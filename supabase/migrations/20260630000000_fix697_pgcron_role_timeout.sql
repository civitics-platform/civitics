-- FIX-697 — make the pg_cron entity_connections rebuild survive its own COMMITs.
--
-- Symptom: the `rebuild-ec-full` pg_cron job (FIX-688) died after exactly 2 min
-- on its first prod firing (2026-06-29 08:00 UTC):
--   ERROR: canceling statement due to statement timeout
--   in rebuild_ec_donations_full_window  →  run_entity_connections_rebuild
--
-- Root cause: pg_cron runs both rebuild jobs as the `postgres` role (cron.job
-- .username = 'postgres', set at schedule time). The prod cluster-default
-- statement_timeout is 2 min (pg_settings.reset_val = 120000ms) and the
-- `postgres` role sets none of its own, so each cron session inherits 2 min.
-- The procedure's top-of-body `SET statement_timeout='90min'` (and the chunk
-- functions' proconfig caps, and the `SET work_mem='256MB'` from FIX-588) are
-- SESSION GUCs that DO NOT survive the procedure's per-chunk COMMITs: after the
-- first COMMIT every GUC reverts to its reset_val (the role/cluster default),
-- so the first heavy donations window — which needs tens of minutes — is killed
-- at the 2-min default and the procedure aborts before its terminal sync-log
-- UPDATE.
--
-- Fix: set the durable DEFAULTS on the `postgres` role itself, so the COMMIT
-- revert lands on 90min / 256MB instead of 2min / the tiny cluster default.
-- This is bulletproof regardless of whether the in-procedure SET / proconfig
-- survive, and it also fixes PR2's future pg_cron MV-refresh procedures, which
-- would hit the identical COMMIT-revert.
--
-- Safety — this is NOT the FIX-589 / FIX-505 request-path hazard. That hazard
-- is about raising anon / authenticated / authenticator / service_role (the
-- roles PostgREST and the admin client connect as). Audited on prod 2026-06-30:
-- the request path runs as `authenticator`; the ONLY `postgres` sessions are
-- pg_cron jobs, migrations, and Supavisor's own pooler tenant connection — the
-- app never connects as `postgres`. So a 256MB work_mem / 90min timeout default
-- on `postgres` only affects cron + migration sessions (one heavy rebuild at a
-- time under the procedure's advisory lock), never the cache-starved request
-- path.

ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '90min';
ALTER ROLE postgres IN DATABASE postgres SET work_mem          = '256MB';

-- ── Pause both rebuild jobs until the FIX-677 backfill data is clean ─────────
-- The current prod financial_relationships holds PARTIAL + double-counted JFC
-- individual receipts (FIX-698): the cancelled 2024 indiv backfill wrote JFC
-- individual→committee rows that are invisible only because the received-totals
-- rebuild has not run. With FIX-697 applied, the next scheduled firing
-- (Wed 08:00 UTC, rebuild-ec-incremental) would SUCCEED and reconcile that
-- dirty data into entity_connections donation edges. Pause both jobs now; the
-- FIX-677 finish-runbook re-enables them (UPDATE cron.job SET active = true …)
-- after the corrected backfill + JFC stale-row cleanup + first clean
-- reconciliation. Reversible, no data effect.
--
-- Direct DML on cron.job is not granted to the migration role (permission
-- denied) — pg_cron exposes cron.alter_job for this. Look the jobs up by name
-- (jobids differ local vs prod) and flip active := false.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('rebuild-ec-full', 'rebuild-ec-incremental')
  LOOP
    PERFORM cron.alter_job(job_id := r.jobid, active := false);
  END LOOP;
END $$;
