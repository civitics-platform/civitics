# The measure-first census — 2026-10-04 (cc-186)

Five parked "measure before design" bullets, answered in one pass, plus two
censuses the next designs need and two entity reads for Craig:

| § | bullet | the question | answer in one line |
|---|---|---|---|
| 1 | FIX-1131 | where else does `rows=200` bite? | **13 routines** carry an exact `rows=200` node (of 179 `GROUP BY`s); the two over 100k (the EC-degree windows, 303,160 groups each) are **harmless as planned**; one **latent** unbounded copy (`refresh_entity_connection_stats_mv`, uncalled); nothing filed |
| 2 | FIX-1075 | which EC arms need windowing, on measured walls? | **none meets the trigger**; `_external` is the one to watch |
| 3 | FIX-1181 | is the 8 s PostgREST bound uniform? | **yes, for 11.0 days**; the mechanism is not determinable read-only |
| 4 | FIX-1132 | read the stats MV instead of `_conn`? | **the premise is wrong** (no `_conn` on the request path); **GO** for the daily unit, with an exact guard |
| 5 | FIX-1145 | what makes the FR index taken? | **no index needed**: 3 of the MV's 4 columns already exist in rollups; the 4th has no reader |
| 6 | FIX-1125 | who owns the swap-in bursts? | **the */30 status snapshot** (34.7 % of the day's swap-in), then ad-hoc operator reads; the 06:00 stack is 2.6 % |
| 7 | FIX-1189 O1 / FIX-1020 | the 11 unpaired candidate stubs | facts only: **11/11** miss the promotion's exact-name key; **all** their FEC money ($59.2M) sits on the stub (elected rows hold 0 FR rows); 6 anchor LittleSis rows (25); 4 encode a different seat; Al Green is already settled |
| 8 | FIX-1204 | what are Ridge Coal and Cumberland? | **fictional** — Franklin seed rows, `is_synthetic = true` |

Every figure names its **instrument**, its **database**, its **unit** and its
**window**. Prod reads went through `scripts/db-query.mjs --prod` (one
transaction, `SET TRANSACTION READ ONLY`), each opening with
`SET max_parallel_workers_per_gather = 0` unless a plan was being reproduced.
Every prod `EXPLAIN` in this document is a **plain** `EXPLAIN` — nothing was
executed on prod. Actuals (`EXPLAIN (ANALYZE, BUFFERS)`) come from the local
prod clone only, and every such block says so. Nothing was written to Pro.

---

## 0. Instruments, epochs, and the clone

### 0.1 State at start (2026-10-03 23:31 UTC)

| read | value |
|---|---|
| HEAD (primary, after `git pull`) | `784a876b` |
| `pnpm session:held` | `held=false … live_writers=0`, exit 0 |
| in-flight markers | `cc-184.running`, `cc-185.running` (expected), `cc-186.running` (this run) |
| `tests.yml` on `main` | 23:26 run `37161756665` success; 23:30 run `37162003697` in progress (FIX-1261, cc-185's) |
| `pnpm session:check` | `fixes:check` FAILED — `done.log` out of sync with trailers (FIX-1255/1259/1260/1261/1264 rows pending; cc-184/185's in-flight landings). Left to those sessions. |
| open count | **48** (`fixes:status`, derived) — the prompt expected 46; the difference is 184/185's work in flight |
| `fixes:status` | FIX-1075 OPEN (last row `reopen`, 2026-08-19); FIX-1020, 1124, 1125, 1131, 1132, 1145, 1181, 1189, 1204 OPEN (no row) |
| `.env.local` | `http://127.0.0.1:54321` (local) |

### 0.2 Counter epochs (prod, read 2026-10-03 23:33–23:37 UTC)

| instrument | value | what it means |
|---|---|---|
| `pg_stat_statements_info.stats_reset` | **2026-09-22 22:32:13.208** | pgss window = **11.04 days** at read time |
| `pg_postmaster_start_time()` | 2026-09-22 22:32:13.260 | 52 ms after the pgss reset — the pgss epoch **is** the 09-22 restart |
| `pg_stat_statements_info.dealloc` | 0 | no entry was evicted; every statement since the epoch is present |
| `pg_stat_statements.track` | `top` | nested statements (a function's body) are **invisible** to pgss (rule 111) |
| extension version | 1.11 | no execution-time histograms — "max only" for any "over N ms" claim |
| `pg_stat_database.stats_reset` | **NULL** | proves nothing about a window (the 2026-10-01 FE census showed these counters survived the 09-22 fast shutdown). Database-level counters below are "since an unknown epoch" and are **not** turned into per-day rates. |

Every pgss figure in this document is **since 2026-09-22 22:32:13 UTC**.

### 0.3 The clone (local Docker, read 2026-10-03 23:33 UTC)

The clone is the 08-10 prod restore with later local writes
(`financial_relationships` max `created_at` 2026-08-20, max `updated_at`
2026-09-03). Clone actuals are scaled by these ratios when a prod-scaled figure
is quoted; walls are never scaled (rule 132 — the clone understates
scan-bound work by a factor that is not a constant).

| table | prod `reltuples` | clone `reltuples` | prod ÷ clone | prod heap |
|---|---:|---:|---:|---:|
| `financial_relationships` | 14,464,491 | 10,416,109 | **1.389** | 4,932 MB |
| `entity_connections` | 10,430,786 | 6,941,060 | **1.503** | 2,919 MB |
| `financial_entities` | 5,226,993 | 3,681,199 | 1.420 | 1,919 MB |
| `votes` | 989,030 | 983,556 | 1.006 | 571 MB |
| `proposals` | 95,193 | 88,278 | 1.078 | 146 MB |
| `officials` | 39,026 | 37,175 | 1.050 | 20 MB |

<details><summary>Queries (§0)</summary>

```sql
-- prod
SELECT (SELECT stats_reset FROM pg_stat_statements_info), (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()), now();
SELECT pg_postmaster_start_time(), (SELECT dealloc FROM pg_stat_statements_info), (SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements');
SHOW pg_stat_statements.track;
-- prod and clone
SELECT relname, reltuples::bigint, pg_size_pretty(pg_relation_size(oid)) FROM pg_class
 WHERE relname IN ('financial_relationships','entity_connections','officials','proposals','votes','financial_entities') AND relkind = 'r';
-- clone
SELECT max(created_at), max(updated_at) FROM financial_relationships;
```
</details>

---

## 1. FIX-1131 — the `rows=200` signature

Measured by a delegated read in this session (prod plain EXPLAIN, clone EXPLAIN ANALYZE); spot-checked by the lead. Files named `scratchpad/r1/*` are the session's working files and are not committed; the cores are reproduced in the `<details>` blocks.

**Scope.** Every `GROUP BY` in the latest prod definition of every `public` function/procedure (`pg_proc.prosrc`), view (`pg_views`) and materialized view (`pg_matviews`); plain `EXPLAIN` of the candidates on prod; `EXPLAIN (ANALYZE, BUFFERS)` of the `rows=200` hits on the clone. Prod reads 2026-10-03 23:35–23:56 UTC; clone runs 23:48–00:00 UTC. Prod and clone are both PostgreSQL 17.6. Every prod statement ran with `SET max_parallel_workers_per_gather = 0` inside db-query's read-only transaction. Every clone `EXPLAIN ANALYZE` ran with `SET statement_timeout = '10min'` and `max_parallel_workers_per_gather = 0` (set up front so the plans compare with prod's; no DSM error occurred). No prod statement was `EXPLAIN ANALYZE`. No command was denied or prompted.

### Correction: the `_conn` fix was FIX-1123, not FIX-1112

The brief said the `_conn` fix was FIX-1112, inside `get_official_page`. Both parts are wrong:

- **FIX-1112** is the watermark-ratchet census (`docs/archive/fixes-archive.md`, `<!--id:FIX-1112-->`; commit `3a367aa8`). FIX-1131's bullet cites it as "a census filing in the FIX-1112 shape", meaning only "a census like FIX-1112".
- `_conn` lives in **`public.rebuild_entity_search_index()`**, the 9th unit of `refresh_derived_mvs('daily')` (jobid 9, 06:00 UTC). It does not appear in `get_official_page`. A grep for `_conn\b` over `supabase/migrations/` matches only the search-index migrations (FIX-748/1123/985/942) and `fix918`.
- The fix was **FIX-1123** (migration `20260901000000_fix1123_search_index_bounded_conn_windows.sql`; commits `2538988d` and `9d0b56a8`). Its header records the signature:

  ```
  -- DEFECT 1 — the stage build's group estimate is the no-statistics fallback.
  -- `EXPLAIN` of the `_conn` build on prod:
  --     Partial HashAggregate  (cost=994411.68..994413.68 rows=200 width=24)
  --       Group Key: entity_connections.from_id
  --       ->  Parallel Append  (cost=0.00..932629.26 rows=12356484 width=16)
  -- `rows=200` is the planner's default when it cannot estimate a group count —
  -- the GROUP BY sits over a UNION ALL of two different columns, so neither
  -- column's n_distinct is reachable. The true count is 3,225,903 (measured on the clone).
  ```

  The live prod `prosrc` of `rebuild_entity_search_index` (lines 80–92) holds the remedy:

  ```sql
  CREATE TEMP TABLE _conn (entity_id uuid, c int) ON COMMIT DROP;
  FOR i IN 1 .. 16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    INSERT INTO _conn (entity_id, c)
    SELECT w.entity_id, w.c
      FROM public.entity_search_conn_window(v_lo, v_hi) w;
  END LOOP;
  CREATE UNIQUE INDEX ON _conn (entity_id);
  -- ... ANALYZE so the eight INSERTs below join against a
  -- real row count rather than a default guess.
  ANALYZE _conn;
  ```

  `entity_search_conn_window` carries `proconfig = {work_mem=64MB, max_parallel_workers_per_gather=0}`.

**FIX-1123's fix class was to materialize into an `ANALYZE`d temp table and to bound the work with 16 uuid windows plus a per-function `work_mem`/parallel proconfig.** It used no `CREATE STATISTICS` and did not rewrite the aggregate. The 200 estimate is still present inside each window (hit #2 below). FIX-1123 bounded the node's memory and gave the downstream `INSERT`s a real row count. It did not repair the node's own estimate.

### How PG 17.6 reaches the 200 fallback (tested on the clone)

When the grouping key resolves to a base-table column, or to an expression over one, the planner uses that column's `n_distinct`. Keys of the following kinds have no statistics, and `estimate_num_groups` falls back to 200 (clamped to the input estimate when that is smaller):

- an output column of a `UNION`/`UNION ALL`, including one reached through an inlined set-returning SQL function;
- a column of a derived relation that is itself grouped on more than that one key, or `DISTINCT ON`;
- a window-function or aggregate output;
- an expression column of a CTE;
- a `VALUES` or function-scan output.

PG 17 does pass statistics through a **MATERIALIZED CTE** column that is a plain `Var`. The clone test below confirms it (6,807 groups, not 200). So CTEs alone are not a hazard. Expressions over base columns (class ii) produce an over-estimate from the column's `n_distinct`, never 200.

<details><summary>Clone synthetic test (plain EXPLAIN · clone · 2026-10-03 23:36 UTC)</summary>

```
EXPLAIN WITH c AS MATERIALIZED (SELECT to_id FROM financial_relationships) SELECT to_id, count(*) FROM c GROUP BY to_id;
  HashAggregate  (cost=488535.10..488603.17 rows=6807 width=24)          <- CTE column: stats pass through
EXPLAIN SELECT id, count(*) FROM (SELECT from_id AS id FROM entity_connections UNION ALL SELECT to_id FROM entity_connections) s GROUP BY id;
  Finalize GroupAggregate  (... rows=200 ...)  /  Partial HashAggregate (... rows=200 ...)   <- UNION ALL output: fallback
EXPLAIN SELECT to_id, count(*) FROM (SELECT to_id, from_id FROM financial_relationships GROUP BY to_id, from_id) s GROUP BY to_id;
  HashAggregate  (cost=572082.94..572084.94 rows=200 width=24)            <- one key of a 2-key derived group: fallback
EXPLAIN SELECT lower(display_name), count(*) FROM financial_entities GROUP BY 1;
  HashAggregate  (cost=244413.98..259659.87 rows=1219671 width=40)       <- expression over a base column: n_distinct, not 200
```
</details>

One finding falls outside the brief's three classes. **`public.primary_industry_tag()`** is a STABLE SQL set-returning function whose body is a `UNION ALL` of two `DISTINCT ON` arms, so it inlines. Every `GROUP BY` key that passes through it (`di.tag`, `dt.industry`, `ri.display_label`) therefore behaves like class (i). Seven candidate clauses inherit the fallback this way, including the MVs `chord_industry_flows_mv` and `official_sector_dollars_mv`.

### (a) Candidate list

*instrument: `pg_proc.prosrc` / `pg_views.definition` / `pg_matviews.definition` read and classified by a regex pass, then by reading every clause · database: prod · unit: definitions and GROUP BY clauses · window: read 2026-10-03 23:35 UTC*

| Quantity | Count |
|---|---|
| `public` functions and procedures on prod | 310 |
| … whose `prosrc` contains `GROUP BY` | 105 |
| `public` views / MVs on prod | 3 / 13 |
| … containing `GROUP BY` | 1 / 11 |
| **Definitions scanned** | **117** |
| … with `GROUP BY` only inside comments (`get_jurisdiction_page_live`, `rebuild_entity_connections`) | 2 |
| **`GROUP BY` clauses in code** | **179** in 115 definitions |
| **Candidate clauses (class i, ii or iii)** | **69** in 50 definitions |
| class (i): key is a `UNION`/`UNION ALL` output, directly or via `primary_industry_tag()` | 23 clauses / 19 definitions |
| class (ii): key is an expression (CASE, COALESCE, `->>`, cast, `date_trunc`, `concat_ws`, …) or an alias or position of one | 42 / 36 |
| class (iii): key is a column of a grouped, `DISTINCT ON`, window or function-scan relation | 24 / 20 |

The classes overlap: 69 clauses carry 89 class labels. The other 110 clauses group on plain base-table columns, or on plain columns of a simple CTE or subquery that statistics pass through.

`packages/db` and `apps/civitics` hold no Postgres `GROUP BY`. The `packages/db/src/supabase-logs.ts` hits are ClickHouse SQL for the Supabase Logs API. `packages/db/migrations/*.sql` is history whose live versions are covered above. The `apps/civitics` hits are comments.

<details><summary>Census queries</summary>

```sql
-- counts
SELECT count(*) FILTER (WHERE prosrc ~* 'group\s+by'), count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind IN ('f','p');                                   -- 105 | 310
SELECT count(*) FILTER (WHERE definition ~* 'group\s+by'), count(*) FROM pg_views WHERE schemaname='public';    -- 1 | 3
SELECT count(*) FILTER (WHERE definition ~* 'group\s+by'), count(*) FROM pg_matviews WHERE schemaname='public'; -- 11 | 13
-- dump (scratchpad/r1/dump_defs.sql → defs.txt): string_agg of '@@@@ FUNC|PROC|VIEW|MATVIEW name(args)' || prosrc/definition
-- then: comments stripped, statements containing GROUP BY extracted (stmts.mjs → gb_stmts.txt, 134 statements),
-- each clause's key and FROM sources parsed (classify.mjs → groupby_list.txt, 179 clauses), classified by reading (cls.txt).
```
```bash
grep -rn "GROUP BY" packages/db --include=*.ts --include=*.mjs --include=*.js --include=*.sql | grep -v types/database.ts
grep -rln "GROUP BY" apps/civitics --include=*.ts --include=*.tsx      # 4 files, all hits are comments
```
</details>

*instrument: classification by reading prod prosrc, with estimates from the plain-EXPLAIN batches A–E in (b) · database: prod · unit: GROUP BY clause; est. rows = planner estimate at that GROUP BY node · window: 2026-10-03 23:44–23:56 UTC*

| # | routine / view | GROUP BY (prod prosrc) | class | prod EXPLAIN ref · est. rows at that node |
|---|---|---|---|---|
| 5 | `check_cron_job_health` | `GROUP BY jobid, grp` | ii + iii | D3 · 1 |
| 6 | `check_cron_job_health` | `GROUP BY 1`<br>*= date_trunc('hour', d.start_time)* | ii | D3 · 1 |
| 10 | `chord_contract_flows_full` | `GROUP BY agency_id, agency_name, agency_acronym, sector`<br>*sector = COALESCE(ri.display_label ← primary_industry_tag(), CASE …)* | i + ii | B6 · 31 |
| 11 | `chord_donor_brackets_for_official` | `GROUP BY bracket`<br>*alias of CASE on fr.amount_cents* | ii | E2 · 11,694 |
| 12 | `chord_donor_state_party_flows` | `GROUP BY UPPER(fe.metadata->>'state'), party_chamber` | ii | E3 · 63,210 |
| 13 | `chord_donor_type_party_flows` | `GROUP BY donor_type, party_chamber`<br>*aliases of COALESCE(fe.entity_type,…), concat_ws(…)* | ii | E4 · 28,399 |
| 14 | `chord_industry_flows_for_official` | `GROUP BY COALESCE(di.tag, 'untagged')`<br>*di ← primary_industry_tag() = UNION ALL* | i + ii | B3 · **200** |
| 15 | `chord_sector_vote_for_officials` | `GROUP BY v.official_id, CASE WHEN v.vote IN ('yes', 'paired_yes') THEN 'yes' WHEN v.vote IN ('no', 'paired_no') THEN 'n…` | ii | B11 · 2,179 |
| 16 | `chord_sector_vote_for_officials` | `GROUP BY official_id`<br>*CTE grouped on (official_id, CASE)* | iii | B11 · **200** |
| 17 | `chord_sector_vote_for_officials` | `GROUP BY s.sector, b.vote_outcome` | ii + iii | B11 · 29 |
| 18 | `chord_subject_party_flows` | `GROUP BY et.tag, et.display_label, et.display_icon, party_chamber`<br>*party_chamber = concat_ws(…)* | ii | E5 · 13 |
| 19 | `chord_top_pacs_for_official` | `GROUP BY fe.id, fe.display_name, COALESCE(di.tag, 'untagged'), COALESCE(di.display_label, 'Untagged'), COALESCE(di.disp…`<br>*di ← primary_industry_tag() = UNION ALL* | i + ii | E1 · 2,877 |
| 21 | `derive_nh_floterials` | `GROUP BY x.district_id, x.base_district_ids` | iii | — (size) |
| 22 | `derive_nh_floterials` | `GROUP BY s.district_id, s.name, s.seats, s.base_district_ids` | iii | — (size) |
| 23 | `detect_brigade_candidates` | `GROUP BY b.tgt, b.dir_agree, b.dir_valuable` | ii | — (size) |
| 25 | `detect_brigade_candidates` | `GROUP BY g.tgt` | iii | — (size) |
| 27 | `detect_brigade_candidates` | `GROUP BY node` | i | — (size) |
| 28 | `detect_brigade_candidates` | `GROUP BY c.cid` | iii | — (size) |
| 29 | `detect_sybil_clusters` | `GROUP BY k.key_kind, k.ckey` | i + ii | — (size) |
| 30 | `detect_sybil_clusters` | `GROUP BY ord.key_kind, ord.ckey` | i | — (size) |
| 31 | `detect_sybil_clusters` | `GROUP BY k.key_kind, k.ckey, k.user_id` | i | — (size) |
| 32 | `detect_sybil_clusters` | `GROUP BY fw.key_kind, fw.ckey` | i + iii | — (size) |
| 34 | `donor_party_rollup_rebuild_donors` | `GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')` | ii | E6 · 164,566 |
| 39 | `donor_rollup_rebuild_bulk` | `GROUP BY d.to_id, COALESCE(fe.industry_tag, 'Untagged')` | ii | — (in-proc ANALYZE) |
| 40 | `donor_rollup_rebuild_bulk` | `GROUP BY d.to_id, COALESCE(fe.state, '??'), fe.display_name` | ii | — (in-proc ANALYZE) |
| 41 | `donor_rollup_rebuild_bulk` | `GROUP BY official_id, tier` | ii | — (in-proc ANALYZE) |
| 43 | `donor_rollup_rebuild_recipients` | `GROUP BY r.official_id, r.relationship_type`<br>*ranked ← per_donor grouped on 3 keys* | iii | B8 · 18,184 |
| 45 | `entity_search_conn_window` | `GROUP BY sub.id`<br>*sub = from_id UNION ALL to_id* | i | A1 · **200** |
| 52 | `get_browse_facets` | `GROUP BY facet_key, facet_value`<br>*unpivoted = 11-way UNION ALL* | i | D6 · **200** |
| 53 | `get_browse_facets` | `GROUP BY facet_key`<br>*per_value grouped on 2 keys* | iii | D6 · **200** |
| 55 | `get_connection_counts` | `GROUP BY id`<br>*sub = from_id UNION ALL to_id* | i | A4 · **200** |
| 57 | `get_ec_crawl_health` | `GROUP BY grp`<br>*window count() output* | ii + iii | D2 · 100 |
| 59 | `get_financial_entity_naics` | `GROUP BY side.entity_id, fr.metadata->>'naics_code'` | ii + iii | B7 · 155,178 (the DISTINCT ON above it: **200**) |
| 67 | `get_officials_breakdown` | `GROUP BY category`<br>*alias of CASE … END* | ii | C12 · 33,455 |
| 70 | `get_pac_treemap_by_party` | `GROUP BY r.party_key, pt.shown_cents` | iii | B13 · 49 |
| 72 | `get_pac_treemap_by_sector` | `GROUP BY industry_label`<br>*MIN() output of per_donor* | iii | B12 · **200** |
| 73 | `get_pac_treemap_by_sector` | `GROUP BY c.industry_label, st.shown_cents` | iii | B12 · 331 |
| 74 | `get_platform_daily_cost_deltas` | `GROUP BY wd`<br>*cast of payload jsonb, from a UNION CTE* | i + ii | D4 · 4 (the DISTINCT ON pac_day below it: **200** ×2) |
| 75 | `get_proposal_counts_by_agency` | `GROUP BY 1`<br>*= p.metadata->>'agency_id'* | ii | C12 · 92 |
| 78 | `get_pv_bots` | `GROUP BY visitor_type`<br>*alias of CASE … END* | ii | E8 · 1 |
| 81 | `get_pv_entry_pages` | `GROUP BY page`<br>*normalize_pv_path(page) under DISTINCT ON* | ii + iii | D5 · 20 |
| 86 | `get_pv_top_transitions` | `GROUP BY from_page, to_page`<br>*LAG() window output* | ii + iii | D5 · 2 |
| 88 | `get_top_connected_officials` | `GROUP BY entity_id`<br>*s = from_id UNION ALL to_id* | i | A5 · **200** |
| 91 | `link_officials_to_districts` | `GROUP BY official_id`<br>*ranked ← m = hit14 UNION ALL m5* | i + iii | D1 · 1 |
| 97 | `list_scheduled_rollup_pipelines` | `GROUP BY d.pipeline` | i | — (size) |
| 98 | `list_scheduled_rollup_pipelines` | `GROUP BY 1`<br>*= d.pipeline; drivers is a UNION* | i | — (size) |
| 103 | `rebuild_browse_facet_counts` | `GROUP BY kind, facet_key, facet_value`<br>*unpivoted = 11-way UNION ALL* | i | A6 · 63,661 |
| 111 | `rebuild_entity_connection_stats_window` | `GROUP BY sub.id`<br>*sub = from_id UNION ALL to_id* | i | A2 · **200** |
| 135 | `refresh_contract_flow_rollups` | `GROUP BY fr.to_id, fr.metadata->>'naics_code'` | ii | B5 · 1,072,634 |
| 136 | `refresh_contract_flow_rollups` | `GROUP BY rc.entity_id`<br>*rc = CTE grouped on (to_id, naics)* | iii | B5 · **200** |
| 137 | `refresh_contract_flow_rollups` | `GROUP BY agency_id, agency_name, agency_acronym, sector`<br>*sector = COALESCE(ri.display_label ← primary_industry_tag(), CASE …)* | i + ii | B6 · 31 |
| 138 | `refresh_donor_party_rollup_incremental` | `GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')` | ii | E6 · 164,566 |
| 139 | `refresh_entity_connection_stats_mv` | `GROUP BY sub.id`<br>*sub = from_id UNION ALL to_id* | i | A3 · **200** |
| 149 | `refresh_treemap_individuals_global` | `GROUP BY 1, 2`<br>*= COALESCE(fe.metadata->>'state','??'), fe.display_name* | ii | C11 · 154,791 |
| 151 | `sector_affinity_rebuild_officials` | `GROUP BY pd.official_id, COALESCE(dt.industry, 'Untagged')`<br>*pd: 2-key grouped CTE; dt ← primary_industry_tag()* | i + ii + iii | B4 · 40,000 (=200×200) |
| 156 | `treemap_individual_brackets_for_official_live` | `GROUP BY bracket`<br>*CASE over a SUM() output* | ii + iii | B10 · **200** |
| 158 | `treemap_individual_brackets_rebuild_officials` | `GROUP BY official_id, tier`<br>*tier = CASE over a SUM() output* | ii + iii | B9 · 19,165 |
| 159 | `treemap_individuals_rebuild_officials` | `GROUP BY fr.to_id, COALESCE(fe.metadata->>'state', '??'), fe.display_name` | ii | E7 · 189,525 |
| 160 | `treemap_officials_by_donations` | `GROUP BY sub.official_id, sub.official_name, sub.party, sub.state, sub.chamber` | ii | E9 · 11,158 |
| 161 | `treemap_officials_by_donations` | `GROUP BY sub.official_id, sub.official_name, sub.party, sub.state, sub.chamber` | ii | (same shape as #160) |
| 162 | `treemap_recipients_by_contracts_full` | `GROUP BY fr.to_id, fr.metadata->>'naics_code'` | ii | B5 · 1,072,634 |
| 163 | `treemap_recipients_by_contracts_full` | `GROUP BY rc.entity_id`<br>*rc = CTE grouped on (to_id, naics)* | iii | B5 · **200** |
| 165 | `chord_donor_state_party_flows_mv` | `GROUP BY ds.donor_state, (concat_ws(' '::text, initcap(COALESCE((o.party)::text, 'other'::text)), CASE WHEN (o.role_tit…` | ii + iii | C1 · 811,400 |
| 166 | `chord_donor_type_party_flows_mv` | `GROUP BY COALESCE(fe.entity_type, 'other'::text), (concat_ws(' '::text, initcap(COALESCE((o.party)::text, 'other'::text…` | ii | C2 · 28,399 |
| 167 | `chord_industry_flows_mv` | `GROUP BY COALESCE(di.tag, 'untagged'::text), (concat_ws(' '::text, initcap(COALESCE((o.party)::text, 'other'::text)), C…`<br>*di ← primary_industry_tag() = UNION ALL* | i + ii | B1 · 811,400 |
| 168 | `chord_subject_party_flows_mv` | `GROUP BY et.tag, et.display_label, et.display_icon, (concat_ws(' '::text, initcap(COALESCE((o.party)::text, 'other'::te…` | ii | C3 · 782 |
| 173 | `entity_engagement_rollup_mv` | `GROUP BY CASE WHEN ((g.role = 'official'::grant_role) AND (g.target_type = 'official'::grant_target_type)) THEN 'offici…` | ii | E8 · 1 |
| 174 | `homepage_agency_counts_mv` | `GROUP BY (metadata ->> 'agency_id'::text)` | ii | C4 · 92 |
| 177 | `official_sector_dollars_mv` | `GROUP BY fr.to_id, di.tag`<br>*di ← primary_industry_tag() = UNION ALL* | i | B2 · 55,052 |

### (b) Plain EXPLAIN on prod

*instrument: plain `EXPLAIN` with real ids/params substituted; plpgsql variables replaced by literals · database: prod · unit: rows (planner estimate) · window: read 2026-10-03 23:44:45–23:55:03 UTC*

Parameters used:

- top official `6282bdaf-…148d` (343,431 donor rows in `official_donor_totals`);
- 20-official array (first 20 by id with donations);
- 10 active senators;
- top donor WINRED `13b71e53-…6ca7`;
- uuid window 1 of the canonical 16 (`00000000-…` to `10000000-…`).

**45 of the 50 candidate definitions were EXPLAINed** (`treemap_officials_by_donations` with a simplified chamber CASE). The `rows=200` signature appears in 13 of them:

| ref | routine / statement | node with exactly `rows=200` | input estimate under it |
|---|---|---|---|
| A1 | `entity_search_conn_window` (window 1) | HashAggregate | Append 1,291,765 |
| A2 | `rebuild_entity_connection_stats_window` (window 1) | HashAggregate | Append 1,291,765 |
| A3 | `refresh_entity_connection_stats_mv` | HashAggregate | Append 20,861,572 |
| A4 | `get_connection_counts` (20 ids) | HashAggregate | Append 16,797 |
| A5 | `get_top_connected_officials(10)` | HashAggregate → Sort | Append 6,472,303 |
| B3 | `chord_industry_flows_for_official` | GroupAggregate → Sort | per-official FR rows |
| B5 | `refresh_contract_flow_rollups` stmt 1 = `treemap_recipients_by_contracts_full(500)` | GroupAggregate `rc.entity_id` → **Nested Loop 200** → Materialize 200 → Merge Right Join 200 | recipient_codes 1,072,634 |
| B7 | `get_financial_entity_naics` | Unique (`DISTINCT ON c.entity_id`) | HashAggregate 155,178 |
| B10 | `treemap_individual_brackets_for_official_live` | HashAggregate (`bracket`) | per_donor 80,769 |
| B11 | `chord_sector_vote_for_officials` (10 senators) | HashAggregate `official_total_votes` → Hash 200 | breakdown 2,179 |
| B12 | `get_pac_treemap_by_sector(NULL, 100000)` | HashAggregate `sector_tot` + 2× CTE Scan 200 | capped 4,413 |
| D4 | `get_platform_daily_cost_deltas(30)` | Unique (`DISTINCT ON pac_day`) ×2 | CTE Scan 1,420 |
| D6 | `get_browse_facets('official', party=democrat)` | HashAggregate `per_value` and `per_key` | filt 955 |

**Fallback-derived estimates that are not exactly 200.** These are products of 200 and other columns' `n_distinct`. All of them over-estimate:

| ref | statement | estimate | actual (source) |
|---|---|---|---|
| B1 | `chord_industry_flows_mv` definition | 811,400 | 101 (`count(*)` of the MV, prod) |
| C1 | `chord_donor_state_party_flows_mv` definition | 811,400 | 334 (MV, prod) |
| B4 | `sector_affinity_rebuild_officials` `by_sector` | 40,000 (= 200 × 200) | 30 (clone, 10 officials) |
| A6 | `rebuild_browse_facet_counts` | 63,661 + 7 | 144 (`browse_facet_counts`, prod) |
| B2 | `official_sector_dollars_mv` definition | 55,052 | 18,240 (MV, prod) |
| B9 | `treemap_individual_brackets_rebuild_officials` (10 officials) | 19,165 | ≤ 40 by construction |
| B8 | `donor_rollup_rebuild_recipients` `tail_rows` (1 official) | 18,184 | ≤ 3 by construction |

**Near-default `rows=1` on a derived group.** None is the fallback:

- `link_officials_to_districts` `resolved` estimates 1 because its upstream regex joins estimate WindowAgg rows=2.
- `check_cron_job_health` (D3) and `get_pv_bots` (E8) estimate 1 because their inputs are tiny.
- `donor_outbound_summary` (C7) estimates 1 because its base-table estimate for WINRED's `from_id` is 1 row. That is a statistics question for `financial_relationships.from_id`, not this signature.

**Controls showed no fallback.** These confirm the PG 17 CTE pass-through and the n_distinct path for class-ii expressions over base columns:

- `rebuild_official_vote_stats` (C8): 545 / 2,194 / 545;
- `get_vote_agreement_matrix` (C9): 21,816;
- `get_proposal_topic_groups` (C10): 51 / 56;
- `refresh_treemap_individuals_global` (C11): 154,791;
- `homepage_agency_counts_mv` (C4): 92;
- `get_officials_breakdown` (C12): 33,455 (actual 3);
- `chord_donor_brackets_for_official` (E2): 11,694 (actual ≤ 4);
- E1/E3–E7: 2,877 / 63,210 / 28,399 / 13 / 164,566 / 189,525.

**Five candidates were not EXPLAINed, with reasons:**

| definition | reason | size evidence |
|---|---|---|
| `detect_brigade_candidates` | harmless by size | `comment_ratings` holds 6 rows |
| `detect_sybil_clusters` | harmless by size | `abuse_events` holds 1 row |
| `derive_nh_floterials` | one-shot manual; groups `jsonb_to_recordset` spec rows | function-scan default 100 rows; NH spec is tens of districts; 0 pgss calls |
| `list_scheduled_rollup_pipelines` | harmless by size | its UNION `drivers` set is ≤ the 45 rows of `cron.job`; `data_sync_log` holds 8,329 rows |
| `donor_rollup_rebuild_bulk` | cannot be meaningfully EXPLAINed between runs | its staging tables `_drb_donor` / `_drb_chunk_fe` hold 0 rows between runs. The procedure runs `ANALYZE public._drb_donor; ANALYZE public._drb_chunk_fe;` (stripped prosrc lines 1674–1675) after each load and before every `GROUP BY` that reads them (lines 1700–1801), so its keys have fresh statistics |

<details><summary>Prod EXPLAIN SQL (full files in scratchpad/r1/prodA.sql … prodE.sql)</summary>

```sql
SET max_parallel_workers_per_gather = 0;
-- A1 entity_search_conn_window body, window 1
EXPLAIN SELECT sub.id, count(*)::int FROM (
  SELECT from_id AS id FROM public.entity_connections WHERE from_id >= '00000000-0000-0000-0000-000000000000'::uuid AND from_id < '10000000-0000-0000-0000-000000000000'::uuid
  UNION ALL
  SELECT to_id AS id FROM public.entity_connections WHERE to_id >= '00000000-0000-0000-0000-000000000000'::uuid AND to_id < '10000000-0000-0000-0000-000000000000'::uuid
) sub GROUP BY sub.id;
--   HashAggregate  (cost=43858.73..43861.23 rows=200 width=20)  ->  Append (rows=1291765)
-- A3 refresh_entity_connection_stats_mv: same shape over the whole table
--   HashAggregate  (cost=1073912.48..1073914.48 rows=200 width=34)  ->  Append (rows=20861572)
-- B5 refresh_contract_flow_rollups stmt 1 (recipient_codes GROUP BY to_id, naics; recipients GROUP BY rc.entity_id; JOIN financial_entities; LIMIT 500)
--   Limit -> Sort (rows=200) -> Merge Right Join (rows=200) -> Materialize (rows=200) -> Nested Loop (rows=200)
--     -> GroupAggregate Group Key: rc.entity_id (rows=200) -> Sort (rows=1072634) -> HashAggregate (rows=1072634)
--     -> Index Scan using financial_entities_pkey on financial_entities fe (rows=1)
-- B7 get_financial_entity_naics
--   Aggregate -> Unique (rows=200) -> Sort (rows=155178) -> HashAggregate Group Key: "*VALUES*".column1, (fr.metadata ->> 'naics_code') (rows=155178)
```
</details>

<details><summary>Call-path queries (pgss, cron, proc callers)</summary>

```sql
SET max_parallel_workers_per_gather = 0;
SELECT dealloc, stats_reset FROM pg_stat_statements_info;      -- 0 | 2026-09-22 22:32:13.208348+00 (no evictions; pgss.max 5000)
-- per name: pgss calls split pgrst_source vs other, cron.job.command matches, pg_proc.prosrc callers
-- (scratchpad/r1/callpaths.sql → callpaths.txt; pgss_hits.sql for the hits, excluding CREATE/COMMENT/GRANT statements)
SELECT jobid, jobname, active, schedule, command FROM cron.job
 WHERE command ~* 'refresh_derived_mvs|run_entity_connections_rebuild|refresh_contract_flow_rollups';
--  9 refresh-derived-mvs-daily 0 6 * * * | 10 refresh-derived-mvs-weekly 47 0 * * 2 | 45 ec-crawl */15 | 28 contract-flow-rollups-refresh 0 14 * * 4
-- nested-call counts since the epoch (data_sync_log):
SELECT count(*), avg((u->>'seconds')::numeric), max((u->>'seconds')::numeric)
  FROM public.data_sync_log l, jsonb_array_elements(l.metadata->'units') u
 WHERE l.pipeline='entity_connections_rebuild' AND l.started_at >= '2026-09-22 22:32:13+00'
   AND u->>'unit' LIKE 'entity_connection_stats_windows window%';                  -- 193 | 47.8 | 280.8
SELECT count(*), count(*) FILTER (WHERE metadata::text ILIKE '%rebuild_entity_search_index%')
  FROM public.data_sync_log WHERE pipeline='refresh_derived_mvs' AND started_at >= '2026-09-22 22:32:13+00';  -- 12 | 11
-- "no caller" evidence for refresh_entity_connection_stats_mv: 0 cron.job.command matches, 0 pg_proc.prosrc callers,
-- 0 pgss statements since the epoch; its only references are packages/data/src/scripts/rebuild-entity-connections.ts:509
-- (the local-dev umbrella path) and packages/data/src/seed/franklin/index.ts:1271
```
</details>

### (c) The `rows=200` hits measured on the clone

*instrument: `EXPLAIN (ANALYZE, BUFFERS)`; actual rows at the 200-node · database: clone (08-10 restore); prod-scaled = clone actual × the ratio named in the cell; prod actual where a cheap prod read exists · unit: rows; ms; kB · window: clone runs 2026-10-03 23:48:58–00:00:21 UTC; pgss since 2026-09-22 22:32:13 UTC. "Cold" means the first run in this session.*

| # | routine · node | est | clone actual | prod-scaled actual | plan consequence | caller(s) | pgss calls / mean since epoch |
|---|---|---|---|---|---|---|---|
| 1 | `rebuild_entity_connection_stats_window` · HashAggregate (window 1/16) | 200 | **203,124** (969 ms after K1 warmed the same index pages; 36,897 kB, 1 batch) | 305,295 (×1.503 EC); **prod actual 303,160** (range count on `entity_connection_stats_mv`) | Right shape, one batch. Proconfig `work_mem=64MB` × hash_mem_multiplier 2 gives a 128 MB ceiling; prod-scaled ~54 MB, about 2.4× headroom (~182 B/group → spills near ~720k groups/window, safely, since PG 13 hash-agg spill is bounded) | ec-crawl jobid 45 `*/15` → `run_entity_connections_rebuild` → `rebuild_entity_connection_stats` | nested: 193 window units since epoch, mean 47.8 s, max 280.8 s; parent `CALL` 1,061 × 15,612.7 ms |
| 2 | `entity_search_conn_window` · HashAggregate (window 1/16) | 200 | **203,124** (cold 20,592 ms, warm 905 ms; 28,705 kB, 1 batch) | 305,295; **prod actual 303,160** | Same; this is the FIX-1123 site after its fix. Proconfig 64 MB / parallel 0; ~42 MB prod-scaled, about 3.1× headroom (~141 B/group → spills near ~925k groups/window) | jobid 9 `refresh-derived-mvs-daily` 06:00 → `refresh_derived_mvs` → `rebuild_entity_search_index` (16 windows) | nested: 11 runs with the search unit × 16 ≈ 176 calls; parent `CALL refresh_derived_mvs($1)` 12 × 458,946.6 ms |
| 3 | `refresh_entity_connection_stats_mv` · HashAggregate (whole table) | 200 | **3,225,903** (cold 29,347 ms; **Batches 5, Memory 540,737 kB, Disk 53,200 kB**) | 4,848,532; prod `entity_connection_stats_mv` reltuples 4,832,771 | **The FIX-1123 failure shape, unchanged.** Hash agg exceeds work_mem 256 MB × hash_mem_multiplier 2 = 512 MB and spills. No `max_parallel_workers_per_gather=0` proconfig, so on prod (global 1) leader and worker could each take 512 MB | none scheduled: no `cron.job`, no `prosrc` caller; only `rebuild-entity-connections.ts:509` (local-dev path) and the franklin seed | **0** |
| 4 | `refresh_contract_flow_rollups` stmt 1 (= `treemap_recipients_by_contracts_full`) · GroupAggregate `rc.entity_id` → Nested Loop | 200 | **63,480** (cold 44,300 ms) | 88,174 (×1.389 FR) | **Real but modest.** The 200 estimate chose a Nested Loop of 63,480 index scans on `financial_entities_pkey`: 7.0 s of 44.3 s (36,861 → 43,866 ms), 40,773 buffer reads, then Materialize + Merge Right Join. The other 36.3 s is the FR bitmap heap scan | jobid 28 `contract-flow-rollups-refresh` Thu 14:00; `treemap_recipients_by_contracts` (`/api/graph/spending`) calls the `_full` copy only while `pipeline_state.contract_flow_rollups_state.bootstrapped` is false; backfill script | `CALL refresh_contract_flow_rollups()` 2 × 1,896,813.7 ms |
| 5 | `get_financial_entity_naics` · Unique (`DISTINCT ON c.entity_id`) | 200 | **63,419** (cold 23,398 ms) | 88,089 (×1.389) | None. Unique streams straight into `jsonb_agg`; nothing downstream is sized by it. Cost is the FR bitmap heap scan (16.4 s of 23.4 s) | `packages/data/src/pipelines/tags/rules.ts:1452` (direct pg) | 12 × 102,153.4 ms + 1 × 107,248.5 ms |
| 6 | `get_top_connected_officials(10)` · HashAggregate → Sort | 200 | 19,362 (cold 11,222 ms; 2,849 kB) | 20,330 (×1.050 officials) | None: 1 batch, top-N heapsort 26 kB. Cost is the index scan of 4.36 M entries with 1.59 M heap fetches | `/api/graph/connections` route.ts:767 | 0 |
| 7 | `get_connection_counts` (20 ids) · HashAggregate | 200 | 17 (1.7 ms) | ≤ 20 (bounded by input ids) | over-estimate; none | typeahead, graph/connections, search/entity, landing-data | 0 |
| 8 | `chord_industry_flows_for_official` · GroupAggregate → Sort | 200 | 6 (clone est. clamped to 149; 297 ms) | ≤ 17 (prod has 16 distinct FE industry tags, plus `untagged`) | over-estimate; none | `/api/graph/chord` | 0 (the 2 matches are CREATE statements) |
| 9 | `treemap_individual_brackets_for_official_live` · HashAggregate `bracket` | 200 | 0 (the clone has no individual donors for this official) | ≤ 4 (four CASE outcomes) | none | `treemap_individual_brackets_for_official` ← `/api/graph/treemap` | 0 |
| 10 | `chord_sector_vote_for_officials` · HashAggregate `official_total_votes` → Hash | 200 | 10 | ≤ cohort size | none | `/api/graph/chord` | 0 (the 1 match is a `COMMENT ON` statement) |
| 11 | `get_pac_treemap_by_sector` · HashAggregate `sector_tot` | 200 | 16 | ≤ 16 | none | `/api/graph/treemap-pac` | 1 × 6,929.7 ms |
| 12 | `get_browse_facets` · HashAggregate `per_value` / `per_key` | 200 / 200 | 63 / 5 | bounded by facet vocabularies (`browse_facet_counts` has 144 rows across all kinds) | none | `/api/browse/execute.ts:162` (narrowed sets only) | 0 |
| 13 | `get_platform_daily_cost_deltas(30)` · Unique `DISTINCT ON pac_day` ×2 | 200 | 0 (no snapshots after 08-10 on the clone) | ≤ 33 (one per day of the 32-day window; table 1,420 rows) | none | `packages/db/src/burn-rate.ts` | 531 × 261.2 ms |

**Outside the signature but on a hit's call path.** Statement 2 of `refresh_contract_flow_rollups` (the agency × sector arm, also `chord_contract_flows_full`) is estimated at **31 rows on prod / 60 on the clone** at its join. The clone measured **3,240,205 rows** (K15, cold 62,433 ms). That under-estimate produces:

- a Nested Loop of 3.24 M index-only probes into `financial_entities` (11.2 M buffer hits);
- two external sorts, 447,664 kB and 270,048 kB on disk.

The cause is a per-agency `fr.from_id = a.id` selectivity of 1 row against about 24,900 actual. That is a base-statistics problem, not the 200 fallback. On the clone it costs more than hit #4 does, and it is the more likely cause of the 1,896.8 s mean `CALL`. Likewise `chord_industry_flows_mv` (weekly jobid 10) is over-estimated at 811,400 groups against 101 actual (K16, cold 28,848 ms on the clone; clone estimate 746,800). The planner therefore fed a GroupAggregate with a 2,017,752-row quicksort of 223,439 kB (~4.3 s) where a ~101-group HashAggregate would have needed no sort. At prod scale (×1.389) that sort would exceed `work_mem` 256 MB and go external.

<details><summary>Clone EXPLAIN ANALYZE outputs (full: scratchpad/r1/clone1.out … clone7.out)</summary>

```
K1 entity_search_conn_window window 1, SET work_mem='64MB' (cold)
 HashAggregate  (cost=64113.25..64115.75 rows=200 width=20) (actual time=20539.421..20582.681 rows=203124 loops=1)
   Batches: 1  Memory Usage: 28705kB
   ->  Append  (... rows=878681 ...) (actual ... rows=862717 loops=1)
 Execution Time: 20591.637 ms        (K1b warm: 905.153 ms)
K2 rebuild_entity_connection_stats_window agg, window 1
 HashAggregate  (cost=83883.57..83885.57 rows=200 width=34) (actual time=905.712..959.627 rows=203124 loops=1)
   Batches: 1  Memory Usage: 36897kB
K3 refresh_entity_connection_stats_mv SELECT (cold)
 HashAggregate  (cost=1237762.63..1237764.63 rows=200 width=34) (actual time=27752.974..29215.981 rows=3225903 loops=1)
   Batches: 5  Memory Usage: 540737kB  Disk Usage: 53200kB
 Execution Time: 29346.755 ms
K5 get_top_connected_officials(10) (cold)
 HashAggregate (... rows=200 ...) (actual ... rows=19362 loops=1)  Batches: 1  Memory Usage: 2849kB
 Execution Time: 11221.630 ms
K6 refresh_contract_flow_rollups stmt 1 (cold)
 Materialize (... rows=200 ...) (actual time=36642.912..43912.497 rows=63480 loops=1)
   ->  Nested Loop (... rows=200 ...) (actual time=36642.909..43866.411 rows=63480 loops=1)
         ->  GroupAggregate (... rows=200 ...) (actual time=36642.407..36861.198 rows=63480 loops=1)  Group Key: rc.entity_id
         ->  Index Scan using financial_entities_pkey on financial_entities fe (actual time=0.110..0.110 rows=1 loops=63480)
 Execution Time: 44300.336 ms
K7 get_financial_entity_naics (cold)
 Unique (cost=791651.15..792142.88 rows=200 width=88) (actual time=22603.970..22642.840 rows=63419 loops=1)
 Execution Time: 23397.931 ms
K15 refresh_contract_flow_rollups stmt 2 (cold) — not the signature
 Nested Loop (cost=0.56..1196.86 rows=60 width=197) (actual time=3.460..25216.492 rows=3240205 loops=1)
 Sort Method: external sort  Disk: 447664kB  /  Sort Method: external merge  Disk: 270048kB
 Execution Time: 62433.312 ms
K16 chord_industry_flows_mv definition (cold) — 200-derived over-estimate
 GroupAggregate (cost=1045460.53..1099189.27 rows=746800 width=152) (actual time=27504.120..28848.150 rows=101 loops=1)
   ->  Sort (... rows=1659587 ...) (actual ... rows=2017752 loops=1)  Sort Method: quicksort  Memory: 223439kB
```
</details>

### (d) Ranking, trigger, fix class

*instrument: derived from (b) and (c) · database: prod actual where read, otherwise prod-scaled clone · unit: (actual ÷ 200) × calls since the pgss epoch, nested calls counted from `data_sync_log` · window: as in (c)*

| rank | hit | actual ÷ 200 | calls since epoch | score | meets "est 200 vs actual > 100k on a called path"? | verdict | fix class |
|---|---|---|---|---|---|---|---|
| 1 | #1 `rebuild_entity_connection_stats_window` | 1,515.8 | 193 | 292,549 | **Yes on the numbers** (303,160 per window, ec-crawl) | **Harmless**: the hash agg is the right plan, one batch, bounded by its 64 MB proconfig with ~2.4× headroom | explicit no-op. The FIX-1115/FIX-1123 bound is the remedy. CREATE STATISTICS cannot attach to a UNION ALL output |
| 2 | #2 `entity_search_conn_window` | 1,515.8 | ≈176 | ≈266,781 | **Yes on the numbers** (303,160 per window, jobid 9) | **Harmless**: this is FIX-1123's own fixed site; ~3.1× headroom | no-op. Optional rewrite named in FIX-1123's bullet: read degree from `entity_connection_stats_mv` (kept current by #1) instead of re-aggregating |
| 3 | #5 `get_financial_entity_naics` | 440.4 | 13 | 5,725 | No (~88k < 100k) | **Harmless** (no consumer is sized by it) | no-op |
| 4 | #4 `refresh_contract_flow_rollups` stmt 1 / `treemap_recipients_by_contracts_full` | 440.9 | 2 | 882 | No (~88k, below the bar and growing with contract rows) | **Real, modest** (≈7 s nested loop on the clone) | rewrite to one `GROUP BY fr.to_id` (the dominant code via an ordered aggregate), or materialize `recipient_codes` into an `ANALYZE`d temp table (FIX-1123 class; the caller is plpgsql). Not CREATE STATISTICS |
| 5 | #3 `refresh_entity_connection_stats_mv` | 24,164 | **0** | 0 | No: 4.83 M ≫ 100k, but **not on a called path** | **Latent defect**: an exact FIX-1123 repeat (540 MB + spill) if anyone runs it on prod | retire, or re-point its two script callers at the windowed `rebuild_entity_connection_stats` |
| 6 | #6 `get_top_connected_officials` | 101.7 | 0 | 0 | No | Harmless | no-op |
| 7–13 | #7–#13 | < 1 (over-estimates) | 0–531 | ≤ 88 | No | Harmless by size; the 200 is too *high* | no-op |

**Recommendation.** The `rows=200` signature is wider than `_conn`. 13 prod routines carry an exact `rows=200` node, out of 50 candidate definitions and 69 candidate clauses among 179 `GROUP BY`s. But only two cases match the dangerous FIX-1123 shape:

- **Hits #1 and #2** (the 16-window EC-degree aggregates) **meet the filing trigger on the numbers**: 200 against 303,160 actual groups per window on called paths (ec-crawl and jobid 9). They are harmless as planned, because FIX-1115/FIX-1123 already bounded them with per-function 64 MB proconfigs that leave 2.4–3.1× headroom. File nothing new for them. If anything is filed, make it a headroom watch: spill begins near ~720k groups per window for #1 and ~925k for #2.
- **#3 `refresh_entity_connection_stats_mv`** is the only live copy of the unbounded FIX-1123 shape. On the clone it uses 540,737 kB of hash memory, spills across 5 batches, and has no parallel-0 guard. It sits off every scheduled path (0 calls since the epoch) and misses the trigger only for that reason. It should be retired or re-pointed rather than left as a break-glass foot-gun.
- **#4 (contract-flow recipients)** has a real but small plan cost, below the bar at ~88k prod-scaled. In the same weekly procedure, the bigger measured lever is the non-200, 31-row join under-estimate in statement 2.
- **All other hits are harmless over-estimates**: their actual group counts are 0–20,330.

**CREATE STATISTICS**, the first remedy in FIX-1131's bullet, applies to none of the 13 hits. Every key is an output of a UNION ALL, a grouped or `DISTINCT ON` relation, or a CTE expression, and extended statistics only attach to base-table columns and expressions. The FIX-1034 precedent was base-table. Class-(ii) expressions over base columns never produced 200 on PG 17.6; they over-estimate from the column's `n_distinct`.

---

## 2. FIX-1075 — the EC arms' real timings

### 2.1 Where the walls are recorded

`run_entity_connections_rebuild` (prod `pg_proc.prosrc`, the body
`20260911000200_fix950_guards_rebuild_family.sql` last replaced) stamps three
things on its `data_sync_log` row (`pipeline = 'entity_connections_rebuild'`):

- `metadata.arm_timings` — FIX-1056's per-arm elapsed, **for every outcome**:
  ```sql
  v_arm_timings := v_arm_timings || jsonb_build_object(
    v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);
  ```
  ⚠ For an arm the FIX-1117 gate skips, the same key carries the **fingerprint
  probe's** seconds (`jsonb_build_object(v_fn, round(v_fp_secs)::int)`), not an
  arm run. Read alone, `arm_timings` cannot tell a 4 s probe from a 4 s arm.
- `metadata.units` — one `crawl_record_unit()` record per unit:
  `{unit, seconds, rows, rate, backoff_set, …}`. A gated arm's unit is named
  `"<arm> (gated)"` with `rows = 0`. **This is the instrument used below.**
- `metadata.gated_arms` / `gated_count`.

The ring (`pipeline_state.ec_crawl.recent_units`, 50 entries) carries the same
records plus `outcome`, but holds only the last 50 units. Since FIX-1111 (the
crawl, 2026-08-27) each `*/15` firing runs **one** unit, so a unit's wall is
its firing's wall.

### 2.2 Per-arm walls

**Instrument:** `data_sync_log.metadata.units` · **database:** prod · **unit:**
seconds per unit, rows upserted per unit · **window:** 14 d (2026-09-19 23:45 →
2026-10-03 19:00) and the whole crawl era (2026-08-27 → 2026-10-03).

| arm | real units 14 d | gated 14 d | p50 s 14 d | max s 14 d | real units crawl era | p50 s | p90 s | max s | rows p50 | last real run |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `_external` | 2 | 32 | 997.4 | **1,003.6** | 9 | 908.7 | 1,011.7 | **1,043.9** | 574,353 | 09-27 02:30 |
| `entity_connection_stats_windows` (16 windows) | 256 | 18 | 35.9 | 665.6 | 598 | 53.4 | 259.4 | **1,973.9** | 26 | 10-03 12:45 |
| `donations_incr_windows` (FIX-1069) | 91 | — | 31.8 | 488.5 | 342 | 67.7 | 186.5 | 951.5 | 16,951 | 09-28 19:45 |
| `_contracts` | **0** | 34 | — | — | 12 | 345.6 | 436.2 | 1,878.3 † | 189,949 | **09-02 15:15** |
| `_votes` | 10 | 24 | 4.0 | 18.5 | 27 | 7.8 | 23.7 | 36.9 | 506 | 10-02 15:45 |
| `_oversight` | 3 | 31 | 8.7 | 8.9 | 10 | 8.7 | 8.8 | 8.9 | 0 | 09-27 02:15 |
| `_appointments` | 0 | 34 | — | — | 4 | 9.1 | 13.2 | 14.8 | 0 | 08-28 |
| `_lobbying` | 0 | 34 | — | — | 4 | 10.0 | 10.7 | 10.9 | 0 | 08-28 |
| `_cosponsors` | 0 | 34 | — | — | 4 | 8.8 | 9.3 | 9.5 | 0 | 08-28 |
| `_holds` | 0 | 34 | — | — | 4 | 8.7 | 9.2 | 9.3 | 0 | 08-28 |
| `_gifts` | 0 | 34 | — | — | 4 | 8.7 | 8.7 | 8.7 | 0 | 08-28 |
| `_investigation` | 0 | 34 | — | — | 4 | 0.1 | 0.1 | 0.1 | 1 | 08-28 |

† `_contracts` 1,878.3 s on 2026-08-31 12:15 is the one cancelled unit: rows 0,
`backoff_set = true` — the 1,800 s `cron_job_budget` row reaped it. Its eleven
completed runs are 327.2–439.0 s, all 189,949 edges.

Every `_external` run, in order (prod, `metadata.units`):

| started | seconds | edges |
|---|---:|---:|
| 08-27 07:30 | 903.7 | 574,209 |
| 08-27 16:00 | 894.5 | 574,209 |
| 08-28 00:00 | 877.0 | 574,209 |
| 08-28 08:30 | 882.7 | 574,209 |
| 08-30 22:15 | 908.7 | 574,353 |
| 09-06 14:30 | 951.5 | 574,420 |
| 09-13 04:15 | 1,043.9 | 574,495 |
| 09-20 02:00 | 991.2 | 574,590 |
| 09-27 02:30 | 1,003.6 | 574,650 |

Since the gate went live (FIX-1117, 08-28) it runs **weekly**, because the
weekly LittleSis ingest moves `external_relationships.ingested_at` — the
fingerprint's timestamp — on every row it re-ingests (`n_tup_upd` 1,814,645
against 603,651 live rows). It then rebuilds 574k byte-near-identical edges
(+441 edges over 31 days) by `DELETE … WHERE evidence_source =
'external_relationships'` + a full `INSERT … SELECT … GROUP BY`. Its wall rose
877 → 1,004 s over that month (+14 %) while its output rose 0.08 %.

### 2.3 Run outcomes and budgets

**Instrument:** `data_sync_log` (status + metadata flags) · **database:** prod ·
**unit:** firings · **window:** 14 d.

| status | firings | `unit_capped` | `canceled` | `budget_exhausted` | `backoff_tripped` |
|---|---:|---:|---:|---:|---:|
| partial | 343 | 343 | 0 | 0 | 1 |
| complete | 34 | 0 | 0 | 0 | 0 |
| skipped | 13 | 0 | 0 | 0 | 0 |
| deferred | 7 | 0 | 0 | 0 | 0 |

Cancelled units in 30 d: **two**, both stats windows — 09-14 14:15 (window
13/16, 2,001 s elapsed) and 09-17 14:45 (window 1/16, 1,886 s). No generic arm
was cancelled in 30 days.

The bounds a unit runs under (prod, by NAME — candidate 223):

| bound | value | source |
|---|---:|---|
| `cron_job_budget` `ec-crawl` | **1,800 s** | outside, the FIX-1063 watchdog (`*/2`) |
| `ec_crawl.unit_budget_seconds` | 1,800 s | `pipeline_state.ec_crawl` |
| `ec_crawl.backoff_abs_seconds` | 1,500 s | a completed unit this long trips a 2 h backoff |
| internal `c_budget` | 5 h | checked at arm boundaries only |
| `postgres` role `statement_timeout` | 3 h | in-backend ceiling (FIX-1185) |

### 2.4 Against the thresholds the prompt set

| arm | p50 ÷ 1,800 s | max ÷ 1,800 s | ever cancelled? |
|---|---:|---:|---|
| `_external` | **55 %** (14 d) | 58 % | no |
| stats windows | 2 % | **110 %** | yes, 2× (30 d) |
| donations windows | 4 % | 53 % | no (30 d) |
| `_contracts` | 19 % (crawl era) | 104 % † | once (08-31) |
| all others | < 1 % | ≤ 2 % | no |

`_contracts`' current wall vs the bullet's 128 s: there is **no** current wall —
it has been gated for 31 days (its source, FR `contract`/`grant`, changes only
on a USASpending ingest, which is manual-only). Its last eleven completions
were 327–439 s, **2.6–3.4×** FIX-1056's 128 s idle measurement of the
aggregate alone; the difference is the DELETE + INSERT of 189,949 edges. Its
runs fell at 07:00, 15:30, 23:30, 08:00, 19:00, 05:15, 04:15, 22:00, 12:15,
15:00, 09:45, 15:15 UTC — the box was not reliably idle for any of them.

### 2.5 Source-side size per arm (prod, `reltuples` / heap, read 23:40 UTC)

| arm | source (from `ec_arm_source_fingerprint`) | rows | heap |
|---|---|---:|---:|
| `_external` | `external_relationships` | 603,651 | 537 MB |
| `_contracts` | `financial_relationships` `contract`/`grant` | ≈ 3,904,447 ‡ | (of 4,932 MB) |
| `_gifts` / `_holds` / `_lobbying` | `financial_relationships` by type | 0 rows of those types in the MCV list | — |
| `_votes` | `votes` | 989,030 | 571 MB |
| `_oversight` | `agencies` | 134 | 216 kB |
| `_investigation` | `evidence_cards` | 0 | 8 kB |
| `_cosponsors` / `_appointments` | `proposal_cosponsors` / `career_history` | `reltuples = -1` (never analyzed; empty) | 0 |
| stats windows | `entity_connections` | 10,430,786 | 2,919 MB |

‡ `pg_stats.most_common_freqs` × `reltuples`: contract 3,325,386 + grant
579,061 (an estimate, not a count — a full count of 14.5M rows would breach the
2-minute read bound).

### 2.6 Recommendation (FIX-1075)

1. **No arm meets the bullet's trigger** ("`arm_timings` ≥ ~1,800 s on two
   consecutive firings"). Nothing should be windowed now.
2. **The arm to watch is `_external`, not `_contracts`.** It sits at 55 % of
   the 1,800 s unit bound at p50, it runs every week, and it grew +14 % in a
   month on flat output. At the observed ~4 s/day it reaches the 1,500 s
   backoff trip in roughly four months and the 1,800 s bound in roughly six —
   one month of nine readings, so a slope, not a trend (rule 24). It also
   partitions exactly as donations did (`from_id uuid`, the same 16 nibble
   windows), so it is the cheapest conversion when it is needed.
3. **The cheaper fix for `_external` is not windowing — it is the gate.** It
   reruns weekly because `ingested_at` moves on a re-ingest that changes
   nothing. A fingerprint on content (`count(*)` + a hash or `max(source_updated_at)`
   only) would skip most of those ~1,000 s runs. That is a FIX-1117 refinement,
   not FIX-1075 work.
4. **`_contracts`: never, on current evidence** — it has not run in 31 days and
   will next run after a manual USASpending ingest. Re-read its wall then.
5. **Small sources (votes, oversight, gifts, holds, lobbying, cosponsors,
   appointments, investigation): never.** All ≤ 37 s across the crawl era.
6. **"Bank before the arm" is needed regardless of windowing**, and the reason
   is a livelock, not a timing: a generic arm that outgrows the 1,800 s outside
   bound is cancelled by the watchdog, rolls back whole, banks nothing, records
   `seconds ≥ 1,500` → a 2 h backoff → retries → is cancelled again. Every 2 h,
   forever, and the cycle never closes (so the stats MV never refreshes either).
   The one cancelled `_contracts` unit (08-31, 1,878 s, 0 rows) is that shape
   happening once. The stats windows already escaped it by being windowed; the
   generic loop has no equivalent exit. The minimum change is a per-arm
   consecutive-cancel count that parks the arm (status `partial`, reason named)
   rather than retrying it into the same wall.

<details><summary>Queries (§2)</summary>

```sql
-- per-arm walls (14 d; the crawl-era table is the same with 90 d)
WITH runs AS (
  SELECT id, started_at, status, metadata FROM public.data_sync_log
  WHERE pipeline = 'entity_connections_rebuild' AND started_at >= now() - interval '14 days'
), u AS (
  SELECT r.id, r.started_at, regexp_replace(e->>'unit', ' window [0-9]+/16$', '') AS arm, e->>'unit' AS unit,
         (e->>'seconds')::numeric AS secs, (e->>'rows')::bigint AS rows_
  FROM runs r, jsonb_array_elements(COALESCE(r.metadata->'units','[]'::jsonb)) e
)
SELECT arm, count(*) FILTER (WHERE unit NOT LIKE '%(gated)') AS real_units,
       count(*) FILTER (WHERE unit LIKE '%(gated)') AS gated_marks,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FILTER (WHERE unit NOT LIKE '%(gated)') AS p50_s,
       max(secs) FILTER (WHERE unit NOT LIKE '%(gated)') AS max_s
FROM u GROUP BY arm;

-- every _contracts / _external unit, all time
SELECT r.started_at, e->>'unit', (e->>'seconds')::numeric, (e->>'rows')::bigint, e->>'backoff_set'
FROM public.data_sync_log r, jsonb_array_elements(COALESCE(r.metadata->'units','[]'::jsonb)) e
WHERE r.pipeline = 'entity_connections_rebuild'
  AND e->>'unit' IN ('rebuild_entity_connections_contracts','rebuild_entity_connections_external')
ORDER BY 2, 1;

-- outcomes (14 d) and cancels (30 d)
SELECT status, count(*), count(*) FILTER (WHERE (metadata->>'unit_capped')::boolean),
       count(*) FILTER (WHERE (metadata->>'canceled')::boolean),
       count(*) FILTER (WHERE (metadata->>'budget_exhausted')::boolean),
       count(*) FILTER (WHERE (metadata->>'backoff_tripped')::boolean)
FROM public.data_sync_log WHERE pipeline = 'entity_connections_rebuild' AND started_at >= now() - interval '14 days' GROUP BY status;
SELECT started_at, metadata->>'cancel_detail', metadata->>'elapsed_seconds' FROM public.data_sync_log
WHERE pipeline = 'entity_connections_rebuild' AND started_at >= now() - interval '30 days'
  AND ((metadata->>'canceled')::boolean OR status IN ('failed','running'));

-- bounds
SELECT * FROM public.cron_job_budget;
SELECT value - 'recent_units' - 'skips' FROM public.pipeline_state WHERE key = 'ec_crawl';
SELECT value->'disabled_arms' FROM public.pipeline_state WHERE key = 'ec_arm_source_fingerprints';  -- [] today

-- sources
SELECT relname, reltuples::bigint, pg_size_pretty(pg_relation_size(oid)) FROM pg_class WHERE relname IN (...);
SELECT v.val, round(v.freq::numeric * 14464491) FROM pg_stats s,
  LATERAL unnest(s.most_common_vals::text::text[], s.most_common_freqs) v(val, freq)
WHERE s.tablename = 'financial_relationships' AND s.attname = 'relationship_type';
SELECT relname, n_tup_ins, n_tup_upd, n_tup_del, n_live_tup FROM pg_stat_user_tables WHERE relname = 'external_relationships';
```
</details>

---

## 3. FIX-1181 — the pooled `statement_timeout`

**The tree has moved past the prompt's premise.** The bullet already records
cc-137 (2026-09-19) **refuting** the non-`LOCAL` `SET` candidate and leaving a
weekly re-read as the open question; cc-141 did read #1 on 09-21. This section
is weekly read #2, plus the facts the prompt asked for.

### 3.1 Statements past 8 s (pgss)

**Instrument:** `pg_stat_statements` · **database:** prod · **unit:** ms
(`max_exec_time` — completions only; rule 112) · **window:** 2026-09-22 22:32:13
→ 2026-10-03 23:37 UTC (11.04 d).

| role | statements with `max_exec_time > 8,000 ms` |
|---|---:|
| `service_role` | **0** |
| `authenticator` | **0** |
| `anon` | **0** |
| `authenticated` | **0** |

The bound is not merely respected, it is **binding**: five PostgREST statements
complete within 39 ms of it, and nothing completes above it.

| `service_role` RPC / table (pgrst_source) | calls | mean ms | max ms |
|---|---:|---:|---:|
| `enrichment_queue` (count, `status = $1`) | 467 | 4,823.1 | **7,993.3** |
| `link_officials_to_districts` | 3 | 7,824.3 | **7,984.5** |
| `enrichment_queue` (count, `status = $1 AND …`) | 469 | 4,834.8 | 7,984.2 |
| `check_senate_reference_cohort` | 488 | 3,612.6 | 7,983.6 |
| `search_graph_entities` | 482 | 3,035.2 | 7,961.5 |
| `refresh_primary_source_for_entities` | 1,194 | 70.0 | 5,982.3 |

The bullet's two named functions since the epoch: `link_officials_to_districts`
3 calls, max 7,984.5 ms; `refresh_primary_source_for_entities` 1,194 calls, max
5,982.3 ms. **No completion past 8 s.** (Their `postgres`-role rows — 4 calls,
max 171.9 ms — are direct-connection callers and carry the 3 h bound.)

### 3.2 The `SET` sites (rule 122)

`grep -rniE "SET +(LOCAL +)?statement_timeout|set_config\( *'statement_timeout'"`
over `apps/civitics`, `packages/db/src`, `packages/data/src` (2026-10-03 ~23:38
UTC): **apps/civitics — 0 executable sites. packages/db — 0.** Every hit in
`packages/data` is a `client.query("SET statement_timeout = …")` on a
`pg.Client`/`Pool` the code constructs itself (`direct-pg-upsert.ts:48`,
`heavy-rebuild.ts` ×6, `prod-op-gate.ts:80`, `prod-session.ts:533`,
`session-lock.ts:102`, `littlesis/matcher.ts:171`, and ~40 one-shot scripts);
two are `SET LOCAL` (`fr-rewrite-drain.ts:152`,
`verify-fix1252-naics-dominant.ts:156`). Those clients connect as **`postgres`
through the session pooler** (`supabase/.temp/pooler-url`: port **5432**; no
port-6543 DSN exists in the repo or `.env.local.prod`, which carries no DSN at
all — the pooler URL plus `SUPABASE_DB_PASSWORD` is the only shape). No
`apps/civitics` code opens a `pg` connection (`grep` for `from 'pg'`,
`new Pool(`, `new Client(`: 0). Prod `pg_proc.proconfig` carrying
`statement_timeout`: **0** functions (`_fix1128_probe_sleep` no longer exists).

cc-137's conclusion stands: no site can reach a PostgREST backend.

### 3.3 Which pooler the PostgREST path uses

`pg_stat_activity`, prod, 2026-10-03 23:37 UTC:

| usename | application_name | state | n | oldest `backend_start` |
|---|---|---|---:|---|
| `authenticator` | `postgrest` | idle | **9** | **2026-09-22 22:32:52** (11 d 01:04) |
| `pgbouncer` | `Supavisor (auth_query)` | idle | 1 | 2026-10-03 23:35:46 |
| `postgres` | `Supavisor` | active | 1 | 2026-10-03 23:35:46 (this read) |
| `supabase_admin` | (none) / `postgres_exporter` | idle | 2 | 2026-09-22 22:32:17 |

**PostgREST does not traverse Supavisor.** Its nine backends log in as
`authenticator` with `application_name = 'postgrest'` — its own pool of direct
connections. The prompt's question (does Supavisor transaction mode
`DISCARD ALL` between clients?) therefore does not apply to this path, and the
Supavisor docs were not fetched.

**And the pool churns.** Re-read at 23:53:35 UTC, the nine `backend_start`s
are: **one** at 2026-09-22 22:32:52 (39 s after the restart — the long-lived
connection, consistent with PostgREST's schema-cache `LISTEN` channel) and
**eight** at 23:53:24–23:53:27, i.e. seconds old at the re-read. Request-serving backends are
recycled continuously, so a login-time role GUC lives only as long as a
recycled backend — minutes, not days. That is the "pool churning normally"
condition the bullet named as the receipt.

Role settings (`pg_db_role_setting`, prod): `authenticator`
`{session_preload_libraries=safeupdate, statement_timeout=8s, lock_timeout=8s}`;
`authenticated` 8 s; `anon` 3 s; `service_role` **no row**; `postgres` IN
DATABASE `{statement_timeout=3h, work_mem=256MB}`.

### 3.4 Can an existing RPC sample the pool read-only?

**No.** No prod function reads `current_setting('statement_timeout')`, and the
FIX-1128 probe (`_fix1128_probe_sleep`) is gone. Sampling the nine backends'
effective bound needs a new function — a migration — out of scope here.

### 3.5 Recommendation (FIX-1181)

- **Mechanism:** not determinable read-only, and not determinable at all for
  the pre-09-15 episode (pgss has been wiped twice since). What this read adds:
  PostgREST's request-serving backends **recycle within minutes** (8 of 9 were
  under a minute old at 23:53), so a login-time GUC cannot be "frozen" on them
  for long today. A pre-09-15 over-bound completion would need either a pool
  that did not churn then, or a role-setting change at/near the 09-15 restart —
  cc-137's two accounts, still not separable from here.
- **Fix class:** accept and document. No non-`LOCAL` `SET` exists on a pooled
  path (FIX-1181's filing trigger is **not met** — nothing filed). Any future
  change to `authenticator`'s role settings reaches request backends as they
  recycle (minutes) — but **not** the one long-lived backend until a restart.
- **Weekly reads:** #1 (cc-141, 09-15 → 09-21) clean; **#2 (this, 09-22 →
  10-03, 11.0 d, with the pool observed churning) clean** — which is the
  receipt condition the bullet stated. Recommend closing FIX-1181 at the next
  clean weekly read rather than carrying it further.
- **A new, real finding from this read (§6):** the statements pressed against
  the bound are the status snapshot's `enrichment_queue` counts — 467 + 469
  completions out of ~531 firings, consistent with ~12 % of them being
  **cancelled at 8 s** every half hour.

<details><summary>Queries (§3)</summary>

```sql
SELECT r.rolname, s.calls, s.mean_exec_time, s.max_exec_time, left(s.query, 120)
FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
WHERE r.rolname IN ('service_role','authenticator','anon','authenticated') AND s.max_exec_time > 8000;   -- 0 rows

SELECT s.calls, s.mean_exec_time, s.max_exec_time, substring(s.query from '"public"\."([a-z_0-9]+)"')
FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
WHERE r.rolname = 'service_role' AND s.query ILIKE '%pgrst_source%' AND s.max_exec_time > 5000 ORDER BY 3 DESC;

SELECT coalesce(r.rolname,'(all)'), coalesce(d.datname,'(all)'), s.setconfig
FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase;

SELECT usename, application_name, state, count(*), min(backend_start)
FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1,2,3;

SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND array_to_string(p.proconfig, ',') ILIKE '%statement_timeout%';   -- 0 rows
SELECT proname FROM pg_proc WHERE proname ILIKE '%probe%' OR prosrc ILIKE '%current_setting(''statement_timeout''%';   -- record_vm_probe only
```
</details>

---

## 4. FIX-1132 — the measured look

### 4.1 The premise does not hold

**`get_official_page` contains no `_conn`.** Its prod body (`pg_get_functiondef`,
read 2026-10-03 ~23:39 UTC; byte-identical to the clone's) is a single
`jsonb_build_object` of votes, career history, promises, civic responses,
comments and a contracts top-10 — it never touches `entity_connections`. A
search of every public `prosrc` on prod for `_conn\M` returns **one** routine:
`rebuild_entity_search_index()`, unit 9 of the daily `refresh_derived_mvs` at
06:00 UTC.

There `_conn` is a TEMP TABLE (FIX-1123), filled by 16 calls to
`entity_search_conn_window(lo, hi)` and then `ANALYZE`d; its `c` becomes
`entity_search_index.connection_count`, which the request path reads
**precomputed** (typeahead's `ORDER BY connection_count`, browse). So:

- the request path pays **nothing** for `_conn` today — there is nothing there
  to delete;
- the substitution the bullet describes is available **one level down**, in the
  daily unit, and it is exact:

```sql
-- entity_search_conn_window (prod)                -- rebuild_entity_connection_stats_window (prod), the MV's writer
SELECT sub.id, count(*)::int                         SELECT sub.id AS entity_id, COUNT(*)::bigint AS connection_count, …
  FROM (SELECT from_id AS id FROM entity_connections   FROM (SELECT from_id AS id, connection_type FROM entity_connections
         WHERE from_id >= p_lo AND (p_hi IS NULL OR …)       WHERE from_id >= p_lo AND (p_hi IS NULL OR …)
        UNION ALL                                           UNION ALL
        SELECT to_id … same window) sub                     SELECT to_id … same window) sub
 GROUP BY sub.id;                                     GROUP BY sub.id
```

Same relation, same UNION ALL of both id columns, same 16 nibble windows, same
`count(*)`. `connection_count ≡ _conn.c` by construction.

For completeness, `get_official_page` itself (pgss, prod, since the epoch):
`anon` **1,432 calls, mean 189.4 ms, max 2,871.3 ms**. The three-official
`EXPLAIN (ANALYZE, BUFFERS)` the prompt asked for was not run: its question was
the `_conn` share of that call, and the share is zero by inspection.

### 4.2 What the substitution buys, where it actually lives

**Instrument:** `EXPLAIN (ANALYZE, BUFFERS)` · **database:** clone (6.94M EC
rows; ×1.503 to prod) · **unit:** ms, 8 kB buffers · **window:** 2026-10-03
~23:41 UTC, `work_mem = 64MB`, `max_parallel_workers_per_gather = 0` (the
window function's own proconfig), first window cold, the rest warm.

| shape | groups | time | buffers hit | buffers read | total buffers |
|---|---:|---:|---:|---:|---:|
| `_conn` today: 16 × `entity_search_conn_window` | 3,225,903 | **29,427 ms** (window 1 cold 13,304; the other 15 1.3–3.3 s each) | 2,974,462 | 1,691,705 | **4,666,167** |
| read `entity_connection_stats_mv` | 3,225,903 | **1,821 ms** (cold) | 0 | 31,031 | **31,031** |

**150× fewer buffers, 16× less time** on the clone, for the identical set (the
group counts match row for row). Each window is a `HashAggregate` estimated at
**`rows=200`** against ~202,000 actual — FIX-1131's signature, still live
inside the fix that removed it from the whole-table form (§1).

On prod the unit's wall is known, its `_conn` share is not: pgss `track = top`
cannot see inside `rebuild_entity_search_index`, and the unit stamps only its
total. `refresh_derived_mvs` `metadata.unit_seconds.rebuild_entity_search_index`,
prod, 30 daily runs 2026-09-04 → 10-03: **p50 241.5 s, p90 355.0 s, max
1,019.1 s, min 215.3 s.** (The clone's last stamped run, 2026-09-07, was 79.6 s;
the `_conn` stage there would be roughly a third of it. That is a clone wall
fraction, quoted for orientation only — rule 132.)

### 4.3 Would the MV be wrong?

**Instrument:** a join of `entity_search_index.connection_count` (built from a
live `_conn` at the 06:00 daily, `refreshed_at` 2026-10-03 06:01:15) against
`entity_connection_stats_mv.connection_count` · **database:** prod · **unit:**
entities · **window:** read 2026-10-03 ~23:40 UTC.

| kind | entities | equal | `_conn` higher | MV higher | missing in MV | max |diff| |
|---|---:|---:|---:|---:|---:|---:|
| financial | 229,070 | 229,070 | 0 | 0 | 0 | 0 |
| proposal | 94,678 | 94,678 | 0 | 0 | 0 | 0 |
| official | 32,828 | 32,828 | 0 | 0 | 0 | 0 |
| jurisdiction | 10,548 | 10,548 | 0 | 0 | 0 | 0 |
| institution / agency / meeting / initiative | 589 | 589 | 0 | 0 | 0 | 0 |
| **all** | **367,713** | **367,713** | **0** | **0** | **0** | **0** |

Clone, 100 active officials (sampled by `md5(id)`): live `count(*)` from both
EC columns vs the clone's MV — **100 / 100 equal**, Σ 5,826 connections.

Why they agree: the stats arm is gated on EC's own fingerprint
(`count(*)` + `max(derived_at)`). On prod its stored fingerprint read
`n=10470704; t=2026-10-03 04:49:04` (stamped 12:45:19) — EC had not changed
since 04:49, before the 06:00 `_conn` build. When EC is unchanged since the
stats arm's last build, the MV is exact; the gate already computes that test.

The MV's refresh rhythm (prod, `data_sync_log` `entity_connections_rebuild`
`status = 'complete'`, which is when the last-pinned stats arm has banked;
30 d): **70 closures; gap p50 6.5 h, p90 18.0 h, max 30.0 h** (ending
09-09 01:02); 4.7 h since the last close at read time. Stats windows in 30 d:
450 real, 42 gated, 120,921 rows upserted, max window 1,973.9 s, **two
cancelled** (09-14, 09-17; §2.3).

### 4.4 Recommendation (FIX-1132) — **GO, reframed**

- **NO-GO on the bullet as written:** there is no request-path aggregation to
  delete (`_conn` share of `get_official_page` = 0).
- **GO on the same substitution in the daily unit:** replace the 16-window
  `_conn` build in `rebuild_entity_search_index()` with a read of
  `entity_connection_stats_mv`, **guarded exactly**: use the MV when
  `ec_arm_source_fingerprint('entity_connection_stats_windows')` equals the
  stored `ec_arm_source_fingerprints.arms.entity_connection_stats_windows.fp`
  (EC unchanged since the MV was built), else fall back to today's 16 windows.
  The guard costs one fingerprint probe — **p50 6.5 s, max 32.3 s** on prod
  (42 gated stats probes, 30 d) — against 4.67M buffers on the clone.
- The bullet's catch ("pipeline lateness surfaces as WRONG COUNTS") does not
  survive the guard: a stale MV is never read, and the fallback is today's
  behaviour. The freshness bound is the fingerprint, not an hours threshold, so
  there is no product decision to make about `X`.
- Deciding numbers: **367,713 / 367,713 equal on prod; 4,666,167 → 31,031
  buffers on the clone; prod unit p50 241.5 s at 06:01, inside the minute that
  carried the day's worst swap-in (§6).**
- FIX-1132 stays **open**; the build is its own FIX (not filed here — this
  prompt files nothing for R4).

<details><summary>Queries (§4)</summary>

```sql
-- prod: where _conn lives
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosrc ~ '_conn\M';                       -- rebuild_entity_search_index
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname IN ('get_official_page','entity_search_conn_window','rebuild_entity_connection_stats_window');

-- prod: agreement
SELECT esi.kind, count(*),
       count(*) FILTER (WHERE esi.connection_count = COALESCE(m.connection_count, 0)),
       count(*) FILTER (WHERE esi.connection_count > COALESCE(m.connection_count, 0)),
       count(*) FILTER (WHERE esi.connection_count < COALESCE(m.connection_count, 0)),
       count(*) FILTER (WHERE m.entity_id IS NULL AND esi.connection_count > 0),
       max(abs(esi.connection_count - COALESCE(m.connection_count, 0)))
FROM public.entity_search_index esi LEFT JOIN public.entity_connection_stats_mv m ON m.entity_id = esi.entity_id
GROUP BY esi.kind;

-- prod: closures + the stored fingerprint + probe cost
WITH c AS (SELECT completed_at FROM public.data_sync_log WHERE pipeline = 'entity_connections_rebuild' AND status = 'complete'
           AND completed_at >= now() - interval '33 days'),
     g AS (SELECT completed_at, completed_at - lag(completed_at) OVER (ORDER BY completed_at) AS gap FROM c)
SELECT count(*), max(gap), percentile_cont(0.5) WITHIN GROUP (ORDER BY gap), percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)
FROM g WHERE completed_at >= now() - interval '30 days';
SELECT value->'arms'->'entity_connection_stats_windows' FROM public.pipeline_state WHERE key = 'ec_arm_source_fingerprints';
SELECT count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY (e->>'seconds')::numeric), max((e->>'seconds')::numeric)
FROM public.data_sync_log r, jsonb_array_elements(COALESCE(r.metadata->'units','[]'::jsonb)) e
WHERE r.pipeline = 'entity_connections_rebuild' AND r.started_at > now() - interval '30 days'
  AND e->>'unit' = 'entity_connection_stats_windows (gated)';

-- prod: unit walls
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY u.v::numeric), max(u.v::numeric)
FROM public.data_sync_log r, jsonb_each_text(r.metadata->'unit_seconds') u(k, v)
WHERE r.pipeline = 'refresh_derived_mvs' AND r.started_at >= now() - interval '30 days' AND u.k = 'rebuild_entity_search_index';

-- prod: get_official_page
SELECT r.rolname, s.calls, s.mean_exec_time, s.max_exec_time FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
WHERE s.query ILIKE '%get_official_page%';

-- clone, ×16 windows (literal bounds; shown for window 1)
SET statement_timeout = '10min'; SET work_mem = '64MB'; SET max_parallel_workers_per_gather = 0; SET jit = off;
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON)
SELECT sub.id, count(*)::int FROM (
  SELECT from_id AS id FROM public.entity_connections WHERE from_id >= '00000000-…'::uuid AND from_id < '10000000-…'::uuid
  UNION ALL
  SELECT to_id   AS id FROM public.entity_connections WHERE to_id   >= '00000000-…'::uuid AND to_id   < '10000000-…'::uuid
) sub GROUP BY sub.id;
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) SELECT entity_id, connection_count FROM public.entity_connection_stats_mv;

-- clone, 100-official agreement
WITH s AS (SELECT id FROM officials WHERE is_active ORDER BY md5(id::text) LIMIT 100),
live AS (SELECT s.id, (SELECT count(*) FROM entity_connections e WHERE e.from_id = s.id)
                    + (SELECT count(*) FROM entity_connections e WHERE e.to_id = s.id) AS c FROM s)
SELECT count(*), count(*) FILTER (WHERE l.c = COALESCE(m.connection_count, 0))
FROM live l LEFT JOIN entity_connection_stats_mv m ON m.entity_id = l.id;
```
</details>

---

## 5. FIX-1145 — what is left after the index measurement

### 5.1 What the bullet already proposes (its tail)

> THE WORK is therefore twofold: add the index AND make the daily refresh
> actually take it. Options, cheapest first: (1) set a session-scoped cost GUC
> in the refresh path only, which is narrow but fragile; (2) reshape the
> aggregate so the index-only path wins on cost honestly; (3) reconsider whether
> the MV needs the all-relationship-types count(*) at all, since the
> donation-only half could ride an existing sibling. Measure on PROD before
> committing.

### 5.2 The MV: refresh, readers, settings

| fact | value | instrument · database · window |
|---|---|---|
| refresh unit | `REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv` — unit **4** of `refresh_derived_mvs('daily')`, `0 6 * * *` | `prosrc`, prod |
| wall | **p50 48.4 s, p90 56.0 s, max 58.3 s, min 44.4 s** over 30 runs | `data_sync_log.metadata.unit_seconds`, prod, 2026-09-04 → 10-03 |
| when | ≈ 06:00:10 → 06:01:00 (units 1–3 ≈ 27.5 s before it) — inside the ring reading that carried the day's worst swap-in (06:02, §6) | same |
| planner settings it runs under | `work_mem = 128MB` (in-body), **parallel ON** (the daily cadence keeps the server default `max_parallel_workers_per_gather = 1`; only the weekly sets 0) | `prosrc` + `pg_settings`, prod |
| its prod plan (plain EXPLAIN, `work_mem 128MB`, 1 worker) | `Finalize GroupAggregate` ← `Gather Merge` (1 worker) ← `Partial HashAggregate` (est. 6,491 groups) ← **`Parallel Seq Scan on financial_relationships`**, filter `to_type = 'official'` | prod, 2026-10-03 ~23:50 UTC |
| with parallel off (plain EXPLAIN) | `HashAggregate` ← `Bitmap Heap Scan` on `financial_relationships_to` (est. 6,501,789 rows) | prod |
| readers | `apps/civitics/app/page.tsx:407` (home, `vote_count, donor_count, total_donations_cents`); `officials/components/OfficialCard.tsx:93` (same three); `app/api/officials/[id]/summary/route.ts:156` (`donor_count, total_donations_cents`) | grep, tree `81e55351` |
| **`financial_relationship_count`** | **no reader** — it appears only in the generated `packages/db/src/types/database.ts` | grep |

### 5.3 Three of the four columns already exist, exactly

**Instrument:** a join of the MV against the two rollups · **database:** prod ·
**unit:** officials · **window:** read 2026-10-03 ~23:51 UTC (MV built 10-03
06:00; `official_donor_totals` by `donor-rollup-refresh` `0 9,12 * * *`;
`official_vote_stats` by `vote-stats-refresh` `30 3 * * *`).

| MV column | source it could read instead | equal on prod |
|---|---|---:|
| `total_donations_cents` | `official_donor_totals.total_cents` | **37,417 / 37,417** |
| `donor_count` | `official_donor_totals.donor_count` | **37,417 / 37,417** |
| `vote_count` | `official_vote_stats.total_votes` | **37,417 / 37,417** |
| `financial_relationship_count` | — (all relationship types to the official) | equals `donor_count` for 35,308; exceeds it for 2,109 — **and nobody reads it** |

(Clone, same join: 37,174 / 37,175 on the two donor columns and 36,644 / 37,175
on votes — the clone's `official_vote_stats` is stale at 558 rows. Prod is the
truth here.)

### 5.4 The plan shapes on the clone

**Instrument:** `EXPLAIN (ANALYZE, BUFFERS)` · **database:** clone (FR 10.4M rows,
×1.389 to prod; FR VM 442,025 / 442,292 all-visible = 99.9 %, prod's 100.0 %) ·
**unit:** ms, 8 kB buffers · **window:** 2026-10-03 23:58 UTC, one transaction.
Prod's planner GUCs set per session (`random_page_cost 1.1`,
`effective_cache_size 768MB`, `effective_io_concurrency 200`, `jit off`,
`work_mem 128MB`, `max_parallel_workers_per_gather 1`); `shared_buffers` cannot
be (clone 128 MB, prod 256 MB). The candidate index
`(to_id) INCLUDE (relationship_type, amount_cents) WHERE to_type = 'official'`
was built **inside the transaction** — 16.6 s, 200 MB — so no other session ever
saw it, and was **dropped** before commit (`pg_class` count for `cc186%`
afterwards: 0).

| shape | plan | buffers hit | buffers read | total | time |
|---|---|---:|---:|---:|---:|
| FIX-1133's seq scan (its measurement, 2026-09) | Parallel Seq Scan | — | 431,714 | 442,306 | 1,543.7 ms |
| **(i) as-is, index present, nothing forced** | **Parallel Index Only Scan** on the candidate, heap fetches 3,843 | 46,149 | 25,749 | **71,898** | **860 ms** |
| (i-b) as-is, parallel off | Index Only Scan on the candidate | 46,269 | 25,464 | 71,733 | 811 ms |
| (ii) per-official LATERAL from `officials` | Nested Loop → 37,175 × Index Only Scan on the candidate | 196,047 | 25,896 | 221,943 | 847 ms |
| (iv) forced `enable_seqscan/bitmapscan = off` | identical to (i) | 49,220 | 22,711 | 71,931 | 833 ms |
| **(v) read the rollups** (§5.3; no FR at all) | Hash Left Join ×2 over `officials` pkey | 1,320 | 423 | **1,743** | **58 ms** |

**The planner TAKES the index — unforced.** Plain EXPLAINs in the same
transaction show the Parallel Index Only Scan chosen under the **clone's own
defaults** too (`random_page_cost 4`, `effective_cache_size 128MB`,
`effective_io_concurrency 1`) and at `random_page_cost` 1.1, 2.0, 3.0 and 4.0.
No cost GUC is needed; (iii)'s "what value flips it" has no answer because
nothing flips. FIX-1133's refusal does not reproduce. Its forced index-only run
cost 182,716 buffers where today's costs 71,898 with 3,843 heap fetches — the
~110k difference is what heap fetches through a decayed visibility map cost,
and an index-only scan is costed on `relallvisible`. The most likely reading is
that FIX-1133 measured on a clone whose VM had decayed (its 100 % figure is
prod's, not the clone's), not that the planner refuses this index.

### 5.5 Recommendation (FIX-1145)

- **Shape: read the rollups, not FR.** Redefine the MV over `officials` LEFT
  JOIN `official_vote_stats` LEFT JOIN `official_donor_totals`, and drop the
  unread `financial_relationship_count` (or derive it elsewhere if a reader ever
  appears). No index, no knob, no FR read.
- **Cost class (rule 132):** today, ∝ |FR rows with `to_type = 'official'`|
  (≈ 6.5M on prod, growing with every FEC ingest) through a 4.9 GB heap,
  driven from the big side. Rollup-read: ∝ |officials| (≈ 39k) plus two small
  rollups, driven from the small side. The clone ratio is 1,743 vs 442,306
  buffers (254×) — a shape difference, not a wall forecast.
- **Freshness, stated:** `official_vote_stats` rebuilds at 03:30, before the
  06:00 refresh — no change. `official_donor_totals` rebuilds at 09:00 and 12:00,
  so a 06:00 MV built from it would carry donations as of the previous 12:00 —
  the nightly ingest's new rows reach the home page at 09:00 instead of 06:00.
  Moving this unit's refresh after 12:00 (or having the three readers read
  `official_donor_totals` directly — FIX-942 already names it the authoritative
  per-official donation total) removes even that.
- **If the index route is preferred instead:** the planner takes it today
  (≈ 250 MB on prod, a 20th FR index, one more vacuum sweep). It is strictly
  worse than the rollup read on every axis measured here.
- **Worth a FIX this quarter: yes.** It is daily, at 06:00, in the minute that
  carried the day's worst swap-in (§6), and the fix is one MV redefinition whose
  three readers already select only the three rollup-backed columns. This
  prompt files nothing; the numbers ride on FIX-1145.

<details><summary>Queries (§5)</summary>

```sql
-- prod
SELECT pg_get_viewdef('public.official_homepage_stats_mv'::regclass, true);
SET work_mem = '128MB';   -- max_parallel_workers_per_gather left at the server's 1, as the daily runs
EXPLAIN SELECT to_id, count(*) FILTER (WHERE relationship_type = 'donation'), count(*),
  sum(amount_cents) FILTER (WHERE relationship_type = 'donation' AND amount_cents IS NOT NULL)::bigint
FROM public.financial_relationships WHERE to_type = 'official' GROUP BY to_id;
SELECT count(*), count(*) FILTER (WHERE m.total_donations_cents = COALESCE(t.total_cents, 0)),
       count(*) FILTER (WHERE m.donor_count = COALESCE(t.donor_count, 0)),
       count(*) FILTER (WHERE m.vote_count = COALESCE(v.total_votes, 0)),
       count(*) FILTER (WHERE m.financial_relationship_count = m.donor_count)
FROM official_homepage_stats_mv m LEFT JOIN official_donor_totals t ON t.official_id = m.official_id
LEFT JOIN official_vote_stats v ON v.official_id = m.official_id;
SELECT relpages, relallvisible FROM pg_class WHERE relname = 'financial_relationships';

-- clone, one transaction (db-query --local wraps in --single-transaction)
SET statement_timeout = '10min';
SET random_page_cost = 1.1; SET effective_cache_size = '768MB'; SET jit = off; SET effective_io_concurrency = 200;
SET work_mem = '128MB'; SET max_parallel_workers_per_gather = 1;
CREATE INDEX cc186_tmp_fr_official_cover ON public.financial_relationships (to_id) INCLUDE (relationship_type, amount_cents) WHERE to_type = 'official';
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) <the MV's FR query>;                       -- (i); (i-b) with parallel 0
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON)
SELECT o.id, s.* FROM public.officials o CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE fr.relationship_type = 'donation'), count(*),
         sum(fr.amount_cents) FILTER (WHERE fr.relationship_type = 'donation' AND fr.amount_cents IS NOT NULL)::bigint
  FROM public.financial_relationships fr WHERE fr.to_type = 'official' AND fr.to_id = o.id) s;   -- (ii)
SET enable_seqscan = off; SET enable_bitmapscan = off; EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) <the MV's FR query>;   -- (iv)
DROP INDEX public.cc186_tmp_fr_official_cover;
-- second transaction: the same index, plain EXPLAIN under clone defaults and random_page_cost 1.1 / 2.0 / 3.0 / 4.0, then DROP
-- (v)
EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON)
SELECT o.id, COALESCE(v.total_votes, 0), COALESCE(t.donor_count, 0), COALESCE(t.total_cents, 0), now()
FROM public.officials o LEFT JOIN public.official_vote_stats v ON v.official_id = o.id
LEFT JOIN public.official_donor_totals t ON t.official_id = o.id;
SELECT count(*) FROM pg_class WHERE relname LIKE 'cc186%';   -- 0
```
</details>

---

## 6. FIX-1125 — memory attribution (the design input)

### 6.1 What the ring holds

**There is one banked day, not two.** The Upstash ring is 720 readings at `*/2`
= 24 h; `data:box-health:series --hours 48 --json` (primary checkout, 23:45
UTC) returned **720 rows, 2026-10-02 23:46 → 2026-10-03 23:44**. The only
banked series is the 10-04 receipt's `forker.memory_day` (FIX-1194's banking,
first run), which covers 10-02 23:28 → 10-03 23:26 as a **summary**:

| `forker.memory_day` (docs/receipts/2026-10-04.json) | value |
|---|---|
| samples / gaps | 720 / 0 |
| swap-in pages/s p50 / p95 / max | 23.9 / 548.8 / 1,584.7 |
| swap-out pages/s p50 / p95 / max | 4.2 / 502.7 / 1,583.1 |
| MemAvailable MB min / p50 | 176 / 451 |
| swap used MB max | 1,014 |

So 10-02's minute series (and with it 10-02's 03:00–06:30 swap picture and the
"10-02 17:32" minute) has rolled out of the ring. The Gantt below is two days of
`cron.job_run_details`; the swap series beside it is 10-03 only.

### 6.2 The fifteen worst readings, and who was running

**Instruments:** the ring (`swapin_per_s` = the 2-minute rate ending at the
reading) · `cron.job_run_details` (jobs overlapping `[t − 2 min, t]`, by name —
rule 7; the `*/1` probe and both `*/2` watchdogs excluded) · `data_sync_log`
rows overlapping the same span · **database:** prod + Upstash · **unit:**
pages/s, MB · **window:** 2026-10-02 23:46 → 10-03 23:44 UTC.

| reading (UTC) | swap-in /s | MemAvailable MB | pg_cron running | data_sync_log running | owner |
|---|---:|---:|---|---|---|
| 10-03 06:02 | 1,584.7 | 327 | refresh-derived-mvs-daily (+142 s of 339 s) | refresh_derived_mvs | **06:00 daily**, units 3–4 then 9 (§4, §5) |
| 04:52 | 1,547.5 | 243 | — | — | **cc-182** (see below) |
| 04:54 | 1,455.0 | **176** | — | — | **cc-182** |
| 04:10 | 1,375.5 | 237 | — | — | **cc-182** |
| 09:02 | 1,215.9 | 468 | ec-crawl (80 s) | entity_connections_rebuild | status snapshot :00 + an EC unit |
| 04:08 | 1,122.4 | 202 | — | — | **cc-182** |
| 04:44 | 1,099.7 | 320 | — | — | **cc-182** |
| 04:12 | 1,066.8 | 280 | — | — | **cc-182** |
| 11:02 | 1,014.8 | 315 | ec-crawl (57 s) | entity_connections_rebuild | status snapshot :00 + an EC unit |
| 10:02 | 999.8 | 309 | ec-crawl (73 s) | entity_connections_rebuild | status snapshot :00 + an EC unit |
| 04:22 | 982.9 | 287 | — | — | **cc-182** |
| 22:32 | 953.1 | 360 | — | nightly_cron:enrichment-tail; tag_rules | status snapshot :30 + nightly tail |
| 23:02 | 834.6 | 303 | — | — | status snapshot :00 (+ cc-184/185/186 ad-hoc reads) |
| 23:44 | 833.2 | 359 | — | — | plausibly ad-hoc reads — this census's prod reads ran throughout 23:33–23:58, alongside cc-184/185 |
| 04:50 | 810.5 | 234 | fe-vacuum-analyze (12 s) | — | **cc-182** |

**Eight of the fifteen — including the day's MemAvailable minimum (176 MB at
04:54) — fall inside one operator session; seven of them have no pg_cron job and
no `data_sync_log` row running at all (the eighth overlaps a 12 s fe-vacuum).** They
sit inside cc-182's supervised session (started 03:59:34, finished 05:15:00 UTC),
whose report records an ad-hoc full-scan census at **04:07:55–04:11:56** (240.9
s, after a **04:07:15** parallel attempt "failed after 31 s: could not resize
shared memory segment … to 134217728 bytes") and a second at **04:49:18 → 324.9
s** (to 04:54:43), plus DML at 04:38 and 04:48–04:49. Ad-hoc reads log in as
`postgres` through the session pooler and leave no `data_sync_log` row, which is
why the stack's own instruments do not see them.

### 6.3 The day, attributed

Swap-in pages summed over the ring (rate × 120 s): **8,993,940 pages** in 719
readings.

| bucket | readings | share of the day's swap-in | mean pages/s |
|---|---:|---:|---:|
| **:02 and :32 of every hour** (the `*/30` status snapshot) | 48 | **34.7 %** | 541 |
| cc-182's session, 04:00–05:16 (excluding its :02/:32) | 35 | 16.0 % | — |
| the 06:00 derived-MVs daily (06:00–06:06) | 3 | **2.6 %** | — |
| everything else | 634 | 48.8 % | 58 |

The minute-of-hour profile (mean pages/s, same window): **`:02` = 598, `:32` =
485**, every other even minute 9–119. **All 48 of 48** `:02`/`:32` readings are
≥ 240 pages/s (min 243.3 / 240.0, median 502.2 / 434.5); the other 671 have
median 21.4, p90 157.4. The `:16`/`:46` readings (ec-crawl's quarter-past
firings) are 117 — mildly raised.

**What fires at :00 and :30:** Vercel `/api/cron/platform-snapshot` (`*/30`,
`apps/civitics/vercel.json`) — it writes `platform_usage_snapshot` and the
11-section `status_snapshot`. Its PostgREST reads are visible in pgss as the
`service_role` statements with **≈ 531 calls** (11.04 d × 48/day = 530):

| status-snapshot statement (pgss, prod, since the epoch) | calls | mean ms | max ms | shared blocks **read** per call | plan (plain EXPLAIN, prod) |
|---|---:|---:|---:|---:|---|
| `enrichment_queue` count, `status = 'processing'` | 467 | 4,823 | 7,993 | **57,999** | **Seq Scan** of the 274 MB heap for **44** rows |
| `enrichment_queue` count, `status = 'processing' AND claimed_at < …` | 469 | 4,835 | 7,984 | **55,430** | same |
| `entity_search_index` `ORDER BY refreshed_at DESC LIMIT 1` | 531 | 712 | 5,076 | **15,283** | **Seq Scan + Sort** of 367,713 rows |
| `officials` (status section) | 527 | 565 | 5,435 | 556 | — |
| `check_cron_job_escalations` | 530 | 689 | 6,737 | 71 (46,064 hit) | — |
| `data_sync_log` (pipelines history) | 531 | 413 | 6,486 | 104 | — |

The two `enrichment_queue` counts are the `getPipelines()` section
(`apps/civitics/app/api/claude/status/_lib/sections.ts:535-543`); the pending
counts beside them use `idx_enrichment_queue_pending_by_task` and are cheap.
Read per call, the three heavy statements pull **≈ 129,000 blocks ≈ 1.0 GB**
from outside shared_buffers **every half hour** on a 904 MB box — roughly
**50 GB/day** — and the two `enrichment_queue` counts complete only 467/469 of
~531 firings: the ~12 % shortfall is consistent with their being cancelled at
the 8 s PostgREST bound (§3). (The read count per call exceeds the heap's
~35,000 pages; that excess is not decomposed here.)

### 6.4 The 03:00–06:30 UTC stack, both days

**Instrument:** `cron.job_run_details` · **database:** prod · **unit:** seconds ·
**window:** 02:55–06:35 UTC on 2026-10-02 and 2026-10-03 (probe, watchdogs and
`ec-crawl` firings under 5 s omitted).

| job | 10-02 start · wall | 10-03 start · wall |
|---|---|---|
| fr-vacuum-analyze | 03:00:00 · 10 s | 03:00:00 · 10 s |
| ec-crawl units | 03:00 · 80, 03:15 · 53, 03:30 · 63, 03:45 · 55, 04:00 · 31, 04:15 · 41, 04:30 · 57, 04:45 · 38, 05:00 · 33, 05:15 · 33, 05:30 · 44 s | none (cycle cooldown) |
| vote-stats-refresh | 03:30:00 · 26 s | 03:30:00 · 22 s |
| platform-counts-daily | 03:53:00 · 36 s | 03:53:00 · 27 s |
| ec-vacuum-analyze | 04:30:00 · 9 s | 04:30:00 · 9 s |
| fe-vacuum-analyze | 04:50:00 · 11 s | 04:50:00 · 12 s |
| refresh-derived-mvs-daily | 06:00:00 · 361 s | 06:00:00 · 339 s |
| rule-taggers-daily | 06:30:00 · 210 s | 06:30:00 · 192 s |

10-03 swap-in beside it (pages/s / MemAvailable MB, every 2 min; selected):
03:02 372.6/330 · 03:18 616.8/322 · 03:32 589.3/336 · 03:54 623.7/268 (platform-counts) ·
04:02 619.3/280 · **04:08–04:12 1,122–1,376/202–280 (cc-182)** · 04:22 982.9/287 ·
04:32 384.3/364 · 04:44 1,099.7/320 · **04:50–04:54 811–1,548/176–243 (cc-182)** ·
05:02 549.3/408 · 05:32 304.3/320 · 05:52 1.1/467 · 06:00 191.9/419 ·
**06:02 1,584.7/327** · 06:04 182.7/359 · 06:30 170.6/314 · 06:32 773.3/272.

**The stack has no overlaps on either day** — every job finishes before the next
starts, and on 10-03 nothing but the daily's units ran between 06:00 and 06:06.
The bursts inside 03:00–06:30 sit on (i) the half-hour snapshot (03:02, 03:32,
04:02, 05:02, 05:32, 06:32), (ii) cc-182, and (iii) one minute of the 06:00
daily. Of the four FIX-1125 candidates in the stack, only the 06:00 daily owns a
burst.

### 6.5 The memory GUCs (prod, `pg_settings` / `pg_db_role_setting` / `pg_proc`, read 2026-10-03 ~23:49 UTC)

| knob | value | scope | worst-case multiplier |
|---|---|---|---|
| `shared_buffers` | 256 MB (32,768 × 8 kB) | global | fixed |
| `work_mem` | **4 MB boot; config value not readable** (`pg_file_settings` → permission denied) | global | per sort/hash node |
| `work_mem` | **256 MB** | role `postgres` IN DATABASE `postgres` | × `hash_mem_multiplier` 2 = 512 MB per hash node per process |
| `work_mem` (in-body `SET`) | 256 MB ×16, 128 MB ×8 | 24 cron procedures/functions (list in the query block) | same, per node |
| `work_mem` (proconfig) | 64 MB ×4, 256 MB ×1 | `entity_search_conn_window`, `rebuild_entity_connection_stats_window`, `refresh_fe_inbound_rollup_unit`, `refresh_fe_totals_slice`; `refresh_donor_party_rollup_slice` | same |
| `hash_mem_multiplier` | 2 | global default | — |
| `maintenance_work_mem` | 64 MB | config | per VACUUM/CREATE INDEX |
| `autovacuum_work_mem` | −1 (→ 64 MB) | default | × `autovacuum_max_workers` 3 |
| `max_parallel_workers_per_gather` | **1** (`reset_val`; boot 2) | config | +1 worker × `work_mem` per parallel node |
| `max_parallel_workers` | 2 | config | box-wide worker cap |
| `max_parallel_maintenance_workers` | 1 | config | — |
| `max_parallel_workers_per_gather = 0` | | `refresh_derived_mvs` (weekly only), `refresh_donor_party_rollup_incremental` (in-body); `entity_search_conn_window` (proconfig) | — |
| `jit` | **off** | config | — |
| `temp_buffers` | 8 MB | default | per session using temp tables |
| `max_connections` | 60 | config | — |
| `effective_cache_size` | 768 MB | config | planner only |
| `huge_pages` / `dynamic_shared_memory_type` | try / posix | default | parallel hash DSM lives in `/dev/shm` |
| `logical_decoding_work_mem` | 64 MB | default | — |
| `wal_buffers` | 7.7 MB (983 × 8 kB) | config | — |
| role `anon` / `authenticated` / `authenticator` | `statement_timeout` only (+ `lock_timeout`) | role | — |
| `service_role` | no row | — | — |

### 6.6 Spills

`pg_stat_database` (prod): `temp_files` 19,983, `temp_bytes` 181 GB —
**since an unknown epoch** (`stats_reset` NULL), so not a per-day rate.

pgss `temp_blks_written` by role, since 2026-09-22 22:32:13 (11.04 d): **`postgres`
11 GB** (1,461,938 blocks, ≈ 1.0 GB/day) · **`anon` 2.4 GB** · `service_role`
395 MB · every other role 0.

| top spillers (pgss, prod, since the epoch) | role | calls | temp written | per call | mean ms | `work_mem` it ran under |
|---|---|---:|---:|---:|---:|---|
| `CALL refresh_derived_mvs($1)` | postgres | 12 | 3,051 MB | 254 MB | 458,947 | 128 MB (in-body) |
| PostgREST `officials` select (`id, full_name, …`) | **anon** | 900 | 2,435 MB | 2.7 MB | 539 | the global default |
| `CALL refresh_contract_flow_rollups()` | postgres | 2 | 1,853 MB | 927 MB | 1,896,814 | 256 MB (in-body) |
| an EC `SELECT ec.id, ec.from_id, …` (ad-hoc) | postgres | 2 | 1,594 MB | 797 MB | 282,780 | role 256 MB |
| `CALL reconcile_donation_edge_orphans()` | postgres | 1 | 1,451 MB | 1,451 MB | 135,500 | 256 MB (in-body) |
| `REFRESH … chord_industry_flows_mv_new` | postgres | 1 | 867 MB | 867 MB | 279,505 | 128 MB (weekly) |
| `CALL donor_rollup_rebuild_bulk()` | postgres | 22 | 795 MB | 36 MB | 87,283 | 256 MB (in-body) |
| `CALL refresh_sector_affinity_from_tag_changes()` | postgres | 12 | 602 MB | 50 MB | 61,606 | 128 MB (in-body) |
| `list_scheduled_rollup_pipelines()` | service_role | 20 | 364 MB | 18 MB | 805 | the global default |

### 6.7 Backends

`pg_stat_activity`, prod, 2026-10-03 ~23:49 UTC: client backends `authenticator`
idle 9 · `supabase_admin` idle 2 · `pgbouncer` idle 1 · `postgres` active 1 (this
read); plus pg_cron launcher, pg_net worker, logical-replication launcher,
autovacuum launcher, archiver, bgwriter, checkpointer, walwriter. Idle-in-pool:
12 of 13 client backends. The probe's stamp (`pipeline_state.box_health`, 23:48)
carries `backends: {client 16, active 1, idle_in_txn 0, lock_waiting 0,
max_connections 60, longest_active_s null}` — counts only, no per-role split.
**`numbackends` max over the epoch is not readable** — `pg_stat_database` keeps
the current value only (rule 24).

The non-Postgres residents (Supavisor, Realtime, Kong, GoTrue, Storage, pg_meta,
vector, `postgres_exporter`) share the 904 MB and are not attributable from
inside Postgres. Their sizes are not guessed here.

### 6.8 Recommendation, sized (FIX-1125) — no change made

1. **Lever (1), `ALTER ROLE postgres SET max_parallel_workers_per_gather = 0`
   (+ `jit = off`):** `jit` is **already off globally** — that half is a no-op.
   Parallel is 1 worker by default and 2 box-wide. Data-modifying statements
   (most cron work: the rollups' INSERT/UPDATE/DELETE) never plan parallel;
   the cron statements that do are SELECT-shaped reads and MV refreshes —
   e.g. `official_homepage_stats_mv`'s FR scan (§5: `Parallel Seq Scan`,
   `Workers Planned: 1`, a 6,491-group partial hash). At the day's worst
   minute (06:02) the saving is **one worker process** and its tiny hash; at
   cc-182's minutes it would have prevented the **128 MB DSM refusal**, because
   ad-hoc reads log in as `postgres`. Cheap, metadata, reversible —
   **supported by the evidence for the ad-hoc class**, not for the stack.
2. **Lever (2), `work_mem` 256 → 128 MB for `postgres`:** **inert for the cron
   stack by construction.** 24 procedures/functions `SET work_mem` in-body and
   5 more carry it in proconfig; a role default reaches none of them. What it
   would reach is ad-hoc sessions and the few un-`SET` paths. The statements it
   would newly spill are not identifiable from pgss (a statement that fits in
   256 MB writes no temp); the ones already spilling (the table above) spill
   at their own `SET`s and would be unchanged. **Not supported.**
3. **Lever (3), spreading 03:00–06:30:** the stack has **no overlaps** on either
   day (§6.4). **Nothing to spread.**
4. **The lever the day actually supports — not on the prompt's list:** the
   `*/30` status snapshot's two heavy reads. A partial index
   `enrichment_queue (…) WHERE status = 'processing'` (44 rows) turns two
   ~58k-block seq scans into index-only counts; `entity_search_index`'s
   freshness can be read without sorting 367,713 rows (every row of one rebuild
   carries the same `refreshed_at`; the unit's own stamp in
   `refresh_derived_mvs.metadata` already has it). Together ≈ **1.0 GB of
   physical reads per half hour, 34.7 % of the day's swap-in, 48 of 48
   readings**, and it also removes the two statements most often cancelled at
   the 8 s bound. This is efficiency, not a tier — the shape Craig's 10-03
   decision asks for.
5. **What the one banked day supports and what needs seven (forker s6):**
   the snapshot attribution rests on 48 independent half-hour readings and a
   cadence match, inside one day — strong but one day (rule 24); the seven-day
   bank should confirm it holds on a weekend and on a drop night. Levers (1)–(3)
   need the seven days only if someone still wants them after (4) lands; the
   06:00 daily's one-minute burst is better attacked by §4 and §5, which remove
   its two largest reads.

<details><summary>Queries (§6)</summary>

```bash
pnpm --filter @civitics/data data:box-health:series --hours 48 --json    # primary checkout; Upstash only
node -e '…JSON.parse(docs/receipts/2026-10-04.json).forker.memory_day…'
gh run list -L 200 --json workflowName,createdAt,updatedAt,event          # 03–07 UTC: platform-snapshot dispatches, cc pushes
```

```sql
-- jobs and sync rows overlapping each worst reading (t = the reading; the rate covers [t − 2 min, t])
WITH t(at, swapin, avail) AS (VALUES (timestamptz '2026-10-03T06:02:22.299Z', 1584.7, 327), …)
SELECT t.at,
  (SELECT string_agg(j.jobname, '; ') FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time <= t.at AND d.end_time >= t.at - interval '2 minutes' AND d.start_time >= t.at - interval '1 day'
      AND j.jobname NOT IN ('box-health-probe','cron-job-budget-watchdog','derived-mvs-unit-watchdog')),
  (SELECT string_agg(s.pipeline, '; ') FROM public.data_sync_log s
    WHERE s.started_at <= t.at AND COALESCE(s.completed_at, t.at) >= t.at - interval '2 minutes' AND s.started_at >= t.at - interval '1 day'
      AND (s.pipeline <> 'entity_connections_rebuild' OR s.status <> 'skipped'))
FROM t;
-- (rows with a NULL end_time are 08-xx crashed runs and are excluded by the end_time predicate)

-- Gantt
SELECT d.start_time::date, d.start_time::time, round(extract(epoch FROM d.end_time - d.start_time)), j.jobname, d.status
FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
WHERE d.start_time >= '2026-10-02 02:55Z' AND d.start_time < '2026-10-03 06:35Z' AND d.start_time::time BETWEEN '02:55' AND '06:35'
  AND j.jobname NOT IN ('box-health-probe','cron-job-budget-watchdog','derived-mvs-unit-watchdog')
  AND NOT (j.jobname = 'ec-crawl' AND d.end_time - d.start_time < interval '5 s');

-- status-snapshot statements and their plans
SELECT r.rolname, s.calls, s.mean_exec_time, s.max_exec_time, s.shared_blks_read / s.calls, s.shared_blks_hit / s.calls,
       COALESCE(substring(s.query from '"public"\."([a-z_0-9]+)"'), '?')
FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
WHERE r.rolname IN ('service_role','authenticator') AND s.calls BETWEEN 515 AND 545 ORDER BY s.mean_exec_time DESC;
EXPLAIN SELECT count(*) FROM public.enrichment_queue WHERE status = 'processing';
EXPLAIN SELECT count(*) FROM public.enrichment_queue WHERE status = 'pending' AND task_type = 'tag';
EXPLAIN SELECT refreshed_at FROM public.entity_search_index ORDER BY refreshed_at DESC LIMIT 1;
SELECT status, count(*) FROM public.enrichment_queue GROUP BY 1;

-- GUCs
SELECT name, setting, unit, reset_val, source, boot_val FROM pg_settings WHERE name IN (…);
SELECT r.rolname, d.datname, s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase;
SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND array_to_string(p.proconfig, ',') ~ '(work_mem|max_parallel|jit|hash_mem)';
SELECT p.proname, (regexp_matches(p.prosrc, '(SET\s+(LOCAL\s+)?(work_mem|max_parallel_workers_per_gather|jit|hash_mem_multiplier|maintenance_work_mem)\s*(=|TO)\s*''?[A-Za-z0-9]+''?)', 'gi'))[1]
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
SELECT name, setting FROM pg_file_settings WHERE name = 'work_mem';   -- ERROR: permission denied for function pg_show_all_file_settings

-- spills, backends
SELECT temp_files, temp_bytes, stats_reset, numbackends FROM pg_stat_database WHERE datname = current_database();
SELECT r.rolname, sum(s.temp_blks_written) FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid GROUP BY 1;
SELECT r.rolname, s.calls, s.temp_blks_written, s.mean_exec_time, left(s.query, 110)
FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid WHERE s.temp_blks_written > 0 ORDER BY s.temp_blks_written DESC LIMIT 15;
SELECT usename, state, backend_type, count(*) FROM pg_stat_activity GROUP BY 1,2,3;
SELECT value->'backends' FROM public.pipeline_state WHERE key = 'box_health';
```
</details>

---

## 7. FIX-1189 O1 / FIX-1020 — the 11 unpaired candidate stubs

Read-only. Every number below comes from prod (`node scripts/db-query.mjs --prod`, `SET TRANSACTION READ ONLY` enforced, `max_parallel_workers_per_gather = 0` first), read 2026-10-03 between about 22:00 and 23:00 UTC, unless a row says otherwise. Code is quoted from `main` at `784a876b`. No recommendation — the facts only, for the Sunday design (bind / merge / leave per member). Files named `scratchpad/r7/*.sql` are the session's working queries and are not committed; their cores are reproduced in the `<details>` blocks.

---

### (a) The current-id-on-a-stub rows, per member

#### a.0 The stamp: key, writer, shape

- **Key.** One `public.data_sync_log` row per night, `pipeline = 'congress_legislator_ids_report'`, `rows_inserted = 0`. Nothing goes to `pipeline_state`: the only writes are `startSync`/`completeSync`/`failSync` on `data_sync_log`.
- **Writer.** `packages/data/src/pipelines/congress/legislator-ids-report.ts`:
  - `:47` `export const REPORT_PIPELINE = "congress_legislator_ids_report";`
  - `:231` `const logId = opts.dryRun ? "" : await startSync(REPORT_PIPELINE);`
  - `:275` `await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0, metadata });`
- **Shape.** `metadata` is `stampMetadata()` (`:207-223`): `{...LegislatorIdReport, population_predicate, historical_members_count, historical_members_with_fec, claimant_rows_read, dataset_ref, read_at}`. `completeSync` (`sync-log.ts:170-176`) merges in `peak_rss_mb`. `LegislatorIdReport` (`legislator-ids.ts:409-433`) is `{population, counts, double_claim_split{current_id, other_id}, top_20{<class>: ReportEntry[]}, dataset_members, matched_dataset_members, members_with_multiple_rows, dataset_ambiguous_current, matched_via_historical, unmatched_dataset_members}`. Each `ReportEntry` is `{bioguide, official_id, name, state, live, dataset_ids, current_id, reason}`.
- **The truncation that limits this section.** `top_20` holds **the first 20 entries per class, by name, then by official_id** (`legislator-ids.ts:490-495`). `double_claim` has 59 rows, so the stamp carries 20. The list stops at "Haley M. Stevens". **The stamp does not carry the dataset's `id.fec[]` for any `double_claim` row whose name sorts after that.**

**Table A1. The stamps.** Instrument: `data_sync_log` · Database: prod · Unit: one row per nightly run · Window: all rows for the pipeline (2026-09-28 → 2026-10-03).

| started_at (UTC) | id | status | noop | bindable | prior_office_live | prior_incomplete | unlisted_live_id | double_claim (current_id / other_id) | dataset_lag | top_20.double_claim listed |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|
| 2026-10-03 21:37:31 | `116cd1f9…` (**newest**) | complete | 444 | 0 | 2 | 29 | 3 | 59 (13 / 46) | 2 | 20 |
| 2026-10-02 21:07:59 | `a0ba8ad5…` | complete | 444 | 0 | 2 | 29 | 3 | 59 (13 / 46) | 2 | 20 |
| 2026-10-01 21:06:09 | `fa1be188…` | complete | 444 | 0 | 2 | 29 | 3 | 59 (13 / 46) | 2 | 20 |
| 2026-09-30 21:06:45 | `67708250…` | complete | 444 | 0 | 2 | 29 | 3 | 59 (13 / 46) | 2 | 20 |
| 2026-09-29 21:05:47 | `923ae88f…` | complete | 444 | 0 | 2 | 29 | 3 | 59 (13 / 46) | 2 | 20 |
| 2026-09-28 21:07:38 | `36136232…` | complete | 444 | 0 | 2 | 29 | 3 | 59 (13 / 46) | 2 | 20 |

`cross_bioguide_claim`, `ambiguous_current` and `no_bioguide` are 0 in all six. The newest stamp's `dataset_ref.current` has ETag `W/"6ab4f9aa-166a83"` and Last-Modified `Thu, 24 Sep 2026 10:21:30 GMT`. That is the same file cc-170 read on 09-28 (its rendered receipt quotes the same ETag and Last-Modified).

<details><summary>Query A1</summary>

```sql
SET max_parallel_workers_per_gather = 0;
SELECT id, started_at, completed_at, status, rows_inserted, metadata->'counts' AS counts,
       metadata->'double_claim_split' AS split,
       jsonb_array_length(metadata->'top_20'->'double_claim') AS dc_listed
  FROM public.data_sync_log WHERE pipeline='congress_legislator_ids_report' ORDER BY started_at DESC;
```
</details>

#### a.1 Where the tree contradicts the brief

1. **"13 ids over 11 members" is not what the split counts.** `double_claim_split` counts population **rows** (`legislator-ids.ts:473-476`: `current_id++` when the row's `current_id ∈ contested`). The 13 rows are:
   - the **11 named members' elected rows**, which hold no `fec_candidate_id`;
   - **Gilbert Ray Cisneros**, whose row holds live `H8CA39174` while the dataset's current id `H4CA31170` sits on stub `a1766a0b` (this one is in the stamp);
   - **one row not in the stamp**, inferred to be **Keith Self**. His row holds live `H2TX00064`. Stub `60de154b` (created 2026-09-19, no bioguide) holds `H2TX03290`, which cc-170 read from this same dataset file as Self's current id.

   The 11 named members contribute **12 stubs and 12 contested ids**: Luján has two stubs, the Senate id `S0NM00058` (current) and the House id `H8NM03196` (prior).
2. **Only 7 of the 13 current-id rows are in the stamp:** McClain Delaney, Hinson, Radewagen, Austin Scott, Luján, Watson Coleman, Cisneros. The other 6 (García, Sánchez, Barragán, Velázquez, Hernández, and the inferred Self) all sort after "Haley M. Stevens". For those, the dataset's `id.fec[]` is **not in the stamp**. No cached copy of `legislators-current.json` exists on disk (searched `C:/Users/Craig/Documents/Civitics` and the Claude temp tree), and it was not fetched. Their stubs below are **DB-derived**: the only non-elected row carrying a CAND_ID with the member's office char and state chars and a matching name.
3. **All 11 are `double_claim` by elimination, from the stamp's counts alone.** Every one of the 11 rows has a bioguide and no live, prior or retired id (Table A2). Such a row can only be `dataset_lag`, `cross_bioguide_claim`, `double_claim`, `bindable` or `ambiguous_current` (`classifyBinding`, `legislator-ids.ts:272-388`). `dataset_lag` is exactly Alan Armstrong and Darline Graham (the stamp's `top_20.dataset_lag`), and the other three classes are 0. So all 11 are `double_claim`. cc-170 (which had the whole dataset in its dry run) states that all 11 have their current id on a stub. That accounts for 11 + Cisneros + Self = 13, which matches the stamp's split. The Self attribution is the only inference in that arithmetic.
4. **Al Green is no longer a case.** His elected row `e9015ab5` holds live `H4TX09095`. The Alexander Green stub `a92cfc2e` carries `{"merged_fec_candidate_ids": ["H4TX09095"]}` (retired). FIX-1020's "Alexander/Al" half is settled in the data. Austin Scott is the only FIX-1020 member among the 11.
5. **`authoritativeClaims()` does not split by chamber.** It is `fec_candidate_id` first, then `prior_fec_candidate_ids`, minus retired ids (`fec-bulk/claims.ts:100-108`). "Current vs prior office" is a storage convention (live = current office), not something the reader checks. None of the 11 elected rows and none of the 12 stubs carries a prior or retired array, so for these rows the reader returns exactly `fec_candidate_id` or nothing.

```ts
// packages/data/src/pipelines/fec-bulk/claims.ts:100-108
export function authoritativeClaims(o: SourceIdsCarrier): string[] {
  const out: string[] = [];
  const current = o.source_ids["fec_candidate_id"];
  if (typeof current === "string" && current) out.push(current);
  for (const p of priorClaims(o)) if (!out.includes(p)) out.push(p);
  return out.filter((id) => !hasRetiredClaim(o, id));
}
```

#### a.2 Identity, per member

**Table A2. Elected rows and the dataset listing.** Instrument: `officials` + the newest stamp's `top_20.double_claim` · Database: prod · Unit: one elected row · Window: snapshot at about 22:00 UTC 2026-10-03.

All 13 elected rows are `tier='elected'`, `is_active=true`, `primary_source='congress_gov'`, created 2026-04-22 (Self's row was created 2026-09-13).

| # | member | bioguide | seat (jurisdiction / district_name) | dataset `id.fec[]` (source) | stamp `current_id` | elected row id | elected `source_ids` |
|---|---|---|---|---|---|---|---|
| 1 | Ashley Hinson | H001091 | IA / District 2 | `["H0IA01174"]` (stamp) | H0IA01174 | `1fcd4ca1-8598-476e-a469-d0abdf604863` | `{"congress_gov":"H001091"}` |
| 2 | Nanette Diaz Barragán | B001300 | CA / District 44 | **not in stamp** | — | `380c47ba-e2b2-4008-8847-1c405343ffc2` | `{"congress_gov":"B001300"}` |
| 3 | April McClain Delaney | M001232 | MD / District 6 | `["H4MD06340"]` (stamp) | H4MD06340 | `3ba56de6-f313-4f1f-afbe-c4e360f459db` | `{"congress_gov":"M001232"}` |
| 4 | Jesús G. "Chuy" García | G000586 | IL / District 4 | **not in stamp** | — | `42d07b67-ae64-4276-ac92-3b40fc4a46a3` | `{"congress_gov":"G000586"}` |
| 5 | Bonnie Watson Coleman | W000822 | NJ / District 12 | `["H4NJ12149"]` (stamp) | H4NJ12149 | `6a01a39b-8283-40a8-9017-a1eb5d6a340c` | `{"congress_gov":"W000822"}` |
| 6 | Nydia M. Velázquez | V000081 | NY / District 7 | **not in stamp** | — | `838ab3f3-760f-4e65-9f3a-08bb474a8692` | `{"congress_gov":"V000081"}` |
| 7 | Austin Scott | S001189 | GA / District 8 | `["H0GA08099"]` (stamp) | H0GA08099 | `88b9e155-0d06-48f3-94e5-bec952869441` | `{"congress_gov":"S001189"}` |
| 8 | Pablo Jose Hernández | H001103 | PR / (null) | **not in stamp** | — | `cccaae0a-35fd-48ad-a365-c005da9c12b4` | `{"congress_gov":"H001103"}` |
| 9 | Aumua Amata Coleman Radewagen | R000600 | AS / (null) | `["H4AS00036"]` (stamp) | H4AS00036 | `e1824501-eb21-4c20-8596-b8a86b543ccd` | `{"congress_gov":"R000600"}` |
| 10 | Linda T. Sánchez | S001156 | CA / District 38 | **not in stamp** | — | `e899cac1-7982-4a3b-96a0-eb25e39553dc` | `{"congress_gov":"S001156"}` |
| 11 | Ben Ray Luján | L000570 | NM / (Senate) | `["H8NM03196","S0NM00058"]` (stamp) | S0NM00058 | `eadbf1fd-e245-44ff-91ec-794407411f69` | `{"congress_gov":"L000570"}` |
| — | Gilbert Ray Cisneros | C001123 | CA / District 31 | `["H4CA31170","H8CA39174"]` (stamp) | H4CA31170 | `1f0fcc25-c88d-4112-9e90-e873d106d32d` | `{"congress_gov":"C001123","fec_candidate_id":"H8CA39174"}` |
| — | Keith Self (inferred 13th) | S001224 | TX / District 3 | not in stamp; cc-170 (same file): current `H2TX03290`, live `H2TX00064` | — | `0104dd77-938f-4f0f-aa18-cb5c04b51f1d` | `{"congress_gov":"S001224","fec_candidate_id":"H2TX00064"}` |

The stamp's `reason` strings for the 7 it carries:
- Hinson: `H0IA01174 also claimed by 369bd6b6-… (no bioguide)`
- McClain Delaney: `H4MD06340 also claimed by 8ab73c89-… (no bioguide)`
- Watson Coleman: `H4NJ12149 also claimed by eb6e7f4c-… (no bioguide)`
- Austin Scott: `H0GA08099 also claimed by 893a581e-… (no bioguide)`
- Radewagen: `H4AS00036 also claimed by 439f33bb-… (no bioguide)`
- Luján: `H8NM03196 also claimed by 6dc78f88-… (no bioguide); S0NM00058 also claimed by 93a6040f-… (no bioguide)`
- Cisneros: `H4CA31170 also claimed by a1766a0b-… (no bioguide)`

**Table A3. The stubs.** Instrument: `officials` · Database: prod · Unit: one stub row · Window: snapshot at about 22:00 UTC 2026-10-03.

Every stub is `tier='candidate'`, `is_active=true`, carries no `congress_gov`, and its `source_ids` is exactly `{"fec_candidate_id": <id>}` (no prior, merged or `fec_id` key). Each CAND_ID has **exactly one** carrier platform-wide, in any `source_ids` slot (Query A3b).

| # | member | stub id | stub `full_name` | role_title | created / primary_source | CAND_ID | encoded seat (office·state·chars 5-6) | member seat | same office + state + district? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Hinson | `369bd6b6-2e5c-409d-82fd-bb426b7a66aa` | Ashley Arenholz | Cand. for Representative | 2026-05-11 / fec | H0IA01174 | H · IA · 01 | House IA-2 | **no** (01 ≠ 2) |
| 2 | Barragán | `499e1266-e4cd-4188-b9b8-4ff321e9863f` | Nanette Barragan | Cand. for Representative | 2026-05-11 / littlesis | H6CA44103 | H · CA · 44 | House CA-44 | yes |
| 3 | McClain Delaney | `8ab73c89-3703-43f3-9ed4-1023bf465527` | April Delaney | Cand. for Representative | 2026-05-11 / littlesis | H4MD06340 | H · MD · 06 | House MD-6 | yes |
| 4 | García | `71c5b1c0-7436-499f-a2e1-61f2e2f681a2` | Jesus Garcia | Cand. for Representative | 2026-05-11 / littlesis | H8IL04134 | H · IL · 04 | House IL-4 | yes |
| 5 | Watson Coleman | `eb6e7f4c-dc9c-47c5-a016-5d499dccd0ac` | Bonnie Coleman | Cand. for Representative | 2026-05-11 / littlesis | H4NJ12149 | H · NJ · 12 | House NJ-12 | yes |
| 6 | Velázquez | `cd949887-7a4e-4c1d-827d-501ad06522de` | Nydia Velazquez | Cand. for Representative | 2026-05-11 / fec | H2NY00010 | H · NY · 00 | House NY-7 | **no** (00 ≠ 7) |
| 7 | Austin Scott | `893a581e-4fc0-4190-b43f-6afafc7aa917` | James Scott | Cand. for Representative | 2026-05-11 / littlesis | H0GA08099 | H · GA · 08 | House GA-8 | yes |
| 8 | Hernández | `02942ed7-fec5-4384-b0cb-d94775ba7d26` | Pablo Hernandez Rivera | Cand. for Representative | 2026-05-11 / fec | H4PR01010 | H · PR · 01 | House PR (district_name null → 0) | **no** (01 ≠ 0) |
| 9 | Radewagen | `439f33bb-0ed0-4a27-aedd-3d1e1c8fa8a2` | Aumua Amata | Cand. for Representative | 2026-05-11 / fec | H4AS00036 | H · AS · 00 | House AS (null → 0) | yes |
| 10 | Sánchez | `29714b2c-42bf-4b43-a82d-60785caa4af7` | Linda Sanchez | Cand. for Representative | 2026-05-11 / littlesis | H2CA39078 | H · CA · 39 | House CA-38 | **no** (39 ≠ 38) |
| 11a | Luján (current) | `93a6040f-402c-4f85-8d0d-55cf1b0350b2` | Ben Lujan | Cand. for Senator | 2026-05-11 / fec | S0NM00058 | S · NM | Senate NM | yes |
| 11b | Luján (prior) | `6dc78f88-fe6f-4ff5-8a75-bd242e07d0ec` | Ben Lujan | Cand. for Representative | 2026-05-11 / fec | H8NM03196 | H · NM · 03 | Senate NM | **no** (office H ≠ Senator) |
| — | Cisneros | `a1766a0b-a4ee-4117-afb6-6aec28a1af18` | Gilbert Cisneros | Cand. for Representative | 2026-07-18 / fec | H4CA31170 | H · CA · 31 | House CA-31 | yes |
| — | Self | `60de154b-9dde-4eb9-9b0f-d519172335a9` | Keith Self | Cand. for Representative | 2026-09-19 / fec | H2TX03290 | H · TX · 03 | House TX-3 | yes |

Rows 2, 4, 6, 8 and 10 (and Self) are **DB-derived**, not stamp-confirmed. In every row, the stub's `metadata->>'state'` equals the elected row's jurisdiction `short_name`.

<details><summary>Queries A2 / A3 / A3b</summary>

```sql
-- A2 part 1: federal elected rows with no live id (FEDERAL_ELECTED_POPULATION.sql)
SET max_parallel_workers_per_gather = 0;
SELECT o.id, o.full_name, o.first_name, o.last_name, o.role_title, j.short_name AS st, o.district_name,
       o.is_active, o.tier, o.source_ids->>'congress_gov' AS bioguide, o.source_ids->>'fec_candidate_id' AS live,
       o.source_ids->'prior_fec_candidate_ids' AS prior, o.source_ids->'merged_fec_candidate_ids' AS merged_arr,
       o.source_ids->>'merged_fec_candidate_id' AS merged_scalar, o.source_ids->>'fec_id' AS fec_id
  FROM officials o LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
 WHERE o.tier = 'elected'
   AND o.governing_body_id IN (SELECT id FROM governing_bodies WHERE (name, type) IN
       (('United States Senate','legislature_upper'),('United States House of Representatives','legislature_lower')))
   AND (o.source_ids->>'fec_candidate_id') IS NULL
 ORDER BY o.last_name;
-- → 12 rows: Armstrong (dataset_lag) + the 11. None carries prior / merged / fec_id.

-- A2 part 2: the stamp's double_claim top-20
SELECT e->>'name', e->>'bioguide', e->>'state', e->>'official_id', e->>'live', e->'dataset_ids', e->>'current_id', e->>'reason'
  FROM public.data_sync_log d, jsonb_array_elements(d.metadata->'top_20'->'double_claim') e
 WHERE d.id='116cd1f9-df8c-47db-baf1-6c99fe1be227';
SELECT metadata->'top_20'->'dataset_lag' FROM public.data_sync_log WHERE id='116cd1f9-df8c-47db-baf1-6c99fe1be227';

-- A3 (stub discovery for the 5 non-stamp members): non-elected rows whose name matches the
-- member and whose CAND_ID carries the member's state chars
WITH m(member, pat, st) AS (VALUES ('Barragan','%barrag%','CA'),('Garcia (Chuy)','%garc%','IL'),
  ('Hernandez','%hern%','PR'),('Hinson','%hinson%','IA'),('Lujan','%luj%','NM'),('McClain Delaney','%delaney%','MD'),
  ('McClain Delaney','%mcclain%','MD'),('Radewagen','%radewagen%','AS'),('Radewagen','%amata%','AS'),
  ('Sanchez','%nchez%','CA'),('Scott (Austin)','%scott%','GA'),('Velazquez','%zquez%','NY'),('Watson Coleman','%coleman%','NJ'))
SELECT m.member, o.id, o.full_name, o.tier, o.role_title, o.is_active, o.created_at::date, o.primary_source,
       o.metadata->>'state', o.district_name, o.source_ids->>'congress_gov', o.source_ids->>'fec_candidate_id',
       o.source_ids->'prior_fec_candidate_ids', o.source_ids->'merged_fec_candidate_ids', o.source_ids->>'merged_fec_candidate_id'
  FROM m JOIN officials o ON o.full_name ILIKE m.pat
 WHERE o.tier <> 'elected'
   AND (substr(o.source_ids->>'fec_candidate_id',3,2) = m.st OR substr(o.source_ids->>'merged_fec_candidate_id',3,2) = m.st)
 ORDER BY 1, o.source_ids->>'fec_candidate_id';
-- Barragán / García / Velázquez / Hernández / Sánchez: one same-first-name, same-seat-family row each
-- (the others returned are different first names: Rodolfo Barragan, Patty Garcia, Jose Hernandez-Mayoral,
--  Monica/Tim/Abdeli/David/Jorge/Loretta Sanchez, Jose Velazquez, Marcye Scott, John Delaney, Michelle Lujan Grisham).
-- Hinson's stub (Ashley Arenholz) does not match a surname pattern; it is identified by the stamp.

-- A3 detail: full rows for the 14 (elected, stub) pairs, see scratchpad q4_rows.sql
-- A3b: every officials row carrying each CAND_ID in ANY source_ids slot
WITH c(cand_id) AS (VALUES ('H0IA01174'),('H6CA44103'),('H4MD06340'),('H8IL04134'),('H4NJ12149'),('H2NY00010'),
  ('H0GA08099'),('H4PR01010'),('H4AS00036'),('H2CA39078'),('S0NM00058'),('H8NM03196'),('H4CA31170'),('H2TX03290'))
SELECT c.cand_id, o.id, o.full_name, o.tier,
       CASE WHEN o.source_ids->>'fec_candidate_id' = c.cand_id THEN 'live'
            WHEN COALESCE(o.source_ids->'prior_fec_candidate_ids','[]'::jsonb) ? c.cand_id THEN 'prior'
            WHEN COALESCE(o.source_ids->'merged_fec_candidate_ids','[]'::jsonb) ? c.cand_id THEN 'merged_arr'
            WHEN o.source_ids->>'merged_fec_candidate_id' = c.cand_id THEN 'merged_scalar'
            WHEN o.source_ids->>'fec_id' = c.cand_id THEN 'fec_id' ELSE 'other-key' END AS slot
  FROM c JOIN officials o ON o.source_ids::text LIKE '%' || c.cand_id || '%' ORDER BY 1, o.tier;
-- → 14 rows, one per id, every one the stub, slot 'live'.

-- Al Green check
SELECT id, full_name, tier, source_ids FROM officials WHERE source_ids::text LIKE '%H4TX09095%';
```
</details>

#### a.3 `verifyOwnSeatInDb`, applied by hand

The predicate (`packages/data/src/scripts/merge-same-person-official-dupes.ts:832-984`). Its SQL computes, per `(survivor, dup)`:

```sql
s.source_ids->>'fec_candidate_id' AS survivor_fec,
d.source_ids->>'fec_candidate_id' AS dup_fec,
s.role_title                      AS survivor_role,
upper(js.short_name)              AS survivor_state,
COALESCE(NULLIF(regexp_replace(COALESCE(s.district_name,''),'[^0-9]','','g'),''),'0') AS survivor_district,
regexp_replace(upper(COALESCE(NULLIF(s.last_name,''), s.full_name)),'[^A-Z]','','g') AS survivor_surname,
regexp_replace(upper(COALESCE(NULLIF(d.last_name,''), d.full_name)),'[^A-Z]','','g') AS dup_surname,
-- + att.* : votes, career_history, official_committee_memberships, promises, proposal_cosponsors,
--   official_community_comments, civic_initiative_responses, lobbying_disclosures,
--   bill_details.primary_sponsor_id, proposal_actions.performed_by_id, external_relationships (from or to)
```

The client then refuses, in this order:

```ts
if (r.survivor_tier !== "elected" || r.dup_tier !== "candidate") …           // :918
if (r.dup_fec !== p.fecId) …                                                  // :922
if (r.survivor_fec !== null && r.survivor_fec !== p.fecId) …  // "survivor holds a DIFFERENT id" :928
if (!r.survivor_surname || r.survivor_surname !== r.dup_surname) …  // "surnames disagree" :935
if (r.dup_attachments !== "0") …               // "stub carries non-money records" (decision 5) :945
if (!roleMayHoldFecOffice(role, office) || state !== (r.survivor_state ?? "")) … // seat re-check :960
if (office === "H") { … if (Number(candDistrict) !== Number(r.survivor_district ?? "0")) … } // :967-979
```

`roleMayHoldFecOffice(role, office)` is `fecOfficePrefixFor(role) === office`, with `Representative→H`, `Senator→S` (`fec-bulk/electable-role.ts:43-51, 89-96`). Selection is a separate step: `OWN_SEAT_MANIFEST_SQL` (`:610-664`) joins on `d.surname = s.surname` with the same normalisation (`:618, :637`), so **a pair that fails the surname gate is never even selected.**

**Table A4. Own-seat gates, per pair.** Instrument: SQL reproduction of `verifyOwnSeatInDb`'s columns, with its checks evaluated as CASE · Database: prod · Unit: one (elected, stub) pair · Window: snapshot 2026-10-03.

| # | member | survivor_surname vs dup_surname | unbound | surname | decision-5 (attachments) | office+state | district | **first refusal** |
|---|---|---|---|---|---|---|---|---|
| 1 | Hinson | HINSON vs ARENHOLZ | ✓ | ✗ | ✓ (0) | ✓ | ✗ 01 vs 2 | surnames disagree |
| 2 | Barragán | **BARRAGN** vs BARRAGAN | ✓ | ✗ | ✗ (2 ext_rel) | ✓ | ✓ | surnames disagree |
| 3 | McClain Delaney | MCCLAINDELANEY vs DELANEY | ✓ | ✗ | ✗ (6) | ✓ | ✓ | surnames disagree |
| 4 | García | **GARCA** vs GARCIA | ✓ | ✗ | ✗ (1) | ✓ | ✓ | surnames disagree |
| 5 | Watson Coleman | WATSONCOLEMAN vs COLEMAN | ✓ | ✗ | ✗ (5) | ✓ | ✓ | surnames disagree |
| 6 | Velázquez | **VELZQUEZ** vs VELAZQUEZ | ✓ | ✗ | ✓ (0) | ✓ | ✗ 00 vs 7 | surnames disagree |
| 7 | Austin Scott | SCOTT vs SCOTT | ✓ | ✓ | ✗ (10) | ✓ | ✓ | **stub carries non-money records (10 external_relationships)** |
| 8 | Hernández | **HERNNDEZ** vs HERNANDEZRIVERA | ✓ | ✗ | ✓ (0) | ✓ | ✗ 01 vs 0 | surnames disagree |
| 9 | Radewagen | RADEWAGEN vs AMATA | ✓ | ✗ | ✓ (0) | ✓ | ✓ 00 vs 0 | surnames disagree |
| 10 | Sánchez | **SNCHEZ** vs SANCHEZ | ✓ | ✗ | ✗ (1) | ✓ | ✗ 39 vs 38 | surnames disagree |
| 11a | Luján S | **LUJN** vs LUJAN | ✓ | ✗ | ✓ (0) | ✓ | n/a (S) | surnames disagree |
| 11b | Luján H | **LUJN** vs LUJAN | ✓ | ✗ | ✓ (0) | ✗ H vs Senator | ✗ | surnames disagree |
| — | Cisneros | CISNEROS vs CISNEROS | ✗ (holds H8CA39174) | ✓ | ✓ (0) | ✓ | ✓ 31 | survivor holds a DIFFERENT id |
| — | Self | SELF vs SELF | ✗ (holds H2TX00064) | ✓ | ✓ (0) | ✓ | ✓ 03 | survivor holds a DIFFERENT id |

**Fact about the predicate:** `upper()` keeps `Á/Í/É`, and `'[^A-Z]'` then deletes them. So an accented elected surname never equals its unaccented FEC spelling. That is the first refusal for 6 of the 12 stubs (Barragán, García, Velázquez, Hernández, Sánchez, and both Luján stubs). For Hernández the strings also differ by "RIVERA".

<details><summary>Query A4</summary>

Full text in `scratchpad/r7/q13_ownseat.sql`. Core:

```sql
SELECT …, s.source_ids->>'fec_candidate_id' AS survivor_fec, s.role_title AS survivor_role,
       upper(js.short_name) AS survivor_state,
       COALESCE(NULLIF(regexp_replace(COALESCE(s.district_name,''),'[^0-9]','','g'),''),'0') AS survivor_district,
       regexp_replace(upper(COALESCE(NULLIF(s.last_name,''), s.full_name)),'[^A-Z]','','g') AS survivor_surname,
       regexp_replace(upper(COALESCE(NULLIF(d.last_name,''), d.full_name)),'[^A-Z]','','g') AS dup_surname,
       (SELECT count(*) FROM external_relationships er
         WHERE (er.from_type='official' AND er.from_id = d.id) OR (er.to_type='official' AND er.to_id = d.id)) AS extrel,
       CASE WHEN survivor_fec IS NOT NULL AND survivor_fec <> fec_id THEN 'survivor holds a DIFFERENT id'
            WHEN survivor_surname = '' OR survivor_surname <> dup_surname THEN 'surnames disagree'
            WHEN extrel > 0 THEN 'stub carries non-money records'
            WHEN NOT (office/role match) OR cand_state <> survivor_state THEN 'seat re-check failed'
            WHEN office='H' AND substr(fec_id,5,2)::int <> survivor_district::int THEN 'district mismatch'
            ELSE 'ok' END AS first_refusal, …
  FROM m JOIN officials s ON s.id = m.survivor JOIN officials d ON d.id = m.dup
  LEFT JOIN jurisdictions js ON js.id = s.jurisdiction_id;
```

The other ten decision-5 attachment tables are 0 for every stub (Table B2 / Query B2a). So `extrel` alone is the decision-5 total here.
</details>

---

### (b) Each stub's anchors

**How the table list was derived.**
1. FKs: `pg_constraint` (`contype='f'`, `confrelid='public.officials'`) gives **11**: `votes`, `official_committee_memberships`, `career_history`, `promises`, `civic_initiative_responses`, `official_community_comments`, `proposal_cosponsors`, `lobbying_disclosures`, `bill_details.primary_sponsor_id`, `proposal_actions.performed_by_id`, `official_content_ids`. These are decision-5's ten plus `official_content_ids`.
2. Polymorphic and non-FK columns: `information_schema.columns` in base tables named `official_id / entity_id / from_id / to_id / target_id / matched_entity_id / related_entity_id / recipient_id / followed_officials` (48 + 19 hits).
3. Claim-like tables: only `entity_grants` (`target_id`) and `claim_queue` (keyed by `jurisdiction_id`, so it cannot point at an official) exist.

**Table B1. Money on each stub.** Instrument: `financial_relationships` grouped by side and `relationship_type` · Database: prod · Unit: rows and Σ `amount_cents` (shown in $) · Window: all rows present at about 22:10 UTC 2026-10-03.

From-side (`from_id = stub`) is **0 rows for all 14 stubs**. To-side is all `to_type='official'`:

| # | member | donation rows / $ | ie_support rows / $ | ie_oppose rows / $ | total rows / $ | cycles | sources |
|---|---|---|---|---|---|---|---|
| 1 | Hinson | 6,571 / $12,664,729.00 | 13 / $1,874,574.59 | 5 / $5,368,898.88 | 6,589 / $19,908,202.47 | 2020–2026 | fec_bulk_indiv, _pac, _ie |
| 2 | Barragán | 1,682 / $4,406,380.00 | 1 / $150,000.00 | 0 | 1,683 / $4,556,380.00 | 2020–2026 | indiv, pac, ie |
| 3 | McClain Delaney | 1,477 / $3,238,407.00 | 4 / $566,790.77 | 6 / $271,669.05 | 1,487 / $4,076,866.82 | 2024–2026 | indiv, pac, ie |
| 4 | García | 1,434 / $2,675,217.00 | 2 / $231,854.76 | 0 | 1,436 / $2,907,071.76 | 2020–2026 | indiv, pac, ie |
| 5 | Watson Coleman | 1,440 / $2,673,148.00 | 0 | 0 | 1,440 / $2,673,148.00 | 2020–2026 | indiv, pac |
| 6 | Velázquez | 1,264 / $2,001,133.00 | 0 | 0 | 1,264 / $2,001,133.00 | 2020–2026 | indiv, pac |
| 7 | Austin Scott | 1,958 / $4,015,676.00 | 1 / $5,000.00 | 1 / $1,748.10 | 1,960 / $4,022,424.10 | 2020–2026 | indiv, pac, ie |
| 8 | Hernández | 1,565 / $1,970,163.00 | 0 | 0 | 1,565 / $1,970,163.00 | 2024–2026 | indiv, pac |
| 9 | Radewagen | 112 / $230,505.00 | 1 / $1,568.33 | 0 | 113 / $232,073.33 | 2020–2026 | indiv, pac, ie |
| 10 | Sánchez | 2,054 / $5,774,739.00 | 1 / $300,000.00 | 0 | 2,055 / $6,074,739.00 | 2020–2026 | indiv, pac, ie |
| 11a | Luján S | 5,492 / $9,710,061.00 | 1 / $11,770.00 | 1 / $404,479.88 | 5,494 / $10,126,310.88 | 2020–2026 | indiv, pac, ie |
| 11b | Luján H | 171 / $619,552.00 | 0 | 0 | 171 / $619,552.00 | 2020–2026 | pac |
| — | Cisneros | 67 / $212,150.00 | 0 | 1 / $1,373.10 | 68 / $213,523.10 | 2024–2026 | pac, ie |
| — | Self | 158 / $391,098.00 | 1 / $1,215.09 | 0 | 159 / $392,313.09 | 2024–2026 | pac, ie |

Across the 12 stubs of the 11 members: **$49,979,710.00 in donations** and $59,168,064.36 in all types. **The 11 elected rows hold 0 `financial_relationships` rows** (Query D1a).

**Table B2. Non-money anchors (non-zero only).** Instrument: per-table `count(*)` with an index-matching predicate · Database: prod · Unit: rows · Window: snapshot about 22:20 UTC 2026-10-03.

| # | member | `external_relationships` (decision-5) | `entity_connections` non-money | `external_source_refs` | `entity_tags` | `official_content_ids` | `enrichment_queue` |
|---|---|---|---|---|---|---|---|
| 1 | Hinson | 0 | 0 | 0 | 3 (industry, rule) | 1 | 1 (tag, skipped_feature_retired) |
| 2 | Barragán | **2** from: littlesis/appointment (Position) ×2 | 2 from: appointment | 2 littlesis | 4 (3 industry + 1 pattern, rule) | 1 | 0 |
| 3 | McClain Delaney | **6** from: littlesis/affiliated_with ×3, appointment ×1, member_of ×2 | 6 from: affiliated_with 3, appointment 1, member_of 2 | 1 littlesis | 3 | 1 | 0 |
| 4 | García | **1** from: littlesis/appointment | 1 from: appointment | 1 littlesis | 4 | 1 | 0 |
| 5 | Watson Coleman | **5**: 2 from member_of; 3 to (affiliated_with ×2 Generic, appointment ×1) | 2 from member_of; 3 to (affiliated_with 2, appointment 1) | 1 littlesis | 4 | 1 | 0 |
| 6 | Velázquez | 0 | 0 | 0 | 3 | 1 | 0 |
| 7 | Austin Scott | **10**: 9 from (appointment ×8, member_of ×1); 1 to (affiliated_with) | 8 from (appointment 7, member_of 1); 1 to (affiliated_with) | 7 littlesis | 4 | 1 | 1 (tag, skipped_feature_retired) |
| 8 | Hernández | 0 | 0 | 0 | 3 | 1 | 1 (tag, skipped_feature_retired) |
| 9 | Radewagen | 0 | 0 | 0 | 2 | 1 | 0 |
| 10 | Sánchez | **1** from: littlesis/appointment | 1 from: appointment | 1 littlesis | 4 | 1 | 0 |
| 11a | Luján S | 0 | **44 from: vote_no 27, vote_yes 17 (evidence_source `votes`)**, while `votes` = 0 | 0 | 3 | 1 | 0 |
| 11b | Luján H | 0 | 0 | 0 | 4 | 1 | 0 |
| — | Cisneros | 0 | 0 | 0 | 4 | 0 | 1 (tag, skipped_feature_retired) |
| — | Self | 0 | 0 | 0 | 4 | 0 | 0 |

Money-derived `entity_connections` on the to-side (`donation`/`opposition`, evidence_source `financial_relationships`):

| stub | donation | opposition |
|---|---:|---:|
| Hinson | 4,554 | 5 |
| Barragán | 1,013 | — |
| McClain Delaney | 1,270 | 5 |
| García | 944 | — |
| Watson Coleman | 936 | — |
| Velázquez | 919 | — |
| Austin Scott | 1,325 | 1 |
| Hernández | 1,419 | — |
| Radewagen | 87 | — |
| Sánchez | 1,259 | — |
| Luján S | 4,776 | 1 |
| Luján H | 144 | — |
| Cisneros | 65 | 1 |
| Self | 117 | — |

Each stub also has 1 row in `entity_connection_stats_mv`.

- The six stubs with `external_relationships` rows are exactly the six with `primary_source = 'littlesis'`.
- FIX-1020 records Austin Scott's 10 as "9 from, 1 to, incl. 7 `appointment`". Today the 10 are 9 from + 1 to, with **8** `appointment` `external_relationships` rows and **7** `appointment` `entity_connections` edges.

**Table B3. Derived rollups keyed on the stub.** Instrument: per-table `count(*)` · Database: prod · Unit: rows · Window: snapshot 2026-10-03.

| stub | official_donor_totals | official_donor_bracket_totals | official_sector_affinity_rollup | official_small_dollar_rollup | official_donor_rollup_mv | small_dollar_bracket_rollup |
|---|---:|---:|---:|---:|---:|---:|
| Hinson | 1 | 4 | 17 | 1 | 217 | 0 |
| Barragán | 1 | 4 | 15 | 1 | 202 | 2 |
| McClain Delaney | 1 | 4 | 15 | 1 | 210 | 3 |
| García | 1 | 4 | 16 | 1 | 203 | 3 |
| Watson Coleman | 1 | 4 | 14 | 1 | 201 | 0 |
| Velázquez | 1 | 4 | 14 | 1 | 201 | 2 |
| Austin Scott | 1 | 4 | 16 | 1 | 203 | 0 |
| Hernández | 1 | 4 | 9 | 1 | 201 | 2 |
| Radewagen | 1 | 4 | 3 | 1 | 87 | 0 |
| Sánchez | 1 | 4 | 16 | 1 | 202 | 3 |
| Luján S | 1 | 4 | 17 | 1 | 203 | 3 |
| Luján H | 1 | 0 | 16 | 1 | 144 | 0 |
| Cisneros | 1 | 0 | 13 | 1 | 66 | 0 |
| Self | 1 | 0 | 15 | 1 | 118 | 0 |

**Zero for all 14 stubs** (stated once, Queries B2a and B3):
- `votes`, `official_committee_memberships`, `career_history`, `promises`, `civic_initiative_responses`, `official_community_comments`, `proposal_cosponsors`, `lobbying_disclosures`, `bill_details.primary_sponsor_id`, `proposal_actions.performed_by_id`
- `entity_grants.target_id` (**no stub is claimed**), `user_follows`, `user_preferences.followed_officials`, `notifications`
- `entity_comments`, `entity_positions`, `entity_statements`, `position_events`, `evidence_cards` (from/to), `citations`, `abuse_events`, `brigade_candidates`, `civic_credit_transactions`
- `page_views`, `irs990_grants_out.matched_entity_id`, `irs990_officers.matched_entity_id`, `franklin_seed_map.row_id`, `ai_summary_cache` (entity_type is `proposal` only, per `pg_stats`)
- `official_vote_stats`, `financial_entity_inbound_rollup/_totals.recipient_id`, `contract_recipient_rollup`, `entity_activity_state`, `synthetic_position_rollup`, `ec_donations_incr_dirty`

`external_relationships` and `entity_tags` were counted with `from_type/to_type/entity_type = 'official'`. These tables' `pg_stats` list only `financial_entity`/`official` (ER) and `financial_entity`/`proposal`/`official` (tags) as type values.

**Not counted (stated, with why):**
- `fec_emit_keys.to_id`: 5.3M rows, only a `run_id` index; it is the FIX-1106 emit ledger.
- `external_relationships_review_queue.resolved_to_id`: 733k rows, no index on it.
- `entity_search_index.entity_id`: 368k rows, no `entity_id` index; derived.

An unnarrowed first attempt at B2 (untyped `entity_id`/`from_id` probes on those tables) **exceeded 2 minutes and was stopped**. `pg_stat_activity` showed no surviving backend afterwards. B2 was re-run narrowed.

<details><summary>Queries B0 (table list), B1, B2a, B2b, B2c, B3</summary>

```sql
-- B0a: FKs referencing officials
SELECT c.conrelid::regclass, a.attname, c.conname, c.confdeltype
  FROM pg_constraint c JOIN LATERAL unnest(c.conkey) k(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
 WHERE c.contype='f' AND c.confrelid='public.officials'::regclass ORDER BY 1,2;   -- 11 rows
-- B0b: polymorphic columns
SELECT c.table_name, string_agg(c.column_name||':'||c.data_type, ', ')
  FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
 WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
   AND c.column_name IN ('official_id','entity_id','from_id','to_id','target_id','subject_id','entity_type','from_type',
                         'to_type','target_type','subject_type','official_ids','politician_id','person_id','claimed_official_id','owner_id')
 GROUP BY 1 ORDER BY 1;
-- plus: columns ILIKE '%official%' / '%matched_entity%' / '%entity_id%' / '%recipient_id%' / '%candidate_id%',
-- and tables ILIKE '%claim%' / '%grant%' / '%seed_map%'.

-- B1: money (scratchpad q9_fr.sql)
WITH s(n, member, id) AS (VALUES … 14 stub ids …)
SELECT s.n, s.member, 'to', fr.to_type, fr.relationship_type::text, count(*), sum(fr.amount_cents),
       min(fr.cycle_year), max(fr.cycle_year), string_agg(DISTINCT fr.metadata->>'source', ',')
  FROM s JOIN financial_relationships fr ON fr.to_id = s.id GROUP BY 1,2,3,4,5
UNION ALL
SELECT s.n, s.member, 'from', fr.from_type, fr.relationship_type::text, count(*), sum(fr.amount_cents),
       min(fr.cycle_year), max(fr.cycle_year), string_agg(DISTINCT fr.metadata->>'source', ',')
  FROM s JOIN financial_relationships fr ON fr.from_id = s.id GROUP BY 1,2,3,4,5;   -- no 'from' rows returned

-- B2a: FK tables + small tables (scratchpad q10a_fk.sql) — one scalar count per table per stub:
--   votes, official_committee_memberships, career_history, promises, civic_initiative_responses,
--   official_community_comments, proposal_cosponsors, lobbying_disclosures, bill_details.primary_sponsor_id,
--   proposal_actions.performed_by_id, official_content_ids, entity_grants.target_id, user_follows.entity_id,
--   user_preferences (s.id = ANY(followed_officials)), notifications, entity_comments, entity_positions,
--   entity_statements, position_events, evidence_cards (from_id OR to_id), citations.target_id,
--   abuse_events.target_id, brigade_candidates.target_id, civic_credit_transactions.related_entity_id,
--   page_views, irs990_grants_out/irs990_officers.matched_entity_id, franklin_seed_map.row_id, ai_summary_cache
-- B2b: large polymorphic (scratchpad q10b_poly.sql)
SELECT s.n, s.member,
  (SELECT count(*) FROM entity_connections x WHERE x.from_id = s.id),
  (SELECT count(*) FROM entity_connections x WHERE x.to_id   = s.id),
  (SELECT count(*) FROM external_relationships x WHERE x.from_type='official' AND x.from_id = s.id),
  (SELECT count(*) FROM external_relationships x WHERE x.to_type='official'   AND x.to_id   = s.id),
  (SELECT count(*) FROM entity_tags x          WHERE x.entity_type='official' AND x.entity_id = s.id),
  (SELECT count(*) FROM external_source_refs x WHERE x.entity_type='official' AND x.entity_id = s.id),
  (SELECT count(*) FROM enrichment_queue x     WHERE x.entity_id = s.id::text),
  (SELECT count(*) FROM entity_connection_stats_mv x WHERE x.entity_id = s.id)
FROM s;
-- B2c: breakdowns (scratchpad q11_breakdown.sql): EC by (side, connection_type, evidence_source);
--   ER by (side, source/connection_type, raw_category_name); tags by (tag_category, generated_by);
--   external_source_refs by source; enrichment_queue by (task_type, status).
-- B3: derived (scratchpad q10c_derived.sql): official_donor_totals, official_donor_bracket_totals,
--   official_sector_affinity_rollup, official_small_dollar_rollup, official_vote_stats, official_donor_rollup_mv,
--   financial_entity_inbound_rollup/_totals.recipient_id, contract_recipient_rollup, small_dollar_bracket_rollup,
--   entity_activity_state, synthetic_position_rollup, ec_donations_incr_dirty.from_id
```
</details>

---

### (c) Why the nightly promotion skipped each stub

The guard (`packages/data/src/pipelines/congress/promote-candidates.ts`). The elected input is `congress_gov` not null, `is_active`, and `role_title ∈ {Senator, Representative}` (`:207-215, :226`). The candidate input is `tier='candidate'`, `fec_candidate_id` not null, `role_title ∈ {Candidate for Senator, Candidate for Representative}`, and `metadata->>'state'` not null (`:250-269`, `:149`):

```ts
function normName(s: string | null): string {                       // :76-79
  if (!s) return "";
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
…
    if (e.fec_candidate_id) { skippedBound++; continue; }            // :161  FIX-1196 bound guard
    if (!e.state_short) continue;
    const fam = roleFamilyOf(e.role_title);
    if (!fam) continue;
    const key = `${normName(e.full_name)}|${e.state_short.toUpperCase()}|${fam}`;   // :165
    const matches = candidateIndex.get(key) ?? [];
    if (matches.length !== 1) continue; // skip ambiguous or no-match                 // :167
```

The key is an **exact** lower-cased full name (no accent folding, no middle-name handling), plus state, plus role family. It needs **exactly one** candidate on that key.

**Table C1. Promotion key per member.** Instrument: SQL mirror of `selectPromotionPairs` (normName = `lower(regexp_replace(btrim(full_name),'\s+',' ','g'))`) · Database: prod · Unit: one elected row · Window: snapshot 2026-10-03.

| # | member | elected key (name part) | stub `normName` | state equal? | family equal? | candidates on elected key | failing condition |
|---|---|---|---|---|---|---:|---|
| 1 | Hinson | `ashley hinson` | `ashley arenholz` | IA = IA | rep = rep | 0 | name: different surname |
| 2 | Barragán | `nanette diaz barragán` | `nanette barragan` | CA = CA | rep = rep | 0 | name: middle name + accent |
| 3 | McClain Delaney | `april mcclain delaney` | `april delaney` | MD = MD | rep = rep | 0 | name: compound surname |
| 4 | García | `jesús g. "chuy" garcía` | `jesus garcia` | IL = IL | rep = rep | 0 | name: accents + initial + nickname |
| 5 | Watson Coleman | `bonnie watson coleman` | `bonnie coleman` | NJ = NJ | rep = rep | 0 | name: compound surname |
| 6 | Velázquez | `nydia m. velázquez` | `nydia velazquez` | NY = NY | rep = rep | 0 | name: initial + accent |
| 7 | Austin Scott | `austin scott` | `james scott` | GA = GA | rep = rep | 0 | name: different first name (legal "James") |
| 8 | Hernández | `pablo jose hernández` | `pablo hernandez rivera` | PR = PR | rep = rep | 0 | name: middle name + accent + second surname |
| 9 | Radewagen | `aumua amata coleman radewagen` | `aumua amata` | AS = AS | rep = rep | 0 | name: FEC filing name lacks "coleman radewagen" |
| 10 | Sánchez | `linda t. sánchez` | `linda sanchez` | CA = CA | rep = rep | 0 | name: initial + accent |
| 11a | Luján S | `ben ray luján` | `ben lujan` | NM = NM | sen = sen | 0 | name: middle name + accent |
| 11b | Luján H | `ben ray luján` | `ben lujan` | NM = NM | sen ≠ rep | 0 | name, and family |
| — | Cisneros | (refused before indexing) | `gilbert cisneros` | CA = CA | rep = rep | 0 | **`fec_candidate_id` = H8CA39174 → `skippedBound`** (and the name differs) |
| — | Self | (refused before indexing) | `keith self` | TX = TX | rep = rep | **1** | **`fec_candidate_id` = H2TX00064 → `skippedBound`**. Without FIX-1196 this would be a lone exact match. |

For all 11 members, the elected row passes every input filter: bioguide present, active, family ok, unbound, state present. The **only** failing component is the name, so `matches.length` is 0 and the `!== 1` branch skips them. None is "ambiguous" (2+ matches). None is "already holds a different current id" (all 11 are unbound).

<details><summary>Query C1</summary>

```sql
WITH e AS (SELECT o.id, o.full_name, o.role_title, o.is_active, o.source_ids->>'congress_gov' AS bioguide,
                  o.source_ids->>'fec_candidate_id' AS fec_candidate_id, upper(j.short_name) AS st,
                  lower(regexp_replace(btrim(o.full_name), '\s+', ' ', 'g')) AS nn,
                  CASE lower(btrim(o.role_title)) WHEN 'senator' THEN 'senator' WHEN 'representative' THEN 'representative' END AS fam
             FROM officials o LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id WHERE o.id IN (… 13 elected ids …)),
     c AS (SELECT o.id, o.full_name, upper(o.metadata->>'state') AS st,
                  lower(regexp_replace(btrim(o.full_name), '\s+', ' ', 'g')) AS nn,
                  CASE lower(btrim(o.role_title)) WHEN 'candidate for senator' THEN 'senator'
                       WHEN 'candidate for representative' THEN 'representative' END AS fam
             FROM officials o WHERE o.tier='candidate' AND o.source_ids->>'fec_candidate_id' IS NOT NULL
              AND o.metadata->>'state' IS NOT NULL)
SELECT e.full_name, e.is_active, e.bioguide IS NOT NULL, e.fec_candidate_id, e.nn||'|'||e.st||'|'||e.fam,
       (SELECT count(*) FROM c WHERE c.fam IS NOT NULL AND c.nn=e.nn AND c.st=e.st AND c.fam=e.fam),
       (SELECT string_agg(c.full_name,'; ') FROM c WHERE c.fam IS NOT NULL AND c.nn=e.nn AND c.st=e.st AND c.fam=e.fam)
  FROM e ORDER BY 1;
-- → key_matches 0 for all except Keith Self (1: 'Keith Self').
```
</details>

---

### (d) Donor-cycle overlap per pair

**The gate's definition.** It is not mechanized in `verifyOwnSeatInDb` or `OWN_SEAT_MANIFEST_SQL`; neither reads an overlap. FIX-1020 names it as "a SECOND, independent gate" and the FIX-953 audit uses it as "§2 decision 4's meaningful donor-cycle overlap signal" (`docs/audits/2026-08-10-fix953-own-seat-manifest.md:95-97`). The mechanized instrument it comes from is the FIX-930/933 classifier (`packages/data/src/scripts/fec-orphan-classify.ts`):

```sql
-- :86-94
ov AS (
  SELECT p.suspect_id, p.twin_id, count(*)::bigint AS shared
  FROM pair p
  JOIN d a ON a.to_id = p.suspect_id
  JOIN d b ON b.to_id = p.twin_id
          AND b.from_id = a.from_id
          AND b.cycle_year IS NOT DISTINCT FROM a.cycle_year
  GROUP BY 1, 2
),
```

(`d` is `relationship_type = 'donation'`, `to_type = 'official'`.)

```ts
// :255-260
return { ...r, rows: n, shared, frac: n > 0 ? shared / n : 0 };   // frac = shared / suspect's own donation rows
// :508-510
const overlapping = e.twin_id !== null &&
  ((e.frac >= boundary.fracCut && e.shared >= boundary.sharedFloor) || contained);
```

`fracCut` and `sharedFloor` are **derived from the data on each run** (`deriveBoundary`, `:348-361`), not constants, so no fixed threshold can be quoted. Below, the stub is the suspect. Both the all-type key FIX-1020 names, `(relationship_type, from_id, cycle_year)`, and the classifier's donation-only key are shown.

**Table D1. Overlap.** Instrument: `financial_relationships` key join, `to_type='official'` both sides · Database: prod · Unit: keys (= rows; the unique index makes `(relationship_type, from_id, to_id, cycle_year)` one row per key) · Window: snapshot about 22:40 UTC 2026-10-03.

| # | member | stub keys | elected keys | shared keys (all types) | % of stub keys | % of elected keys | donation-only shared / stub donation rows (classifier `frac`) |
|---|---|---:|---:|---:|---:|---:|---|
| 1 | Hinson | 6,589 | **0** | 0 | 0.0% | n/a (0 keys) | 0 / 6,571 = 0.0 |
| 2 | Barragán | 1,683 | **0** | 0 | 0.0% | n/a | 0 / 1,682 = 0.0 |
| 3 | McClain Delaney | 1,487 | **0** | 0 | 0.0% | n/a | 0 / 1,477 = 0.0 |
| 4 | García | 1,436 | **0** | 0 | 0.0% | n/a | 0 / 1,434 = 0.0 |
| 5 | Watson Coleman | 1,440 | **0** | 0 | 0.0% | n/a | 0 / 1,440 = 0.0 |
| 6 | Velázquez | 1,264 | **0** | 0 | 0.0% | n/a | 0 / 1,264 = 0.0 |
| 7 | Austin Scott | 1,960 | **0** | 0 | 0.0% | n/a | 0 / 1,958 = 0.0 |
| 8 | Hernández | 1,565 | **0** | 0 | 0.0% | n/a | 0 / 1,565 = 0.0 |
| 9 | Radewagen | 113 | **0** | 0 | 0.0% | n/a | 0 / 112 = 0.0 |
| 10 | Sánchez | 2,055 | **0** | 0 | 0.0% | n/a | 0 / 2,054 = 0.0 |
| 11a | Luján S | 5,494 | **0** | 0 | 0.0% | n/a | 0 / 5,492 = 0.0 |
| 11b | Luján H | 171 | **0** | 0 | 0.0% | n/a | 0 / 171 = 0.0 |
| — | Cisneros | 68 | 2,029 | 21 | 30.9% | 1.0% | 21 / 67 = 0.313 |
| — | Self | 159 | 308 | 67 | 42.1% | 21.8% | 66 / 158 = 0.418 |

**For all 11 members the zero is structural, not a disagreement.** Every one of the 11 elected rows holds **0** `financial_relationships` rows, so there is no key to share. All of each member's FEC money sits on the stub. FIX-1020's Austin Scott reading ("0.0% … his elected row holds $0 across 0 FR rows") holds for **all 11**. Cisneros's elected row has $5,384,248.97 across 2,029 rows; Self's has $556,182.09 across 308 rows.

<details><summary>Queries D1a, D1b</summary>

```sql
-- D1a: FR held by each ELECTED row (scratchpad q14a_elec_fr.sql)
WITH e(n, member, id) AS (VALUES … 13 elected ids …)
SELECT e.n, e.member, fr.to_type, fr.relationship_type::text, count(*), sum(fr.amount_cents),
       min(fr.cycle_year), max(fr.cycle_year), string_agg(DISTINCT fr.metadata->>'source', ',')
  FROM e JOIN financial_relationships fr ON fr.to_id = e.id GROUP BY 1,2,3,4 ORDER BY 1,4;
-- → rows returned ONLY for Cisneros (donation 2,024 / ie_oppose 1 / ie_support 4) and Self (donation 306 / ie_support 2).
--   The 11 members' elected ids return no rows: 0 FR rows each.

-- D1b: shared keys where both sides hold money (scratchpad q14b_shared.sql)
WITH m(n, member, survivor, dup) AS (VALUES (13,'Cisneros',…),(14,'Self',…)),
a AS MATERIALIZED (SELECT m.n, m.member, m.survivor, fr.relationship_type, fr.from_id, fr.cycle_year
                     FROM m JOIN financial_relationships fr ON fr.to_id = m.dup AND fr.to_type = 'official')
SELECT a.n, a.member, count(*) AS stub_keys,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM financial_relationships b
          WHERE b.to_id = a.survivor AND b.to_type='official' AND b.relationship_type = a.relationship_type
            AND b.from_id = a.from_id AND b.cycle_year IS NOT DISTINCT FROM a.cycle_year)) AS shared_keys,
       count(*) FILTER (WHERE a.relationship_type='donation') AS stub_don,
       count(*) FILTER (WHERE a.relationship_type='donation' AND EXISTS (…same, 'donation'…)) AS shared_don
  FROM a GROUP BY 1,2;
-- An earlier single-statement version (CTE over all 27 ids, referenced 6x) hit the session's 115 s
-- wrapper and was narrowed to D1a + D1b; pg_stat_activity showed no surviving backend.
```
</details>

---

### (e) Summary, one row per member

**Table E1.** Instrument: Tables A2–D1 condensed · Database: prod · Unit: one member (Luján's two stubs on one row) · Window: snapshot 2026-10-03.

| member | in stamp? | stub (CAND_ID) | encoded seat vs seat | promotion: name key | own-seat: first refusal · other failing gates | non-money anchors | stub $ (all FR) | elected FR | overlap |
|---|---|---|---|---|---|---|---|---|---|
| Ashley Hinson | yes | `369bd6b6` (H0IA01174) | IA-01 vs IA-2 ✗ | "ashley arenholz" ≠ (surname) | surname · district | none (tags/content stamp only) | $19.91M / 6,589 | 0 | 0 / 6,589 |
| Nanette Diaz Barragán | no (DB-derived) | `499e1266` (H6CA44103) | CA-44 ✓ | "nanette barragan" ≠ (middle + accent) | surname (accent strip) · decision-5 | **2 ER** (littlesis appointment) | $4.56M / 1,683 | 0 | 0 / 1,683 |
| April McClain Delaney | yes | `8ab73c89` (H4MD06340) | MD-06 ✓ | "april delaney" ≠ (compound surname) | surname · decision-5 | **6 ER** (affiliated_with 3, appointment 1, member_of 2) | $4.08M / 1,487 | 0 | 0 / 1,487 |
| Jesús G. "Chuy" García | no (DB-derived) | `71c5b1c0` (H8IL04134) | IL-04 ✓ | "jesus garcia" ≠ (accents + initial + nickname) | surname (accent strip) · decision-5 | **1 ER** (appointment) | $2.91M / 1,436 | 0 | 0 / 1,436 |
| Bonnie Watson Coleman | yes | `eb6e7f4c` (H4NJ12149) | NJ-12 ✓ | "bonnie coleman" ≠ (compound surname) | surname · decision-5 | **5 ER** (2 from member_of; 3 to) | $2.67M / 1,440 | 0 | 0 / 1,440 |
| Nydia M. Velázquez | no (DB-derived) | `cd949887` (H2NY00010) | NY-00 vs NY-7 ✗ | "nydia velazquez" ≠ (initial + accent) | surname (accent strip) · district | none | $2.00M / 1,264 | 0 | 0 / 1,264 |
| Austin Scott | yes | `893a581e` (H0GA08099) | GA-08 ✓ | "james scott" ≠ (legal first name) | **decision-5** (passes surname, seat, district) | **10 ER** (8 appointment + 1 member_of from; 1 affiliated_with to) | $4.02M / 1,960 | 0 | 0 / 1,960 |
| Pablo Jose Hernández | no (DB-derived) | `02942ed7` (H4PR01010) | PR-01 vs PR (0) ✗ | "pablo hernandez rivera" ≠ (middle + accent + 2nd surname) | surname · district | none | $1.97M / 1,565 | 0 | 0 / 1,565 |
| Aumua Amata Coleman Radewagen | yes | `439f33bb` (H4AS00036) | AS-00 ✓ | "aumua amata" ≠ (FEC name) | surname | none | $0.23M / 113 | 0 | 0 / 113 |
| Linda T. Sánchez | no (DB-derived) | `29714b2c` (H2CA39078) | CA-39 vs CA-38 ✗ | "linda sanchez" ≠ (initial + accent) | surname (accent strip) · decision-5 · district | **1 ER** (appointment) | $6.07M / 2,055 | 0 | 0 / 2,055 |
| Ben Ray Luján | yes | `93a6040f` (S0NM00058, current) + `6dc78f88` (H8NM03196, prior) | S·NM ✓; H·NM-03 vs Senator ✗ | "ben lujan" ≠ (middle + accent); H stub also family ≠ | surname (accent strip) · H stub also office/district | none in ER; **44 stale `vote_*` EC edges** on the S stub (its `votes` = 0) | $10.13M / 5,494 + $0.62M / 171 | 0 | 0 / 5,665 |
| *Gilbert Ray Cisneros (13 rows, not one of the 11)* | yes | `a1766a0b` (H4CA31170) | CA-31 ✓ | refused before indexing (bound H8CA39174) | survivor holds a DIFFERENT id | none | $0.21M / 68 | 2,029 rows | 21 / 68 (30.9%) |
| *Keith Self (inferred 13th row)* | no (inferred) | `60de154b` (H2TX03290) | TX-03 ✓ | refused before indexing (bound H2TX00064); 1 exact name match | survivor holds a DIFFERENT id | none | $0.39M / 159 | 308 rows | 67 / 159 (42.1%) |

**Class counts over the 11 members:**

- **Legal-name class** (stub name ≠ elected display name under the promotion's `normName`): **11 / 11**. By kind:
  - 7 differ only by accents, middle names/initials or a compound-surname token, with first and last tokens equal after accent folding: Barragán, García, Sánchez, Velázquez, Luján, McClain Delaney, Watson Coleman.
  - 3 have a different surname string: Hinson (Arenholz), Radewagen (Amata), Hernández (Hernandez Rivera).
  - 1 has a different first name: Austin Scott (James).
- **Anchor non-money rows** (decision-5's list, i.e. `external_relationships`): **6 / 11**. Barragán 2, McClain Delaney 6, García 1, Watson Coleman 5, Austin Scott 10, Sánchez 1, **25 rows total**. All are LittleSis, and these are the six `primary_source='littlesis'` stubs.
  - Outside decision-5's list, Luján's S stub carries 44 `vote_yes`/`vote_no` EC edges with 0 underlying votes.
  - All 12 stubs carry rule-generated `entity_tags` (2–4 each) and 1 `official_content_ids` stamp.
  - 0 votes, 0 committee memberships, **0 `entity_grants` (no stub is claimed)**, 0 follows.
- **Fail the own-seat test.** Encoded seat (office + state + district of the member's current id) ≠ member's seat for **4 / 11**: Hinson, Velázquez, Hernández, Sánchez. Luján's current S id passes; his prior H id fails on office. The full `verifyOwnSeatInDb` refuses **11 / 11**:
  - 10 at the surname gate first. Of those, 5 fail only because accents are stripped (Barragán, García, Velázquez, Sánchez, Luján) and 5 have a different surname string (Hinson, McClain Delaney, Watson Coleman, Radewagen, Hernández).
  - 1 (Austin Scott) at decision-5.
  - `OWN_SEAT_MANIFEST_SQL` would select only Austin Scott (surname join).
- **Fail the overlap gate: 11 / 11.** Every one has 0 shared keys, because all 11 elected rows hold 0 FR rows.

**Commands denied or prompted:** none.
- The first anchor census (untyped probes) exceeded 2 minutes and was stopped with TaskStop.
- One overlap query hit the 115 s client wrapper.
- `pg_stat_activity` showed no surviving prod backend after either. Both were narrowed, not re-run with a larger timeout.

---

## 8. FIX-1204 — the two entities Craig asked about

**Instrument:** direct reads of `financial_entities`, `entity_tags`,
`external_source_refs`, `franklin_seed_map`, `financial_relationships`,
`financial_entity_industry_overrides` · **database:** prod · **unit:** rows,
cents · **window:** read 2026-10-03 ~23:44 UTC.

**Both are fictional.** Each row carries `is_synthetic = true`, a `seed_key` in
its `metadata`, and a `franklin_seed_map` row from 2026-06-19 09:41 — they are
part of the Franklin demo state seeded by `data:seed:franklin`, not FEC or
LittleSis records. Neither has an `external_source_refs` row, an FEC committee
id, or a `primary_source`. Every official they pay is a synthetic Franklin
"Delegate". FIX-1204's 2026-09-20 measurement selected `fec_committee_id IS
NULL AND total_donated_cents > 0 AND industry-tagged` without excluding
`is_synthetic`, which is how they joined the list.

**Ridge Coal Legacy Trust** (`a222d616-0487-48ac-af68-0ec7eca301ba`) —
`entity_type = 'other'`; metadata `{"note": "Legacy coal money.", "officer":
null, "seed_key": "donor-ridge-coal"}`. It gave **$265,000** in cycle 2026,
all dated 2026-03-01: **$250,000 to Cumberland Energy Action Fund** (the other
entity here) and **$15,000 to Delegate Eli Tipton**. It received nothing. Its
`oil_gas` tag is a **rule** tag (`generated_by = 'rule'`, confidence 0.80,
`metadata {"matched_count": 1}`, re-created 2026-10-03 22:30 by the nightly
rule tagger) — a keyword match on the name. Read plainly it is **coal money**;
if it were real, the vocabulary's `mining` key would describe it better than
`oil_gas`.

**Cumberland Energy Action Fund** (`8a1e3c6f-03b1-46d0-9f61-42693de6f154`) —
`entity_type = 'pac'`; metadata `{"note": "The anti-Ridgeline money. Chaired by
Gov. Aldridge's estranged brother.", "officer": "Dell Aldridge", "seed_key":
"pac-cumberland"}`. It gave **$135,000** (cycle 2026, 2026-03-01) to three
synthetic Delegates — Theo Crane $52,000, Harlan Boyd $45,000, Eli Tipton
$38,000 — and **received $430,000**: $250,000 from Ridge Coal Legacy Trust and
$180,000 from Blackwater Holdings LLC (also synthetic). Its `oil_gas` tag is an
**AI** tag (confidence 0.85, `ai_model` NULL) whose stored reasoning is: *"The
name 'Cumberland Energy Action Fund' indicates a focus on energy sector
activities, most likely representing oil and gas industry interests."* — an
inference from the word "Energy", nothing more.

Both also carry rule tags `large_donation` (size) and `pre_vote_timing`
(internal). No `financial_entity_industry_overrides` row exists for either.

**The vocabulary CHECK** (`financial_entity_industry_overrides_industry_vocab`,
prod) — **16 keys**: `health`, `oil_gas`, `finance`, `tech`, `defense`,
`real_estate`, `labor`, `agriculture`, `legal`, `retail`, `transportation`,
`lobby`, `utilities`, `manufacturing`, `mining`, `media` (or NULL). The sibling
`…_key_shape` CHECK requires `fec_committee_id = 'fe:' || financial_entity_id`
whenever `financial_entity_id` is set.

**For Craig's decision:** these two are not oil-and-gas escapees from real
data; they are demo characters. The options are (a) leave them out of the
FIX-1204 TSV (synthetic rows are already excluded from platform-wide totals by
the SF-P1 seam), or (b) curate them for the demo's internal consistency — in
which case Ridge Coal reads as `mining`, and Cumberland's "Energy" is the
author's intent for the story, which the seed note (anti-Ridgeline money)
frames as the opposing side of a coal fight, not as oil and gas.

<details><summary>Queries (§8)</summary>

```sql
SELECT * FROM public.financial_entities WHERE id IN ('a222d616-0487-48ac-af68-0ec7eca301ba','8a1e3c6f-03b1-46d0-9f61-42693de6f154');
SELECT entity_id, tag, tag_category, generated_by, confidence, ai_model, metadata, visibility, created_at
FROM public.entity_tags WHERE entity_id IN (…);
SELECT * FROM public.external_source_refs WHERE entity_id IN (…);                             -- 0 rows
SELECT * FROM public.franklin_seed_map WHERE row_id::text IN (…) OR seed_key IN ('pac-cumberland','donor-ridge-coal');
SELECT fr.from_id, fr.relationship_type, fr.to_type, fr.to_id, o.full_name, o.role_title, o.is_synthetic, fr.cycle_year, fr.amount_cents, fr.occurred_at
FROM public.financial_relationships fr LEFT JOIN public.officials o ON o.id = fr.to_id AND fr.to_type = 'official'
WHERE fr.from_id IN (…);
SELECT fr.to_id, fr.relationship_type, fr.from_id, fe.display_name, fe.is_synthetic, fr.cycle_year, fr.amount_cents
FROM public.financial_relationships fr LEFT JOIN public.financial_entities fe ON fe.id = fr.from_id WHERE fr.to_id IN (…);
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.financial_entity_industry_overrides'::regclass;
SELECT * FROM public.financial_entity_industry_overrides WHERE fec_committee_id IN ('fe:a222d616-…','fe:8a1e3c6f-…');   -- 0 rows
```
</details>
