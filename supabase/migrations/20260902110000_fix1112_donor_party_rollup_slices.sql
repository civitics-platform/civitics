-- =============================================================================
-- FIX-1112 — jobid 17 banks its watermark per slice. The ratchet ends.
--
-- THE MEASUREMENT (prod, 2026-09-02).
--
--   donor_party_rollup_watermark  = 2026-07-28 05:54:28.48494+00
--   pipeline_state.updated_at     = 2026-07-28 08:50:51+00     ← 36 days ago
--   cadence                       = weekly (Tue 15:00 UTC), cron_job_budget 1,800 s
--
--   dirty since the watermark: 7,252,207 financial_relationships rows,
--                              3,326,070 distinct from_id (98.4% donations)
--
-- THE RATCHET, exactly. refresh_donor_party_rollup_incremental() writes
-- donor_party_rollup_watermark ONLY after its loop finishes cleanly, and
-- `EXCEPTION WHEN OTHERS` does not match query_canceled (57014). So when the
-- FIX-1063 watchdog cancels the run at 1,800 s the error blows out of the
-- procedure: the terminal UPDATE never runs (row stranded 'running' for the
-- reaper) AND the watermark never moves. The next firing therefore starts from
-- the SAME watermark against a strictly LARGER dirty set. Every week it gets
-- worse, and it has been getting worse since 2026-07-28:
--
--   runid    start                    secs      outcome
--   114      2026-07-28 08:45:00       351.7    succeeded  ← last clean run
--   166      2026-08-04 08:45:00    21,628.6    canceled (6h statement timeout)
--   232      2026-08-11 08:45:00       288.1    job startup timeout
--   4346     2026-08-18 08:45:00        10.1    job startup timeout
--   15764    2026-08-25 15:00:00        10.1    job startup timeout
--   26195    2026-09-01 15:00:00     1,814.6    canceled (watchdog, 1,800 s budget)
--
-- WHERE THE 1,814 SECONDS WENT — and it is not where it looks. The procedure
-- builds `array_agg(DISTINCT fr.from_id)` over everything since the watermark,
-- i.e. materialises 3.3M uuids into a PL/pgSQL array, and then uses that array
-- ONLY to compute `v_n_dirty` for the mode gate:
--
--     v_mode := CASE WHEN v_watermark IS NULL          THEN 'bootstrap'
--                    WHEN v_n_dirty > c_full_threshold THEN 'full'
--                    ELSE 'incremental' END;
--
-- 3,326,070 > c_full_threshold (300,000), so the run takes the 'full' branch and
-- THROWS THE ARRAY AWAY. The whole budget was spent building a value that was
-- discarded — and then the watchdog killed it before the full rebuild it had
-- just decided to do could start. The cancel's own CONTEXT confirms it:
-- "canceling statement due to user request / CONTEXT: SQL statement "SELECT ".
--
-- THE REWRITE, on the FIX-1031/969 fe-crawl shape.
--
-- (1) refresh_donor_party_rollup_slice() — NEW. One bounded, ATOMIC unit.
--     Picks slice_end by an index scan of exactly slice_rows entries on
--     financial_relationships_updated_at BEFORE doing any work, rebuilds every
--     dirty donor in (watermark, slice_end] through the existing
--     donor_party_rollup_rebuild_donors(), and writes the new watermark IN THE
--     SAME TRANSACTION. It is a FUNCTION, so it physically cannot COMMIT even
--     if a later edit wanted it to: rows and watermark are indivisible, and a
--     cancel loses ONE slice instead of everything since 2026-07-28.
--
--     Slicing by time is exact here because donor_party_rollup_rebuild_donors()
--     recomputes each donor's FULL qualifying FR set (the FIX-372/373 rule),
--     not a delta. So the operation is order-independent and idempotent: a
--     donor that appears in three slices is simply rebuilt three times to the
--     same value. That is what makes "split the window" a safe transformation
--     and not an approximation.
--
--     The slice picker deliberately scans ALL FR rows, not just donations, so
--     it rides the plain financial_relationships_updated_at index. Donations
--     are 98.4% of the backlog, so at most a rounding error of slices advance
--     the watermark with no donation work — cheap, and it can never MISS a
--     donation row, because the window covers every timestamp in
--     (watermark, slice_end].
--
-- (2) The procedure keeps its name and signature (no DROP, no overload risk)
--     and becomes a driver with three paths:
--
--     bootstrap  — watermark absent. The existing staged full rebuild, verbatim.
--     full       — watermark present but LAG > full_rebuild_lag_days (14d).
--     crawl      — the normal path: slices until caught up, the unit cap, or
--                  the wall-clock budget.
--
--     The mode decision is now O(1): two index probes (the stored watermark and
--     max(updated_at)) and a timestamp subtraction. It never builds the 3.3M
--     array. That alone would have made the 2026-09-01 firing succeed.
--
-- (3) WHY A LAG ESCAPE AND NOT "JUST SLICE IT". A full rebuild's cost is
--     independent of how far behind the watermark is — it recomputes the whole
--     MV either way — and prod has measured it repeatedly:
--
--       2026-07-28  full path  1,314,597 rows   351.7 s
--       2026-07-14  full path  1,299,829 rows   388.1 s
--       2026-07-11  full path  1,299,644 rows   285.2 s
--
--     ~350-420 s against a 1,800 s budget. Crawling the same backlog would take
--     ~145 slices at slice_rows=50,000, i.e. many weekly firings. So once the
--     lag is large the full rebuild is both cheaper AND exact, and the escape
--     picks it. Below the threshold, slices are cheaper and bank progress
--     per unit, so the crawl picks those. Each mechanism is used where it wins.
--
--     A cancelled full rebuild is NOT a ratchet: the watermark stays put, and
--     the next firing redoes a ~350 s rebuild, not a larger one. That is the
--     property the old code lacked in BOTH directions.
--
--     CONSEQUENCE, stated plainly: the next scheduled firing (Tue 2026-09-08
--     15:00 UTC) will see a 36-day lag, take the full path, and re-baseline the
--     watermark in one ~350-420 s run inside the 1,800 s budget. No supervised
--     drain is required. Nothing in this migration writes data; the schedule
--     does the work on its own schedule, and jobid 17's cadence, budget and
--     active flag are untouched.
--
-- (4) The FIX-1028 handler on every loop, per the sweep in 20260902100000.
--     A cancel closes the row 'partial' with completed_at = clock_timestamp(),
--     'canceled — …', and metadata.canceled/cancel_detail/elapsed_seconds/
--     next_slice_from.
--
-- NOT TOUCHED: refresh_donor_party_rollup_mv(). Note for the record that it is
-- NOT a full rebuild despite the name — it is a single-transaction INCREMENTAL
-- rebuild off the same watermark and dirty set, so calling it against a 3.3M
-- donor backlog would be strictly worse than the staged path below, not better.
-- It is left exactly as it is.
--
-- CONFIG lives in pipeline_state key 'donor_party_crawl' (absent = defaults, so
-- this migration needs no seed row and writes no data):
--     slice_rows             50000   FR rows per slice
--     chunk_ids               5000   donors per rebuild call (was c_chunk_size)
--     unit_budget_seconds     1500   self-stop BELOW the 1,800 s watchdog
--     max_units                 40   slices per firing
--     full_rebuild_lag_days     14   lag above which the full path wins
--
-- Cross-ref FIX-1112, FIX-1028, FIX-1108, FIX-1063, FIX-1031, FIX-969,
-- FIX-991 (closed: superseded by the FE crawl), FIX-734, FIX-717/718.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. refresh_donor_party_rollup_slice() — ONE bounded, ATOMIC unit
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_donor_party_rollup_slice()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
SET work_mem = '256MB'
AS $fn$
DECLARE
  v_cfg        jsonb;
  v_slice_rows int;
  v_chunk      int;
  v_w          timestamptz;
  v_target     timestamptz;
  v_slice_end  timestamptz;
  v_dirty      uuid[];
  v_n          int;
  v_i          int;
  v_ids        uuid[];
  v_rows       bigint := 0;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  v_cfg        := COALESCE(v_cfg, '{}'::jsonb);
  v_slice_rows := GREATEST(COALESCE((v_cfg->>'slice_rows')::int, 50000), 1000);
  v_chunk      := GREATEST(COALESCE((v_cfg->>'chunk_ids')::int,  5000),  100);

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_w
    FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  IF v_w IS NULL THEN
    -- A NULL watermark is the bootstrap case and cannot be served by slices:
    -- the incremental path only touches donors present in its dirty set, so it
    -- can never DELETE a rollup row whose last qualifying FR vanished. The
    -- caller drives the staged full rebuild instead. Defined behaviour.
    RETURN jsonb_build_object('bootstrap_required', true);
  END IF;

  -- O(1) via financial_relationships_updated_at, backward.
  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  IF v_target IS NULL OR v_target <= v_w THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w,
                              'donors', 0, 'rows_written', 0);
  END IF;

  -- ── the bound, established BEFORE any work ───────────────────────────────
  -- An index scan of exactly v_slice_rows entries. If a single timestamp is
  -- shared by more rows than that, slice_end lands on it and the slice is
  -- larger than nominal — but it is still strictly greater than the watermark,
  -- so the crawl can never fail to advance. That is the property that matters.
  SELECT max(s.updated_at) INTO v_slice_end
    FROM (SELECT fr.updated_at
            FROM public.financial_relationships fr
           WHERE fr.updated_at >  v_w
             AND fr.updated_at <= v_target
           ORDER BY fr.updated_at
           LIMIT v_slice_rows) s;

  IF v_slice_end IS NULL THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w,
                              'donors', 0, 'rows_written', 0);
  END IF;

  -- ── the dirty set, scoped to this slice ──────────────────────────────────
  -- Byte-for-byte the predicates refresh_donor_party_rollup_incremental() has
  -- always used; only the upper time bound is new. This is a pacing change,
  -- not a semantics change.
  SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty
    FROM public.financial_relationships fr
   WHERE fr.relationship_type = 'donation'
     AND fr.from_type = 'financial_entity'
     AND fr.to_type   = 'official'
     AND fr.updated_at >  v_w
     AND fr.updated_at <= v_slice_end;

  v_n := COALESCE(array_length(v_dirty, 1), 0);
  v_i := 1;
  WHILE v_i <= v_n LOOP
    v_ids  := v_dirty[v_i : LEAST(v_i + v_chunk - 1, v_n)];
    v_rows := v_rows + public.donor_party_rollup_rebuild_donors(v_ids);
    v_i    := v_i + v_chunk;
  END LOOP;

  -- ── the watermark, in this same transaction ──────────────────────────────
  -- No COMMIT above and none here. Either every row this slice wrote AND this
  -- advance are durable, or neither is. FIX-1112's rule, enforced by the
  -- language: this is a FUNCTION, so it cannot COMMIT even if a future edit
  -- wanted it to.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_party_rollup_watermark',
          jsonb_build_object('last_indexed_at', v_slice_end::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = clock_timestamp();

  RETURN jsonb_build_object(
    'caught_up',    v_slice_end >= v_target,
    'watermark',    v_slice_end,
    'from',         v_w,
    'donors',       v_n,
    'rows_written', v_rows);
END;
$fn$;

REVOKE ALL ON FUNCTION public.refresh_donor_party_rollup_slice() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_donor_party_rollup_slice() TO service_role;

COMMENT ON FUNCTION public.refresh_donor_party_rollup_slice() IS
  'FIX-1112 — ONE bounded, ATOMIC unit of the donor-party rollup crawl. '
  'Advances donor_party_rollup_watermark by a slice of at most '
  'donor_party_crawl.slice_rows financial_relationships rows, chosen by an index '
  'scan of exactly that many entries BEFORE any work is done, then re-derives '
  'the dirty donors through donor_party_rollup_rebuild_donors() and writes the '
  'new watermark IN THE SAME TRANSACTION. It is a FUNCTION rather than a '
  'PROCEDURE so it physically cannot COMMIT mid-slice: rows and watermark are '
  'indivisible, which is what makes a watchdog cancel lose one slice instead of '
  'everything since the last clean run. Slicing by time is exact because '
  'donor_party_rollup_rebuild_donors() recomputes each donor''s FULL qualifying '
  'FR set, so it is order-independent and idempotent. Returns '
  '{bootstrap_required} when the watermark is NULL.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. refresh_donor_party_rollup_incremental() — the driver (jobid 17)
--
--    Same name, same (empty) signature, so cron.job's command needs no change
--    and there is no overload to disambiguate.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key   bigint := hashtext('donor_party_rollup_refresh')::bigint;
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
  v_cfg        jsonb;
  v_budget     interval;
  v_max_units  int;
  v_full_lag   interval;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_target     timestamptz;
  v_lag        interval;
  v_mode       text;
  v_i          int;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint := 0;
  v_n          bigint;
  v_units      int     := 0;
  v_donors     bigint  := 0;
  v_capped     boolean := false;
  v_caught_up  boolean := false;
  v_failures   text[]  := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text    := NULL;
  -- FIX-979 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
  v_res        jsonb;
  i            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-party-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-party-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Plain SET (not SET LOCAL) survives the per-unit COMMITs. NOTE (FIX-703):
  -- the CALL's statement_timeout is the postgres role default (6h) armed at
  -- CALL start — nothing in this body can change it. The budget guard below and
  -- the FIX-1063 watchdog are the real stops.
  SET work_mem = '256MB';

  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  v_cfg       := COALESCE(v_cfg, '{}'::jsonb);
  v_budget    := make_interval(secs => GREATEST(
                   COALESCE((v_cfg->>'unit_budget_seconds')::numeric, 1500), 60));
  v_max_units := GREATEST(COALESCE((v_cfg->>'max_units')::int, 40), 1);
  v_full_lag  := make_interval(days => GREATEST(
                   COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));

  -- ── the mode decision, O(1) ──────────────────────────────────────────────
  -- Two index probes and a subtraction. The old body materialised
  -- array_agg(DISTINCT from_id) over the whole backlog — 3.3M uuids on
  -- 2026-09-02 — purely to compare its length against a threshold, then
  -- discarded it. That array build IS the 1,814 s that the watchdog killed on
  -- 2026-09-01. It is gone.
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  v_lag  := CASE WHEN v_watermark IS NULL OR v_target IS NULL
                 THEN NULL ELSE v_target - v_watermark END;
  v_mode := CASE
              WHEN v_watermark IS NULL     THEN 'bootstrap'
              WHEN v_lag > v_full_lag      THEN 'full'
              ELSE                              'crawl'
            END;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_refresh', 'running', v_started,
          jsonb_build_object('mode', v_mode, 'source', 'pg_cron',
                             'watermark_before', v_watermark,
                             'lag', v_lag::text,
                             'full_rebuild_lag', v_full_lag::text,
                             'max_units', v_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_mode IN ('bootstrap', 'full') THEN
    -- ═══ Staged full rebuild ═══════════════════════════════════════════════
    -- ONE set-based scan (the FIX-734 lesson) into a session temp stage, then
    -- 16 donor-id-windowed DELETE+INSERT applies with per-window COMMIT
    -- (FIX-703 bounded-txn discipline). Readers keep prior rows per un-applied
    -- window (complete-if-stale, never missing).
    --
    -- Cost is independent of the lag: ~350-420 s on prod regardless of how far
    -- behind the watermark is. That is why it is the right answer once the lag
    -- is large, and why a cancelled full rebuild does not ratchet — the next
    -- firing redoes the same ~350 s, not a bigger one.
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
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('stage build: %s', SQLERRM);
      RAISE WARNING '[donor-party-rollup] stage build CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('stage build: %s', SQLERRM);
      RAISE WARNING '[donor-party-rollup] stage build FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level (temp table persists across COMMIT for the session)

    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
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
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('window %s: %s', i, SQLERRM);
          RAISE WARNING '  [donor-party-rollup] window %/16 CANCELED: %', i, SQLERRM;
        WHEN OTHERS THEN
          v_failures := v_failures || format('window %s: %s', i, SQLERRM);
          RAISE WARNING '  [donor-party-rollup] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;  -- top level, outside the EXCEPTION subtransaction
        -- FIX-1028 — the box has just proven it cannot finish one window; the
        -- remaining ones would each re-arm the same axe.
        EXIT WHEN v_canceled IS NOT NULL;
      END LOOP;
      v_units := 1;
    END IF;

    DROP TABLE IF EXISTS dpr_stage;
    COMMIT;

    -- The full rebuild recomputed EVERY donor, so on a clean finish the
    -- watermark can jump straight to the target captured before it started.
    -- FR writes that landed during the rebuild are strictly after v_target and
    -- are re-processed by the next firing's crawl, never silently consumed.
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_party_rollup_watermark',
              jsonb_build_object('last_indexed_at',
                COALESCE(v_target, clock_timestamp())::text))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = clock_timestamp();
      v_caught_up := true;
      COMMIT;
    END IF;

  ELSE
    -- ═══ CRAWL PATH — the normal one ═══════════════════════════════════════
    WHILE v_units < v_max_units LOOP
      IF clock_timestamp() - v_started >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] BUDGET EXHAUSTED before slice %; stopping cleanly', v_units + 1;
        EXIT;
      END IF;

      v_res := NULL;
      BEGIN
        v_res    := public.refresh_donor_party_rollup_slice();
        v_rows   := v_rows   + COALESCE((v_res->>'rows_written')::bigint, 0);
        v_donors := v_donors + COALESCE((v_res->>'donors')::bigint, 0);
      EXCEPTION
      -- FIX-1028 — by name. The slice is atomic, so a cancel here has already
      -- rolled back BOTH its rows and its watermark advance. Nothing is
      -- stranded and nothing is skipped; the next firing retries the same
      -- slice. That is the whole point of FIX-1112.
      WHEN query_canceled THEN
        v_canceled := format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % CANCELED (rolled back whole — watermark unmoved): %',
          v_units + 1, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % FAILED: %', v_units + 1, SQLERRM;
      END;
      COMMIT;

      IF v_res IS NOT NULL AND COALESCE((v_res->>'bootstrap_required')::boolean, false) THEN
        RAISE WARNING '  [donor-party-rollup] watermark vanished mid-run — bootstrap required; stopping';
        EXIT;
      END IF;

      EXIT WHEN v_canceled IS NOT NULL;
      EXIT WHEN COALESCE(array_length(v_failures, 1), 0) > 0;

      v_units := v_units + 1;

      IF v_res IS NOT NULL THEN
        RAISE NOTICE '  [donor-party-rollup] slice -> % — % donors, % rows',
          v_res->>'watermark', v_res->>'donors', v_res->>'rows_written';
        IF COALESCE((v_res->>'caught_up')::boolean, false) THEN
          v_caught_up := true;
          RAISE NOTICE '  [donor-party-rollup] CAUGHT UP — watermark is at the newest FR write';
          EXIT;
        END IF;
      END IF;
    END LOOP;

    IF v_units >= v_max_units AND NOT v_caught_up AND v_canceled IS NULL
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      v_capped := true;
    END IF;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        WHEN v_capped                        THEN 'partial'
                        ELSE 'complete'
                      END,
      -- FIX-979/981: clock_timestamp(), not now() — this transaction began
      -- after the last unit's COMMIT.
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; every COMMITTED slice kept its watermark, the next firing resumes from it', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_capped
                          THEN left(format('%s — %s unit(s) run, resumable',
                                 CASE WHEN v_units >= v_max_units THEN 'unit cap reached'
                                      ELSE 'wall-clock budget reached' END, v_units), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode',            v_mode,
                        'units_run',       v_units,
                        'unit_capped',     v_capped,
                        'caught_up',       v_caught_up,
                        'dirty_donors',    v_donors,
                        'rollup_rows',     v_rows,
                        'failures',        COALESCE(array_length(v_failures, 1), 0),
                        'canceled',        v_canceled IS NOT NULL,
                        'cancel_detail',   v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- Where the next firing picks up. On the old code this
                        -- was always the same value as watermark_before, which
                        -- is what the ratchet looked like in the log.
                        'next_slice_from', (SELECT value->>'last_indexed_at'
                                              FROM public.pipeline_state
                                             WHERE key = 'donor_party_rollup_watermark'))
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-party-rollup] % (mode=%) — % unit(s), % donors, % rows, watermark now %',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'FAILED'
         WHEN v_caught_up THEN 'CAUGHT UP'
         WHEN v_capped THEN 'UNIT CAP' ELSE 'complete' END,
    v_mode, v_units, v_donors, v_rows,
    (SELECT value->>'last_indexed_at' FROM public.pipeline_state
      WHERE key = 'donor_party_rollup_watermark');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.refresh_donor_party_rollup_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_donor_party_rollup_incremental() TO service_role;

COMMENT ON PROCEDURE public.refresh_donor_party_rollup_incremental() IS
  'FIX-1112 — jobid 17 (donor-party-rollup-refresh). Three paths: bootstrap '
  '(watermark absent) and full (lag > donor_party_crawl.full_rebuild_lag_days, '
  'default 14d) both run the staged 16-window full rebuild, whose cost is '
  'independent of the lag (~350-420 s measured on prod); crawl runs bounded '
  'ATOMIC slices via refresh_donor_party_rollup_slice(), each banking '
  'donor_party_rollup_watermark in its own transaction. Before FIX-1112 the '
  'watermark was written only after the loop and EXCEPTION WHEN OTHERS did not '
  'match query_canceled, so every watchdog cancel discarded the whole run and '
  'the next firing faced a strictly larger dirty set — the watermark sat at '
  '2026-07-28 for 36 days behind 7.25M dirty FR rows. The mode decision is now '
  'O(1) (two index probes) instead of materialising a 3.3M-element uuid array '
  'that the full path then threw away.';
