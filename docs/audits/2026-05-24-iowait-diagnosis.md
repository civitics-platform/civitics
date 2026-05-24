# Supabase IOWait diagnosis — 2026-05-24

- Ran at: `2026-05-24T19:44:11.455Z`
- DB host: `aws-0-us-west-2.pooler.supabase.com:5432` (Supabase Pro,
  project `xsazcoxinpgttgquwvuf`)
- Active env at probe time: `https://xsazcoxinpgttgquwvuf.supabase.co`
  (confirmed via `grep ^NEXT_PUBLIC_SUPABASE_URL .env.local` after
  `Copy-Item .env.local.prod .env.local`)
- Read-only. No writes against prod. All probes are SELECTs against
  `pg_stat_statements`, `pg_stat_user_tables`, `pg_stat_user_indexes`,
  `pg_stat_activity`, `pg_class`, `pg_settings`, `pg_index`, `pg_indexes`.
- Source script: [packages/data/src/scripts/iowait-diagnosis.ts](../../packages/data/src/scripts/iowait-diagnosis.ts)
  (pnpm `data:iowait-diagnosis`). JSON dump alongside this doc.

> **TL;DR.** The Small tier's 256 MB `shared_buffers` against a 12.5 GB
> top-3-table working set is the root constraint — every workload is one
> cache miss away from disk. Three classes of pressure compound on it:
> (1) full-rebuild `rebuild_entity_connections_*` writing >25 M dirty
> pages per run, (2) JSONB metadata lookups doing seq scans of
> `proposals` and `financial_entities`, (3) a busted `enrichment_queue`
> drain claim that does 41 M block reads at 5% cache hit. Section I has
> 12 findings ranked by expected IO reduction. FIX-346 is closable —
> autovacuum has caught up on `financial_relationships`.

---

## Section A — Environment baseline

```sql
SELECT version();
SHOW shared_buffers; SHOW work_mem; SHOW effective_cache_size;
SHOW max_connections; SHOW autovacuum; SHOW maintenance_work_mem;
SHOW effective_io_concurrency; SHOW random_page_cost;
SHOW pg_stat_statements.max; SHOW track_io_timing;
```

| Setting | Value | Notes |
|---|---|---|
| version | PostgreSQL 17.6 on aarch64 (GCC 15.2.0, 64-bit) | Recent — Supabase Pro Small (graviton-class) |
| shared_buffers | 32768 (× 8 KiB) = **256 MB** | Pro Small default. The binding constraint. |
| work_mem | 3500 KiB ≈ **3.4 MB** | Per-sort/hash-op cap. Tight — affects HashAgg/HashJoin on big rebuilds. |
| effective_cache_size | 98304 (× 8 KiB) = **768 MB** | Planner's view of OS + shared cache. Confirms ~1 GB RAM tier. |
| max_connections | **60** | Confirms Small tier per FIX-346 memory entry. |
| autovacuum | on | — |
| maintenance_work_mem | 65536 KiB = **64 MB** | Used by autovacuum + CREATE INDEX. OK for tier. |
| effective_io_concurrency | 200 | SSD-tuned. |
| random_page_cost | 1.1 | SSD-tuned. |
| pg_stat_statements.max | 5000 | Plenty of room. |
| track_io_timing | **off** | `EXPLAIN (ANALYZE, BUFFERS)` can't report per-op IO time. Flagged in Section I. |

**Headline ratio (Section D foreshadow):** 256 MB `shared_buffers` ÷ 12.5 GB
top-3-table working set ≈ **2%**. Even the OS page cache (768 MB
`effective_cache_size`) covers only the hottest ~6%.

---

## Section B — Top IO consumers (steady-state)

```sql
SELECT substring(query, 1, 200), calls,
       total_exec_time::int AS total_ms,
       (total_exec_time / NULLIF(calls,0))::int AS mean_ms,
       shared_blks_read, shared_blks_hit,
       ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       shared_blks_dirtied, rows
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY shared_blks_read DESC
LIMIT 25;
```

Top 25 by `shared_blks_read` (1 block = 8 KiB).

| # | Query summary | calls | mean_ms | blks_read | hit_pct | Notes |
|---:|---|---:|---:|---:|---:|---|
| 1 | `SELECT … FROM enrichment_queue WHERE status=$1 LIMIT/OFFSET` | 768 | 2,962 | **41.5 M** | **5.0%** | Drain-orchestrator claim path. Cache-busting. |
| 2 | `get_connection_type_counts()` RPC | 1,028 | 5,992 | **38.9 M** | 17.3% | The `connection_type_counts` MV (FIX-338) is supposed to short-circuit this — RPC still reading 30 GB of pages. |
| 3 | `proposals WHERE metadata->>$1 = $2 LIMIT` | 7,229 | 679 | 32.2 M | 76.1% | JSONB `agency_id` lookup. No index on the metadata key → seq scan. |
| 4 | `rebuild_entity_connections_donations()` | 5 | **3,021,700** (50 min) | 29.4 M | 96.8% | Hit% high but writes 25 M dirty pages per call. |
| 5 | `financial_entities` full-table read (no WHERE, LIMIT/OFFSET) | 1,274 | 1,298 | 24.2 M | 20.5% | PostgREST GET against `/financial_entities?select=id,canonical_name,entity_type`. No filter. |
| 6 | PostgREST upsert into `financial_relationships` (donation conflict) | 17,145 | 792 | 18.0 M | 94.6% | FEC bulk path. |
| 7 | `rebuild_entity_connections()` umbrella | 17 | 489,130 | 14.9 M | 97.3% | Umbrella; called only by local dev / fallback path. |
| 8 | `proposals WHERE metadata->>$1 = $2 LIMIT` (variant) | 3,410 | 812 | 12.3 M | 79.7% | Same shape as #3. |
| 9 | `entity_connections WHERE from_id=$1 AND connection_type=$2 LIMIT` | 326 | 3,995 | **10.9 M** | **3.9%** | Likely the graph page edge fetch. User-facing latency. |
| 10 | `rebuild_entity_connections_votes()` | 6 | 493,344 | 5.0 M | 93.8% | Votes chunk. |
| 11 | `proposals ORDER BY introduced_at DESC LIMIT` | 741 | 279 | 3.6 M | 48.0% | Proposals list page. |
| 12 | PostgREST upsert into `financial_entities` (donor_fingerprint conflict) | 6,028 | 863 | 3.5 M | 95.2% | FEC indiv bulk path. |
| 13 | `rebuild_entity_connections_external()` | 8 | 356,954 | 2.9 M | 93.9% | External chunk. |
| 14 | `rebuild_entity_connections_contracts()` | 8 | 289,604 | 2.5 M | 85.3% | Contracts chunk. |
| 15 | `SELECT id::text, display_name, canonical_name FROM financial_entities WHERE entity_type=$3 AND id > $1 ORDER BY id LIMIT` | 111 | 1,344 | 2.3 M | 38.4% | Keyset paginator (canonical-name backfill or LittleSis matcher). |
| 16 | PostgREST upsert into `financial_entities` (donor_fingerprint variant) | 2,002 | 1,131 | 2.0 M | 85.8% | Same as #12. |
| 17 | `UPDATE financial_entities SET total_donated_cents FROM _donor_totals` | 1 | 768,169 | 1.5 M | 87.6% | `rebuild_financial_entity_donation_totals()` body (FIX-269). One-shot. |
| 18 | `rebuild_financial_entity_donation_totals()` RPC | 1 | 650,039 | 1.4 M | 77.0% | Wraps #17. |
| 19 | `search_graph_entities(q, lim)` RPC | 768 | 1,687 | 1.3 M | 64.5% | Graph search-box autocomplete. |
| 20 | `get_quality_counts()` RPC | 791 | 4,100 | 1.2 M | 85.0% | `/api/claude/status/quality` section. |
| 21 | `entity_connections WHERE from_id=$1 OR to_id=$2 LIMIT` | 84 | 561 | 1.1 M | 8.7% | Bidirectional fetch — different surface than #9. |
| 22 | `financial_relationships WHERE relationship_type = ANY($1) LIMIT` | 1,343 | 154 | 1.1 M | **1.7%** | Pure disk reads. Very low hit. |
| 23 | PostgREST upsert into `financial_relationships` (usaspending_award_id conflict) | 7,018 | 116 | 1.1 M | 99.1% | USAspending bulk. |
| 24 | `financial_relationships WHERE relationship_type=$1 LIMIT` | 341 | 618 | 925 K | 41.4% | Single-type variant of #22. |
| 25 | `financial_entities WHERE display_name ILIKE $1 LIMIT` | 96 | 526 | 886 K | 3.2% | ILIKE on display_name — pre-pattern-index path. |

### Top 10 — full normalized queries

```sql
-- #1: enrichment_queue drain claim (pre-claim() helper or status-only path)
WITH pgrst_source AS (
  SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue"
  WHERE "public"."enrichment_queue"."status" = $1
  LIMIT $2 OFFSET $3
) /* … */
```

Source: `packages/data/src/drain/status.ts` and PostgREST-side reads from
`/enrichment_queue?status=eq.<value>`. 41 M reads against a 258 MB table
strongly suggests this hits sequentially with no useful index. The
table has `enrichment_queue_pending(status, priority, created_at)` per
the cutover-index audit, but the PostgREST shape `status=eq.X LIMIT N
OFFSET M` with no ORDER BY may not use it cleanly — and `OFFSET M`
forces row counting up to M regardless.

```sql
-- #2: get_connection_type_counts()
SELECT * FROM public.get_connection_type_counts();
```

Source: `apps/civitics/app/api/claude/status/_lib/sections.ts` ->
`getConnectionTypes`. Defined in
`supabase/migrations/20260523040001_connection_type_counts_mv.sql`. The
RPC reads from `connection_type_counts_mv`. 38 M blks in 1028 calls →
**~37,800 blks / call ≈ 295 MB / call**. The MV is supposed to short-
circuit this. Suggests one of: (a) the MV isn't being read by the RPC
on this path, (b) refresh_connection_type_counts_mv is failing
silently and the function falls back to live SELECT, (c) the function
body still does a re-aggregation pass. **Needs body inspection.**

```sql
-- #3: proposals metadata->>'agency_id' lookup (or similar)
SELECT "public"."proposals"."id" FROM "public"."proposals"
WHERE "public"."proposals"."metadata"->>$1 = $2 LIMIT $3 OFFSET $4;
```

Source: `apps/civitics/app/api/cron/notify-followers/route.ts` walks
`a.acronym ?? a.name` → `proposals WHERE metadata->>'agency_id' = X`.
Also referenced in several agency-page routes. No expression index on
`(metadata->>'agency_id')` → forces seq scan of all 76k proposals every
time (26,068 seq_scans on `proposals` from Section D hot-tables
confirms it).

```sql
-- #4: rebuild_entity_connections_donations()
SELECT * FROM public.rebuild_entity_connections_donations();
```

Source: `packages/data/src/scripts/rebuild-entity-connections.ts`
chunk 1. Section H below — full rebuild every Sun+Wed, no watermark.
**Highest single source of dirty pages per run** (25.5 M blks
dirtied × 5 calls = 128 M page writes since stat reset).

```sql
-- #5: financial_entities unfiltered list
SELECT id, canonical_name, entity_type FROM financial_entities LIMIT $1 OFFSET $2;
```

Source: PostgREST GET. Likely the LittleSis matcher (`packages/data/src/pipelines/littlesis/index.ts`) walking all entities for canonical-name resolution, or the connection-graph `/financial-entities` page. The 20.5% hit pct against a 2.6 GB table means this read pulled most of the table off disk repeatedly.

```sql
-- #6: financial_relationships donation upsert
INSERT INTO financial_relationships(...) ... ON CONFLICT (relationship_type, from_id, to_id, cycle_year) DO UPDATE SET ...
```

Source: FEC bulk pipeline `packages/data/src/pipelines/fec-bulk/` step
2b (PAC contributions) and step 2c (individual contributions).
Expected — the path is documented as `Verified: prod` per the cutover
notes. 17k calls × 94.6% hit is healthy.

```sql
-- #7: rebuild_entity_connections() umbrella
SELECT * FROM public.rebuild_entity_connections();
```

Source: PostgREST RPC. Only the local-dev fallback path
(`rebuild-entity-connections.ts` line 144) and emergency manual calls.
Production uses the per-chunk path. 17 calls × 489s = 8h+ since stat
reset window — that's the umbrella running on local + the rare manual
trigger.

```sql
-- #8: proposals metadata variant of #3
```

Same shape as #3, second parameterization (probably a different field
key — `subject` or `sponsor_id`).

```sql
-- #9: entity_connections WHERE from_id AND connection_type LIMIT
SELECT "public"."entity_connections"."id" FROM "public"."entity_connections"
WHERE "public"."entity_connections"."from_id" = $1
  AND "public"."entity_connections"."connection_type" = $2
LIMIT $3 OFFSET $4;
```

Source: graph page edge fetch (`apps/civitics/app/connections/*` or
`apps/civitics/app/officials/[id]/page.tsx`). 3.9% hit pct on a 5 GB
table is the worst hit ratio of any user-facing read. The
`entity_connections` table has `entity_connections_from_id_to_id` and
others per the cutover audit; needs verification that a
`(from_id, connection_type)` compound or partial index exists.

```sql
-- #10: rebuild_entity_connections_votes() — same shape as #4
```

### Cross-references from request-path / pipeline audits

- #2 `get_connection_type_counts()` was the central FIX-298 / FIX-338
  fix. Findings F2 below flag that the MV path isn't carrying its
  weight.
- #3 + #8 (proposals metadata) — not currently materialized. The
  request-path-aggregations audit (`docs/audits/request-path-aggregations.md`)
  doesn't list `proposals` JSONB lookups; this is a new candidate.
- #9 (entity_connections graph fetch) — not currently materialized.
  Would need a per-entity rollup or just a missing-index fix.
- `homepage_stats_mv`, `chord_*_mv`, `proposal_trending_24h`,
  `proposal_popularity_24h` — none in the top 25, confirming the
  request-path materializations are doing their job.

---

## Section C — Top IO consumers (burst / concurrency)

Six samples taken across a 30-second window (`2026-05-24T19:43:45` →
`19:44:11`):

```sql
-- Contention probe (one row per sample)
SELECT
  count(*) FILTER (WHERE wait_event_type IN ('IO','BufferPin')) AS io_waiting,
  count(*) FILTER (WHERE wait_event_type = 'Lock') AS lock_waiting,
  count(*) FILTER (WHERE state = 'active') AS active,
  count(*) FILTER (WHERE state = 'idle') AS idle,
  count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_xact,
  count(*) AS total
FROM pg_stat_activity
WHERE datname = current_database();
```

| Sample time (UTC) | active | idle | io_waiting | lock_waiting | total |
|---|---:|---:|---:|---:|---:|
| 19:43:45 | 1 | 18 | 0 | 0 | 21 |
| 19:43:50 | 1 | 18 | 0 | 0 | 21 |
| 19:43:55 | 1 | 18 | 0 | 0 | 21 |
| 19:44:01 | 1 | 18 | 0 | 0 | 21 |
| 19:44:06 | 1 | 18 | 0 | 0 | 21 |
| 19:44:11 | 1 | 18 | 0 | 0 | 21 |

```sql
-- Activity sample
SELECT pid, state, wait_event_type, wait_event,
       EXTRACT(EPOCH FROM now() - xact_start)::int AS xact_age_s,
       EXTRACT(EPOCH FROM now() - query_start)::int AS query_age_s,
       substring(query, 1, 400) AS query, application_name
FROM pg_stat_activity
WHERE datname = current_database() AND state IS NOT NULL
ORDER BY query_start NULLS LAST;
```

All 6 samples show 18 idle PostgREST sessions on `COMMIT` /
`ClientRead` (normal Supavisor pool state) plus 1 active session — the
audit's own connection. Active workload during this window: nothing
heavy. The probe **caught a quiet moment** (between 10-min platform-
snapshot ticks, no rebuild running, GHA scheduler likely drifted past
its slot per FIX-327).

**This means the burst-sample question is unanswered by this pass.**
The 30s window probed steady-state-empty, not steady-state-active.
Section I records this as a follow-up: re-run with a 10-min probe
window aligned to a known `platform-snapshot.yml` firing or a manual
`gh workflow run rebuild-entity-connections.yml` trigger. Section H
inspects the source shapes so the unanswered burst data point is the
only gap, not a blocker.

**The IOWait symptoms reported in the user briefing
(reference_supabase_compute_iowait.md) happen during cron ticks** —
status_snapshot's 11-section payload + rebuild chunks + ad-hoc admin
queries all fire concurrently against 60-conn / 256 MB shared_buffers.
Section H reasons about that load from the static shape; Section I
flags the burst re-probe.

---

## Section D — Working set vs RAM

```sql
SELECT relname,
       pg_total_relation_size(c.oid) AS total_bytes,
       pg_relation_size(c.oid) AS heap_bytes,
       pg_indexes_size(c.oid) AS index_bytes,
       reltuples::bigint AS approx_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 20;
```

| # | Table | Total | Heap | Indexes | Approx rows |
|---:|---|---:|---:|---:|---:|
| 1 | `entity_connections` | **5.12 GB** | 2.37 GB | 2.75 GB | 5.18 M |
| 2 | `financial_relationships` | **4.79 GB** | 2.46 GB | 2.33 GB | 5.93 M |
| 3 | `financial_entities` | **2.61 GB** | 1.53 GB | 1.08 GB | 2.42 M |
| 4 | `votes` | 500 MB | 259 MB | 240 MB | 902 K |
| 5 | `jurisdictions` | 450 MB | 8 MB | 3 MB | 7,267 |
| 6 | `enrichment_queue` | 258 MB | 232 MB | 26 MB | 142 K |
| 7 | `external_relationships_review_queue` | 204 MB | 164 MB | 24 MB | 120 K |
| 8 | `proposals` | 150 MB | 80 MB | 69 MB | 76,622 |
| 9 | `external_relationships` | 137 MB | 102 MB | 35 MB | 193 K |
| 10 | `external_source_refs` | 85 MB | 35 MB | 50 MB | 176 K |
| 11 | `officials` | 42 MB | 16 MB | 26 MB | 28,768 |
| 12 | `bill_details` | 22 MB | 8 MB | 14 MB | 68 K |
| 13 | `entity_tags` | 20 MB | 9 MB | 11 MB | 43 K |
| 14 | `platform_usage_snapshot` | 9 MB | 0.4 MB | 0.1 MB | 823 |
| 15 | `status_snapshot` | 7.5 MB | 1.4 MB | 0.1 MB | 691 |

**Top-3 sum = 12.52 GB.** Against `shared_buffers = 256 MB`, the top-3
buffer ratio is **~2%**. Even against `effective_cache_size = 768 MB`
(planner's view of OS + shared cache), the top-3 ratio is **~6%**.

`jurisdictions` is row #5 by total size at 450 MB despite only 7,267
rows — PostGIS `boundary_geometry` MULTIPOLYGONs from the TIGER
districts pipeline. Almost entirely TOAST; not in the hot path
(district map pages render via `/api/districts` simplifier, not raw
boundary reads). Stays.

`entity_connections` indexes alone (2.75 GB) exceed the entire
`shared_buffers` 10×. Cache thrashing is structural.

### Hot tables (proxy: seq_scan + idx_tup_fetch volume)

```sql
SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
       n_live_tup, n_dead_tup,
       n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd
FROM pg_stat_user_tables WHERE schemaname = 'public'
ORDER BY (COALESCE(seq_tup_read,0) + COALESCE(idx_tup_fetch,0)) DESC
LIMIT 10;
```

| Table | seq_scan | seq_tup_read | idx_scan | idx_tup_fetch | n_tup_upd |
|---|---:|---:|---:|---:|---:|
| `financial_relationships` | 6,423 | **1.78 B** | 13.6 M | 398 M | 5.69 M |
| `proposals` | **26,068** | **1.64 B** | 893 K | 56.5 M | 40,571 |
| `entity_connections` | 1,996 | 1.06 B | 2.09 M | 248 M | 4,692 |
| `votes` | 1,265 | 7.9 M | 45,719 | **849 M** | 0 |
| `financial_entities` | 3,326 | 720 M | 28.5 M | 47 M | 25.7 M |
| `enrichment_queue` | 2,438 | **304 M** | 417 K | 17 M | 327 K |
| `officials` | 7,719 | 105 M | 5.0 M | 9.3 M | 575 K |

Standouts:

- **`proposals` 26,068 seq_scans + 1.6 B tup_read** — every
  `metadata->>'agency_id'` JSONB lookup (queries #3 + #8 in Section B)
  is a full table scan. Cause confirmed.
- **`financial_relationships` 1.78 B tup_read** — combined drag of
  rebuild chunks reading it (donations, votes, contracts, external all
  pull from it) plus `relationship_type` filter queries (#22, #24).
- **`votes` 849 M idx_tup_fetch** is fine — that's `votes_official_id`
  index doing its job for the official-page voting record.
- `enrichment_queue` 2,438 seq_scans = 304 M tup_read confirms the
  drain-claim PostgREST query (#1) does NOT use the index. 142k row
  table × 2,438 scans = ~~340M rows~~ ≈ 304M actual; confirms full-
  table on every claim.

---

## Section E — Unused / oversized indexes (working-set shrink candidates)

```sql
SELECT schemaname, relname, indexrelname,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_relation_size(indexrelid) AS size_bytes
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
LIMIT 40;
```

### Unused (`idx_scan = 0`) AND size > 10 MB

| Table | Index | Size | Notes |
|---|---|---:|---|
| `entity_connections` | `entity_connections_strength` | **490 MB** | btree on `strength`. Never used by any query in the top 25. Drop candidate. |
| `financial_relationships` | `financial_relationships_metadata_gin` | **257 MB** | GIN on `metadata`. Sized like a load-bearing index but `idx_scan=0`. Drop candidate. |
| `entity_connections` | `entity_connections_amount` | **128 MB** | btree on `amount_cents`. Drop candidate. |
| `financial_entities` | `financial_entities_display_trgm_individual` | **123 MB** | Partial GIN `WHERE entity_type='individual'`. Drop candidate; the unpartial `financial_entities_canonical_trgm` covers similar shape with idx_scan in use. |
| `financial_relationships` | `financial_relationships_occurred_at` | **75 MB** | btree on `occurred_at`. Drop candidate. |
| `votes` | `votes_roll_call_id_official_id_key` | **65 MB** | UNIQUE constraint — drop carefully, may protect insert idempotency. Verify pipeline doesn't rely on uniqueness. |
| `proposals` | `shadow_proposals_search_vector` | 13 MB | GIN on tsvector. Cutover leftover. Drop candidate. |
| `external_source_refs` | `external_source_refs_metadata_gin` | 11 MB | GIN on metadata. Cutover leftover. |

**Sum of unused-and-large = ~1.16 GB.** Dropping these reduces the
total index footprint by that much, freeing shared_buffers room for
the indexes that ARE in the hot path. Roughly a 15% working-set
shrink for the top-3 tables.

Caveat: `entity_connections` was TRUNCATE+rebuilt 17 times since the
last `pg_stat_statements_reset` (Section B #7 + #4 etc.), and
`pg_stat_user_indexes` counters reset with TRUNCATE on Postgres < 14
but **persist on 17**. So `idx_scan=0` here is solid — these indexes
truly have not been used in this window.

### Duplicate-shape indexes

```sql
-- pg_index.indkey-based duplicate detection
WITH idx AS (
  SELECT i.indrelid::regclass::text AS table_name, c.relname AS index_name,
         array_to_string(i.indkey, ' ') AS keylist,
         pg_relation_size(c.oid) AS size_bytes,
         i.indisunique, pg_get_indexdef(c.oid) AS indexdef
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
)
SELECT a.table_name, a.index_name, a.size_bytes,
       b.index_name AS dup_of, b.size_bytes AS dup_size
FROM idx a JOIN idx b
  ON a.table_name = b.table_name AND a.keylist = b.keylist
 AND a.index_name < b.index_name
ORDER BY a.size_bytes + b.size_bytes DESC;
```

| Table | Index A | Index B | A size | B size | Verdict |
|---|---|---|---:|---:|---|
| `financial_entities` | `financial_entities_donor_fingerprint_pattern` | `financial_entities_donor_fingerprint_unique` | 166 MB | 163 MB | **Different opclasses** — `text_pattern_ops` (LIKE) vs default (=). The pattern one is dead unless `WHERE donor_fingerprint LIKE 'X%'` happens. Verify grep before drop. |
| `financial_entities` | `financial_entities_canonical` (partial) | `financial_entities_canonical_trgm` | 4 MB | 231 MB | Different shapes (btree partial vs gin trgm). Not redundant. |
| `financial_entities` | `financial_entities_display_trgm` (partial: non-individual) | `financial_entities_display_trgm_individual` (partial: individual) | 15 MB | 123 MB | Partitioned. The individual partition's idx_scan=0 (above) — drop the individual half. |
| `officials` | `idx_officials_name_trgm` | `officials_full_name_trgm` | 6.6 MB | 6.6 MB | **TRUE DUPLICATE.** Drop one. |
| `agencies` | `agencies_name_trgm` | `idx_agencies_name_trgm` | 0.1 MB | 0.1 MB | **TRUE DUPLICATE.** Tiny, low priority. |
| `agencies` | `agencies_acronym_unique` (UNIQUE) | `idx_agencies_acronym_trgm` (gin trgm) | 16 KB | 49 KB | Different opclasses. Keep both. |
| `notifications` | `notifications_user_all` | `notifications_user_unread` (partial WHERE !is_read) | 8 KB | 8 KB | Intentional pair. Keep. |
| `graph_snapshots` | `graph_snapshots_code_key` (UNIQUE) | `idx_graph_snapshots_code` | 8 KB | 8 KB | **UNIQUE covers equality lookups; drop the non-unique.** Small. |

---

## Section F — Table bloat (FIX-346 re-measure)

```sql
SELECT relname, n_live_tup, n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
       vacuum_count, autovacuum_count
FROM pg_stat_user_tables WHERE schemaname = 'public'
ORDER BY n_dead_tup DESC NULLS LAST LIMIT 25;
```

| Table | Live | Dead | dead_pct | last_autovacuum | last_autoanalyze |
|---|---:|---:|---:|---|---|
| `financial_relationships` | 6.17 M | 835,012 | **11.9%** | 2026-05-13 07:35 | 2026-05-17 07:01 |
| `financial_entities` | 2.42 M | 282,605 | 10.4% | 2026-05-20 11:53 | 2026-05-24 07:55 |
| `entity_connections` | 5.18 M | 147,824 | 2.8% | **2026-05-24 13:15** | 2026-05-24 13:34 |
| `external_relationships` | 193 K | 26,580 | 12.1% | 2026-05-12 05:17 | 2026-05-14 22:58 |
| `proposals` | 76,661 | 9,356 | 10.9% | 2026-05-17 05:52 | 2026-05-23 07:46 |
| `enrichment_queue` | 148 K | 8,521 | 5.4% | 2026-04-25 05:01 | 2026-04-29 06:29 |
| `agencies` | 100 | 32 | 24.2% | 2026-05-08 05:36 | 2026-05-08 05:35 |

### FIX-346 status

`reference_supabase_compute_iowait.md` (2026-05-24) flagged autovacuum
lag on `financial_relationships`. Current state: **autovacuum has run
33 times** (`autovacuum_count: 33`) on `financial_relationships`. Last
autovacuum ran **2026-05-13** (11 days ago), last autoanalyze **2026-
05-17** (7 days ago). `dead_pct = 11.9%` — within tolerance, not a
red flag.

**Verdict: autovacuum has caught up.** FIX-346 is closable. No manual
`VACUUM`/`pg_repack` needed today. Per the runbook this is a closure-
type fix (`Closes: FIX-346` with `Verified: closes-as-recognized` if
no other code change is involved), to be handled in a separate commit.

`enrichment_queue` last autoanalyze 2026-04-29 (25 days ago) is the
most stale entry — but `dead_pct=5.4%` is fine, and the drain churn
(327k upd) means autoanalyze threshold hasn't tripped. Flagged in
Section I as a low-priority cleanup.

---

## Section G — Cron / job schedule audit

### GHA workflows under `.github/workflows/`

| File | Cron | Cadence (UTC) | DB load | Status |
|---|---|---|---|---|
| `nightly.yml` | `0 2 * * *` | Daily 02:00 | **Heavy** — full nightly orchestrator | Active |
| `notify-followers` (Vercel cron) | `0 3 * * *` | Daily 03:00 | Light — agency-keyed proposal lookups (query #3 above) | Active |
| `audit.yml` | `0 4 * * 1` | Monday 04:00 | Medium — integrity audit | Active |
| `sync-canary-check.yml` | `0 5 * * *` | Daily 05:00 | Light — data_sync_log scan | Active |
| `rebuild-entity-connections.yml` | `0 8 * * 0,3` | Sun + Wed 08:00 | **Heaviest single job** — full rebuild chunks | Active |
| `platform-snapshot.yml` | `*/10 * * * *` | Every 10 min (drifts to 1h-3.5h per FIX-327) | Medium — fires `computePlatformUsagePayload` + `writeStatusSnapshot` | Active |

### In-app crons (`apps/civitics/vercel.json`)

- `/api/cron/nightly-sync` at `0 2 * * *` — light canary, just writes
  a row to `data_sync_log`. **Fires concurrently with GHA nightly** but
  is trivially light.
- `/api/cron/notify-followers` at `0 3 * * *` — runs the per-agency
  proposal lookup (the `proposals.metadata->>'agency_id'` query #3
  family). With ~100 agencies × ~679ms mean = ~68s wall, hits during
  nightly's first hour. **Overlap candidate.**

### Overlap analysis

| Time (UTC) | Heavy job firing | Concurrent jobs | Risk |
|---|---|---|---|
| 02:00 daily | nightly.yml | nightly-sync canary | Low — canary is trivial. |
| 02:00–04:00 daily | nightly.yml (continuing) | platform-snapshot (12 ticks, GHA-drift permitting) | **Medium.** Every 10-min snapshot writes ~7 MB of status data + reads ~30 GB worth of MV/RPC pages. Compounds with nightly's IO. |
| 03:00 daily | notify-followers (Vercel) | nightly.yml + platform-snapshot | **Medium.** notify-followers re-seq-scans `proposals` per agency. |
| 04:00 Monday | audit.yml | nightly.yml tail of Sunday-block (heaviest day) | **Medium-low.** Audit is read-only and capped. |
| 05:00 daily | sync-canary-check | nightly.yml tail | Low — both are read-only short queries. |
| 08:00 Sun+Wed | rebuild-entity-connections | platform-snapshot ticks during the 40-90 min rebuild window | **High.** Rebuild dirties 25 M pages in donations chunk alone; concurrent snapshot reads compete for cache + WAL. |

The most consequential overlap is the **08:00 Sun+Wed rebuild ×
10-min platform-snapshot window** — but per FIX-327 the GHA `*/10`
scheduler drifts to 1h-3.5h gaps, so the actual overlap is
intermittent. When it lands, both workloads are IO-bound.

Mitigation suggestions filed to Section I; not implemented here.

---

## Section H — `rebuild_entity_connections`, `platform-snapshot`, status route shape audit

### `rebuild_entity_connections` — full rebuild every run

Script: [packages/data/src/scripts/rebuild-entity-connections.ts](../../packages/data/src/scripts/rebuild-entity-connections.ts)

```ts
const CHUNK_FNS = [
  "rebuild_entity_connections_donations",
  "rebuild_entity_connections_votes",
  "rebuild_entity_connections_cosponsors",
  "rebuild_entity_connections_appointments",
  "rebuild_entity_connections_oversight",
  "rebuild_entity_connections_holds",
  "rebuild_entity_connections_gifts",
  "rebuild_entity_connections_contracts",
  "rebuild_entity_connections_lobbying",
  "rebuild_entity_connections_external",
];
```

**Shape:** loop through 10 chunk functions sequentially, each one a
`SELECT * FROM public.rebuild_entity_connections_<chunk>()`. After the
loop, `SELECT public.refresh_connection_type_counts()` fires the MV
refresh (FIX-338).

**Watermark:** **none.** No `updated_at` cursor, no dirty-entity queue.
The body of `rebuild_entity_connections_donations` (per the cutover
note) does a TRUNCATE-and-rebuild from `financial_relationships` where
`relationship_type IN ('donation', 'ie_support')`.

**Per-run IO (from Section B #4):**
- donations chunk: 5 calls × 29.4 M blks_read / 5 = 5.88 M blks / run
  = ~47 GB of reads (with 96.8% cache hit, ~1.5 GB actual disk read)
- donations chunk: dirties 25.5 M blocks / 5 calls = 5.1 M / run =
  **40 GB of dirty-page writes per donations chunk run**

**Incrementalization potential.** `financial_relationships` adds ~10k
rows/day on quiet days, ~100k on FEC bulk days (5.93 M total → roughly
1.7%/week churn). Twice-weekly rebuild = ~3.5% churn. **Incremental
rebuild on only changed `from_id` entities** would cut donations chunk
IO by an order of magnitude. Same shape as FIX-294 (LittleSis
incremental). Expected reduction: **80-90%** of donations chunk IO.

### `platform-snapshot` shape

Helper: [packages/db/src/platform-snapshot.ts](../../packages/db/src/platform-snapshot.ts)

Calls: anthropic spend SUM (1 query against `api_usage_logs`),
`getSupabaseSqlMetrics` (RPC), `getSupabaseAuthMau` (RPC),
`getSupabaseManagementMetrics` (HTTP), `getCloudflareR2Usage` (HTTP),
`getSupabasePrometheusMetrics` (HTTP), `getGitHubUsage` (HTTP),
`getVercelUsage` (HTTP). Writes ~9 `updateUsage` UPSERTs per tick,
plus the `platform_limits` UPDATE for the disk-size override
(FIX-351).

**Per-tick DB load:** small. The 9 UPSERTs target tiny tables. The
heavy lifting in the cron route is the *companion* `writeStatusSnapshot`
call — see next subsection.

### `/api/cron/platform-snapshot` route + `writeStatusSnapshot`

Route: [apps/civitics/app/api/cron/platform-snapshot/route.ts](../../apps/civitics/app/api/cron/platform-snapshot/route.ts)

Calls in parallel:
- `writePlatformUsageSnapshot(db)` — the helper above.
- `writeStatusSnapshot(db)` — computes the 11-section status payload
  and INSERTs into `status_snapshot`.

**Status payload helper:** [apps/civitics/app/api/claude/status/_lib/status-snapshot.ts](../../apps/civitics/app/api/claude/status/_lib/status-snapshot.ts)
+ [sections.ts](../../apps/civitics/app/api/claude/status/_lib/sections.ts).

11 sections run in parallel via `Promise.allSettled`. Heaviest:

- `getDatabase` — fires 11 COUNT queries against the row-count tables
  (officials, proposals × 3 variants, votes, connections,
  financial_relationships, financial_entities, tags, cache, views).
  Mode tuned for "estimated" on big tables (FIX-206) so these are
  pg_class reads, not full scans. **Low.**
- `getConnectionTypes` — calls `get_connection_type_counts()` (the #2
  IO consumer; 38 M blks read). **Highest in the suite.**
- `getQuality` — calls `get_quality_counts()` (#20 above; 1.2 M blks).
  **Second highest.**
- `getChord` — 4 MV reads (chord_*_mv); all small.
- Others — `getActivity`, `getResourceWarnings`, `getOfficialsBreakdown`,
  `getPipelines`, `getAiCosts`, `getVersion`, `getSelfTests` — small,
  bounded by `withDbTimeout(2000)`.

**Per-10-min-tick IO from status snapshot alone:**
- `get_connection_type_counts()` mean ~37 K blocks ≈ **295 MB per tick**.
- `get_quality_counts()` mean ~1.5 K blocks ≈ **12 MB per tick**.

Per FIX-327 the GHA scheduler drifts to ~1-3.5h gaps. If it fires at
nominal cadence: 6 ticks/h × 295 MB = ~1.8 GB/h of MV reads. At the
drifted cadence: ~1 tick/h ≈ 295 MB/h. **The MV is supposed to make
this cheap; it isn't.** Filed in Section I.

`get_connection_type_counts` is the path FIX-338 was supposed to fix
via the `connection_type_counts_mv`. The fact that 1028 calls average
**5,992 ms each** suggests the MV is either (a) not being read by the
RPC, (b) being refreshed mid-read and falling back to live, or (c)
the RPC body still does compute on top of the MV. Body inspection
needed — see Finding 2 in Section I.

---

## Section I — Findings, ranked

Ordered by expected IO reduction per unit implementation cost. "S/M/L"
implementation cost: S = day, M = a few days, L = a week or more.

| # | Finding | Expected IO reduction | Cost | Refers to |
|---:|---|---|---|---|
| 1 | **`rebuild_entity_connections` → incremental rebuild on dirty `from_id` rows.** Full rebuild reads & rewrites 29 M / 5 M / 2.9 M / 2.5 M blocks per chunk twice a week. With twice-weekly cadence and ~3.5% source-row churn, incrementalization cuts donations chunk IO by ~95%. Highest single lever in the entire diagnosis. | **Very high** (~80-95% of rebuild IO) | **L** (months, per CLAUDE.md note) | §H rebuild shape; cross-ref FIX-294 (LittleSis incremental, same pattern) |
| 2 | **`get_connection_type_counts()` RPC body — verify MV is on the read path.** 1,028 calls × 5,992 ms × 38 M blks suggests the FIX-338 MV (`connection_type_counts_mv`) is being bypassed, refreshed mid-read, or wrapping live compute. Likely a one-day fix (rewrite RPC body to `SELECT … FROM connection_type_counts_mv` exclusively, with sub-query removed). | **High** (~30% of total request-path IO) | **S** | §B #2, §H status route |
| 3 | **Add expression index `proposals_metadata_agency_id ON proposals ((metadata->>'agency_id'))`** (or equivalent for whichever metadata key #3+#8 are using). 26,068 seq_scans → ~30-50 index lookups. Eliminates 32 M + 12 M = 44 M blks of seq scans. | **High** (~15% of request-path IO) | **S** | §B #3, §B #8, §D hot tables; cross-ref `apps/civitics/app/api/cron/notify-followers/route.ts` |
| 4 | **`entity_connections (from_id, connection_type)` index — verify present + healthy.** 3.9% cache-hit rate on 326 calls × 3,995 ms suggests the index is either missing, bloated, or the planner isn't using it. Check `\d entity_connections` and `EXPLAIN ANALYZE` of query #9. | **High** (~5% of total IO and biggest user-facing latency cut) | **S** | §B #9 |
| 5 | **Drop 1.16 GB of unused-and-large indexes** (`entity_connections_strength` 490 MB; `financial_relationships_metadata_gin` 257 MB; `entity_connections_amount` 128 MB; `financial_entities_display_trgm_individual` 123 MB; `financial_relationships_occurred_at` 75 MB; `proposals.shadow_proposals_search_vector` 13 MB; `external_source_refs_metadata_gin` 11 MB). Each verified `idx_scan=0` over the current stat window. | **Medium** (~15% working-set shrink on top-3 tables → better cache hit rate everywhere) | **S** | §E unused indexes |
| 6 | **`enrichment_queue` drain claim — switch from PostgREST `status=eq.X LIMIT N OFFSET M` to the `claim_*()` RPC + index hint.** 41 M blks at 5% hit (worst in the table) is from sequential drain-orchestrator polling. The `enrichment_queue_pending(status, priority, created_at)` index exists but PostgREST's `LIMIT/OFFSET` without `ORDER BY` may not select it; the underlying `pnpm data:drain:claim` already uses a `FOR UPDATE SKIP LOCKED` RPC — find what's still using the PostgREST path and migrate it. | **Medium** (eliminates one of the two worst-hit-pct queries) | **S** | §B #1, §D hot tables; cross-ref `packages/data/src/drain/claim.ts` |
| 7 | **Re-run the burst probe during an active cron tick.** This audit caught a quiet window. Need 5-10 sample of `pg_stat_activity` during a confirmed `platform-snapshot.yml` firing OR a manual `gh workflow run rebuild-entity-connections.yml` to confirm whether `wait_event_type='IO'` actually spikes. Without it, the IOWait diagnosis is from-shape inference, not observation. | n/a (observation) | **S** (re-run script + grep) | §C samples |
| 8 | **Drop true-duplicate indexes** — `officials.idx_officials_name_trgm` vs `officials_full_name_trgm` (both 6.6 MB, same shape), `agencies.agencies_name_trgm` vs `idx_agencies_name_trgm`, `graph_snapshots.idx_graph_snapshots_code` (non-unique dup of `graph_snapshots_code_key`). Small absolute size; mostly hygiene. | **Low** (~15 MB shrink) | **S** | §E duplicates |
| 9 | **Verify `financial_entities_donor_fingerprint_pattern` (166 MB) is in use.** Same column as `_unique` (163 MB) but `text_pattern_ops` opclass. Only useful if `donor_fingerprint LIKE 'X%'` happens anywhere. If grep finds zero callsites, drop it. | **Medium** (166 MB shrink if dead) | **S** (grep then drop) | §E duplicates |
| 10 | **Reduce `platform-snapshot.yml` cadence from `*/10` to `*/30` until cache headroom recovers.** Per FIX-327 the scheduler already drifts to 1-3.5h gaps, so 30-min nominal would be a no-op most of the time, and would cut the worst-case overlap with rebuilds in half. | **Low-medium** (depends on tick frequency observed) | **S** | §G overlap, §H status route |
| 11 | **Enable `track_io_timing = on`** so future `EXPLAIN (ANALYZE, BUFFERS)` against the top consumers can report per-op IO time. Tiny per-query overhead on modern Linux. Without it, when we get to fixing #2 or #4 we'll be flying blind on which plan node is the IO sink. | n/a (observability) | **S** (one ALTER SYSTEM, supabase support ticket if dashboard doesn't expose it) | §A |
| 12 | **`enrichment_queue` and `agencies` autoanalyze lag** — `enrichment_queue.last_autoanalyze = 2026-04-29` (25 days), `agencies.dead_pct = 24.2%`. Likely a per-table `autovacuum_analyze_scale_factor` would help once row counts are this small or this update-churny. Low priority — neither table is hot enough to matter. | **Low** (planner accuracy on tiny tables) | **S** | §F bloat |

### Finding #4 — outcome (IOWait Round 1, FIX-C / FIX-360)

**Branch A — index missing.** The `entity_connections` index list at
investigation time (local, 2026-05-24):

```
entity_connections_from         (from_type, from_id)              128 MB
entity_connections_to           (to_type,   to_id)                 59 MB
entity_connections_type         (connection_type)                  35 MB
entity_connections_amount       (amount_cents) WHERE NOT NULL      23 MB
entity_connections_derived_at   (derived_at)                       35 MB
entity_connections_evidence_source                                 36 MB
entity_connections_strength     (strength DESC)                   117 MB
entity_connections_from_type_from_id_to_type_to_id_connecti_key   470 MB
entity_connections_pkey         (id)                              227 MB
```

No index leads with `from_id` alone. The `(from_type, from_id)` composite
and the 5-column unique constraint both lead with `from_type` — when the
caller's WHERE omits `from_type`, those indexes are unusable as seeks.
The planner falls back to scanning `(from_type, from_id)` for the matching
`from_id` across every `from_type` value, then filtering by
`connection_type` row-by-row.

`EXPLAIN (ANALYZE, BUFFERS)` on the audit's query #9 shape against local
(2.52M rows; busiest `from_id = c07a4ff4-6998-4a04-a02e-aaf98f5aa716`
with 2,998 connections, none of type `'donation'`) before adding the
index:

```
Limit  (cost=0.43..2113.03 rows=50 width=16) (actual time=117.701..117.703 rows=0 loops=1)
  Buffers: shared read=15998
  ->  Index Scan using entity_connections_from on entity_connections
        Index Cond: (from_id = 'c07a4ff4-...'::uuid)
        Filter: (connection_type = 'donation'::connection_type)
        Rows Removed by Filter: 2998
        Buffers: shared read=15998
Execution Time: 117.745 ms
```

After adding `entity_connections_from_id_connection_type (from_id,
connection_type)`:

```
Limit  (cost=0.43..172.64 rows=50 width=16) (actual time=0.024..0.024 rows=0 loops=1)
  Buffers: shared read=3
  ->  Index Scan using entity_connections_from_id_connection_type
        Index Cond: ((from_id = 'c07a4ff4-...'::uuid) AND (connection_type = 'donation'::connection_type))
        Buffers: shared read=3
Execution Time: 0.062 ms
```

5,300× buffer reduction (15,998 → 3), 1,900× execution time reduction
(117.7 ms → 0.06 ms). On prod's 5.18M-row table the absolute numbers
will be larger but the shape change is the same: tight two-key seek
replaces a per-row filter scan. Ships in
`supabase/migrations/20260524100002_fix_c_entity_connections_from_id_connection_type_idx.sql`.

### FIX-346 closure

Section F confirms autovacuum has caught up on `financial_relationships`
(`autovacuum_count: 33`, `last_autovacuum: 2026-05-13`, `dead_pct:
11.9%`). FIX-346 is closable. Per the docs/FIXES.md workflow this is a
`Closes: FIX-346` with `Verified: closes-as-recognized`, handled in a
separate commit by Craig.

---

## Verification footer

- All probes were SELECT-only against `pg_stat_*`, `pg_class`,
  `pg_settings`, `pg_index`, `pg_indexes`. No INSERT/UPDATE/DELETE/
  ALTER/DROP/VACUUM/REINDEX executed.
- Script source preserved at
  [packages/data/src/scripts/iowait-diagnosis.ts](../../packages/data/src/scripts/iowait-diagnosis.ts);
  alongside JSON dump at
  [docs/audits/2026-05-24-iowait-diagnosis.json](2026-05-24-iowait-diagnosis.json)
  so any claim can be reproduced from `pnpm --filter @civitics/data
  data:iowait-diagnosis`.
- Active env at every probe was prod
  (`https://xsazcoxinpgttgquwvuf.supabase.co`). Restored to dev at end
  of session: see the closing line.

---

## Restoration

```
PS C:\…\App> Copy-Item .env.local.dev .env.local
PS C:\…\App> grep ^NEXT_PUBLIC_SUPABASE_URL .env.local
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
```

---

## Round 2 — drops (2026-05-24 / FIX-364 + FIX-366)

Working-set shrink batch. FIX-365 (FIX-B, donor_fingerprint_pattern) was
redirected to FIX-367 after pre-ship grep found a live `.like(...)` callsite
in the EDGAR matcher — that index stays. FIX-364 (FIX-A) and FIX-366 (FIX-C)
shipped.

**Pre-flight + measurement script:**
[docs/audits/scratch/2026-05-24-round2-prod-measurement.ts](scratch/2026-05-24-round2-prod-measurement.ts)
([pre-flight verification script](scratch/2026-05-24-round2-preflight.ts)).
Both read-only against prod. Migrations:
[20260524230000_fix_a_drop_unused_indexes.sql](../../supabase/migrations/20260524230000_fix_a_drop_unused_indexes.sql),
[20260524230001_fix_c_drop_duplicate_indexes.sql](../../supabase/migrations/20260524230001_fix_c_drop_duplicate_indexes.sql).

### Indexes dropped (verified `idx_scan = 0` immediately before drop)

| Table | Index | Pre-drop size | Pre-drop idx_scan | FIX |
|---|---|---:|---:|---|
| `entity_connections` | `entity_connections_strength` | 468 MB | 0 | FIX-364 |
| `financial_relationships` | `financial_relationships_metadata_gin` | 246 MB | 0 | FIX-364 |
| `entity_connections` | `entity_connections_amount` | 123 MB | 0 | FIX-364 |
| `financial_entities` | `financial_entities_display_trgm_individual` | 117 MB | 0 | FIX-364 |
| `financial_relationships` | `financial_relationships_occurred_at` | 72 MB | 0 | FIX-364 |
| `proposals` | `shadow_proposals_search_vector` | 12 MB | 0 | FIX-364 |
| `external_source_refs` | `external_source_refs_metadata_gin` | 11 MB | 0 | FIX-364 |
| `officials` | `officials_full_name_trgm` | 6.5 MB | (duplicate — kept `idx_officials_name_trgm`) | FIX-366 |
| `agencies` | `agencies_name_trgm` | 120 kB | (duplicate — kept `idx_agencies_name_trgm`) | FIX-366 |
| `graph_snapshots` | `idx_graph_snapshots_code` | 8 kB | (non-unique dup — kept UNIQUE `graph_snapshots_code_key`) | FIX-366 |

### `pg_total_relation_size` deltas on prod (top-3 tables)

Captured via the prod-measurement script immediately before / immediately
after `supabase db push --linked`.

| Table | Before total | After total | Δ total | Before indexes | After indexes | Δ indexes |
|---|---:|---:|---:|---:|---:|---:|
| `entity_connections` | 4998 MB | 4407 MB | **-591 MB** | 2737 MB | 2146 MB | **-591 MB** |
| `financial_relationships` | 4572 MB | 4254 MB | **-318 MB** | 2225 MB | 1907 MB | **-318 MB** |
| `financial_entities` | 2491 MB | 2374 MB | **-117 MB** | 1027 MB | 910 MB | **-117 MB** |
| **SUM (top-3)** | **12061 MB** | **11035 MB** | **-1026 MB** | **5989 MB** | **4964 MB** | **-1025 MB** |

Total bytes freed on top-3 tables: **1,075,404,800** (~1.00 GB). Matches
the sum of dropped index sizes for those tables exactly (591 + 318 + 117 =
1026 MB), confirming no other writes happened in the push window.

The proposals + external_source_refs + FIX-366 duplicate drops (~30 MB
combined) shrink smaller tables not represented in the top-3 row.

### What was NOT dropped

- `financial_entities_donor_fingerprint_pattern` (166 MB, text_pattern_ops)
  — pre-ship grep found a live `.like("donor_fingerprint", "<canonical>|%")`
  call at [packages/data/src/pipelines/edgar/matcher.ts:88](../../packages/data/src/pipelines/edgar/matcher.ts)
  (FIX-253 EDGAR matcher). Index kept; investigation of whether its 166 MB
  is worth the per-weekly-EDGAR-run usage is redirected to FIX-367.
- `votes_roll_call_id_official_id_key` (65 MB UNIQUE constraint) — excluded
  by explicit Craig decision; kept for insert-idempotency protection.

### Working-set ratio after Round 2

- `shared_buffers` = 256 MB (unchanged — that's a tier-level setting)
- Top-3 working set: 12061 MB → 11035 MB (**~8.5% shrink**)
- `shared_buffers` / top-3 ratio: 2.12% → 2.32%
- `effective_cache_size` (768 MB) / top-3 ratio: 6.37% → 6.96%

The headline ratio is still tight — Round 3 (incremental
`rebuild_entity_connections`, audit Finding #1) is where the
larger lever is. Round 2 freed enough working-set room that
post-cutover index pages have ~17% more headroom inside `shared_buffers`
on the entity_connections table specifically (2737 → 2146 MB indexes,
fits the same 256 MB cache "fewer times over"). Post-push cache rewarm
will surface as `hit_pct` recovery in pg_stat_statements over the next
4-6 hours; re-run `pnpm data:iowait-diagnosis` then to capture it.

---

## Round 2 — sunburst route measurement

Two route shapes from [apps/civitics/app/api/graph/sunburst/route.ts](../../apps/civitics/app/api/graph/sunburst/route.ts)
flagged in the FIX-360 after-commit report. Captured against prod immediately
after the Round 2 push (so the freed index pages have not yet been re-used
by other workloads — same plan shape as before the push, validated by the
"BEFORE" capture being identical structurally).

High-degree probe `from_id` picked at runtime: `37164e8b-fa41-44ca-9b5b-4ab210286e81`
(15,484 connections — the busiest single from_id on prod).

### Shape 1 — `vote_categories` mode (route line 372-378)

```sql
SELECT connection_type, to_id, strength
FROM public.entity_connections
WHERE from_id = $1
  AND connection_type = ANY ($2::connection_type[])
LIMIT 200;
```

```
Limit  (cost=0.43..182.41 rows=200 width=25) (actual time=0.021..0.021 rows=0 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using entity_connections_from_id_connection_type on entity_connections
        Index Cond: ((from_id = '37164e8b-...'::uuid) AND (connection_type = ANY ('{vote_yes,vote_no,vote_abstain,nomination_vote_yes,nomination_vote_no}'::connection_type[])))
        Buffers: shared hit=6
Planning Time: 0.127 ms
Execution Time: 0.043 ms
```

**Healthy.** Two-key seek on the FIX-360 compound index, 6 shared-buffer
hits, all cache. The high-degree probe entity has zero connections of
`vote_*` type (it's not an official) — but the plan shape is what we're
auditing, and it's tight. No additional index needed.

### Shape 2 — `connection_types` default mode (route line 431-434)

```sql
SELECT connection_type, to_id, strength, amount_cents
FROM public.entity_connections
WHERE from_id = $1
LIMIT 200;
```

```
Limit  (cost=0.43..176.96 rows=200 width=33) (actual time=0.021..0.108 rows=200 loops=1)
  Buffers: shared hit=11
  ->  Index Scan using entity_connections_from_id_connection_type on entity_connections
        Index Cond: (from_id = '37164e8b-...'::uuid)
        Buffers: shared hit=11
Planning Time: 0.100 ms
Execution Time: 0.137 ms
```

**Healthy.** The planner walks the FIX-360 compound index using `from_id`
alone (leading column), early-terminates at LIMIT 200. 11 shared-buffer
hits, all cache, 0.14 ms execution. The 17,418 estimated rows for this
from_id (matches the runtime-pick of 15,484 connections) confirms it's
the worst case in the table.

### Verdict

**No follow-up FIX warranted from sunburst measurement.** The FIX-360
compound index (`entity_connections_from_id_connection_type`) serves both
sunburst shapes with sub-millisecond execution and small bounded buffer
counts. The plan was already optimal before Round 2; Round 2's index
drops don't change the read path for entity_connections sunburst queries
(none of the dropped indexes were on the hot path for these shapes).

The FIX-360 after-commit report's worry — that sunburst routes might need
additional indexes — turns out to be unfounded against the current data
shape. If a future workload pattern (e.g., a "top X connection types for
this from_id" aggregation) materializes, that's a separate spec.
