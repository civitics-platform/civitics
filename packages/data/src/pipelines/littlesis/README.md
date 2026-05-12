# LittleSis ingestion pipeline (FIX-251)

## Attribution — required by license

> Data ingested by this pipeline is sourced from **LittleSis**
> (<https://littlesis.org>), a project of the Public Accountability Initiative.
>
> LittleSis data is licensed under the **Creative Commons
> Attribution-ShareAlike 4.0 International** license:
> <https://creativecommons.org/licenses/by-sa/4.0/>
>
> Any derivative dataset Civitics publishes that contains rows derived from
> LittleSis (rows in `external_relationships` where `source='littlesis'`, plus
> any `entity_connections` edge whose `evidence_source='external_relationships'`
> aggregates a LittleSis row) **must also be licensed CC-BY-SA 4.0 and
> attribute LittleSis**.

The attribution string is also embedded in the pipeline source
(`util.ts:ATTRIBUTION`), the migration that creates `external_relationships`
(`supabase/migrations/20260511000001_external_relationships.sql`), and the
RPC extension migration. Any new surface that exposes LittleSis-derived edges
to end users must surface attribution per CC-BY-SA 4.0.

## What this pipeline ingests

LittleSis publishes two daily-ish gzipped JSON bulk dumps:

- `entities.json.gz`        — every person + organization in LittleSis (~600k records)
- `relationships.json.gz`   — every relationship between them (~1M+ records)

We ingest a **2-hop** subset of that graph:

1. **0-hop edges** — both endpoints already exist as Civitics entities
   (officials, financial_entities). These are the highest-value rows.
2. **1-hop entities** — LittleSis entities one edge away from a known
   Civitics entity. These are inserted as new `financial_entities` rows
   keyed via `external_source_refs` (source='littlesis').
3. **2-hop edges** — relationships between any combination of the anchor
   set and the 1-hop set.

LittleSis category 5 (Donation) is intentionally dropped — FEC bulk is
authoritative for campaign donations and overlapping rows would skew totals.
See `util.ts:SKIPPED_CATEGORIES`.

## Category → connection_type mapping

| LittleSis cat | Name        | connection_type     | Notes                                |
|---------------|-------------|---------------------|--------------------------------------|
| 1             | Position    | `appointment`       | reuses existing enum                 |
| 3             | Membership  | `member_of`         | new in migration `…000000`           |
| 5             | Donation    | **DROPPED**         | FEC authoritative                    |
| 6             | Transaction | `business_partner`  | reuses existing enum                 |
| 7             | Lobbying    | `lobbying`          | deduped vs FR.lobbying_spend in RPC  |
| 10            | Ownership   | `owns`              | new                                  |
| 11            | Hierarchy   | `parent_of`         | new — entity1 is parent of entity2   |
| 12            | Generic     | `affiliated_with`   | new — weakest strength               |

## Matching is deterministic-only

No AI in the default code path. The matcher (`matcher.ts`) uses
`canonicalizeEntityName` (mandatory cross-pipeline normalizer from
`fec-bulk/writer.ts`) + last-name index + first-name 3-char prefix + state
hint parsed from LittleSis `types`/`aliases`.

Confidence levels:

- **high** — exact canonical match, single candidate (or single after state-narrow)
- **medium** — single candidate, narrowing wasn't possible but no other candidates competed
- **queue** — 2+ candidates that survive narrowing → `external_relationships_review_queue`
- **miss** — zero candidates; entity becomes a hop-1 `financial_entity` if a future edge references it

Ambiguous matches are stored in `external_relationships_review_queue` for
future human-in-the-loop resolution. They are **never** auto-linked.

Person matching uses an alphabetical-token sort key so that
`"Elon Musk"` (LittleSis FIRST-LAST) and `"MUSK ELON R"` (FEC indiv
LAST-FIRST-MIDDLE) hash to the same lookup key.

## Idempotency

Run again on the same dumps → zero new rows:

- `external_relationships UNIQUE(source, source_id)` — LittleSis relationship id
- `external_source_refs UNIQUE(source, external_id)` — LittleSis entity id binding
- `financial_entities UNIQUE(canonical_name, entity_type)` — hop-1 entity dedup
- `pipeline_state.littlesis_state.{entities_sha, relationships_sha}` — both
  SHA256s match → `skipSync(reason='dumps_unchanged')`, full pipeline
  short-circuits

To bypass the freshness gate (e.g. after a schema change that reshapes
metadata), pass `--force`:

```bash
pnpm --filter @civitics/data data:littlesis -- --force
```

## Memory profile + abort thresholds

`expand.ts:pass1AnchorMatch` holds the parsed entity payload in memory through
pass 2 + pass 3 so hop-1 materialization can find each entity by its
LittleSis id. LittleSis ships ~600k entities; ~500 bytes parsed each →
~300 MB. Hard abort if RSS exceeds 1.5 GB or `byId.size > 2_000_000`.

Run with `NODE_OPTIONS=--max-old-space-size=4096` (4 GB) or higher. Default
Node heap is 4 GB on most environments so the pipeline runs without override
for current dump sizes.

Peak RSS is captured automatically by `completeSync` → `metadata.peak_rss_mb`.
Duration is `completed_at - started_at` in `data_sync_log`.

## What this pipeline does NOT do

- **It does not write `entity_connections` directly.** That table is
  derivation-only post-cutover (see `packages/db/CLAUDE.md`). Edges are
  materialized by the nightly `rebuild_entity_connections()` RPC, which now
  has a block 10 aggregating from `external_relationships`.
- **It does not use the LittleSis API.** The API is reserved for future
  incremental hydration (per-entity lookups when a user views an
  unseen-in-bulk profile). Initial seed is bulk-only.
- **It does not auto-merge ambiguous matches.** Low-confidence matches sit
  in the review queue until a human-in-loop FIX (planned FIX-252) drains them.

## Surfaces that need attention later

- **FIX-252** — UI attribution. The graph snapshot route surfaces
  `evidence_source` but no page renders a "Sources & Licenses" footer
  attributing LittleSis. Add to `/about` (or create one) before any UI
  surfaces these edges to end users. CC-BY-SA 4.0 attribution is a hard
  license obligation.
- **Removed-upstream edges.** LittleSis rarely retracts relationships.
  v1 doesn't tombstone vanished rows on re-fetch; the row stays until
  manually cleaned. Track if it becomes a problem.
