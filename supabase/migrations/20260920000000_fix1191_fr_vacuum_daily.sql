-- ─────────────────────────────────────────────────────────────────────────────
-- FIX-1191 — financial_relationships gets a DAILY vacuum owner.
--
--   fr-vacuum-analyze   0 1 * * 1  (Mon 01:00)  ->  0 3 * * *  (daily 03:00)
--
-- THE MEASUREMENT (prod, 2026-09-19 17:46–17:58 UTC, one window, stated per
-- rule 127)
-- ---------------------------------------------------------------------------
-- Three tables, same instance, same instant. Two have had a DAILY vacuum owner
-- since FIX-1152; the third is on a weekly one.
--
--   relation                  owner cadence      n_dead_tup   pct_all_visible
--   entity_connections        daily 04:30                 0            100.00
--   financial_entities        daily 04:50                 0            100.00
--   financial_relationships   weekly Mon 01:00      212,083             82.74
--
-- That is the whole argument. FR is not decaying because it is written harder
-- than the other two — EC took 1,450,064 deletes over the same stats epoch to
-- FR's 124,715 — it is decaying because nothing collects it for six days.
--
-- WHAT last_vacuum SAYS, AND WHY IT SAYS NOTHING
-- ----------------------------------------------
-- pg_stat_user_tables.last_vacuum is NULL for FR and vacuum_count is 0. That is
-- NOT evidence the weekly owner is broken. Prod restarted at
-- 2026-09-15 15:09:48 UTC (pg_postmaster_start_time(), which is also where
-- pg_stat_statements_info.stats_reset points), and the restart discarded the
-- cumulative statistics file. The weekly owner's last firing was BEFORE it:
-- cron.job_run_details — a table, so it survived — records fr-vacuum-analyze
-- succeeding at 2026-09-14 01:00:00 -> 01:03:20 UTC.
--
-- So the correct reading of vacuum_count = 0 is the harsher one: FR has had NO
-- vacuum, manual or auto, in the 4 days 2 h 41 m since the restart, and its next
-- scheduled collection is Monday 2026-09-21 01:00 — six and a half days after
-- it. autovacuum_count is 0 for the reason below.
--
-- WHY AUTOVACUUM IS NOT THE BACKSTOP
-- ----------------------------------
-- FR carries autovacuum_vacuum_scale_factor=0.02 (already tuned down from the
-- 0.2 default by FIX-943). On 14,469,877 reltuples that is a trigger at
-- ~289,448 dead. FR is sitting at 212,083 — 77,365 BELOW it, which is ~36 h of
-- headroom at the ~2,149 dead/h this epoch has averaged. Autovacuum is
-- therefore structurally unable to reach FR inside a normal week: the weekly
-- vacuum resets the counter just before autovacuum would have tripped. The
-- table spends the week in the gap between the two mechanisms, which is exactly
-- where 82.74% all-visible comes from.
--
-- WHY THE VISIBILITY MAP AND NOT THE DEAD-TUPLE COUNT IS THE COST
-- --------------------------------------------------------------
-- A heap page loses its all-visible mark if ANY tuple on it is dead, and FR
-- carries ~22.9 tuples per page (14.47M tuples / 631,265 pages). So 1.5% dead
-- tuples has un-marked 17.3% of the heap, and every index-only scan over that
-- 17.3% silently degrades to a per-row heap fetch. That is FIX-884's shape
-- (0.9% all-visible -> 34,534 heap fetches, 20.5 s of a 22.1 s query) and
-- FIX-943's (a 600 s statement_timeout blown by ~260k dead tuples, and met
-- again after a vacuum).
--
-- WHY THIS AND NOT THE OTHER TWO OPTIONS ON THE BULLET
-- ---------------------------------------------------
-- * A one-shot VACUUM scheduled by the rewrite script itself. REJECTED: it is a
--   SECOND scheduling mechanism for one table, owned by whichever script last
--   touched it, and the FIX-943 convention deliberately hands the vacuum to
--   "the scheduled owner" precisely so there is ONE. The scripts already do the
--   right thing — --defer-tails names fr-vacuum-analyze as the owner. The only
--   thing wrong is how often that owner runs.
-- * Lowering autovacuum_vacuum_scale_factor further (0.02 -> ~0.005). REJECTED,
--   same reason FIX-1152 rejected it for EC: autovacuum keys on dead tuples,
--   not on the visibility map, and it would fire at prod's hour of its choosing
--   — cost-delay-throttled, sweeping FR's 18 indexes (FIX-1133) across the
--   request path on a 256MB-shared_buffers box. That is the FIX-1144 shape by
--   another door. 0.02 stays.
--
-- THE SLOT, AND WHAT IT WAS SIZED AGAINST
-- ---------------------------------------
-- 03:00 UTC daily. Four constraints, each read rather than assumed:
--
-- * AFTER the nightly's tail, including on drop nights. nightly.yml's last four
--   long runs ended 2026-09-13 00:15 and 2026-09-14 00:31 UTC; ordinary
--   weeknights end 23:04–23:38. 03:00 clears the worst observed tail by 2 h 29 m.
-- * BEFORE the 04:15–05:00 band, which is abuse-events-retention (04:15),
--   ec-vacuum-analyze (04:30) and fe-vacuum-analyze (04:50). Two VACUUMs at once
--   is two background workers on an I/O-bound instance — FIX-1152's
--   SEQUENTIAL-NOT-CONCURRENT rule applies to the third table as well.
-- * Inside a clean startup-timeout hour. FIX-1124's histogram (rule 16) measures
--   hour 03 at 0.0% of firings lost to "job startup timeout", one of five clean
--   hours; hour 06 — the daily's own — is 9.2%.
-- * Clear of its neighbours by more than its measured wall. fr-vacuum-analyze's
--   last 30 days: 4 firings, min 11.6 s, median 110.5 s, max 227.2 s, zero
--   failures. Worst case 03:03:47. The nearest daily neighbour is
--   vote-stats-refresh at 03:30 (26 min of clearance) and the nearest weekly one
--   group-donor-rollup-refresh at Wed 03:10 (6 min). Under a DAILY cadence each
--   run has one day of churn to collect rather than seven, so the 227.2 s tail —
--   which was a six-day backlog — should shrink, not grow.
--
-- NOT TAKEN HERE: a second EC slot. The FIX-1191 prompt offered
-- ec-vacuum-analyze-pm at 13:00 conditional on EC accumulating >= 10k dead/h
-- measured inside the landing window. Measured 2026-09-19 17:46–18:2x UTC: EC
-- held 0 dead tuples and 100.00% all-visible 13 h after its 04:31 vacuum — a
-- rate of 0/h. The same instrument reads 12,300/h (2026-09-18 23:07) and
-- 20,500/h (2026-09-18 02:49) on weekdays, so the refusal rests on a Saturday
-- and is recorded on FIX-1169 as such, together with the reason it should not be
-- re-litigated without an EXPLAIN showing an actual degraded index-only scan on
-- EC (VM decay only costs index-only scans).
--
-- NO cron_job_budget ROW. A bare VACUUM is not a procedure, so there is no body
-- to consult prod_session_state() and nothing for the */2 watchdog to cancel;
-- the budget rows cover single-statement PROCEDURES. Confirmed against prod: all
-- twelve *-vacuum-analyze jobs carry NULL there today, and this one stays NULL.
--
-- fr-vacuum-analyze REMAINS UNGUARDED. VACUUM cannot run inside a function
-- (PreventInTransactionBlock), so there is no in-function gate to add and no way
-- to make it defer to a supervised session. It can still fire INSIDE one. Moving
-- it from weekly to daily makes that MORE likely, not less, so read 3 of every
-- landing prompt must keep listing it in the unguarded set, and drain-and-wait
-- gate (a) — start >= 90 min after the last unguarded VACUUM's END, none
-- scheduled inside [start, start + 2x expected wall] — now has one more daily
-- entry to clear. That is the cost of this change and it is deliberate.
--
-- Changed by NAME via cron.alter_job, so jobid 38 and the whole of
-- cron.job_run_details survive (FIX-946: never key on jobid — it is 38 on prod
-- and differs on the local clone).
--
-- Cross-ref FIX-884, FIX-943, FIX-1030, FIX-1124, FIX-1133, FIX-1144, FIX-1152,
-- FIX-1165, FIX-1169, FIX-1193.
--
-- Fixes: FIX-1191
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_jobname CONSTANT text := 'fr-vacuum-analyze';
  c_new     CONSTANT text := '0 3 * * *';
  v_id      bigint;
  v_old     text;
BEGIN
  SELECT jobid, schedule INTO v_id, v_old FROM cron.job WHERE jobname = c_jobname;
  IF v_id IS NULL THEN
    -- Not an error: a fresh local DB may not carry the cron catalogue yet.
    RAISE WARNING '[fix1191] job % not found — skipped', c_jobname;
    RETURN;
  END IF;
  PERFORM cron.alter_job(v_id, schedule := c_new);
  RAISE NOTICE '[fix1191] % (jobid %) -> % (was %)', c_jobname, v_id, c_new, v_old;
END $$;
