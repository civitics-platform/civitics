-- =============================================================================
-- FIX-1216 — the donor-party full-rebuild cursor lives 22 days, not 7.
--
-- THE TREADMILL. refresh_donor_party_rollup_incremental() (FIX-1212,
-- 20260920100000) resumes a `full`/`bootstrap` cursor only while
--   (cursor->>'started_at')::timestamptz > clock_timestamp() - c_cycle_max_age
-- and started_at is the FIRST firing's CALL start — a resume does not refresh
-- it. jobid 17 `donor-party-rollup-refresh` fires `0 15 * * 2` (weekly), and at
-- prod's window wall (cc-147: ~125-135 s per window) the 1,500 s unit budget
-- runs ~10 of 16 windows per firing. So every cycle needs a second firing, and
-- the second firing is exactly 7 d + cron jitter (ms) after started_at: past a
-- 7-day bound, every time. The cursor was discarded, the cycle restarted at
-- window 1, and weekly firings alone never reached 16/16.
--
-- THE BOUND (rule 18 — a resume bound exceeds the schedule interval plus
-- slack): 3 firings x 7 d + 1 d = 22 d. A cycle started at firing 1 is resumed
-- at +7 d, +14 d and +21 d, so it survives two capped or cancelled firings
-- after the one that started it (a Tuesday the box is down, a budget-capped
-- window). Discarded at the first firing past 22 d, i.e. +28 d.
--
-- FIX-983, KEPT. The cycle target is still fixed once, before window 1 reads
-- anything, and is still what the watermark jumps to at 16/16. Every FR write
-- stamped after it is re-processed by a later firing (the crawl dirties on
-- `updated_at > watermark`); a longer-lived cycle only widens that band.
-- NOTE — the band is re-processed by the CRAWL only while it is at most
-- `full_rebuild_lag_days` (14, pipeline_state.donor_party_crawl): the next
-- firing's mode decision is `lag > 14 d -> full`, and a cycle that took two
-- firings completes ~14 d behind (cc-167 report).
--
-- NOT the `last_window_at` variant FIX-1216 also offered: that changes the
-- cursor's shape and every reader of it. This is one constant.
--
-- NOT CHANGED: anything else in the body (pg_get_functiondef diff against
-- prod = this constant + the three comment lines above it). The procedure still
-- carries NO SET clause (proconfig NULL on prod, read 2026-09-27 06:41 UTC) —
-- it COMMITs, and a proconfig'd routine cannot. The six `interval '7 days'`
-- cursor bounds in the entity_connections procedures are a different cadence
-- class (`*/15` crawls) and are out of scope.
--
-- Tue 2026-09-29 15:00 UTC is unaffected: prod holds no donor_party_full_rebuild
-- cursor (cc-154 reached caught_up 2026-09-25 00:54), the watermark is
-- 2026-09-21 00:18, so that firing takes the CRAWL branch (FIX-969's receipt).
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
  -- FIX-1216 — 3 weekly firings + 1 d of slack. started_at is the FIRST
  -- firing's, so at 7 d the second firing always found the cursor a few ms
  -- past the bound and discarded it; weekly firings never reached 16/16.
  c_cycle_max_age  interval := interval '22 days';
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
