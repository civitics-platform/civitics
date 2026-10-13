-- FIX-1307 — the job registry: job_registry + platform_dials + dispatch_log,
-- seeded from prod's live cron.job / cron_job_budget / rollup_watch_overrides
-- (R1 of spec-job-registry-and-dispatcher-2026-10-11 v1.1; cc-223, 2026-10-12).
--
-- WHAT. Three tables and a seed. job_registry holds one row per scheduled job:
-- every pg_cron job (active AND inactive, so the registry is the whole
-- catalog) plus one row per GHA workflow with an on.schedule block. In each
-- row, runner/pipeline/unit_shape/unit_call say what runs; priority,
-- deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates and
-- idempotent_refire are what the dispatcher (FIX-1308) will read. platform_dials
-- is the one-row table of runtime dials, pinned by a boolean PK. dispatch_log is
-- the dispatcher's decision log; it carries the ARM path's columns (armed_jobid,
-- armed_jobname, armed_for) now so R2 adds no DDL to it.
--
-- SEEDING CHANGES NO BEHAVIOUR. Every row's deadline_rule is
-- 'at <its live cron schedule>' (D5/D12). Nothing reads these tables until
-- FIX-1308 lands, and even then a row becomes dispatcher-eligible only through
-- its own one-row UPDATE. cron.job, cron_job_budget and rollup_watch_overrides
-- are UNCHANGED; R1b (FIX-1309) folds cron_job_budget into a view over this
-- table after R2's proving. The first row move is M1 (donor-rollup-refresh ->
-- stale_after '12 hours', Mon 10-19). A row move is a one-row UPDATE; a
-- regression is a revert of that row.
--
-- PROVENANCE. Three read-only prod statements, banked whole in
-- docs/audits/2026-10-12-cc223-cron-job-read.json; the column derivations are
-- in docs/audits/2026-10-12-job-registry-contract-audit.md §1.
--   read 1 2026-10-13T00:41:25Z  cron.job (45 rows: 41 active, 4 inactive)
--          LEFT JOIN cron_job_budget LEFT JOIN cron-job-pipelines.ts'
--          Q_CRON_JOB_PIPELINES (imported as-is) -> unit_call = command
--          verbatim, pipeline, guarded (-> gates), budget_seconds by jobname.
--   read 2 2026-10-13T00:42:15Z  md5(prosrc) / proconfig / work_mem lines for
--          the 30 routines the commands name + 3 callees: every md5 equals
--          the body in its newest migration on main. cap_mb = 2 x the work_mem
--          the body or its one callee SETs (hash_mem_multiplier 2, serial; D3);
--          a body with no SET inherits the role's 64MB (20261009030000) -> 128;
--          a VACUUM uses maintenance_work_mem 64 -> 64.
--          group-donor-rollup-refresh is seeded at 128, the value cc-219's
--          20261013010000 lands; prod still read the 20261004070000 body's
--          SET LOCAL work_mem = '256MB' at read time.
--   read 3 2026-10-13T00:43:03Z  rollup_watch_overrides (5 rows) + the
--          vacuumed tables' sizes and autovacuum triggers (the audit's §4).
-- xsr-vacuum-analyze (cc-219's 41 1 * * 2 job) was not on prod at read 1. It is
-- seeded from cc-219's migration text, ahead of that landing, and cc-226
-- re-reads the slot its guard passed.
--
-- IDEMPOTENT END TO END: CREATE ... IF NOT EXISTS, INSERT ... ON CONFLICT DO
-- NOTHING. The clone gets this file through db-query.mjs --local --file
-- tonight, and db push applies it again on Wed (cc-226).
--
-- check:job-registry (scripts/check-job-registry.mjs) parses the seed, one row
-- per line, the job literal first, between the two fence comments. A later
-- migration that adds a job adds rows in the same fence shape; membership is
-- the union of every fence.
--
-- ROLLBACK: DROP TABLE public.dispatch_log, public.platform_dials, public.job_registry;
-- (nothing reads them until FIX-1308.)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. job_registry
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_registry (
  job               text PRIMARY KEY,
  runner            text NOT NULL CHECK (runner IN ('pg_cron', 'github_actions', 'vercel', 'manual')),
  pipeline          text,
  unit_shape        text NOT NULL CHECK (unit_shape IN ('resumable', 'atomic', 'bare')),
  unit_call         text,
  priority          smallint NOT NULL CHECK (priority BETWEEN 1 AND 5),
  deadline_rule     text NOT NULL CHECK (deadline_rule ~ '^(at |by |stale_after |dead_tuples > )'),
  cost_class        text NOT NULL CHECK (cost_class IN ('io', 'memory', 'cpu', 'mixed')),
  cap_mb            int,
  exclusion_group   text,
  budget_seconds    int CHECK (budget_seconds IS NULL OR budget_seconds > 0),
  gates             text[] NOT NULL DEFAULT '{}'
                    CHECK (gates <@ ARRAY['box', 'peer', 'prod_session', 'blackout']),
  idempotent_refire boolean NOT NULL DEFAULT false,
  note              text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.job_registry IS
  'FIX-1307 — one row per scheduled job (every pg_cron job, active or not, and '
  'every GHA workflow with an on.schedule block): what runs, and what the unit '
  'dispatcher (FIX-1308) reads to choose it. Seeded by FIX-1307 with every row '
  'deadline_rule ''at <its cron schedule>'', so the seed changes no behaviour. '
  'A row move is a one-row UPDATE; a regression is a revert of that row. '
  'check:job-registry keeps it in parity with the receipts'' cron_jobs[] and '
  'the scheduled workflows.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. platform_dials — the one-row table (boolean PK pinned to true)
-- ─────────────────────────────────────────────────────────────────────────────
-- Defaults are the measured first values (D5/D12). The tick_seconds ->
-- cron.alter_job trigger is FIX-1308's: it needs the tick job to exist.
CREATE TABLE IF NOT EXISTS public.platform_dials (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  headroom_target_mb   int NOT NULL DEFAULT 150,
  max_live_caps_mb     int NOT NULL DEFAULT 1024,
  max_concurrent_units int NOT NULL DEFAULT 2,
  tick_seconds         int NOT NULL DEFAULT 120 CHECK (tick_seconds BETWEEN 60 AND 3600),
  unit_target_seconds  int NOT NULL DEFAULT 240,
  pause                boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_dials IS
  'FIX-1307 — the dispatcher''s runtime dials, one row (id = true). Seeded by '
  'FIX-1307 with the measured first values; every dial is one row write. A dial '
  'move is a one-row UPDATE; a regression is a revert of that row.';

INSERT INTO public.platform_dials DEFAULT VALUES ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. dispatch_log — one row per tick decision (retention lives in the tick, C4)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dispatch_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticked_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  source        text NOT NULL DEFAULT 'pg_cron' CHECK (source IN ('pg_cron', 'vercel', 'manual')),
  job           text,
  decision      text NOT NULL,
  reason        text,
  live_caps_mb  int,
  live_units    int,
  box           jsonb,
  armed_jobid   bigint,
  armed_jobname text,
  armed_for     timestamptz,
  unit_rows     int,
  unit_ms       int
);

CREATE INDEX IF NOT EXISTS dispatch_log_ticked_at_idx ON public.dispatch_log (ticked_at DESC);
CREATE INDEX IF NOT EXISTS dispatch_log_armed_jobid_idx ON public.dispatch_log (armed_jobid) WHERE armed_jobid IS NOT NULL;

COMMENT ON TABLE public.dispatch_log IS
  'FIX-1307 — the unit dispatcher''s decision log (FIX-1308 writes it): one row '
  'per tick decision, with the ARM path''s armed_jobid / armed_jobname / '
  'armed_for. Created empty by FIX-1307; retention lives inside the tick.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Grants — the rollup_watch_overrides shape (20260903000000:135-137), with
--    service_role named in the REVOKE too: Supabase's default privileges give
--    a new public table ALL to service_role, so without it the GRANTs below
--    would be a floor, not the grant (measured on the clone, cc-223: service_role
--    held INSERT on dispatch_log). dispatch_log's writer is the tick (FIX-1308).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.job_registry   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_dials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_log   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_registry, public.platform_dials, public.dispatch_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.job_registry, public.platform_dials, public.dispatch_log TO service_role;
GRANT INSERT, UPDATE ON TABLE public.job_registry, public.platform_dials TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The seed — 53 rows: 45 pg_cron (read 1) + xsr-vacuum-analyze + 7 GHA
-- ─────────────────────────────────────────────────────────────────────────────
-- Column rules (derived; each cited in the audit §1):
--   unit_shape  bare = the command is not a CALL/SELECT of a routine (the 14
--               VACUUMs + the retention DELETE); resumable = the body persists a
--               cursor AND bounds a unit (the cursor key is named in the note);
--               atomic = everything else.
--   priority    1 probes/watchdogs + fr-vacuum-analyze; 2 reader-visible daily
--               freshness; 3 weeklies (and the four inactive weekly jobs);
--               4 the other vacuums; 5 the monthly sweeps + the two retentions.
--   gates       {prod_session} where the derivation says guarded;
--               {prod_session,blackout} for ec-crawl/fe-crawl (the ec_crawl
--               config blackout until FIX-1124 part 2); {} otherwise.
--   exclusion_group  the table family the body rewrites in bulk; any other
--               family it writes is named in the note.
--   note        the cc-210 §1.1 wall line, the cursor key, and no-band where
--               docs/receipts/bands.json has no key for the job.
-- job-registry-seed:begin
INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, note) VALUES
  ('abuse-events-retention', 'pg_cron', NULL, 'atomic', 'CALL public.purge_abuse_events();', 5, 'at 15 4 * * *', 'cpu', 128, 'platform', NULL, '{}', false, 'p50/max 0.1/0.1 s (30 d); no-band'),
  ('agency-staffing-rollup-refresh', 'pg_cron', 'agency_staffing_rollup_refresh', 'atomic', 'CALL public.refresh_agency_staffing_rollup();', 3, 'at 5 0 * * 2', 'memory', 256, 'rollups', 3600, '{prod_session}', false, 'p50/max 42.0/58.3 s (30 d); no-band'),
  ('box-health-probe', 'pg_cron', NULL, 'atomic', 'SELECT public.record_box_health()', 1, 'at * * * * *', 'cpu', 128, NULL, 60, '{}', false, 'no-band'),
  ('contract-flow-rollups-refresh', 'pg_cron', 'contract_flow_rollups_rebuild', 'atomic', 'CALL public.refresh_contract_flow_rollups();', 3, 'at 0 14 * * 4', 'memory', 128, 'mvs', 9000, '{prod_session}', false, 'p50/max 1904.4/5892.2 s (30 d)'),
  ('cron-job-budget-watchdog', 'pg_cron', NULL, 'atomic', 'SELECT public.enforce_cron_job_budgets();', 1, 'at */2 * * * *', 'cpu', 128, NULL, NULL, '{}', false, 'no-band'),
  ('cron-job-run-details-retention', 'pg_cron', NULL, 'bare', 'DELETE FROM cron.job_run_details WHERE start_time < now() - make_interval(days => 42)', 5, 'at 51 1 * * *', 'io', 128, 'platform', 300, '{}', false, 'no-band'),
  ('derived-mvs-unit-watchdog', 'pg_cron', NULL, 'atomic', 'SELECT public.enforce_derived_mvs_unit_budget();', 1, 'at */2 * * * *', 'cpu', 128, NULL, NULL, '{}', false, 'no-band'),
  ('donation-edge-orphan-sweep', 'pg_cron', 'donation_edge_orphan_sweep', 'atomic', 'CALL public.reconcile_donation_edge_orphans();', 5, 'at 30 11 1 * *', 'memory', 128, 'ec', NULL, '{prod_session}', false, 'p50/max 135.5/135.5 s (30 d); deletes entity_connections'),
  ('donor-party-rollup-orphan-sweep', 'pg_cron', 'donor_party_rollup_orphan_sweep', 'atomic', 'CALL public.reconcile_donor_party_rollup_orphans();', 5, 'at 0 13 1 * *', 'io', 128, 'rollups', NULL, '{prod_session}', false, 'p50/max 290.5/290.5 s (30 d)'),
  ('donor-party-rollup-refresh', 'pg_cron', 'donor_party_rollup_refresh', 'resumable', 'CALL public.refresh_donor_party_rollup_incremental();', 3, 'at 0 15 * * 2', 'memory', 128, 'rollups', 1800, '{prod_session}', false, 'cursor donor_party_full_rebuild (16 windows); p50/max 78.8/11335.1 s (30 d)'),
  ('donor-rollup-orphan-sweep', 'pg_cron', 'donor_rollup_orphan_sweep', 'atomic', 'CALL public.reconcile_donor_rollup_orphans();', 5, 'at 30 12 1 * *', 'memory', 128, 'rollups', NULL, '{prod_session}', false, 'p50/max 103.5/103.5 s (30 d)'),
  ('donor-rollup-refresh', 'pg_cron', 'donor_rollup_refresh', 'resumable', 'CALL public.donor_rollup_rebuild_bulk();', 2, 'at 0 9,12 * * *', 'memory', 128, 'rollups', 9000, '{prod_session}', true, 'cursor donor_rollup_bulk_sweep; p50/max 0.2/2498.2 s (30 d); also refreshes official_homepage_stats_mv (mvs)'),
  ('dpr-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.donor_party_rollup_mv;', 4, 'at 0 2 * * 0,3', 'io', 64, 'rollups', NULL, '{}', true, 'p50/max 2.4/8.0 s (30 d); no-band'),
  ('ec-crawl', 'pg_cron', 'entity_connections_rebuild', 'resumable', 'CALL public.run_entity_connections_rebuild(''incremental'', p_max_units := 1);', 2, 'at */15 * * * *', 'mixed', 128, 'ec', 1800, '{prod_session,blackout}', true, 'cursor entity_connections_rebuild_cursor; unit p_max_units 1; p50/max 0.2/2109.3 s (30 d); no-band'),
  ('ec-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.entity_connections;', 4, 'at 30 4 * * *', 'io', 64, 'ec', NULL, '{}', true, 'p50/max 78.9/3147.9 s (30 d)'),
  ('ecs-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.entity_connection_stats_mv;', 4, 'at 20 11,17 * * *', 'io', 64, 'ec', NULL, '{}', true, 'p50/max 4.4/17.5 s (30 d); no-band'),
  ('entity-connection-stats-orphan-sweep', 'pg_cron', 'entity_connection_stats_orphan_sweep', 'atomic', 'CALL public.reconcile_entity_connection_stats_orphans();', 5, 'at 30 13 1 * *', 'io', 128, 'ec', NULL, '{prod_session}', false, 'p50/max 92.8/92.8 s (30 d)'),
  ('entity-connection-stats-rebuild', 'pg_cron', 'entity_connection_stats_rebuild', 'atomic', 'CALL public.rebuild_entity_connection_stats();', 3, 'at 0 16 * * 1,3', 'mixed', 128, 'ec', 9000, '{prod_session}', false, 'INACTIVE on prod (jobid 16 parked): rollup_watch_overrides: retired 2026-08-26; no-band'),
  ('fe-crawl', 'pg_cron', 'financial_entity_totals_refresh', 'resumable', 'CALL public.run_fe_totals_crawl(p_max_units := 1);', 2, 'at */30 * * * *', 'io', 128, 'fe-totals', 1800, '{prod_session,blackout}', true, 'cursor fe_crawl + fe_crawl_bootstrap_progress; unit p_max_units 1; p50/max 0.2/1952.5 s (30 d); no-band'),
  ('fe-inbound-rollup-refresh', 'pg_cron', 'financial_entity_inbound_rollup', 'resumable', 'CALL public.run_fe_inbound_rollup(p_max_units := 10)', 2, 'at 13 2 * * *', 'cpu', 128, 'fe-totals', 1800, '{prod_session}', false, 'cursor financial_entity_inbound_rollup_watermark.resume_after; unit 10x200; p50/max 0.1/102.7 s (30 d); no-band'),
  ('fe-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.financial_entities;', 4, 'at 50 4 * * *', 'io', 64, 'fe-totals', NULL, '{}', true, 'p50/max 11.6/99.2 s (30 d)'),
  ('financial-entity-totals-incremental', 'pg_cron', 'financial_entity_totals_refresh', 'atomic', 'CALL public.refresh_financial_entity_totals_incremental();', 3, 'at 0 10 * * 2', 'io', 256, 'fe-totals', 7200, '{prod_session}', false, 'INACTIVE on prod (jobid 13 parked): no-band'),
  ('financial-entity-totals-reconcile', 'pg_cron', 'financial_entity_totals_reconcile', 'atomic', 'CALL public.reconcile_financial_entity_totals();', 5, 'at 0 12 1 * *', 'io', 128, 'fe-totals', NULL, '{prod_session}', false, 'p50/max 155.4/155.4 s (30 d)'),
  ('fr-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.financial_relationships;', 1, 'at 0 3 * * *', 'io', 64, 'fr-table', NULL, '{}', true, 'p50/max 10.4/212.0 s (30 d); no-band'),
  ('group-donor-rollup-refresh', 'pg_cron', 'group_donor_rollup_refresh', 'atomic', 'CALL public.run_group_donor_rollup_refresh();', 3, 'at 10 3 * * 3', 'memory', 128, 'rollups', 1800, '{prod_session}', false, 'p50/max 101.5/294.2 s (30 d); cap 128 = cc-219''s 20261013010000 64MB; prod read 256MB (20261004070000)'),
  ('odbt-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.official_donor_bracket_totals;', 4, 'at 18 11,17 * * *', 'io', 64, 'rollups', NULL, '{}', true, 'p50/max 0.3/1.4 s (30 d); no-band'),
  ('odr-mv-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.official_donor_rollup_mv;', 4, 'at 5 11,17 * * *', 'io', 64, 'rollups', NULL, '{}', true, 'p50/max 1.5/2.5 s (30 d); no-band'),
  ('odt-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.official_donor_totals;', 4, 'at 12 11,17 * * *', 'io', 64, 'rollups', NULL, '{}', true, 'p50/max 0.2/0.3 s (30 d); no-band'),
  ('officials-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.officials;', 4, 'at 30 1 * * 1', 'io', 64, 'officials', NULL, '{}', true, 'p50/max 3.8/4.0 s (30 d); no-band'),
  ('osar-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.official_sector_affinity_rollup;', 4, 'at 16 11,17 * * *', 'io', 64, 'rollups', NULL, '{}', true, 'p50/max 0.3/1.0 s (30 d); no-band'),
  ('osdr-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.official_small_dollar_rollup;', 4, 'at 14 11,17 * * *', 'io', 64, 'rollups', NULL, '{}', true, 'p50/max 0.2/0.2 s (30 d); no-band'),
  ('platform-counts-daily', 'pg_cron', 'platform_counts_daily', 'atomic', 'CALL public.refresh_platform_counts();', 2, 'at 53 3 * * *', 'io', 128, 'platform', 1800, '{}', false, 'p50/max 59.7/324.6 s (30 d); no-band'),
  ('rebuild-ec-incremental', 'pg_cron', 'entity_connections_rebuild', 'atomic', 'CALL public.run_entity_connections_rebuild(''incremental'');', 3, 'at 0 8 * * 3', 'mixed', 128, 'ec', 18000, '{prod_session}', false, 'INACTIVE on prod (jobid 2 parked): no-band'),
  ('rebuild-ec-incremental-mon', 'pg_cron', 'entity_connections_rebuild', 'atomic', 'CALL public.run_entity_connections_rebuild(''incremental'');', 3, 'at 0 8 * * 1', 'mixed', 128, 'ec', 18000, '{prod_session}', false, 'INACTIVE on prod (jobid 22 parked): no-band'),
  ('refresh-derived-mvs-daily', 'pg_cron', 'refresh_derived_mvs', 'atomic', 'CALL public.refresh_derived_mvs(''daily'');', 2, 'at 0 6 * * *', 'mixed', 256, 'mvs', 5400, '{prod_session}', false, 'p50/max 354.8/1207.6 s (30 d); per-unit COMMITs, no persisted cursor: a re-run starts at unit 1'),
  ('refresh-derived-mvs-weekly', 'pg_cron', 'refresh_derived_mvs', 'atomic', 'CALL public.refresh_derived_mvs(''weekly'');', 3, 'at 47 0 * * 2', 'mixed', 256, 'mvs', 5400, '{prod_session}', false, 'p50/max 1407.5/1593.2 s (30 d); per-unit COMMITs, no persisted cursor: a re-run starts at unit 1; no-band'),
  ('rule-taggers-daily', 'pg_cron', 'run_rule_taggers', 'atomic', 'CALL public.run_rule_taggers(''daily'');', 2, 'at 30 6 * * *', 'io', 128, 'tags', 7200, '{prod_session}', false, 'p50/max 225.7/7203.5 s (30 d)'),
  ('rule-taggers-weekly', 'pg_cron', 'run_rule_taggers', 'atomic', 'CALL public.run_rule_taggers(''weekly'');', 3, 'at 0 16 * * 2', 'memory', 128, 'tags', 7200, '{prod_session}', false, 'p50/max 5062.9/19043.9 s (30 d); no-band'),
  ('treemap-individuals-global-refresh', 'pg_cron', 'treemap_individuals_global_refresh', 'resumable', 'CALL public.refresh_treemap_individuals_global();', 3, 'at 0 14 * * 2', 'cpu', 128, 'rollups', 5400, '{prod_session}', false, 'cursor treemap_global_refresh.chunk_cursor (64 chunks); p50/max 916.4/994.1 s (30 d); treemap_individuals_rollup is also rewritten by donor-rollup-refresh'),
  ('treemap-individuals-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.treemap_individuals_rollup;', 4, 'at 10 11,17 * * *', 'io', 64, 'rollups', NULL, '{}', true, 'p50/max 0.6/1.4 s (30 d); no-band'),
  ('vm-probe-pre-ec', 'pg_cron', NULL, 'atomic', 'SELECT public.record_vm_probe(''pre-ec'', ARRAY[''entity_connections'',''votes''])', 1, 'at 25 4 * * *', 'cpu', 128, NULL, NULL, '{}', false, 'no-band'),
  ('vm-probe-pre-fe', 'pg_cron', NULL, 'atomic', 'SELECT public.record_vm_probe(''pre-fe'', ARRAY[''financial_entities''])', 1, 'at 45 4 * * *', 'cpu', 128, NULL, NULL, '{}', false, 'no-band'),
  ('vm-probe-pre-fr', 'pg_cron', NULL, 'atomic', 'SELECT public.record_vm_probe(''pre-fr'', ARRAY[''financial_relationships''])', 1, 'at 55 2 * * *', 'cpu', 128, NULL, NULL, '{}', false, 'no-band'),
  ('vote-stats-refresh', 'pg_cron', 'official_vote_stats_rebuild', 'atomic', 'CALL public.rebuild_official_vote_stats();', 2, 'at 30 3 * * *', 'cpu', 128, 'votes', NULL, '{prod_session}', false, 'p50/max 22.2/45.3 s (30 d); no-band'),
  ('votes-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.votes;', 4, 'at 37 2 * * 6', 'io', 64, 'votes', NULL, '{}', true, 'p50/max 24.8/24.8 s (30 d)'),
  ('xsr-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.external_source_refs;', 4, 'at 41 1 * * 2', 'io', 64, 'xsr', NULL, '{}', true, 'seeded ahead of cc-219''s landing; cc-226 re-reads the slot the guard passed; no-band'),
  ('audit', 'github_actions', NULL, 'atomic', 'gha:audit.yml', 3, 'at 0 4 * * 1', 'io', 128, NULL, 1800, '{}', false, 'weekly integrity report; reads prod, commits docs/audits; no-band'),
  ('crs-summaries', 'github_actions', NULL, 'atomic', 'gha:crs-summaries.yml', 3, 'at 0 10 * * 6', 'io', 128, 'proposals', 21000, '{}', false, 'writes proposals.summary_plain; no data_sync_log row; no-band'),
  ('irs990', 'github_actions', 'irs990', 'atomic', 'gha:irs990.yml', 3, 'at 0 15 * * 1', 'io', 128, 'fr-table', 5400, '{}', false, 'writes financial_relationships (bulk) + financial_entities, officials, external_source_refs; no-band'),
  ('nightly', 'github_actions', 'nightly_cron', 'atomic', 'gha-dispatch:nightly', 2, 'at 0 21 * * *', 'mixed', 128, 'fr-table', 18000, '{prod_session}', false, 'the START moves to the dispatcher in N2 (by 21:00Z..23:00Z); its fec phase takes the FIX-950 claim in N1 (cc-225); no-band'),
  ('platform-snapshot', 'github_actions', NULL, 'atomic', 'gha-dispatch:platform-snapshot', 1, 'at */10 * * * *', 'cpu', 128, NULL, 600, '{}', false, 'request-path probe (curl www); writes nothing on prod; no-band'),
  ('refresh-disposable-emails', 'github_actions', NULL, 'atomic', 'gha:refresh-disposable-emails.yml', 5, 'at 0 11 3 * *', 'cpu', 128, NULL, 900, '{}', false, 'opens a blocklist PR; writes nothing on prod; no-band'),
  ('sync-canary-check', 'github_actions', NULL, 'atomic', 'gha-dispatch:sync-canary-check', 1, 'at 0 5 * * *', 'cpu', 128, 'platform', 300, '{}', false, 'canary: reads data_sync_log, stamps the nightly_cron row''s metadata; no-band')
ON CONFLICT (job) DO NOTHING;
-- job-registry-seed:end
