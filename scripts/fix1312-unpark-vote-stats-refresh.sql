-- =============================================================================
-- FIX-1312 (cc-226) ROLLBACK — un-park vote-stats-refresh.
--
-- The mirror of supabase/migrations/20261014220000_fix1312_park_vote_stats_refresh.sql.
-- NOT a migration: it is a payload for the --call path, run only on a decision
-- to abandon the cutover:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1312-unpark-vote-stats-refresh.sql
--
-- (under a FIX-950 claim, like any other prod write).
--
-- Valid only before the job's return. Once vote-stats-refresh has come back
-- through job_registry, un-parking it by cron would make it dual-owned.
--
-- It mirrors PROD: the job read active there before the park (2026-10-15
-- ~02:00Z). The local clone's cron.job is local history (FIX-946).
--
-- By NAME (FIX-946): a missing or duplicated name RAISEs. A name already
-- active is a no-op. The hold row is deleted by its hold_reason, so a human
-- declaration on the same pipeline is never touched, and FIX-1311's cc-232
-- rows are not matched.
-- =============================================================================

DO $$
DECLARE
  c_reason_like CONSTANT text := 'parked for the dispatcher cutover (cc-226%';
  c_jobs CONSTANT text[] := ARRAY[
    'vote-stats-refresh'
  ];
  v_name    text;
  v_n       int;
  v_jobid   bigint;
  v_active  boolean;
  v_rows    int;
BEGIN
  FOREACH v_name IN ARRAY c_jobs LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1312-unpark] % cron.job rows named % — expected exactly 1', v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF NOT v_active THEN
      PERFORM cron.alter_job(job_id := v_jobid, active := true);
      RAISE NOTICE '[fix1312-unpark] re-activated % (jobid %)', v_name, v_jobid;
    END IF;
  END LOOP;

  DELETE FROM public.rollup_watch_overrides WHERE hold_reason LIKE c_reason_like;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '[fix1312-unpark] % hold row(s) removed', v_rows;
END $$;
