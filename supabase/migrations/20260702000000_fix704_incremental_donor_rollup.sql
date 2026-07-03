-- FIX-704 — incremental donor-rollup table + decouple recipient_count from the
-- rebuild critical path. Kills the two Micro-wedging tail steps of the pg_cron
-- full rebuild by construction (both jobs are PAUSED until this ships and the
-- supervised prod bootstrap is clean):
--
--   1. REFRESH MATERIALIZED VIEW CONCURRENTLY official_donor_rollup_mv built a
--      full second copy of the (post-FIX-703, doubled) donor set → OOM'd Micro
--      so hard a compute restart was needed (2026-07-01 incident; the MV is
--      currently STALE on prod, missing the super-PAC money).
--   2. rebuild_ec_donations_full_finalize() recomputed recipient_count over ALL
--      2.36M individual donors in one statement, right after the 16 windows
--      rewrote ~3.7M edges with autovacuum paused (FIX-590) — stale visibility
--      map → index-only scan degrades to per-row heap fetches → ~4h (33min with
--      a fresh VACUUM; measured).
--
-- Both are the same disease: a full recompute of a huge aggregate, all at once,
-- in the rebuild's critical path. The cure is the FIX-372/373 incremental
-- pattern (watermark → dirty set → delete+reinsert only the changed keys →
-- advance watermark), chunked with per-chunk COMMIT (FIX-703 discipline) so no
-- transaction and no aggregation ever holds the whole set. This migration:
--
--   * converts official_donor_rollup_mv to a regular TABLE of the same name and
--     columns (Postgres cannot incrementally refresh an MV; keeping the name —
--     a minor `_mv` wart — means zero read-path churn: officials/[id], treemap,
--     treemap-pac keep their `.from("official_donor_rollup_mv")` reads). The
--     stale MV contents are carried over at swap time so readers never see a
--     gap; the bootstrap then replaces them recipient-by-recipient.
--   * WIDENS the recipient set: the FIX-518 MV filtered to_type='official',
--     which structurally excluded the 2.3M donation rows INTO super PACs /
--     committees (to_type='financial_entity', ~6.9k recipients, landed by
--     FIX-677/236). to_id is now ANY recipient. The column keeps its
--     official_id name (read compat); it holds officials AND financial_entity
--     recipient ids.
--   * shrinks top-N 1000 → 200. The tail-bucket row (rank 201, donor_id NULL)
--     preserves the SUM invariant, so headline totals are unchanged; read
--     surfaces show at most 50 donors / 8 industries / a 1000-leaf treemap
--     whose 200+ leaves were sub-pixel. ~686k of the old 1.07M rows fold into
--     tails.
--   * refreshes via refresh_official_donor_rollup_incremental(), a PROCEDURE
--     (per-chunk COMMIT, own watermark on financial_relationships.updated_at,
--     bounded work_mem) on its own weekly pg_cron job — donations only change
--     on the FEC Sunday ingest. NULL watermark → bootstrap over ALL recipients,
--     same chunked loop. Memory is bounded by construction: no step ever
--     materializes more than one ~200-recipient chunk.
--   * removes the MV refresh AND the recipient_count recompute-all from
--     run_entity_connections_rebuild — the full rebuild is now edges-only.
--   * replaces the finalize with reconcile_recipient_count(), a chunked,
--     committed, rarely-run procedure (monthly pg_cron pair: VACUUM (ANALYZE)
--     entity_connections → reconcile; VACUUM cannot run inside a CALL).
--     recipient_count stays dirty-scoped in the donations incremental path and
--     becomes eventually-consistent globally (display-only count; accepted).
--
-- ⚠ PR2 template: this incremental-procedure-via-pg_cron shape (watermark →
-- dirty keys → chunked delete+insert with per-chunk COMMIT → advance watermark)
-- is the template the ~18-MV enrichment tail will reuse. Same FIX-703 caveats
-- apply: the CALL's statement_timeout is the postgres role default (6h) armed
-- at CALL start; in-procedure SET / COMMIT / proconfig cannot re-arm it.
--
-- Known limitation (same as the FIX-372 edge incremental): the dirty set comes
-- from FR.updated_at, so a HARD-DELETEd FR row does not dirty its recipient —
-- that recipient's rollup stays stale until its next touch. Safety net: clear
-- the watermark (DELETE FROM pipeline_state WHERE key='donor_rollup_watermark')
-- and re-run the procedure for a full chunked re-bootstrap.

-- ── 1. MV → TABLE (same name, same columns, atomic swap with carry-over) ─────

CREATE TABLE public.official_donor_rollup_next (
  official_id       uuid    NOT NULL,   -- to_id: official OR financial_entity recipient
  relationship_type text    NOT NULL,   -- 'donation' | 'ie_support' | 'ie_oppose'
  rank              int     NOT NULL,   -- 1..200 ranked; 201 = tail bucket
  donor_id          uuid,               -- NULL ≡ tail bucket
  donor_name        text,
  entity_type       text,
  industry_tag      text,
  industry_label    text,
  total_cents       bigint  NOT NULL,
  tx_count          bigint  NOT NULL,
  tail_donor_count  bigint              -- set only on the tail row
);

-- Carry the stale MV snapshot over (re-bucketed to top-200) so the read paths
-- keep serving data between this swap and the chunked bootstrap. Old ranked
-- rows 201..1000 and the old rank-1001 tail fold into the new rank-201 tail;
-- each ranked row counts 1 donor, the old tail row contributes its
-- tail_donor_count. SUM invariant is preserved exactly.
INSERT INTO public.official_donor_rollup_next
SELECT official_id, relationship_type, rank, donor_id, donor_name, entity_type,
       industry_tag, industry_label, total_cents, tx_count, NULL::bigint
FROM public.official_donor_rollup_mv
WHERE rank <= 200
UNION ALL
SELECT official_id, relationship_type, 201, NULL::uuid, NULL::text, NULL::text,
       NULL::text, NULL::text,
       SUM(total_cents)::bigint,
       SUM(tx_count)::bigint,
       SUM(CASE WHEN donor_id IS NOT NULL THEN 1 ELSE COALESCE(tail_donor_count, 0) END)::bigint
FROM public.official_donor_rollup_mv
WHERE rank > 200
GROUP BY official_id, relationship_type;

DROP MATERIALIZED VIEW public.official_donor_rollup_mv;
ALTER TABLE public.official_donor_rollup_next RENAME TO official_donor_rollup_mv;

-- Same key the MV's unique index served: the read-path range scan
-- (WHERE official_id=? [AND relationship_type=?] ORDER BY rank) and the
-- per-recipient DELETE both ride the official_id prefix.
ALTER TABLE public.official_donor_rollup_mv
  ADD CONSTRAINT official_donor_rollup_mv_pkey
  PRIMARY KEY (official_id, relationship_type, rank);

ALTER TABLE public.official_donor_rollup_mv ENABLE ROW LEVEL SECURITY;
CREATE POLICY official_donor_rollup_mv_read
  ON public.official_donor_rollup_mv FOR SELECT USING (true);
GRANT SELECT ON public.official_donor_rollup_mv TO anon, authenticated, service_role;

COMMENT ON TABLE public.official_donor_rollup_mv IS
  'FIX-518/FIX-704 — per (recipient, relationship_type) top-200 donors (rank '
  '1..200) + one tail-bucket row (rank 201, donor_id NULL, tail_donor_count '
  'set). SUM(total_cents) over a recipient''s rows = the true total. Recipient '
  '(official_id column) is any to_id: officials AND financial_entity recipients '
  '(super PACs; FIX-704 widened). A TABLE (not an MV — the name is a compat '
  'wart), incrementally maintained by refresh_official_donor_rollup_incremental() '
  'on the donor_rollup_watermark. Serves officials/[id], treemap entity mode, '
  'treemap-pac entityId mode.';

-- The per-recipient re-aggregation needs a to_id-leading index — nothing on
-- financial_relationships led with to_id (financial_relationships_to leads with
-- to_type). Partial on exactly the rollup predicate; INCLUDE amount_cents makes
-- each chunk's scan index-only. ~5.1M entries.
CREATE INDEX IF NOT EXISTS financial_relationships_donor_rollup_idx
  ON public.financial_relationships (to_id, relationship_type, from_id)
  INCLUDE (amount_cents)
  WHERE relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND from_type = 'financial_entity';

-- ── 2. Core re-aggregation helper (single txn, no COMMIT — callers own txns) ─
-- FIX-372/373 "aggregate the whole key" rule: pulls ALL of each recipient's FR
-- rows, not just the changed ones — the rollup is a sum over the recipient's
-- full donor history.
CREATE OR REPLACE FUNCTION public.donor_rollup_rebuild_recipients(p_recipients uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_donor_rollup_mv
   WHERE official_id = ANY (p_recipients);

  WITH per_donor AS (
    SELECT
      fr.to_id                       AS official_id,
      fr.relationship_type::text     AS relationship_type,
      fr.from_id                     AS donor_id,
      SUM(fr.amount_cents)::bigint   AS total_cents,
      COUNT(*)::bigint               AS tx_count
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
      AND fr.from_type = 'financial_entity'
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id, fr.relationship_type, fr.from_id
  ),
  ranked AS (
    SELECT
      pd.*,
      ROW_NUMBER() OVER (
        PARTITION BY pd.official_id, pd.relationship_type
        ORDER BY pd.total_cents DESC, pd.donor_id
      ) AS rn
    FROM per_donor pd
  ),
  ind AS (
    -- One deterministic (tag, label) pair per donor, scoped to this chunk's
    -- ranked donors (the FIX-518 MV computed this over ALL donors once per
    -- refresh; per-chunk scoping keeps it an index probe). Same smallest-tag
    -- pick as fetchIndustryTagsByEntityId.
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id,
      et.tag           AS industry_tag,
      et.display_label AS industry_label
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
      AND et.entity_id IN (SELECT r.donor_id FROM ranked r WHERE r.rn <= 200)
    ORDER BY et.entity_id, et.tag
  ),
  top_rows AS (
    SELECT
      r.official_id,
      r.relationship_type,
      r.rn::int           AS rank,
      r.donor_id,
      fe.display_name     AS donor_name,
      fe.entity_type      AS entity_type,
      ind.industry_tag    AS industry_tag,
      ind.industry_label  AS industry_label,
      r.total_cents,
      r.tx_count,
      NULL::bigint        AS tail_donor_count
    FROM ranked r
    LEFT JOIN public.financial_entities fe ON fe.id = r.donor_id
    LEFT JOIN ind                          ON ind.entity_id = r.donor_id
    WHERE r.rn <= 200
  ),
  tail_rows AS (
    SELECT
      r.official_id,
      r.relationship_type,
      201                        AS rank,
      NULL::uuid                 AS donor_id,
      NULL::text                 AS donor_name,
      NULL::text                 AS entity_type,
      NULL::text                 AS industry_tag,
      NULL::text                 AS industry_label,
      SUM(r.total_cents)::bigint AS total_cents,
      SUM(r.tx_count)::bigint    AS tx_count,
      COUNT(*)::bigint           AS tail_donor_count
    FROM ranked r
    WHERE r.rn > 200
    GROUP BY r.official_id, r.relationship_type
  ),
  ins AS (
    INSERT INTO public.official_donor_rollup_mv (
      official_id, relationship_type, rank, donor_id, donor_name, entity_type,
      industry_tag, industry_label, total_cents, tx_count, tail_donor_count
    )
    SELECT * FROM top_rows
    UNION ALL
    SELECT * FROM tail_rows
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.donor_rollup_rebuild_recipients(uuid[]) TO service_role;

COMMENT ON FUNCTION public.donor_rollup_rebuild_recipients(uuid[]) IS
  'FIX-704 — delete + fully re-aggregate the donor rollup for a set of '
  'recipients (top-200 + tail bucket per relationship_type). No COMMIT: the '
  'chunked procedure commits per chunk; the compat function runs one txn.';

-- ── 3. Incremental refresh PROCEDURE (pg_cron entry point) ───────────────────
CREATE OR REPLACE PROCEDURE public.refresh_official_donor_rollup_incremental()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_chunk_size int    := 200;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_new_max    timestamptz;
  v_dirty      uuid[];
  v_chunk      uuid[];
  v_n_recips   int;
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
BEGIN
  -- Session advisory lock (survives the COMMITs below); also excludes a
  -- concurrent compat-function refresh via the same rebuild helper being safe
  -- anyway (idempotent per recipient), this is mostly stampede protection.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Bounded per-chunk memory. Plain SET (not SET LOCAL) survives the per-chunk
  -- COMMITs. NOTE (FIX-703): the CALL's statement_timeout is the postgres role
  -- default (6h) armed at CALL start — nothing in this body can change it.
  SET work_mem = '128MB';

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

  -- Capture the new watermark BEFORE building the dirty set so FR writes that
  -- land mid-refresh are re-processed by the next run, never silently consumed.
  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

  IF v_watermark IS NULL THEN
    -- Bootstrap: every recipient, same chunked loop. (~11.5k recipients on
    -- 2026-07 data — ~58 chunks.)
    SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
      AND fr.from_type = 'financial_entity';
  ELSE
    SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
      AND fr.from_type = 'financial_entity'
      AND fr.updated_at > v_watermark;
  END IF;

  v_n_recips := COALESCE(array_length(v_dirty, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_refresh', 'running', now(),
          jsonb_build_object(
            'mode', CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END,
            'dirty_recipients', v_n_recips,
            'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  WHILE v_i <= v_n_recips LOOP
    v_chunk    := v_dirty[v_i : LEAST(v_i + c_chunk_size - 1, v_n_recips)];
    v_chunk_no := v_chunk_no + 1;
    BEGIN
      v_n    := public.donor_rollup_rebuild_recipients(v_chunk);
      v_rows := v_rows + v_n;
      IF v_chunk_no % 10 = 0 THEN
        RAISE NOTICE '[donor-rollup] chunk % — % recipients done, % rows so far',
          v_chunk_no, LEAST(v_i + c_chunk_size - 1, v_n_recips), v_rows;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its recipients keep their PRIOR
      -- rollup rows (complete-if-stale) and the un-advanced watermark retries
      -- them next run.
      v_failures := v_failures || format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk_size - 1, v_n_recips), SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;
    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Bounds txn size + advances xmin between chunks.
    COMMIT;
    v_i := v_i + c_chunk_size;
  END LOOP;

  -- Advance the watermark only on a clean run — a failed chunk's recipients
  -- must stay in the next run's dirty set.
  IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('donor_rollup_watermark',
            jsonb_build_object('last_indexed_at', COALESCE(v_new_max, NOW())::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'rollup_rows', v_rows,
                        'chunks', v_chunk_no,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup] % — % recipients in % chunks, % rows (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_n_recips, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_official_donor_rollup_incremental() TO service_role;

COMMENT ON PROCEDURE public.refresh_official_donor_rollup_incremental() IS
  'FIX-704 — chunked incremental refresh of official_donor_rollup_mv (the '
  'TABLE). Watermark on financial_relationships.updated_at '
  '(pipeline_state.donor_rollup_watermark); dirty recipients re-aggregated in '
  'full, 200 recipients per chunk, COMMIT per chunk, work_mem bounded. NULL '
  'watermark → bootstrap over all recipients. Runtime budget = postgres role '
  'default statement_timeout (6h) armed at CALL start (FIX-703). This is the '
  'PR2 template for the enrichment-MV tail.';

-- ── 4. Compat shim: refresh_official_donor_rollup_mv() ──────────────────────
-- Was `REFRESH MATERIALIZED VIEW CONCURRENTLY` (the OOM). Same signature (void,
-- SECURITY DEFINER, grants preserved by CREATE OR REPLACE) so PostgREST callers
-- — the franklin seed's post-seed refresh list — keep working. Now a
-- dirty-scoped single-transaction refresh: fine for the small dirty sets those
-- callers produce; a big dirty set just times out at the caller's cap and rolls
-- back untouched (watermark un-advanced — the weekly procedure picks it up).
CREATE OR REPLACE FUNCTION public.refresh_official_donor_rollup_mv()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_watermark timestamptz;
  v_new_max   timestamptz;
  v_dirty     uuid[];
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

  IF v_watermark IS NULL THEN
    -- Bootstrap belongs to the chunked procedure — an all-recipients rebuild in
    -- one transaction through PostgREST is exactly the shape FIX-704 removes.
    RAISE WARNING 'refresh_official_donor_rollup_mv: no donor_rollup_watermark — '
      'run CALL public.refresh_official_donor_rollup_incremental() (chunked bootstrap) instead';
    RETURN;
  END IF;

  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

  SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND fr.from_type = 'financial_entity'
    AND fr.updated_at > v_watermark;

  IF COALESCE(array_length(v_dirty, 1), 0) > 0 THEN
    PERFORM public.donor_rollup_rebuild_recipients(v_dirty);
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_new_max, NOW())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$$;

COMMENT ON FUNCTION public.refresh_official_donor_rollup_mv() IS
  'FIX-518/FIX-704 — compat shim over the incremental donor-rollup TABLE '
  '(was REFRESH MATERIALIZED VIEW CONCURRENTLY). Dirty-scoped single-txn '
  'refresh; NULL watermark → no-op with a WARNING (use the chunked procedure).';

-- ── 5. run_entity_connections_rebuild: edges-only (drop finalize + MV tail) ──
-- Body identical to FIX-703 (20260701000000) EXCEPT: the donations-finalize
-- block (recipient_count recompute-all — the ~4h stale-VM step) and the
-- donor-rollup MV refresh block (the OOM step) are REMOVED. The rollup has its
-- own watermark on financial_relationships, so it does not depend on this
-- rebuild at all; recipient_count is reconciled by reconcile_recipient_count()
-- (monthly, post-VACUUM) and stays dirty-scoped in the donations incremental.
CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(p_mode text DEFAULT 'incremental')
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo         uuid;
  v_hi         uuid;
  v_win        bigint;
  v_donations_total bigint;
  i            int;
BEGIN
  IF p_mode NOT IN ('full', 'incremental') THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: invalid p_mode %, expected ''full'' or ''incremental''', p_mode;
  END IF;

  -- ── Concurrency guard (session advisory lock; survives the COMMITs below) ───
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'skipped', now(), now(),
      jsonb_build_object(
        'mode', p_mode,
        'skip_reason', 'advisory lock held by a concurrent entity_connections rebuild',
        'source', 'pg_cron'
      )
    );
    RAISE NOTICE '[rebuild] advisory lock held — skipping (mode=%)', p_mode;
    RETURN;
  END IF;

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer.
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object('mode', p_mode, 'source', 'pg_cron')
  )
  RETURNING id INTO v_log_id;

  -- ── Pause autovacuum on entity_connections for the full rebuild (FIX-590) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = false);
    RAISE NOTICE '[rebuild] autovacuum paused on entity_connections (full rebuild)';
  END IF;
  COMMIT;

  -- ── Full donations chunk — per-window COMMIT (FIX-703) ─────────────────────
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint on Micro
  -- (so the raised CALL-level budget never becomes an atomic multi-hour txn).
  -- Each window range-scopes its delete+insert, so a mid-run failure leaves
  -- un-processed windows' PRIOR edges intact (complete-if-stale, never missing).
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band (reconcile_recipient_count(), monthly post-VACUUM) and stays
  -- dirty-scoped in the incremental donations path.
  IF v_full THEN
    BEGIN
      PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('donations prepare: %s', SQLERRM);
      RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
    END;
    COMMIT;

    v_donations_total := 0;
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
        v_donations_total := v_donations_total + v_win;
        RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
      EXCEPTION WHEN OTHERS THEN
        -- Per-window catch: one bad window must not abort the rest; the run is
        -- reported `failed`. WHEN OTHERS catches a statement_timeout cancel too.
        v_failures := v_failures || format('donations window %s [%s..%s): %s',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
        RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
      END;
      -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction — PL/pgSQL
      -- forbids COMMIT inside one).
      COMMIT;
    END LOOP;

    v_total := v_total + v_donations_total;
    RAISE NOTICE '  [chunk] donations (windowed) — complete (% edges)', v_donations_total;
  END IF;

  -- ── Remaining chunks (external + investigation MUST stay last) ─────────────
  IF v_full THEN
    v_fns := ARRAY[
      'rebuild_entity_connections_votes_full',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  ELSE
    v_fns := ARRAY[
      'rebuild_entity_connections_donations',
      'rebuild_entity_connections_votes',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  END IF;

  FOREACH v_fn IN ARRAY v_fns LOOP
    BEGIN
      EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
        INTO v_n;
      v_total := v_total + v_n;
      RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;
    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    COMMIT;
  END LOOP;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0)
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;

COMMENT ON PROCEDURE public.run_entity_connections_rebuild(text) IS
  'FIX-687/FIX-703/FIX-704 — pg_cron entity_connections rebuild, EDGES ONLY. '
  'Session advisory-lock guard, per-window/per-chunk COMMIT '
  '(external/investigation last), data_sync_log observability. FIX-704 removed '
  'the two tail steps that wedged Micro: recipient_count recompute-all (now '
  'reconcile_recipient_count(), monthly post-VACUUM) and the donor-rollup MV '
  'refresh (now an incremental table on its own pg_cron job). Total-runtime '
  'budget is the postgres role default (6h, FIX-703) armed at CALL start. '
  'CALL with ''full'' (Mon) or ''incremental'' (Wed).';

GRANT EXECUTE ON PROCEDURE public.run_entity_connections_rebuild(text) TO service_role;

-- ── 6. recipient_count decouple ──────────────────────────────────────────────
-- The finalize's recompute-all is gone from every path (the TS interim script
-- drops its call in the same commit). The donations INCREMENTAL path's
-- dirty-scoped recipient_count update (20260525000000) is untouched.
DROP FUNCTION IF EXISTS public.rebuild_ec_donations_full_finalize();

-- Chunked, committed, rarely-run reconcile. Run it AFTER a VACUUM of
-- entity_connections (fresh visibility map → index-only scans; VACUUM cannot
-- run inside a CALL, hence the separate pg_cron pair below). The IS DISTINCT
-- FROM guard makes a no-change reconcile write ~nothing.
CREATE OR REPLACE PROCEDURE public.reconcile_recipient_count()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_recipient_count')::bigint;
  c_bounds   uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo       uuid;
  v_hi       uuid;
  v_total    bigint := 0;
  v_n        bigint;
  v_failures text[] := ARRAY[]::text[];
  i          int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[reconcile] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  FOR i IN 1..16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    BEGIN
      -- Same aggregation as the old finalize (FIX-194 block 1b), scoped to one
      -- from_id window. Only updates individuals whose count actually changed;
      -- donors that lost ALL their donation edges are not zeroed (parity with
      -- the old finalize — recipient_count is a display-only connector count).
      UPDATE public.financial_entities fe
      SET recipient_count = sub.cnt
      FROM (
        SELECT
          ec.from_id,
          COUNT(DISTINCT ec.to_id)::smallint AS cnt
        FROM public.entity_connections ec
        WHERE ec.connection_type = 'donation'
          AND ec.from_type = 'financial_entity'
          AND ec.from_id >= v_lo
          AND (v_hi IS NULL OR ec.from_id < v_hi)
        GROUP BY ec.from_id
      ) sub
      WHERE fe.id = sub.from_id
        AND fe.entity_type = 'individual'
        AND fe.recipient_count IS DISTINCT FROM sub.cnt;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_total := v_total + v_n;
      RAISE NOTICE '  [reconcile] window %/16 — % donors updated', i, v_n;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [reconcile] window %/16 FAILED: %', i, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, rows_failed, error_message, metadata)
  VALUES ('recipient_count_reconcile',
          CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
          now(), now(), v_total,
          COALESCE(array_length(v_failures, 1), 0),
          CASE WHEN array_length(v_failures, 1) > 0
               THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
          jsonb_build_object('source', 'pg_cron'));

  RAISE NOTICE '[reconcile] % — recipient_count updated for % donors (% window failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_total, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_recipient_count() TO service_role;

COMMENT ON PROCEDURE public.reconcile_recipient_count() IS
  'FIX-704 — chunked (16 from_id windows, COMMIT each) recompute of '
  'financial_entities.recipient_count for individual donors; replaces the '
  'rebuild-critical-path finalize. Run AFTER VACUUM (ANALYZE) entity_connections '
  '(the ec-vacuum-analyze cron job) so the scan stays index-only. '
  'recipient_count is eventually-consistent by design (display-only).';

-- ── 7. pg_cron jobs — created PAUSED (FIX-704 runbook re-enables together with
--       rebuild-ec-full / rebuild-ec-incremental after the supervised prod
--       bootstrap) ─────────────────────────────────────────────────────────────
--   * donor-rollup-refresh          Tue 08:00 UTC weekly — donations only change
--     on the FEC Sunday ingest; Tuesday clears the Monday full rebuild's 6h
--     budget window. Reads financial_relationships directly (independent of the
--     edge rebuild).
--   * ec-vacuum-analyze             1st of month 08:00 UTC — fresh visibility
--     map for the reconcile 3h later. pg_cron runs it as its own top-level
--     command (VACUUM can't run inside a CALL).
--   * ec-recipient-count-reconcile  1st of month 11:00 UTC.
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('donor-rollup-refresh', 'ec-vacuum-analyze', 'ec-recipient-count-reconcile');

SELECT cron.schedule(
  'donor-rollup-refresh',
  '0 8 * * 2',
  $$CALL public.refresh_official_donor_rollup_incremental();$$
);

SELECT cron.schedule(
  'ec-vacuum-analyze',
  '0 8 1 * *',
  $$VACUUM (ANALYZE) public.entity_connections;$$
);

SELECT cron.schedule(
  'ec-recipient-count-reconcile',
  '0 11 1 * *',
  $$CALL public.reconcile_recipient_count();$$
);

SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job
 WHERE jobname IN ('donor-rollup-refresh', 'ec-vacuum-analyze', 'ec-recipient-count-reconcile');

-- PostgREST: the MV→table swap changes relkind under the same name; nudge the
-- schema cache so `.from("official_donor_rollup_mv")` reads keep resolving.
NOTIFY pgrst, 'reload schema';
