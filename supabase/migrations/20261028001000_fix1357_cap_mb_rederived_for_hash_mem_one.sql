-- FIX-1357 — job_registry.cap_mb re-derived for hash_mem_multiplier = 1
-- (the rider FIX-1356 forces; cc-252).
--
-- THE RULE. The seed (20261014230000:33-37) and the contract audit
-- (docs/audits/2026-10-12-job-registry-contract-audit.md §1) derive
--   cap_mb = 2 × the work_mem the body, or its one callee, SETs
--            (a body with no SET inherits the postgres role's 64MB);
--   a VACUUM row = 64 (maintenance_work_mem, NOT a hash);
--   a GHA row = 128.
-- The 2 IS hash_mem_multiplier: one hash node may hold work_mem × the
-- multiplier. FIX-1356 sets the multiplier to 1 on the postgres role (every
-- pg_cron unit is a postgres login), so from here a multiplier-derived cap is
--   cap_mb = 1 × work_mem
-- and every such row halves. Nothing else about a row moves.
--
-- WHY NOW. FIX-1354's D8 rung excludes a due row while
-- MemAvailable − cap_mb < headroom_target_mb (150). A cap twice the real
-- per-node peak refuses arms the box could carry: the RETURNed daily (256)
-- needs MemAvailable ≥ 406 against a clean-day gate-time median of ~387
-- (cc-251 M1). It was excluded at 394 on cc-251's first tick, and on its first
-- SLOT firing, Tue 10-27, at 06:01:00Z (397) and 06:03:00Z (269) before it
-- armed at 06:05:00Z (458). Halved, the daily needs ≥ 278 (397 would have
-- passed) and a 64-cap crawl ≥ 214.
--
-- READ 6 — the census (prod, 2026-10-28 00:58Z; pg_proc.prosrc / proconfig of
-- each unit_call's routine and its callees). No routine on prod SETs
-- hash_mem_multiplier (the mentions in refresh_derived_mvs and
-- run_rule_taggers are comments), so the role value reaches every unit.
--
--   HALVED — 33 pg_cron rows, cap = 2 × work_mem:
--   job                                  old  new  work_mem source
--   agency-staffing-rollup-refresh       256  128  body SET 128MB
--   financial-entity-totals-incremental  256  128  body SET 128MB
--   refresh-derived-mvs-daily            256  128  body SET 128MB (refresh_derived_mvs:78)
--   refresh-derived-mvs-weekly           256  128  body SET 128MB
--   contract-flow-rollups-refresh        128   64  body SET 64MB
--   donation-edge-orphan-sweep           128   64  body SET 64MB
--   donor-party-rollup-orphan-sweep      128   64  body SET 64MB
--   donor-party-rollup-refresh           128   64  body SET 64MB (+ slice proconfig 64MB)
--   donor-rollup-orphan-sweep            128   64  body SET 64MB
--   entity-connection-stats-orphan-sweep 128   64  body SET 64MB
--   financial-entity-totals-reconcile    128   64  body SET 64MB
--   treemap-individuals-global-refresh   128   64  body SET 64MB
--   vote-stats-refresh                   128   64  body SET 64MB
--   ec-crawl                             128   64  body SET 64MB (run_entity_connections_rebuild)
--   rebuild-ec-incremental               128   64  body SET 64MB (the same routine)
--   rebuild-ec-incremental-mon           128   64  body SET 64MB (the same routine)
--   rule-taggers-daily                   128   64  body SET 64MB (run_rule_taggers:79/122)
--   rule-taggers-weekly                  128   64  body SET 64MB (the same routine)
--   donor-rollup-refresh                 128   64  callee donor_rollup_rebuild_bulk SET 64MB
--   fe-crawl                             128   64  callee refresh_fe_totals_slice proconfig 64MB
--   fe-inbound-rollup-refresh            128   64  callee refresh_fe_inbound_rollup_unit proconfig 64MB
--   entity-connection-stats-rebuild      128   64  callee rebuild_entity_connection_stats_window proconfig 64MB
--   group-donor-rollup-refresh           128   64  callee refresh_group_donor_rollup SET 64MB
--   abuse-events-retention               128   64  no SET → the postgres role's 64MB
--   box-health-probe                     128   64  no SET → role 64MB
--   cron-job-budget-watchdog             128   64  no SET → role 64MB
--   cron-job-run-details-retention       128   64  a plain DELETE under work_mem → role 64MB
--   derived-mvs-unit-watchdog            128   64  no SET → role 64MB
--   dispatcher-tick                      128   64  no SET → role 64MB
--   platform-counts-daily                128   64  no SET → role 64MB
--   vm-probe-pre-ec                      128   64  no SET → role 64MB
--   vm-probe-pre-fe                      128   64  no SET → role 64MB
--   vm-probe-pre-fr                      128   64  no SET → role 64MB
--
--   LEFT — 22 rows:
--   14 VACUUM rows at 64 — maintenance_work_mem, which the multiplier does not
--      scale: dpr-, ec-, ecs-, fe-, fr-, odbt-, odr-mv-, odt-, officials-,
--      osar-, osdr-, treemap-individuals-, votes-, xsr-vacuum-analyze.
--   8 GHA rows at 128 — audit, crs-summaries, fixes-housekeep, irs990, nightly,
--      platform-snapshot, refresh-disposable-emails, sync-canary-check. The
--      prompt classes them as the runner's; the 10-12 audit says "the role
--      default" (× 2). Left either way: a larger cap only makes the headroom
--      test stricter, and a GHA run's DB sessions are not one hash node. A
--      later run can halve them on a decision.
--
--   Σ cap_mb 6,656 → 4,288 against max_live_caps_mb 1024, which STAYS (the
--   dial bounds what may run together; Σ falling under it is the point).
--
-- NETS. scripts/fix1357-revert-cap-mb.sql puts every halved row back to its
-- read-6 value, matched on the new one. note gains one clause per row.
--
-- IDEMPOTENT. Each UPDATE matches job AND the exact old cap. 0 rows → the row
-- already reads the new cap (NOTICE, a re-apply) or something else moved it
-- (RAISE — a human looks).

DO $$
DECLARE
  r       record;
  v_n     int;
  v_cap   int;
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
       SET cap_mb     = r.new_cap,
           note       = note || format('; cap_mb %s → %s 2026-10-28 (FIX-1357, cc-252): hash_mem_multiplier 1', r.old_cap, r.new_cap),
           updated_at = now()
     WHERE job = r.job
       AND cap_mb = r.old_cap;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      RAISE NOTICE '[fix1357] % cap_mb % → %', r.job, r.old_cap, r.new_cap;
    ELSE
      SELECT j.cap_mb INTO v_cap FROM public.job_registry j WHERE j.job = r.job;
      IF v_cap = r.new_cap THEN
        RAISE NOTICE '[fix1357] % already at % — 0 rows', r.job, r.new_cap;
      ELSE
        RAISE EXCEPTION '[fix1357] % reads cap_mb %, want % (old) or % (new) — a human looks', r.job, v_cap, r.old_cap, r.new_cap;
      END IF;
    END IF;
  END LOOP;
END $$;

-- Read-back: the 33 at their new caps, the 22 left rows at their old ones,
-- Σ quoted against the dial, today's headroom arithmetic for the daily.
DO $$
DECLARE
  v_bad      text;
  v_sum      bigint;
  v_rows     int;
  v_dial     int;
  v_headroom int;
  v_avail    int;
BEGIN
  SELECT string_agg(format('%s=%s (want %s)', e.job, j.cap_mb, e.want), ', ') INTO v_bad
    FROM (VALUES
      ('agency-staffing-rollup-refresh', 128), ('financial-entity-totals-incremental', 128),
      ('refresh-derived-mvs-daily', 128), ('refresh-derived-mvs-weekly', 128),
      ('contract-flow-rollups-refresh', 64), ('donation-edge-orphan-sweep', 64),
      ('donor-party-rollup-orphan-sweep', 64), ('donor-party-rollup-refresh', 64),
      ('donor-rollup-orphan-sweep', 64), ('entity-connection-stats-orphan-sweep', 64),
      ('financial-entity-totals-reconcile', 64), ('treemap-individuals-global-refresh', 64),
      ('vote-stats-refresh', 64), ('ec-crawl', 64), ('rebuild-ec-incremental', 64),
      ('rebuild-ec-incremental-mon', 64), ('rule-taggers-daily', 64), ('rule-taggers-weekly', 64),
      ('donor-rollup-refresh', 64), ('fe-crawl', 64), ('fe-inbound-rollup-refresh', 64),
      ('entity-connection-stats-rebuild', 64), ('group-donor-rollup-refresh', 64),
      ('abuse-events-retention', 64), ('box-health-probe', 64), ('cron-job-budget-watchdog', 64),
      ('cron-job-run-details-retention', 64), ('derived-mvs-unit-watchdog', 64),
      ('dispatcher-tick', 64), ('platform-counts-daily', 64), ('vm-probe-pre-ec', 64),
      ('vm-probe-pre-fe', 64), ('vm-probe-pre-fr', 64),
      -- LEFT: the VACUUM rows (maintenance_work_mem) and the GHA rows
      ('dpr-vacuum-analyze', 64), ('ec-vacuum-analyze', 64), ('ecs-vacuum-analyze', 64),
      ('fe-vacuum-analyze', 64), ('fr-vacuum-analyze', 64), ('odbt-vacuum-analyze', 64),
      ('odr-mv-vacuum-analyze', 64), ('odt-vacuum-analyze', 64), ('officials-vacuum-analyze', 64),
      ('osar-vacuum-analyze', 64), ('osdr-vacuum-analyze', 64),
      ('treemap-individuals-vacuum-analyze', 64), ('votes-vacuum-analyze', 64),
      ('xsr-vacuum-analyze', 64),
      ('audit', 128), ('crs-summaries', 128), ('fixes-housekeep', 128), ('irs990', 128),
      ('nightly', 128), ('platform-snapshot', 128), ('refresh-disposable-emails', 128),
      ('sync-canary-check', 128)
    ) AS e(job, want)
    LEFT JOIN public.job_registry j ON j.job = e.job
   WHERE j.cap_mb IS DISTINCT FROM e.want;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[fix1357] read-back failed: %', v_bad;
  END IF;

  SELECT sum(cap_mb), count(*) INTO v_sum, v_rows FROM public.job_registry;
  SELECT d.max_live_caps_mb, d.headroom_target_mb INTO v_dial, v_headroom FROM public.platform_dials d WHERE d.id;
  RAISE NOTICE '[fix1357] read-back ok: 33 halved, 22 left; job_registry % rows, Σ cap_mb % (was 6656) against max_live_caps_mb % (unchanged)',
    v_rows, v_sum, v_dial;
  IF v_rows <> 55 THEN
    RAISE NOTICE '[fix1357] note: % rows, read 6 classified 55 — the extra rows were not touched', v_rows;
  END IF;

  SELECT ((value->>'mem_available_bytes')::bigint / 1048576)::int INTO v_avail
    FROM public.pipeline_state WHERE key = 'box_health_mem';
  IF v_avail IS NULL THEN
    RAISE NOTICE '[fix1357] headroom now: no box_health_mem reading — the rung fails open';
  ELSE
    RAISE NOTICE '[fix1357] headroom now: % MB avail − 128 MB cap = % % % MB → refresh-derived-mvs-daily % (it needs ≥ %; at 256 it needed ≥ %)',
      v_avail, v_avail - 128, CASE WHEN v_avail - 128 >= v_headroom THEN '≥' ELSE '<' END, v_headroom,
      CASE WHEN v_avail - 128 >= v_headroom THEN 'admitted' ELSE 'excluded (headroom)' END,
      128 + v_headroom, 256 + v_headroom;
  END IF;
END $$;
