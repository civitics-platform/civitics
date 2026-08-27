-- =============================================================================
-- FIX-1111b — the backoff sensor compares THROUGHPUT, not raw duration.
--
-- ═══ THE DEFECT, AND HOW PROD SURFACED IT ══════════════════════════════════
-- FIX-1111 shipped the sensor as specified: trip when a unit runs >=
-- backoff_multiple x the rolling MEDIAN DURATION for its unit class. That
-- assumes a unit class has a characteristic cost. Measured against prod
-- immediately before Phase 4, it does not:
--
--   * the ~346 s/window figure the design was sized on comes from the 08-24
--     run, whose cycle staged **565,810 dirty donors** — 35,363 per window;
--   * prod's dirty set at 2026-08-27 01:11 UTC is **2,733 rows / 2,518
--     donors** — **157 per window**, i.e. ~225x smaller.
--
-- Window duration scales with dirty-set size, so the same healthy window is a
-- ~3 s unit on a quiet day and a ~346 s unit after a bulk FEC replay.
--
-- THE FAILURE THAT WOULD HAVE FOLLOWED, in order:
--   1. the first cycle after activation writes ~16 `donations_incr_window`
--      samples at ~3 s into an empty ring, anchoring the median at ~3 s;
--   2. the first cycle after a large ingest hits a genuinely healthy 346 s
--      window; 346 >= 2 x 3 trips the backoff;
--   3. the crawl exits after ONE unit and gates itself off for 2 h;
--   4. it re-trips every firing, because one expensive sample cannot move a
--      median dominated by sixteen cheap ones — so it keeps re-tripping until
--      expensive samples OUTNUMBER cheap ones in the ring, roughly a day and a
--      half at one unit per two hours.
--
-- That fires **exactly after a large replay**, which is the Monday case
-- FIX-1111 exists to handle. It would have converted the fix into its own
-- worst scenario.
--
-- NO CONFIG VALUE RESCUES IT. Tolerating a 115x scale change means setting
-- backoff_multiple past 115, which also blinds the sensor to the 10-40x
-- slowdown a real throttle produces — the only thing it is for.
--
-- ═══ THE FIX — RATE, WHICH IS SCALE-INVARIANT ══════════════════════════════
-- Compare seconds per 1,000 rows, not seconds:
--
--     346 s / 150,000 edges  ->  2.31 s/krow
--       3 s /   1,300 edges  ->  2.31 s/krow     <- same healthy box
--
-- and it matches the physical claim the sensor rests on more directly than
-- duration ever did. The 08-25 throttle receipt is a THROUGHPUT collapse: jobid
-- 13's chunk went ~3 s -> >1,680 s **for the same 500 entities**. Rate catches
-- that at ~560x while raw duration catches it only if the box happened to be
-- busy when the median was built.
--
-- TWO INDEPENDENT TRIPS, because rate cannot see everything:
--
--   1. RATE  — s/krow >= backoff_multiple x the median rate for this class,
--      over at least backoff_min_samples prior samples. Only samples with
--      rows >= backoff_min_rows count toward the median, and only a unit with
--      rows >= backoff_min_rows is judged by it: s/krow on a 12-row unit is
--      noise, not signal.
--
--   2. ABSOLUTE — seconds >= backoff_abs_seconds (default 1,500 s), whatever
--      the rate says. This is the backstop for the case rate is blind to, and
--      it is not hypothetical: a CANCELLED window records rows = 0, so the
--      1,902 s runaway that took the box into connection starvation on
--      2026-08-26 (FIX-1110) would be invisible to rule 1 and is caught here.
--      1,500 s sits under FIX-1101's 1,800 s per-window bound so the sensor
--      reacts before the watchdog has to.
--
-- Cross-ref FIX-1111 (the crawl), FIX-1107 (the throttle receipt this is
-- calibrated on), FIX-1101 (the 1,800 s window bound), FIX-1110 (the 1,902 s
-- zero-row runaway), FIX-1069 (why dirty-set size varies by orders of magnitude).
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add the two new knobs WITHOUT clobbering anything already tuned.
--
--    `defaults || value` puts the existing row on the RIGHT, so a key already
--    present wins and only genuinely-missing keys are filled in.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.pipeline_state
   SET value = jsonb_build_object(
                 'backoff_min_rows',    1000,
                 'backoff_abs_seconds', 1500)
               || value,
       updated_at = now()
 WHERE key = 'ec_crawl';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The sensor.
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
  v_minrows  bigint;
  v_abs      numeric;
  v_hours    numeric;
  v_rows     bigint;
  v_rate     numeric;
  v_ratable  boolean;
  v_trip     boolean := false;
  v_reason   text    := NULL;
  v_until    timestamptz;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'ec_crawl';
  v_cfg  := COALESCE(v_cfg, '{}'::jsonb);
  v_ring := COALESCE(v_cfg->'recent_units', '[]'::jsonb);

  v_mult    := COALESCE((v_cfg->>'backoff_multiple')::numeric, 2.0);
  v_minn    := COALESCE((v_cfg->>'backoff_min_samples')::int, 5);
  v_minrows := COALESCE((v_cfg->>'backoff_min_rows')::bigint, 1000);
  v_abs     := COALESCE((v_cfg->>'backoff_abs_seconds')::numeric, 1500);
  v_hours   := COALESCE((v_cfg->>'backoff_hours')::numeric, 2);

  v_rows    := GREATEST(COALESCE(p_rows, 0), 0);
  -- Seconds per 1,000 rows. NULL when the unit is too small to rate honestly —
  -- a rate computed off 12 rows is noise and must not enter the median either.
  v_ratable := v_rows >= v_minrows;
  v_rate    := CASE WHEN v_ratable THEN p_seconds * 1000.0 / v_rows END;

  -- Median RATE over PRIOR ratable samples of this class only. The new unit
  -- must not raise the bar it is judged against.
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.value->>'rate')::numeric),
         count(*)
    INTO v_median, v_samples
    FROM jsonb_array_elements(v_ring) e
   WHERE e.value->>'unit_class' = p_unit_class
     AND (e.value->>'rate') IS NOT NULL;

  -- ── Trip 1: throughput ────────────────────────────────────────────────────
  IF v_ratable AND v_samples >= v_minn AND v_median > 0
     AND v_rate >= v_mult * v_median THEN
    v_trip   := true;
    v_reason := format('throughput %s s/krow vs median %s over %s samples',
                       round(v_rate, 3), round(v_median, 3), v_samples);
  END IF;

  -- ── Trip 2: absolute duration (catches what rate is blind to) ─────────────
  IF NOT v_trip AND p_seconds >= v_abs THEN
    v_trip   := true;
    v_reason := format('absolute duration %s s >= %s s', round(p_seconds)::int, round(v_abs)::int);
  END IF;

  IF v_trip THEN
    v_until := clock_timestamp() + make_interval(secs => v_hours * 3600);
  END IF;

  v_entry := jsonb_build_object(
    'unit',       p_unit,
    'unit_class', p_unit_class,
    'seconds',    round(p_seconds, 1),
    'rows',       v_rows,
    -- NULL for sub-threshold units, which is what keeps them out of the median.
    'rate',       CASE WHEN v_ratable THEN round(v_rate, 4) END,
    'outcome',    p_outcome,
    'at',         clock_timestamp(),
    -- The class the burst ledger reads. Rate-based where rate exists, so it
    -- stays meaningful as dirty-set size swings by orders of magnitude.
    'iops_class', CASE
                    WHEN v_trip                                      THEN 'degraded'
                    WHEN NOT v_ratable AND p_seconds < 30            THEN 'trivial'
                    WHEN NOT v_ratable                               THEN 'short'
                    WHEN p_seconds >= 120                            THEN 'sustained_writer'
                    ELSE 'short'
                  END,
    'median_rate_at_time', CASE WHEN v_samples >= v_minn THEN round(v_median, 4) END);

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
    RAISE WARNING '[ec-crawl] unit % (%) tripped backoff — % — backing off until %',
      p_unit, p_unit_class, v_reason, v_until;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('ec_crawl', v_cfg)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object(
    'recorded',      true,
    'unit',          p_unit,
    'seconds',       round(p_seconds, 1),
    'rows',          v_rows,
    'rate',          CASE WHEN v_ratable THEN round(v_rate, 4) END,
    'median_rate',   CASE WHEN v_samples >= v_minn THEN round(v_median, 4) END,
    'samples',       v_samples,
    'backoff_set',   v_trip,
    'backoff_reason', v_reason,
    'backoff_until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.ec_crawl_record_unit(text, text, numeric, bigint, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ec_crawl_record_unit(text, text, numeric, bigint, text) IS
  'FIX-1111b — records one completed unit into pipeline_state.ec_crawl.recent_units '
  '(bounded ring of 50) and trips backoff_until on EITHER of two independent '
  'rules: (1) THROUGHPUT — seconds-per-1000-rows >= backoff_multiple x the '
  'rolling median rate for this unit class, over >= backoff_min_samples prior '
  'samples, counting only units with rows >= backoff_min_rows; (2) ABSOLUTE — '
  'seconds >= backoff_abs_seconds (1500s, under FIX-1101''s 1800s window bound), '
  'which is what catches a cancelled or hung unit that records rows = 0 and is '
  'therefore invisible to rule 1. FIX-1111 compared raw DURATION and was wrong: '
  'window duration scales with dirty-set size (prod 08-24 staged 565,810 dirty '
  'donors = 35,363/window = ~346s; prod 08-27 staged 2,518 = 157/window = ~3s), '
  'so a median built on quiet days would have tripped on every healthy window '
  'after a bulk replay and throttled the crawl to one unit per two hours — in '
  'exactly the post-replay scenario the crawl exists to handle. Rate is '
  'scale-invariant and matches the physical claim: the 08-25 throttle was a '
  'throughput collapse (~3s -> >1680s for the SAME 500 entities).';

NOTIFY pgrst, 'reload schema';
