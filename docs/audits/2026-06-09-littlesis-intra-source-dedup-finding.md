# LittleSis intra-source dedup — FIX-380 closeout finding

**Date:** 2026-06-09
**Author:** Claude Code session (FIX-294 PR)
**Outcome:** FIX-380 closed administratively (`closes-as-recognized`). No
shared-edge merge machinery built — there is nothing to merge on current data.

---

## What FIX-380 was tracking

FIX-380 (a follow-up to FIX-313) proposed a **shared-edge heuristic** to collapse
clusters of ≥2 LittleSis-bound `financial_entities` rows that share a
`canonical_name`: merge only when their `external_relationships` neighborhoods
overlap above a threshold, since the public LittleSis dump exposes no
`merged_into` field (confirmed 2026-05-25 — top-level keys are `aliases, blurb,
end_date, extensions, id, name, parent_id, primary_ext, start_date, summary,
tags, types, updated_at, website`).

The target was the **intra-source** residue: two distinct LS-bound FE rows of the
same `entity_type` that are really the same entity.

## Measurement (2026-06-09)

The clean-dupe case the shared-edge heuristic targets is: a
`canonical_name` + `entity_type` group containing **≥2 distinct** LS-bound
`financial_entity` rows. Query (run on both environments):

```sql
WITH ls_fe AS (
  SELECT DISTINCT fe.id, fe.canonical_name, fe.entity_type
  FROM external_source_refs r
  JOIN financial_entities fe ON fe.id = r.entity_id
  WHERE r.source = 'littlesis' AND r.entity_type = 'financial_entity'
)
SELECT count(*) AS true_clusters
FROM (
  SELECT canonical_name, entity_type
  FROM ls_fe
  GROUP BY 1, 2
  HAVING count(*) > 1
) q;
```

| Environment | `true_clusters` |
|---|---|
| Local Docker (prod clone, 2,458,904 FE rows) | **0** |
| Production (Pro, `xsazcoxinpgttgquwvuf`) | **0** |

Both environments return **zero** same-type distinct-FE clusters. There is no
intra-source LS×LS dupe residue left to merge.

If you ignore `entity_type` and group by `canonical_name` alone, only **9**
clusters surface — all of which are **cross-entity-type** (e.g. a person and an
org sharing a name), which must **not** be auto-merged. They are not what FIX-380
targeted.

## Why the earlier "~265 collapsible" number was wrong

The earlier estimate that motivated FIX-380's path (b) counted rows where
multiple LittleSis `ls_id`s bound to FE rows under one `canonical_name`. That
count was an **artifact of multiple LS ids pointing at a single, already-deduped
FE row** — i.e. many `external_source_refs` → one `financial_entity` — not
multiple distinct FE rows that needed collapsing. Counting `DISTINCT fe.id` (as
above) removes the artifact and the residue evaporates to 0.

## What actually closed the residue

- **FIX-273** — in-pipeline dedup (the LS dedup race fix) stopped new duplicate
  LS-bound FE rows from being created during ingest.
- **2026-05-25 merge bundles (FIX-313 / FIX-325 / FIX-379)** — collapsed the
  historical intra-source duplicates that predated FIX-273.
- **`resolve_entity_by_canonical`** on ingest prevents new same-canonical
  collisions from landing as fresh FE rows.

Together these eliminated the intra-source case the shared-edge heuristic was
designed for. Building that machinery now would be dead code against a 0-row
target.

## Where the dedup pressure actually moved — cross-source

The residue did not disappear; it **moved cross-source**. Measured 2026-06-09:
**3,414** `canonical_name` + `entity_type` clusters / **~20,786** collapsible rows
where exactly one LS-bound FE shares a `canonical_name` with one or more **non-LS**
(FEC / IRS / EDGAR) FE rows.

That is **FIX-271 cross-source-merge territory**, not FIX-380's shared-edge
heuristic, and it is higher-stakes: per the **FIX-273 lesson**, most
same-canonical multi-FE clusters are common-name *distinct people* that must never
auto-merge. It needs its own signal-quality investigation before any merge is
designed. Filed separately as **FIX-544** (cross-source canonical-collision
residue) — see `docs/FIXES.md`, `## GRAPH` section.

## Decision

Close FIX-380 as `closes-as-recognized`: the intra-source residue it tracked was
already resolved by prior work (FIX-273 + the 05-25 bundles); the surviving dedup
pressure is cross-source and tracked under FIX-544. No code change.
