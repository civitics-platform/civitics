# 2026-06-14 — Weekly pipeline timeout remediation

Investigation of the two prod workflows that both died the night of Sun 2026-06-14,
and the remediation (FIX-586..589). Source: GHA run logs + read-only prod psql audit.

## Incident

| Workflow | Run | Outcome | Symptom |
|---|---|---|---|
| `nightly-sync` enrichment-phase | 27490940863 | cancelled @ 2h cap | 125 `canceling statement due to statement timeout`; never reached daily MV/AI tail |
| `rebuild-entity-connections` (full) | 27496446207 | cancelled @ 4h budget | `donations_full` FAILED at the 90min statement cap; `votes_full` 71.6min |

`rebuild-entity-connections` full mode has now failed **3 Sundays running** (5/31 fail,
6/7 + 6/14 cancelled); Wed incrementals still pass (~1.5h).

## Root cause

All failures are the same class: writes/reads against the now-large tables
(`financial_relationships` ~4M, `financial_entities` ~790k, `votes`, `entity_connections`)
blow prod's statement_timeout on a cache-starved Pro Small instance.

**Prod per-role `statement_timeout`** (audited 2026-06-14, `pg_roles.rolconfig`):

| role | statement_timeout | path |
|---|---|---|
| anon | 3s | public client |
| authenticated | 8s | RLS client |
| authenticator | 8s (+ lock_timeout 8s) | PostgREST login role |
| service_role | *(none → inherits authenticator 8s)* | `createAdminClient()` — **all pipelines** |
| postgres (direct via pooler) | 2min (raisable to 90min) | the direct-pg fix path |

So `createAdminClient()` is effectively **8s-capped**. The direct-pg path (postgres role,
`lib/heavy-rebuild.ts` / `lib/direct-pg-upsert.ts`) raises the session timeout to 90min and
sidesteps both the 8s role cap and the ~100s PostgREST gateway cap.

**Server config** (same audit): `shared_buffers` = **256 MB**, `effective_cache_size` = 768 MB,
`work_mem` = 3.4 MB, `max_connections` = 60. Top-3 table working set ~12.5 GB → ~2% buffer-hit
on sequential scans (see `2026-05-24-iowait-diagnosis.md`). Cache thrash is structural.

## What was fixed (FIX-586 / FIX-587 — landed code)

Four admin-PostgREST paths routed through direct-pg (same pattern as FIX-462/463/443):

1. **USASpending writer** — was the fatal: 500-row `.upsert()` + `.in()` ref-lookup → `withDirectClient`
   + `bulkUpsert`, one client per file, `= ANY($1)` lookup, ON CONFLICT on the FULL `usaspending_award_id` index.
2. **LittleSis hop-1 resolve/insert** — per-entity RPC + INSERT (50-concurrent) → new `withDirectPool`
   (node-pg Pool, max 10, per-conn 90min), positional `resolve_entity_by_canonical` SQL.
3. **primary-source refresh** (n=90484) → new `refreshPrimarySourceDirect` helper.
4. **FEC `rebuild_financial_entity_donation_totals`** (100s gateway cap) → `runHeavyRebuild` allow-list.

Verified local: typecheck + build clean; direct-pg smokes pass for both rewritten writers.

## Still open

- **FIX-588** — `rebuild_entity_connections` full mode: keyset-batch `donations_full` by `from_id`
  window; EXPLAIN/keyset `votes_full`; alert on donations-chunk failure (fails-open silently today).
  Per-function `statement_timeout` GUCs are **no-ops through the session pooler** — confirmed by
  `votes_full` running 72min under a 15min function GUC. *Collides with in-flight FIX-583/584 edits to
  `rebuild-entity-connections.ts` — sequence after that lands.*
- **FIX-589 / Tier 4** — compute-tier decision (below).

## Tier 4 — compute-tier upgrade analysis (FIX-589)

The direct-pg fixes route *around* cache starvation; they don't cure it. The structural lever is
more RAM → larger `shared_buffers` so the hot working set stops thrashing.

Supabase compute add-on ladder (RAM → Postgres `shared_buffers`, which Supabase sets ≈ RAM/4):

| Tier | RAM | ~shared_buffers | Effect on the timeout class |
|---|---|---|---|
| **Small (current)** | 2 GB | ~256 MB | 2% buffer-hit on the 12.5 GB working set — the binding constraint |
| Medium | 4 GB | ~512 MB | ~2× buffers; helps but still « working set |
| Large | 8 GB | ~1–2 GB | materially fewer seq-scan re-reads on the hot tables |
| XL | 16 GB | ~4 GB | working set largely resident; the timeout class mostly disappears |

> **Exact monthly $ must be read off the dashboard** (Settings → Add-ons → Compute) — Supabase
> compute pricing changes and is billed hourly; do not quote a figure from memory. Directionally each
> step up is roughly 2× the prior add-on's monthly cost.

**Recommendation:** the direct-pg fixes (FIX-586/587) + the rebuild re-architecture (FIX-588) keep the
*pipelines* green on Small, so an upgrade is **not required to stop the failures**. But the same cache
starvation also degrades the *request-path* graph/search queries (FIX-499/503/505). If those cold-cache
read-path timeouts remain painful after the FIX-503 family, **Large** is the cost-effective step — it
brings `shared_buffers` to ~1–2 GB, the first tier where the hot indexes stay resident. XL only if the
request path needs the full working set warm. Decision is Craig's (cost-sensitive); revisit after
FIX-588 lands and a clean full rebuild + enrichment run is observed.
