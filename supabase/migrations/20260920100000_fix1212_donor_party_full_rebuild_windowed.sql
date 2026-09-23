-- =============================================================================
-- FIX-1212 — the donor-party full rebuild stops being one GROUP BY over every
-- donation. Sixteen bounded, resumable donor-id windows (stage + apply + COMMIT
-- each), parallel off, progress persisted in pipeline_state.
--
-- WHAT WAS FAILING (prod, read 2026-09-23 02:12 UTC, cc-146 read 3).
--
--   jobid 17 donor-party-rollup-refresh, `0 15 * * 2`, CALLs this procedure.
--   donor_party_rollup_watermark = 2026-07-28 05:54:28 — 54 days behind — so
--   every firing since has taken the FULL branch (lag > 14 d), and the full
--   branch was ONE `CREATE TEMP TABLE dpr_stage AS … GROUP BY fr.from_id, party`
--   over every donation, joined to ALL of financial_entities:
--
--     2026-07-28  352 s      complete   ← the last success
--     2026-08-04  21,628.6 s canceled at the 6 h ceiling, inside dpr_stage
--     2026-09-08  reaped     (the box went down — docs/audits/2026-09-22-…)
--     2026-09-15  reaped     (the box went down)
--     2026-09-22  11,278 s   partial: "stage build: canceling statement due to
--                            statement timeout" — the 3 h role ceiling
--                            (FIX-1185), units_run 0
--
--   The crash read has jobid 17 in flight on all three Tuesdays, with the
--   fork-failure curve starting ~10 min in. The 1,800 s cron_job_budget never
--   fired because the full branch had NO budget guard of its own and the two
--   `*/2` watchdogs that would have enforced the budget could not fork
--   (FIX-1194). The only bound left was the role's statement ceiling.
--
-- WHERE THE MEMORY WENT (local Docker prod-clone, EXPLAIN (ANALYZE, BUFFERS),
-- max_parallel_workers_per_gather = 0, work_mem = 256MB, hash_mem_multiplier 2;
-- FR 10,410,035 reltuples / 442,292 pages; 4,204,255 donation->official rows):
--
--   the whole-table stage SELECT (the shape this migration removes)
--     HashAggregate  1,859,976 groups  Batches 1  434,193 kB   (cap 512 MB)
--     Hash on financial_entities  3,680,773 rows  305,720 kB   (Seq Scan)
--     both live at once: ~740 MB in ONE backend. 516,850 buffers.
--
--   Prod is bigger on both axes: financial_entities 5,221,853 rows (1.42x) and
--   more donation groups, so on prod the HashAggregate reaches the 512 MB cap
--   and SPILLS while ~430 MB of fe hash sits beside it — on a box with
--   shared_buffers 256 MB. That is the memory the fork failures were missing.
--
--   one window, all three sources bounded (the shape below)
--     window 1:  268,936 FR rows  HashAgg 116,858 groups 30,737 kB  Batches 1
--                fe Bitmap Heap Scan 230,960 rows, hash 19,176 kB
--                ind Index Scan 2,751 rows, hash 231 kB
--                241,772 buffers
--     window 8:  263,833 FR rows  HashAgg 116,620 groups 30,737 kB  Batches 1
--                fe hash 19,147 kB, ind 220 kB     223,460 buffers
--     per-window FR rows: min 249,421 (w9)  max 271,071 (w6) — uuid windows
--     are uniform to +/-4 %.
--
--   one window, only FR bounded (the obvious edit, and WRONG):
--     the planner still Seq Scans ALL of financial_entities into the same
--     305,720 kB hash for every window, i.e. the peak this migration exists to
--     remove, sixteen times. So the window bound goes on `fe` and `ind` too.
--     That is semantics-preserving: both join on donor_id, which is in the
--     window by construction.
--
-- THE TRADE, stated so nobody is surprised by it. FR has no covering index for
-- this aggregate (it needs to_id and to_type), so each window is a bitmap heap
-- scan that touches ~34 % of FR's heap for 1/16 of the donations (clone: 152k of
-- 442k blocks). Sixteen windows therefore READ ~7x what one whole-table pass
-- reads (clone: ~3.7M buffers vs 516,850). The windowed rebuild buys a ~15x
-- smaller memory peak and a resumable unit with more I/O. On a box whose
-- failure is memory, that is the right trade; the I/O is paid in bounded units
-- with a COMMIT between each.
--
-- PROD PROJECTION (rule 132 — from each step's shape, not the clone's wall):
--   FR per window: ~389k donation rows (clone 4.20M x 1.48, the size ratio of
--   financial_relationships_treemap_global_rollup, 257 MB prod / 174 MB clone),
--   touching ~220k of 631,265 heap blocks (the clone's measured clustering
--   applied to prod's rows/pages); fe per window ~326k rows over ~119k of
--   245,569 blocks. So ~340k buffer reads (~2.6 GB) and a ~70 MB peak per
--   window; ~5.4M buffer reads for all sixteen. Wall on prod is not projected
--   from the clone (which lies both ways — reference_clone_understates…); the
--   first supervised CALL measures it, and the budget guard bounds it either way.
--
-- PROVEN ON THE CLONE (packages/data/src/__tests__/donor-party-full-rebuild.test.ts,
-- CIVITICS_DB_HEAVY_TESTS=1, 2026-09-23 ~02:28-02:33 UTC, local Docker):
--   (i)   watermark set 60 d back -> mode full, 16 windows, complete, caught_up,
--         cursor gone, watermark = the cycle target. 1,859,976 rows, 100.7 s.
--         stage 1.51-7.54 s, apply 0.80-11.07 s per window.
--   (iv)  MV after the windowed rebuild vs ONE whole-table aggregate:
--         1,859,976 rows / 693,098,760,800 cents / 4,204,255 tx — identical.
--   (ii)  max_units 3 -> partial, windows_done [1,2,3], watermark unmoved;
--         next CALL resumed 4..16 (58.3 s) and wrote the FIRST call's target.
--   (iii) a SHARE lock queued window 3's DELETE; pg_cancel_backend landed in
--         its EXCEPTION block -> partial, windows_done [1,2], window 3 still
--         held its 115,907 prior rows, a sentinel row survived in exactly the
--         windows not applied; the next CALL retried 3 and cleared all 16.
--
-- THE SHAPE.
--   (a) `SET max_parallel_workers_per_gather = 0` beside the existing
--       `SET work_mem = '256MB'` — plain SETs, so they survive the per-unit
--       COMMITs (FIX-1123's remedy). work_mem stays 256 MB: no window's
--       HashAggregate spilled at it (Batches 1, 30.7 MB), and with every source
--       bounded no plan can build a whole-table hash.
--   (b) Each window i not yet done: CREATE TEMP TABLE dpr_stage_w AS <the
--       windowed stage>, DELETE the window from donor_party_rollup_mv, INSERT
--       from the stage, DROP the stage, record i in the cursor — all in ONE
--       transaction, then COMMIT. Readers keep the prior rows of every window
--       not yet applied (complete-if-stale, never missing): a donor's rows all
--       live in one window, so a reader statement sees each donor wholly old or
--       wholly new. The two readers (get_pac_treemap_by_party/_by_sector) read
--       one statement snapshot and need nothing more.
--   (c) The cursor is pipeline_state.donor_party_full_rebuild =
--       { mode, started_at, target, windows_done: [i…] }, written in the same
--       transaction as window i's apply, so it can never claim a window whose
--       rows rolled back. `target` is fixed when the cycle starts, BEFORE window
--       1 reads anything. When windows_done reaches 16 the watermark is written
--       to `target` (the FIX-983-clamped value) and the cursor is DELETEd, in
--       one transaction. Sound because the crawl dirties on
--       `updated_at > watermark`: every FR write stamped after `target` —
--       whether or not a later window happened to see it — is re-processed by
--       the crawl, and donor_party_rollup_rebuild_donors() recomputes a donor's
--       whole qualifying set, so a donor rebuilt twice lands on the same value.
--       Every write stamped at or before `target` had committed before window 1
--       read (target <= the FIX-983 horizon, now() - 1 h). The watermark is
--       never moved BACKWARDS: if something advanced it past `target` mid-cycle,
--       the cycle deletes its cursor and leaves the watermark alone.
--   (d) The mode decision honours a live cursor: bootstrap/full resumes it, and
--       skips windows_done, even if the lag has since fallen under
--       full_rebuild_lag_days. A cursor older than 7 days is discarded and the
--       mode decided afresh (the entity_connections_rebuild_cursor rule,
--       FIX-1056) — resuming it would still be sound, but its target is then a
--       week behind and the crawl it hands over to would start that far back.
--   (e) The guard: before each window after the first, stop cleanly (`partial`,
--       resumable) if elapsed + the longest window THIS call has run would
--       reach unit_budget_seconds (default 1,500 s), or if max_units windows
--       have run. Projecting the next window is what keeps a CALL from
--       overshooting its budget by one window's wall — the unguarded version
--       could start a window at 1,499 s and be axed by the 1,800 s
--       cron_job_budget mid-window. The cron_job_budget row is untouched.
--   (f) EXCEPTION per window as before: query_canceled BY NAME first (FIX-1028)
--       — record, stop; OTHERS — record, continue with the next window (it is
--       not in windows_done, so the next CALL retries it).
--   (g) data_sync_log metadata gains windows_total, windows_done, windows_run,
--       stage_seconds[] and apply_seconds[] (aligned with windows_run),
--       resumed, cycle_started_at, cycle_target, cursor_discarded.
--
-- CORRECTED CLAIM. The FIX-1112 body said of the full branch: "Cost is
-- independent of the lag: ~350-420 s on prod regardless of how far behind the
-- watermark is … a cancelled full rebuild does not ratchet — the next firing
-- redoes the same ~350 s". Measured false at today's size: 21,628.6 s and
-- 11,278 s, both cancelled with nothing banked. The lag only picks the mode;
-- the cost scales with financial_relationships and financial_entities, and a
-- cancelled whole-table stage banked nothing, so every Tuesday redid all of it.
-- Now a capped or cancelled run banks every window it committed.
--
-- NOT CHANGED: the crawl branch, refresh_donor_party_rollup_slice(), the FIX-950
-- interlock, the cron_job_budget row, the schedule. No statement_timeout is set
-- anywhere (FIX-1128: in a routine it bounds nothing). The procedure carries NO
-- SET clause — it COMMITs, and a proconfig'd routine cannot.
-- =============================================================================

CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()
 LANGUAGE plpgsql
AS $procedure$
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
  -- FIX-1212 — the full-rebuild cursor, and the age past which it is discarded.
  c_cursor_key     text     := 'donor_party_full_rebuild';
  c_cycle_max_age  interval := interval '7 days';
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
  -- FIX-1212 — the windowed full rebuild.
  v_cursor         jsonb;
  v_discarded      jsonb   := NULL;
  v_resumed        boolean := false;
  v_cycle_started  timestamptz;
  v_cycle_target   timestamptz;
  v_done           int[]   := ARRAY[]::int[];
  v_win_run        int[]   := ARRAY[]::int[];
  v_stage_s        numeric[] := ARRAY[]::numeric[];
  v_apply_s        numeric[] := ARRAY[]::numeric[];
  v_max_unit       interval := interval '0';
  v_t0             timestamptz;
  v_t1             timestamptz;
  v_fr_w           text;
  v_et_w           text;
  v_fe_w           text;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-party-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-party-rollup] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-party-rollup] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Plain SET (not SET LOCAL) survives the per-unit COMMITs. NOTE (FIX-703,
  -- FIX-1185): the CALL's statement bound is the postgres role default (3 h)
  -- armed at CALL start — nothing in this body can change it. The budget guard
  -- below and the FIX-1063 watchdog are the real stops.
  SET work_mem = '256MB';
  -- FIX-1212 — FIX-1123's remedy: no parallel workers, so one window's memory is
  -- one backend's memory, not (1 + workers) copies of it.
  SET max_parallel_workers_per_gather = 0;

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

  -- FIX-983 — the head-lag horizon. Bounds the lag that picks the mode AND the
  -- watermark the full path writes below.
  v_target := LEAST(v_target, public.fr_watermark_horizon());

  v_lag  := CASE WHEN v_watermark IS NULL OR v_target IS NULL
                 THEN NULL ELSE v_target - v_watermark END;

  -- FIX-1212 — a full rebuild in progress wins the decision. A cursor younger
  -- than c_cycle_max_age is resumed whatever the lag is now; an older (or
  -- malformed) one is discarded and the mode decided afresh.
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;
  IF v_cursor IS NOT NULL THEN
    IF v_cursor->>'mode' IN ('bootstrap', 'full')
       AND (v_cursor->>'started_at')::timestamptz > clock_timestamp() - c_cycle_max_age
       AND v_cursor->>'target' IS NOT NULL THEN
      v_resumed       := true;
      v_mode          := v_cursor->>'mode';
      v_cycle_started := (v_cursor->>'started_at')::timestamptz;
      v_cycle_target  := (v_cursor->>'target')::timestamptz;
      SELECT COALESCE(array_agg(DISTINCT x::int ORDER BY x::int), ARRAY[]::int[])
        INTO v_done
        FROM jsonb_array_elements_text(COALESCE(v_cursor->'windows_done', '[]'::jsonb)) x;
    ELSE
      v_discarded := v_cursor;
    END IF;
  END IF;

  IF NOT v_resumed THEN
    v_mode := CASE
                WHEN v_watermark IS NULL     THEN 'bootstrap'
                WHEN v_lag > v_full_lag      THEN 'full'
                ELSE                              'crawl'
              END;
    IF v_mode IN ('bootstrap', 'full') THEN
      -- A new cycle. Its target is fixed HERE, before window 1 reads anything.
      v_cycle_started := v_started;
      v_cycle_target  := COALESCE(v_target, public.fr_watermark_horizon());   -- FIX-983
    END IF;
  END IF;

  IF v_discarded IS NOT NULL THEN
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
    RAISE WARNING '[donor-party-rollup] discarded a stale full-rebuild cursor (started %, % window(s) done)',
      v_discarded->>'started_at', jsonb_array_length(COALESCE(v_discarded->'windows_done', '[]'::jsonb));
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_refresh', 'running', v_started,
          jsonb_strip_nulls(jsonb_build_object(
                             'mode', v_mode, 'source', 'pg_cron',
                             'watermark_before', v_watermark,
                             'lag', v_lag::text,
                             'full_rebuild_lag', v_full_lag::text,
                             'max_units', v_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int,
                             'resumed', CASE WHEN v_mode IN ('bootstrap', 'full') THEN v_resumed END,
                             'cycle_started_at', v_cycle_started,
                             'cycle_target', v_cycle_target,
                             'windows_done_before', CASE WHEN v_mode IN ('bootstrap', 'full')
                                                         THEN to_jsonb(v_done) END,
                             'cursor_discarded', v_discarded)))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_mode IN ('bootstrap', 'full') THEN
    -- ═══ Windowed full rebuild (FIX-1212) ═══════════════════════════════════
    -- Sixteen donor-id windows. Each is ONE bounded unit: stage the window's
    -- aggregate, replace the window in donor_party_rollup_mv, record it in the
    -- cursor, COMMIT. The GROUP BY and both joins are bounded to the window, so
    -- the peak is ~1/16 of the whole-table stage's (clone: 30.7 MB + 19.2 MB
    -- against 434 MB + 306 MB). A cap or a cancel banks every window already
    -- committed; the next CALL or firing resumes at the first window not done.
    --
    -- Cost is NOT independent of the lag's consequences (FIX-1112's header said
    -- it was: "~350-420 s on prod regardless"). It scales with
    -- financial_relationships and financial_entities — 21,628.6 s on 2026-08-04
    -- and 11,278 s on 2026-09-22 as one statement. What the windows buy is that
    -- no single statement has to be the whole of it.
    FOR i IN 1..16 LOOP
      CONTINUE WHEN i = ANY (v_done);

      IF v_units >= v_max_units THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] UNIT CAP (%) reached before window %/16; stopping cleanly', v_max_units, i;
        EXIT;
      END IF;
      -- Project the next window from the longest one this call has run, so the
      -- CALL stops AT its budget rather than one window past it. The first
      -- window of a call always runs (v_max_unit is 0), which is what
      -- guarantees progress.
      IF (clock_timestamp() - v_started) + v_max_unit >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] BUDGET: % elapsed + % longest window >= %; stopping before window %/16',
          clock_timestamp() - v_started, v_max_unit, v_budget, i;
        EXIT;
      END IF;

      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      -- Literal bounds, so each window is planned against its real range.
      v_fr_w := format('fr.from_id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND fr.from_id < %L::uuid', v_hi) END;
      v_et_w := format('et.entity_id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND et.entity_id < %L::uuid', v_hi) END;
      v_fe_w := format('fe.id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND fe.id < %L::uuid', v_hi) END;

      BEGIN
        v_t0 := clock_timestamp();
        DROP TABLE IF EXISTS dpr_stage_w;
        EXECUTE format($stage$
          CREATE TEMP TABLE dpr_stage_w AS
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
              AND %1$s
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
              AND %2$s
            ORDER BY et.entity_id, et.tag
          )
          SELECT
            a.donor_id, a.party_key, fe.display_name AS donor_name,
            fe.entity_type, ind.industry_tag, ind.industry_label,
            a.total_cents, a.tx_count
          FROM agg a
          LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id AND %3$s
          LEFT JOIN ind                          ON ind.entity_id = a.donor_id
        $stage$, v_fr_w, v_et_w, v_fe_w);
        v_t1 := clock_timestamp();

        DELETE FROM public.donor_party_rollup_mv
         WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
        INSERT INTO public.donor_party_rollup_mv (
          donor_id, party_key, donor_name, entity_type, industry_tag,
          industry_label, total_cents, tx_count
        )
        SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
               industry_label, total_cents, tx_count
        FROM dpr_stage_w;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        DROP TABLE dpr_stage_w;

        -- The cursor rides the SAME transaction as the window's rows: it can
        -- never name a window whose apply rolled back.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
                  'mode',         v_mode,
                  'started_at',   v_cycle_started,
                  'target',       v_cycle_target,
                  'windows_done', to_jsonb(v_done || i)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = clock_timestamp();

        -- Locals last: a PL/pgSQL variable is NOT rolled back with the
        -- subtransaction, so nothing that can still raise may follow these.
        v_done     := v_done || i;
        v_win_run  := v_win_run || i;
        v_stage_s  := v_stage_s || round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 2);
        v_apply_s  := v_apply_s || round(EXTRACT(epoch FROM (clock_timestamp() - v_t1))::numeric, 2);
        v_max_unit := GREATEST(v_max_unit, clock_timestamp() - v_t0);
        v_rows     := v_rows + v_n;
        v_units    := v_units + 1;
        RAISE NOTICE '  [donor-party-rollup] window %/16 — stage % s, apply % s, % rows (% of 16 done)',
          i, v_stage_s[array_length(v_stage_s, 1)], v_apply_s[array_length(v_apply_s, 1)],
          v_n, array_length(v_done, 1);
      EXCEPTION
      -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
      WHEN query_canceled THEN
        v_canceled := format('window %s: %s', i, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] window %/16 CANCELED (rolled back whole — cursor unmoved): %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('window %s: %s', i, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level, outside the EXCEPTION subtransaction
      -- FIX-1028 — the box has just proven it cannot finish one window; the
      -- remaining ones would each re-arm the same axe.
      EXIT WHEN v_canceled IS NOT NULL;
    END LOOP;

    DROP TABLE IF EXISTS dpr_stage_w;
    COMMIT;

    -- All sixteen banked (across however many calls): the cycle recomputed
    -- EVERY donor, so the watermark jumps to the target fixed before window 1
    -- read. FR writes stamped after it are re-processed by the next crawl,
    -- never silently consumed. The cursor goes in the same transaction.
    IF (SELECT count(DISTINCT x) FROM unnest(v_done) x) = 16 THEN
      IF v_watermark IS NULL OR v_cycle_target > v_watermark THEN
        INSERT INTO public.pipeline_state (key, value)
        VALUES ('donor_party_rollup_watermark',
                jsonb_build_object('last_indexed_at', v_cycle_target::text))   -- FIX-983
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = clock_timestamp();
      ELSE
        -- Something advanced the watermark past this cycle's target mid-cycle.
        -- Writing the target would move it BACKWARDS (the FIX-983 rule).
        RAISE WARNING '  [donor-party-rollup] watermark % is already past cycle target %; left alone',
          v_watermark, v_cycle_target;
      END IF;
      DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
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
                          THEN left(format('canceled — %s; every COMMITTED %s kept its progress, the next firing resumes from it',
                                 v_canceled,
                                 CASE WHEN v_mode IN ('bootstrap', 'full') THEN 'window' ELSE 'slice' END), 1000)
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
                      -- FIX-1212 — the windowed full rebuild's own clock (the
                      -- phase_seconds shape, rule 93). Absent on a crawl run.
                      || CASE WHEN v_mode IN ('bootstrap', 'full') THEN jsonb_build_object(
                           'windows_total', 16,
                           'windows_done',  to_jsonb(v_done),
                           'windows_run',   to_jsonb(v_win_run),
                           'stage_seconds', to_jsonb(v_stage_s),
                           'apply_seconds', to_jsonb(v_apply_s))
                         ELSE '{}'::jsonb END
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
$procedure$
;

-- Restated (rule 34). CREATE OR REPLACE keeps the ACL, but the grant is part of
-- the contract and is written down where the body is.
REVOKE ALL ON PROCEDURE public.refresh_donor_party_rollup_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_donor_party_rollup_incremental() TO service_role;
