-- ─────────────────────────────────────────────────────────────────────────────
-- FIX-1021 + FIX-1013 + FIX-1027 — stop refresh_derived_mvs() from being able to
-- hold the box for six hours, and give the two tables its MVs actually pivot on
-- a vacuum owner that runs AFTER the writes it exists to clean up.
--
-- ── THE INCIDENT THIS COMES FROM ───────────────────────────────────────────
-- 2026-08-11 07:00 UTC, pg_cron jobid 10 (refresh-derived-mvs-weekly) ran
-- 21,802 s and was killed by the postgres role's 6 h statement_timeout inside a
-- REFRESH. Its six units had a baseline series of 1,253 → 1,779 → 2,781 →
-- 2,774 s. One statement held a bgworker plus parallel workers out of
-- max_worker_processes = 6 for six hours; 13 consecutive pg_cron firings died
-- with 'job startup timeout' between 07:30 and 12:00; the request path served
-- Cloudflare 522s until the 23:26 UTC restart. Full writeup:
-- docs/audits/2026-08-12-weekly-mv-regression.md.
--
-- ── WHAT THE PROCEDURE COULD NOT DO, AND NOW CAN ───────────────────────────
-- Three independent defects, all of which had to hold at once for a slow unit
-- to become a 14-hour outage:
--
--   (1) NO BUDGET. The loop ran unit after unit with nothing evaluating whether
--       continuing was sane — the FIX-1021 bullet's exact shape, and the same
--       gap FIX-944/FIX-965 closed for the treemap sweep and FIX-1002 for the
--       donor rollup. Per playbook C3 the check can only sit BETWEEN units: a
--       single REFRESH MATERIALIZED VIEW cannot be budget-guarded mid-statement,
--       which is precisely why the between-unit point must be used and not left
--       empty.
--
--   (2) THE ROW COULD NOT CLOSE ITSELF. The per-unit handler is
--       `EXCEPTION WHEN OTHERS`, and PL/pgSQL's OTHERS matches every error type
--       EXCEPT query_canceled and assert_failure. statement_timeout raises
--       query_canceled (57014). So the axe blew straight through the handler,
--       past the final UPDATE, and out of the procedure — leaving the
--       data_sync_log row stranded 'running' until the nightly reaper closed it
--       15 h later at 08-12 04:08:28. That is a CLASS, not an instance: any
--       cancel (statement_timeout, pg_cancel_backend, client disconnect) had the
--       same effect on every run this procedure has ever made.
--
--   (3) NO PER-UNIT TIMING. metadata carried `units`, `units_ok` and
--       `unit_failures` and nothing else, so a 35x spread across runs of
--       identical work was invisible in every log the procedure writes. The only
--       reason the 08-11 run was diagnosable at all is cron.job_run_details
--       recording the wall clock from outside. Same lesson as FIX-1018 one level
--       up: a phase with no instrument is a phase nobody can bound.
--
-- ── BUDGET SIZING — from OBSERVED starts, not cron expressions (playbook D2) ─
-- Both cadences share this procedure and one advisory lock, so both get a
-- budget, each sized below the gap to the next scheduled heavy work:
--
--   daily  (jobid 9, 06:00): next heavy neighbour is 07:00 refresh-derived-mvs-
--          -weekly on Tuesdays. 3,300 s stops at 06:55, five minutes clear —
--          which matters because the two cadences share c_lock_key, so a daily
--          run that overruns 07:00 does not merely collide with the weekly, it
--          makes the weekly SKIP for the week. Healthy daily runs measure 354-
--          816 s (08-09..08-12), so this is ~4x headroom over observed good
--          runs while capping the 12,546 s (3h29m) pathology of 08-05 at 55 min.
--   weekly (jobid 10, 07:00): next heavy neighbour is 08:15 treemap-individuals-
--          -global-refresh, a 64-chunk sweep. 4,200 s stops at 08:10. Healthy
--          weekly runs measure 1,253-2,781 s, so this is ~1.5x headroom over the
--          WORST healthy run — deliberately tighter than the daily, because a
--          weekly overrun collides with a genuinely heavy job rather than a
--          light one.
--
-- Both are GUC-overridable via civitics.derived_mvs_budget_seconds for a
-- supervised manual CALL, mirroring civitics.treemap_global_budget_seconds
-- (FIX-965).
--
-- Skipping is cheap for the daily for the FIX-1017 reason — these MVs are
-- re-refreshed on the next firing. It is NOT cheap for the weekly: a skipped
-- weekly unit is stale for a week. That asymmetry is why the fix below is a
-- budget AND a diagnosis (FIX-1027, section 3) rather than a budget alone —
-- a breaker that trips every Tuesday is a breaker nobody should have shipped.
--
-- ── WHY THE VACUUM OWNERS ARE IN THE SAME MIGRATION ────────────────────────
-- Because the diagnosis says the regression is a visibility-map failure, and
-- the vacuum owners are the fix for it. Measured on prod 2026-08-12 23:30 UTC,
-- the FIX-1018 dirty-set build against financial_relationships:
--
--     before VACUUM (ANALYZE)   7,952 ms   Heap Fetches 129,415   60,883 reads
--     after  VACUUM (ANALYZE)     365 ms   Heap Fetches       0      439 reads
--
-- 21.8x on wall clock, 139x on buffer reads, from one vacuum. 129,415 heap
-- fetches for 129,415 rows is a 100% index-only-scan fallback — FIX-884's
-- mechanism at its theoretical maximum. financial_relationships went 77.1% ->
-- 100.0% all-visible; it had NO vacuum owner at all (FIX-1013).
--
-- Cross-ref FIX-943 (the standing bulk-rewrite vacuum rule), FIX-884 (the
-- all-visible / heap-fetch mechanism), FIX-965 + FIX-944 (the budget idiom this
-- mirrors), FIX-1002 (same shape for the donor rollup), FIX-1022 (the
-- background-worker starvation this outage escalated), FIX-1008 (the
-- skip-unchanged predicate reused in section 3).
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FIX-1021 — refresh_derived_mvs(): predictive budget, per-unit timings, and
--    a handler that can actually catch the axe.
--
--    Unit list and order are UNCHANGED from the live definition. The only
--    behavioural changes are the three defects above.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_derived_mvs(p_cadence text)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('refresh_derived_mvs')::bigint;  -- shared by both cadences: never two at once
  v_log_id   uuid;
  v_units    text[];   -- SQL command per unit
  v_labels   text[];   -- human label per unit (data_sync_log / NOTICE)
  v_cmd      text;
  v_label    text;
  v_ok       int := 0;
  v_failures text[] := ARRAY[]::text[];
  i          int;
  -- FIX-1021 additions
  c_budget     double precision;         -- seconds; per-cadence, GUC-overridable
  v_budget_cfg int;
  v_started    timestamptz := clock_timestamp();
  v_unit_beg   timestamptz;
  v_unit_secs  double precision;
  v_max_unit   double precision := 0;
  v_elapsed    double precision := 0;
  v_unit_times jsonb := '{}'::jsonb;     -- label -> seconds, ALWAYS written
  v_skipped    text[] := ARRAY[]::text[];
  v_budget_hit boolean := false;
  v_canceled   text := NULL;             -- non-NULL = query_canceled caught
  v_status     text;
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'refresh_derived_mvs: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

  -- Session advisory lock (survives the per-unit COMMITs below). Stampede guard.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('refresh_derived_mvs', 'skipped', now(), now(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent refresh_derived_mvs',
                               'source', 'pg_cron'));
    RAISE NOTICE '[derived-mvs] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;

  -- Bounded per-unit memory. Plain SET (not SET LOCAL) survives the COMMITs.
  SET work_mem = '128MB';

  -- FIX-1021: per-cadence budget. Measured 2026-08-12: work_mem is NOT the
  -- lever here (unit 1 measured 185 s at 256MB vs 198 s at 128MB, identical
  -- plan), so this stays as FIX-748 set it.
  c_budget := CASE p_cadence WHEN 'weekly' THEN 4200 ELSE 3300 END;
  v_budget_cfg := NULLIF(current_setting('civitics.derived_mvs_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := v_budget_cfg;
  END IF;

  IF p_cadence = 'daily' THEN
    -- proposal/vote/comment/engagement-derived + co-located daily maintenance.
    -- FIX-748: rebuild_entity_search_index appended (daily superset — new
    -- entities land on the nightly ingest; TRUNCATE+INSERT is atomic per unit).
    v_labels := ARRAY[
      'proposal_trending_24h', 'proposal_popularity_24h', 'homepage_stats_mv',
      'official_homepage_stats_mv', 'entity_engagement_rollup_mv',
      'homepage_agency_counts_mv', 'commons_active_threads', 'pipeline_runtime_stats_mv',
      'rebuild_entity_search_index',
      'rebuild_all_primary_sources', 'prune_platform_usage_snapshot',
      'prune_kill_switch_events', 'prune_status_snapshot'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_trending_24h',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_popularity_24h',
      'REFRESH MATERIALIZED VIEW public.homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.entity_engagement_rollup_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_agency_counts_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.commons_active_threads',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.pipeline_runtime_stats_mv',
      'SELECT public.rebuild_entity_search_index()',
      'SELECT public.rebuild_all_primary_sources()',
      'SELECT public.prune_platform_usage_snapshot()',
      'SELECT public.prune_kill_switch_events()',
      'SELECT public.prune_status_snapshot()'
    ];
  ELSE  -- weekly (donation-derived)
    v_labels := ARRAY[
      'chord_industry_flows_mv', 'chord_donor_type_party_flows_mv',
      'chord_donor_state_party_flows_mv', 'chord_subject_party_flows_mv',
      'official_sector_dollars_mv', 'refresh_spending_totals'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_industry_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_type_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_state_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_subject_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_sector_dollars_mv',
      'SELECT public.refresh_spending_totals()'
    ];
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('refresh_derived_mvs', 'running', now(),
          jsonb_build_object('cadence', p_cadence,
                             'units', array_length(v_units, 1),
                             'budget_seconds', c_budget,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  FOR i IN 1 .. array_length(v_units, 1) LOOP
    v_cmd   := v_units[i];
    v_label := v_labels[i];

    -- FIX-1021 PREDICTIVE budget check (FIX-944 idiom): stop when the slowest
    -- unit observed so far, plus 25% headroom, would not fit in what remains.
    -- Deliberately BETWEEN units — playbook C3, a REFRESH cannot be interrupted
    -- from inside.
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_unit > 0 AND v_elapsed + (v_max_unit * 1.25) > c_budget THEN
      v_budget_hit := true;
      -- Everything from here on is skipped; name each one so the log says what
      -- is stale rather than just that something is.
      v_skipped := v_skipped || v_labels[i : array_length(v_labels, 1)];
      RAISE WARNING '[derived-mvs] budget guard — stopping before % (elapsed %s of %s budget, slowest unit %s); % unit(s) skipped',
        v_label, round(v_elapsed)::int, round(c_budget)::int, round(v_max_unit)::int,
        array_length(v_skipped, 1);
      EXIT;
    END IF;

    v_unit_beg := clock_timestamp();
    BEGIN
      EXECUTE v_cmd;
      v_ok := v_ok + 1;
      RAISE NOTICE '  [derived-mvs] % — ok', v_label;
    EXCEPTION
      -- FIX-1021: query_canceled is NOT matched by OTHERS (PL/pgSQL trapping
      -- rules), and statement_timeout raises exactly that. Trapping it by name
      -- is the only way this procedure can close its own row. The docs' caution
      -- about swallowing user cancels is answered by the EXIT below: we stop the
      -- whole loop immediately and do nothing but bookkeeping afterwards, so a
      -- deliberate pg_cancel_backend still ends the run — it just ends it
      -- tidily instead of leaving a stranded 'running' row behind.
      WHEN query_canceled THEN
        v_canceled := format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — CANCELED (statement_timeout or operator cancel): %', v_label, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — FAILED: %', v_label, SQLERRM;
    END;

    -- Timing is recorded for EVERY outcome (ok, failed, canceled) — a unit that
    -- died at 6 h is the single most interesting number in the run.
    v_unit_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_unit_beg));
    v_unit_times := v_unit_times || jsonb_build_object(v_label, round(v_unit_secs::numeric, 1));
    IF v_unit_secs > v_max_unit THEN
      v_max_unit := v_unit_secs;
    END IF;

    COMMIT;

    IF v_canceled IS NOT NULL THEN
      -- The timer that fired is disarmed once it has thrown, so the bookkeeping
      -- UPDATE below still runs. Continuing the loop would not: the next unit
      -- would be starting on a box that has already proven it cannot finish one.
      IF i < array_length(v_units, 1) THEN
        v_skipped := v_skipped || v_labels[i + 1 : array_length(v_labels, 1)];
      END IF;
      EXIT;
    END IF;
  END LOOP;

  v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  v_status := CASE
                WHEN v_canceled IS NOT NULL THEN 'partial'
                WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                WHEN v_budget_hit THEN 'partial'
                ELSE 'complete'
              END;

  UPDATE public.data_sync_log
  SET status        = v_status,
      completed_at  = now(),
      rows_inserted = v_ok,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled mid-unit — %s; %s unit(s) skipped',
                                           v_canceled, COALESCE(array_length(v_skipped, 1), 0)), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_budget_hit
                          THEN left(format('budget exhausted after %ss of %ss — %s unit(s) skipped: %s',
                                           round(v_elapsed)::int, round(c_budget)::int,
                                           COALESCE(array_length(v_skipped, 1), 0),
                                           array_to_string(v_skipped, ', ')), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'units_ok', v_ok,
                        'unit_failures', COALESCE(array_length(v_failures, 1), 0),
                        'unit_seconds', v_unit_times,
                        'elapsed_seconds', round(v_elapsed::numeric, 1),
                        'slowest_unit_seconds', round(v_max_unit::numeric, 1),
                        'budget_hit', v_budget_hit,
                        'canceled', v_canceled IS NOT NULL,
                        'skipped_units', to_jsonb(v_skipped))
  WHERE id = v_log_id;

  RAISE NOTICE '[derived-mvs] % (cadence=%) — %/% units ok (% failures, % skipped, %ss elapsed)',
    upper(v_status), p_cadence, v_ok, array_length(v_units, 1),
    COALESCE(array_length(v_failures, 1), 0), COALESCE(array_length(v_skipped, 1), 0),
    round(v_elapsed)::int;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

COMMENT ON PROCEDURE public.refresh_derived_mvs(text) IS
  'Refreshes the daily (13-unit) or weekly (6-unit) derived-MV set under a '
  'predictive between-unit wall-clock budget (daily 3300s, weekly 4200s; GUC '
  'civitics.derived_mvs_budget_seconds overrides). FIX-1021: budget EXIT and a '
  'by-name query_canceled handler both close the data_sync_log row as partial '
  'rather than stranding it running, and per-unit durations are always written '
  'to metadata.unit_seconds. Cadences share one advisory lock.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FIX-1013 — financial_relationships and officials get vacuum owners.
--
--    ── WHY MONDAY 01:00/01:30 AND NOT SUNDAY ──────────────────────────────
--    From OBSERVED starts (playbook D2), not cron expressions. The Sunday FEC
--    bulk window on 2026-08-09 ran 15:55->16:55 and 22:28->23:43 UTC. So a
--    vacuum owner for what that window rewrites must fire AFTER ~23:43 Sunday.
--    Monday 01:00 clears it by 1h15m and precedes jobid 22
--    (rebuild-ec-incremental-mon, 08:00) by seven hours. This is the same
--    mistake jobid 30 (fe-vacuum-analyze) still makes and section 3 fixes:
--    its Sunday 02:00 firing runs ~14 h BEFORE the ingest it is meant to clean
--    up, so it only ever cleans the previous week's writes.
--
--    ── COST, MEASURED, NOT ESTIMATED ──────────────────────────────────────
--    Run inline on prod 2026-08-12 23:30 UTC on a verified-quiet box:
--        VACUUM (ANALYZE) public.officials                  1.4 s
--        VACUUM (ANALYZE) public.financial_relationships   141.9 s
--    FIX-1013's bullet predicted ~2.1x financial_entities' 83.9 s ≈ 176 s; the
--    real number is 141.9 s. Both are comfortably inside a 01:00 window.
--
--    One VACUUM per cron job: pg_cron sends the command as a simple query and
--    multiple statements there run in an implicit transaction block, which
--    VACUUM may not. Same constraint FIX-1003(b) documented.
--
--    FIX-688 unschedule+schedule idiom — these are NEW jobs with no
--    cron.job_run_details history to orphan, and it makes this re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_job text;
BEGIN
  FOREACH v_job IN ARRAY ARRAY['fr-vacuum-analyze', 'officials-vacuum-analyze'] LOOP
    BEGIN
      PERFORM cron.unschedule(v_job);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

SELECT cron.schedule(
  'fr-vacuum-analyze',
  '0 1 * * 1',
  'VACUUM (ANALYZE) public.financial_relationships;'
);

SELECT cron.schedule(
  'officials-vacuum-analyze',
  '30 1 * * 1',
  'VACUUM (ANALYZE) public.officials;'
);

-- ── officials: threshold-led autovacuum override (playbook D7) ─────────────
-- officials had NO reloptions at all, so it inherited the cluster default
-- trigger of 50 + 0.2 x 37,070 reltuples = 7,464 dead tuples — 20% of the table
-- before autovacuum is even permitted to look at it. That is how it sat at
-- 9.5% all-visible for the whole 08-10..08-12 window after the FIX-953 merge
-- churned it, and it only self-healed at 08-12 04:11 by crossing that very
-- loose bar. On a 2,590-page / 20 MB table the scale-factor term is the wrong
-- lever and the THRESHOLD is the whole trigger: 1,000 dead tuples (2.7%) with
-- the scale factor zeroed fires ~7x sooner, and the vacuum it triggers costs
-- 1.4 s. The weekly cron job above is the primary owner; this is the backstop.
ALTER TABLE public.officials
  SET (autovacuum_vacuum_threshold = 1000, autovacuum_vacuum_scale_factor = 0.0,
       autovacuum_analyze_threshold = 1000, autovacuum_analyze_scale_factor = 0.0);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FIX-1027 — the weekly-MV regression's actual mechanism.
--
--    ── 3a. refresh_spending_totals() rewrites 127,728 rows a week to write
--           values that are already there ────────────────────────────────────
--    Measured on prod 2026-08-12: the UPDATE touches 127,728 financial_entities
--    rows, and the number of those rows whose value would actually CHANGE is
--    ZERO. financial_entities carries 19 indexes totalling 1,403 MB, so each of
--    those no-op rewrites is a new tuple version plus index maintenance, every
--    Tuesday, for nothing.
--
--    That is not merely waste — it is the weekly job bloating the exact table
--    its own MVs pivot on. Four of the five weekly MVs join financial_entities
--    through an Index Only Scan on financial_entities_pkey (815,293 Memoize'd
--    loops on the chord_industry plan, 3,670,461 rows on the hash-join plan),
--    and every one of those reads Heap Fetches: 0 ONLY while financial_entities
--    is all-visible. FIX-884 is this instance's measured precedent for what a
--    degraded visibility map does to precisely that access shape, and section 2
--    above re-measured it at 21.8x on financial_relationships the same night.
--
--    The predicate is FIX-1008's, unchanged in shape: compare before writing.
--    Same function signature, same result, same rows READ; the only difference
--    is that rows which do not change are not rewritten.
--
--    Honest scope: this removes a write amplifier and a bloat source. It is NOT
--    on its own proof that the 08-11 blowup was visibility-driven — see the
--    audit's "what this does not establish" section. The falsifiable prediction
--    is recorded there.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_spending_totals()
RETURNS void
LANGUAGE sql
AS $function$
  UPDATE public.financial_entities fe
  SET
    total_contract_cents = COALESCE(agg.contract_sum, 0),
    total_grant_cents    = COALESCE(agg.grant_sum, 0)
  FROM (
    SELECT
      to_id,
      SUM(CASE WHEN relationship_type = 'contract' THEN amount_cents ELSE 0 END) AS contract_sum,
      SUM(CASE WHEN relationship_type = 'grant'    THEN amount_cents ELSE 0 END) AS grant_sum
    FROM public.financial_relationships
    WHERE relationship_type IN ('contract', 'grant')
    GROUP BY to_id
  ) agg
  WHERE fe.id = agg.to_id
    -- FIX-1027 skip-unchanged (FIX-1008 idiom): 127,728 rows matched on prod
    -- 2026-08-12, 0 of them with a changed value.
    AND (fe.total_contract_cents IS DISTINCT FROM COALESCE(agg.contract_sum, 0)
      OR fe.total_grant_cents    IS DISTINCT FROM COALESCE(agg.grant_sum, 0));
$function$;

COMMENT ON FUNCTION public.refresh_spending_totals() IS
  'Recomputes financial_entities.total_contract_cents / total_grant_cents from '
  'financial_relationships. FIX-1027: only rows whose value actually changes are '
  'written (measured 127,728 matched / 0 changed on prod 2026-08-12), so the '
  'weekly refresh no longer bloats the table its own MVs index-only-scan.';

-- ── 3b. financial_entities' vacuum owner fires BEFORE the write it cleans ──
-- jobid 30 (fe-vacuum-analyze) runs '0 2 * * 0,3' — Sunday and Wednesday 02:00.
-- The Sunday firing precedes the Sunday FEC ingest (15:55 / 22:28 observed) by
-- ~14 h, so financial_entities goes into Monday and Tuesday carrying the whole
-- weekend's churn and is not cleaned until Wednesday 02:00. The weekly MV job
-- runs Tuesday 07:00 — the single furthest point in that cycle from a vacuum.
--
-- Adding Monday is additive and cheap (the job measured 61.4 s on 08-12 and
-- 73.3 s on 08-09). The Sunday firing is deliberately KEPT: it covers Saturday
-- fec-backfill dispatches, which are a real write path.
--
-- alter_job by NAME (playbook D3) rather than unschedule+schedule: jobid 30 has
-- cron.job_run_details history worth preserving — it is the receipt this whole
-- diagnosis rests on.
DO $$
DECLARE
  v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'fe-vacuum-analyze';
  IF v_id IS NOT NULL THEN
    PERFORM cron.alter_job(v_id, schedule := '0 2 * * 0,1,3');
    RAISE NOTICE '[fix1027] fe-vacuum-analyze (jobid %) -> 0 2 * * 0,1,3 (added Monday)', v_id;
  ELSE
    RAISE NOTICE '[fix1027] fe-vacuum-analyze not present — skipping (local/dev)';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Re-enable the two jobs paused during the 2026-08-11 incident response.
--
--    jobids 2 (rebuild-ec-incremental, Wed 08:00) and 16
--    (entity-connection-stats-rebuild, Mon+Wed 11:00) were paused by hand at
--    ~23:30 UTC on 08-11 to give the box a clean Wednesday. That Wednesday is
--    now on the record and it was clean — every one of the 08-12 firings
--    succeeded, including all six FIX-1003 arm vacuums at 11:05-11:18, which
--    had been 0-for-12 lifetime. Their next natural fires are next week, so
--    they go back to active here.
--
--    jobid 10 (refresh-derived-mvs-weekly) STAYS PAUSED and is deliberately not
--    touched below. Its next natural fire is Tue 2026-08-18; re-enabling it is
--    gated on the budget in section 1 being verified against a real firing, and
--    that is a decision for a later session with the evidence in hand.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_job  text;
  v_id   bigint;
BEGIN
  FOREACH v_job IN ARRAY ARRAY['rebuild-ec-incremental', 'entity-connection-stats-rebuild'] LOOP
    SELECT jobid INTO v_id FROM cron.job WHERE jobname = v_job;
    IF v_id IS NOT NULL THEN
      PERFORM cron.alter_job(v_id, active := true);
      RAISE NOTICE '[fix1022] re-enabled % (jobid %)', v_job, v_id;
    END IF;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. FIX-943 compliance for THIS migration.
--
--    Nothing here bulk-rewrites a table — sections 1 and 3a replace routine
--    bodies, section 2 and 3b are catalog and cron rows. The one-shot
--    VACUUM (ANALYZE) of financial_relationships and officials that the
--    diagnosis needed was run OUT OF BAND on prod before this migration (VACUUM
--    cannot run inside a migration's transaction), and its before/after is
--    recorded in section 2's header and in the audit. From here the Monday jobs
--    own it.
-- ─────────────────────────────────────────────────────────────────────────────
