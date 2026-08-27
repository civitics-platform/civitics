-- =============================================================================
-- FIX-1111 — the entity_connections rebuild becomes a background CRAWL: one
--            bounded unit per firing, paced so spend ≈ refill.
--
-- ═══ THE CONSTRAINT THIS IS BUILT AROUND ═══════════════════════════════════
-- Three measured I/O-budget exhaustions in three days (08-24 EC window 5,
-- 08-25 jobid 13, 08-26 the FIX-1101 acceptance drain) established the
-- operating fact recorded in FIX-1107: on this Small compute the scarce
-- resource is the daily **Disk IO burst budget**, not CPU. Provisioned
-- baseline is 1,000 IOPS / 22 MB/s; the disk caps at 3,000; the box holds
-- roughly 30–75 minutes per day of above-baseline I/O and, once that is spent,
-- runs at ~150 IOPS / 60–75% IOwait for HOURS while the balance refills.
--
-- The two facts that make a crawl the right shape rather than a smaller budget:
--
--   * **Killing a writer does not return the credit it spent.** On 08-25
--     jobid 13 was cancelled at 12:14 and the box got monotonically WORSE
--     afterwards — 43/60, 50/60, 58/60 watchdog firings lost at 12:00, 13:00,
--     14:00, peaking with nothing scheduled at all. A budget bounds the
--     writer; it does not bound the consequence.
--   * **Sustained load INSIDE the budget is harmless.** The contrast is on
--     record: 08-26 donor-rollup-refresh ran 09:00–10:59 AND 12:00–13:59 —
--     four hours of sustained writing — and jobids 40/44 recorded 5/60 failed
--     firings across the entire day.
--
-- So the fix is not "bound the burst harder". It is "never burst": spread the
-- same work across many small firings whose aggregate spend stays under the
-- refill rate. Derived-layer staleness of a few days is acceptable; an
-- exhausted I/O balance is not.
--
-- ═══ THE PACING ARITHMETIC (the measurement decision 7 asked for) ══════════
-- FIX-1101's clean scheduled receipt (prod 2026-08-26 08:00, jobid 2, runid
-- succeeded in 2,654 s) is the instrument. Its arm_timings:
--
--     donations_incr_windows   1385 s   ← 4 windows × ~346 s
--     ..._external              878 s
--     ..._contracts             307 s
--     ..._votes                  26 s
--     ..._holds / _lobbying / _oversight / _appointments   10 s each
--     ..._gifts / _cosponsors                               9 s each
--     ..._investigation           0 s
--
-- A donations window measures ~346 s at ~2,500 IOPS. Against a 1,000 IOPS
-- baseline that is 1,500 excess IOPS × 346 s, and the burst pool refills at
-- roughly baseline — which is why ONE window costs about **540 s of refill**
-- (the empirical number the FIX-1110 drain wrapper takes as its default sleep)
-- and why 12–13 back-to-back windows exhaust the pool, matching the measured
-- 75-minute 08-25 burst.
--
-- The crawl's ceiling therefore does NOT depend on what a cycle contains,
-- because pacing is per-FIRING, not per-cycle:
--
--     at */15, at most 96 firings/day × at most 1 unit each
--     worst case every unit is a full-cost window:
--         96 × 346 s  =  33,216 writer-seconds/day
--         × (540/346) =  51,817 refill-seconds/day
--         ÷ 86,400    =  **60% of the day's refill**
--
-- 60% with 40% headroom, and that is the HARD ceiling — no cycle composition
-- can exceed it. Compare the three measured exhaustions, all of which spent
-- 100% of the pool in under two hours. */15 is defensible; see §7 of
-- docs/audits/2026-08-27-io-budget-burst-ledger.md for what the ledger says
-- about where the rest of the day's refill is already committed.
--
-- ⚠ WHAT THE ARITHMETIC *DID* MOVE — `min_cycle_interval_minutes`.
-- The per-firing ceiling is safe, but it is not the whole cost story. A cycle
-- is 16 windows + 10 arms = up to 26 units, and the ten non-donations arms are
-- UNCONDITIONAL full rebuilds — they rerun every cycle whether or not anything
-- changed. Windows that are already banked skip without consuming a firing
-- (see the driver), so a cycle with a small dirty set completes in ~13 firings
-- ≈ 3.3 h, which would spin those ten arms **6–7× per day against the once-a-
-- week they get today**. That is not a budget problem — 8 of the 10 arms cost
-- ≤26 s — but `_external` (878 s) and `_contracts` (307 s) are real, and
-- burning ~2 h/day of writer to recompute unchanged edges is precisely the
-- waste this whole line of work exists to stop. So the config carries a
-- minimum interval between CYCLES, defaulted to 6 h (≤4 cycles/day, still 28×
-- fresher than the current weekly rebuild). Mechanism ships; the number is
-- data. This is the one knob NOT named in the cc-90 design decisions, and it
-- is here because the arithmetic asked for it.
--
-- ═══ ⚠⚠ THE OVERLOAD HAZARD — WHY THIS MIGRATION DROPS BEFORE IT CREATES ═══
-- Adding `p_max_units int DEFAULT NULL` does NOT replace
-- run_entity_connections_rebuild(text). It creates a SECOND procedure with a
-- different signature, and the old one keeps existing. Measured on local
-- before writing this file:
--
--     CREATE OR REPLACE PROCEDURE _ovl_test(text DEFAULT 'x');
--     CREATE OR REPLACE PROCEDURE _ovl_test(text DEFAULT 'x', int DEFAULT NULL);
--     CALL _ovl_test('incremental');
--     -- ERROR:  procedure public._ovl_test(unknown) is not unique
--
-- This is worse than shadowing: it is a HARD ERROR at call time. Shipping the
-- new signature without dropping the old would break every existing caller —
-- including jobid 2's `CALL public.run_entity_connections_rebuild('incremental')`
-- — and the EC arm would stop running entirely, silently, with the failure
-- visible only in cron.job_run_details. The DROP below is therefore load-
-- bearing, not tidiness. Any future migration that adds a parameter to this
-- procedure must do the same.
--
-- ═══ WHAT THIS SHIPS ═══════════════════════════════════════════════════════
--   1. `p_max_units` on the EXISTING procedure — one body, one truth. NULL is
--      byte-for-byte today's behaviour. N runs at most N pending units and
--      exits resumable. A "unit" is exactly what FIX-1056/FIX-1069 already
--      made bankable: one donations window, or one non-donations arm.
--   2. A unit-duration ring (last 50) + the 2× median backoff — the throttle
--      sensor. The box tells you it is throttled by the unit slowing 10–40×
--      (jobid 13's per-chunk cost went 3 s → 8 s → >1,680 s across the 08-25
--      throttle inflection). Retrying makes it worse, so back off 2 h.
--   3. Blackout windows — yield to users. Default empty; policy is data.
--   4. The `ec-crawl` pg_cron job at */15, created **inactive**, plus its
--      FIX-1071 outside budget row at 1,800 s.
--
-- DELIBERATELY NOT SHIPPED: a lock around the crawl. pg_cron QUEUES a firing
-- behind a still-running one (reference_pgcron_queues_overrunning_job), and
-- the procedure's own advisory lock already covers the drain-vs-crawl case.
-- A third guard would be a third thing that can strand.
--
-- Cross-ref FIX-1107 (the I/O budget fact), FIX-969 (the regime this answers),
-- FIX-1101 (per-window bound + FEC interlock, both untouched here), FIX-1069
-- (the windows and their watermarks), FIX-1056 (banking + resume), FIX-1063
-- (the outside watchdog), FIX-1110 (the drain wrapper that now rides this),
-- FIX-1030/FIX-1035 (unit watchdog, liveness-first), FIX-1028 (query_canceled).
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The crawl's control block.
--
--    Everything an operator can retune without a migration lives here. Seeded
--    with ON CONFLICT DO NOTHING so a replay never stamps on tuned values.
--
--    blackout is a LIST of {"from":"HH:MM","to":"HH:MM"} in UTC. Empty by
--    default: the mechanism ships, Craig sets the policy once he can see the
--    traffic it should yield to.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.pipeline_state (key, value)
VALUES ('ec_crawl', jsonb_build_object(
          'cadence_minutes',           15,
          'unit_budget_seconds',       1800,
          'backoff_hours',             2,
          'backoff_multiple',          2.0,
          'backoff_min_samples',       5,
          'min_cycle_interval_minutes', 360,
          'blackout',                  '[]'::jsonb,
          'recent_units',              '[]'::jsonb))
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.pipeline_state IS
  'Durable key/value control + watermark state for pipelines and scheduled '
  'work. FIX-1111 adds the ''ec_crawl'' block: cadence_minutes, '
  'unit_budget_seconds, backoff_hours/multiple/min_samples, '
  'min_cycle_interval_minutes, blackout[], backoff_until, and recent_units '
  '(a bounded ring of the last 50 unit timings, which is the crawl''s throttle '
  'sensor).';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The gate — may a crawl firing open a unit right now?
--
--    Three reasons to say no, in cost order (cheapest first, and none of them
--    opens a cycle or writes a log row):
--
--      backoff  — a unit recently ran ≥ backoff_multiple × the rolling median
--                 for its type, i.e. the box is throttled. This is the one
--                 that matters, and the only one that earns a data_sync_log
--                 row (see the driver): it is an alarm-worthy state.
--      blackout — a configured user-facing window covers now().
--      cooldown — the last cycle CLOSED less than min_cycle_interval_minutes
--                 ago, so re-opening one would recompute unchanged arms. Only
--                 consulted when no cycle is currently open; a cycle in flight
--                 always continues.
--
--    Returns a verdict rather than acting, so the driver owns all logging and
--    this stays trivially testable in isolation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ec_crawl_gate()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cfg        jsonb;
  v_backoff    timestamptz;
  v_now        timestamptz := clock_timestamp();
  v_tod        time        := (clock_timestamp() AT TIME ZONE 'UTC')::time;
  r            record;
  v_from       time;
  v_to         time;
  v_cursor     jsonb;
  v_min_gap    int;
  v_last_close timestamptz;
  v_age_min    numeric;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'ec_crawl';
  v_cfg := COALESCE(v_cfg, '{}'::jsonb);

  -- ── backoff ────────────────────────────────────────────────────────────────
  v_backoff := (v_cfg->>'backoff_until')::timestamptz;
  IF v_backoff IS NOT NULL AND v_backoff > v_now THEN
    RETURN jsonb_build_object(
      'run',    false,
      'reason', 'backoff',
      'detail', format('backing off until %s (%s s remaining) — a unit ran far over its rolling median',
                       v_backoff, round(EXTRACT(epoch FROM (v_backoff - v_now)))::int),
      'backoff_until', v_backoff);
  END IF;

  -- ── blackout ───────────────────────────────────────────────────────────────
  -- Wrap-around is supported and is the common case for a night-time-only
  -- crawl: from > to means the window spans midnight UTC.
  FOR r IN SELECT e.value AS w FROM jsonb_array_elements(COALESCE(v_cfg->'blackout', '[]'::jsonb)) e
  LOOP
    BEGIN
      v_from := (r.w->>'from')::time;
      v_to   := (r.w->>'to')::time;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[ec-crawl] unparseable blackout entry % — ignored', r.w;
      CONTINUE;
    END;
    IF v_from IS NULL OR v_to IS NULL THEN CONTINUE; END IF;

    IF (v_from <= v_to  AND v_tod >= v_from AND v_tod < v_to)
    OR (v_from >  v_to AND (v_tod >= v_from OR v_tod < v_to))
    THEN
      RETURN jsonb_build_object(
        'run',    false,
        'reason', 'blackout',
        'detail', format('inside blackout window %s–%s UTC', v_from, v_to));
    END IF;
  END LOOP;

  -- ── cycle cooldown ─────────────────────────────────────────────────────────
  -- Only when NO cycle is open. An open cycle is work already started and must
  -- be allowed to finish, or the crawl could strand a half-drained dirty set.
  SELECT value INTO v_cursor
    FROM public.pipeline_state WHERE key = 'entity_connections_rebuild_cursor';

  IF v_cursor IS NULL THEN
    v_min_gap := COALESCE((v_cfg->>'min_cycle_interval_minutes')::int, 0);
    IF v_min_gap > 0 THEN
      SELECT max(completed_at) INTO v_last_close
        FROM public.data_sync_log
       WHERE pipeline = 'entity_connections_rebuild'
         AND status   = 'complete';
      IF v_last_close IS NOT NULL THEN
        v_age_min := EXTRACT(epoch FROM (v_now - v_last_close)) / 60.0;
        IF v_age_min < v_min_gap THEN
          RETURN jsonb_build_object(
            'run',    false,
            'reason', 'cycle_cooldown',
            'detail', format('last cycle closed %s min ago; minimum interval is %s min',
                             round(v_age_min)::int, v_min_gap));
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('run', true, 'reason', 'clear');
END;
$$;

REVOKE ALL ON FUNCTION public.ec_crawl_gate() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ec_crawl_gate() IS
  'FIX-1111 — may an ec-crawl firing open a unit right now? Checks, cheapest '
  'first: backoff_until (the throttle sensor tripped), a configured blackout '
  'window (yield to users), and — only when no cycle is open — a minimum '
  'interval since the last cycle CLOSED (so the ten unconditional '
  'non-donations arms are not recomputed 6× a day for a once-weekly workload). '
  'Returns a verdict; the caller owns logging. Enforced only when '
  'run_entity_connections_rebuild() is called with p_max_units NOT NULL, so a '
  'manual unbounded run is unaffected.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The throttle sensor — record a unit, decide whether to back off.
--
--    WHY DURATION AND NOT IOPS. We cannot read the box's burst balance; there
--    is no catalog for it. But we do not need to. The 08-25 receipt shows the
--    throttle announcing itself in the only number we DO have: jobid 13's
--    per-chunk cost went ~3 s (10:00 hour, credit in hand) → ~8 s (11:00,
--    throttling) → **>1,680 s** (one 500-entity chunk, 28 minutes, killed with
--    nothing committed). The inflection sits exactly at the ~11:15 throttle.
--    A unit slowing 10–40× IS the sensor.
--
--    Median, not mean: a single 1,800 s cancelled unit must not drag the
--    baseline it is being compared against. Per unit TYPE, because a 346 s
--    window and a 9 s gifts arm share no scale.
--
--    min_samples guards the cold start — with 2 samples any second unit is
--    trivially ≥2× the median and the crawl would back off on principle.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ec_crawl_record_unit(
  p_unit_class text,
  p_unit       text,
  p_seconds    numeric,
  p_rows       bigint,
  p_outcome    text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_ring_max CONSTANT int := 50;
  v_cfg      jsonb;
  v_ring     jsonb;
  v_entry    jsonb;
  v_median   numeric;
  v_samples  int;
  v_mult     numeric;
  v_minn     int;
  v_hours    numeric;
  v_trip     boolean := false;
  v_until    timestamptz;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'ec_crawl';
  v_cfg  := COALESCE(v_cfg, '{}'::jsonb);
  v_ring := COALESCE(v_cfg->'recent_units', '[]'::jsonb);

  v_mult  := COALESCE((v_cfg->>'backoff_multiple')::numeric, 2.0);
  v_minn  := COALESCE((v_cfg->>'backoff_min_samples')::int, 5);
  v_hours := COALESCE((v_cfg->>'backoff_hours')::numeric, 2);

  -- Median over PRIOR samples of this class only — the new unit must not be
  -- allowed to raise the bar it is judged against.
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.value->>'seconds')::numeric),
         count(*)
    INTO v_median, v_samples
    FROM jsonb_array_elements(v_ring) e
   WHERE e.value->>'unit_class' = p_unit_class
     AND (e.value->>'seconds') IS NOT NULL;

  IF v_samples >= v_minn AND v_median > 0 AND p_seconds >= v_mult * v_median THEN
    v_trip  := true;
    v_until := clock_timestamp() + make_interval(secs => v_hours * 3600);
  END IF;

  v_entry := jsonb_build_object(
    'unit',       p_unit,
    'unit_class', p_unit_class,
    'seconds',    round(p_seconds, 1),
    'rows',       p_rows,
    'outcome',    p_outcome,
    'at',         clock_timestamp(),
    -- The I/O class the ledger reads. Derived from duration against this
    -- class's own median, so it stays meaningful as the arms change shape.
    'iops_class', CASE
                    WHEN p_seconds < 30                              THEN 'trivial'
                    WHEN v_samples >= v_minn AND v_median > 0
                         AND p_seconds >= v_mult * v_median          THEN 'degraded'
                    WHEN p_seconds < 120                             THEN 'short'
                    ELSE 'sustained_writer'
                  END,
    'median_at_time', CASE WHEN v_samples >= v_minn THEN round(v_median, 1) END);

  -- Append, then keep only the newest c_ring_max.
  v_ring := v_ring || jsonb_build_array(v_entry);
  IF jsonb_array_length(v_ring) > c_ring_max THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
      INTO v_ring
      FROM jsonb_array_elements(v_ring) WITH ORDINALITY AS e(value, ord)
     WHERE e.ord > jsonb_array_length(v_ring) - c_ring_max;
  END IF;

  v_cfg := v_cfg || jsonb_build_object('recent_units', v_ring);
  IF v_trip THEN
    v_cfg := v_cfg || jsonb_build_object('backoff_until', v_until);
    RAISE WARNING '[ec-crawl] unit % (%) took %s vs a rolling median of %s over % samples — backing off until %',
      p_unit, p_unit_class, round(p_seconds)::int, round(v_median)::int, v_samples, v_until;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('ec_crawl', v_cfg)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object(
    'recorded',      true,
    'unit',          p_unit,
    'seconds',       round(p_seconds, 1),
    'median',        CASE WHEN v_samples >= v_minn THEN round(v_median, 1) END,
    'samples',       v_samples,
    'backoff_set',   v_trip,
    'backoff_until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.ec_crawl_record_unit(text, text, numeric, bigint, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ec_crawl_record_unit(text, text, numeric, bigint, text) IS
  'FIX-1111 — records one completed unit into pipeline_state.ec_crawl.recent_units '
  '(bounded ring of 50) and trips backoff_until when the unit ran >= '
  'backoff_multiple x the rolling MEDIAN for its own unit class over at least '
  'backoff_min_samples prior samples. Duration is the sensor because the burst '
  'balance is not readable from any catalog, and because the throttle announces '
  'itself in duration: prod 2026-08-25 jobid 13 went 3s -> 8s -> >1680s per '
  'chunk across the throttle inflection. Called by '
  'run_entity_connections_rebuild() in EVERY mode, so a manual unbounded run '
  'still teaches the crawl; only ENFORCEMENT is crawl-mode-gated.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The driver.
--
--    ⚠ DROP FIRST — see the overload hazard in the header. Without this, every
--    existing `CALL run_entity_connections_rebuild('incremental')` fails with
--    "procedure ... is not unique" and the EC arm silently stops running.
--
--    Reproduced from FIX-1101 with the FIX-1111 changes marked. Every line not
--    marked FIX-1111 is byte-identical to the shipped body (prod prosrc md5
--    694592901327e33d3bc8a3d59862bb52, verified equal to local before edit).
-- ─────────────────────────────────────────────────────────────────────────────
DROP PROCEDURE IF EXISTS public.run_entity_connections_rebuild(text);

CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(
  IN p_mode      text DEFAULT 'incremental'::text,
  IN p_max_units int  DEFAULT NULL          -- FIX-1111
)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- EXCEPTION WHEN OTHERS does not match query_canceled, so before this the 6h
  -- statement_timeout blew straight through both handlers below and out of the
  -- procedure, skipping the terminal UPDATE and stranding the row 'running'.
  v_canceled   text := NULL;
  -- ── FIX-1056 — budget + durable per-arm resume checkpoint ─────────────────
  -- 5h, deliberately 1h under the 6h `postgres` role statement_timeout so the
  -- terminal bookkeeping below is never the thing that gets cancelled. Do NOT
  -- raise this to 6h: the margin IS the feature. FIX-1071 mirrors this value in
  -- cron_job_budget as an OUTSIDE bound, because this one is checked at arm
  -- boundaries and therefore cannot bound a single arm.
  c_budget_default interval := interval '5 hours';
  c_budget        interval;
  c_cursor_key    text     := 'entity_connections_rebuild_cursor';
  c_budget_key    text     := 'entity_connections_rebuild_budget';
  c_cycle_max_age interval := interval '7 days';
  v_cursor        jsonb;
  v_done_arms     text[]   := ARRAY[]::text[];
  v_cycle_started timestamptz;
  v_budget_out    boolean  := false;
  v_arm_started   timestamptz;
  v_arm_failed    boolean;
  v_arm_timings   jsonb    := '{}'::jsonb;
  v_next_arm      text     := NULL;
  v_resumed       boolean  := false;
  -- ── FIX-1069 — the donations arm is windowed in BOTH modes ────────────────
  v_don_arm       text;
  v_incr_target   timestamptz := NULL;
  v_bootstrap     boolean  := false;
  v_closed        boolean;
  -- ── FIX-1101 ──────────────────────────────────────────────────────────────
  c_inflight_key  text     := 'entity_connections_window_inflight';
  v_interlock     jsonb;
  -- ── FIX-1111 — the crawl ──────────────────────────────────────────────────
  v_crawl        boolean := (p_max_units IS NOT NULL);
  v_units_run    int     := 0;
  v_unit_capped  boolean := false;
  v_gate         jsonb;
  v_unit_t0      timestamptz;
  v_unit_secs    numeric;
  v_rec          jsonb;
  v_backoff_set  boolean := false;
  v_win_since    timestamptz;
  v_unit_log     jsonb   := '[]'::jsonb;
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
  -- FIX-1028 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF p_mode NOT IN ('full', 'incremental') THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: invalid p_mode %, expected ''full'' or ''incremental''', p_mode;
  END IF;

  -- FIX-1111 — a unit cap of 0 or less is meaningless; treat it as a caller bug
  -- rather than silently doing nothing forever on a */15 schedule.
  IF v_crawl AND p_max_units < 1 THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: p_max_units must be >= 1 (got %)', p_max_units;
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

  -- ── FIX-1111 — the crawl gate ─────────────────────────────────────────────
  -- Crawl mode only: p_max_units IS NULL is byte-for-byte today's behaviour, so
  -- an operator's unbounded manual run is never blocked by a policy written for
  -- a */15 background job.
  --
  -- Placed AFTER the advisory-lock guard (so the unlock below is unconditional)
  -- and BEFORE the FEC interlock, because it is strictly cheaper: two
  -- pipeline_state reads and one indexed data_sync_log aggregate, against the
  -- interlock's pg_locks scan.
  --
  -- LOGGING ASYMMETRY, deliberate. Only `backoff` writes a data_sync_log row.
  -- At */15 a blackout or cooldown skip would write up to 96 rows a day saying
  -- "I did nothing, on purpose", drowning the very log that FIX-1107-class
  -- diagnosis is read from. Backoff is rare, means the box is throttled, and is
  -- exactly what you want to find in that log. The other two are counted in
  -- ec_crawl.skips and RAISEd, which is greppable without being noise.
  IF v_crawl THEN
    v_gate := public.ec_crawl_gate();
    IF NOT (v_gate->>'run')::boolean THEN
      IF v_gate->>'reason' = 'backoff' THEN
        INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
        VALUES (
          'entity_connections_rebuild', 'skipped', v_started, clock_timestamp(),
          jsonb_build_object(
            'mode',        p_mode,
            'source',      'pg_cron',
            'skip_reason', v_gate->>'detail',
            'crawl',       true,
            'max_units',   p_max_units,
            'gate',        v_gate));
      END IF;

      UPDATE public.pipeline_state
         SET value = value
                   || jsonb_build_object(
                        'skips',
                        COALESCE(value->'skips', '{}'::jsonb)
                        || jsonb_build_object(
                             v_gate->>'reason',
                             COALESCE((value->'skips'->>(v_gate->>'reason'))::int, 0) + 1,
                             'last_skip_at',     clock_timestamp(),
                             'last_skip_reason', v_gate->>'reason')),
             updated_at = now()
       WHERE key = 'ec_crawl';

      RAISE NOTICE '[rebuild/crawl] SKIPPED (%) — %', v_gate->>'reason', v_gate->>'detail';
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;
  END IF;

  -- ── FIX-1101 — the widened FEC interlock ──────────────────────────────────
  -- Defers BEFORE the log row goes 'running', before the cursor read and before
  -- any cycle is opened, so a deferred firing leaves no state behind and the
  -- next firing is indistinguishable from a first one.
  --
  -- The status is its own value, 'deferred', not 'skipped': a skip means a peer
  -- rebuild is already doing this work, a defer means the work is deliberately
  -- postponed. Conflating them would make the two indistinguishable in exactly
  -- the log this line of work is diagnosed from.
  --
  -- Placed AFTER the advisory-lock guard, so at this point we HOLD the rebuild
  -- lock and the unlock below is both required and unconditional.
  --
  -- FIX-1111 — this is also the whole Monday fix. jobid 22 is retired by the
  -- crawl, and the weekly FIX-903 FEC replay now simply defers crawl firings
  -- while it holds the lock or leaves a run_state. When it clears, the crawl's
  -- next unit runs — and if the replay spent the day's I/O budget, that unit's
  -- DURATION says so and the sensor above backs off 2 h. No schedule arithmetic.
  v_interlock := public.fec_bulk_interlock_state();

  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'deferred', v_started, clock_timestamp(),
      jsonb_build_object(
        'mode',          p_mode,
        'source',        'pg_cron',
        'defer_reason',  v_interlock->>'reason',
        'fec_interlock', v_interlock)
    );
    RAISE WARNING '[rebuild] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- A stale marker does NOT defer, but it must not be silent either: a
  -- run_state that never clears would otherwise convert one bad run into an
  -- indefinitely skipped arm.
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[rebuild] fec_bulk_run_state present but STALE (%s old) — proceeding; the marker is stranded and wants investigating',
      v_interlock->>'run_state_age';
  END IF;

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer. FIX-1069 re-measured the same for a FUNCTION's
  -- proconfig on the plain SELECT path (the GUC does change inside the body; the
  -- timer does not re-arm) and REMOVED the decorative 45min/90min guards from
  -- the donations arm functions rather than leave them to mislead.
  SET work_mem = '256MB';

  -- ── FIX-1056 — budget, overridable without a migration ────────────────────
  -- pipeline_state.entity_connections_rebuild_budget = {"seconds": N}. Exists so
  -- an operator can shrink or widen the budget in one UPDATE, and so the repro
  -- paths exercise the SHIPPED code path rather than a test variant of it.
  SELECT GREATEST(interval '1 second', make_interval(secs => (value->>'seconds')::numeric))
    INTO c_budget
    FROM public.pipeline_state
   WHERE key = c_budget_key AND (value->>'seconds') IS NOT NULL;
  c_budget := COALESCE(c_budget, c_budget_default);

  -- ── FIX-1056 — read the resume cursor BEFORE opening the log row ───────────
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;

  IF v_cursor IS NOT NULL
     AND v_cursor->>'mode' = p_mode
     AND (v_cursor->>'cycle_started_at')::timestamptz > now() - c_cycle_max_age
  THEN
    v_cycle_started := (v_cursor->>'cycle_started_at')::timestamptz;
    SELECT COALESCE(array_agg(x), ARRAY[]::text[])
      INTO v_done_arms
      FROM jsonb_array_elements_text(COALESCE(v_cursor->'completed_arms', '[]'::jsonb)) x;
    v_resumed := COALESCE(array_length(v_done_arms, 1), 0) > 0;
    IF v_resumed THEN
      RAISE NOTICE '[rebuild] resuming cycle started % — % arm(s) already banked: %',
        v_cycle_started, array_length(v_done_arms, 1), array_to_string(v_done_arms, ', ');
    END IF;
  ELSE
    -- No cursor, wrong mode, or a cycle too old to trust: start fresh.
    v_cycle_started := v_started;
    v_done_arms     := ARRAY[]::text[];
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object(
      'mode', p_mode,
      'source', 'pg_cron',
      'resumed', v_resumed,
      'cycle_started_at', v_cycle_started,
      'budget_seconds', round(EXTRACT(epoch FROM c_budget))::int,
      'arms_banked_on_entry', to_jsonb(v_done_arms),
      -- FIX-1111
      'crawl', v_crawl,
      'max_units', p_max_units
    )
  )
  RETURNING id INTO v_log_id;

  -- ── Startup reconcile: heal a stranded autovacuum flag (FIX-885) ──────────
  -- Runs on EVERY invocation, both modes, before the mode-gated pause below.
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  IF NOT COALESCE(
       (SELECT (split_part(opt, '=', 2))::boolean
          FROM pg_catalog.pg_class c, unnest(c.reloptions) AS opt
         WHERE c.oid = 'public.entity_connections'::regclass
           AND opt LIKE 'autovacuum_enabled=%'),
       true
     ) THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE WARNING '[rebuild] startup reconcile: autovacuum was stranded OFF on entity_connections — re-enabled (FIX-885)';
  END IF;

  -- ── Pause autovacuum on entity_connections for the full rebuild (FIX-590) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = false);
    RAISE NOTICE '[rebuild] autovacuum paused on entity_connections (full rebuild)';
  END IF;
  COMMIT;

  -- ═══ DONATIONS ARM — 16 COMMITTED WINDOWS, BOTH MODES (FIX-703/FIX-1069) ═══
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint, so the
  -- CALL-level budget never becomes an atomic multi-hour txn.
  --
  -- FIX-1069 — this is the change that matters. Before it this whole block was
  -- gated on `IF v_full`, and BOTH scheduled jobs run mode='incremental', so on
  -- prod the windowed path was unreachable code while the incremental arm ran
  -- as one 6-hour statement that banked nothing and wrote nothing.
  --
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band. reconcile_recipient_count() survives as a break-glass full
  -- recompute with NO caller and NO cron job (FIX-736 unscheduled it; the
  -- FIX-1056 comment correction records why that mattered).
  v_don_arm := CASE WHEN v_full THEN 'donations_full_windows' ELSE 'donations_incr_windows' END;

  IF NOT (v_don_arm = ANY(v_done_arms)) THEN
    v_arm_started := clock_timestamp();

    -- ── prepare ──────────────────────────────────────────────────────────────
    IF v_full THEN
      BEGIN
        PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('donations prepare: %s', SQLERRM);
        RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;
    ELSE
      -- FIX-1069 — stages the dirty set ONCE per cycle and returns the cycle
      -- target. Free on resume: an open cycle whose staging table is still
      -- populated returns immediately without rebuilding anything.
      BEGIN
        v_incr_target := public.rebuild_ec_donations_incr_prepare();
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare CANCELED: %', SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;

      -- A NULL target means no watermark has ever been set. The incremental
      -- path only touches donors present in its dirty set, so it cannot clear
      -- an edge whose donor has vanished from financial_relationships; a true
      -- bootstrap must go through the full windowed path, which range-DELETEs.
      IF v_canceled IS NULL
         AND v_incr_target IS NULL
         AND COALESCE(array_length(v_failures, 1), 0) = 0
      THEN
        v_bootstrap := true;
        v_don_arm   := 'donations_full_windows';
        RAISE WARNING '  [donations/incr] no watermark — bootstrapping via the FULL windowed path';
        BEGIN
          PERFORM public.rebuild_ec_donations_full_prepare();
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations prepare: %s', SQLERRM);
          RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
        END;
        COMMIT;
      END IF;
    END IF;

    -- ── the 16 windows ───────────────────────────────────────────────────────
    v_donations_total := 0;
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        -- ── FIX-1111 — skip a banked window BEFORE spending a unit on it ─────
        -- rebuild_ec_donations_incr_window() already returns 0 immediately for a
        -- window level with the cycle target; this hoists that same check into
        -- the driver so an already-banked window does not consume the crawl's
        -- one unit. Without it, a crawl firing that met 15 banked windows would
        -- "run" window 1 in ~0 s, count it, and exit — livelock at one useless
        -- firing every 15 minutes forever.
        --
        -- Read-only and exactly the function's own predicate, so NULL-mode
        -- behaviour is unchanged: the call it replaces returned 0 anyway.
        IF NOT v_full AND NOT v_bootstrap THEN
          SELECT (value->'windows'->>(i - 1)::text)::timestamptz
            INTO v_win_since
            FROM public.pipeline_state
           WHERE key = 'entity_connections_donations';

          IF v_win_since IS NOT NULL AND v_win_since >= v_incr_target THEN
            RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', i;
            CONTINUE;
          END IF;
        END IF;

        -- ── FIX-1111 — the unit cap ─────────────────────────────────────────
        -- Checked AFTER the skip above, so the cap is only ever spent on a
        -- window that will do real work.
        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, i);
          RAISE NOTICE '  [donations] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        -- FIX-1056 — stop at a window boundary rather than being axed mid-window.
        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          -- FIX-1069 — name the arm AND the window. The end-of-run lookup below
          -- only covers v_fns, which never contains the donations window arm.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        -- ── FIX-1101 — publish the in-flight window ────────────────────────
        -- Must be COMMITted before the window starts, or the watchdog — which
        -- runs in a different backend — cannot see it. FIX-1030's shape.
        -- clock_timestamp(), not now(): now() is transaction_timestamp() and
        -- would date the window to whenever this transaction began.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_inflight_key, jsonb_build_object(
                  'window_idx',  i,
                  'started_at',  clock_timestamp(),
                  'backend_pid', pg_backend_pid(),
                  'mode',        p_mode,
                  'log_id',      v_log_id))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now();
        COMMIT;

        v_unit_t0 := clock_timestamp();   -- FIX-1111
        v_win     := 0;                   -- FIX-1111 — so a cancel records 0 rows, not NULL

        BEGIN
          IF v_full OR v_bootstrap THEN
            v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
          ELSE
            -- p_idx is 0-based, to match the window watermark keys "0".."15".
            v_win := public.rebuild_ec_donations_incr_window(i - 1, v_lo, v_hi, v_incr_target);
          END IF;
          v_donations_total := v_donations_total + v_win;
          RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
        EXCEPTION
        -- FIX-1028 — by name, FIRST. PL/pgSQL's OTHERS matches every error
        -- EXCEPT query_canceled and assert_failure.
        WHEN query_canceled THEN
          v_canceled := format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          -- FIX-1101 — name the arm AND the window, matching what the BUDGET
          -- exit above already does. Before this, a cancelled window closed the
          -- row with next_arm = 'donations_incr_windows' and the window index
          -- only in cancel_detail, so the two exit paths described the same
          -- situation differently and next_arm alone could not tell an operator
          -- where to resume. Now that FIX-1101's watchdog makes a per-window
          -- cancel a ROUTINE outcome rather than an incident, that asymmetry
          -- would be read every week.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — CANCELED (statement_timeout or operator cancel): %', i, SQLERRM;
        WHEN OTHERS THEN
          -- Per-window catch: one bad window must not abort the rest; the run is
          -- reported `failed`.
          v_failures := v_failures || format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
        END;
        -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction —
        -- PL/pgSQL forbids COMMIT inside one). This is the point at which the
        -- window's edges AND, in incremental mode, its watermark become durable
        -- together. Neither can land without the other.
        COMMIT;

        -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────
        -- A CANCELLED window is still counted and still recorded. It spent the
        -- I/O either way, and a 1,800 s cancel against a ~346 s median is
        -- precisely the reading that should trip the backoff — that is the
        -- sensor working, not an edge case to exclude.
        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     CASE WHEN v_full OR v_bootstrap THEN 'donations_full_window'
                          ELSE 'donations_incr_window' END,
                     format('%s window %s/16', v_don_arm, i),
                     v_unit_secs, v_win,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled' ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          -- The sensor must never be able to fail the run it is measuring.
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        -- FIX-1028 — stop the sweep. The box has just proven it cannot finish
        -- one window; the remaining ones would each re-arm the same axe.
        IF v_canceled IS NOT NULL THEN
          EXIT;
        END IF;

        -- FIX-1111 — the sensor tripped. In crawl mode stop here and let the
        -- gate hold the next firings off; in NULL mode the backoff is RECORDED
        -- for the crawl to obey but does NOT change this run's behaviour, which
        -- is what "NULL = today's behaviour" has to mean.
        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;
    END IF;

    v_total := v_total + v_donations_total;
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_don_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- ── bank only a clean, complete pass over all 16 windows ─────────────────
    -- FIX-1111 — `AND NOT v_unit_capped` is load-bearing. Without it a crawl
    -- firing that ran ONE window would fall into this branch, and although
    -- rebuild_ec_donations_incr_close() correctly refuses to close a cycle
    -- whose windows still lag (FIX-1069c), the arm would still be appended to
    -- v_done_arms below — so the NEXT firing would skip the entire donations
    -- arm with 15 windows unbuilt. The cap exit is an incomplete pass and must
    -- be treated exactly like a budget exit.
    IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1069 — close the incremental cycle: drop the staging rows and set
      -- the scalar watermark. Returns false if any window still lags, which
      -- cannot happen on this branch but is checked rather than assumed.
      IF NOT v_full AND NOT v_bootstrap THEN
        BEGIN
          v_closed := public.rebuild_ec_donations_incr_close(v_incr_target);
          IF NOT v_closed THEN
            RAISE WARNING '  [donations/incr] cycle NOT closed — a window still lags the target';
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations incr close: %s', SQLERRM);
          RAISE WARNING '  [donations/incr] close FAILED: %', SQLERRM;
        END;
      END IF;

      IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
        v_done_arms := v_done_arms || v_don_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
      END IF;
      COMMIT;
    END IF;

    RAISE NOTICE '  [chunk] donations (windowed, %) — % (% edges)',
      CASE WHEN v_full THEN 'full' WHEN v_bootstrap THEN 'bootstrap' ELSE 'incremental' END,
      CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
           WHEN v_unit_capped THEN 'UNIT CAP'
           WHEN v_canceled IS NOT NULL THEN 'CANCELED'
           ELSE 'complete' END,
      v_donations_total;
  ELSE
    RAISE NOTICE '  [chunk] donations (windowed) — SKIPPED (already banked this cycle)';
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
    -- FIX-1069 — 'rebuild_entity_connections_donations' REMOVED. That entry is
    -- what routed the incremental donations arm through the generic
    -- single-statement EXECUTE below; it is now driven as 16 committed windows
    -- above. The function still exists as a break-glass single-shot.
    v_fns := ARRAY[
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
    -- FIX-1028 — a cancel in the donations windows above skips the chunks too.
    EXIT WHEN v_canceled IS NOT NULL;
    -- FIX-1056 — and so does a budget exhaustion in those windows.
    EXIT WHEN v_budget_out;
    -- FIX-1111 — and so does a unit-cap or backoff exit. Placed BEFORE the
    -- banked-arm CONTINUE so v_next_arm keeps the window index the donations
    -- exit already wrote into it, rather than being overwritten with the first
    -- outstanding chunk arm.
    EXIT WHEN v_unit_capped;

    -- FIX-1056 — resume: an arm banked earlier in this cycle is already built.
    -- Its edges are stale by at most one cadence, never missing.
    IF v_fn = ANY(v_done_arms) THEN
      RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', v_fn;
      CONTINUE;
    END IF;

    -- FIX-1111 — the unit cap, after the banked-arm skip for the same reason
    -- the window cap sits after the banked-window skip: a cap must only ever be
    -- spent on work that will actually run.
    IF v_crawl AND v_units_run >= p_max_units THEN
      v_unit_capped := true;
      v_next_arm    := v_fn;
      RAISE NOTICE '  [chunk] % — UNIT CAP reached (% unit(s)); banking and exiting', v_fn, v_units_run;
      EXIT;
    END IF;

    -- FIX-1056 — stop BEFORE starting an arm the budget cannot cover, so the
    -- exit lands on an arm boundary with the cursor and the log row intact
    -- rather than being cancelled mid-statement by the 6h axe.
    IF clock_timestamp() - v_started >= c_budget THEN
      v_budget_out := true;
      v_next_arm   := v_fn;
      RAISE WARNING '  [chunk] % — BUDGET EXHAUSTED (%s elapsed); banking % arm(s) and exiting',
        v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
        COALESCE(array_length(v_done_arms, 1), 0);
      EXIT;
    END IF;

    v_arm_started := clock_timestamp();
    v_arm_failed  := false;
    v_n           := 0;   -- FIX-1111 — so a cancelled arm records 0 rows, not NULL
    BEGIN
      EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
        INTO v_n;
      v_total := v_total + v_n;
      RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
    EXCEPTION
    -- FIX-1028 — by name; see the donations handler above.
    WHEN query_canceled THEN
      v_canceled := format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — CANCELED (statement_timeout or operator cancel): %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      v_arm_failed := true;
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;

    -- FIX-1056 — per-arm elapsed, recorded for EVERY outcome. This is the
    -- observability gap that let the 08-17 overrun be attributed to the arm the
    -- axe hit rather than the arm that spent the hours.
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- FIX-1056 — bank the arm only if it neither cancelled nor raised. A
    -- cancelled arm rolled back, so re-running it next firing is exactly right.
    IF v_canceled IS NULL AND NOT v_arm_failed THEN
      v_done_arms := v_done_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
    END IF;

    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    -- Also the point at which the arm AND its cursor become durable together.
    COMMIT;

    -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────────
    v_units_run := v_units_run + 1;
    v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_arm_started));
    BEGIN
      v_rec := public.ec_crawl_record_unit(
                 v_fn, v_fn, v_unit_secs, v_n,
                 CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                      WHEN v_arm_failed          THEN 'failed'
                      ELSE 'ok' END);
      IF (v_rec->>'backoff_set')::boolean THEN
        v_backoff_set := true;
      END IF;
      v_unit_log := v_unit_log || jsonb_build_array(v_rec);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
    END;
    COMMIT;

    IF v_canceled IS NOT NULL THEN
      EXIT;
    END IF;

    -- FIX-1111 — sensor tripped; crawl mode stops, NULL mode carries on.
    IF v_crawl AND v_backoff_set THEN
      v_unit_capped := true;
      EXIT;
    END IF;
  END LOOP;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;

  -- ── FIX-1056 — cycle bookkeeping ───────────────────────────────────────────
  -- FIX-1069 — the donations WINDOW arm is in v_fns in neither mode, so it has
  -- to be named explicitly here. Without this, a run whose donations windows
  -- never banked could compute v_next_arm = NULL and sit one gate away from
  -- reporting 'complete'. Only computed when nothing already claimed it — a
  -- budget exit sets it with the window index attached.
  IF v_next_arm IS NULL THEN
    IF NOT (v_don_arm = ANY(v_done_arms)) THEN
      v_next_arm := v_don_arm;
    ELSE
      -- WITH ORDINALITY because unnest() ordering is not contractually
      -- guaranteed and "first outstanding arm" has to mean first in ARM ORDER,
      -- not first returned.
      SELECT f INTO v_next_arm
        FROM unnest(v_fns) WITH ORDINALITY AS u(f, ord)
       WHERE NOT (u.f = ANY(v_done_arms))
       ORDER BY u.ord
       LIMIT 1;
    END IF;
  END IF;

  IF v_next_arm IS NULL
     AND v_canceled IS NULL
     AND NOT v_budget_out
     AND COALESCE(array_length(v_failures, 1), 0) = 0
  THEN
    -- Every arm banked AND the pass was clean: the cycle is closed, so the
    -- cursor must not survive to make the NEXT firing skip everything.
    -- Deliberately also gated on v_failures: the donations windows can fail
    -- without being banked while every v_fns arm succeeds, which would
    -- otherwise clear the cursor on a run that still owes work. Leaving the
    -- cursor is safe either way — each arm is an idempotent DELETE-then-INSERT
    -- over its own connection_type — but clearing it on a failed pass would
    -- throw away the record of what still needs redoing.
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

  -- ── FIX-1101 — the belt-and-braces clear (playbook C3) ────────────────────
  -- Unconditional, and NOT gated on this run having published anything: this is
  -- the "put it where it can FIRE" backstop, and it must be able to clean up
  -- state this run did not create. Reached on every software exit from the
  -- procedure — convergence, budget exit, a caught cancel, per-arm failures.
  -- Only a hard terminate or a crash skips it, and that case is the watchdog's.
  DELETE FROM public.pipeline_state WHERE key = c_inflight_key;
  COMMIT;

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE
                        -- FIX-1028 — a cancelled run is PARTIAL: the edges it did
                        -- commit are real, but the sweep did not cover everything.
                        WHEN v_canceled IS NOT NULL THEN 'partial'
                        -- FIX-1056 — a budget exit is also PARTIAL, and unlike a
                        -- cancel it is an ORDERLY stop with a resumable cursor.
                        WHEN v_budget_out THEN 'partial'
                        -- FIX-1111 — so is a unit-cap exit, and it is the crawl's
                        -- NORMAL outcome rather than an incident. It must still be
                        -- 'partial' (work remains), but `unit_capped` in metadata
                        -- is what distinguishes ~96 routine crawl exits a day from
                        -- the budget exhaustions FIX-969 counts.
                        WHEN v_unit_capped THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        -- FIX-1056 — arms left unrun without a cancel or a budget
                        -- exit can only mean a failure skipped them; never claim
                        -- 'complete' while v_next_arm is non-NULL.
                        WHEN v_next_arm IS NOT NULL THEN 'partial'
                        ELSE 'complete'
                      END,
      -- clock_timestamp(), not now(): now() is transaction_timestamp() and this
      -- transaction began after the last chunk's COMMIT (FIX-979 / FIX-972).
      completed_at  = clock_timestamp(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s%s', v_canceled,
                                 CASE WHEN v_next_arm IS NOT NULL
                                      THEN format('; resumable at arm %s', v_next_arm)
                                      ELSE '' END,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN v_budget_out
                          -- +1 on the arm count: the donations window arm is
                          -- bankable but is not a member of v_fns.
                          THEN left(format('budget exhausted — resumable at arm %s (%s of %s arms banked)',
                                 COALESCE(v_next_arm, '?'),
                                 COALESCE(array_length(v_done_arms, 1), 0),
                                 COALESCE(array_length(v_fns, 1), 0) + 1), 1000)
                        -- FIX-1111 — an ORDERLY, expected stop. Worded so it can
                        -- never be mistaken for a budget blowout in a grep.
                        WHEN v_unit_capped
                          THEN left(format('unit cap reached — %s unit(s) run%s; resumable at arm %s',
                                 v_units_run,
                                 CASE WHEN v_backoff_set THEN ' then BACKOFF tripped' ELSE '' END,
                                 COALESCE(v_next_arm, '?')), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- FIX-1056
                        'budget_exhausted', v_budget_out,
                        'arm_timings', v_arm_timings,
                        'arms_banked', to_jsonb(v_done_arms),
                        'next_arm', v_next_arm,
                        'cycle_started_at', v_cycle_started,
                        -- FIX-1069 — the donations cycle target this run drove
                        -- its windows toward, so a partial run's remaining work
                        -- is readable from the log row alone.
                        'donations_target_at', v_incr_target,
                        'donations_bootstrap', v_bootstrap,
                        -- FIX-1111
                        'crawl', v_crawl,
                        'max_units', p_max_units,
                        'units_run', v_units_run,
                        'unit_capped', v_unit_capped,
                        'backoff_tripped', v_backoff_set,
                        'units', v_unit_log
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures), % arm(s) banked, % unit(s), next=%',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
         WHEN v_unit_capped THEN 'UNIT CAP'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0),
    COALESCE(array_length(v_done_arms, 1), 0), v_units_run, COALESCE(v_next_arm, '(none)');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

COMMENT ON PROCEDURE public.run_entity_connections_rebuild(text, int) IS
  'Rebuilds entity_connections arm by arm. FIX-1056: 5h wall-clock budget '
  'checked at arm boundaries, per-arm banking into '
  'pipeline_state.entity_connections_rebuild_cursor, per-arm timings. '
  'FIX-1069: the donations arm is driven as 16 COMMITted windows in BOTH modes. '
  'FIX-1071 adds the outside bound this internal budget cannot provide for a '
  'single arm. FIX-1101: publishes the in-flight window to '
  'pipeline_state.entity_connections_window_inflight so '
  'enforce_ec_window_budget() can bound ONE window, and DEFERS the whole run '
  'when a FEC bulk run is live or pending resume. '
  'FIX-1111 — p_max_units: NULL is byte-for-byte the pre-1111 behaviour; N runs '
  'at most N PENDING units (one donations window, or one non-donations arm) and '
  'exits ''partial'' with unit_capped=true and a resumable cursor. This is what '
  'makes the ec-crawl job possible: one bounded unit every 15 minutes, paced so '
  'aggregate spend stays under the box''s I/O refill rate instead of bursting '
  'through the whole daily budget in 75 minutes (FIX-1107). Already-banked '
  'windows and arms are skipped WITHOUT consuming a unit, or the crawl would '
  'livelock. Every unit feeds ec_crawl_record_unit() in every mode; the gate '
  '(backoff / blackout / cycle cooldown) is enforced in crawl mode only.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The crawl job — created INACTIVE.
--
--    Phase 4 activates it by hand in the quiet window Craig names, together
--    with pausing jobid 2 by NAME. Creating it live here would start a */15
--    writer the moment the migration lands, which is exactly the class of
--    surprise this whole line of work exists to remove.
--
--    Schedule is literal `*/15`, NOT read from ec_crawl.cadence_minutes: a
--    pg_cron schedule cannot be a query. cadence_minutes is the RECORD of what
--    the schedule is meant to be, and the drain wrapper's pacing reads it;
--    changing the cadence means cron.alter_job AND updating that key.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'ec-crawl';

  IF v_jobid IS NULL THEN
    -- schedule() creates it ACTIVE; immediately park it.
    v_jobid := cron.schedule(
      'ec-crawl',
      '*/15 * * * *',
      $cmd$CALL public.run_entity_connections_rebuild('incremental', p_max_units := 1);$cmd$);
    PERFORM cron.alter_job(v_jobid, active := false);
    RAISE NOTICE '[FIX-1111] ec-crawl created as jobid % and parked INACTIVE (Phase 4 activates it)', v_jobid;
  ELSE
    RAISE NOTICE '[FIX-1111] ec-crawl already exists as jobid % (active=%) — left alone',
      v_jobid, (SELECT active FROM cron.job WHERE jobid = v_jobid);
  END IF;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The FIX-1071 outside budget for the crawl.
--
--    1,800 s — the OUTSIDE bound, deliberately equal to FIX-1101's per-window
--    inside bound rather than tighter. The inside bound should always fire
--    first for a slow window; this one exists for the case the inside bound
--    cannot cover, namely a slow NON-donations arm (nothing publishes an
--    in-flight row for those) or a driver wedged outside any window.
--
--    Sized off measurement, not the cron expression (playbook D2): the most
--    expensive single unit on record is `_external` at 878 s (prod 08-26
--    arm_timings), and the most expensive window is ~346 s nominal / 1,902 s
--    at its worst observed (the FIX-1110 drain's window 13). 1,800 s clears
--    the honest cases and catches the pathological one.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES ('ec-crawl', 1800,
        'FIX-1111 — one EC unit per firing at */15. Outside bound; FIX-1101''s '
        'per-window watchdog is the inside one and should fire first. Sized '
        'off measured unit costs: max arm _external 878s, nominal window 346s.')
ON CONFLICT (jobname) DO UPDATE
  SET budget_seconds = EXCLUDED.budget_seconds,
      note           = EXCLUDED.note,
      updated_at     = now();
