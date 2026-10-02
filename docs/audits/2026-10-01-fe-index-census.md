# `financial_entities` index census — 2026-10-01 (cc-175, FIX-1012)

**Stats window: 16.4 days — 2026-09-15 15:09:48 UTC (the crash) → 2026-10-02 00:22:57 UTC.**
**Verdict: DROP four indexes, 204,439,552 bytes (195.0 MiB). KEEP the other fifteen.**

Every figure names its instrument and its database. Prod reads went through
`scripts/db-query.mjs --prod`, which wraps the SQL in `SET TRANSACTION READ ONLY`.
Plans are from the local prod clone (3.69M `financial_entities` rows) through
psql, with the candidate drops inside `BEGIN … ROLLBACK` (they never committed).
The order is the rule-26 order: **role, then callers, then counters**.

---

## 1. The window, proven three ways

The counters are only evidence when read against their epoch.

| read (prod, 2026-10-02 00:22–00:45 UTC) | value | what it shows |
|---|---|---|
| `pg_stat_database.stats_reset` | **NULL** | Nothing on its own. |
| `pg_postmaster_start_time()` | 2026-09-22 22:32:13 | The last restart. It is **not** the epoch (next row). |
| `min(last_idx_scan)` over all 19 FE indexes | 2026-09-18 03:55:00 | Earlier than the restart. The counters **survived** the 09-22 fast shutdown (rule 166; the fix1178c proof). |
| `pg_stat_statements_info.stats_reset` | 2026-09-22 22:32:13 | pgss **was** reset at the restart. So pgss call counts below cover 9.1 days, not 16.4. |
| `data_sync_log`: `n_tup_ins` vs rows by `created_at` (`n_tup_del` = 0) | **3,238** = 3,238 rows since 09-15 15:09:48; 1,773 since 09-22 | The insert-only table's counter matches the crash exactly. The epoch is the **2026-09-15 15:09:48** crash (cc-145, cc-169). |

### What 16.4 days covers

| reader | cadence | ran inside the window? | evidence (prod) |
|---|---|---|---|
| LittleSis hop-1 resolver (`littlesis/writer.ts:174-178`, direct-pg) | weekly, Saturday nightly | **yes**: 09-19 22:46, 09-26 21:09 | `data_sync_log` `littlesis` complete ×2. pgss `SELECT public.resolve_entity_by_canonical($1, $2, $3)`: **20 calls**, mean 999.75 ms (since 09-22). `financial_entities_canonical_trgm` `last_idx_scan` 09-26 21:35:44 falls inside the 09-26 run. |
| EDGAR corporation resolver (`edgar/companies.ts:132-149`, PostgREST rpc) | runs in the nightly; called only for an **unbound CIK** (`:280-282`) | **pipeline yes, reader no** | `edgar` complete 09-19 and 09-26 (951 / 957 rows). `edgar_daily` skipped every night (`no_filings`). pgss has **0** PostgREST-shaped resolver calls since 09-22. Neither btree has a scan at all since 09-15. |
| IRS 990 resolver + grant name-only path (`irs990/writer.ts:125-128`, `:368-374`) | `0 15 * * 1` | **no** | `irs990` complete 09-21 and 09-28, **0 rows** each. GHA logs: "New filings to ingest: 5 … 5 filings not found in any ZIP archive". |
| Sweep C of `reconcile_financial_entity_totals()` (jobid 14 `0 12 1 * *`) | monthly | **yes**: 2026-10-01 12:00:00–12:02:35 | `recipient_count_orphans_zeroed: 19`. `financial_entities_received_positive` got its one scan at 12:02:35 (the received sweep). `recipient_count_idx` stayed **0**. |
| `financial_entity_recipient_count_window()` pass 2 (fe-crawl bootstrap, `20260911000200:1431-1433`) | `*/30` | yes (fe-crawl 734 complete + 4 partial) | Plan is pkey in both cases (§3). |
| Chord MV donor-state CTE (FIX-1030) | jobid 10, weekly | not needed | Plan is a Seq Scan in both cases (§3). |
| Browse / typeahead `ilike '%q%'` on `canonical_name` | request path | yes | trgm GIN `idx_scan` 48. |

**The argument.** A reader that ran inside the window while an index stayed at
0 was never served by that index, so dropping it cannot regress that reader. A
reader that did not run gives no evidence either way; for those, §3's plans
decide. An index with `idx_scan > 0` is KEPT, whatever the bullet said.

---

## 2. All nineteen indexes

Prod, 2026-10-02 00:22:57 UTC. "Constraint" = a `pg_constraint` row whose `conindid` is the index.

| index | definition (abridged) | bytes | idx_scan | last_idx_scan | role | verdict |
|---|---|---:|---:|---|---|---|
| `financial_entities_pkey` | UNIQUE (id) | 243,384,320 | 20,442,749 | 10-02 00:20 | PK; FK target ×5 (edgar ×3, `parent_entity_id`, irs990) | **KEEP** (constraint) |
| `financial_entities_donor_fingerprint_unique` | UNIQUE (donor_fingerprint) | 291,823,616 | 2,828,836 | 09-27 22:28 | donor upsert `ON CONFLICT (donor_fingerprint)` arbiter | **KEEP** (arbiter) |
| `financial_entities_fec_committee_id_key` | UNIQUE (fec_committee_id) | 61,194,240 | 84,342 | 10-01 21:09 | UNIQUE constraint; `ON CONFLICT (fec_committee_id)` arbiter (pgss) | **KEEP** (constraint) |
| `financial_entities_donated_positive` | (id) WHERE total_donated_cents > 0 | 197,869,568 | 43,316 | 09-20 19:58 | donor rollups | **KEEP** (scanned; out of scope) |
| `financial_entities_donor_fingerprint_pattern` | (donor_fingerprint text_pattern_ops) | 311,451,648 | 2,530 | 09-26 21:42 | prefix match on fingerprints | **KEEP** (scanned) |
| `financial_entities_display_trgm` | GIN (display_name trgm) WHERE type <> individual | 55,353,344 | 1,349 | 10-02 00:01 | typeahead / browse | **KEEP** (scanned) |
| `financial_entities_is_synthetic_idx` | (id) WHERE is_synthetic | 16,384 | 381 | 10-01 21:15 | SF-P1 quarantine | **KEEP** (scanned) |
| `financial_entities_nonindividual_id` | (id) INCLUDE (display_name, entity_type) WHERE type <> individual | 34,996,224 | 207 | 10-01 21:10 | non-individual scans | **KEEP** (scanned) |
| `financial_entities_canonical_trgm` | GIN (canonical_name trgm), all rows | 326,213,632 | 48 | 09-26 21:35 | every `ilike` reader **and every exact `canonical_name =` lookup** (pg_trgm 1.6, §3) | **KEEP** (scanned; it is what serves the resolver) |
| `financial_entities_type` | (entity_type) | 82,952,192 | 39 | 10-01 03:53 | — | **KEEP** (scanned) |
| `financial_entities_total_donated_nonindividual` | (total_donated_cents DESC) WHERE type <> individual | 8,421,376 | 19 | 10-01 06:06 | top-donor lists | **KEEP** (scanned) |
| `financial_entities_primary_source_idx` | (primary_source) | 74,907,648 | 3 | 09-18 03:55 | — | **KEEP** (scanned; 71 MB for 3 scans is a question for a later census, not this one) |
| `financial_entities_received_positive` | (id) WHERE total_received_cents > 0 | 581,632 | 1 | 10-01 12:02:35 | jobid 14's received sweep | **KEEP** (scanned) |
| `financial_entities_parent` | (parent_entity_id) WHERE NOT NULL | 8,192 | 0 | — | referencing side of `financial_entities_parent_entity_id_fkey` (an RI check on delete; FE `n_tup_del` = 0 in the window) | **KEEP** (FK support; 8 kB, nothing to win) |
| `financial_entities_entity_cluster` | (entity_cluster_id) WHERE NOT NULL | 8,192 | 0 | — | empty partial | **KEEP** (8 kB, nothing to win; outside the bullet) |
| `financial_entities_canonical` | (canonical_name) WHERE type <> individual | **16,146,432** | **0** | — | partial search support (FIX-195) | **DROP** |
| `financial_entities_canonical_name_type` | (canonical_name, entity_type) WHERE type <> individual | **19,914,752** | **0** | — | partial search support (FIX-195) | **DROP** |
| `financial_entities_individual_state_idx` | ((metadata->>'state')) WHERE type = individual | **77,611,008** | **0** | — | none usable (§3) | **DROP** |
| `financial_entities_recipient_count_idx` | (recipient_count) WHERE type = individual | **90,767,360** | **0** | — | intended for Sweep C (FIX-736); never the plan (§3) | **DROP** |

None of the four DROP indexes is UNIQUE, backs a constraint, or arbitrates an
`ON CONFLICT`. No later migration drops or depends on any of them. The bullet's
fifth index, `donated_positive`, is no longer a candidate (43,316 scans).

---

## 3. The plans, with and without (local clone, 2026-10-02 00:26:40 UTC)

`max_parallel_workers_per_gather = 0`. "Generic" = `PREPARE …; SET
plan_cache_mode = force_generic_plan; EXPLAIN EXECUTE`, the plan plpgsql settles
on. The "without" column is the same statement after `DROP INDEX` of all four
inside one `BEGIN … ROLLBACK`.

| shape | with the four | without the four |
|---|---|---|
| S1 Sweep C `UPDATE … WHERE type = individual AND recipient_count > 0 AND NOT EXISTS (FR)` | **Seq Scan** on FE (2.63M rows est.), Hash Right Anti Join vs FR | identical |
| S1b Sweep C as `SELECT count(*)` | Seq Scan on FE; FR side Index Only Scan `donation_size_rollup` | identical |
| S2 pass 2, custom (1/16 id window) | Bitmap Index Scan **pkey** | identical |
| S2g pass 2, generic | Bitmap Index Scan **pkey** (`id >= $1`) | identical |
| S3 resolver, individual branch, custom (`p_state` NULL) | Bitmap on **canonical_trgm**, 94.9 ms cold | identical, 4.96 ms warm |
| S3g same, generic | canonical_trgm, 4.92 ms | identical, 4.85 ms |
| S3s individual branch WITH a state (no caller passes one) | canonical_trgm; state is a Filter | identical |
| S4 resolver, NULL-type branch, custom | canonical_trgm, 223.6 ms cold | identical, 14.8 ms |
| S4g same, generic | canonical_trgm, 15.1 ms | identical, 14.9 ms |
| **S5 resolver ELSE branch, custom** (`entity_type = 'corporation'`) | **Index Scan `canonical_name_type`, 0.80 ms** | Bitmap on canonical_trgm, **8.86 ms** |
| S5g same, generic | canonical_trgm, 72.8 ms cold | canonical_trgm, 8.48 ms |
| **S6 irs990 name-only, custom** (`= ANY('{nonprofit,other}')`) | **Index Scan `canonical`, 0.78 ms** | Bitmap on canonical_trgm, **14.8 ms** |
| S6g same, generic (PostgREST array param) | canonical_trgm, 14.7 ms | identical, 14.6 ms |
| S7 browse individual `ilike '%andoni%'` | canonical_trgm, 5.3 ms | identical, 3.3 ms |
| S8 chord MV donor-state CTE `length(metadata->>'state') = 2` | **Seq Scan** (FIX-1030's fence) | identical |
| S8b chord MV, whole definition | HashAggregate over the fenced CTE | identical |

What it says, per index:

- **`recipient_count_idx`**: never the plan. `recipient_count > 0` is not
  selective: 2.63M of 3.69M rows on the clone. Sweep C seq-scans with the index
  present, which is what prod's counter shows: it ran on 10-01 and zeroed 19
  rows, and the index stayed at 0. **The FIX-736 comment
  (`20260911000200:2486-2490`, and its copies in `20260705000000:316` and
  `20260902100000:583`) that says Sweep C is "driven by
  financial_entities_recipient_count_idx" was wrong when written.** Pass 2 is
  pkey both ways. No TS reader filters or orders on `recipient_count`.
- **`individual_state_idx`**: no usable reader. The one equality predicate is
  the resolver's `(p_state IS NULL OR metadata->>'state' = p_state)`, and all
  three callers pass NULL (`littlesis/writer.ts:177`, `irs990/writer.ts:127`,
  `edgar/companies.ts:140`). Even with a literal state the planner takes the
  canonical_name trgm and filters (S3s). Every other `metadata->>'state'` on FE
  is a projection or a GROUP BY (`donor_rollup_rebuild_bulk`,
  `refresh_treemap_individuals_global`, `treemap_individuals_rebuild_officials`,
  `rebuild_entity_search_index`). There is also the chord function's per-official
  arm (FE reached by pkey join, no `entity_type` predicate) and the chord MV's
  fenced Seq Scan, unchanged (S8). FIX-1034's `fe_state_len_stats` and
  `fe_state_value_stats` exist on prod with data, so the planner keeps its view
  of the expression without the index. The script refuses this index if they are
  absent.
- **`canonical_name_type` and `canonical`**: the resolver's individual and
  NULL-type branches cannot use them (excluded by, or not implied by, the
  partial predicate). The LittleSis resolver ran 20 times inside the window and
  both stayed at 0. Only two **custom** shapes use them: the EDGAR ELSE branch
  (S5) and the IRS 990 name-only path (S6). Neither reader ran inside the window.
  Without the btrees both go to the trgm GIN, **not to a Seq Scan**: about 10×
  slower per call warm on the clone (0.8 → 8.9 ms; 0.8 → 14.8 ms). On prod a
  cold trgm equality probe is about 1 s (the LittleSis resolver's pgss mean).
  So a wakened EDGAR run pays ~1–2 s per unbound CIK (two calls each). D1's
  condition was "does not go Seq Scan without them", and it holds. **What
  serves exact `canonical_name =` for every generic plan, with or without the
  partial btrees, is `financial_entities_canonical_trgm` (pg_trgm 1.6 on prod
  and clone).**

---

## 4. The table these drops act on (prod, 2026-10-02 00:27:26 UTC)

| | value |
|---|---|
| `n_live_tup` | 5,226,617 |
| `n_tup_upd` / `n_tup_hot_upd` since the epoch | 394,676 / 18,630 = **4.7 % HOT, 95.3 % non-HOT** (the bullet's 08-09 baseline said ~73 % non-HOT) |
| `n_dead_tup` | 38 (`fe-vacuum-analyze` 10-01 04:50; `autovacuum_count` 0, `vacuum_count` 19) |
| reloptions | `autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.02` |
| heap / all indexes | 1,919 MB / 1,806 MB (1,894,088,704 bytes; 19 indexes) |
| expected after the four drops | 15 indexes, 1,689,182,208 bytes (≈ 1,611 MB at the dry-run reading of 1,893,621,760) |

**What the drop can and cannot do for HOT.** It removes `recipient_count` and
`metadata` from the table's indexed-column set. An update that changes only
those, such as pass 1's `SET recipient_count` or a metadata-only donor upsert,
becomes HOT-eligible if its page has room. An update that changes
`total_donated_cents` or `total_received_cents` stays non-HOT: those columns
remain in `donated_positive`, `received_positive` and
`total_donated_nonindividual`. The update volume is also not the bullet's
840,338 per cycle: 394,676 updates over 16.4 days. The HOT ratio after the drop
is a receipt (owed), not a prediction.

---

## 5. The DROP list (rule 42: this list IS `scripts/fix1012-drop-fe-indexes.mjs`'s `TARGETS[]`)

Smallest first, one gated `DROP INDEX CONCURRENTLY` per invocation:

1. `financial_entities_canonical` — 16,146,432 bytes
2. `financial_entities_canonical_name_type` — 19,914,752 bytes
3. `financial_entities_individual_state_idx` — 77,611,008 bytes
4. `financial_entities_recipient_count_idx` — 90,767,360 bytes

Total **204,439,552 bytes (195.0 MiB)**. The twin migration
`20261002000000_fix1012_drop_unscanned_fe_indexes.sql` carries the same four as
`DROP INDEX IF EXISTS`. Recreate DDL, should one ever be wanted back:

```sql
CREATE INDEX financial_entities_canonical ON public.financial_entities USING btree (canonical_name) WHERE (entity_type <> 'individual'::text);
CREATE INDEX financial_entities_canonical_name_type ON public.financial_entities USING btree (canonical_name, entity_type) WHERE (entity_type <> 'individual'::text);
CREATE INDEX financial_entities_individual_state_idx ON public.financial_entities USING btree (((metadata ->> 'state'::text))) WHERE (entity_type = 'individual'::text);
CREATE INDEX financial_entities_recipient_count_idx ON public.financial_entities USING btree (recipient_count) WHERE (entity_type = 'individual'::text);
```

## 6. What would reverse a verdict

- A wakened EDGAR or IRS 990 run that measurably slows on the resolver. Watch
  the `edgar` / `irs990` wall in `data_sync_log`, and "resolve_entity_by_canonical
  failed" lines (the PostgREST role cap is 8 s; the cold trgm probe is ~1 s).
  The remedy is a non-partial btree on `canonical_name`, or the ELSE branch
  reading `entity_type <> 'individual'` explicitly. It is not these two partial
  indexes back.
- Any later reader that filters FE on `recipient_count` or `metadata->>'state'`
  with `entity_type = 'individual'`. None exists in the tree or in prod's
  `pg_proc` / `pg_matviews` / `pg_views` at this reading.
