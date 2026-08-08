-- FIX-975 — vacuum OWNERSHIP for financial_entities: the scheduled backstop.
--
-- THE FINDING. The 2026-08-07 efficiency audit sorted the 18 public tables over
-- 200 MB by "does any script, cron job or procedure ever issue a manual VACUUM
-- against it", and the split was total:
--
--   entity_connections        vacuum_count 6  ->  98.4% all-visible   OWNED
--   financial_relationships   vacuum_count 5  ->  96.8%               OWNED (FIX-974)
--   official_donor_rollup_mv  vacuum_count 1  -> 100.0%               OWNED (FIX-974)
--   financial_entities        vacuum_count 0  ->  53.7%               NONE
--   donor_party_rollup_mv     vacuum_count 0  ->  74.9%               NONE
--
-- Measured consequence on the covering index that exists specifically to enable
-- index-only scans (financial_entities_nonindividual_id): 108,419 Heap Fetches
-- on 226,640 rows (47.8%), 47.0 s — against 4.8% on the FIX-974-owned
-- financial_relationships path. A 10x spread tracking ownership exactly, behind
-- financial_entities_pkey, the most-scanned index on the instance.
--
-- WHY OWNERSHIP AND NOT MORE AUTOVACUUM TUNING (playbook B2, FIX-943). The
-- trigger is `threshold + scale_factor x reltuples`, so a table is ALWAYS
-- permitted a floor of dead tuples before autovacuum fires — ~182k on FE at its
-- current size, and that floor GREW 25% as the table grew. A bulk rewrite lands
-- its whole dead-tuple load inside the floor at once and the next reader pays.
-- Autovacuum does eventually recover the table (it fired 2026-08-07 05:12 UTC,
-- taking FE 53.7% -> 85.7%); what it does not do is close the window between
-- the write and the recovery, which is where readers live. Ownership closes it.
--
-- WHY THE FIX IS SPLIT ACROSS TWO LAYERS. `VACUUM` cannot run inside a function
-- or a transaction block, so the 13 live plpgsql functions that mass-UPDATE
-- financial_entities structurally cannot own their own tails:
--
--   financial_entity_donation_totals_rebuild   financial_entity_donation_totals_window
--   financial_entity_received_totals_rebuild   financial_entity_received_totals_window
--   financial_entity_recipient_count_rebuild   financial_entity_recipient_count_window
--   rebuild_all_primary_sources                rebuild_financial_entity_donation_totals
--   rebuild_financial_entity_ie_totals         rebuild_financial_entity_received_totals
--   reconcile_financial_entity_totals          refresh_primary_source_for_entities
--   refresh_spending_totals
--
--   (a) PATHS WITH A TYPESCRIPT DRIVER get a prompt tail at the call layer —
--       packages/data/src/lib/vacuum-tail.ts, wired into runHeavyRebuild() so
--       every caller of that hub inherits it, plus the CHURNED_TABLES lists in
--       the merge/remediation scripts.
--   (b) PATHS WITH NO TYPESCRIPT DRIVER get this backstop only. Those are
--       exactly the two CALLed directly by pg_cron:
--         jobid 13 financial-entity-totals-incremental (refresh_financial_entity_totals_incremental)
--         jobid 14 financial-entity-totals-reconcile   (reconcile_financial_entity_totals)
--
-- WHY THREE JOBS AND NOT ONE MULTI-STATEMENT JOB. Postgres wraps a
-- multi-statement simple query in an IMPLICIT transaction, and VACUUM cannot
-- run inside a transaction block — verified locally:
--     VACUUM (ANALYZE) public.a; VACUUM (ANALYZE) public.b;
--     ERROR:  VACUUM cannot run inside a transaction block
-- So a single job vacuuming three tables would fail on every firing. One
-- statement per job is the only correct shape, and it buys per-table visibility
-- in cron.job_run_details as a side effect.
--
-- Cadence: Wednesday + Sunday 02:00 UTC. Twice-weekly rather than the existing
-- monthly because the pg_cron-only writers in (b) run weekly (Tue 09:00) and
-- monthly (1st 12:00); Wednesday 02:00 picks the Tuesday cluster's writes up
-- within ~12 h. 02:00 UTC is clear of the 05:50-08:00 nightly window and of the
-- 09:00-17:40 active-hours rule.
--
-- `ec-vacuum-analyze` (jobid 6) keeps its name and its jobid — with one VACUUM
-- per job the name no longer lies about its scope, so the audit's "rename it"
-- is discharged by making the scope match the name rather than the reverse.
-- Its schedule is widened from monthly to the same twice-weekly cadence.
--
-- VACUUM, never VACUUM FULL — the latter takes ACCESS EXCLUSIVE and rewrites
-- the whole heap. Measured cost of the first owned pass on prod 2026-08-08:
-- financial_entities 83.9 s, donor_party_rollup_mv 6.3 s.

DO $$
DECLARE
  v_sched text := '0 2 * * 0,3';
  v_specs text[][] := ARRAY[
    ['ec-vacuum-analyze',  'VACUUM (ANALYZE) public.entity_connections;'],
    ['fe-vacuum-analyze',  'VACUUM (ANALYZE) public.financial_entities;'],
    ['dpr-vacuum-analyze', 'VACUUM (ANALYZE) public.donor_party_rollup_mv;']
  ];
  v_name  text;
  v_cmd   text;
  v_jobid bigint;
  i       int;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '[fix975] pg_cron absent — skipping vacuum backstop schedule';
    RETURN;
  END IF;

  FOR i IN 1 .. array_length(v_specs, 1) LOOP
    v_name := v_specs[i][1];
    v_cmd  := v_specs[i][2];

    SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = v_name;

    IF v_jobid IS NULL THEN
      PERFORM cron.schedule(v_name, v_sched, v_cmd);
      RAISE NOTICE '[fix975] scheduled %', v_name;
    ELSE
      -- alter_job IN PLACE, not unschedule+schedule: cron.schedule mints a NEW
      -- jobid, which discards the run history and resets the job's identity for
      -- anything reading cron.job_run_details (the FIX-968 precedent).
      PERFORM cron.alter_job(job_id := v_jobid, schedule := v_sched, command := v_cmd);
      RAISE NOTICE '[fix975] retuned % (jobid %)', v_name, v_jobid;
    END IF;
  END LOOP;
END;
$$;
