-- =============================================================================
-- FIX-1114 / FIX-1113 / FIX-1103 — the crawl's instrument, the grant sweep, and
-- the job that has been crashing the postmaster.
--
-- Three changes that happen to share one migration because they share one
-- quiet window. They are independent; each is guarded and each announces
-- itself.
--
--   1. FIX-1114  get_ec_crawl_health() — the lag metric.
--   2. FIX-1103  jobid 16 entity-connection-stats-rebuild -> PAUSED.
--   3. FIX-1113  REVOKE anon/authenticated EXECUTE on 13 pipeline procedures.
--
-- Per the standing rule this migration is the first to be written under: every
-- routine it creates or recreates ends with REVOKE EXECUTE ... FROM PUBLIC,
-- anon, authenticated plus the grant its real caller actually needs.
-- =============================================================================


-- ═══ 1. FIX-1114 — get_ec_crawl_health() ════════════════════════════════════
--
-- FIX-1111 turned the EC rebuild into a paced crawl. That converts an
-- AVAILABILITY problem into a LATENCY one: the crawl provably cannot starve
-- the box (96 firings/day x 1 bounded unit = 60% of the day's I/O refill, a
-- ceiling no cycle shape can exceed), but it can fall arbitrarily far behind
-- ingest and nothing currently measures that. This is the instrument.
--
-- ⚠ THE DECISION RULE THIS SERVES — recorded here because an instrument
-- without its rule gets read as whatever the reader already believed:
--
--     lag > 7d for TWO CONSECUTIVE WEEKS **with** backoffs on >~25% of
--       firings   ->  compute-tier conversation. The crawl is being throttled;
--                     more units/day cannot be bought with scheduling.
--
--     lag > 7d **with** backoffs rare and units/cycle GROWING
--                 ->  ingest conversation (delta aggregation, write
--                     amplification, replay pacing). The box is fine; we are
--                     manufacturing more work per cycle than a cycle can hold.
--
-- The "two consecutive weeks" half CANNOT be evaluated from a single snapshot,
-- and this function deliberately does not pretend otherwise. It exposes
-- lag_days and backoff_rate_7d and emits a coarse `signal`; the persistence
-- test is the human read across two weekly snapshots.
--
-- SECURITY DEFINER because it reads cron.job_run_details, which the calling
-- role does not have. Owned by postgres, search_path pinned.
--
-- Returns ONE jsonb (never a set): PostgREST caps set-returning RPCs at 1000
-- rows, and an aggregate is immune to that by construction.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_ec_crawl_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_temp
AS $$
DECLARE
  v_cfg        jsonb;
  v_wm         timestamptz;
  v_dirty_rows bigint := 0;
  v_dirty_dons bigint := 0;
  v_cursor     jsonb;
  v_fire_total int := 0;
  v_fire_fail  int := 0;
  v_units_7d   int := 0;
  v_units_all_7d int := 0;
  v_backoff_7d int := 0;
  v_cycles     jsonb := '[]'::jsonb;
  v_last_close timestamptz;
  v_lag_days   numeric;
  v_backoff_r  numeric;
  v_signal     text;
BEGIN
  SELECT value INTO v_cfg     FROM public.pipeline_state WHERE key = 'ec_crawl';
  SELECT value INTO v_cursor  FROM public.pipeline_state
   WHERE key = 'entity_connections_rebuild_cursor';

  -- Scalar watermark. NOTE: the donations key carries BOTH a scalar
  -- `last_indexed_at` and a per-window `windows` map (FIX-1069). The scalar is
  -- the lag number; the windows are the crawl's resume cursor.
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_wm
    FROM public.pipeline_state WHERE key = 'entity_connections_donations';

  -- Dirty set — byte-for-byte the drain wrapper's DIRTY_SQL so the two
  -- instruments can never disagree about what "behind" means.
  IF v_wm IS NOT NULL THEN
    SELECT count(*), count(DISTINCT from_id)
      INTO v_dirty_rows, v_dirty_dons
      FROM public.financial_relationships
     WHERE relationship_type IN ('donation','ie_support','ie_oppose')
       AND updated_at > v_wm;
  END IF;

  -- Trailing-7d firing census, by NAME (jobids are not stable across a
  -- reschedule and the whole point of this row is to survive one).
  SELECT count(*),
         count(*) FILTER (WHERE d.status <> 'succeeded')
    INTO v_fire_total, v_fire_fail
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = 'ec-crawl'
     AND d.start_time >= now() - interval '7 days';

  -- Units actually run BY THE CRAWL in the same window. One data_sync_log row
  -- is written per unit and a skipped firing writes none, so this is an exact
  -- skip count without trusting a cumulative counter.
  --
  -- ⚠ It must be counted through the cron rows, not straight off data_sync_log.
  -- The FIX-1110 drain wrapper drives the SAME CALL and writes an
  -- indistinguishable row (metadata.crawl is true for both, deliberately), so
  -- a bare count of unit rows includes hand-driven drains and
  -- `firings - units` would silently under-report skips — it went NEGATIVE on
  -- local, where every unit was drain-driven and only one cron firing existed.
  -- Matching on start_time keeps the two populations apart: the crawl's log row
  -- carries the firing's start_time exactly.
  SELECT count(*) INTO v_units_7d
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = 'ec-crawl'
     AND d.start_time >= now() - interval '7 days'
     AND EXISTS (
       SELECT 1 FROM public.data_sync_log l
        WHERE l.pipeline = 'entity_connections_rebuild'
          AND l.started_at = d.start_time
          AND COALESCE(jsonb_array_length(l.metadata->'units'), 0) > 0);

  -- Every unit row in the window regardless of driver. units_out_of_band is
  -- (this - v_units_7d) and is the supervised-drain contribution.
  SELECT count(*) INTO v_units_all_7d
    FROM public.data_sync_log
   WHERE pipeline = 'entity_connections_rebuild'
     AND started_at >= now() - interval '7 days'
     AND COALESCE(jsonb_array_length(metadata->'units'), 0) > 0;

  -- Backoffs in the ring (the ring is bounded at 50, so this saturates on a
  -- badly-throttled week — which is itself the signal).
  SELECT count(*) INTO v_backoff_7d
    FROM jsonb_array_elements(COALESCE(v_cfg->'recent_units','[]'::jsonb)) e
   WHERE (e.value->>'at')::timestamptz >= now() - interval '7 days'
     AND (e.value->>'outcome') IS DISTINCT FROM 'ok';

  -- Units per cycle, last 5 CLOSED cycles. A 'complete' row closes a cycle;
  -- everything since the previous close belongs to it.
  WITH rows AS (
    SELECT started_at, status,
           count(*) FILTER (WHERE status = 'complete')
             OVER (ORDER BY started_at DESC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
      FROM public.data_sync_log
     WHERE pipeline = 'entity_connections_rebuild'
       AND COALESCE(jsonb_array_length(metadata->'units'), 0) > 0
       AND started_at >= now() - interval '30 days'
  ), cycles AS (
    SELECT grp,
           count(*)          AS units,
           min(started_at)   AS first_unit,
           max(started_at)   AS last_unit,
           bool_or(status = 'complete') AS closed
      FROM rows GROUP BY grp
  )
  SELECT jsonb_agg(jsonb_build_object(
           'units',            units,
           'first_unit_at',    first_unit,
           'closed_at',        CASE WHEN closed THEN last_unit END,
           'closed',           closed,
           'span_minutes',     round(EXTRACT(epoch FROM (last_unit - first_unit))::numeric / 60.0, 1)
         ) ORDER BY first_unit DESC)
    INTO v_cycles
    FROM (SELECT * FROM cycles WHERE closed ORDER BY first_unit DESC LIMIT 5) c;

  SELECT max(started_at) INTO v_last_close
    FROM public.data_sync_log
   WHERE pipeline = 'entity_connections_rebuild' AND status = 'complete';

  v_lag_days  := CASE WHEN v_wm IS NULL THEN NULL
                      ELSE round(EXTRACT(epoch FROM (now() - v_wm))::numeric / 86400.0, 2) END;
  v_backoff_r := CASE WHEN v_fire_total = 0 THEN NULL
                      ELSE round(v_backoff_7d::numeric / v_fire_total::numeric, 4) END;

  -- Coarse signal only. The tier-vs-ingest CALL is the human's, made across two
  -- weekly readings — see the rule at the top of this migration.
  v_signal := CASE
    WHEN v_lag_days IS NULL          THEN 'unknown'
    WHEN v_lag_days <= 7             THEN 'ok'
    WHEN COALESCE(v_backoff_r,0) > 0.25 THEN 'lag_high_backoff_high'
    ELSE                                  'lag_high_backoff_low'
  END;

  RETURN jsonb_build_object(
    'generated_at',   now(),
    'watermark',      jsonb_build_object('last_indexed_at', v_wm, 'age_days', v_lag_days),
    'dirty_set',      jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons),
    'firings_7d',     jsonb_build_object(
                        'total',             v_fire_total,
                        'units_run',         v_units_7d,
                        'skipped',           greatest(v_fire_total - v_units_7d, 0),
                        'units_out_of_band', greatest(v_units_all_7d - v_units_7d, 0),
                        'backoff',           v_backoff_7d,
                        'failed',            v_fire_fail),
    'backoff_rate_7d',      v_backoff_r,
    'skips_cumulative',     COALESCE(v_cfg->'skips','{}'::jsonb),
    'cycles_last5',         COALESCE(v_cycles,'[]'::jsonb),
    'last_cycle_closed_at', v_last_close,
    'open_cycle',           jsonb_build_object(
                              'started_at',     v_cursor->'cycle_started_at',
                              'completed_arms', COALESCE(jsonb_array_length(v_cursor->'completed_arms'), 0)),
    'config',               COALESCE(v_cfg,'{}'::jsonb) - 'recent_units' - 'skips',
    'signal',               v_signal,
    'decision_rule',        'lag>7d for TWO consecutive weeks WITH backoffs on >~25% of firings -> compute-tier; lag>7d with backoffs rare and units/cycle growing -> ingest (delta aggregation / write amplification / replay pacing)'
  );
END;
$$;

ALTER FUNCTION public.get_ec_crawl_health() OWNER TO postgres;

COMMENT ON FUNCTION public.get_ec_crawl_health() IS
  'FIX-1114 — health/lag instrument for the FIX-1111 EC crawl. Returns ONE '
  'jsonb: watermark age, dirty set, trailing-7d firing census, units per '
  'cycle for the last 5 closed cycles, and the live ec_crawl config. Read by '
  'the status-snapshot payload (section ec_crawl_health). SECURITY DEFINER '
  'because it reads cron.job_run_details. The tier-vs-ingest decision rule it '
  'serves is carried in the returned decision_rule key and in migration '
  '20260828000000.';

-- Route-gated: the snapshot writer calls it as service_role. Nothing on the
-- anon or authenticated path has any business starting a cron-catalog read.
REVOKE ALL ON FUNCTION public.get_ec_crawl_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ec_crawl_health() TO service_role;


-- ═══ 2. FIX-1103 — pause jobid 16 (entity-connection-stats-rebuild) ══════════
--
-- MEASURED on prod 2026-08-27. jobid 16 has fired exactly TWICE since 08-24
-- and BOTH firings ended in a postmaster restart, with the job as the ONLY
-- non-watchdog process in flight:
--
--   08-24 16:00:00 fired -> postmaster restarted 16:26:19 (26 min in)
--   08-26 16:00:00 fired -> postmaster restarted 16:03:01 ( 3 min in)
--
-- The 08-26 case is the one that settles it. pg_postmaster_start_time() reads
-- 2026-08-26 16:03:01, the watchdogs (jobids 40/44) fired cleanly at 15:56,
-- 15:58 and 16:00 — so the box was HEALTHY, not starving — and jobid 16 was
-- the only thing running in the whole 15:00-16:10 window. A healthy box that
-- dies three minutes into one job is not a victim of that job's neighbours.
--
-- Only one other 'server restarted' exists in retained history (jobid 12,
-- 08-18 ~10:00) and it has a different and already-known cause: jobid 13 and
-- jobid 24 were both mid-run, the Tuesday I/O pile-up FIX-1101 paused jobid 13
-- for.
--
-- MECHANISM (see FIX-1115 for the replacement): the procedure does
-- SET work_mem='256MB' and then CREATE TEMP TABLE ecs_stage AS <HashAggregate
-- over 2x entity_connections, ~2.66M groups> in ONE unbounded statement, on a
-- 2GB box with 256MB shared_buffers. The 08-10 firing died at 21,610s on a
-- statement timeout INSIDE that CREATE TEMP TABLE. An OOM-killed backend is a
-- cluster-wide crash-recovery restart, which is exactly the signature.
--
-- ⚠ THIS PAUSE LEAVES entity_connection_stats_mv STALE — last successful
-- rebuild 2026-08-05. That is deliberate: stale connection counts are strictly
-- better than a postmaster that dies twice a week, and the crawl is writing
-- edges continuously so the drift is already there. FIX-1115 owns the fix.
--
-- UN-PAUSE CONDITION: never, until FIX-1115 ships a bounded stage build that
-- has been measured against prod cardinality. Not "when the box looks better".
--
-- alter_job by NAME, job stays DEFINED (playbook D3) — its job_run_details
-- history is the entire evidence base above and unscheduling would orphan it.
-- =============================================================================
DO $$
DECLARE
  v_ecs record;
BEGIN
  SELECT jobid, active INTO v_ecs FROM cron.job
   WHERE jobname = 'entity-connection-stats-rebuild';

  IF v_ecs.jobid IS NULL THEN
    RAISE WARNING '[FIX-1103] entity-connection-stats-rebuild not found — nothing to pause';
  ELSIF NOT v_ecs.active THEN
    RAISE NOTICE '[FIX-1103] entity-connection-stats-rebuild (jobid %) already paused — left alone', v_ecs.jobid;
  ELSE
    PERFORM cron.alter_job(v_ecs.jobid, active := false);
    RAISE NOTICE '[FIX-1103] entity-connection-stats-rebuild (jobid %) PAUSED — 2/2 firings since 08-24 ended in a postmaster restart; see FIX-1115', v_ecs.jobid;
  END IF;
END;
$$;


-- ═══ 3. FIX-1113 — REVOKE anon/authenticated on pipeline procedures ══════════
--
-- FIX-1113 named ONE case: refresh_official_donor_rollup_incremental() is
-- EXECUTE-able by anon on prod. Auditing the whole surface to seed the
-- report-only sweep turned that single case into a clean RULE:
--
--   EVERY procedure (prokind='p') that anon or authenticated can EXECUTE on
--   prod is a heavy pipeline procedure, and EVERY ONE of them is driven by
--   pg_cron as postgres. There is not one legitimate anon/authenticated
--   caller among them.
--
-- This is DRIFT, not design — the convention already exists and the newer
-- procedures already carry it. refresh_agency_staffing_rollup (jobid 25),
-- refresh_treemap_individuals_global (26), rebuild_official_vote_stats (27),
-- refresh_contract_flow_rollups (28) and run_entity_connections_rebuild
-- (2/22/45) are all correctly revoked already. The 13 below are the ones that
-- predate the convention or missed it, still carrying Supabase's default
-- grant-EXECUTE-to-anon-and-authenticated behaviour (FIX-834, FIX-695).
--
-- Classification per FIX-834's rule, done before revoking, for all 13:
--   caller = pg_cron CALL as postgres, for every one (jobids 9,10,11,12,13,
--   14,15,16,17,18,19,23,24,29; reconcile_recipient_count is script-driven).
--   app references = display strings only (DashboardClient's `retryCmd`
--   operator label) plus packages/data scripts that run as service_role.
--   No route, no client, no authenticated path. Nothing here loses a caller.
--
-- Two of these deserve their names said out loud: rebuild_entity_connection_
-- stats is the procedure section 2 just paused for crashing the postmaster,
-- and purge_abuse_events is a bulk DELETE. Both were anon-executable.
-- =============================================================================
DO $$
DECLARE
  c_procs text[] := ARRAY[
    'purge_abuse_events',
    'rebuild_entity_connection_stats',
    'reconcile_donation_edge_orphans',
    'reconcile_donor_party_rollup_orphans',
    'reconcile_donor_rollup_orphans',
    'reconcile_entity_connection_stats_orphans',
    'reconcile_financial_entity_totals',
    'reconcile_recipient_count',
    'refresh_derived_mvs',
    'refresh_donor_party_rollup_incremental',
    'refresh_financial_entity_totals_incremental',
    'refresh_official_donor_rollup_incremental',
    'run_rule_taggers'
  ];
  r         record;
  v_touched int := 0;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.prokind
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY (c_procs)
  LOOP
    IF r.prokind <> 'p' THEN
      RAISE WARNING '[FIX-1113] public.%(%) is not a procedure (prokind=%) — SKIPPED, classify by hand',
        r.proname, r.args, r.prokind;
      CONTINUE;
    END IF;

    EXECUTE format(
      'REVOKE ALL ON PROCEDURE public.%I(%s) FROM PUBLIC, anon, authenticated',
      r.proname, r.args);
    -- pg_cron runs these as postgres (the owner). service_role keeps EXECUTE
    -- so the packages/data operator scripts that drive them by hand still work.
    EXECUTE format(
      'GRANT EXECUTE ON PROCEDURE public.%I(%s) TO service_role',
      r.proname, r.args);

    v_touched := v_touched + 1;
    RAISE NOTICE '[FIX-1113] revoked anon/authenticated EXECUTE on public.%(%)', r.proname, r.args;
  END LOOP;

  SELECT array_agg(x) INTO v_missing
    FROM unnest(c_procs) x
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = x);

  IF v_missing IS NOT NULL THEN
    RAISE NOTICE '[FIX-1113] not present in this database (fine — local and prod differ): %',
      array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE '[FIX-1113] % procedure(s) hardened', v_touched;
END;
$$;

NOTIFY pgrst, 'reload schema';
