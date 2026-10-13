# The job-registry contract audit — 53 rows seeded, the nine-item matrix, the unitized fraction (cc-223, FIX-1307)

The first census of every scheduled job against the pipeline contract
(playbook D9; spec `spec-job-registry-and-dispatcher-2026-10-11` v1.1 §1). The
spec's warning is the reason this exists: the failure mode to avoid is the
control plane before the units. FIX-1308's dispatcher can only bound a unit it
can see the end of, so this measures how much of the platform's scheduled wall
is in units today.

The seed is `supabase/migrations/20261014230000_fix1307_job_registry.sql`, built
on `feature/fix-1307` and landed by cc-226 (Wed 10-14 23:15Z). The prod reads
behind it are banked in `docs/audits/2026-10-12-cc223-cron-job-read.json`.

**Headline.** 6 of the 21 active `CALL` jobs are resumable today (a persisted
cursor and a bounded unit). They carry **8.3 %** of the weekly scheduled wall
(p50 × firings). **86.5 %** sits in 8 atomic jobs whose p50 is over 2 min.
**None** has the `(p_max_rows, p_max_units)` signature yet. EC sits at **73.8 %**
of its autovacuum trigger. FR's figure cannot be read: its counters were
discarded by the 10-12 restart (§4).

---

## §0 The three prod reads

All three were read-only, from the primary checkout, through
`node scripts/db-query.mjs --prod --file` (`SET TRANSACTION READ ONLY`,
`max_parallel_workers_per_gather = 0`). Nothing else touched prod.

| read | instant (UTC) | what | rows |
|---|---|---|---|
| 1 | 2026-10-13 00:41:25 | `cron.job` LEFT JOIN `cron_job_budget` LEFT JOIN `cron-job-pipelines.ts`'s `Q_CRON_JOB_PIPELINES`, imported as-is through tsx (no port) | 45 jobs: **41 active, 4 inactive**; 25 `CALL` (21 active), 6 `SELECT`, 13 `VACUUM`, 1 `DELETE`; **23 guarded (19 active)**; 21 with a budget row |
| 2 | 2026-10-13 00:42:15 | for every routine a command names (30) plus three callees and five named units: `md5(prosrc)`, `proconfig`, every `work_mem` / `max_parallel_workers_per_gather` line; the role settings | 33 routines. **Every md5 equals the body in its newest migration on main** (all 33, including all 21 active CALL targets). Role `postgres@postgres` = `{statement_timeout=3h, work_mem=64MB}`; `maintenance_work_mem` 64MB; `hash_mem_multiplier` 2 |
| 3 | 2026-10-13 00:43:03 | `rollup_watch_overrides` (all rows); `pg_stat_user_tables` + `reloptions` + `reltuples` for the 13 vacuumed tables + `external_source_refs` | 5 override rows; 14 tables |

The four inactive jobs are `entity-connection-stats-rebuild` (jobid 16),
`financial-entity-totals-incremental` (13), `rebuild-ec-incremental` (2) and
`rebuild-ec-incremental-mon` (22). `xsr-vacuum-analyze` was **not** on prod at
read 1, because cc-219's push had not landed. The newest receipts
(`docs/receipts/2026-10-13.json`) carry the same 45 jobs and no `xsr-`.

**`refresh_group_donor_rollup`** read the `20261004070000` body:
`SET LOCAL work_mem = '256MB'`, no parallel zeroing. cc-219's `20261013010000`
(64MB + parallel 0) had not landed, so the seed carries cap 128, the landed
value, and the row's note says so.

**Bodies still above 64MB at read 2:** `refresh_derived_mvs` 128MB (+ parallel 0)
→ cap 256; `refresh_agency_staffing_rollup` 128MB (no parallel 0) → 256;
`refresh_financial_entity_totals_incremental` 128MB (inactive) → 256;
`refresh_group_donor_rollup` 256MB (above).

---

## §1 The registry as seeded

53 rows: 45 pg_cron (read 1) + `xsr-vacuum-analyze` (from cc-219's migration
text) + 7 GHA (one per workflow with `on.schedule`). By runner, 46 `pg_cron` and
7 `github_actions`. By unit_shape, 32 `atomic`, 15 `bare` (14 VACUUM + 1 DELETE)
and 6 `resumable`. Every `deadline_rule` is `at <schedule>`.

**How each non-obvious value was derived**

- **unit_call** is the `cron.job.command` verbatim for pg_cron rows; for GHA,
  `gha:<file>` or `gha-dispatch:<stem>`. The nightly, `sync-canary-check` and
  `platform-snapshot` are fired by `/api/cron/gha-dispatch/<stem>`
  (`apps/civitics/vercel.json`), so they carry the dispatch form.
- **cap_mb** = 2 × the `work_mem` the body, or its one callee, SETs (read 2):
  `run_fe_totals_crawl` → `refresh_fe_totals_slice` proconfig 64 → 128;
  `run_fe_inbound_rollup` → `refresh_fe_inbound_rollup_unit` proconfig 64 →
  128; `run_group_donor_rollup_refresh` → `refresh_group_donor_rollup` (above).
  A body with no SET inherits the role's 64MB → 128 (`purge_abuse_events`,
  `refresh_platform_counts`, the probes and watchdogs, the inactive
  `rebuild_entity_connection_stats` via its 64MB window). The retention DELETE
  runs under `work_mem`, not `maintenance_work_mem`, so it gets 128. A VACUUM
  gets 64. The GHA rows get 128 (the role default; the TS client sets nothing).
- **unit_shape `resumable`** was confirmed in each body, not taken from cc-210
  §1.1's labels:

  | job | cursor (`pipeline_state` key) | bound |
  |---|---|---|
  | donor-rollup-refresh | `donor_rollup_bulk_sweep` (sweep_started_at / sweep_target / resume chunk) | the chunk loop under its budget |
  | ec-crawl | `entity_connections_rebuild_cursor` | `p_max_units := 1` |
  | fe-crawl | `fe_crawl` + `fe_crawl_bootstrap_progress` | `p_max_units := 1` |
  | donor-party-rollup-refresh | `donor_party_full_rebuild` (`windows_done`, 16 windows) | one window per COMMIT |
  | fe-inbound-rollup-refresh | `financial_entity_inbound_rollup_watermark.resume_after` (watermark mode) / `financial_entity_inbound_rollup_cursor` (bootstrap) | `p_max_units := 10` batches of 200 recipients |
  | treemap-individuals-global-refresh | `treemap_global_refresh.chunk_cursor` | 64 chunks, one COMMIT each, budget-checked |

  `refresh-derived-mvs-daily/weekly` are **atomic** in this sense. They COMMIT
  per unit, but no cursor is persisted: the unit list is an array literal, and
  a re-run starts at unit 1 (skipped units are logged in `data_sync_log`, not
  resumed). The prompt expected them among the six (§6).
- **exclusion_group** comes from each body's write targets (`INSERT INTO`,
  `UPDATE`, `DELETE FROM`, `TRUNCATE`, `REFRESH MATERIALIZED VIEW`, followed
  one callee deep):

  | group | members | the tables |
  |---|---|---|
  | ec | ec-crawl, ec-vacuum-analyze, ecs-vacuum-analyze, entity-connection-stats-orphan-sweep, **donation-edge-orphan-sweep**, entity-connection-stats-rebuild, rebuild-ec-incremental, rebuild-ec-incremental-mon | entity_connections, entity_connection_stats_mv |
  | fe-totals | fe-crawl, fe-inbound-rollup-refresh, fe-vacuum-analyze, financial-entity-totals-reconcile, financial-entity-totals-incremental | financial_entities (totals columns), financial_entity_inbound_rollup/_totals |
  | rollups | donor-rollup-refresh, donor-party-rollup-refresh, donor-party-rollup-orphan-sweep, donor-rollup-orphan-sweep, group-donor-rollup-refresh, agency-staffing-rollup-refresh, **treemap-individuals-global-refresh**, **treemap-individuals-vacuum-analyze**, dpr-/odr-mv-/odbt-/odt-/osar-/osdr-vacuum-analyze | official_donor_* rollups, donor_party_rollup_mv, treemap_individuals_rollup, group_donor_rollup*, agency_staffing_rollup |
  | mvs | refresh-derived-mvs-daily, refresh-derived-mvs-weekly, contract-flow-rollups-refresh | the 13 derived MVs, entity_search_index, contract_*_rollup |
  | tags | rule-taggers-daily, rule-taggers-weekly | entity_tags |
  | votes | vote-stats-refresh, votes-vacuum-analyze | official_vote_stats, votes |
  | fr-table | fr-vacuum-analyze, nightly, **irs990** | financial_relationships |
  | officials / xsr | officials-vacuum-analyze / xsr-vacuum-analyze | officials / external_source_refs |
  | platform | platform-counts-daily, abuse-events-retention, cron-job-run-details-retention, **sync-canary-check** | platform_counts, abuse_events, cron.job_run_details, a data_sync_log metadata stamp |
  | proposals | **crs-summaries** | proposals.summary_plain |
  | (NULL) | box-health-probe, both watchdogs, the three vm-probes, audit, platform-snapshot, refresh-disposable-emails | write only pipeline_state / their own logs, or nothing on prod |

  The bold entries depart from the prompt's list. `donation-edge-orphan-sweep`
  DELETEs from `entity_connections` (`20261010020000:419`), which is EC's
  family, not rollups. `treemap-individuals-global-refresh` rewrites
  `treemap_individuals_rollup`, which `donor_rollup_rebuild_bulk` also rewrites
  (`20261009030000:2000`); a table in two groups would void the exclusion, so
  treemap and its vacuum join rollups. `irs990` writes `financial_relationships`
  (`irs990/writer.ts:578`). `sync-canary-check` stamps a `data_sync_log` row
  (`canary-check.ts:1267`). `crs-summaries` writes proposals
  (`backfill-crs-summaries.ts:247`).

  **Bodies that write two families** (bulk family = the group; the others
  named in the note): `donor-rollup-refresh` also refreshes
  `official_homepage_stats_mv` (mvs). `refresh-derived-mvs-daily`'s
  `rebuild_all_primary_sources` writes `financial_entities`, `votes`,
  `officials` (+ proposals, agencies, governing_bodies;
  `20260527000000:176-290`). `refresh-derived-mvs-weekly`'s
  `refresh_spending_totals` writes `financial_entities`
  (`20260813000000:424`). The nightly and irs990 write FR in bulk plus
  financial_entities, officials and external_source_refs.
- **priority** follows the prompt's list for every job it names. Not named:
  the four inactive jobs get 3 (their schedules are weekly); `xsr-vacuum-analyze`
  4; GHA `platform-snapshot` and `sync-canary-check` 1 (a probe and a canary);
  the nightly 2; `audit`, `crs-summaries` and `irs990` 3 (weeklies);
  `refresh-disposable-emails` 5 (monthly).
- **gates** follow the derivation's `guarded`: 23 rows (19 active) carry
  `{prod_session}`, and `ec-crawl`/`fe-crawl` carry `{prod_session,blackout}`.
  The nightly is `{prod_session}` per the prompt.
- **idempotent_refire** is true for the 14 VACUUM rows and for `ec-crawl`,
  `fe-crawl` and `donor-rollup-refresh` (FIX-1137's "obvious yes"); false
  elsewhere, including the retention DELETE (the prompt's list; a re-fired
  retention DELETE is in fact idempotent, which is a later one-row move).
- **budget_seconds** = `cron_job_budget.budget_seconds` by jobname (21 rows; the
  inactive ones keep theirs), NULL where there is no row, and never invented.
  For GHA rows it is `timeout-minutes × 60`: the nightly's fec job 300 min →
  18,000 (`nightly.yml:175`; `PIPELINE_BUDGET_REFS`' comment says "fec 150",
  which is stale), crs 350 → 21,000, irs990 90 → 5,400, audit 30 → 1,800,
  disposable-emails 15 → 900, platform-snapshot 10 → 600, sync-canary 5 → 300.

**Every row, every column**

| job | runner | pipeline | shape | unit_call | prio | deadline_rule | cost | cap_mb | group | budget_s | gates | refire | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| abuse-events-retention | pg_cron | — | atomic | `CALL public.purge_abuse_events();` | 5 | `at 15 4 * * *` | cpu | 128 | platform | — | `{}` | f | p50/max 0.1/0.1 s (30 d); no-band |
| agency-staffing-rollup-refresh | pg_cron | `agency_staffing_rollup_refresh` | atomic | `CALL public.refresh_agency_staffing_rollup();` | 3 | `at 5 0 * * 2` | memory | 256 | rollups | 3600 | `{prod_session}` | f | p50/max 42.0/58.3 s (30 d); no-band |
| box-health-probe | pg_cron | — | atomic | `SELECT public.record_box_health()` | 1 | `at * * * * *` | cpu | 128 | — | 60 | `{}` | f | no-band |
| contract-flow-rollups-refresh | pg_cron | `contract_flow_rollups_rebuild` | atomic | `CALL public.refresh_contract_flow_rollups();` | 3 | `at 0 14 * * 4` | memory | 128 | mvs | 9000 | `{prod_session}` | f | p50/max 1904.4/5892.2 s (30 d) |
| cron-job-budget-watchdog | pg_cron | — | atomic | `SELECT public.enforce_cron_job_budgets();` | 1 | `at */2 * * * *` | cpu | 128 | — | — | `{}` | f | no-band |
| cron-job-run-details-retention | pg_cron | — | bare | `DELETE FROM cron.job_run_details WHERE start_time < now() - make_interval(days => 42)` | 5 | `at 51 1 * * *` | io | 128 | platform | 300 | `{}` | f | no-band |
| derived-mvs-unit-watchdog | pg_cron | — | atomic | `SELECT public.enforce_derived_mvs_unit_budget();` | 1 | `at */2 * * * *` | cpu | 128 | — | — | `{}` | f | no-band |
| donation-edge-orphan-sweep | pg_cron | `donation_edge_orphan_sweep` | atomic | `CALL public.reconcile_donation_edge_orphans();` | 5 | `at 30 11 1 * *` | memory | 128 | ec | — | `{prod_session}` | f | p50/max 135.5/135.5 s (30 d); deletes entity_connections |
| donor-party-rollup-orphan-sweep | pg_cron | `donor_party_rollup_orphan_sweep` | atomic | `CALL public.reconcile_donor_party_rollup_orphans();` | 5 | `at 0 13 1 * *` | io | 128 | rollups | — | `{prod_session}` | f | p50/max 290.5/290.5 s (30 d) |
| donor-party-rollup-refresh | pg_cron | `donor_party_rollup_refresh` | resumable | `CALL public.refresh_donor_party_rollup_incremental();` | 3 | `at 0 15 * * 2` | memory | 128 | rollups | 1800 | `{prod_session}` | f | cursor donor_party_full_rebuild (16 windows); p50/max 78.8/11335.1 s (30 d) |
| donor-rollup-orphan-sweep | pg_cron | `donor_rollup_orphan_sweep` | atomic | `CALL public.reconcile_donor_rollup_orphans();` | 5 | `at 30 12 1 * *` | memory | 128 | rollups | — | `{prod_session}` | f | p50/max 103.5/103.5 s (30 d) |
| donor-rollup-refresh | pg_cron | `donor_rollup_refresh` | resumable | `CALL public.donor_rollup_rebuild_bulk();` | 2 | `at 0 9,12 * * *` | memory | 128 | rollups | 9000 | `{prod_session}` | t | cursor donor_rollup_bulk_sweep; p50/max 0.2/2498.2 s (30 d); also refreshes official_homepage_stats_mv (mvs) |
| dpr-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.donor_party_rollup_mv;` | 4 | `at 0 2 * * 0,3` | io | 64 | rollups | — | `{}` | t | p50/max 2.4/8.0 s (30 d); no-band |
| ec-crawl | pg_cron | `entity_connections_rebuild` | resumable | `CALL public.run_entity_connections_rebuild('incremental', p_max_units := 1);` | 2 | `at */15 * * * *` | mixed | 128 | ec | 1800 | `{prod_session,blackout}` | t | cursor entity_connections_rebuild_cursor; unit p_max_units 1; p50/max 0.2/2109.3 s (30 d); no-band |
| ec-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.entity_connections;` | 4 | `at 30 4 * * *` | io | 64 | ec | — | `{}` | t | p50/max 78.9/3147.9 s (30 d) |
| ecs-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.entity_connection_stats_mv;` | 4 | `at 20 11,17 * * *` | io | 64 | ec | — | `{}` | t | p50/max 4.4/17.5 s (30 d); no-band |
| entity-connection-stats-orphan-sweep | pg_cron | `entity_connection_stats_orphan_sweep` | atomic | `CALL public.reconcile_entity_connection_stats_orphans();` | 5 | `at 30 13 1 * *` | io | 128 | ec | — | `{prod_session}` | f | p50/max 92.8/92.8 s (30 d) |
| entity-connection-stats-rebuild | pg_cron | `entity_connection_stats_rebuild` | atomic | `CALL public.rebuild_entity_connection_stats();` | 3 | `at 0 16 * * 1,3` | mixed | 128 | ec | 9000 | `{prod_session}` | f | INACTIVE on prod (jobid 16 parked): rollup_watch_overrides: retired 2026-08-26; no-band |
| fe-crawl | pg_cron | `financial_entity_totals_refresh` | resumable | `CALL public.run_fe_totals_crawl(p_max_units := 1);` | 2 | `at */30 * * * *` | io | 128 | fe-totals | 1800 | `{prod_session,blackout}` | t | cursor fe_crawl + fe_crawl_bootstrap_progress; unit p_max_units 1; p50/max 0.2/1952.5 s (30 d); no-band |
| fe-inbound-rollup-refresh | pg_cron | `financial_entity_inbound_rollup` | resumable | `CALL public.run_fe_inbound_rollup(p_max_units := 10)` | 2 | `at 13 2 * * *` | cpu | 128 | fe-totals | 1800 | `{prod_session}` | f | cursor financial_entity_inbound_rollup_watermark.resume_after; unit 10x200; p50/max 0.1/102.7 s (30 d); no-band |
| fe-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.financial_entities;` | 4 | `at 50 4 * * *` | io | 64 | fe-totals | — | `{}` | t | p50/max 11.6/99.2 s (30 d) |
| financial-entity-totals-incremental | pg_cron | `financial_entity_totals_refresh` | atomic | `CALL public.refresh_financial_entity_totals_incremental();` | 3 | `at 0 10 * * 2` | io | 256 | fe-totals | 7200 | `{prod_session}` | f | INACTIVE on prod (jobid 13 parked): no-band |
| financial-entity-totals-reconcile | pg_cron | `financial_entity_totals_reconcile` | atomic | `CALL public.reconcile_financial_entity_totals();` | 5 | `at 0 12 1 * *` | io | 128 | fe-totals | — | `{prod_session}` | f | p50/max 155.4/155.4 s (30 d) |
| fr-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.financial_relationships;` | 1 | `at 0 3 * * *` | io | 64 | fr-table | — | `{}` | t | p50/max 10.4/212.0 s (30 d); no-band |
| group-donor-rollup-refresh | pg_cron | `group_donor_rollup_refresh` | atomic | `CALL public.run_group_donor_rollup_refresh();` | 3 | `at 10 3 * * 3` | memory | 128 | rollups | 1800 | `{prod_session}` | f | p50/max 101.5/294.2 s (30 d); cap 128 = cc-219's 20261013010000 64MB; prod read 256MB (20261004070000) |
| odbt-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.official_donor_bracket_totals;` | 4 | `at 18 11,17 * * *` | io | 64 | rollups | — | `{}` | t | p50/max 0.3/1.4 s (30 d); no-band |
| odr-mv-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.official_donor_rollup_mv;` | 4 | `at 5 11,17 * * *` | io | 64 | rollups | — | `{}` | t | p50/max 1.5/2.5 s (30 d); no-band |
| odt-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.official_donor_totals;` | 4 | `at 12 11,17 * * *` | io | 64 | rollups | — | `{}` | t | p50/max 0.2/0.3 s (30 d); no-band |
| officials-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.officials;` | 4 | `at 30 1 * * 1` | io | 64 | officials | — | `{}` | t | p50/max 3.8/4.0 s (30 d); no-band |
| osar-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.official_sector_affinity_rollup;` | 4 | `at 16 11,17 * * *` | io | 64 | rollups | — | `{}` | t | p50/max 0.3/1.0 s (30 d); no-band |
| osdr-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.official_small_dollar_rollup;` | 4 | `at 14 11,17 * * *` | io | 64 | rollups | — | `{}` | t | p50/max 0.2/0.2 s (30 d); no-band |
| platform-counts-daily | pg_cron | `platform_counts_daily` | atomic | `CALL public.refresh_platform_counts();` | 2 | `at 53 3 * * *` | io | 128 | platform | 1800 | `{}` | f | p50/max 59.7/324.6 s (30 d); no-band |
| rebuild-ec-incremental | pg_cron | `entity_connections_rebuild` | atomic | `CALL public.run_entity_connections_rebuild('incremental');` | 3 | `at 0 8 * * 3` | mixed | 128 | ec | 18000 | `{prod_session}` | f | INACTIVE on prod (jobid 2 parked): no-band |
| rebuild-ec-incremental-mon | pg_cron | `entity_connections_rebuild` | atomic | `CALL public.run_entity_connections_rebuild('incremental');` | 3 | `at 0 8 * * 1` | mixed | 128 | ec | 18000 | `{prod_session}` | f | INACTIVE on prod (jobid 22 parked): no-band |
| refresh-derived-mvs-daily | pg_cron | `refresh_derived_mvs` | atomic | `CALL public.refresh_derived_mvs('daily');` | 2 | `at 0 6 * * *` | mixed | 256 | mvs | 5400 | `{prod_session}` | f | p50/max 354.8/1207.6 s (30 d); no persisted cursor: a re-run starts at unit 1; rebuild_all_primary_sources also writes financial_entities, votes, officials |
| refresh-derived-mvs-weekly | pg_cron | `refresh_derived_mvs` | atomic | `CALL public.refresh_derived_mvs('weekly');` | 3 | `at 47 0 * * 2` | mixed | 256 | mvs | 5400 | `{prod_session}` | f | p50/max 1407.5/1593.2 s (30 d); no persisted cursor: a re-run starts at unit 1; refresh_spending_totals also writes financial_entities; no-band |
| rule-taggers-daily | pg_cron | `run_rule_taggers` | atomic | `CALL public.run_rule_taggers('daily');` | 2 | `at 30 6 * * *` | io | 128 | tags | 7200 | `{prod_session}` | f | p50/max 225.7/7203.5 s (30 d) |
| rule-taggers-weekly | pg_cron | `run_rule_taggers` | atomic | `CALL public.run_rule_taggers('weekly');` | 3 | `at 0 16 * * 2` | memory | 128 | tags | 7200 | `{prod_session}` | f | p50/max 5062.9/19043.9 s (30 d); no-band |
| treemap-individuals-global-refresh | pg_cron | `treemap_individuals_global_refresh` | resumable | `CALL public.refresh_treemap_individuals_global();` | 3 | `at 0 14 * * 2` | cpu | 128 | rollups | 5400 | `{prod_session}` | f | cursor treemap_global_refresh.chunk_cursor (64 chunks); p50/max 916.4/994.1 s (30 d); treemap_individuals_rollup is also rewritten by donor-rollup-refresh |
| treemap-individuals-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.treemap_individuals_rollup;` | 4 | `at 10 11,17 * * *` | io | 64 | rollups | — | `{}` | t | p50/max 0.6/1.4 s (30 d); no-band |
| vm-probe-pre-ec | pg_cron | — | atomic | `SELECT public.record_vm_probe('pre-ec', ARRAY['entity_connections','votes'])` | 1 | `at 25 4 * * *` | cpu | 128 | — | — | `{}` | f | no-band |
| vm-probe-pre-fe | pg_cron | — | atomic | `SELECT public.record_vm_probe('pre-fe', ARRAY['financial_entities'])` | 1 | `at 45 4 * * *` | cpu | 128 | — | — | `{}` | f | no-band |
| vm-probe-pre-fr | pg_cron | — | atomic | `SELECT public.record_vm_probe('pre-fr', ARRAY['financial_relationships'])` | 1 | `at 55 2 * * *` | cpu | 128 | — | — | `{}` | f | no-band |
| vote-stats-refresh | pg_cron | `official_vote_stats_rebuild` | atomic | `CALL public.rebuild_official_vote_stats();` | 2 | `at 30 3 * * *` | cpu | 128 | votes | — | `{prod_session}` | f | p50/max 22.2/45.3 s (30 d); no-band |
| votes-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.votes;` | 4 | `at 37 2 * * 6` | io | 64 | votes | — | `{}` | t | p50/max 24.8/24.8 s (30 d) |
| xsr-vacuum-analyze | pg_cron | — | bare | `VACUUM (ANALYZE) public.external_source_refs;` | 4 | `at 41 1 * * 2` | io | 64 | xsr | — | `{}` | t | seeded ahead of cc-219's landing; cc-226 re-reads the slot the guard passed; no-band |
| audit | github_actions | — | atomic | `gha:audit.yml` | 3 | `at 0 4 * * 1` | io | 128 | — | 1800 | `{}` | f | weekly integrity report; reads prod, commits docs/audits; no-band |
| crs-summaries | github_actions | — | atomic | `gha:crs-summaries.yml` | 3 | `at 0 10 * * 6` | io | 128 | proposals | 21000 | `{}` | f | writes proposals.summary_plain; no data_sync_log row; no-band |
| irs990 | github_actions | `irs990` | atomic | `gha:irs990.yml` | 3 | `at 0 15 * * 1` | io | 128 | fr-table | 5400 | `{}` | f | writes financial_relationships (bulk) + financial_entities, officials, external_source_refs; no-band |
| nightly | github_actions | `nightly_cron` | atomic | `gha-dispatch:nightly` | 2 | `at 0 21 * * *` | mixed | 128 | fr-table | 18000 | `{prod_session}` | f | the START moves to the dispatcher in N2 (by 21:00Z..23:00Z); its fec phase takes the FIX-950 claim in N1 (cc-225); no-band |
| platform-snapshot | github_actions | — | atomic | `gha-dispatch:platform-snapshot` | 1 | `at */10 * * * *` | cpu | 128 | — | 600 | `{}` | f | request-path probe (curl www); writes nothing on prod; no-band |
| refresh-disposable-emails | github_actions | — | atomic | `gha:refresh-disposable-emails.yml` | 5 | `at 0 11 3 * *` | cpu | 128 | — | 900 | `{}` | f | opens a blocklist PR; writes nothing on prod; no-band |
| sync-canary-check | github_actions | — | atomic | `gha-dispatch:sync-canary-check` | 1 | `at 0 5 * * *` | cpu | 128 | platform | 300 | `{}` | f | canary: reads data_sync_log, stamps the nightly_cron row's metadata; no-band |

---

## §2 The contract matrix

Rows are the 21 active `CALL` jobs, the nightly, and the two GHA writers.
Columns are D9's nine items: ✓ = met, with file:line; ✗ = not met (what exists
is said); n-a = the item does not apply. Migration shorthands:
**m1** `20261009030000_fix1294_fix1295_fix1287_work_mem_m1.sql`, **m2**
`20261010010000_fix1295_work_mem_m2.sql`, **m3**
`20261010020000_fix1295_work_mem_m3.sql`, **1124**
`20261004075000_fix1124_crawl_yield_to_peers.sql`, **950r**
`20260911000200_fix950_guards_rebuild_family.sql`, **950o**
`20260911000100_fix950_guards_rollup_family.sql`, **1217**
`20260926000000_fix1217_fe_inbound_rollup.sql`, **p1a**
`20261003030000_fix1194_p1a_box_backoff_gates.sql`, **1126**
`20260906000400_fix1126_planned_counts_cached.sql`, **880**
`20260722020000_fix880_abuse_events_substrate.sql`, **501**
`20261004070000_fix501_group_donor_topn_fix1204_null_committee_overrides.sql`,
**reg** `20261014230000_fix1307_job_registry.sql`.

Item 4 (the FIX-950 claim) concerns writers outside the database. A pg_cron
body is GUARDED instead — it reads `prod_session_state()` and stands down — so
those cells read n-a with the guard's line. Item 7 (the upsert skip predicate)
is a TypeScript-writer item; SQL procedures that write in place read n-a.

| job | 1 unit entry `(p_max_rows, p_max_units)` + cursor | 2 one DSL row / unit, `partial` terminal | 3 row | 4 claim | 5 band | 6 vacuum owner for each rewritten table | 7 skip predicate | 8 SET work_mem + parallel 0 | 9 overrides row |
|---|---|---|---|---|---|---|---|---|---|
| abuse-events-retention | ✗ `purge_abuse_events(int,int)` 880:137 | ✗ writes no DSL row | ✓ reg:174 | n-a (unguarded) | ✗ | ✗ abuse_events (880:154) — none | n-a | ✗ no SET (role 64) | n-a (no DSL) |
| agency-staffing-rollup-refresh | ✗ no args, no cursor | ✓ p1a:1320 / `partial` p1a:1476 | ✓ reg:175 | n-a (guard p1a:1340) | ✗ | ✗ agency_staffing_rollup — none | n-a | ✗ SET 128 p1a:1354, no parallel 0 | ✗ |
| contract-flow-rollups-refresh | ✗ no args, no cursor | ✗ DSL m3:103, no `partial` | ✓ reg:177 | n-a (m3:123) | ✓ | ✗ contract_recipient_rollup (m3:160), contract_agency_sector_rollup (m3:240) — none | n-a | ✓ m3:137 / m3:138 | ✗ |
| donation-edge-orphan-sweep | ✗ | ✓ m3:393 / m3:446 | ✓ reg:181 | n-a (m3:392) | ✓ | ✓ entity_connections (m3:419) → ec-vacuum-analyze | n-a | ✓ m3:409 / m3:410 | ✗ |
| donor-party-rollup-orphan-sweep | ✗ | ✓ m3:506 / m3:555 | ✓ reg:182 | n-a (m3:505) | ✓ | ✓ donor_party_rollup_mv (m3:533) → dpr-vacuum-analyze | n-a | ✓ m3:519 / m3:520 | ✗ |
| donor-party-rollup-refresh | ✗ cursor, no args (m2:378) | ✓ m2:442 / m2:778 | ✓ reg:183 | n-a (m2:454) | ✓ | ✓ donor_party_rollup_mv (m2:645) → dpr-vacuum-analyze | n-a | ✓ m2:472 / m2:475 | ✗ |
| donor-rollup-orphan-sweep | ✗ | ✓ m3:613 / m3:663 | ✓ reg:184 | n-a (m3:612) | ✓ | ✓ official_donor_rollup_mv (m3:642) → odr-mv-vacuum-analyze | n-a | ✓ m3:626 / m3:627 | ✗ |
| donor-rollup-refresh | ✗ cursor, no args (m1:1483) | ✓ m1:1581 / m1:2097 | ✓ reg:185 | n-a (m1:1641) | ✓ | ✓ the six rollups (m1:1910–2029) → odr-mv/odt/osdr/osar/treemap/odbt; official_homepage_stats_mv (m1:2207) is an MV refresh | n-a | ✓ m1:1655 / m1:1656 | ✗ |
| ec-crawl | ✗ `p_max_units` + cursor, no `p_max_rows` (m1:99) | ✓ m1:216 / m1:1359 | ✓ reg:187 | n-a (m1:233) | ✗ | ✓ entity_connections (arms, e.g. `20260905000000:98`) → ec-vacuum-analyze; entity_connection_stats_mv (`20260828010000:187`) → ecs-vacuum-analyze | n-a | ✓ m1:349 / m1:350 | ✗ |
| entity-connection-stats-orphan-sweep | ✗ | ✓ m3:721 / m3:769 | ✓ reg:190 | n-a (m3:720) | ✓ | ✓ entity_connection_stats_mv (m3:748) → ecs-vacuum-analyze | n-a | ✓ m3:734 / m3:735 | ✗ |
| fe-crawl | ✗ `p_max_units` + cursor (950r:1282) | ✓ 950r:1330 / 950r:1562 | ✓ reg:192 | n-a (950r:1342) | ✗ | ✓ financial_entities (`20260704000000:191`, via the slice) → fe-vacuum-analyze | n-a | ✗ wrapper sets nothing; callee proconfig 64 (`20260903010000:153`); no parallel 0 | ✗ |
| fe-inbound-rollup-refresh | ✗ `p_max_units` + cursor (1217:286) | ✓ 1217:325 / 1217:539 | ✓ reg:193 | n-a (1217:334) | ✗ | ✗ financial_entity_inbound_rollup / _totals (1217:187–188) — none | n-a | ✗ callee proconfig 64 (1217:168); no parallel 0 | ✗ |
| financial-entity-totals-reconcile | ✗ | ✓ m3:829 / m3:936 | ✓ reg:196 | n-a (m3:828) | ✓ | ✓ financial_entities (m3:856) → fe-vacuum-analyze | n-a | ✓ m3:844 / m3:845 | ✗ |
| group-donor-rollup-refresh | ✗ | ✗ DSL 950o:3078, no `partial` | ✓ reg:198 | n-a (950o:3077) | ✓ | ✗ group_donor_rollup / _summary (501:136–137) — none | n-a | ✗ callee SET LOCAL 256 (501:59), no parallel 0 — cc-219's 20261013010000 fixes both | ✗ |
| platform-counts-daily | ✗ | ✗ DSL 1126:159, no `partial` | ✓ reg:205 | n-a (unguarded) | ✗ | ✗ platform_counts (1126:106), connection_type_counts — none | n-a | ✗ no SET (role 64) | ✗ |
| refresh-derived-mvs-daily | ✗ per-unit COMMIT, no cursor | ✓ 1124:520 / 1124:780 | ✓ reg:208 | n-a (1124:533) | ✓ (unit key `:rebuild_entity_search_index`) | ✗ entity_search_index (m1:2369), proposals/agencies/governing_bodies, 8 MVs — none; officials/votes/financial_entities owned | n-a | ✓ 128 at 1124:548 / 1124:571 (cap 256) | ✗ |
| refresh-derived-mvs-weekly | ✗ per-unit COMMIT, no cursor | ✓ 1124:520 / 1124:780 | ✓ reg:209 | n-a (1124:533) | ✗ | ✗ 5 MVs — none; financial_entities (`20260813000000:424`) owned | n-a | ✓ 128 at 1124:548 / 1124:571 (cap 256) | ✗ |
| rule-taggers-daily | ✗ | ✓ m1:2630 / m1:2790 | ✓ reg:210 | n-a (m1:2658) | ✓ | ✗ **entity_tags** (`20261001010000:282`, `20260920080000:243`) — none | n-a | ✓ m1:2675 / m1:2676 | ✗ |
| rule-taggers-weekly | ✗ | ✓ m1:2630 / m1:2790 | ✓ reg:211 | n-a (m1:2658) | ✗ | ✗ **entity_tags** — none | n-a | ✓ m1:2675 / m1:2676 (+ the weekly branch's 64 at m1:2718) | ✗ |
| treemap-individuals-global-refresh | ✗ chunk_cursor, no args (m2:71) | ✓ m2:106 / m2:287 | ✓ reg:212 | n-a (m2:117) | ✓ | ✓ treemap_individuals_rollup (m2:336) → treemap-individuals-vacuum-analyze | n-a | ✓ m2:134 / m2:135 | ✗ |
| vote-stats-refresh | ✗ | ✗ DSL m1:2860, no `partial` | ✓ reg:217 | n-a (m1:2859) | ✗ | ✗ official_vote_stats (m1:2878) — none | n-a | ✓ m1:2873 / m1:2874 | ✗ |
| nightly (GHA) | ✗ phase jobs | ✗ a `nightly_cron` row per run plus one per pipeline; `partial` per pipeline | ✓ reg:223 | ✗ — N1 (cc-225) | ✗ | ✗ FR, votes, officials, financial_entities, external_source_refs owned; proposals and others — none | ✗ partial: `fec-bulk/writer.ts:722` sets `skipUnchangedRows`; the other `DO UPDATE` sites are playbook C6's census (`ENGINEERING_PLAYBOOK.md:383-390`) | n-a (TS client; role default) | ✗ `nightly_cron` has no row |
| irs990 (GHA) | ✗ | ✗ one row per run (`irs990/index.ts:87` startSync), no unit | ✓ reg:222 | ✗ | ✗ | ✗ FR (`irs990/writer.ts:578`) and financial_entities owned; its filing tables — none | ✗ `.upsert` at `writer.ts:209/320/466`, no skip predicate | n-a | ✗ |
| crs-summaries (GHA) | ✗ | ✗ writes no DSL row | ✓ reg:221 | ✗ | ✗ | ✗ proposals (`backfill-crs-summaries.ts:247`) — none | ✗ plain `.update` | n-a | n-a |

**Column totals over the 21 active CALL jobs:**

| item | ✓ | ✗ | n-a |
|---|---|---|---|
| 1 unit entry point | **0** | 21 (6 have a cursor + a bound but not the signature; 3 take `p_max_units`) | — |
| 2 DSL row + `partial` | 16 | 5 (4 no `partial`, 1 no DSL row) | — |
| 3 registry row | 21 | — | — |
| 4 claim | — | — | 21 (19 guarded, 2 unguarded) |
| 5 band | 12 | 9 | — |
| 6 vacuum owner | 10 | 11 | — |
| 7 skip predicate | — | — | 21 |
| 8 SET + parallel 0 | 15 | 6 | — |
| 9 overrides row | 0 | 20 | 1 |

**Tables a scheduled body rewrites that NO vacuum row owns:**
`entity_tags` (both taggers — the largest by far; FIX-1258's compaction is the
one-time answer, and it still needs a recurring owner), `entity_search_index`
(TRUNCATE + INSERT daily), `abuse_events`, `agency_staffing_rollup`,
`contract_recipient_rollup`, `contract_agency_sector_rollup`,
`financial_entity_inbound_rollup`, `financial_entity_inbound_totals`,
`group_donor_rollup`, `group_donor_rollup_summary`, `platform_counts`,
`connection_type_counts`, `official_vote_stats`, `proposals`, `agencies`,
`governing_bodies`, and the 13 derived MVs. Most are small, and per D7 their
threshold, not a cron job, is the right lever. `entity_tags` and
`entity_search_index` are not small.

**Item 4's receipt reads differently from the prompt.** `usaspending-bulk` does
not claim on a CI run. It READS `prod_session_state()` and writes `skipped`
under a held session (`usaspending-bulk.yml:29`, `usaspending-bulk/index.ts:1305`,
FIX-1274). The CLAIM belongs to its supervised catch-up, taken by
`claim-prod-session.ts`. No scheduled GHA writer claims today.

---

## §3 The unitized fraction

Of the 21 active `CALL` jobs, weekly wall = cc-210 §1.1's p50 × firings per
week. A monthly job counts 12 / 52.18 = 0.23 firings per week.

| class | jobs | weekly wall (s) | share | Σ cap_mb |
|---|---|---|---|---|
| **resumable** | 6 — donor-rollup-refresh (0.2 × 14), ec-crawl (0.2 × 672), fe-crawl (0.2 × 336), donor-party-rollup-refresh (78.8 × 1), fe-inbound-rollup-refresh (0.1 × 7), treemap-individuals-global-refresh (916.4 × 1) | 1,200.3 | **8.3 %** | 768 |
| atomic, p50 < 2 min (D7: stay atomic) | 7 — abuse-events-retention 0.1, agency-staffing 42.0, donor-rollup-orphan-sweep 103.5, ecs-orphan-sweep 92.8, **group-donor-rollup-refresh 101.5**, platform-counts-daily 59.7, vote-stats-refresh 22.2 | 762.6 | 5.2 % | 1,024 |
| atomic, p50 > 2 min (the chunking candidates) | 8 — rule-taggers-weekly 5,062.9, refresh-derived-mvs-daily 354.8 × 7, contract-flow 1,904.4, rule-taggers-daily 225.7 × 7, refresh-derived-mvs-weekly 1,407.5, donor-party-rollup-orphan-sweep 290.5, financial-entity-totals-reconcile 155.4, donation-edge-orphan-sweep 135.5 | 12,572.0 | **86.5 %** | 1,280 |
| total | 21 | 14,535.0 (≈ 2,076 s/day) | | |

**Ranked by weekly wall, the chunking candidates are:** rule-taggers-weekly
5,063 s, refresh-derived-mvs-daily 2,484 s, contract-flow 1,904 s,
rule-taggers-daily 1,580 s and refresh-derived-mvs-weekly 1,408 s. Those five
are 85 % of the scheduled wall. Two of them (derived-mvs ×2) already COMMIT per
unit, so they need only a persisted cursor to become resumable, which would
move the resumable share from 8.3 % to 35 %.

**Caveat on p50.** The crawls' p50 is a skip (0.2 s): most `*/15` and `*/30`
firings find nothing dirty or stand down to a gate. Their real cost is the
tail — ec-crawl max 2,109 s, fe-crawl 1,953 s, donor-rollup 2,498 s. By max
rather than p50 the resumable class is the expensive one, and resumable is
exactly what lets a 2,000 s tail be cut into units. p50 measures the typical
week's occupancy, not the risk.

---

## §4 The D11 vacuum table (read 3, 00:43:03Z)

Trigger = `autovacuum_vacuum_threshold + scale_factor × reltuples`, with the
per-table `reloptions` (FIX-943) over the globals (0.2 / 50). V1's future
deadline for a vacuum row is `dead_tuples > 60 % of trigger`. Last wall is cc-210
§1.1's last firing.

| table | vacuum job | reltuples | n_live_tup | n_dead_tup | sf / threshold | trigger | 60 % | dead % of trigger | last_vacuum | last wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| entity_connections | ec-vacuum-analyze | 10,515,503 | 10,516,517 | **387,846** | 0.05 / 50 | 525,825 | 315,495 | **73.8 %** | 10-12 04:31Z | 8.9 |
| entity_connection_stats_mv | ecs-vacuum-analyze | 4,857,076 | 4,866,629 | 6,677 | 0.05 / 50 | 242,904 | 145,742 | 2.7 % | 10-12 17:20Z | 5.7 |
| financial_entities | fe-vacuum-analyze | 5,265,098 | 5,265,098 | 180 | 0.05 / 50 | 263,305 | 157,983 | 0.1 % | 10-12 04:51Z | 12.8 |
| financial_relationships | fr-vacuum-analyze | 15,600,127 | 0 † | 0 † | 0.02 / 50 | 312,053 | 187,232 | — † | — † | 10.7 |
| votes | votes-vacuum-analyze | 984,828 | 0 † | 0 † | 0.05 / 50 | 49,291 | 29,575 | — † | — † | 24.8 |
| donor_party_rollup_mv | dpr-vacuum-analyze | 2,972,746 | 0 † | 0 † | 0.02 / 50 | 59,505 | 35,703 | — † | — † | 7.8 |
| external_source_refs | xsr-vacuum-analyze (cc-219) | 609,548 | 1 † | 339 † | 0.05 / 50 | 30,527 | 18,316 | — † | — | — |
| treemap_individuals_rollup | treemap-individuals-vacuum-analyze | 1,244,235 | 1,244,235 | 0 | 0.05 / 50 | 62,262 | 37,357 | 0 % | 10-12 17:10Z | 0.6 |
| official_donor_rollup_mv | odr-mv-vacuum-analyze | 658,815 | 658,815 | 0 | 0.05 / 50 | 32,991 | 19,795 | 0 % | 10-12 17:05Z | 2.0 |
| officials | officials-vacuum-analyze | 39,107 | 39,107 | 0 | 0 / 1000 | 1,000 | 600 | 0 % | autovacuum 10-12 21:07Z | 4.0 |
| official_sector_affinity_rollup | osar-vacuum-analyze | 25,517 | 25,517 | 0 | 0.05 / 50 | 1,326 | 796 | 0 % | 10-12 17:16Z | 0.2 |
| official_donor_bracket_totals | odbt-vacuum-analyze | 20,468 | 20,468 | 0 | 0.05 / 50 | 1,073 | 644 | 0 % | 10-12 17:18Z | 0.1 |
| official_small_dollar_rollup | osdr-vacuum-analyze | 7,504 | 7,504 | 0 | 0.05 / 50 | 425 | 255 | 0 % | 10-12 17:14Z | 0.2 |
| official_donor_totals | odt-vacuum-analyze | 7,494 | 7,494 | 0 | 0.05 / 50 | 425 | 255 | 0 % | 10-12 17:12Z | 0.1 |

† **Counters discarded, not a reading.** `n_live_tup = 0` against 15.6M
`reltuples`, and a NULL `last_vacuum` on a table vacuumed daily at 03:00Z, is
what a crash restart leaves: cumulative statistics are dropped on crash
recovery. The 10-12 03:53Z restart (cc-229) is consistent with exactly this
split. Every table whose last vacuum ran BEFORE 03:53Z reads zeroed (FR 03:00Z,
votes Sat 02:37Z, dpr Sun 02:00Z, xsr never). Every table vacuumed or
autovacuumed after it reads live (EC 04:31Z, FE 04:51Z, the 17:xxZ series,
officials 21:07Z). This is inference from the pattern, not a
`pg_stat_database` read; read 3 did not ask, and the posture allowed three
statements. So **FR's dead-tuple % of trigger — the input V1 needs first — is
not readable tonight.** It becomes readable after the next fr-vacuum-analyze
(03:00Z) plus a day of writes.

**EC at 73.8 % is already past V1's 60 % line**, about 20 h after its 04:31Z
vacuum. Today's `ec-vacuum-analyze` at 04:30Z will reach it before autovacuum
does. Under a `dead_tuples > 60 %` rule EC would be dispatched now. That is the
first data point for E1's sizing.

---

## §5 What the seed could NOT derive

- **cost_class** comes from cc-210 §1.1's evidence column (R2 pgss temp, R4
  MemAvailable drop, R5 node sizes), mapped as the prompt said; no fresh
  instrument was run. Judgment calls: `vote-stats-refresh` "small" → `cpu`
  (every node under 64MB, 0 temp); the four inactive jobs have no §1.1 row and
  take their active sibling's class (EC rebuilds `mixed`, FE incremental `io`);
  the GHA rows (nightly `mixed`, irs990/crs/audit `io`, probe/canary/
  disposable `cpu`) are judged, not measured.
- **exclusion_group** for agency-staffing, group-donor and contract-flow:
  each writes a table no other job writes, so its group only adds exclusion.
  They follow the prompt's families. `crs-summaries` got a new single-member
  group, `proposals`.
- **The GHA rows' caps** (128) are the role default. A TS client sets no
  `work_mem`, and no GHA job was instrumented.
- **The xsr row** is seeded from cc-219's migration text, not from prod.
  `check:job-registry` warns on it until the receipts carry the job.
- **Stale constants noted, not changed:** `PGCRON_CEILING_SECONDS = 6 * 60 * 60`
  at `apps/civitics/src/lib/pipeline-runtime-stats.ts:132`. The role ceiling has
  been 3 h since `20260916000000_fix1185:87`; the prompt cited `:133`, and the
  constant is on `:132`. `PIPELINE_BUDGET_REFS`' comment "fec 150" is stale
  (300 since FIX-1100, `nightly.yml:175`). Three pg_cron pipelines are missing
  from `PIPELINE_BUDGET_REFS` altogether: `platform_counts_daily`,
  `financial_entity_inbound_rollup` and `group_donor_rollup_refresh`.
- **Item 9** cannot be met by convention today: FIX-1059 asks for an override
  row only when a job is unscheduled or paused. So 0 of the 20 DSL writers have
  one, and the canary infers cadence from the cron expression. The registry's
  `deadline_rule` is the natural absorber (D9 says so).

---

## §6 What contradicted the prompt

1. **19 guarded, not 17.** All 21 active CALL jobs except `abuse-events-retention`
   and `platform-counts-daily` consult `prod_session_state()`. The "17" matches
   cc-210 §1.1's count of bodies that SET `work_mem`, not the guard. With the
   inactive four, 23 rows carry `{prod_session}`.
2. **The resumable six differ.** `refresh-derived-mvs-daily/weekly` persist no
   cursor (atomic). `fe-inbound-rollup-refresh` (a `resume_after` cursor,
   `p_max_units := 10`) and `treemap-individuals-global-refresh` (a
   `chunk_cursor` over 64 chunks) are resumable. The count is still 6.
3. **group-donor-rollup-refresh's p50 is 101.5 s**, under the 2-min line, so
   it is not a chunking candidate by D7. The prompt listed it among the
   over-2-min ones.
4. **Two groups moved** for write targets: donation-edge-orphan-sweep → `ec`,
   treemap ×2 → `rollups` (§1).
5. **The retention DELETE has a budget row** (`cron-job-run-details-retention`,
   300 s). So "every bare row has budget NULL" holds for the VACUUM rows only
   (rule 120 is about VACUUMs), and the DELETE's cap is 128, not 64. The seed
   test asserts the VACUUM form.
6. **Open count was 40 at Phase 0, not 37.** cc-229 filed FIX-1304/1305/1306.
   This run's three filings make 43.
7. **Three `unit_call`s are `gha-dispatch:`**, not just the nightly's:
   `sync-canary-check` and `platform-snapshot` are Vercel-dispatched too.
8. **`check-workflow-parity.mjs` exports no parser and reads `jobs:`, not
   `on.schedule`.** check:job-registry carries its own ~20-line cron reader.
9. **The grant shape needed `service_role` in the REVOKE.** Supabase's default
   privileges give a new table ALL to it; on the clone it held INSERT on
   `dispatch_log` until the REVOKE named it.
10. **`cron_job_budget` INSERT sites are in 14 migration files**, not 13
    (FIX-1309's body says 14).
11. **The receipts' `cron_jobs[]` does not carry `xsr-vacuum-analyze` yet**,
    hence the check's one warning.
12. **The resumable rows' p50 understates them** (§3 caveat): the class is 8 %
    of typical wall and most of the tail risk.
13. **FR's dead-tuple figure is unreadable** (§4 †).
