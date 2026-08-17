-- FIX-1052 — move the two job families that start INSIDE the EC rebuild's
-- 6h window out of it.
--
-- EVIDENCE (prod, 2026-08-17, cc-prompt-63 phase 0):
--
--   jobid 22 rebuild-ec-incremental-mon   08:00 -> 14:00  (21,615s = the 6h
--                                         statement_timeout ceiling exactly,
--                                         FIX-985; data_sync_log status=partial,
--                                         4,011,180 rows, 'canceled')
--   jobid 24 donor-rollup-refresh         09:00 -> 10:50  (partial, budget
--                                         exhausted — by design, FIX-1002/1021)
--
--   INSIDE that window, all failing with pg_cron 'job startup timeout':
--   jobid 16 entity-connection-stats-rebuild  11:00  failed after 10s
--   jobids 32..37 vacuum wave                 11:05  failed
--                                             11:10-11:16 succeeded but at
--                                             30-90x normal duration
--                                             (93s/33s/60s vs 0-2s)
--                                             11:18  failed
--   jobid 24 donor-rollup-refresh             12:00  failed
--   jobids 32..37 vacuum wave                 14:05-14:18  ALL SIX failed
--
-- 191 'job startup timeout' failures 08-10..08-17. Only THREE real statement
-- timeouts in the same span (08-10 08:00, 08-10 09:00, 08-11 07:00) — the
-- burst was worker-launch starvation, not query cancellation.
--
-- HONEST LIMIT OF THIS MIGRATION. The failure window runs 09:xx to 16:08 and
-- therefore OUTLASTS both heavy jobs by over two hours; nothing in
-- data_sync_log runs 14:00-16:08, and the baseline bgworker count (3: pg_cron
-- launcher, pg_net, logical replication launcher) is nowhere near
-- max_worker_processes=12. So these moves are NECESSARY BUT LIKELY NOT
-- SUFFICIENT. The resource actually exhausted in the tail is not established
-- from catalog evidence and needs the Supabase Analytics postgres logs. Do not
-- read a still-failing 14:0x slot next Monday as "the moves did not work" —
-- read it as the tail, which is a separate open question.
--
-- Monday 2026-08-17 was also the FIRST REAL TEST of max_worker_processes=12
-- with jobid 16 active (the 2026-08-12 audit named exactly this test, and noted
-- Wednesday 08-12 was confounded because jobids 2 and 16 were paused by hand).
-- jobid 16 failed it. mwp=12 is live and did not clear the contention.
--
-- LOCK-SPLIT CONSTRAINT (FIX-1033): nothing here touches jobid 9
-- (refresh-derived-mvs-daily) or jobid 10 (refresh-derived-mvs-weekly). Those
-- two still share one advisory lock, so the unit watchdog's single-slot
-- in-flight state stays safe and per-run keying is NOT yet required.
--
-- alter_job by NAME (playbook D3) rather than unschedule+schedule: these jobs
-- have cron.job_run_details history that the whole diagnosis rests on, and
-- rescheduling would reset their jobids and orphan it.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. entity-connection-stats-rebuild: 0 11 * * 1,3 -> 0 16 * * 1,3
--
--    This is a CORRECTNESS move as much as a contention one. The job reads
--    entity_connections, and at 11:00 the rebuild is still three hours from its
--    ceiling — so the job is both starved of a worker AND, when it does run,
--    reading a half-rebuilt table. 16:00 is clear of the 14:00 ceiling with two
--    hours of margin.
--
--    Kept on Mon+Wed. Its dependency on the rebuild is unchanged; only the
--    ordering is now actually honoured.
DO $$
DECLARE
  v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'entity-connection-stats-rebuild';
  IF v_id IS NOT NULL THEN
    PERFORM cron.alter_job(v_id, schedule := '0 16 * * 1,3');
    RAISE NOTICE '[fix1052] entity-connection-stats-rebuild (jobid %) -> 0 16 * * 1,3 (was 0 11 * * 1,3)', v_id;
  ELSE
    RAISE NOTICE '[fix1052] entity-connection-stats-rebuild not present — skipping (local/dev)';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The afternoon vacuum wave: 14:05-14:18 -> 17:05-17:18
--
--    14:0x sits exactly on the EC rebuild's cancel-and-rollback exit. The wave
--    went 0-for-6 on Monday 08-17. Each job keeps its relative offset so the
--    staggering (which exists to keep them off each other) is preserved.
--
--    The MORNING wave at 11:05-11:18 is deliberately LEFT ALONE: it is the
--    slot that partially survives, and moving both waves would leave the
--    tables with no vacuum owner across the whole afternoon. Revisit once the
--    14:00-16:08 tail is explained.
DO $$
DECLARE
  v_id  bigint;
  v_row record;
BEGIN
  FOR v_row IN
    SELECT * FROM (VALUES
      ('odr-mv-vacuum-analyze',              '5 11,17 * * *'),
      ('treemap-individuals-vacuum-analyze', '10 11,17 * * *'),
      ('odt-vacuum-analyze',                 '12 11,17 * * *'),
      ('osdr-vacuum-analyze',                '14 11,17 * * *'),
      ('osar-vacuum-analyze',                '16 11,17 * * *'),
      ('odbt-vacuum-analyze',                '18 11,17 * * *')
    ) AS t(jobname, schedule)
  LOOP
    SELECT jobid INTO v_id FROM cron.job WHERE jobname = v_row.jobname;
    IF v_id IS NOT NULL THEN
      PERFORM cron.alter_job(v_id, schedule := v_row.schedule);
      RAISE NOTICE '[fix1052] % (jobid %) -> %', v_row.jobname, v_id, v_row.schedule;
    ELSE
      RAISE NOTICE '[fix1052] % not present — skipping (local/dev)', v_row.jobname;
    END IF;
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FIX-943 compliance.
--
--    Nothing here rewrites a table — this migration only mutates cron.job
--    schedule strings. No VACUUM tail required.
