-- ============================================================================
-- FIX-1140 — the FIX-983 caught-up branch must log 'complete', not 'skipped'
--
-- SELF-INFLICTED, CAUGHT BEFORE IT FIRED, one hop after the FIX-983 landing.
--
-- FIX-983's invariant (c) says a routine whose clamped target has not cleared
-- its watermark must no-op cleanly rather than write the watermark backwards.
-- In the two rollup PROCEDURES that keep a data_sync_log row, that was
-- implemented as an early RETURN which logged `status = 'skipped'`.
--
-- `public.check_rollup_freshness()` — and `canary-check.ts` behind it —
-- measure staleness as "hours since the last data_sync_log row with
-- status = 'complete'" for the pipeline. A 'skipped' row does not reset that
-- clock. So a stretch of legitimately caught-up days would have driven
-- `donor_rollup_refresh` past its freshness ceiling and paged, with the rollup
-- perfectly healthy. That is exactly the FIX-968 shape the playbook warns
-- about: a frozen signal making a healthy system look broken.
--
-- IT WAS REACHABLE ON THE NEXT FIRING, not theoretical. Prod, 2026-09-03 01:45
-- UTC: pipeline_state.donor_rollup_watermark.last_indexed_at =
-- 2026-09-01 07:28:45.938461 and MAX(fr.updated_at) over
-- (donation, ie_support, ie_oppose) = 2026-09-01 07:28:45.938461 — EQUAL. FR has
-- taken no write in over 24 h, so `LEAST(max, horizon) <= watermark` holds and
-- jobid 24 would have taken the skip branch at 09:00 UTC that same morning, and
-- again at 12:00, and every firing until FR moves.
--
-- THE FIX IS TO DELETE THE BRANCH, not to relabel it. The early RETURN was only
-- ever protecting against a BACKWARDS watermark write, and a floor does that in
-- one line with no new control flow and no new status vocabulary:
--
--     v_new_max := GREATEST(v_new_max, v_watermark);
--
-- With the target floored at the watermark, the dirty predicate
-- `> v_watermark AND <= v_new_max` is empty BY CONSTRUCTION, the loop is a
-- no-op, and the terminal write rewrites the SAME watermark. The run reports
-- 'complete' because it IS complete: everything readable has been read.
-- GREATEST ignores NULLs, so the bootstrap path (v_watermark IS NULL) is
-- untouched.
--
-- This is the same construction FIX-983 already used for
-- donor_rollup_rebuild_bulk and FIX-987 used for refresh_agency_staffing_rollup,
-- both of which log 'complete' on an empty dirty set and were never affected.
--
-- NOT CHANGED: refresh_donor_party_rollup_mv() and
-- refresh_official_donor_rollup_mv() keep their RAISE NOTICE + RETURN. They
-- write NO data_sync_log row at all, so they cannot move a freshness clock in
-- either direction, and the early return is the clearer statement of intent for
-- a manual/seed path.
--
-- Fixes: FIX-1140
-- ============================================================================

BEGIN;


-- ── 1/2 · refresh_official_donor_rollup_incremental() — jobid 24, the live one ─

CREATE OR REPLACE PROCEDURE public.refresh_official_donor_rollup_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;

  -- FIX-1002 — wall-clock budget for ONE run. See the header for the sizing:
  -- 3h between firings, pg_cron queues rather than skips, one healthy full
  -- sweep measured 2h00m43s. Overridable via civitics.donor_rollup_budget_seconds.
  c_budget     interval := interval '2 hours';

  -- What one chunk SHOULD cost. The guard can only act between chunks, so this
  -- is also the granularity of every control decision in the loop and the blast
  -- radius of a mid-chunk cancel by the outer 6h timeout. 300 s over a 2 h
  -- budget gives the guard ~24 evaluation points per run; FIX-972's regime gave
  -- it 3. Overridable via civitics.donor_rollup_chunk_target_seconds.
  c_chunk_secs int := 300;

  -- Hard caps on one chunk, so a mis-calibrated rows-per-second cannot build a
  -- monster. c_weight_max is ~450 s at the healthy measured rate of 448 rows/s.
  c_weight_max     bigint := 200000;   -- FR rows
  c_recipients_max int    := 500;      -- recipients (also the meaning of the
                                       -- pre-existing donor_rollup_chunk_size GUC)

  -- Cold-start rows-per-second, used only when pipeline_state carries no
  -- calibration. Deliberately pessimistic: prod's WORST measured incremental
  -- rate was 28.7 rows/s (08-07, un-vacuumed arms) against 448 rows/s healthy.
  -- Starting low costs one short first chunk; starting high costs an outage.
  c_rps_seed   double precision := 30.0;

  -- Weight assumed for a recipient with no official_donor_totals row yet.
  -- p90 of the live distribution (1,389), rounded up — being wrong-small here
  -- is what builds an oversized chunk, so this errs pessimistic.
  c_weight_default bigint := 1500;

  -- Latest UTC hour at which a firing may START. The 12:00 backstop exists for
  -- the case where 09:00 was starved at startup; it must not turn into a second
  -- full window chained onto an overrunning first one (measured 08-06/07/08).
  -- Overridable two ways: civitics.donor_rollup_ignore_start_window for
  -- break-glass, and civitics.donor_rollup_latest_start_hour to move the cutoff
  -- (0 refuses always, 24 never refuses). The second exists so the refusal is
  -- TESTABLE without waiting for a wall clock — a guard that can only be
  -- observed by getting unlucky is the same class of defect as the one this
  -- migration is fixing.
  c_latest_hour int := 13;

  -- FIX-1018 — fraction of the budget the PRE-LOOP dirty-set build may consume
  -- before the run refuses to enter the loop at all.
  --
  -- Sizing, one line: the healthy build is 52.8 s against a 7,200 s budget
  -- (0.7%) and should be well under that once the index below is in place, so
  -- anything past 50% is two orders of magnitude off-nominal and means the box
  -- is in the contention regime this run must not add to; below 50% there is
  -- still a full c_chunk_secs target of window left with headroom, so entering
  -- the loop is still worth it. This guard exists for the ~176x case, not the
  -- healthy one. Overridable via
  -- civitics.donor_rollup_dirty_set_budget_fraction (which is also how the
  -- refusal is exercised in test — playbook C3).
  c_dirty_frac double precision := 0.5;

  v_state      jsonb;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_new_max    timestamptz;
  v_horizon    timestamptz;   -- FIX-983
  v_cursor     uuid;
  v_resumed    boolean := false;
  v_dirty      uuid[];
  v_weights    bigint[];
  v_chunk      uuid[];
  v_n_recips   int;
  v_i          int := 1;
  v_j          int;
  v_chunk_end  int;
  v_chunk_w    bigint;
  v_target_w   bigint;
  v_fit_w      bigint;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  v_prior_fail int := 0;
  v_budget_cfg int;
  v_chunk_cfg  int;
  v_secs_cfg   int;
  v_hour_cfg   int;
  v_frac_cfg   double precision;   -- FIX-1018
  v_ignore_win boolean;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_dirty_secs double precision;   -- FIX-1018
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_stop_why   text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- Routed into the EXISTING v_budget_hit 'partial' branch below rather than a
  -- new terminal path: a cancelled sweep and a budget-stopped sweep are the same
  -- thing to a reader (resumable, cursor intact), so they get the same shape.
  v_canceled   text := NULL;
  v_blocked    uuid := NULL;
  v_elapsed    double precision;
  v_remaining  double precision;
  v_rps_seed   double precision;
  v_rps_run    double precision := NULL;
  v_rps        double precision;
  v_yield      double precision;
  v_budget_s   double precision;
BEGIN
  -- ── Start-window refusal (FIX-1002) ───────────────────────────────────────
  -- BEFORE the advisory lock, so a firing pg_cron queued behind an overrunning
  -- run exits immediately instead of waiting on a lock it would then hold for
  -- another full budget. This is the job stopping ITSELF; nothing here depends
  -- on an operator noticing (FIX-965's lesson — a cancelled long CALL wedged
  -- prod for ~7 h on 08-05, so cancellation is not a control path).
  v_ignore_win := COALESCE(
    NULLIF(current_setting('civitics.donor_rollup_ignore_start_window', true), '')::boolean,
    false);
  v_hour_cfg := NULLIF(current_setting('civitics.donor_rollup_latest_start_hour', true), '')::int;
  IF v_hour_cfg IS NOT NULL THEN
    c_latest_hour := GREATEST(0, LEAST(v_hour_cfg, 24));
  END IF;
  IF NOT v_ignore_win
     AND EXTRACT(hour FROM (clock_timestamp() AT TIME ZONE 'UTC')) >= c_latest_hour THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] start window closed (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;

  -- Session advisory lock (survives the COMMITs below). Stampede protection.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Bounded per-chunk memory. Plain SET (not SET LOCAL) survives the per-chunk
  -- COMMITs. NOTE (FIX-703/FIX-944): the CALL's statement_timeout is the
  -- postgres role default (6h) armed at CALL start — nothing in this body can
  -- change it, which is exactly why the c_budget loop guard below exists.
  SET work_mem = '128MB';

  SELECT value INTO v_state
  FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

  v_watermark := (v_state->>'last_indexed_at')::timestamptz;
  v_cursor    := NULLIF(v_state->>'sweep_cursor', '')::uuid;

  -- FIX-1002 — cross-run calibration. The previous run's measured (pessimistic)
  -- rows-per-second sizes THIS run's first chunk, which is the one FIX-972's
  -- guard could never protect. Persisted alongside the cursor and carried
  -- across sweep completion.
  v_rps_seed := COALESCE(
    NULLIF(v_state->>'rows_per_second', '')::double precision, c_rps_seed);
  IF v_rps_seed <= 0 THEN v_rps_seed := c_rps_seed; END IF;

  -- Optional operator overrides, all SESSION GUCs rather than shared state
  -- (FIX-944 decision 6): a pipeline_state override would have to be restored
  -- afterwards, and a run that died before restoring would silently re-widen
  -- every subsequent pg_cron run. A GUC dies with the connection.
  --     SET civitics.donor_rollup_budget_seconds              = '72000';
  --     SET civitics.donor_rollup_chunk_target_seconds        = '600';
  --     SET civitics.donor_rollup_chunk_size                  = '250';
  --     SET civitics.donor_rollup_ignore_start_window         = 'on';
  --     SET civitics.donor_rollup_dirty_set_budget_fraction   = '0.5';
  v_budget_cfg := NULLIF(current_setting('civitics.donor_rollup_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_budget_cfg);
  END IF;

  v_secs_cfg := NULLIF(current_setting('civitics.donor_rollup_chunk_target_seconds', true), '')::int;
  IF COALESCE(v_secs_cfg, 0) > 0 THEN
    c_chunk_secs := LEAST(v_secs_cfg, 3600);
  END IF;

  -- Pre-existing GUC, repurposed: it now caps RECIPIENTS per chunk rather than
  -- fixing them. Clamped to [1, 5000] — 0 or negative would make the inner
  -- accumulator never advance v_i, i.e. an infinite loop holding an advisory
  -- lock (the FIX-972 hazard, preserved).
  v_chunk_cfg := NULLIF(current_setting('civitics.donor_rollup_chunk_size', true), '')::int;
  IF COALESCE(v_chunk_cfg, 0) > 0 THEN
    c_recipients_max := LEAST(v_chunk_cfg, 5000);
  END IF;

  -- FIX-1018 — clamped to (0, 1]. A value of 0 or below would make the pre-loop
  -- refusal fire on every run including healthy ones, permanently parking the
  -- sweep; above 1 it could never fire at all.
  v_frac_cfg := NULLIF(current_setting('civitics.donor_rollup_dirty_set_budget_fraction', true), '')::double precision;
  IF COALESCE(v_frac_cfg, 0) > 0 THEN
    c_dirty_frac := LEAST(v_frac_cfg, 1.0);
  END IF;

  v_budget_s   := EXTRACT(epoch FROM c_budget);
  v_prior_fail := COALESCE((v_state->>'sweep_failures')::int, 0);

  IF v_cursor IS NOT NULL AND (v_state ? 'sweep_target') THEN
    -- RESUMING an interrupted sweep. Reuse the target captured at sweep start
    -- so mid-sweep FR writes stay for the NEXT sweep (FIX-704 invariant).
    v_resumed := true;
    v_new_max := (v_state->>'sweep_target')::timestamptz;
  ELSE
    -- Capture the new watermark BEFORE building the dirty set so FR writes that
    -- land mid-refresh are re-processed by the next run, never silently consumed.
    v_cursor     := NULL;
    v_prior_fail := 0;
    SELECT MAX(fr.updated_at) INTO v_new_max
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    -- FIX-983 — the head-lag horizon, applied to the sweep target the moment it
    -- is captured, so every downstream use (the dirty-set bound below, the
    -- per-chunk sweep_target, and the terminal watermark) inherits it.
    v_horizon := public.fr_watermark_horizon();
    v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);

    -- FIX-983 invariant (c), FIX-1140 shape. The clamp can put the target at or
    -- below the watermark (the first minutes after a write burst, or after the
    -- lag GUC is raised). Floor it rather than returning early: the dirty
    -- predicate below is then empty BY CONSTRUCTION, the loop is a no-op, and
    -- the terminal write rewrites the SAME watermark — so the run still reports
    -- 'complete', which is what check_rollup_freshness() and canary-check.ts
    -- measure staleness from. An early return logging 'skipped' would have left
    -- that clock frozen through a legitimately caught-up stretch and paged on a
    -- healthy rollup (FIX-968's shape). GREATEST ignores NULLs, so bootstrap
    -- (v_watermark IS NULL) is unaffected.
    v_new_max := GREATEST(v_new_max, v_watermark);
  END IF;

  v_horizon := COALESCE(v_horizon, public.fr_watermark_horizon());

  -- ── Dirty set, now carrying a per-recipient cost weight (FIX-1002) ────────
  -- ORDER BY is load-bearing: the cursor resumes on uuid order, so the dirty
  -- set must be built the same way on every resuming run, and v_dirty/v_weights
  -- must be built in ONE aggregate so the two arrays stay index-aligned.
  --
  -- The weight is official_donor_totals.donor_count — COUNT(*) of that
  -- official's donation FR rows, already maintained by the odt arm of
  -- donor_rollup_rebuild_recipients(). 6,782 rows / 117 pages, so reading it is
  -- free next to the scan it is sizing. Two known imprecisions, both tolerable
  -- because the loop RE-MEASURES rows-per-second empirically after every chunk:
  --   * it counts only 'donation', not ie_support/ie_oppose, so an IE-heavy
  --     recipient is under-weighted;
  --   * it is itself one run stale for recipients in the current dirty set.
  --
  -- FIX-1018 — `to_type = 'official'` is REQUIRED, not an optimisation. Without
  -- it 57% of the enumerated recipients are financial_entities that the arms
  -- cannot roll up, 54% of the dirty weight is c_weight_default fabricated for
  -- them, and the uuid-ordered cursor parks on whichever PAC sorts first. It is
  -- also what lets the planner use
  -- financial_relationships_donor_rollup_dirty_idx above; the two changes are
  -- one fix, not alternatives (see the header's measurement B).
  IF v_watermark IS NULL THEN
    -- Bootstrap: every recipient, same chunked loop.
    SELECT array_agg(d.to_id ORDER BY d.to_id),
           array_agg(COALESCE(odt.donor_count, c_weight_default) ORDER BY d.to_id)
      INTO v_dirty, v_weights
    FROM (
      SELECT DISTINCT fr.to_id
      FROM public.financial_relationships fr
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_type = 'official'                                   -- FIX-1018
        AND (v_cursor IS NULL OR fr.to_id > v_cursor)
    ) d
    LEFT JOIN public.official_donor_totals odt ON odt.official_id = d.to_id;
  ELSE
    SELECT array_agg(d.to_id ORDER BY d.to_id),
           array_agg(COALESCE(odt.donor_count, c_weight_default) ORDER BY d.to_id)
      INTO v_dirty, v_weights
    FROM (
      SELECT DISTINCT fr.to_id
      FROM public.financial_relationships fr
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_type = 'official'                                   -- FIX-1018
        AND fr.updated_at >  v_watermark
        AND fr.updated_at <= v_new_max                                -- FIX-983
        AND (v_cursor IS NULL OR fr.to_id > v_cursor)
    ) d
    LEFT JOIN public.official_donor_totals odt ON odt.official_id = d.to_id;
  END IF;

  -- FIX-1018 — stamp the pre-loop cost. This is the ONLY place it can be
  -- measured: v_started is procedure entry and the next thing that happens is
  -- the loop. Recorded on EVERY run, success or refusal, because its absence
  -- from the logs is what made FIX-1018 take a day to find.
  v_dirty_secs := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  v_n_recips := COALESCE(array_length(v_dirty, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_refresh', 'running', now(),
          jsonb_build_object(
            'mode', CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END,
            'dirty_recipients', v_n_recips,
            'dirty_weight', COALESCE((SELECT SUM(w) FROM unnest(v_weights) w), 0),
            -- 3 dp, not 1: a healthy post-index build is sub-second, and a
            -- value that rounds to "0.0" reads as "not measured" — which is
            -- the exact failure mode this key exists to end.
            'dirty_set_build_seconds', round(v_dirty_secs::numeric, 3),   -- FIX-1018
            'resumed', v_resumed,
            'resume_cursor', v_cursor,
            'sweep_failures_before', v_prior_fail,
            'budget_seconds', v_budget_s,
            'chunk_target_seconds', c_chunk_secs,
            'rows_per_second_seed', round(v_rps_seed::numeric, 2),
            'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  -- ── The PRE-LOOP budget refusal (FIX-1018) ────────────────────────────────
  -- FIX-1002's guard is armed from chunk 1, which is correct and still leaves
  -- everything before iteration 1 unguarded. On 2026-08-10 that unguarded
  -- region was 9,292 of 9,367 seconds. Refuse here rather than enter a loop
  -- that has no window left, so the run stops evicting a 256 MB buffer pool on
  -- behalf of work it cannot finish.
  --
  -- Skipped when v_n_recips = 0: an empty dirty set means there is nothing to
  -- refuse and the run should COMPLETE and advance the watermark, however long
  -- the build took.
  IF v_n_recips > 0 AND v_dirty_secs > c_dirty_frac * v_budget_s THEN
    v_budget_hit := true;
    v_stop_why   := 'dirty_set_build_exhausted_budget';
    RAISE NOTICE '[donor-rollup] dirty-set build took %s of a %s budget (limit fraction %) — refusing to enter the loop',
      round(v_dirty_secs)::int, round(v_budget_s)::int, c_dirty_frac;
  END IF;

  WHILE NOT v_budget_hit AND v_i <= v_n_recips LOOP
    v_elapsed   := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    v_remaining := v_budget_s - v_elapsed;
    v_rps       := COALESCE(v_rps_run, v_rps_seed);

    -- Out of window entirely. Distinct from the per-chunk refusal below so the
    -- log says which one stopped the run.
    IF v_chunk_no > 0 AND v_remaining <= 0 THEN
      v_budget_hit := true;
      v_stop_why   := 'budget_exhausted';
      RAISE NOTICE '[donor-rollup] budget exhausted after chunk % (elapsed %s)',
        v_chunk_no, round(v_elapsed)::int;
      EXIT;
    END IF;

    -- ── Size this chunk (FIX-1002) ──────────────────────────────────────────
    -- Target the configured per-chunk duration at the measured rate, then
    -- shrink to fit what is actually left of the budget (with 25% headroom).
    -- Shrinking BEFORE the guard has to refuse is what turns the budget from a
    -- cliff into a taper: a run near its limit does small chunks rather than
    -- gambling one big one.
    v_target_w := GREATEST(1, LEAST(c_weight_max, (c_chunk_secs * v_rps)::bigint));
    v_fit_w    := GREATEST(1, (GREATEST(v_remaining, 0) * v_rps / 1.25)::bigint);
    v_target_w := LEAST(v_target_w, v_fit_w);

    -- Accumulate recipients until the weight target or the recipient cap is
    -- hit. A chunk is ALWAYS at least one recipient, so a single whale heavier
    -- than the whole target forms its own chunk and the loop still advances.
    v_chunk_end := v_i;
    v_chunk_w   := COALESCE(v_weights[v_i], c_weight_default);
    v_j         := v_i + 1;
    WHILE v_j <= v_n_recips
          AND v_chunk_end - v_i + 1 < c_recipients_max
          AND v_chunk_w + COALESCE(v_weights[v_j], c_weight_default) <= v_target_w
    LOOP
      v_chunk_w   := v_chunk_w + COALESCE(v_weights[v_j], c_weight_default);
      v_chunk_end := v_j;
      v_j         := v_j + 1;
    END LOOP;

    -- ── The guard, ARMED FROM CHUNK 1 (FIX-1002) ────────────────────────────
    -- FIX-972's version reserved 1.25 × the slowest chunk SEEN, which is a
    -- high-water mark of the past and says nothing about the chunk in hand.
    -- This projects the cost of THIS chunk from its own weight, so a whale is
    -- refused on its own merits.
    --
    -- The `v_chunk_no > 0` exception is deliberate and is about LIVENESS, not
    -- convenience: a lone recipient whose projected cost exceeds an entire
    -- budget would otherwise be refused by every future run forever and park
    -- the sweep permanently. The first chunk of a run always attempts, with the
    -- full window ahead of it and the 6h role timeout as the backstop. It is
    -- bounded by v_target_w (one recipient), not by a blind 50.
    IF v_chunk_no > 0
       AND (v_chunk_w / v_rps) * 1.25 > v_remaining THEN
      v_budget_hit := true;
      v_stop_why   := 'chunk_would_not_fit';
      IF v_chunk_end = v_i THEN
        v_blocked := v_dirty[v_i];
      END IF;
      RAISE NOTICE '[donor-rollup] budget guard — refusing chunk % (weight %, projected %s, remaining %s)',
        v_chunk_no + 1, v_chunk_w, round((v_chunk_w / v_rps) * 1.25)::int, round(v_remaining)::int;
      EXIT;
    END IF;

    v_chunk     := v_dirty[v_i : v_chunk_end];
    v_chunk_no  := v_chunk_no + 1;
    v_chunk_beg := clock_timestamp();
    BEGIN
      v_n    := public.donor_rollup_rebuild_recipients(v_chunk);
      v_rows := v_rows + v_n;
      IF v_chunk_no % 10 = 0 THEN
        RAISE NOTICE '[donor-rollup] chunk % — % recipients done, % rows so far',
          v_chunk_no, v_chunk_end, v_rows;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name. EXCEPTION WHEN OTHERS does not match query_canceled,
    -- so the 6h statement_timeout used to blow through this handler and out of
    -- the procedure, leaving the data_sync_log row stranded 'running' until the
    -- reaper found it up to 60 minutes later. This procedure is one of the two
    -- that actually get cancelled in practice.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, v_chunk_end, SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its recipients keep their PRIOR
      -- rollup rows (complete-if-stale). The cursor still advances so the sweep
      -- terminates, but sweep_failures blocks the watermark advance at the end,
      -- so the whole set is retried by the next sweep.
      v_failures := v_failures || format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, v_chunk_end, SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;

    -- FIX-944 — persist the cursor in the SAME transaction as the chunk's work.
    -- A run cancelled by the 6h statement_timeout keeps every committed chunk.
    -- FIX-972 — clock_timestamp(), NOT NOW(): NOW() is transaction_timestamp()
    -- and this transaction began right after the previous chunk's COMMIT, so it
    -- would stamp the moment this chunk STARTED.
    -- FIX-1002 — the calibration rides along, so the next run's first chunk is
    -- sized by the last run's measured rate.
    -- FIX-1028 — do NOT advance the cursor past a CANCELLED chunk. A failed
    -- chunk may advance (sweep_failures blocks the watermark, so the whole set
    -- is retried), but a cancel routes to the 'partial' branch which does NOT
    -- set sweep_failures — so an advanced cursor there would silently skip the
    -- recipients whose work was just rolled back. Leaving it un-advanced makes
    -- the next run redo exactly this chunk.
    IF v_canceled IS NULL THEN
    v_cursor := v_dirty[v_chunk_end];
    UPDATE public.pipeline_state
       SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object(
                     'sweep_cursor',    v_cursor::text,
                     'sweep_target',    v_new_max::text,
                     'sweep_failures',  v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                     'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)),
           updated_at = clock_timestamp()
     WHERE key = 'donor_rollup_watermark';
    IF NOT FOUND THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark', jsonb_build_object(
                'sweep_cursor',    v_cursor::text,
                'sweep_target',    v_new_max::text,
                'sweep_failures',  v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = public.pipeline_state.value || EXCLUDED.value, updated_at = clock_timestamp();
    END IF;
    END IF;  -- FIX-1028 cursor guard

    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Bounds txn size + advances xmin between chunks.
    COMMIT;

    -- FIX-1028 — end the sweep on a cancel, reusing the budget-stop path so the
    -- run closes its own row as 'partial' and stays resumable at v_i.
    IF v_canceled IS NOT NULL THEN
      v_budget_hit := true;
      v_stop_why   := 'canceled';
      EXIT;
    END IF;

    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;

    -- ── Re-measure the rate, pessimistically (FIX-1002) ─────────────────────
    -- Rolling MINIMUM within the run, so one expensive chunk immediately makes
    -- every subsequent chunk smaller. It resets each run rather than ratcheting
    -- down forever: a bad day pins the seed for exactly one following run, and
    -- a good run restores it.
    IF v_chunk_secs > 0 THEN
      v_rps_run := LEAST(COALESCE(v_rps_run, 1e18), v_chunk_w / v_chunk_secs);
    END IF;

    -- ── Pace (FIX-1002) ─────────────────────────────────────────────────────
    -- The saturation mechanism is shared-buffer eviction on a 256 MB pool, not
    -- disk throughput (Disk IO 3–5% while the site was down). Yielding gives
    -- the request path an unobstructed window to re-warm its own pages. Costs
    -- ~5% of the window at the default 300 s chunk. That trade is the point:
    -- a rollup that takes longer but leaves the site up is strictly better than
    -- one that converges fast and makes the platform unreachable. Do not
    -- "optimise" this away.
    v_yield := LEAST(v_chunk_secs * 0.10, 15.0);
    IF v_yield > 0 THEN PERFORM pg_sleep(v_yield); END IF;

    v_i := v_chunk_end + 1;
  END LOOP;

  IF v_budget_hit THEN
    -- Partial, resumable. Distinct from both 'complete' and 'failed'.
    UPDATE public.data_sync_log
    SET status        = 'partial',
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        -- FIX-1018 — say WHICH budget ran out. The pre-loop refusal and the
        -- in-loop exhaustion are different failures with different remedies,
        -- and a message that calls both "budget exhausted" hides the one this
        -- FIX exists to make visible.
        error_message = CASE
          -- FIX-1028 — name the cancel; it is not a budget stop and the remedy
          -- differs (the box could not finish one chunk, not "ran out of time").
          WHEN v_stop_why = 'canceled' THEN
            format('canceled — %s; resumable at recipient %s of %s (cursor %s)',
                   v_canceled, v_i, v_n_recips, v_cursor)
          WHEN v_stop_why = 'dirty_set_build_exhausted_budget' THEN
            format('dirty-set build consumed %ss of a %ss budget (limit %s%%) — loop not entered; resumable at recipient 1 of %s',
                   round(v_dirty_secs)::int, round(v_budget_s)::int,
                   round((c_dirty_frac * 100)::numeric, 1), v_n_recips)
          ELSE
            format('budget exhausted — resumable at recipient %s of %s (cursor %s)',
                   v_i, v_n_recips, v_cursor)
          END,
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'recipients_done', v_i - 1,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'resumable', true,
                          'resume_at_chunk', v_chunk_no + 1,
                          -- Which of the stop paths ended the run. Without
                          -- this, 'partial' cannot be told apart from 'partial'
                          -- and the guard is unfalsifiable from the log alone.
                          'stop_reason', v_stop_why,
                          'canceled', v_canceled IS NOT NULL,
                          'cancel_detail', v_canceled,
                          'remaining_recipients', GREATEST(v_n_recips - v_i + 1, 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3),
                          -- FIX-1002 — "no silent caps": a single recipient the
                          -- guard refuses because it cannot fit a whole budget
                          -- is a stuck sweep, not a paced one. Name it.
                          'blocked_recipient', v_blocked,
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] PARTIAL (%) — % of % recipients this run, resumable at chunk %',
      v_stop_why, v_i - 1, v_n_recips, v_chunk_no + 1;
  ELSE
    -- Sweep finished. Advance the durable watermark only if NO chunk failed
    -- anywhere in the sweep (including earlier, interrupted runs of it), then
    -- clear the cursor so the next run starts a fresh sweep.
    IF v_prior_fail + COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1002 — this branch REPLACES the whole jsonb (that is how the sweep
      -- keys get cleared), so the calibration must be re-stated here or it is
      -- silently dropped every time a sweep completes. Same class of bug as the
      -- entity_comments rating trigger clobbering denormalized keys.
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark',
              jsonb_build_object(
                'last_indexed_at', COALESCE(v_new_max, v_horizon)::text,
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object(
                      'last_indexed_at', COALESCE(v_new_max, v_horizon)::text,
                      'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)),
            updated_at = NOW();
    ELSE
      UPDATE public.pipeline_state
         SET value = (value - 'sweep_cursor' - 'sweep_target' - 'sweep_failures'),
             updated_at = NOW()
       WHERE key = 'donor_rollup_watermark';
    END IF;

    UPDATE public.data_sync_log
    SET status        = CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0
                             THEN 'failed' ELSE 'complete' END,
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        error_message = CASE WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                             ELSE NULL END,
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'recipients_done', v_n_recips,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'sweep_failures_total', v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3),
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] % — % recipients in % chunks, % rows (% failures this run)',
      CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'PARTIAL' ELSE 'complete' END,
      v_n_recips, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);
  END IF;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_official_donor_rollup_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_official_donor_rollup_incremental() TO service_role;


-- ── 2/2 · refresh_financial_entity_totals_incremental() — PAUSED (jobid 13) ───
-- Same edit. It is parked `active = false` and superseded by the fe-crawl, so
-- it could not have paged anything today; corrected anyway so a future un-pause
-- does not resurrect the frozen-clock branch.

CREATE OR REPLACE PROCEDURE public.refresh_financial_entity_totals_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key  bigint := hashtext('financial_entity_totals_refresh')::bigint;
  c_chunk     int    := 500;
  c_bounds    uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id    uuid;
  v_watermark timestamptz;
  v_new_max   timestamptz;
  v_horizon   timestamptz;   -- FIX-983
  v_dirty_from uuid[];
  v_dirty_to   uuid[];
  v_chunk     uuid[];
  v_n_from    int;
  v_n_to      int;
  v_i         int;
  v_lo        uuid;
  v_hi        uuid;
  v_rows      bigint := 0;
  v_rc        bigint := 0;   -- FIX-736: recipient_count rows written
  v_n         bigint;
  v_failures  text[] := ARRAY[]::text[];
  v_mode      text;
  i           int;
  v_canceled  text := NULL;                            -- FIX-1028
  v_started   timestamptz := clock_timestamp();        -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent financial-entity-totals refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[fe-totals] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'financial_entity_totals_watermark';

  -- Capture the new watermark BEFORE building the dirty set so FR writes that
  -- land mid-refresh are re-processed next run, never silently consumed.
  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  -- FIX-983 — the head-lag horizon, applied to the target BEFORE the dirty set
  -- is built (which is where this routine already captures it, for the sibling
  -- reason stated just above).
  v_horizon := public.fr_watermark_horizon();
  v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);

  -- FIX-983 invariant (c), FIX-1140 shape — floor, do not return early. See the
  -- sibling comment in refresh_official_donor_rollup_incremental(): a 'skipped'
  -- terminal row does not reset check_rollup_freshness()'s clock, so a
  -- legitimately caught-up run must still report 'complete'. Flooring the
  -- target at the watermark empties the dirty predicate by construction and
  -- rewrites the same watermark. GREATEST ignores NULLs; bootstrap is
  -- unaffected.
  v_new_max := GREATEST(v_new_max, v_watermark);

  v_mode := CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END;

  IF v_watermark IS NOT NULL THEN
    SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty_from
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type = 'financial_entity'
      AND fr.updated_at >  v_watermark
      AND fr.updated_at <= v_new_max;   -- FIX-983

    SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty_to
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type = 'financial_entity'
      AND fr.updated_at >  v_watermark
      AND fr.updated_at <= v_new_max;   -- FIX-983
  END IF;

  v_n_from := COALESCE(array_length(v_dirty_from, 1), 0);
  v_n_to   := COALESCE(array_length(v_dirty_to, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_refresh', 'running', v_started,
          jsonb_build_object('mode', v_mode,
                             'dirty_donors', v_n_from,
                             'dirty_recipients', v_n_to,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_watermark IS NULL THEN
    -- Bootstrap: 16-window full pass over both totals sides + recipient_count.
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_rows := v_rows + public.financial_entity_donation_totals_window(v_lo, v_hi);
        v_rows := v_rows + public.financial_entity_received_totals_window(v_lo, v_hi);
        v_rc   := v_rc   + public.financial_entity_recipient_count_window(v_lo, v_hi);  -- FIX-736
        RAISE NOTICE '  [fe-totals] bootstrap window %/16 — % totals rows, % rc rows so far', i, v_rows, v_rc;
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 CANCELED: %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level (outside the EXCEPTION subtransaction)
      EXIT WHEN v_canceled IS NOT NULL;
    END LOOP;
  ELSE
    -- Incremental: chunk the dirty donor set (totals + recipient_count together),
    -- then the dirty recipient set (received totals).
    v_i := 1;
    WHILE v_i <= v_n_from LOOP
      v_chunk := v_dirty_from[v_i : LEAST(v_i + c_chunk - 1, v_n_from)];
      BEGIN
        v_n := public.financial_entity_donation_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
        v_n := public.financial_entity_recipient_count_rebuild(v_chunk);  -- FIX-736
        v_rc := v_rc + v_n;
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;

    v_i := 1;
    WHILE v_i <= v_n_to AND v_canceled IS NULL LOOP
      v_chunk := v_dirty_to[v_i : LEAST(v_i + c_chunk - 1, v_n_to)];
      BEGIN
        v_n := public.financial_entity_received_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;
  END IF;

  -- Advance the watermark only on a clean run — a failed chunk/window's keys
  -- must stay in the next run's dirty set. FIX-1028 adds the cancel arm: a
  -- cancelled run has NOT covered its dirty set, so advancing here would
  -- permanently skip every key it did not reach.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('financial_entity_totals_watermark',
            jsonb_build_object('last_indexed_at', COALESCE(v_new_max, v_horizon)::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows + v_rc,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; watermark unmoved, the whole dirty set is retried next run', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'rows_updated', v_rows,
                        'recipient_count_updated', v_rc,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals] % (mode=%) — % totals rows, % recipient_count rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_mode, v_rows, v_rc, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_financial_entity_totals_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_financial_entity_totals_incremental() TO service_role;

COMMIT;
