-- FIX-977 — the rollup watch list becomes DERIVED instead of hand-maintained.
--
-- THE DEFECT WAS ONE LITERAL. packages/data/src/scripts/canary-check.ts had:
--     const ROLLUP_PIPELINES = [{ pipeline: "donor_rollup_refresh", maxAgeHours: 48 }];
-- length 1. The RPC it calls, check_rollup_freshness(p_pipeline), is fully
-- generic — the narrowing was purely the caller's array. Measured on prod
-- 2026-08-07: four UNWATCHED pipelines were 1.1-2.4 cadence cycles behind,
-- including financial_entity_totals_refresh at 403.8 h (it renders
-- total_donated_cents / total_received_cents on every donor and
-- financial-entity page) and entity_connections_rebuild at 212.8 h (the graph).
-- The one entry on the list was the FRESHEST of the five.
--
-- Playbook D4 signature B / E5: a detector covers only what it enumerates. So
-- "add four more entries" is not the fix — it is the same defect with a later
-- expiry date. This function derives the enumeration from the schedule itself,
-- so a new pg_cron rollup joins the watch list on its first run with no code
-- change, and canary-check.ts's array becomes a fallback rather than the truth.
--
-- HOW THE DERIVATION WORKS (all three steps mechanical, none hand-listed):
--
--   1. CENSUS. Every distinct data_sync_log.pipeline that has ever written a
--      row with metadata->>'source' = 'pg_cron'. That is the set of scheduled
--      derived-data pipelines, by construction. On prod today it is 13; the
--      canary watched 1.
--
--   2. CORRELATION. Match each pipeline to its pg_cron job by START-TIME
--      PROXIMITY — a procedure writes its data_sync_log 'running' row within
--      seconds of pg_cron writing the job_run_details row. The command text
--      cannot be used: jobid 13 runs
--      `CALL public.refresh_financial_entity_totals_incremental()` and the
--      pipeline it writes is named `financial_entity_totals_refresh`. Ties are
--      broken by hit count over the retained window, so a one-off coincidence
--      cannot outvote the real owner.
--
--   3. CADENCE. Parsed from the job's own cron expression, falling back to the
--      observed median gap between runs when the expression uses step or range
--      syntax this parser deliberately does not guess at.
--
-- ESCALATE-VS-REPORT (FIX-943 cause-vs-consequence split, and the reason this
-- does not page every Tuesday): one cadence cycle late REPORTS, two-plus
-- ESCALATES. A weekly job that slips a single firing is noise; one that has
-- missed two in a row is a fact about prod that stays broken until someone
-- acts.

-- ---------------------------------------------------------------------------
-- Cadence of a standard 5-field cron expression, in hours.
-- Returns NULL for step (*/n) or range (a-b) syntax rather than guessing — a
-- NULL sends the caller to the observed-gap fallback, which is the safe
-- direction for a number that sets an alerting threshold.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cron_cadence_hours(p_schedule text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  WITH f AS (
    SELECT split_part(p_schedule, ' ', 1) AS mn,
           split_part(p_schedule, ' ', 2) AS hr,
           split_part(p_schedule, ' ', 3) AS dom,
           split_part(p_schedule, ' ', 5) AS dow
  ),
  n AS (
    SELECT
      -- Firings per day = (minutes selected per hour) x (hours selected per day).
      -- '*' means every value in the field, so it contributes 60 and 24.
      CASE WHEN mn = '*' THEN 60
           ELSE GREATEST(array_length(string_to_array(mn, ','), 1), 1) END
      *
      CASE WHEN hr = '*' THEN 24
           ELSE GREATEST(array_length(string_to_array(hr, ','), 1), 1) END AS per_day,
      CASE WHEN dow = '*' THEN NULL
           ELSE GREATEST(array_length(string_to_array(dow, ','), 1), 1) END AS n_dow,
      CASE WHEN dom = '*' THEN NULL
           ELSE GREATEST(array_length(string_to_array(dom, ','), 1), 1) END AS n_dom
    FROM f
  )
  SELECT CASE
    -- No schedule at all (an uncorrelated pipeline) must return NULL, NOT fall
    -- through to the daily branch. Without this guard split_part(NULL,...) makes
    -- every unmatched pipeline look like a 24h job: validated against prod,
    -- `recipient_count_reconcile` was assigned a fabricated 24h cadence and
    -- escalated at 811.9h against a threshold it never actually had.
    WHEN p_schedule IS NULL OR btrim(p_schedule) = '' THEN NULL
    -- Step (*/n) or range (a-b) syntax ANYWHERE in the expression: refuse and
    -- let the caller fall back to the observed median. The whole string is
    -- tested, not just the fields read below — an earlier version checked only
    -- hour/dom/dow and so read '*/5 * * * *' (every five minutes) as hourly.
    WHEN p_schedule ~ '[/-]' THEN NULL
    -- Weekly family: a day-of-week list.
    WHEN (SELECT n_dow FROM n) IS NOT NULL
      THEN 168.0 / ((SELECT per_day FROM n) * (SELECT n_dow FROM n))
    -- Monthly family: a day-of-month list. ~730 h in an average month.
    WHEN (SELECT n_dom FROM n) IS NOT NULL
      THEN 730.0 / ((SELECT per_day FROM n) * (SELECT n_dom FROM n))
    -- Daily family.
    ELSE 24.0 / (SELECT per_day FROM n)
  END;
$$;

COMMENT ON FUNCTION public.cron_cadence_hours(text) IS
  'FIX-977 — hours between consecutive firings of a standard 5-field cron '
  'expression. NULL on step (*/n) or range (a-b) syntax, so the caller falls '
  'back to the observed median gap rather than alerting off a guessed quantum.';

-- ---------------------------------------------------------------------------
-- The derived watch registry.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_scheduled_rollup_pipelines(
  p_lookback_days int DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, cron, pg_catalog
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => p_lookback_days);
  v_out   jsonb;
BEGIN
  -- Degrade to a shaped empty answer where pg_cron is absent, matching
  -- check_cron_job_health()'s contract: the canary treats a detector error as
  -- non-fatal, but an empty-shaped answer keeps the meta-row trail honest.
  IF to_regclass('cron.job_run_details') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object('available', false, 'pipelines', '[]'::jsonb);
  END IF;

  WITH census AS (
    -- STEP 1 — every pipeline pg_cron has ever driven.
    SELECT DISTINCT l.pipeline
    FROM public.data_sync_log l
    WHERE l.metadata->>'source' = 'pg_cron'
      AND l.started_at >= v_since
  ),
  runs AS (
    SELECT l.pipeline, l.started_at
    FROM public.data_sync_log l
    WHERE l.metadata->>'source' = 'pg_cron'
      AND l.started_at >= v_since
  ),
  run_counts AS (
    SELECT pipeline, count(*) AS total_runs FROM runs GROUP BY 1
  ),
  -- STEP 2a — exact correlation by normalised name. jobnames are kebab-case and
  -- pipelines are snake_case, so `donation-edge-orphan-sweep` <->
  -- `donation_edge_orphan_sweep` resolves exactly. This is the PRIMARY match
  -- because time-proximity alone mis-attributed that very pipeline to jobid 9
  -- (refresh-derived-mvs-daily) against prod, inheriting a 24h cadence in place
  -- of its real monthly one.
  by_name AS (
    SELECT c.pipeline, j.jobid
    FROM census c
    JOIN cron.job j ON replace(j.jobname, '-', '_') = c.pipeline
  ),
  -- STEP 2b — fallback correlation by RUN-INTERVAL CONTAINMENT. A pipeline row
  -- written any time between a firing's start and end belongs to that firing.
  -- Containment, not start-proximity: `recipient_count_reconcile` is written
  -- ~4 min into jobid 14's 4m31s run and a 90s start-window missed it entirely.
  by_time AS (
    SELECT r.pipeline, d.jobid, count(*) AS n
    FROM runs r
    JOIN cron.job_run_details d
      ON r.started_at BETWEEN d.start_time - interval '90 seconds'
                          AND COALESCE(d.end_time, d.start_time) + interval '90 seconds'
    WHERE d.start_time >= v_since
    GROUP BY 1, 2
  ),
  -- Keep every job that explains a MEANINGFUL share of the pipeline's runs, not
  -- just the single best. A pipeline can legitimately be driven by more than one
  -- job — entity_connections_rebuild fires from jobid 2 (Wed) AND jobid 22 (Mon),
  -- so picking one halves its apparent firing rate and doubles its stale
  -- threshold. The 15% floor keeps both halves of a Mon/Wed pair while dropping
  -- a one-off coincidence.
  by_time_kept AS (
    SELECT t.pipeline, t.jobid
    FROM by_time t
    JOIN run_counts rc ON rc.pipeline = t.pipeline
    WHERE t.n::numeric / GREATEST(rc.total_runs, 1) >= 0.15
  ),
  drivers AS (
    SELECT pipeline, jobid FROM by_name
    UNION
    SELECT t.pipeline, t.jobid FROM by_time_kept t
    -- name match wins outright: if a pipeline resolved by name, ignore its
    -- time-correlated candidates entirely.
    WHERE NOT EXISTS (SELECT 1 FROM by_name n WHERE n.pipeline = t.pipeline)
  ),
  -- STEP 2c — combine the cadence of every driver. Firing RATES add, so the
  -- combined interval is the harmonic sum: two weekly jobs on different days
  -- give 1/(1/168 + 1/168) = 84h, which is the real cadence a detector must
  -- judge entity_connections_rebuild against.
  combined AS (
    SELECT d.pipeline,
           min(d.jobid)                                    AS jobid,
           string_agg(DISTINCT j.jobname, ', ' ORDER BY j.jobname) AS jobname,
           string_agg(DISTINCT j.schedule, ', ' ORDER BY j.schedule) AS schedule,
           bool_or(j.active)                               AS active,
           CASE
             WHEN count(*) FILTER (WHERE public.cron_cadence_hours(j.schedule) IS NULL) > 0
               THEN NULL
             ELSE 1.0 / NULLIF(sum(1.0 / public.cron_cadence_hours(j.schedule)), 0)
           END                                             AS declared_h
    FROM drivers d
    JOIN cron.job j ON j.jobid = d.jobid
    GROUP BY d.pipeline
  ),
  -- STEP 3 fallback — observed median gap between consecutive runs.
  gaps AS (
    SELECT pipeline,
           EXTRACT(epoch FROM (started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at))) / 3600.0 AS gap_h
    FROM runs
  ),
  observed AS (
    SELECT pipeline,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_h) AS median_gap_h
    FROM gaps
    WHERE gap_h IS NOT NULL AND gap_h > 0
    GROUP BY 1
  ),
  resolved AS (
    SELECT
      c.pipeline,
      k.jobid,
      k.jobname,
      k.schedule,
      k.active,
      k.declared_h,
      o.median_gap_h
    FROM census c
    LEFT JOIN combined k ON k.pipeline = c.pipeline
    LEFT JOIN observed o ON o.pipeline = c.pipeline
  ),
  final AS (
    SELECT
      pipeline, jobid, jobname, schedule, active,
      -- Declared cadence wins; observed is the fallback; 168 h (weekly) is the
      -- last resort, chosen because it is the most common cadence here and
      -- errs toward a LOOSER threshold — a detector that cries wolf gets muted,
      -- which is worse than one that reports a cycle late.
      COALESCE(declared_h, ROUND(median_gap_h::numeric, 1), 168.0) AS cadence_hours,
      CASE
        WHEN declared_h   IS NOT NULL THEN 'cron_schedule'
        WHEN median_gap_h IS NOT NULL THEN 'observed_median'
        ELSE 'default'
      END AS cadence_source
    FROM resolved
  )
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'pipeline'), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
             'pipeline',             pipeline,
             'jobid',                jobid,
             'jobname',              jobname,
             'schedule',             schedule,
             'active',               COALESCE(active, true),
             'cadence_hours',        cadence_hours,
             'cadence_source',       cadence_source,
             -- One cycle late (x1.5 slack) reports; two-plus escalates.
             'report_after_hours',   ROUND(cadence_hours * 1.5, 1),
             'escalate_after_hours', ROUND(cadence_hours * 2.5, 1)
           ) AS t
    FROM final
  ) s;

  RETURN jsonb_build_object(
    'available',      true,
    'lookback_days',  p_lookback_days,
    'pipeline_count', jsonb_array_length(v_out),
    'pipelines',      v_out
  );
END;
$$;

-- Script-gated only (canary -> createAdminClient -> service_role). SECURITY
-- DEFINER because service_role lacks USAGE on schema cron. FIX-834/835 hygiene:
-- Supabase default-grants EXECUTE on new functions to anon/authenticated, so
-- the REVOKE is required, not decorative.
REVOKE ALL ON FUNCTION public.list_scheduled_rollup_pipelines(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_scheduled_rollup_pipelines(int) TO service_role;
REVOKE ALL ON FUNCTION public.cron_cadence_hours(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_cadence_hours(text) TO service_role;

COMMENT ON FUNCTION public.list_scheduled_rollup_pipelines(int) IS
  'FIX-977 — the DERIVED rollup watch registry. Census = every data_sync_log '
  'pipeline pg_cron has driven; correlation = start-time proximity to '
  'cron.job_run_details; cadence = parsed from the job cron expression with an '
  'observed-median fallback. Replaces canary-check.ts''s hand-maintained '
  'length-1 ROLLUP_PIPELINES literal, which watched the freshest of five '
  'pipelines while FE totals sat 403.8h stale. Consumed by canary-check.ts.';
