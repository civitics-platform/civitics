-- FIX-1357 REVERT — every row 20261028001000_fix1357_cap_mb_rederived_for_hash_mem_one.sql
-- halved goes back to its cc-252 read-6 value (prod, 2026-10-28 00:58Z),
-- matched on the NEW value so a row someone has moved since is left alone and
-- named. The note clause stays (it records that the move happened). The 22
-- LEFT rows were never touched.
--
-- Revert FIX-1356 first or together: these caps are 2 × work_mem, which is
-- right only while hash_mem_multiplier is 2.
--
-- Run (prod):  node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file scripts/fix1357-revert-cap-mb.sql
-- Rehearse:    inside BEGIN … ROLLBACK on the clone.
DO $$
DECLARE
  r     record;
  v_n   int;
  v_off text := '';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('agency-staffing-rollup-refresh',       256, 128),
      ('financial-entity-totals-incremental',  256, 128),
      ('refresh-derived-mvs-daily',            256, 128),
      ('refresh-derived-mvs-weekly',           256, 128),
      ('contract-flow-rollups-refresh',        128,  64),
      ('donation-edge-orphan-sweep',           128,  64),
      ('donor-party-rollup-orphan-sweep',      128,  64),
      ('donor-party-rollup-refresh',           128,  64),
      ('donor-rollup-orphan-sweep',            128,  64),
      ('entity-connection-stats-orphan-sweep', 128,  64),
      ('financial-entity-totals-reconcile',    128,  64),
      ('treemap-individuals-global-refresh',   128,  64),
      ('vote-stats-refresh',                   128,  64),
      ('ec-crawl',                             128,  64),
      ('rebuild-ec-incremental',               128,  64),
      ('rebuild-ec-incremental-mon',           128,  64),
      ('rule-taggers-daily',                   128,  64),
      ('rule-taggers-weekly',                  128,  64),
      ('donor-rollup-refresh',                 128,  64),
      ('fe-crawl',                             128,  64),
      ('fe-inbound-rollup-refresh',            128,  64),
      ('entity-connection-stats-rebuild',      128,  64),
      ('group-donor-rollup-refresh',           128,  64),
      ('abuse-events-retention',               128,  64),
      ('box-health-probe',                     128,  64),
      ('cron-job-budget-watchdog',             128,  64),
      ('cron-job-run-details-retention',       128,  64),
      ('derived-mvs-unit-watchdog',            128,  64),
      ('dispatcher-tick',                      128,  64),
      ('platform-counts-daily',                128,  64),
      ('vm-probe-pre-ec',                      128,  64),
      ('vm-probe-pre-fe',                      128,  64),
      ('vm-probe-pre-fr',                      128,  64)
    ) AS h(job, old_cap, new_cap)
  LOOP
    UPDATE public.job_registry
       SET cap_mb = r.old_cap, updated_at = now()
     WHERE job = r.job AND cap_mb = r.new_cap;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      v_off := v_off || format(' %s', r.job);
    END IF;
  END LOOP;
  IF v_off <> '' THEN
    RAISE EXCEPTION '[fix1357 revert] not at the FIX-1357 value, left alone:%', v_off;
  END IF;
  RAISE NOTICE '[fix1357 revert] 33 rows back to the read-6 caps; Σ cap_mb %',
    (SELECT sum(cap_mb) FROM public.job_registry);
END $$;
