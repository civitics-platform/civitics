-- ============================================================================
-- FIX-973 (freshness leg) — check_rollup_freshness() stops reading one
-- hard-wired pipeline_state key and derives `sweep_in_progress` from the
-- pipeline it was actually asked about.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
-- The function takes `p_pipeline` and answers about it in every field but two.
-- Those two read a literal:
--
--     'sweep_in_progress',
--       (SELECT (value ? 'sweep_cursor') FROM public.pipeline_state
--         WHERE key = 'donor_rollup_watermark'),
--     'sweep_cursor',
--       (SELECT value->>'sweep_cursor' FROM public.pipeline_state
--         WHERE key = 'donor_rollup_watermark'),
--
-- regardless of p_pipeline. Three consequences, in ascending order of how much
-- they cost:
--
--   * Every OTHER pipeline in the registry — and since FIX-977 the registry is
--     derived from the schedule, so there are a dozen — gets donor-rollup's
--     sweep state stapled to its freshness row. entity_connections_rebuild
--     reads "sweep in flight" because the donor rollup has a cursor.
--
--   * For donor_rollup_refresh itself, the answer is about to become simply
--     wrong. FIX-973 moves jobid 24 onto donor_rollup_rebuild_bulk(), which
--     keeps its cursor in `donor_rollup_bulk_sweep`, not in
--     `donor_rollup_watermark`. A bulk sweep parked mid-flight would report
--     sweep_in_progress=false — the exact annotation the canary uses to tell
--     "converging over several nights" from "wedged".
--
--   * It is the FIX-992 masking path. `last_good` counts only
--     status='complete', so a pipeline that parks 'partial' on every firing has
--     a freshness clock that does not move; `sweep_in_progress` was the one
--     signal that said "this is the resumable path working, not a stall", and
--     it was reading a key rather than the pipeline.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Read the pipeline's own last row. A sweep is in progress iff that row is
-- 'partial' AND declares itself resumable — which is exactly the contract both
-- writers already emit (`metadata.resumable = true`, set by the budget-hit and
-- cancelled branches of refresh_official_donor_rollup_incremental() and
-- donor_rollup_rebuild_bulk()). The cursor is whichever of the three shapes
-- that writer uses, in order of specificity:
--
--     resume_at_chunk   both regimes' chunk index (FIX-973 adds it to bulk)
--     sweep_cursor      pipelines that name it that way
--     resume_cursor     the incremental's uuid recipient cursor
--
-- RETURN SHAPE IS UNCHANGED — same eleven keys, same types. packages/data's
-- canary-check.ts reads sweep_in_progress as an annotation and never escalates
-- on it, donor-rollup-sweep.ts prints it, and detector-coverage.test.ts asserts
-- the shape; none of them need to change, and that is deliberate.
--
-- `last_good` is NOT touched. A 'partial' row still does not count as a
-- completion, which is correct: the rollup genuinely has not converged. The
-- point of this fix is that the ANNOTATION now tells the truth about why.
--
-- STABLE, not IMMUTABLE, and it stays SQL — it reads two tables.
-- Grants preserved: postgres + service_role only (prod proacl checked before
-- the rewrite), no anon/authenticated.
--
-- Cross-ref FIX-944 (the function), FIX-977 (the derived registry that made the
-- hard-wiring visible), FIX-992, FIX-1135/FIX-1059 (the gating around it).
--
-- Fixes: FIX-973
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
  )
  SELECT jsonb_build_object(
    'pipeline',            p_pipeline,
    'max_age_hours',       p_max_age_hours,
    'last_complete_at',    (SELECT completed_at FROM last_good),
    'hours_since_complete',
      ROUND(EXTRACT(epoch FROM (NOW() - (SELECT completed_at FROM last_good))) / 3600.0, 2),
    'stale',
      COALESCE(
        (SELECT completed_at FROM last_good) < NOW() - make_interval(hours => p_max_age_hours),
        true),
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

COMMIT;
