-- 20261004010000_fix1177_1172_freshness_honours_holds.sql
-- FIX-1177 + FIX-1172 — check_rollup_freshness() honours a FIX-950 hold, and
-- restarts its clock at a deliberate stand-down.
--
-- ── WHAT WAS LEFT ───────────────────────────────────────────────────────────
-- cc-133 built the hold: claimProdSession() upserts rollup_watch_overrides
-- (held_since, hold_reason) for the guarded set and clears it on release, and
-- list_scheduled_rollup_pipelines() already NULLs report_after_hours /
-- escalate_after_hours while a pipeline is held. Two readings stayed wrong:
--
--   (a) FIX-1177 — check_rollup_freshness(), the per-pipeline verdict behind
--       check_rollup_freshness_batch() and every caller of either, read nothing
--       from rollup_watch_overrides. A held (or retired) pipeline answered
--       stale = true on its own clock; only the canary's registry gate kept it
--       from being reported.
--   (b) FIX-1172 — on RELEASE the hold is cleared but last_complete_at is still
--       pre-hold, so a session longer than the cadence x 1.5 reads stale
--       (x 2.5 escalates) until the next complete. For
--       financial_entity_totals_refresh (cadence 0.50 h, prod 2026-10-04 01:48
--       UTC: report 0.8 h, escalate 1.3 h) that is any hold over ~48 min.
--
-- ── THE SHAPE ───────────────────────────────────────────────────────────────
--   status   NEW key: 'retired' | 'held' | 'missing' | 'stale' | 'fresh'.
--            retired_at IS NOT NULL → 'retired'; held_since IS NOT NULL →
--            'held'; both force stale = false (the registry's rule, mirrored).
--            'missing' = no complete row ever (stale stays true, as before).
--   hold_reason, held_since   NEW keys, from rollup_watch_overrides.
--   hours_since_complete / stale   measured from
--            GREATEST(last complete's completed_at, newest held skip's
--            started_at), where a held skip is a status = 'skipped' row whose
--            metadata->>'skip_reason' starts 'prod session held: ' (the FIX-950
--            guard procedures' and the nightly's one spelling) AND that started
--            after the last complete. A deliberate stand-down is "the job looked
--            and chose not to run"; the clock restarts from that look. A skip
--            older than the last complete changes nothing, and with no complete
--            at all a skip does not invent one.
--   hours_since_data   NEW key — the OLD number (hours since the last complete),
--            so the data-staleness truth is never hidden.
--   last_held_skip_at  NEW key — the skip the clock restarted from, or NULL.
--
-- A skip is still never a closure: last_complete_at is unchanged, and
-- list_scheduled_rollup_pipelines()' cadence still reads only 'complete'
-- (FIX-1135/FIX-1140). Thresholds (1.5x / 2.5x cadence) are unchanged.
--
-- check_rollup_freshness_batch() is NOT redefined: it is a CROSS JOIN LATERAL
-- over this function and passes every key through by construction (the guard at
-- the bottom proves it). list_scheduled_rollup_pipelines() is NOT redefined: it
-- already honours held/retired and carries no clock. Both prod bodies read
-- 2026-10-04 01:47 UTC — 0 differing lines against their files.
--
-- rule 34 — prod's body (0 lines differ from 20260903060000_fix973b) +42/−4 by
-- diff of pg_get_functiondef: the four removed lines are the
-- hours_since_complete expression and the three-line COALESCE stale test, which
-- now read the clock / verdict CTEs; every other line of prod's body is kept. Header unchanged: LANGUAGE sql STABLE, SECURITY INVOKER,
-- SET search_path TO 'public' (its only SET — FIX-1128: no statement_timeout).
-- Grants re-stated: service_role only (service_role holds SELECT on
-- rollup_watch_overrides, prod read 01:49 UTC).
--
-- Cross-ref FIX-950, FIX-1135, FIX-1140, FIX-1148, FIX-1011, FIX-973.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.check_rollup_freshness(
  p_pipeline text DEFAULT 'donor_rollup_refresh'::text,
  p_max_age_hours integer DEFAULT 48)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH last_good AS (
    SELECT started_at, completed_at, status, metadata
    FROM public.data_sync_log
    WHERE pipeline = p_pipeline AND status = 'complete'
    ORDER BY started_at DESC LIMIT 1
  ),
  last_any AS (
    SELECT started_at, completed_at, status, error_message, metadata
    FROM public.data_sync_log
    WHERE pipeline = p_pipeline
    ORDER BY started_at DESC LIMIT 1
  ),
  -- FIX-1172 — the newest FIX-950 stand-down SINCE the last complete. Bounded
  -- by that complete, so the (pipeline, started_at DESC) index walks only the
  -- rows after it.
  last_held_skip AS (
    SELECT max(l.started_at) AS started_at
    FROM public.data_sync_log l, last_good g
    WHERE l.pipeline = p_pipeline
      AND l.status = 'skipped'
      AND l.metadata->>'skip_reason' LIKE 'prod session held: %'
      AND l.started_at > g.completed_at
  ),
  clock AS (
    SELECT GREATEST((SELECT completed_at FROM last_good),
                    (SELECT started_at   FROM last_held_skip)) AS at
    WHERE EXISTS (SELECT 1 FROM last_good)
  ),
  -- FIX-1177 — the same declarations list_scheduled_rollup_pipelines() reads.
  ov AS (
    SELECT held_since, hold_reason, retired_at
    FROM public.rollup_watch_overrides
    WHERE pipeline = p_pipeline
  ),
  verdict AS (
    SELECT CASE
             WHEN (SELECT retired_at FROM ov) IS NOT NULL THEN 'retired'
             WHEN (SELECT held_since FROM ov) IS NOT NULL THEN 'held'
             WHEN NOT EXISTS (SELECT 1 FROM last_good)    THEN 'missing'
             WHEN (SELECT at FROM clock) < NOW() - make_interval(hours => p_max_age_hours)
                                                          THEN 'stale'
             ELSE 'fresh'
           END AS status
  )
  SELECT jsonb_build_object(
    'pipeline',            p_pipeline,
    'max_age_hours',       p_max_age_hours,
    'last_complete_at',    (SELECT completed_at FROM last_good),
    'hours_since_complete',
      ROUND(EXTRACT(epoch FROM (NOW() - (SELECT at FROM clock))) / 3600.0, 2),
    'stale',
      (SELECT status FROM verdict) IN ('missing', 'stale'),
    -- FIX-1177/1172 — the verdict as a word, the hold that produced it, and the
    -- un-restarted clock so a deliberate stand-down never hides data age.
    'status',              (SELECT status FROM verdict),
    'hold_reason',         (SELECT hold_reason FROM ov),
    'held_since',          (SELECT held_since  FROM ov),
    'hours_since_data',
      ROUND(EXTRACT(epoch FROM (NOW() - (SELECT completed_at FROM last_good))) / 3600.0, 2),
    'last_held_skip_at',   (SELECT started_at FROM last_held_skip),
    'last_status',         (SELECT status        FROM last_any),
    'last_started_at',     (SELECT started_at    FROM last_any),
    'last_error',          (SELECT error_message FROM last_any),
    'last_metadata',       (SELECT metadata      FROM last_any),
    -- A sweep parked mid-flight is NOT a failure — it is the FIX-944 partial
    -- path working. Surface it so "converging over N nights" is visible and
    -- distinguishable from "wedged".
    -- FIX-973 — derived from p_pipeline's OWN last row. Was a hard-wired read
    -- of pipeline_state.donor_rollup_watermark, which answered about the donor
    -- rollup no matter which pipeline was asked about, and which the bulk
    -- regime does not write a cursor into at all.
    'sweep_in_progress',
      COALESCE(
        (SELECT status = 'partial'
                AND COALESCE((metadata->>'resumable')::boolean, false)
           FROM last_any),
        false),
    'sweep_cursor',
      (SELECT COALESCE(metadata->>'resume_at_chunk',
                       metadata->>'sweep_cursor',
                       metadata->>'resume_cursor')
         FROM last_any)
  );
$function$;

REVOKE ALL ON FUNCTION public.check_rollup_freshness(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rollup_freshness(text, integer) TO service_role;

-- Guard (FIX-1148's, re-run): the batch must still agree with the loop, element
-- for element, now that the element carries the new keys. Clock readings move
-- between two calls, so compare everything that is a verdict.
DO $$
DECLARE
  v_items jsonb;
  v_batch jsonb;
  v_one   jsonb;
  v_n     int;
  r       record;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('pipeline', pipeline, 'cadence_hours', 48)), '[]'::jsonb)
    INTO v_items
  FROM (SELECT DISTINCT pipeline FROM public.data_sync_log
         WHERE started_at > NOW() - interval '30 days'
         ORDER BY 1 LIMIT 60) s;

  v_n := jsonb_array_length(v_items);
  IF v_n = 0 THEN
    RAISE NOTICE '[fix1177] no pipelines in the lookback — parity check skipped';
    RETURN;
  END IF;

  v_batch := public.check_rollup_freshness_batch(v_items);
  IF jsonb_array_length(v_batch) <> v_n THEN
    RAISE EXCEPTION '[fix1177] batch returned % elements for % items', jsonb_array_length(v_batch), v_n;
  END IF;

  FOR r IN SELECT (e.value->>'pipeline') AS pipeline, (e.ord - 1)::int AS idx
             FROM jsonb_array_elements(v_items) WITH ORDINALITY AS e(value, ord)
  LOOP
    v_one := public.check_rollup_freshness(r.pipeline, 48);
    IF NOT (v_one ? 'status') THEN
      RAISE EXCEPTION '[fix1177] check_rollup_freshness(%) carries no status key', r.pipeline;
    END IF;
    IF (v_batch -> r.idx) - 'hours_since_complete' - 'hours_since_data'
         IS DISTINCT FROM v_one - 'hours_since_complete' - 'hours_since_data' THEN
      RAISE EXCEPTION '[fix1177] batch and loop disagree for %: % vs %', r.pipeline, v_batch -> r.idx, v_one;
    END IF;
  END LOOP;

  RAISE NOTICE '[fix1177] batch matches the loop on all % pipelines, each with a status', v_n;
END $$;

COMMIT;
