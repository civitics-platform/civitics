# FIX-1217 — the whale donor page: index vs rollup, measured (cc-158)

**Window:** 2026-09-25 23:38 UTC → 2026-09-26 00:18 UTC. **Posture:** prod was read-only.
- **Plans on prod:** `EXPLAIN` without ANALYZE.
- **Timed SELECTs on prod:** three, of the option-C aggregate (§4.3). These were plain reads, not `EXPLAIN ANALYZE`.
- **Clone:** every scratch index and table was built and dropped there. The clone's relation inventory hash is identical before and after (§6).
- **Numbers:** in `2026-09-25-fix1217-whale-donor-page.json`.

**Instruments** (every figure below names one):
- **prod** = `node scripts/db-query.mjs --prod`. That is the session pooler, role `postgres`, and `SET LOCAL ROLE anon` where stated.
- **clone** = `db-query --local`, `EXPLAIN (ANALYZE, BUFFERS)`, with prod's planner GUCs:
  - `random_page_cost 1.1`, `effective_io_concurrency 200`, `effective_cache_size 768MB`, `max_parallel_workers_per_gather 1`, `jit off`;
  - `work_mem 4MB`, which is an **assumption** for anon, because `pg_file_settings` is permission-denied on prod;
  - `SET ROLE anon`.
- **cold** = the DB container was stopped, the Docker VM page cache dropped (`echo 3 > /proc/sys/vm/drop_caches`, buff/cache 6,139 → ~560 MB), and the container started again.
- **census** = `data:census:cancellations:prod` (Logs API).

## 0. The answer

**Recommendation: partial-A (spending) + B (an FE inbound rollup).** Serve the page's `inbound` and `donor-count` reads from B. Delete the 1000-row sample. Keep `spending` on the partial index.

**The bullet's index (A) is rejected.** As anon the planner takes it, but it **cannot use its order**, for this reason:
- `relationship_type` is an enum.
- `enum_eq` is not leakproof, on prod and on the clone.
- Under RLS, a non-leakproof equality never becomes an equivalence-class constant.

So `(to_type, to_id, relationship_type, amount_cents DESC)` cannot satisfy `ORDER BY amount_cents DESC LIMIT n`. The whale read becomes a full range scan plus a sort:
- RNC `inbound`, cold, on the clone: **5,634 ms, against 1,501 ms before**.
- The contractor whale's `spending`: **15,296 ms**.

A partial index carries the enum in its **predicate**, not its key, and that does work. Both partials flip to `Limit ← Index Scan` with no Sort.

The correctness finding decides the rest. On the clone, the page's top-50 is wrong for **94 of the 328 recipients with more than 1,000 inbound donation rows**:
- 19 of the 167 in the 1k–2k band;
- the RNC: 6 of the true top 50 missing, 16 of 50 at the right rank.

The "Donors" stat is wrong for **all 328**. The RNC shows 837 against 125,567. Only B, or a live aggregate, fixes that. The live aggregate (option C, no DDL) was **timed on prod and cancelled at 3,026 ms** for the RNC, cold.

## 1. Phase 0 reads

### Read 1 — state

- **Session and CI:**
  - `session:check`: 58 open. The prompt expected 57–58.
  - `tests.yml`: the last `main` run, 36199643878, was success at 23:06:03 UTC.
  - `.env.local` points at local (`127.0.0.1:54321`).
- **FIX status:**
  - FIX-675 closed 2026-06-27; FIX-704 closed 2026-07-03; FIX-775 closed 2026-07-08.
  - FIX-1178 and FIX-1217 are OPEN.
- **Clone freshness:** the clone's FR `max(updated_at)` is 2026-09-03 01:34:43. Prod's is 2026-09-21 00:18:25.83, read at 00:14:50 UTC, so the clone is **17.9 days** behind.
- **The clone is also structurally smaller:**
  - 10,410,330 rows against prod's 14,457,904 (reltuples), a ratio of **1.389**.
  - Only 296,171 prod rows carry a last write after 09-03.
  - Its whales are about half-size: the RNC has 151,406 inbound donation rows on the clone against **337,058 on prod**, ×2.23.

  Every clone wall below is for a smaller whale than prod's.

### Read 2 — FR on prod, 23:38:51 UTC

| measure | value |
|---|---|
| reltuples / relpages | 14,457,904 / 631,265 (22.9 tuples/page) |
| heap (`pg_relation_size`) | 5,171,322,880 B (4,932 MB) |
| all-visible | 630,719 / 631,265 = **99.91 %** |
| n_dead_tup | 884 |
| last_vacuum / last_analyze | 03:00:00.955 / 03:00:10.328 |
| `fr-vacuum-analyze` (jobid 38) walls, last 3 days | 10.3 / 9.8 / 9.9 s (14-day mean 87.6 s, from `prod_op_gate`) |
| n_tup_hot_upd | 0 (zero-HOT, as expected) |
| indexes | **18**, 7,575,740,416 B total |

- **Bloat instrument:** `pg_stats` `sum(avg_width)` = 410. That would imply about 786k ideal pages, **more** than the 631k actual, so the width estimate over-counts (compressed `metadata`). With 884 dead tuples and 99.91 % all-visible, there is no bloat signal.
- **Indexes** (the migrations name seven; prod has eighteen). The ones that matter here, by `pg_relation_size`:
  - `derivation` (relationship_type, from_type, from_id, to_type, to_id): 1,162 MB.
  - `donor_rollup_idx` (to_id, relationship_type, from_id) INCLUDE (amount_cents), with partial predicate `relationship_type IN (donation, ie_*) AND from_type='financial_entity'`: 972 MB.
  - `_to` (to_type, to_id): 209 MB.
  - `_type` (relationship_type): 159 MB.
  - `contract_grant_updated_at` (updated_at), partial on contract/grant: 27 MB.
  - The full list is in the JSON.
- **RLS:** `financial_relationships_select` is `TO anon, authenticated USING (true)`.
- **Timeouts:** anon 3 s; authenticated and authenticator 8 s.

### Read 3 — the three queries, "before"

The SQL is the PostgREST text from cc-151 read 5: `WITH pgrst_source AS (…) SELECT … json_agg …`, with the count's `pgrst_source_count` CTE and `LIMIT 1000` (Supabase `max_rows`). It ran as anon.

- **RNC:** `421c9ec5-c476-4ab4-94b6-9a836aeba88d`.
- **Ordinary FE:** `0e988eec-8b72-488b-8406-62d3ab7c98c4`, with 126 inbound donations on prod and 102 on the clone.
- **Added:** AMERISOURCEBERGEN DRUG CORP `01ffa686…`. It is the largest contract recipient and has zero donations.

**Prod, `EXPLAIN` only, 23:45:49 UTC:**
- **RNC `inbound`:** `Limit ← Sort ← Bitmap Heap Scan ← BitmapAnd(_to est 168,038, _type est 2,891,581)`, estimated at 33,608 rows (337,058 actual).
- **RNC `spending`:** the same shape, ANDed with `contract_grant_updated_at` (est 5,783,162).
- **RNC `donor-count`:** an InitPlan count over the same BitmapAnd, plus `Limit 1000 ← Index Only Scan derivation`.
- **Ordinary FE:** all three are a plain `Index Scan _to` with a relationship_type Filter.

The BitmapAnd means every whale render also reads the **whole donation range of `_type`**.

**Clone, `EXPLAIN (ANALYZE, BUFFERS)`:**

| read | cold ms | warm ms | buffers | plan |
|---|---|---|---|---|
| RNC inbound | 1,501.1 | 351.6 | 27,743 | BitmapAnd(_to 151,406 rows, _type 6,575,042 entries) → heap 22,072 blocks → top-N sort |
| RNC spending (0 rows) | 189.5 | 159.1 | 15,557 | BitmapAnd(_to, contract_grant_updated_at 3,822,744 entries) |
| RNC donor-count | 408.4 | 287.9 | 29,141 | InitPlan BitmapAnd + derivation index-only |
| ORD inbound / spending / count | 14.4 / 0.09 / 0.11 | 0.74 / 0.10 / 0.11 | 66 / 66 / 132 | Index Scan `_to` |
| AMB inbound (0 rows) | 1,769.9 | 609.0 | 87,477 | BitmapAnd |
| AMB spending | 810.0 | 665.4 | 98,641 | Bitmap Heap 246,005 rows → sort |
| **AMB donor-count (0 rows)** | **14,386.7** | 1,074.2 | **166,916** | Index Only Scan `derivation` over the entire donation range, 0 matches |

### Read 4 — the whale class (rule 123: asked on the dimension the query reads)

**Prod, inbound donations to FE.** 23:41:08–23:42:50 UTC, **101.6 s**, parallel index-only scan on `derivation`, gated by `prod_op_gate(120)` ok at 23:41:00.

| recipients | rows | max | > 1k | > 10k | > 50k | rows in > 1k | p50 | p99 |
|---|---|---|---|---|---|---|---|---|
| 9,656 | 4,023,127 | 337,058 (RNC) | **497** | **41** | **11** | 3,212,386 | 22 | 5,057 |

- **The 41 over 10k:** 10 party committees (RNC 337,058, DNC 259,440, DSCC 199,241, DCCC 158,193, NRSC 126,536, NRCC 93,507, and others), 2 super PACs (SMP 63,307, Forward Blue) and 29 PACs (ActBlue, EMILYs List, Fair Fight, NAR PAC, Lincoln Project, and others). Ids and counts are in the JSON.
- **Prod, inbound of ANY type to FE.** This is the dimension today's `(to_type, to_id)` plans actually read. 23:44:57–23:45:10, **13.2 s**, index-only scan on `_to`.

  | recipients | rows | max | > 1k | > 10k | > 50k | > 100k |
  |---|---|---|---|---|---|---|
  | 138,711 | 7,932,083 | 337,058 | **828** | **94** | 22 | 10 |

- **The spending class** (clone; prod's contract+grant is 3,908,956 by subtraction, ×1.02 of the clone):
  - 127,728 recipients, 3,822,744 rows, max **246,005** (AmerisourceBergen);
  - 327 over 1k, 53 over 10k, 11 over 50k.
  - These are **contractors, not committees**. Their donation reads are expensive too, because the planner scans their whole `(to_type, to_id)` range (AMB above).
- **The from-side mirror** (`outbound`, clone): 2,819,195 donors, max **2,279** rows, 75 over 1k, **0 over 10k**. The whale shape is not there. It was left alone (out of scope).
- **The census, a third reading (rule 24):** FR 57014s in 24-hour windows went **34 → 0 → 6**:
  - cc-151, to 09-24 00:42;
  - cc-155, to 09-25 02:17;
  - this run, to 09-26 00:12:18 (43 total; enrichment_queue 23).

  `--like` cannot isolate the donor-page texts, because every FR select list names `to_type`. So the 6 are FR by table, not proven donor-page reads.

### Read 5 — the rollup's size (clone)

| measure | value |
|---|---|
| distinct (recipient, donor) donation pairs | 1,949,253 |
| rows under a 200 cap | **441,378** (1,043 recipients over the cap) |
| under a 50 / 1000 cap | 202,387 / 828,185 |
| `official_donor_rollup_mv` | clone 576,303 rows; **prod reltuples 656,050, heap 256 MB** |

- The prompt's reference figure of 2,972,870 is not what prod holds today.
- The prod projection for a 200 cap is **~0.50–0.75 M rows**. That scales by recipients (×1.14) or by inbound rows (×1.70). The hard upper bound is 9,656 × 200 = 1,931,200.
- Prod RNC distinct donors = **283,715**. That comes from §4.3's timed read.
- **The top-200 trap** (reference_official_donor_aggregates): the odr_mv's rank-201 tail is type-blind. B holds one type (`donation`), so the blindness does not apply within B. The cap still means any figure past rank 200 must come from a **summary** (donor_count, tx_total, sum_total per recipient), not from a tail row. B as rehearsed carries that summary.

### Read 6 — the correctness gap (clone, every recipient over 1,000 inbound donation rows)

The truth is the top 50 donors by `sum(amount_cents)` over all inbound donation rows. The page's way is the same sum over the top 1,000 rows by `amount_cents`: the query's `ORDER BY amount_cents DESC LIMIT 1000`, then the JS fold at [page.tsx:474-494](../../apps/civitics/app/donors/%5Bid%5D/page.tsx). There are no NULL or non-positive amounts in this class; the minimum is 20,000¢.

| recipient | rows | true donors | page "Donors" | true top-50 present | at the same rank | page top-50 Σ / true | present donors' Σ / true |
|---|---|---|---|---|---|---|---|
| RNC | 151,406 | 125,567 | **837** | **44** | **16** | 0.966 | 0.972 |
| DNC | 159,448 | 129,463 | 900 | 47 | 31 | 0.992 | 0.998 |
| DSCC | 102,373 | 83,939 | 752 | **41** | 15 | 0.961 | 0.970 |
| Rep. Party of Texas | 4,357 | 3,697 | 860 | 50 | 50 | 1.000 | 1.000 |

| band | recipients | top-50 set wrong | set or order wrong | min overlap | avg "Donors" / true |
|---|---|---|---|---|---|
| 1k–2k | 167 | **19** | 54 | 36 | 0.729 |
| 2k–5k | 105 | 36 | 67 | 40 | 0.361 |
| 5k–10k | 30 | 17 | 23 | 36 | 0.153 |
| 10k–50k | 20 | 16 | 17 | 38 | 0.071 |
| > 50k | 6 | 6 | 6 | 41 | 0.011 |
| **all > 1k** | **328** | **94** | **167** | — | 269 missing slots |

- **The page is wrong for ordinary recipients, not only for whales.** 1,000 rows is enough to lose donors.
- **"Donors" (`donorMap.size`, [page.tsx:537](../../apps/civitics/app/donors/%5Bid%5D/page.tsx)) is capped at the sample for every recipient over 1,000 rows.**
- **Prod has 497 such recipients.** Its whales are about 2× the clone's. Read 6 was not run on prod; it is a window over 3.2 M rows.

### Read 7 — design B's writer and family

**`total_received_cents` — who writes it.**
- **The only re-deriver is the FE totals family:**
  - `fe-crawl`, jobid 46, `*/30`, budget 1,800 s, 30-day max successful wall 1,579 s. Its path is `run_fe_totals_crawl` → `refresh_fe_totals_slice()` → `financial_entity_received_totals_rebuild(uuid[])`, run for recipients dirty by `FR.updated_at`. The watermark `financial_entity_totals_watermark` is at 2026-09-21 00:18:25.83.
  - `financial-entity-totals-reconcile`, jobid 14, `0 12 1 * *`.
  - The weekly `financial-entity-totals-incremental` (jobid 13) is **inactive**.
- **The zeroing writer** is `fec-bulk/writer.ts:384-401`, `upsertPacEntitiesBatch`. On an unscoped run it writes a literal `0` into `total_received_cents`. `bulkUpsert` gets no `updateColumns`, so `ON CONFLICT (fec_committee_id) DO UPDATE` sets it. FIX-1009 narrowed the individual-donor writer (`DONOR_UPDATE_COLUMNS_UNSCOPED`) but not this one.
- **The other writers** (`usaspending-bulk/writer.ts:143`, `littlesis/writer.ts:201`, `edgar/companies.ts:164`) are plain INSERTs of 0 for new rows. They are harmless.
- **The consequence on prod today:**
  - **34 of the 41** recipients over 10k read `total_received_cents = 0`, and all 34 were touched 2026-09-20 22:00 – 09-21 01:00. The RNC is 0; the clone had $210.3 M.
  - The 7 non-zero rows were re-derived by the crawl at 01:00:00, which fits their FR rows having been dirty.
  - 6,953 committees are at 0 and were touched in that window.
  - **The page headline "Total received" reads $0 for the RNC, DNC and DSCC.**
  - Filed separately (§7).
- **Design B therefore should not put `received_tx_count` on `financial_entities` beside the column this writer clobbers.** B as rehearsed carries `donor_count` / `tx_total` / `sum_total` itself. No FE writer change is needed.

**The rollup family** (`cron.job` ⟕ `cron_job_budget`, read at 23:58:51 UTC; walls are the 30-day maximum succeeded):

| jobid | job | schedule | active | budget s | max wall s |
|---|---|---|---|---|---|
| 24 | donor-rollup-refresh | 0 9,12 * * * | t | 9,000 | 6,747 |
| 28 | contract-flow-rollups-refresh | 0 14 * * 4 | t | 9,000 | 5,892 |
| 46 | fe-crawl | */30 | t | 1,800 | 1,579 |
| 17 | donor-party-rollup-refresh | 0 15 * * 2 | t | 1,800 | 11,335 (FIX-1212) |
| 49 | group-donor-rollup-refresh | 10 3 * * 3 | t | 1,800 | 294 |
| 13 | financial-entity-totals-incremental | 0 10 * * 2 | **f** | 7,200 | — |
| 14 | financial-entity-totals-reconcile | 0 12 1 * * | t | — | 134 |

**FIX-704's incremental** (`20260702000000`):
- A watermark on `FR.updated_at` is read first. The new watermark is captured **before** the dirty set is built.
- Dirty recipients are `DISTINCT to_id WHERE updated_at > watermark`.
- Each ~200-recipient chunk is deleted and reinserted with a per-chunk COMMIT.
- The watermark advances only on a clean run.
- Since FIX-983/1139, every watermark clamps to `watermark_horizon()`.

**FIX-704 widened `official_donor_rollup_mv` to FE recipients, and FIX-1018 (`20260811000000`) took that back.** The `to_type = 'official'` scope is "REQUIRED, not an optimisation": 57 % of the enumerated recipients were FEs that the arms cannot roll up. They parked the uuid cursor and fabricated weights. **B is therefore a new arm with its own dirty set, not a widening of jobid 24.** The prod odr_mv holds 0 rows for the RNC.

## 2. D1 — the scratch indexes on the clone

### A — `(to_type, to_id, relationship_type, amount_cents DESC)`

- **Build:** cold, **23.18 s**, `max_parallel_maintenance_workers 1`, `maintenance_work_mem 64MB`.
- **Size:** **255,500,288 B** (244 MB, 31,189 pages).

| read (as anon) | taken? | ordered / bounded? | cold ms | warm ms | buffers |
|---|---|---|---|---|---|
| RNC inbound | yes | **no**: Index Scan returns all 151,406 rows, then a top-N sort | **5,634.5** | 229.2 | 101,557 |
| RNC spending | yes | n/a (0 rows) | 0.08 | 0.05 | 4 |
| RNC donor-count | yes | **Index Only Scan, Heap Fetches 0** | 26.3 | 20.8 | 8,281 |
| AMB spending | yes | **no**: all 246,005 rows, then a sort | **15,295.8** | 728.6 | 246,937 |
| ORD (all three) | yes | — | 7.7 / 0.06 / 0.18 | 0.72 / 0.03 / 0.11 | 84 / 4 / 126 |

**Why the order is lost.** The same `inbound` text **as `postgres`** plans `Aggregate ← Limit ← Index Scan` with no Sort (cost 949). As **anon**, the planner adds the Sort (cost 18,000), and the row estimate drops from 54,940 to 17,354. The bare narrow query as anon does the same. The cause:
- `proleakproof`: `enum_eq` = false, `texteq` = true, `uuid_eq` = true, on clone and prod alike.
- With RLS on, the non-leakproof enum equality is not turned into an equivalence-class constant.
- So the pathkey `(…, relationship_type, amount_cents)` never reduces to `(amount_cents)`, and the selectivity falls back to a default.

This applies to **any** anon-facing read whose ORDER BY sits behind an enum equality in an index key.

### partial-A — `(to_type, to_id, amount_cents DESC) WHERE relationship_type IN ('contract','grant')`

- **Build:** cold **13.75 s** (a warm rebuild took 15.57 s).
- **Size:** **178,782,208 B** (171 MB).

| read (as anon) | plan | cold ms | warm ms | buffers |
|---|---|---|---|---|
| RNC spending | `Limit ← Index Scan`, no Sort | 0.15 | 0.15 | 4 |
| AMB spending | `Limit ← Index Scan`, 50 rows | 15.2 | 0.31 | 58 (was 98,641) |
| ORD spending | same | 0.06 | 0.03 | 4 |

### Added by this run (rule 27, to test the narrow-A idea) — partial-inbound `(to_id, amount_cents DESC) WHERE relationship_type = 'donation' AND to_type = 'financial_entity'`

- **Build:** cold **9.17 s** (a warm rebuild took 3.25 s).
- **Size:** **25,755,648 B** (25 MB; b-tree dedup — `(to_id, amount)` repeats heavily).

| read (as anon, with partial-A also present) | plan | cold ms | warm ms | buffers |
|---|---|---|---|---|
| RNC inbound | `Limit ← Index Scan`, 1,000 rows, no Sort | 242.3 | 5.9 | 903 (was 27,743) |
| RNC donor-count | Index Only Scan, **Heap Fetches 0** | 21.0 | 18.7 | 8,267 |
| AMB inbound / donor-count | Index Scan / Index Only, 0 rows | 0.21 / 0.08 | — | 3 / 6 (was 87,477 / 166,916) |
| ORD inbound / count | same | 18.7 / 0.12 | 0.64 / 0.10 | 84 / 126 |

This fixes the cost of all three reads. It does **not** fix correctness: the inbound read is still a top-1,000-by-amount sample.

All three scratch indexes were dropped (`DROP INDEX CONCURRENTLY`), and the FR index count is back to 18.

## 3. D2 — design B's build on the clone

The query was a LATERAL per-recipient top-200 (reference_lateral_per_group_topn), written as `CREATE TABLE AS` with `work_mem 64MB` and the same planner GUCs:
- **Recipients:** `SELECT to_id … WHERE to_type='financial_entity' AND relationship_type='donation' GROUP BY to_id`.
- **Per recipient:** `from_id, sum, count` over `donor_rollup_idx` (`to_id = r.to_id AND relationship_type='donation' AND from_type='financial_entity'`), with `row_number()` by sum and the per-recipient summary (`donor_count`, `tx_total`, `sum_total`) as window columns, filtered to `rank <= 200`.

It carries no cycle columns. The page renders inbound cycles only when `donorTxCount` is 0 ([page.tsx:663-667](../../apps/civitics/app/donors/%5Bid%5D/page.tsx)), which means there are no inbound rows. That makes the prompt's min/max cycle, and its heap fetches, unnecessary.

| measure | value |
|---|---|
| build (cold) | **27.24 s** |
| rows / recipients | **441,378** / 8,483 (equal to read 5's capped count) |
| heap | **48,234,496 B** (46 MB) |
| RNC summary | 125,567 donors, 151,406 tx, 21,031,139,400¢. That equals the clone's `total_received_cents` for the RNC. |
| RNC top 50 against an independent truth (page predicate, heap path) | **0 missing / 0 extra**, sum 1,407,627,400 on both |
| incremental unit, RNC alone (cold) | 606.3 ms (1,630 reads) |
| incremental, the 26 clone recipients over 10k (cold) | 13,623.6 ms |

The table was dropped.

## 4. D3 — projection table and recommendation

### 4.1 Method

- **Prod build wall**, given as three figures:
  - clone cold × 1.389 (the FR row ratio; rule 173, the primary);
  - the same × 20 (cc-147's measured prod/clone-**warm** ratio, as a bracket);
  - an upper bound: two FR heap passes (2 × 4,932 MB) at tonight's **measured** prod index-scan rate, ~8.7–9.1 MB/s (read 4's two scans), about 1,150 s.
- **Why the ×20 bracket.** The clone's NVMe cold-reads the whole heap in seconds. Prod reads ~9 MB/s on this box, so cold × ratio alone is optimistic here.
- **Front-door cost** = wall / 240 s (rule 192: ~1 render per ~4 min of FR I/O).
- **Write rate.** FR rows by last-write day are bursty: 616,113 on 08-24 (the replay); 296,171 across 09-06…09-21; none since. FR is zero-HOT, so every write touches every index whose predicate matches.

### 4.2 The table

| | **A** | **partial-A (spending)** | partial-inbound | **B** | A + B | **partial-A + B** |
|---|---|---|---|---|---|---|
| prod build | 32 s / 10.7 min / ≤ 19 min | 19 s / 6.4 min / ≤ 19 min | 13 s / 4.2 min / ≤ 19 min | ~2.5 min floor* / 15 min | A's + B's | 6.4 + 2.5–15 min, **two separate windows** |
| prod size | ~355 MB | ~183 MB | ~44 MB | ~55–82 MB heap (0.50–0.75 M rows) + PK | ~410–440 MB | ~240–265 MB |
| renders during build (rule 192) | 0.1 / 2.7 / 4.8 | 0.1 / 1.6 / 4.8 | 0.1 / 1.1 / 4.8 | 0.6 / 3.9 | sum | ~2–9 |
| FR write amplification | every FR write (19th index) | contract/grant writes only | donation→FE writes only | **none** (its owner's refresh) | every write | contract/grant only |
| `inbound` after | taken, **not bounded** (RNC 5.6 s cold) | unchanged (1.5 s) | bounded, 1,000 rows (242 ms) | O(50) rollup read | O(50) | O(50) |
| `spending` after | RNC fine; **AMB 15.3 s cold** | **bounded** (0.15 ms / 15 ms) | unchanged | unchanged | AMB unbounded | **bounded** |
| `donor-count` after | index-only, 26 ms | unchanged | index-only, 21 ms | read dropped (summary column) | dropped | dropped |
| top-50 / "Donors" correct | no | no | no | **yes** (0/0 vs truth) | yes | **yes** |
| staleness | none | none | none | ≤ one owner cycle + the 1 h watermark horizon | ≤ 1 cycle | ≤ 1 cycle |
| budget / other jobs (rule 138) | none | none | none | new unit: a budget row, a guard, and a watermark key | same | same |
| verdict | **reject** | yes | interim only | yes | dominated | **recommended** |

\*B's prod floor has two parts:
- Its recipient enumeration **is** read 4, measured on prod at 101.6 s.
- Its per-recipient ranges cover about 372 MB of `donor_rollup_idx`, which is about 41 s at the measured rate.

**Option C, no DDL** (an RPC aggregating over the existing `donor_rollup_idx`):
- **Correct:** yes.
- **Plan on prod:** `EXPLAIN` takes `Index Only Scan donor_rollup_idx`.
- **Timed on prod as anon** (§4.3): **the RNC was cancelled at 3,026 ms cold**. Warmer runs took 2,421 ms and 521 ms; the DSCC took 2,731 ms cold.
- **Verdict: rejected for the whale class.** Its cost grows with inbound rows, and anon's real `work_mem` is smaller than the 256 MB this session inherited.

### 4.3 The option-C prod timings (the only executed prod reads besides reads 2/4/7)

- **Conditions:** `SET LOCAL ROLE anon`, with a `SET LOCAL statement_timeout` of 3 s and then 15 s.
- **Caveat:** `work_mem` was inherited from `postgres` (256 MB), so these are optimistic.
- `prod_op_gate(60)` read ok at 00:13:31.

| at (UTC) | read | result |
|---|---|---|
| 00:13:32 | RNC, 3 s cap | **57014 at 3,026 ms** (mine, not front-door) |
| 00:13:50 | RNC, 3 s cap | 2,421 ms: 283,715 donors, 337,058 tx |
| 00:13:53 | RNC, 15 s cap | 521 ms |
| 00:13:53 | DSCC, 15 s cap | 2,731 ms: 157,889 donors, 199,241 tx |

### 4.4 Recommendation, and what cc-159 must gate on

**partial-A (spending) + B.** A narrower spending predicate is worth measuring in cc-159 (rule 27), not assuming. The candidate is `(to_id, amount_cents DESC) WHERE relationship_type IN ('contract','grant') AND to_type = 'financial_entity'`: every contract/grant row is `to_type = financial_entity` in the clone's type matrix, and dropping the text column from the key should shrink it.

- **Page:**
  - `inbound` becomes `.from(<rollup>).eq(recipient_id).order(rank).limit(50)`, plus the recipient's summary row.
  - The `donor-count` read is deleted, since `tx_total` and `donor_count` come from the summary.
  - "Donors" uses `donor_count`.
  - "Total received" could read `sum_total` instead of the clobbered FE column. That is Craig's call; the column bug is filed separately.
- **B's owner (rule 59 / 125 / 138):**
  - **Not jobid 24** (FIX-1018).
  - The natural dirty set is the FE crawl's, i.e. recipients dirty by `FR.updated_at`. Adding it inside the existing `fe-crawl` slice leaves only **221 s** of headroom on its worst unit (1,579 of 1,800 s), and a post-drop slice re-deriving every whale costs 13.6 s cold on the clone, which projects to ~30 s or more on prod.
  - **Recommended:** its own unit class or job, with:
    - its own `cron_job_budget` row;
    - a `prod_session_state()` guard (FIX-950);
    - a watermark clamped to `watermark_horizon()` (FIX-983/1139), with the complete-with-0-rows rule when the target does not advance (FIX-1140);
    - REVOKE EXECUTE from anon, authenticated and service_role on the procedure;
    - an anon SELECT policy on the table.
- **B's bootstrap:**
  - Chunk it per recipient with a per-chunk COMMIT, at a bounded `work_mem` (the FIX-1123 arithmetic: 256 MB × `hash_mem_multiplier` 2 × leader+worker on a ~1 GB box).
  - The LATERAL form bounds memory per recipient: the largest is the RNC, at ~284k groups.
  - Its enumeration step is a 101.6 s FR index scan on prod, so it runs through `session:wait-for-gate --then` like any FR-heavy op.
- **The partial-A build.** `CREATE INDEX CONCURRENTLY` **cannot be paced**:
  - It does two full heap passes over 4,932 MB plus a sort of ~3.9 M entries, with two waits for older snapshots.
  - It holds ShareUpdateExclusiveLock on FR the whole time. That **blocks `fr-vacuum-analyze` (03:00) and FR autovacuum**, so the window must end well before 03:00.
  - A cancelled CIC leaves an **INVALID** index. The landing checks `indisvalid` and `DROP INDEX CONCURRENTLY`s a failure.
  - The honest gate is:
    - `prod_op_gate(1200)` (the upper-bound wall), waited on with `session:wait-for-gate --then`;
    - census (f);
    - no FR-heavy op in `[start, start + 2 × 1,200 s]`;
    - **drain-and-wait between the CIC and B's bootstrap**. Never together.
  - **Vacuum spacing.** `fr-vacuum-analyze` now runs **10 s**, not the 161–212 s the template's rule (g) quotes. By the template's own proportional rule, that puts it in the ≥ 10-min class, not the ≥ 90-min one (§5).

## 5. What contradicted the bullet, the prompt, or the template

1. **The four-column index does not do what the bullet says, for anon.** It is taken for all three reads. The `count` read is index-only with **Heap Fetches 0**; the prompt's rule-146 question is answered "index-only". But the index **cannot bound** `inbound` or `spending` under RLS, because `enum_eq` is not leakproof. The whale read got **3.8× slower cold** (1.5 → 5.6 s, RNC, clone). Partial predicates work where key columns do not.
2. **The whale class is not four committees.** The page's reads scan any-type inbound, so it is **94 FEs over 10k rows and 828 over 1k** on prod. It also includes contractors with **zero donations**: AmerisourceBergen's `donor-count` read is 14.4 s cold on the clone, from a `derivation` index-only scan of the whole donation range that finds nothing. cc-151's evidence named only party committees.
3. **The page's top-50 is wrong for mid-size recipients, not only whales:** 19 of the 167 in the 1k–2k band, with a minimum overlap of 36 of 50. The "Donors" stat is wrong for every recipient over 1k rows. That is filed as its own bullet (§7).
4. **"Total received" is $0 on prod for 34 of the 41 largest recipients**, including the RNC, DNC and DSCC. The PAC entity upsert clobbers it on every unscoped FEC run, and the FR-dirty crawl never re-derives a recipient whose FR rows did not change. Filed (§7). **Design B's `received_tx_count` beside that column would inherit the clobber**, so B carries its own summary.
5. **Build walls are minutes, not hours.** The bullet and prompt said "hours on Pro Small". The measured-rate upper bound is ~19 min per CIC.
6. **The RNC is 337,058 inbound donation rows on prod, not ~94,576.** cc-151's figure was a clone plan estimate; the planner under-estimates as anon (default selectivity).
7. **`official_donor_rollup_mv` on prod is 656,050 rows (reltuples, 256 MB)**, not 2,972,870. It holds **no FE recipients** since FIX-1018, so B cannot be a widening of it.
8. **Template rule (g)** quotes `fr-vacuum-analyze` at 161–212 s. The last three prod walls were 10.3 / 9.8 / 9.9 s (14-day mean 87.6 s).
9. **The clone is not a 17.9-day-stale copy of prod's FR; it is a smaller one.** It has 10.41 M rows against 14.46 M, and only 0.30 M prod rows were written after the clone's newest. Whale-sized clone walls are for half-size whales.
10. **ISR caches a degraded render.** The page is `revalidate = 300`, and `withDbTimeout` turns a timeout into empty data. So a whale render that times out can be served for 5 minutes with an empty donor list and "0" stats. This was not measured; it is noted for cc-159's page change.

## 6. The clone as left

- **Relation inventory** (`public`, relkind r / i / m, count plus an md5 of the sorted names): identical before and after.
  - i 497 `bc7cb553…`
  - m 13 `0a8dfc41…`
  - r 133 `4ee4b10e…`
- **Indexes:** FR has 18, and no `fix1217_%` relation remains.
- **State:** the container was restarted six times for cold reads and is healthy.

## 7. Filed and appended

- **FIX-1217:** an append with the correctness finding and this audit's path.
- **New:** the page computes a top-N-by-sum from a top-N-by-amount sample. The top-50 and "Donors" are wrong for recipients over 1k rows.
- **New:** the unscoped PAC entity upsert zeroes `total_received_cents`, and the FR-dirty crawl does not restore it. "Total received" is $0 for 34 of the 41 largest recipients on prod.
