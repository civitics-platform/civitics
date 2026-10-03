-- FIX-1240 — the two donor rollups' industry labels follow a tag change.
--
-- official_donor_rollup_mv and donor_party_rollup_mv (both TABLES) denormalize a
-- donor's primary industry into industry_tag / industry_label at write time,
-- from primary_industry_tag() (FIX-918). Their incremental owners —
-- donor_rollup_rebuild_bulk() (jobid 24) and
-- refresh_donor_party_rollup_incremental() (jobid 17) — key their dirty sets on
-- financial_relationships.updated_at, so a tag or ranking change reached them
-- only when one of the donor's donation rows happened to go dirty. FIX-958's
-- trigger (refresh_sector_affinity_from_tag_changes, Path 3) rebuilt the
-- officials side only; its decision 6 ("the gap was officials-only") never
-- named these two tables.
--
-- Measured on prod 2026-10-03 04:01 UTC (cc-182 read 2): 599 rows / 71 donors /
-- $27,506,473.17 drifted in official_donor_rollup_mv (rank <= 200) and 90 rows /
-- 39 donors / $4,430,935.00 in donor_party_rollup_mv — 77 distinct donors, every
-- one of them with a donor_industry_tag_state signature EQUAL to its live one,
-- i.e. Path 3 had already consumed the change and the labels never followed.
--
-- THE SHAPE. A tag change moves only the label columns: rank, totals and
-- tx_count are functions of financial_relationships alone, so they cannot move.
-- The fix is therefore an in-place UPDATE of the two label columns keyed on
-- donor_id — NOT the bullet's per-recipient rebuild, which re-aggregates every
-- recipient from FR and then runs six per-official arms: 19.0-24.0 s per
-- recipient on prod (20260903050000_fix973), and FIX-918's re-dirty night
-- touched 1,068 officials = 5.6-7.1 h inside a 90-minute tail.
--
-- 1. sync_rollup_industry_labels(p_donors uuid[]) — the UPDATE, both tables.
--    p_donors IS NULL = every row (the one-time backfill + Path 2). A donor that
--    lost all its industry tags gets NULL labels (the LEFT JOIN arm). Returns
--    rows updated per table. Exactly what the owners would write: the bulk path
--    reads primary_industry_tag(NULL), the per-recipient and donor-party paths
--    primary_industry_tag(<ids>) — the same pick by construction (two copies of
--    one ORDER BY in one function), so a later owner rebuild of a synced row
--    writes the same values (rule 138).
--    Clone (08-10 restore): array arm, 525 donors, 0.11 s; NULL arm 2.85 s;
--    official_donor_rollup_mv's donor_id predicate is a 0.23 s scan, so no
--    donor_id index (the bar was 10 s). donor_party_rollup_mv's PK leads on
--    donor_id.
-- 2. refresh_sector_affinity_from_tag_changes() — rebuilt on the PROD body
--    (byte-equal to 20260927020000_fix918:2461-2739, read 2026-10-03), +N/-0:
--      * Path 3: after the chunk loop and BEFORE the shadow gate, sync the
--        night's changed donors (v_donors). Guarded on v_n_donors > 0 — with no
--        changed donor v_donors is NULL, and NULL means "every row" to the sync.
--        A failure appends to v_failures and a cancel sets v_canceled, so the
--        shadow does not advance and the next night re-derives the same diff —
--        the design's safety, unchanged. It runs in the same final transaction
--        as the shadow rewrite, so the labels and the shadow move together.
--      * Path 2 (cold start): sync every row after the backfill, BEFORE the
--        shadow is seeded, so a failure leaves the signature unseeded and the
--        next run retries the cold path (Path 2's existing fail-safe).
--      * Path 1: untouched.
--      * The stamp gains rollup_labels_updated
--        {official_donor_rollup_mv: n, donor_party_rollup_mv: m}.
--    Lock, FIX-950 defer, SET work_mem statement and COMMIT points unchanged; no
--    proconfig (a SET clause would make the procedure atomic and its COMMITs
--    illegal — FIX-1128). Grants are untouched by CREATE OR REPLACE.
--    One blind spot, stated: the per-donor signature covers
--    tag:generated_by:confidence, not display_label, so a label-only edit to an
--    unchanged tag moves neither the signature nor these columns. Read 2 found
--    zero such rows (every drifted row's tag moved).
-- 3. The one-time backfill of today's drift: sync_rollup_industry_labels(NULL).
--    Prod's read of the same predicate took 4.9 s + 25.5 s — the UPDATE's lower
--    bound, well under the 60 s per table that would move it out of here.
--    The dead tuples it leaves (~700) belong to the tables' own vacuum jobs
--    (odr-mv-vacuum-analyze 11:05/17:05, dpr-vacuum-analyze Sun/Wed 02:00) —
--    no VACUUM here (rule 41).

SET statement_timeout = '15min';

-- ── 1. the label sync ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_rollup_industry_labels(p_donors uuid[])
RETURNS TABLE (table_name text, rows_updated bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_odr bigint := 0;
  v_dpr bigint := 0;
BEGIN
  IF p_donors IS NULL THEN
    -- Every row. Join each table to the full pick ONCE and update what differs,
    -- by primary key — the LEFT JOIN is what lets a donor that lost every
    -- industry tag fall back to NULL labels.
    WITH pit AS MATERIALIZED (
      SELECT p.entity_id, p.tag, p.display_label
        FROM public.primary_industry_tag(NULL) p
    ), x AS (
      SELECT m.official_id, m.relationship_type, m.rank, pit.tag, pit.display_label
        FROM public.official_donor_rollup_mv m
        LEFT JOIN pit ON pit.entity_id = m.donor_id
       WHERE m.rank <= 200                 -- 201 is the tail row: no donor, no label
         AND m.donor_id IS NOT NULL
         AND (m.industry_tag, m.industry_label) IS DISTINCT FROM (pit.tag, pit.display_label)
    )
    UPDATE public.official_donor_rollup_mv t
       SET industry_tag = x.tag, industry_label = x.display_label
      FROM x
     WHERE t.official_id       = x.official_id
       AND t.relationship_type = x.relationship_type
       AND t.rank              = x.rank;
    GET DIAGNOSTICS v_odr = ROW_COUNT;

    WITH pit AS MATERIALIZED (
      SELECT p.entity_id, p.tag, p.display_label
        FROM public.primary_industry_tag(NULL) p
    ), x AS (
      SELECT m.donor_id, m.party_key, pit.tag, pit.display_label
        FROM public.donor_party_rollup_mv m
        LEFT JOIN pit ON pit.entity_id = m.donor_id
       WHERE (m.industry_tag, m.industry_label) IS DISTINCT FROM (pit.tag, pit.display_label)
    )
    UPDATE public.donor_party_rollup_mv t
       SET industry_tag = x.tag, industry_label = x.display_label
      FROM x
     WHERE t.donor_id  = x.donor_id
       AND t.party_key = x.party_key;
    GET DIAGNOSTICS v_dpr = ROW_COUNT;
  ELSE
    -- The given donors. Each one is LEFT JOINed to its pick, so a donor with no
    -- industry tag left reads NULL and its rows are cleared.
    WITH x AS (
      SELECT d.donor_id, pit.tag, pit.display_label
        FROM (SELECT DISTINCT u.id AS donor_id
                FROM unnest(p_donors) AS u(id)
               WHERE u.id IS NOT NULL) d
        LEFT JOIN public.primary_industry_tag(p_donors) pit ON pit.entity_id = d.donor_id
    )
    UPDATE public.official_donor_rollup_mv t
       SET industry_tag = x.tag, industry_label = x.display_label
      FROM x
     WHERE t.donor_id = x.donor_id
       AND t.rank <= 200
       AND (t.industry_tag, t.industry_label) IS DISTINCT FROM (x.tag, x.display_label);
    GET DIAGNOSTICS v_odr = ROW_COUNT;

    WITH x AS (
      SELECT d.donor_id, pit.tag, pit.display_label
        FROM (SELECT DISTINCT u.id AS donor_id
                FROM unnest(p_donors) AS u(id)
               WHERE u.id IS NOT NULL) d
        LEFT JOIN public.primary_industry_tag(p_donors) pit ON pit.entity_id = d.donor_id
    )
    UPDATE public.donor_party_rollup_mv t
       SET industry_tag = x.tag, industry_label = x.display_label
      FROM x
     WHERE t.donor_id = x.donor_id
       AND (t.industry_tag, t.industry_label) IS DISTINCT FROM (x.tag, x.display_label);
    GET DIAGNOSTICS v_dpr = ROW_COUNT;
  END IF;

  RETURN QUERY VALUES ('official_donor_rollup_mv'::text, v_odr),
                      ('donor_party_rollup_mv'::text,    v_dpr);
END;
$function$;

COMMENT ON FUNCTION public.sync_rollup_industry_labels(uuid[]) IS
  'FIX-1240 — set official_donor_rollup_mv / donor_party_rollup_mv industry_tag + '
  'industry_label to primary_industry_tag() for the given donors (NULL = every '
  'row), in place; rank, totals and tx_count are untouched. Called by Path 3 of '
  'refresh_sector_affinity_from_tag_changes() for the night''s changed donors and '
  'by Path 2 for all. Returns rows updated per table.';

REVOKE ALL ON FUNCTION public.sync_rollup_industry_labels(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_rollup_industry_labels(uuid[]) TO service_role;

-- ── 2. the hook: refresh_sector_affinity_from_tag_changes() ───────────────────
-- Rebuilt on the prod body (20260927020000_fix918:2461-2739). +N/-0.
CREATE OR REPLACE PROCEDURE public.refresh_sector_affinity_from_tag_changes()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('sector_affinity_tag_refresh')::bigint;
  c_sig_key    constant text := 'sector_affinity:industry_tag_signature';
  c_chunk      constant int  := 500;   -- matches backfill_official_sector_affinity_rollup
  v_log_id     uuid;
  v_live_sig   text;
  v_stored_sig text;
  v_shadow_n   bigint;
  v_reason     text;
  v_donors     uuid[];
  v_n_donors   int;
  v_officials  uuid[];
  v_n_off      int := 0;
  v_chunk_ids  uuid[];
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1240 — rows updated per rollup table by sync_rollup_industry_labels().
  v_labels     jsonb;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text := NULL;
  -- FIX-979 — real entry time.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent sector-affinity tag refresh'));
    RAISE NOTICE '[sector-affinity tag refresh] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[sector-affinity tag refresh] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '128MB';

  -- Signature FIRST, before any rebuild: tag writes that land mid-run make the
  -- NEXT run's live signature differ from what this run stores, so they are
  -- re-processed rather than silently absorbed — the FIX-704
  -- capture-watermark-before-dirty-set discipline, content-shaped.
  v_live_sig := public.compute_fe_industry_tag_signature();

  SELECT value->>'sig' INTO v_stored_sig
    FROM public.pipeline_state WHERE key = c_sig_key;

  SELECT count(*) INTO v_shadow_n FROM public.donor_industry_tag_state;

  -- ── Path 1: no-op — identical content, zero rollup work ────────────────────
  IF v_stored_sig IS NOT NULL AND v_shadow_n > 0 AND v_live_sig = v_stored_sig THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
    VALUES ('sector_affinity_tag_refresh', 'complete', v_started, clock_timestamp(), 0,
            jsonb_build_object('path', 'noop',
                               'reason', 'industry tag content signature unchanged',
                               'sig', v_live_sig));
    RAISE NOTICE '[sector-affinity tag refresh] noop — signature unchanged (%)', v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 2: cold start / signature-store miss — the full backfill ──────────
  IF v_stored_sig IS NULL OR v_shadow_n = 0 THEN
    v_reason := CASE WHEN v_stored_sig IS NULL
                     THEN 'cold_start_no_signature'
                     ELSE 'signature_store_miss_empty_shadow' END;
    INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'running', v_started,
            jsonb_build_object('path', 'full_backfill', 'reason', v_reason))
    RETURNING id INTO v_log_id;
    COMMIT;

    -- Deliberately NOT wrapped in an EXCEPTION block: the nested procedure
    -- COMMITs per chunk, and transaction control is illegal inside a plpgsql
    -- EXCEPTION subtransaction. On failure the error propagates, the signature
    -- is never seeded, and the next run retries the cold path — fail-safe
    -- direction is REBUILD, same as the FIX-652 gate.
    --
    -- FIX-1028 NOTE: this path is therefore the one place in the sweep that
    -- CANNOT carry a query_canceled handler — the language forbids it. A cancel
    -- inside the cold-start backfill still strands the running row for the
    -- reaper. That is a structural consequence of CALLing a COMMITting
    -- procedure, not an oversight; the fix would be to inline the backfill's
    -- chunk loop here, which is out of scope for this sweep. Path 3 below (the
    -- steady-state path, and the only one a scheduled firing takes once the
    -- signature store is warm) IS protected.
    CALL public.backfill_official_sector_affinity_rollup();

    -- FIX-1240 — the two donor rollups' industry labels, every row, BEFORE the
    -- shadow is seeded: a failure propagates like the backfill's, the signature
    -- stays unseeded, and the next run retries the cold path.
    SELECT jsonb_object_agg(s.table_name, s.rows_updated) INTO v_labels
      FROM public.sync_rollup_industry_labels(NULL) s;

    DELETE FROM public.donor_industry_tag_state;
    INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
    SELECT et.entity_id,
           md5(string_agg(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''), ',' ORDER BY et.tag)),
           count(*)::int,
           clock_timestamp()   -- FIX-981: after the backfill's per-chunk COMMITs
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();

    UPDATE public.data_sync_log
       SET status = 'complete', completed_at = clock_timestamp(),
           metadata = metadata || jsonb_build_object(
             'sig', v_live_sig,
             'rollup_labels_updated', v_labels,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;

    RAISE NOTICE '[sector-affinity tag refresh] full backfill (%) — signature store seeded (%)',
      v_reason, v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 3: targeted — diff the per-donor shadow, rebuild only the affected ─
  -- FIX-918: the per-donor sig covers tag:generated_by:confidence (the ranking
  -- inputs), matching compute_fe_industry_tag_signature().
  WITH cur AS (
    SELECT et.entity_id AS donor_id,
           md5(string_agg(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''), ',' ORDER BY et.tag)) AS sig,
           count(*)::int AS n
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id
  )
  SELECT array_agg(donor_id) INTO v_donors
    FROM (
      SELECT COALESCE(c.donor_id, s.donor_id) AS donor_id
        FROM cur c
        FULL OUTER JOIN public.donor_industry_tag_state s ON s.donor_id = c.donor_id
       WHERE c.donor_id IS NULL                       -- tags removed entirely
          OR s.donor_id IS NULL                       -- newly tagged donor
          OR c.sig IS DISTINCT FROM s.tag_sig
          OR c.n   IS DISTINCT FROM s.tag_count
    ) d;

  v_n_donors := COALESCE(array_length(v_donors, 1), 0);

  -- v_n_donors = 0 with a moved global signature means tags changed between the
  -- signature capture and this diff (the shadow was already advanced past the
  -- captured signature by content that arrived mid-scan). Nothing to rebuild
  -- for THIS signature; the newer content re-diffs on the next run. Advance and
  -- log donors_changed=0 — self-healing by construction.
  IF v_n_donors > 0 THEN
    SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
      FROM unnest(v_donors) AS d(id)
      JOIN public.financial_relationships fr ON fr.from_id = d.id
     WHERE fr.relationship_type = 'donation'
       AND fr.from_type = 'financial_entity'
       AND fr.to_type   = 'official'
       AND fr.amount_cents > 0;
    v_n_off := COALESCE(array_length(v_officials, 1), 0);
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('sector_affinity_tag_refresh', 'running', v_started,
          jsonb_build_object('path', 'targeted',
                             'reason', 'industry tag content signature changed',
                             'donors_changed', v_n_donors,
                             'officials_affected', v_n_off,
                             'sig_before', v_stored_sig,
                             'sig_after', v_live_sig))
  RETURNING id INTO v_log_id;
  COMMIT;

  WHILE v_i <= v_n_off LOOP
    v_chunk_ids := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n_off)];
    v_chunk_no  := v_chunk_no + 1;
    BEGIN
      v_n    := public.sector_affinity_rebuild_officials(v_chunk_ids);
      v_rows := v_rows + v_n;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its officials keep their PRIOR
      -- rollup rows (complete-if-stale) and the un-advanced signature re-derives
      -- the same diff next run.
      v_failures := v_failures || format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction (PL/pgSQL rule)
    -- FIX-1028 — stop the sweep; the remaining chunks would each re-arm the
    -- same axe, and the signature advance below is gated so the un-covered
    -- officials stay in the next run's diff.
    EXIT WHEN v_canceled IS NOT NULL;
    v_i := v_i + c_chunk;
  END LOOP;

  -- FIX-1240 — the two donor rollups' industry labels follow the same diff.
  -- Before the shadow gate below: a failure or a cancel here keeps the shadow
  -- unadvanced, so the next run re-derives (and re-syncs) the same donors. In
  -- the final transaction with the shadow rewrite, so both move together.
  -- Guarded on v_n_donors: with no changed donor v_donors is NULL, which the
  -- sync reads as "every row".
  IF v_canceled IS NULL AND v_n_donors > 0 THEN
    BEGIN
      SELECT jsonb_object_agg(s.table_name, s.rows_updated) INTO v_labels
        FROM public.sync_rollup_industry_labels(v_donors) s;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('label sync (%s donors): %s', v_n_donors, SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] label sync CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('label sync (%s donors): %s', v_n_donors, SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] label sync FAILED: %', SQLERRM;
    END;
  END IF;

  -- Advance shadow + signature only on a clean run. FIX-1028 adds the cancel
  -- arm: a cancelled run did not rebuild every affected official, so storing
  -- the new signature would drop the remainder out of the next run's diff
  -- forever.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    IF v_n_donors > 0 THEN
      DELETE FROM public.donor_industry_tag_state s
       WHERE s.donor_id = ANY (v_donors)
         AND NOT EXISTS (
           SELECT 1 FROM public.entity_tags et
            WHERE et.entity_type  = 'financial_entity'
              AND et.tag_category = 'industry'
              AND et.entity_id    = s.donor_id);

      INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
      SELECT et.entity_id,
             md5(string_agg(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''), ',' ORDER BY et.tag)),
             count(*)::int,
             clock_timestamp()   -- FIX-981: after the chunk loop's COMMITs
        FROM unnest(v_donors) AS d(id)
        JOIN public.entity_tags et ON et.entity_id = d.id
       WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
       GROUP BY et.entity_id
      ON CONFLICT (donor_id) DO UPDATE
        SET tag_sig = EXCLUDED.tag_sig,
            tag_count = EXCLUDED.tag_count,
            updated_at = clock_timestamp();
    END IF;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  UPDATE public.data_sync_log
     SET status        = CASE
                             WHEN v_canceled IS NOT NULL          THEN 'partial'
                             WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                             ELSE 'complete'
                           END,
         completed_at  = clock_timestamp(),
         rows_inserted = v_rows,
         rows_failed   = COALESCE(array_length(v_failures, 1), 0),
         error_message = CASE
                           WHEN v_canceled IS NOT NULL
                             THEN left(format('canceled — %s; signature unmoved, the remaining officials stay in the next diff', v_canceled), 1000)
                           WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL
                         END,
         metadata      = metadata || jsonb_build_object(
                           'rollup_rows', v_rows,
                           'chunks', v_chunk_no,
                           'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                           'canceled', v_canceled IS NOT NULL,
                           'cancel_detail', v_canceled,
                           'rollup_labels_updated', v_labels,
                           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
   WHERE id = v_log_id;

  RAISE NOTICE '[sector-affinity tag refresh] % — % donor(s) changed, % official(s) in % chunk(s), % rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_n_donors, v_n_off, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

-- ── 3. the one-time backfill of today's drift ─────────────────────────────────
SELECT * FROM public.sync_rollup_industry_labels(NULL);

RESET statement_timeout;
