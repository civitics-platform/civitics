-- FIX-1129 / FIX-1109 — the weekly derived-MV refresh comes back bounded.
--
-- jobid 10 (refresh-derived-mvs-weekly) has been PAUSED since 2026-08-31. Its
-- family killed or starved prod three times (08-11 weekly, 08-29 daily, 08-31
-- daily). FIX-1129 set four preconditions on its return; this migration is the
-- schema half of them, measured rather than assumed.
--
-- ── THE HONEST HISTORY (prod, read 2026-09-04) ──────────────────────────────
-- FIX-1129 step 1 said "there is no clean unit_seconds history". There is
-- exactly one, and it is the post-FIX-1030 run — 2026-08-13 04:50, 707.1s,
-- status complete, all six units:
--
--   chord_industry_flows_mv           185.7      chord_subject_party_flows_mv     2.8
--   chord_donor_type_party_flows_mv   128.0      official_sector_dollars_mv     112.1
--   chord_donor_state_party_flows_mv  160.3      refresh_spending_totals        118.2
--
-- The only firing since was 2026-08-25 07:00 — 1361.8s, status failed:
--
--   chord_industry_flows_mv           868.8      chord_subject_party_flows_mv     5.6
--   chord_donor_type_party_flows_mv    31.8 FAIL official_sector_dollars_mv      79.6
--   chord_donor_state_party_flows_mv  214.7      refresh_spending_totals        161.1
--
-- Two things in that row drive this migration. Unit 2 died on a shared-memory
-- resize. And unit 1 took 868.8s against 185.7s twelve days earlier for the
-- same work — a 4.7x spread that is contention, not data growth, because it
-- fired at 07:00 inside the 06:00 daily's stack.
--
-- ── FINDING 2 (FIX-1109): IT IS A PARALLEL HASH JOIN'S DSM SEGMENT ──────────
--   chord_donor_type_party_flows_mv: could not resize shared memory segment
--   "/PostgreSQL.3323093180" to 134217728 bytes: No space left on device
--
-- 134217728 is 128MB, which is exactly the work_mem the procedure sets. The
-- prod plan for unit 2 (EXPLAIN, 2026-09-04) explains the ask:
--
--   Parallel Hash Left Join  (Hash Cond: fr.from_id = fe.id)
--     ->  Parallel Hash  (rows=3061003 width=26)
--           ->  Parallel Seq Scan on financial_entities fe
--
-- A Parallel Hash builds in a DSM segment — shared memory, not the backend's
-- own. 3.06M rows at width 26 plus tuple overhead is what asks to grow to
-- 128MB, and the instance's shm could not give it. Unit 1 carries the same
-- node at width 16; units 3-6 carry none (unit 3 because FIX-1030 already
-- fenced it, units 4-6 because they never touch financial_entities that way).
--
-- REPRODUCED, then fixed, on the prod-scale clone (FR 10.4M, FE 3.68M):
--
--   unit                                mpwpg=1              mpwpg=0
--   chord_industry_flows_mv             57.3s (cold)         24.2s
--   chord_donor_type_party_flows_mv     FAILS, same error    32.2s
--   chord_donor_state_party_flows_mv    24.2s                24.2s
--   chord_subject_party_flows_mv         1.2s                 1.2s
--   official_sector_dollars_mv           2.4s                 2.4s
--   refresh_spending_totals             15.6s                15.6s
--
-- So parallelism off is not a speed trade here. It is strictly better on the
-- two units that have a Gather at all, identical on the four that do not, and
-- it removes the failure class by construction: a non-parallel Hash Join keeps
-- its build in PRIVATE memory bounded by work_mem x hash_mem_multiplier
-- (128MB x 2 = 256MB) and spills to disk in batches rather than failing.
--
-- NOT FENCED, deliberately. FIX-1129 authorised a FIX-1030-style MATERIALIZED
-- CTE on units 1 and 2 "only where the plan shows the flip". It does not: the
-- FIX-1030 signature is a Nested Loop with Memoize over financial_entities_pkey
-- driven by the FR outer, and both units plan a bounded Hash Join at every
-- setting measured, on prod and on the clone, with Batches: 1. A fence here
-- would be a rewrite of two MVs to fix something neither of them has.
--
-- ── FINDING 1 (FIX-1109): A FAILED UNIT DID NOT FAIL THE CALL ───────────────
-- The 08-25 run is the receipt. data_sync_log says failed; cron.job_run_details
-- runid 15272 says SUCCEEDED. The loop catches WHEN OTHERS, records the
-- failure, CONTINUEs, writes a terminal row saying 'failed' — and then returns
-- normally, because no path in the body re-raises. Everything downstream that
-- keys on pg_cron's verdict (check_cron_job_health(), FIX-1073's tiers) was
-- blind to it. Fixed below, for BOTH cadences since it is one body. 'partial'
-- still returns normally: a budget stop or a watchdog cancel is this system's
-- own decision working as designed, not an error to report upward.
--
-- ── THE SLOT (FIX-1141 rule) ────────────────────────────────────────────────
-- Tuesday startup-timeout rate by UTC hour, prod, last 56 days:
--   00-05  0.0 0.0 0.0 0.0 0.5 0.0    |  06-11  21.5 16.8 16.9 26.3 18.7 20.0
--   12-17 35.3 47.3 31.3 23.2 18.7 17.7 |  18-23  2.7 0.0 0.0 0.0 0.0 3.8
--
-- 07:00 sits at 16.8% and inside the 05:45-09:00 ec-crawl blackout, 60 minutes
-- behind a daily that ran 1394s on 09-01. It also shares ONE advisory lock with
-- that daily, so a daily still running at 07:00 makes the weekly log 'skipped'
-- and lose the week entirely. Moving to hour 00 (0.0% over 154 Tuesday runs)
-- ends all three problems at once.
--
-- Minute 47, not 35: jobid 25 (agency-staffing) now fires Tue 00:05 and its
-- longest observed run is 1183.3s, so 00:35 could be inside it — and its first
-- post-FIX-987 firing on 2026-09-08 takes the full path. 00:47 clears it by
-- 22 minutes even at that maximum. 47 is odd (clears the */2 watchdogs), is not
-- a multiple of 15 or 30 (clears ec-crawl and fe-crawl), and 00:47 + the 707s
-- clean run finishes well before the 02:00 UTC Vercel nightly-sync.
--
-- ── THE BUDGET ROW ─────────────────────────────────────────────────────────
-- FIX-1063 deliberately excluded both derived-MV jobs, on the grounds that two
-- cancellers on one backend is a race. FIX-1123 then added the daily's row at
-- 5400s anyway, and the daily has run under both cancellers since 09-01 with
-- the per-unit watchdog firing first, as designed. That precedent settles it;
-- the weekly gets the matching row.
--
-- Cross-ref FIX-1030 (the unit watchdog and unit 3's fence), FIX-1021, FIX-1063,
-- FIX-1073, FIX-1123, FIX-1124, FIX-1125, FIX-1141. FIX-966 (unit 3 cancelled at
-- 1200s on 08-05) is closed by the FIX-1030 fence, which this run re-proves.
--
-- Fixes: FIX-1129, FIX-1109
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE PROCEDURE public.refresh_derived_mvs(IN p_cadence text)
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
  -- FIX-1030 addition
  c_unit_budget int;                     -- seconds; per-UNIT, enforced externally
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

  -- FIX-1109 finding 2 / FIX-1129: parallel workers OFF for the weekly cadence.
  -- The weekly's units 1 and 2 both build a hash over the whole of
  -- financial_entities (3.06M rows; width 16 for unit 1, width 26 for unit 2).
  -- Under a Parallel Hash Join that build lives in a DYNAMIC SHARED MEMORY
  -- segment, and on 2026-08-25 unit 2's segment could not grow:
  --   could not resize shared memory segment "/PostgreSQL.3323093180"
  --   to 134217728 bytes: No space left on device
  -- 134217728 = 128MB = exactly the work_mem set above, and 3.06M x 26 bytes
  -- plus tuple overhead is what asks for it. Reproduced on the prod-scale clone
  -- (2026-09-03): unit 2 at max_parallel_workers_per_gather=1 fails with the
  -- same error, and at 0 completes in 32.2s.
  --
  -- With no parallelism the same join becomes a plain Hash Join whose build is
  -- PRIVATE backend memory, bounded by work_mem x hash_mem_multiplier
  -- (128MB x 2 = 256MB) and permitted to spill to disk in batches instead of
  -- failing. Measured on the clone, this is not a speed trade: unit 1 ran
  -- 24.2s at 0 against 57.3s at 1, and units 3-6 plan identically either way.
  --
  -- Weekly ONLY. The daily cadence is untouched: none of its units joins
  -- financial_entities and it has never hit this failure class.
  IF p_cadence = 'weekly' THEN
    SET max_parallel_workers_per_gather = 0;
  END IF;

  -- FIX-1021: per-cadence budget. Measured 2026-08-12: work_mem is NOT the
  -- lever here (unit 1 measured 185 s at 256MB vs 198 s at 128MB, identical
  -- plan), so this stays as FIX-748 set it.
  c_budget := CASE p_cadence WHEN 'weekly' THEN 4200 ELSE 3300 END;
  v_budget_cfg := NULLIF(current_setting('civitics.derived_mvs_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := v_budget_cfg;
  END IF;

  -- FIX-1030: per-UNIT budget. Published for enforce_derived_mvs_unit_budget(),
  -- which runs in a different session and cannot read this session's GUC.
  -- NOTE: this procedure cannot enforce it itself — statement_timeout is armed
  -- once at CALL time and neither SET nor SET LOCAL re-arms it across a
  -- procedure's COMMIT (verified on PG 17; see the header and FIX-703).
  c_unit_budget := COALESCE(
    NULLIF(current_setting('civitics.derived_mvs_unit_budget_seconds', true), '')::int, 900);

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
                             'unit_budget_seconds', c_unit_budget,
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

    -- FIX-1030: publish the in-flight unit and COMMIT, so
    -- enforce_derived_mvs_unit_budget() — running in another session, on its
    -- own pg_cron cadence — can see WHICH unit is running, since when, and in
    -- which backend. Without this commit the watchdog sees nothing: everything
    -- this transaction writes is invisible to it until the unit ends, which is
    -- exactly the case it exists to handle.
    UPDATE public.data_sync_log
    SET metadata = metadata || jsonb_build_object(
                     'current_unit',            v_label,
                     'current_unit_index',      i,
                     'current_unit_started_at', v_unit_beg,
                     'backend_pid',             pg_backend_pid())
    WHERE id = v_log_id;
    COMMIT;

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
      -- FIX-1030: this is now also the landing point for the unit watchdog's
      -- cancel, which is why that watchdog needs no error path of its own.
      WHEN query_canceled THEN
        v_canceled := format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — CANCELED (statement_timeout, unit watchdog, or operator cancel): %', v_label, SQLERRM;
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
      -- FIX-1030: strip the in-flight publish keys, so a terminal row never
      -- looks like it is mid-unit to the watchdog or to a human reading it.
      metadata      = (metadata
                        - 'current_unit' - 'current_unit_index'
                        - 'current_unit_started_at' - 'backend_pid')
                      || jsonb_build_object(
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

  -- FIX-1109 finding 1: a failed unit must fail the CALL.
  -- Until now this procedure returned normally on EVERY path, so a run whose
  -- own data_sync_log row said 'failed' was recorded by pg_cron as
  -- 'succeeded' (prod, jobid 10, 2026-08-25: runid 15272 succeeded / 1361.9s,
  -- while the sync row for the same run says failed on
  -- chord_donor_type_party_flows_mv). That hid the failure from
  -- cron.job_run_details, from check_cron_job_health() and from FIX-1073's
  -- escalation tiers -- every consumer that keys on pg_cron's own verdict.
  --
  -- Order matters: COMMIT makes the terminal row durable, and the advisory
  -- unlock is session-scoped (not transactional), so both survive the raise.
  -- Raising before either would roll the terminal UPDATE back and strand the
  -- lock, which is the failure mode this is meant to end, not start.
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);

  -- 'partial' deliberately does NOT raise: a budget stop and a watchdog cancel
  -- are this system's own decisions, already recorded in the row, and pg_cron
  -- should not be told that its job errored when the bound worked as designed.
  IF v_status = 'failed' THEN
    RAISE EXCEPTION '[derived-mvs] % of % unit(s) FAILED (cadence=%): %',
      COALESCE(array_length(v_failures, 1), 0), array_length(v_units, 1),
      p_cadence, array_to_string(v_failures, '; ');
  END IF;
END;
$procedure$;

-- Supabase default-grants EXECUTE to anon/authenticated on CREATE. This is a
-- REPLACE so the existing ACL survives, but re-assert it: this procedure is
-- pg_cron-only and must never be reachable from PostgREST.
REVOKE ALL ON PROCEDURE public.refresh_derived_mvs(text) FROM PUBLIC;
REVOKE ALL ON PROCEDURE public.refresh_derived_mvs(text) FROM anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_derived_mvs(text) TO service_role;

-- ── FIX-1129 step 3: the outside bound ──────────────────────────────────────
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES (
  'refresh-derived-mvs-weekly',
  5400,
  'FIX-1129. Backstop ABOVE the procedure''s own 4200s predictive budget, which '
  'is checked between units and cannot bound one. Clean run 707s (2026-08-13, '
  'six units); worst unit ever recorded 868.8s (unit 1, 2026-08-25, under the '
  '06:00 daily''s contention). FIX-1063 excluded this job because "two '
  'cancellers on one backend is a race"; FIX-1123 overruled that for the daily '
  'and the daily has run under both since 09-01 with the per-unit watchdog '
  'firing first. Cannot fire under fork starvation — FIX-1125.'
)
ON CONFLICT (jobname) DO UPDATE
  SET budget_seconds = EXCLUDED.budget_seconds,
      note           = EXCLUDED.note,
      updated_at     = now();

-- ── FIX-1129 step 3: out of the 06:00 stack ─────────────────────────────────
-- alter_job BY NAME (playbook D3), never unschedule+schedule: every number in
-- the header comes from this job's cron.job_run_details history, which is keyed
-- on jobid. Rescheduling would mint a new jobid and orphan all of it.
--
-- The job stays INACTIVE here. FIX-1129 step 4 is one supervised hand-fired
-- CALL first; only a 'complete' with six unit_seconds earns the re-enable, and
-- that is done from the session, not from this migration.
DO $$
DECLARE
  c_jobname CONSTANT text := 'refresh-derived-mvs-weekly';
  c_new     CONSTANT text := '47 0 * * 2';
  v_id      bigint;
  v_old     text;
  v_active  boolean;
BEGIN
  SELECT jobid, schedule, active INTO v_id, v_old, v_active
    FROM cron.job WHERE jobname = c_jobname;

  IF v_id IS NULL THEN
    -- Not an error: a fresh local DB may not carry the cron catalogue yet.
    RAISE WARNING '[fix1129] job % not found — skipped', c_jobname;
    RETURN;
  END IF;

  PERFORM cron.alter_job(v_id, schedule := c_new);
  RAISE NOTICE '[fix1129] % (jobid %) -> % (was %); active stays %',
    c_jobname, v_id, c_new, v_old, v_active;
END $$;

-- Post-move guard (FIX-1141). Each clause is one of the placement constraints
-- argued for in the header, so a future edit that breaks one stops here rather
-- than quietly landing the job back in a starved minute.
DO $$
DECLARE
  c_jobname CONSTANT text := 'refresh-derived-mvs-weekly';
  v_sched   text;
  v_min     int;
  v_hour    int;
  v_clash   int;
BEGIN
  SELECT schedule INTO v_sched FROM cron.job WHERE jobname = c_jobname;
  IF v_sched IS NULL THEN
    RAISE NOTICE '[fix1129] job absent — guard skipped';
    RETURN;
  END IF;

  v_min  := split_part(v_sched, ' ', 1)::int;
  v_hour := split_part(v_sched, ' ', 2)::int;

  -- The quiet band: 18:00-05:59 UTC, measured at 0.0-3.8% startup timeouts.
  IF NOT (v_hour >= 18 OR v_hour <= 5) THEN
    RAISE EXCEPTION '[fix1129] % lands at hour % — outside the measured quiet band (18-05 UTC)',
      c_jobname, v_hour;
  END IF;

  -- Odd minute clears the */2 watchdogs (jobids 40, 44).
  IF v_min % 2 = 0 THEN
    RAISE EXCEPTION '[fix1129] % lands on even minute % — collides with the */2 watchdogs',
      c_jobname, v_min;
  END IF;

  -- Clear of ec-crawl (*/15) and fe-crawl (*/30).
  IF v_min % 15 = 0 THEN
    RAISE EXCEPTION '[fix1129] % lands on minute % — collides with ec-crawl/fe-crawl',
      c_jobname, v_min;
  END IF;

  -- Clear of jobid 25 (agency-staffing, Tue 00:05, max observed 1183.3s).
  IF v_hour = 0 AND v_min < 27 THEN
    RAISE EXCEPTION '[fix1129] % at 00:% can overlap agency-staffing-rollup-refresh (00:05, max 1183s)',
      c_jobname, v_min;
  END IF;

  -- No other ACTIVE job may hold the same schedule string.
  SELECT count(*) INTO v_clash FROM cron.job
   WHERE active AND jobname <> c_jobname AND schedule = v_sched;
  IF v_clash > 0 THEN
    RAISE EXCEPTION '[fix1129] % active job(s) already hold schedule %', v_clash, v_sched;
  END IF;

  RAISE NOTICE '[fix1129] post-move guard passed — % now at % (hour %, minute %)',
    c_jobname, v_sched, v_hour, v_min;
END $$;
