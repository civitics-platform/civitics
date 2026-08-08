-- =============================================================================
-- FIX-1002 + FIX-1003 — the donor rollup can take the whole box down, and the
--                       guard that exists to stop it cannot fire.
--
-- ═══ The incident ═══════════════════════════════════════════════════════════
-- 2026-08-08, cron jobid 24 (`donor-rollup-refresh`). Two firings, one block:
--
--   run 194  09:00:00 → 12:28:38  (3h28m38s, status=partial, 400/647 recipients)
--   run 195  12:28:39 → 18:28:46  (6h00m06s, KILLED by the 6h statement_timeout)
--
-- Throughout run 195 the public site served statement timeouts and 503s, and by
-- ~18:00 the Supabase SQL editor could not open a connection at all. There was
-- nothing else on the box: `pg_stat_activity` at 17:52 held exactly one non-idle
-- backend besides a mgmt-api probe, no vacuum in pg_stat_progress_vacuum, no
-- fec_bulk (held off the nightly by FIX-998), no crawler, no traffic spike.
--
-- Run 195 committed ZERO chunks in those six hours.
-- `pipeline_state.donor_rollup_watermark.updated_at` is still 12:28:38 holding
-- cursor cf50b397, which run 194 wrote. Six hours of flat-out I/O, one site
-- outage, and not one row of durable progress.
--
-- That is a categorically different failure from the job-vs-job starvation the
-- FIX-969 bullet describes, and no amount of cron rescheduling addresses it.
-- FIX-969 stays open — it still covers jobids 12, 13, 17, 22 and 26, none of
-- which this migration touches.
--
-- ═══ Why the guard did not fire (FIX-1002) ══════════════════════════════════
-- The FIX-944 predictive guard, retuned by FIX-972, reads:
--
--     IF v_chunk_no > 0
--        AND v_elapsed + (v_max_chunk * 1.25) > EXTRACT(epoch FROM c_budget)
--     THEN EXIT;
--
-- Two properties, both fatal in combination:
--
--   1. `v_chunk_no > 0` skips it entirely before chunk 1.
--   2. It can only be evaluated BETWEEN chunks.
--
-- So a run whose FIRST chunk exceeds the entire window never evaluates the
-- guard even once. That is exactly run 195: one chunk of 50 recipients, still
-- running when the 6h axe fell, against a slowest-ever chunk of 5,447 s
-- recorded three hours earlier in run 194. The guard is not broken — it works
-- correctly on runs that are merely slow (it fired on run 194 at
-- 12,518 + 1.25 × 5,447 = 19,327 > 16,200). It is structurally incapable of
-- firing on the runs that cause outages. A guard that cannot fire in the case
-- it exists for is not a guard.
--
-- ═══ Why one chunk could be that expensive ══════════════════════════════════
-- The chunk is quantised by RECIPIENT COUNT. The cost is driven by per-recipient
-- `financial_relationships` fan-out. Measured on prod 2026-08-08 over
-- `official_donor_totals.donor_count` (which IS COUNT(*) of that official's
-- donation FR rows — see donor_rollup_rebuild_recipients):
--
--     officials 6,782   total FR rows 4,088,218
--     min 1   p50 36   p90 1,389   p99 7,326   max 308,875
--
-- An 8,580× spread between the median and the max. A fixed 50-recipient chunk
-- therefore costs anywhere from ~1,800 to ~15,000,000 FR rows depending purely
-- on where the uuid-ordered cursor happens to land. The quantum is not a
-- quantum; the run is a lottery. FIX-972 halved the count (200 → 50) and bought
-- a 4× reduction in a variance of four orders of magnitude.
--
-- ═══ Third finding: pg_cron QUEUES, it does not skip ════════════════════════
-- FIX-968 added the 12:00 backstop on the stated expectation that "09:00 still
-- draining → 12:00 hits the advisory lock and logs status='skipped'". That
-- premise is false. `cron.job_run_details.start_time` for the second daily
-- firing is not 12:00 — it is ~1.0 s after the first run ENDS, on every day the
-- first run overran:
--
--     08-06  run 1 ended 12:16:14.53   run 2 started 12:16:15.51
--     08-07  run 1 ended 12:30:22.46   run 2 started 12:30:23.53
--     08-08  run 1 ended 12:28:38.81   run 2 started 12:28:39.94
--
-- (`cron.max_running_jobs` is 32, so this is not a global slot cap; pg_cron
-- holds one task per jobid and launches the queued firing on its next 1 s poll
-- tick.) The second firing never reaches the advisory lock, so it never logs
-- 'skipped'. Two full budget windows chain into one continuous block — 9h28m on
-- 08-08. Any budget at or above the 3h gap between firings guarantees this.
--
-- ═══ What saturated (it is not throughput) ══════════════════════════════════
-- `pg_stat_statements`, no text predicate, ordered by total_exec_time:
-- `CALL public.refresh_official_donor_rollup_incremental()` is the single
-- largest consumer on the database — 93,032 s over 17 calls (mean 91 min), 1.8×
-- the entire FEC bulk FR ingest. Its shared-buffer hit rate is 71.0% against a
-- cluster average of 86.55%, on a Pro Small with shared_buffers = 256 MB.
-- Supabase's Disk IO chart read 3–5% across the same 16 hours.
--
-- So the box was never throughput-bound. The rollup's working set evicts
-- 256 MB of shared buffers, the request path's hot pages go with it, and every
-- request-path query then also misses and serialises on random reads. That is
-- why pacing (yielding between chunks) is the right instrument and why raising
-- throughput would make it worse, not better.
--
-- ═══ Which arm is to blame: none of them ════════════════════════════════════
-- The retained `cron.job_run_details` messages name the innermost function at
-- the moment the 6h axe fell, for every jobid-24 blowout in the window:
--
--     07-27  treemap_individuals_rebuild_officials          (line 115)
--     07-28  small_dollar_rebuild_officials                 (line 108)
--     07-29  treemap_individual_brackets_rebuild_officials  (line 119)
--     07-30  donor_rollup_rebuild_recipients line 8         (the odr_mv arm)
--     08-08  treemap_individual_brackets_rebuild_officials  (line 119)
--
-- Five blowouts, four different arms. There is no dominant arm to optimise —
-- every arm filters `financial_relationships` by `to_id = ANY(p_recipients)`,
-- so they all share one cost driver and the axe simply lands wherever the chunk
-- happened to be. This is why the fix is per-chunk cost, not per-arm SQL.
--
-- ═══ What this migration changes ════════════════════════════════════════════
--
-- FIX-1002, in refresh_official_donor_rollup_incremental():
--
--   1. COST-WEIGHTED CHUNKS. The dirty set is fetched with a per-recipient
--      weight (`official_donor_totals.donor_count`, a 117-page table this
--      procedure already maintains) and a chunk accumulates recipients until it
--      hits a weight target rather than a count. A 308,875-row whale forms its
--      own chunk; 278 median officials share one.
--   2. THE GUARD IS ARMED FROM CHUNK 1, and it projects THIS chunk's cost from
--      a measured rows-per-second rather than reserving 1.25× the slowest chunk
--      seen. Chunks are shrunk to fit the remaining budget before the guard has
--      to refuse one.
--   3. c_budget 4h30m → 2h. Sized, not rounded: the firings are 3h apart and
--      pg_cron queues rather than skips, so anything ≥3h guarantees the chained
--      block above; and 2h is what ONE healthy full sweep actually cost
--      (08-02: 2,365 recipients, complete, 2h00m43s). It leaves 1h of slack
--      inside the 3h gap for the guard's own imprecision.
--   4. A LATEST-START WINDOW (13:00 UTC). If a run still overruns, the firing
--      queued behind it refuses to start rather than running a second full
--      window into US active hours. Overridable per-session for break-glass.
--   5. YIELD between chunks — 10% of the chunk's own duration, capped at 15 s.
--
-- FIX-1003:
--
--   6. Per-table autovacuum overrides on all six arm tables, and a scheduled
--      VACUUM (ANALYZE) for the two large ones after each rollup window.
--
-- DELIBERATELY NOT CHANGED:
--   * The 6h role statement_timeout, in either direction. It is the axe, not
--     the guard; it is shared by every pg_cron job; FIX-943's rule stands.
--   * Anything about WHAT donor_rollup_rebuild_recipients() computes.
--   * The cursor/watermark semantics (FIX-704 invariant, FIX-944 durability).
--     The cursor is still the last recipient of the last committed chunk in
--     uuid order; the dirty set is still built ORDER BY to_id.
--   * Routing cron 24 to donor_rollup_rebuild_bulk(), which is 206–1000× faster
--     per recipient and IS the eventual answer. Filed as FIX-1004 and gated on
--     the first post-vacuum firing, because if the arms being 19.9% dead was
--     the whole cause then the incremental path returns to 1.35 s/recipient and
--     the regime split is unnecessary. Do not pre-empt that measurement.
--
-- STALENESS IS CHEAP HERE, DOWNTIME IS NOT. These are derived money rollups on
-- a pre-revenue site. Every constant below trades convergence speed for a
-- shorter degradation window, on purpose. A future session tempted to raise
-- c_budget or the chunk target to "make it converge" should read FIX-1004
-- first: converging is the bulk path's job, not this one's.
--
-- Cross-ref FIX-969, FIX-944, FIX-965, FIX-968, FIX-972, FIX-974, FIX-943,
-- FIX-884, FIX-1004.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FIX-1002 — the bounded, paced, cost-weighted procedure.
--
--    Body derived from the FIX-972 definition; the FIX-704/776/777/779/836/868
--    layering lives in donor_rollup_rebuild_recipients() and is untouched.
-- ─────────────────────────────────────────────────────────────────────────────
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

  v_state      jsonb;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_new_max    timestamptz;
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
  v_ignore_win boolean;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_stop_why   text := NULL;
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
  --     SET civitics.donor_rollup_budget_seconds       = '72000';
  --     SET civitics.donor_rollup_chunk_target_seconds = '600';
  --     SET civitics.donor_rollup_chunk_size           = '250';
  --     SET civitics.donor_rollup_ignore_start_window  = 'on';
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
  END IF;

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
        AND fr.updated_at > v_watermark
        AND (v_cursor IS NULL OR fr.to_id > v_cursor)
    ) d
    LEFT JOIN public.official_donor_totals odt ON odt.official_id = d.to_id;
  END IF;

  v_n_recips := COALESCE(array_length(v_dirty, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_refresh', 'running', now(),
          jsonb_build_object(
            'mode', CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END,
            'dirty_recipients', v_n_recips,
            'dirty_weight', COALESCE((SELECT SUM(w) FROM unnest(v_weights) w), 0),
            'resumed', v_resumed,
            'resume_cursor', v_cursor,
            'sweep_failures_before', v_prior_fail,
            'budget_seconds', v_budget_s,
            'chunk_target_seconds', c_chunk_secs,
            'rows_per_second_seed', round(v_rps_seed::numeric, 2),
            'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  WHILE v_i <= v_n_recips LOOP
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
    EXCEPTION WHEN OTHERS THEN
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

    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Bounds txn size + advances xmin between chunks.
    COMMIT;

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
        error_message = format('budget exhausted — resumable at recipient %s of %s (cursor %s)',
                               v_i, v_n_recips, v_cursor),
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'recipients_done', v_i - 1,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'resumable', true,
                          'resume_at_chunk', v_chunk_no + 1,
                          -- Which of the two stop paths ended the run. Without
                          -- this, 'partial' cannot be told apart from 'partial'
                          -- and the guard is unfalsifiable from the log alone.
                          'stop_reason', v_stop_why,
                          'remaining_recipients', GREATEST(v_n_recips - v_i + 1, 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3),
                          -- FIX-1002 — "no silent caps": a single recipient the
                          -- guard refuses because it cannot fit a whole budget
                          -- is a stuck sweep, not a paced one. Name it.
                          'blocked_recipient', v_blocked,
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] PARTIAL — % of % recipients this run, resumable at chunk %',
      v_i - 1, v_n_recips, v_chunk_no + 1;
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
                'last_indexed_at', COALESCE(v_new_max, NOW())::text,
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object(
                      'last_indexed_at', COALESCE(v_new_max, NOW())::text,
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

COMMENT ON PROCEDURE public.refresh_official_donor_rollup_incremental() IS
  'FIX-704/832/944/972/1002 — incremental refresh of the six per-official money '
  'rollups via donor_rollup_rebuild_recipients(). FIX-944: resumable — a cursor '
  '(pipeline_state.donor_rollup_watermark.sweep_cursor) is advanced inside each '
  'chunk transaction. FIX-1002: chunks are sized by COST (summed '
  'official_donor_totals.donor_count) rather than by recipient count, because '
  'per-recipient FR fan-out spans 8,580x between p50 and max, so a fixed count '
  'had unbounded cost; the budget guard is armed FROM CHUNK 1 and projects the '
  'chunk in hand from a measured rows-per-second instead of reserving 1.25x the '
  'slowest chunk seen (on 2026-08-08 the old form was skipped entirely and the '
  'run burned 6h with zero committed chunks while the site served 503s); the '
  'budget is 2h, below the 3h gap between firings, because pg_cron QUEUES the '
  'next firing behind a running one rather than skipping it; a firing will not '
  'START at or after 13:00 UTC; and the loop yields 10%% of each chunk''s '
  'duration (capped 15s) to leave shared-buffer headroom for the request path. '
  'Session GUC overrides: civitics.donor_rollup_{budget_seconds,'
  'chunk_target_seconds,chunk_size,ignore_start_window}. Break-glass single-'
  'pass: packages/data/src/scripts/donor-rollup-sweep.ts. Converging a large '
  'backlog is donor_rollup_rebuild_bulk()''s job, not this one''s — see FIX-1004.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FIX-1003 — per-table autovacuum overrides on all six arm tables.
--
--    This procedure bulk-rewrites all six by DELETE+INSERT twice a day and
--    vacuums none of them, so the FIX-943 standing rule is unenforced on the
--    path that violates it most. None of the six carried an override, while
--    nine other tables do.
--
--    At the cluster default (50 + 0.2 x reltuples) the two large arms only
--    autovacuum at 201,196 and 185,409 dead tuples; a budget-truncated run of
--    400 recipients makes ~64k, so they went 08-02 → 08-08 without one and
--    reached 19.9% dead / 73.7% all-visible. At 0.05 the floors drop to ~50,336
--    and ~46,390, which a single run trips.
--
--    0.05/0.02 matches what financial_entities, entity_connections, entity_tags,
--    external_source_refs, proposals, votes and enrichment_queue already carry.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.official_donor_rollup_mv
  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.treemap_individuals_rollup
  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.official_sector_affinity_rollup
  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.official_donor_bracket_totals
  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.official_donor_totals
  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.official_small_dollar_rollup
  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FIX-1003 — a scheduled vacuum tail for the two large arms.
--
--    The FIX-943 rule says the bulk rewriter ends by vacuuming what it rewrote.
--    It CANNOT be done inside the procedure: VACUUM may not run in a
--    transaction block, and a PL/pgSQL body is always inside one — including
--    immediately after a COMMIT, which opens the next transaction at once. Nor
--    can two VACUUMs share one cron command: pg_cron sends the command as a
--    simple query and multiple statements there run in an implicit transaction
--    block. Hence one job per table, exactly as jobids 6 / 30 / 31 already do
--    for entity_connections, financial_entities and donor_party_rollup_mv.
--
--    05/10 past 11:00 and 14:00 UTC = just after each 2h budget window closes.
--    Measured cost of vacuuming all six on prod 2026-08-08: 8.4 s total. If a
--    run overruns and starves these at startup, the autovacuum overrides above
--    are the backstop and check_cron_job_health() (FIX-968) reports the miss.
--
--    FIX-688 unschedule+schedule idiom, which is correct HERE (unlike FIX-968's
--    alter_job, which existed to preserve jobid 24's run history): these are new
--    jobs with no history to orphan.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('odr-mv-vacuum-analyze');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('treemap-individuals-vacuum-analyze');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'odr-mv-vacuum-analyze',
  '5 11,14 * * *',
  'VACUUM (ANALYZE) public.official_donor_rollup_mv;'
);

SELECT cron.schedule(
  'treemap-individuals-vacuum-analyze',
  '10 11,14 * * *',
  'VACUUM (ANALYZE) public.treemap_individuals_rollup;'
);
