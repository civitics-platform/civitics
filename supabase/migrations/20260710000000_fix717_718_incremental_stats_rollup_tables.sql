-- FIX-717 + FIX-718 — the last two large MVs → incrementally-maintained TABLEs
-- on their own pg_cron jobs. Closes the cron-resilience program backlog: both
-- were DEFERRED from the PR2 MV-tail relocation (FIX-715) because a full
-- REFRESH MATERIALIZED VIEW CONCURRENTLY is the FIX-704 OOM class on the small
-- prod compute (official_donor_rollup at 276MB/770k OOM-restarted it; these are
-- 287MB/2.66M and 188MB/1.29M on the 2026-07-10 local clone). Until now they
-- refreshed in the GHA enrichment-tail via the capped admin.rpc() path — where
-- the ~8s service_role statement_timeout cancels a minutes-long REFRESH long
-- before it completes, i.e. on prod they were not "stale-but-safe", they were
-- chronically stale. This migration removes them from the nightly entirely.
--
-- Both keep the `_mv` NAME (the FIX-704 compat wart) — zero read churn:
--   entity_connection_stats_mv  ← graph/entities, graph/treemap,
--                                 graph/connections, search, search/entity
--   donor_party_rollup_mv       ← get_pac_treemap_by_sector / _by_party
--                                 (treemap-pac global modes)
--
-- ── FIX-718 (donor_party_rollup_mv): true FIX-704 incremental ────────────────
-- Source is financial_relationships (donation, from_type='financial_entity')
-- joined officials for party — the same dirty source FIX-704's donor rollup and
-- FIX-702/726's totals already watermark. Own watermark
-- (pipeline_state.donor_party_rollup_watermark, NEVER shared with FIX-704's
-- donor_rollup_watermark) on FR.updated_at; dirty keys = DISTINCT from_id of
-- changed qualifying rows; each dirty donor is deleted + fully re-aggregated
-- (FIX-372/373 "aggregate the whole key" rule) in 5,000-donor chunks with
-- per-chunk COMMIT. NULL watermark (bootstrap) or an oversized dirty set falls
-- back to the staged full rebuild below. Weekly pg_cron Tue 08:45 UTC —
-- donations only change on the FEC Sunday ingest; 08:45 offsets from
-- donor-rollup-refresh (Tue 08:00) and clears before
-- financial-entity-totals-incremental (Tue 09:00).
--
-- ── FIX-717 (entity_connection_stats_mv): ESCAPE HATCH — staged full rebuild ─
-- The dirty-key design was investigated and rejected. entity_connections has no
-- updated_at; the insert-fresh column is derived_at (DEFAULT now(), btree
-- indexed, no trigger — EC is written ONLY by the rebuild fns as DELETE+INSERT,
-- FIX-699 context). A derived_at watermark WOULD identify dirty rows, but:
--   1. A dirty entity's stats need re-aggregation over ALL its edges, and the
--      to-side has no to_id-leading index (entity_connections_to leads with
--      to_type) — per-entity chunks would seq-scan 5.7M rows per chunk.
--   2. The Monday full EC rebuild rewrites every row → derived_at goes fresh on
--      ~all 5.7M rows → the "incremental" degenerates to a full pass anyway.
-- So the procedure is an always-full STAGED rebuild, which is cheap at this
-- shape: ONE set-based aggregation (the FIX-734 single-scan lesson — never 16
-- cold windows against the source) into a session temp table, then 16
-- entity-id-windowed DELETE+INSERT applies with per-window COMMIT (the FIX-703
-- bounded-txn discipline — no 2.66M-row transaction on the small compute).
-- Memory is bounded by construction: the hash aggregate spills under work_mem;
-- no full second copy + unique-index diff like REFRESH CONCURRENTLY builds.
-- Mon + Wed 11:00 UTC — after the 08:00 EC rebuild jobs (full takes ~30-40 min
-- in-DB; 3h slack). If an EC rebuild overruns, this run captures whatever is
-- committed (complete-if-stale, per-window) and the next run heals.
--
-- ── Hard-delete blind spot: monthly orphan sweeps for BOTH (FIX-705 lesson) ──
-- FIX-718's FR.updated_at watermark cannot see a hard-deleted FR row — that
-- donor's rollup rows stay stale forever without a sweep. FIX-717's always-full
-- rebuild removes orphans by construction, but the sweep is kept as
-- belt-and-braces (guards a future incremental conversion; FIX-705 discipline:
-- every watermark/derived table gets one). Single set-based anti-joins, wired
-- into the existing 1st-of-month reconcile slots (after
-- donor-rollup-orphan-sweep at 12:30): 13:00 + 13:30 UTC.
--
-- pg_cron jobs are created PAUSED (FIX-704 discipline); the supervised prod
-- runbook bootstraps both tables via one-off server-side jobs, verifies
-- readers, then enables:
--   SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job
--    WHERE jobname IN ('entity-connection-stats-rebuild',
--                      'donor-party-rollup-refresh',
--                      'donor-party-rollup-orphan-sweep',
--                      'entity-connection-stats-orphan-sweep');

-- ═══ 1. entity_connection_stats_mv: MV → TABLE (same name, atomic swap) ══════

CREATE TABLE public.entity_connection_stats_next (
  entity_id        uuid    NOT NULL,
  connection_count bigint  NOT NULL,
  vote_count       bigint  NOT NULL,
  has_donation     boolean,
  has_vote         boolean
);

-- Carry the current MV snapshot over so readers never see a gap between this
-- swap and the first staged rebuild. Split into id-range statements: the prod
-- push runs through the session pooler whose postgres-role statement_timeout is
-- 2min (reference: prod role timeouts) — one 2.66M-row copy risks the cap, four
-- ~670k copies do not.
INSERT INTO public.entity_connection_stats_next
SELECT entity_id, connection_count, vote_count, has_donation, has_vote
FROM public.entity_connection_stats_mv
WHERE entity_id < '40000000-0000-0000-0000-000000000000';

INSERT INTO public.entity_connection_stats_next
SELECT entity_id, connection_count, vote_count, has_donation, has_vote
FROM public.entity_connection_stats_mv
WHERE entity_id >= '40000000-0000-0000-0000-000000000000'
  AND entity_id <  '80000000-0000-0000-0000-000000000000';

INSERT INTO public.entity_connection_stats_next
SELECT entity_id, connection_count, vote_count, has_donation, has_vote
FROM public.entity_connection_stats_mv
WHERE entity_id >= '80000000-0000-0000-0000-000000000000'
  AND entity_id <  'c0000000-0000-0000-0000-000000000000';

INSERT INTO public.entity_connection_stats_next
SELECT entity_id, connection_count, vote_count, has_donation, has_vote
FROM public.entity_connection_stats_mv
WHERE entity_id >= 'c0000000-0000-0000-0000-000000000000';

DROP MATERIALIZED VIEW public.entity_connection_stats_mv;
ALTER TABLE public.entity_connection_stats_next RENAME TO entity_connection_stats_mv;

-- Same key the MV's unique index served: the routes' point reads
-- (.in('entity_id', …)) and the windowed apply's range DELETE both ride it.
ALTER TABLE public.entity_connection_stats_mv
  ADD CONSTRAINT entity_connection_stats_mv_pkey PRIMARY KEY (entity_id);

ALTER TABLE public.entity_connection_stats_mv ENABLE ROW LEVEL SECURITY;
CREATE POLICY entity_connection_stats_mv_read
  ON public.entity_connection_stats_mv FOR SELECT USING (true);
GRANT SELECT ON public.entity_connection_stats_mv TO anon, authenticated, service_role;

COMMENT ON TABLE public.entity_connection_stats_mv IS
  'FIX-509/FIX-717 — per-entity connection stats (one row per entity id on '
  'either side of entity_connections; connection_count both directions, '
  'vote_count over the 5-type vote set, has_donation/has_vote flags). A TABLE '
  '(not an MV — the name is a compat wart), rebuilt by '
  'rebuild_entity_connection_stats() (staged full rebuild: one set-based scan '
  'into a temp stage + 16 windowed committed applies) on pg_cron Mon+Wed 11:00 '
  'UTC after the EC rebuild jobs. Serves graph/entities, graph/treemap, '
  'graph/connections, search, search/entity.';

-- ═══ 2. donor_party_rollup_mv: MV → TABLE (same name, atomic swap) ═══════════

CREATE TABLE public.donor_party_rollup_next (
  donor_id       uuid   NOT NULL,
  party_key      text   NOT NULL,
  donor_name     text,
  entity_type    text,
  industry_tag   text,
  industry_label text,
  total_cents    bigint NOT NULL,
  tx_count       bigint NOT NULL
);

INSERT INTO public.donor_party_rollup_next
SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
       industry_label, total_cents, tx_count
FROM public.donor_party_rollup_mv
WHERE donor_id < '80000000-0000-0000-0000-000000000000';

INSERT INTO public.donor_party_rollup_next
SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
       industry_label, total_cents, tx_count
FROM public.donor_party_rollup_mv
WHERE donor_id >= '80000000-0000-0000-0000-000000000000';

DROP MATERIALIZED VIEW public.donor_party_rollup_mv;
ALTER TABLE public.donor_party_rollup_next RENAME TO donor_party_rollup_mv;

ALTER TABLE public.donor_party_rollup_mv
  ADD CONSTRAINT donor_party_rollup_mv_pkey PRIMARY KEY (donor_id, party_key);

-- Same partial read index the MV carried: the global treemap-pac RPCs read only
-- the pac/party_committee subset (~7.4k donors) of the 1.29M-row table.
CREATE INDEX donor_party_rollup_mv_pac_read_idx
  ON public.donor_party_rollup_mv (party_key, total_cents DESC)
  WHERE entity_type IN ('pac', 'party_committee');

ALTER TABLE public.donor_party_rollup_mv ENABLE ROW LEVEL SECURITY;
CREATE POLICY donor_party_rollup_mv_read
  ON public.donor_party_rollup_mv FOR SELECT USING (true);
GRANT SELECT ON public.donor_party_rollup_mv TO anon, authenticated, service_role;

COMMENT ON TABLE public.donor_party_rollup_mv IS
  'FIX-518/FIX-718 — per (donor_id, party_key) donation totals (donations only, '
  'to_type=official; party_key = recipient officials.party::text, NULL→unknown; '
  'ALL FE donor types — readers filter entity_type IN (pac,party_committee)). '
  'A TABLE (not an MV — the name is a compat wart), incrementally maintained by '
  'refresh_donor_party_rollup_incremental() on the donor_party_rollup_watermark '
  '(FR.updated_at), weekly pg_cron Tue 08:45 UTC. Serves treemap-pac global '
  'sector/party modes via get_pac_treemap_by_{sector,party}.';

-- ═══ 3. FIX-718 core helper (single txn, no COMMIT — callers own txns) ═══════
-- FIX-372/373 rule: re-aggregates each donor's FULL qualifying FR set, not just
-- the changed rows. Aggregation/join shape is byte-for-byte the FIX-518 MV
-- query scoped to the chunk (party from the INNER JOIN on to_type='official';
-- ind CTE picks one deterministic (tag,label) pair per donor).
CREATE OR REPLACE FUNCTION public.donor_party_rollup_rebuild_donors(p_donors uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.donor_party_rollup_mv
   WHERE donor_id = ANY (p_donors);

  WITH agg AS (
    SELECT
      fr.from_id                          AS donor_id,
      COALESCE(o.party::text, 'unknown')  AS party_key,
      SUM(fr.amount_cents)::bigint        AS total_cents,
      COUNT(*)::bigint                    AS tx_count
    FROM public.financial_relationships fr
    JOIN public.officials o
      ON o.id = fr.to_id AND fr.to_type = 'official'
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type = 'financial_entity'
      AND fr.from_id = ANY (p_donors)
    GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
  ),
  ind AS (
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id,
      et.tag           AS industry_tag,
      et.display_label AS industry_label
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
      AND et.entity_id = ANY (p_donors)
    ORDER BY et.entity_id, et.tag
  ),
  ins AS (
    INSERT INTO public.donor_party_rollup_mv (
      donor_id, party_key, donor_name, entity_type, industry_tag,
      industry_label, total_cents, tx_count
    )
    SELECT
      a.donor_id, a.party_key, fe.display_name, fe.entity_type,
      ind.industry_tag, ind.industry_label, a.total_cents, a.tx_count
    FROM agg a
    LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id
    LEFT JOIN ind                          ON ind.entity_id = a.donor_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.donor_party_rollup_rebuild_donors(uuid[]) TO service_role;

COMMENT ON FUNCTION public.donor_party_rollup_rebuild_donors(uuid[]) IS
  'FIX-718 — delete + fully re-aggregate donor_party_rollup_mv rows for a set '
  'of donors. No COMMIT: the chunked procedure commits per chunk; the compat '
  'shim runs one txn.';

-- ═══ 4. FIX-718 refresh PROCEDURE (pg_cron entry point) ══════════════════════
CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key   bigint := hashtext('donor_party_rollup_refresh')::bigint;
  c_chunk_size int    := 5000;
  -- Above this many dirty donors, ~all of the table is being rewritten anyway:
  -- the staged full rebuild (ONE set-based FR scan) beats hundreds of
  -- index-probe chunks (the FIX-734 lesson).
  c_full_threshold int := 300000;
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_new_max    timestamptz;
  v_dirty      uuid[];
  v_chunk      uuid[];
  v_n_dirty    int;
  v_mode       text;
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  i            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-party-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-party-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Plain SET (not SET LOCAL) survives the per-chunk COMMITs. NOTE (FIX-703):
  -- the CALL's statement_timeout is the postgres role default (6h) armed at
  -- CALL start — nothing in this body can change it.
  SET work_mem = '256MB';

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  -- Capture the new watermark BEFORE building the dirty set so FR writes that
  -- land mid-refresh are re-processed next run, never silently consumed.
  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  IF v_watermark IS NOT NULL THEN
    SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type = 'financial_entity'
      AND fr.to_type   = 'official'
      AND fr.updated_at > v_watermark;
  END IF;

  v_n_dirty := COALESCE(array_length(v_dirty, 1), 0);
  v_mode := CASE
    WHEN v_watermark IS NULL          THEN 'bootstrap'
    WHEN v_n_dirty > c_full_threshold THEN 'full'
    ELSE 'incremental'
  END;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_refresh', 'running', now(),
          jsonb_build_object('mode', v_mode, 'dirty_donors', v_n_dirty,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_mode IN ('bootstrap', 'full') THEN
    -- Staged full rebuild: ONE set-based scan (FIX-734 lesson) into a session
    -- temp stage, then 16 donor-id-windowed DELETE+INSERT applies with
    -- per-window COMMIT (FIX-703 bounded-txn discipline). Readers keep prior
    -- rows per un-applied window (complete-if-stale, never missing).
    BEGIN
      DROP TABLE IF EXISTS dpr_stage;
      CREATE TEMP TABLE dpr_stage AS
      WITH agg AS MATERIALIZED (
        SELECT
          fr.from_id                          AS donor_id,
          COALESCE(o.party::text, 'unknown')  AS party_key,
          SUM(fr.amount_cents)::bigint        AS total_cents,
          COUNT(*)::bigint                    AS tx_count
        FROM public.financial_relationships fr
        JOIN public.officials o
          ON o.id = fr.to_id AND fr.to_type = 'official'
        WHERE fr.relationship_type = 'donation'
          AND fr.from_type = 'financial_entity'
        GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
      ),
      ind AS (
        SELECT DISTINCT ON (et.entity_id)
          et.entity_id,
          et.tag           AS industry_tag,
          et.display_label AS industry_label
        FROM public.entity_tags et
        WHERE et.entity_type  = 'financial_entity'
          AND et.tag_category = 'industry'
        ORDER BY et.entity_id, et.tag
      )
      SELECT
        a.donor_id, a.party_key, fe.display_name AS donor_name,
        fe.entity_type, ind.industry_tag, ind.industry_label,
        a.total_cents, a.tx_count
      FROM agg a
      LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id
      LEFT JOIN ind                          ON ind.entity_id = a.donor_id;

      CREATE INDEX dpr_stage_idx ON dpr_stage (donor_id);
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('stage build: %s', SQLERRM);
      RAISE WARNING '[donor-party-rollup] stage build FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level (temp table persists across COMMIT for the session)

    IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
        BEGIN
          DELETE FROM public.donor_party_rollup_mv
           WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
          INSERT INTO public.donor_party_rollup_mv (
            donor_id, party_key, donor_name, entity_type, industry_tag,
            industry_label, total_cents, tx_count
          )
          SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
                 industry_label, total_cents, tx_count
          FROM dpr_stage
          WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_rows := v_rows + v_n;
          RAISE NOTICE '  [donor-party-rollup] window %/16 — % rows', i, v_n;
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('window %s: %s', i, SQLERRM);
          RAISE WARNING '  [donor-party-rollup] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;  -- top level, outside the EXCEPTION subtransaction
      END LOOP;
    END IF;

    DROP TABLE IF EXISTS dpr_stage;
    COMMIT;
  ELSE
    -- Incremental: chunk the dirty donor set, per-chunk COMMIT.
    WHILE v_i <= v_n_dirty LOOP
      v_chunk    := v_dirty[v_i : LEAST(v_i + c_chunk_size - 1, v_n_dirty)];
      v_chunk_no := v_chunk_no + 1;
      BEGIN
        v_n    := public.donor_party_rollup_rebuild_donors(v_chunk);
        v_rows := v_rows + v_n;
        IF v_chunk_no % 10 = 0 THEN
          RAISE NOTICE '[donor-party-rollup] chunk % — % donors done, % rows so far',
            v_chunk_no, LEAST(v_i + c_chunk_size - 1, v_n_dirty), v_rows;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- One bad chunk must not abort the rest; its donors keep their PRIOR
        -- rollup rows and the un-advanced watermark retries them next run.
        v_failures := v_failures || format('chunk %s (donors %s..%s): %s',
          v_chunk_no, v_i, LEAST(v_i + c_chunk_size - 1, v_n_dirty), SQLERRM);
        RAISE WARNING '[donor-party-rollup] chunk % FAILED: %', v_chunk_no, SQLERRM;
      END;
      COMMIT;  -- top level (PL/pgSQL forbids COMMIT inside an EXCEPTION block)
      v_i := v_i + c_chunk_size;
    END LOOP;
  END IF;

  -- Advance the watermark only on a clean run — failed chunks'/windows' donors
  -- must stay in the next run's dirty set.
  IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('donor_party_rollup_watermark',
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
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-party-rollup] % (mode=%) — % dirty donors, % rows (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_mode, v_n_dirty, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_donor_party_rollup_incremental() TO service_role;

COMMENT ON PROCEDURE public.refresh_donor_party_rollup_incremental() IS
  'FIX-718 — chunked incremental refresh of donor_party_rollup_mv (the TABLE). '
  'Watermark on financial_relationships.updated_at '
  '(pipeline_state.donor_party_rollup_watermark); dirty donors re-aggregated in '
  'full, 5,000 per chunk, COMMIT per chunk, work_mem bounded. NULL watermark or '
  '>300k dirty → staged full rebuild (one set-based scan into a temp stage + 16 '
  'windowed committed applies). Runtime budget = postgres role default '
  'statement_timeout (6h) armed at CALL start (FIX-703).';

-- ═══ 5. FIX-717 rebuild PROCEDURE (pg_cron entry point) ══════════════════════
CREATE OR REPLACE PROCEDURE public.rebuild_entity_connection_stats()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('entity_connection_stats_rebuild')::bigint;
  c_bounds   uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id   uuid;
  v_lo       uuid;
  v_hi       uuid;
  v_rows     bigint := 0;
  v_n        bigint;
  v_failures text[] := ARRAY[]::text[];
  i          int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connection_stats_rebuild', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent stats rebuild',
                               'source', 'pg_cron'));
    RAISE NOTICE '[ec-stats] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Bounded stage-build memory (the hash aggregate spills past this). Plain SET
  -- survives the per-window COMMITs. NOTE (FIX-703): the CALL's
  -- statement_timeout is the postgres role default (6h) armed at CALL start.
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('entity_connection_stats_rebuild', 'running', now(),
          jsonb_build_object('mode', 'staged-full', 'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- Stage: ONE set-based aggregation (2 seq scans of entity_connections via the
  -- UNION ALL — the FIX-734 single-scan lesson; never 16 cold windows against
  -- the source). Query is byte-for-byte the FIX-509 MV definition.
  BEGIN
    DROP TABLE IF EXISTS ecs_stage;
    CREATE TEMP TABLE ecs_stage AS
    SELECT
      sub.id                                          AS entity_id,
      COUNT(*)::BIGINT                                AS connection_count,
      COUNT(*) FILTER (
        WHERE sub.connection_type IN (
          'vote_yes', 'vote_no', 'vote_abstain',
          'nomination_vote_yes', 'nomination_vote_no'
        )
      )::BIGINT                                       AS vote_count,
      bool_or(sub.connection_type = 'donation')       AS has_donation,
      bool_or(sub.connection_type IN (
        'vote_yes', 'vote_no', 'vote_abstain',
        'nomination_vote_yes', 'nomination_vote_no'
      ))                                              AS has_vote
    FROM (
      SELECT from_id AS id, connection_type FROM public.entity_connections
      UNION ALL
      SELECT to_id   AS id, connection_type FROM public.entity_connections
    ) sub
    GROUP BY sub.id;

    CREATE INDEX ecs_stage_idx ON ecs_stage (entity_id);
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('stage build: %s', SQLERRM);
    RAISE WARNING '[ec-stats] stage build FAILED: %', SQLERRM;
  END;
  COMMIT;  -- top level (temp table persists across COMMIT for the session)

  -- Apply: 16 entity-id windows, DELETE+INSERT per window, COMMIT per window
  -- (FIX-703 bounded-txn discipline — never a 2.66M-row transaction). A failed
  -- window keeps its PRIOR rows (complete-if-stale); the next Mon/Wed run heals.
  -- Orphans (entities that lost all edges) die by construction: the window
  -- DELETE covers the whole keyspace and only live-aggregate rows come back.
  IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        DELETE FROM public.entity_connection_stats_mv
         WHERE entity_id >= v_lo AND (v_hi IS NULL OR entity_id < v_hi);
        INSERT INTO public.entity_connection_stats_mv (
          entity_id, connection_count, vote_count, has_donation, has_vote
        )
        SELECT entity_id, connection_count, vote_count, has_donation, has_vote
        FROM ecs_stage
        WHERE entity_id >= v_lo AND (v_hi IS NULL OR entity_id < v_hi);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_rows := v_rows + v_n;
        RAISE NOTICE '  [ec-stats] window %/16 — % rows', i, v_n;
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('window %s: %s', i, SQLERRM);
        RAISE WARNING '  [ec-stats] window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level, outside the EXCEPTION subtransaction
    END LOOP;
  END IF;

  DROP TABLE IF EXISTS ecs_stage;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'stats_rows', v_rows,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[ec-stats] % — % rows (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.rebuild_entity_connection_stats() TO service_role;

COMMENT ON PROCEDURE public.rebuild_entity_connection_stats() IS
  'FIX-717 — staged full rebuild of entity_connection_stats_mv (the TABLE): one '
  'set-based aggregation of entity_connections into a session temp stage '
  '(FIX-734 single-scan lesson), then 16 entity-id-windowed DELETE+INSERT '
  'applies with per-window COMMIT (FIX-703 bounded-txn discipline). Always full '
  '— the ESCAPE-HATCH design: EC has no to_id-leading index for per-entity '
  're-aggregation, and the Monday full EC rebuild freshens derived_at on every '
  'row so a watermark would degenerate to a full pass anyway. pg_cron Mon+Wed '
  '11:00 UTC, after the 08:00 EC rebuild jobs. Runtime budget = postgres role '
  'default statement_timeout (6h) armed at CALL start (FIX-703).';

-- ═══ 6. Compat shims (PostgREST/franklin callers; nothing may REFRESH an MV) ═
-- refresh_entity_connection_stats_mv(): was REFRESH MATERIALIZED VIEW
-- CONCURRENTLY. Now a full single-txn rebuild — fine for local/dev callers
-- (franklin --refresh-all-mvs, the rebuild script's PostgREST fallback); on
-- prod PostgREST it exceeds the ~8s service_role statement_timeout and rolls
-- back untouched, which is EXACTLY what the old REFRESH did there (it never
-- completed inside the cap). The pg_cron procedure is the durable path.
CREATE OR REPLACE FUNCTION public.refresh_entity_connection_stats_mv()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.entity_connection_stats_mv;
  INSERT INTO public.entity_connection_stats_mv (
    entity_id, connection_count, vote_count, has_donation, has_vote
  )
  SELECT
    sub.id                                          AS entity_id,
    COUNT(*)::BIGINT                                AS connection_count,
    COUNT(*) FILTER (
      WHERE sub.connection_type IN (
        'vote_yes', 'vote_no', 'vote_abstain',
        'nomination_vote_yes', 'nomination_vote_no'
      )
    )::BIGINT                                       AS vote_count,
    bool_or(sub.connection_type = 'donation')       AS has_donation,
    bool_or(sub.connection_type IN (
      'vote_yes', 'vote_no', 'vote_abstain',
      'nomination_vote_yes', 'nomination_vote_no'
    ))                                              AS has_vote
  FROM (
    SELECT from_id AS id, connection_type FROM public.entity_connections
    UNION ALL
    SELECT to_id   AS id, connection_type FROM public.entity_connections
  ) sub
  GROUP BY sub.id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.refresh_entity_connection_stats_mv() TO authenticated, service_role;

COMMENT ON FUNCTION public.refresh_entity_connection_stats_mv() IS
  'FIX-509/FIX-717 — compat shim over the entity_connection_stats_mv TABLE (was '
  'REFRESH MATERIALIZED VIEW CONCURRENTLY). Full single-txn rebuild for '
  'local/dev callers; a capped PostgREST caller times out and rolls back '
  'harmlessly. Durable path: CALL public.rebuild_entity_connection_stats().';

-- refresh_donor_party_rollup_mv(): dirty-scoped single-txn refresh (the FIX-704
-- compat-shim shape). Fine for the small dirty sets local callers produce; a
-- big dirty set times out at the caller's cap and rolls back untouched
-- (watermark un-advanced — the weekly procedure picks it up).
CREATE OR REPLACE FUNCTION public.refresh_donor_party_rollup_mv()
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
  FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  IF v_watermark IS NULL THEN
    RAISE WARNING 'refresh_donor_party_rollup_mv: no donor_party_rollup_watermark — '
      'run CALL public.refresh_donor_party_rollup_incremental() (staged bootstrap) instead';
    RETURN;
  END IF;

  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation'
    AND fr.from_type = 'financial_entity'
    AND fr.to_type   = 'official'
    AND fr.updated_at > v_watermark;

  IF COALESCE(array_length(v_dirty, 1), 0) > 0 THEN
    PERFORM public.donor_party_rollup_rebuild_donors(v_dirty);
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_party_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_new_max, NOW())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$$;
GRANT EXECUTE ON FUNCTION public.refresh_donor_party_rollup_mv() TO authenticated, service_role;

COMMENT ON FUNCTION public.refresh_donor_party_rollup_mv() IS
  'FIX-518/FIX-718 — compat shim over the donor_party_rollup_mv TABLE (was '
  'REFRESH MATERIALIZED VIEW CONCURRENTLY). Dirty-scoped single-txn refresh; '
  'NULL watermark → no-op with a WARNING (use the pg_cron procedure).';

-- ═══ 7. Monthly orphan sweeps (FIX-705 discipline) ═══════════════════════════
CREATE OR REPLACE PROCEDURE public.reconcile_donor_party_rollup_orphans()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_party_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[dpr-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_orphan_sweep', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- DELETE rollup rows for any donor with NO surviving qualifying FR row —
  -- same predicate as donor_party_rollup_rebuild_donors. The FR.updated_at
  -- watermark cannot see hard deletes (FIX-705 blind spot); this is the
  -- catch-all. Single set-based anti-join.
  BEGIN
    DELETE FROM public.donor_party_rollup_mv r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.from_id = r.donor_id
        AND fr.relationship_type = 'donation'
        AND fr.from_type = 'financial_entity'
        AND fr.to_type   = 'official'
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [dpr-orphans] orphan rollup rows deleted: %', v_deleted;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [dpr-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[dpr-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_donor_party_rollup_orphans() TO service_role;

COMMENT ON PROCEDURE public.reconcile_donor_party_rollup_orphans() IS
  'FIX-718 — monthly hard-delete orphan sweep for donor_party_rollup_mv. Single '
  'anti-join DELETE of rows whose donor has no surviving qualifying FR '
  '(donation, from_type=fe, to_type=official) — the FR.updated_at watermark '
  'blind spot. Break-glass full rebuild: clear donor_party_rollup_watermark + '
  'CALL refresh_donor_party_rollup_incremental().';

CREATE OR REPLACE PROCEDURE public.reconcile_entity_connection_stats_orphans()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_entity_connection_stats_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[ec-stats-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('entity_connection_stats_orphan_sweep', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- Belt-and-braces: the staged full rebuild removes orphans by construction
  -- (windowed DELETE covers the whole keyspace), so this normally deletes ~0
  -- rows. Kept per the FIX-705 discipline — it guards a future incremental
  -- conversion and any window that failed complete-if-stale.
  BEGIN
    DELETE FROM public.entity_connection_stats_mv s
    WHERE NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.from_id = s.entity_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.to_id = s.entity_id
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [ec-stats-orphans] orphan stats rows deleted: %', v_deleted;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [ec-stats-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[ec-stats-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_entity_connection_stats_orphans() TO service_role;

COMMENT ON PROCEDURE public.reconcile_entity_connection_stats_orphans() IS
  'FIX-717 — monthly orphan sweep for entity_connection_stats_mv (rows whose '
  'entity no longer touches any entity_connections edge). Normally a no-op — '
  'the staged full rebuild removes orphans by construction — kept as '
  'belt-and-braces per the FIX-705 discipline.';

-- ═══ 8. pg_cron jobs — created PAUSED (FIX-704 discipline) ═══════════════════
--   entity-connection-stats-rebuild       Mon+Wed 11:00 UTC — after the 08:00
--     EC rebuild jobs (~30-40 min full + slack). Rare 1st-of-month overlap with
--     ec-recipient-count-reconcile (11:00 monthly) is accepted: separate
--     advisory locks, both chunked/committed.
--   donor-party-rollup-refresh            Tue 08:45 UTC weekly — post-FEC-Sunday,
--     offset from donor-rollup-refresh (08:00), ahead of
--     financial-entity-totals-incremental (09:00).
--   donor-party-rollup-orphan-sweep       1st 13:00 UTC monthly.
--   entity-connection-stats-orphan-sweep  1st 13:30 UTC monthly.
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('entity-connection-stats-rebuild', 'donor-party-rollup-refresh',
                   'donor-party-rollup-orphan-sweep', 'entity-connection-stats-orphan-sweep');

SELECT cron.schedule(
  'entity-connection-stats-rebuild',
  '0 11 * * 1,3',
  $$CALL public.rebuild_entity_connection_stats();$$
);

SELECT cron.schedule(
  'donor-party-rollup-refresh',
  '45 8 * * 2',
  $$CALL public.refresh_donor_party_rollup_incremental();$$
);

SELECT cron.schedule(
  'donor-party-rollup-orphan-sweep',
  '0 13 1 * *',
  $$CALL public.reconcile_donor_party_rollup_orphans();$$
);

SELECT cron.schedule(
  'entity-connection-stats-orphan-sweep',
  '30 13 1 * *',
  $$CALL public.reconcile_entity_connection_stats_orphans();$$
);

SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job
 WHERE jobname IN ('entity-connection-stats-rebuild', 'donor-party-rollup-refresh',
                   'donor-party-rollup-orphan-sweep', 'entity-connection-stats-orphan-sweep');

-- PostgREST: the MV→table swaps change relkind under the same names; nudge the
-- schema cache so the .from() reads keep resolving.
NOTIFY pgrst, 'reload schema';
