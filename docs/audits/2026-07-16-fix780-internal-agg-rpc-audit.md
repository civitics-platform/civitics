# FIX-780 — internal-aggregating request-path RPCs: cost audit

**Date:** 2026-07-16
**FIX:** FIX-780 (consolidated tail of the FIX-775 audit)
**Verdict:** **all leave-live** — materialize nothing. Two latent structural
risks filed as follow-ups (see bottom).
**Evidence:** prod `pg_stat_statements` (window since 2026-07-03 01:27 UTC, ~14
days) + direct `EXPLAIN ANALYZE` on prod (read-only).

---

## TL;DR

The nine candidate RPCs from the FIX-780 bullet aggregate `financial_relationships`
/ `entity_connections` inside the function body. The gate was: measure real prod
cost first, materialize **only** the confirmed-hot ones.

Result: **none is hot on the DB request path.** Over 14 days the busiest saw
**4 calls**; six saw **zero real calls**. All nine are `service_role`-EXECUTE
only (anon/authenticated REVOKE'd in FIX-834/835) and every calling route wraps
its response in `withPublicCdnCache` with a long `s-maxage` (3600–86400s). The
edge CDN absorbs virtually all traffic; the DB pays only on rare cache-miss /
revalidation. Materializing any of these would add refresh cost + staleness to
serve RPCs the CDN already reduces to a fraction of a call per day.

The bullet's candidate list is also **stale**: 5 of 9 already read a
materialized view or a pre-derived table.

---

## Cost table

Real calls = PostgREST `pgrst_source`-wrapped invocations only (GRANT/REVOKE DDL
and the FIX-717/718 monitoring query were filtered out — they otherwise
contaminate a naïve `ILIKE '%name%'` match; e.g. all the treemap 0.x-ms "calls"
were actually the FIX-834 REVOKE/GRANT statements).

| RPC | real calls (14d) | mean ms | max ms | worst-case (cold, measured) | reachable | verdict | reason |
|---|---|---|---|---|---|---|---|
| `treemap_recipients_by_contracts` | **0** | — | — | **>45s (timeout)** | service_role only; CDN `s-maxage=3600` | leave-live → **FIX-507** | Global agg over 3.24M contract rows → ~2M-group HashAggregate + 3.2M-row bitmap scan. Exceeds the 8s service_role ceiling, so any real cache-miss errors and the route caches `[]` for 1h. But 0 calls in 14d. Overlaps the FIX-507 contract-flow MV — route there. |
| `get_pac_treemap_by_sector` | 3 | 2658.4 | 5254.1 | ~5.3s | service_role; CDN 24h | leave-live | Already reads `donor_party_rollup_mv` (FIX-518). Re-aggregates per call (per-donor GROUP BY + industry windowing over the 11,448-row PAC subset) but under 8s; 3 calls/14d. |
| `chord_industry_flows_for_official` | 0 | — | — | **6.85s cold** (top-funded official, 2,831 donation rows); <4 ms warm | service_role; CDN 24h | leave-live | Per-official; served by covering index `financial_relationships_donor_rollup_idx`. Cold worst-case ~7s occurs only for the single #1 official (I/O-bound: `read=10562` pages of random heap/index fetches on the cache-starved Small). Nearly every other official is far smaller. |
| `chord_top_pacs_for_official` | 0 | — | — | bounded per-official (LIMIT 20) | service_role; CDN 24h | leave-live | Same covering index; no existing MV serves the per-PAC grain. |
| `chord_donor_brackets_for_official` | 0 | — | — | bounded (fr×fe only, no `entity_tags` join) | service_role; CDN 24h | leave-live | Cheapest of the three per-official chords. |
| `get_pac_treemap_by_party` | 4 | 75.0 | 91.6 | ~92 ms | service_role; CDN 24h | leave-live | Already MV-backed (`donor_party_rollup_mv`, FIX-518). Fast. |
| `get_group_sector_totals` | 1 | 82.6 | 82.6 | ~83 ms | service_role; CDN | leave-live | **Already materialized** — reads `official_sector_dollars_mv` (FIX-506). |
| `chord_sector_vote_for_officials` | 0 | — | — | fast | service_role; CDN | leave-live | **Already materialized** — sector CTE reads `official_sector_dollars_mv` (FIX-506); only the vote-outcome weighting is computed live over the tiny per-official vote set. |
| `get_group_connections` | 0 | — | — | fast (~0.2 ms) | service_role; CDN | leave-live | Reads the pre-derived `entity_connections` table (FIX-704 pipeline) with an indexed `from_id = ANY(...)` point read — already effectively materialized. |

### Ranking note (per the FIX-780 design gate)

Estimates are ceilings; ranking is by **real** mean/worst-case, not cumulative
total. The only two RPCs with a genuinely high single-call cost are
`treemap_recipients_by_contracts` (>45s, but **0** real calls) and
`get_pac_treemap_by_sector` (~2.6s mean, 3 calls). Neither clears the "hot on
the request path" bar. A high total from many cheap calls does not appear here —
the opposite holds: the totals are tiny because the CDN caches everything.

---

## Method

1. `pg_stat_statements` window: `stats_reset = 2026-07-03 01:27 UTC` → ~14 days.
2. Ranked candidates by real call count + mean/max exec time, filtering the
   PostgREST call shape (`query ILIKE '%pgrst_source%'`) to exclude DDL and the
   FIX-717/718 rollup-monitoring query (which md5's the function bodies and so
   matched a naïve name filter, injecting a spurious 16.2s outlier).
3. Reachability: checked `information_schema.routine_privileges` — all nine are
   `service_role`-EXECUTE only.
4. Request-path context: all nine are called via `createAdminClient()` in
   `apps/civitics/app/api/graph/{treemap-pac,spending,chord,sunburst}/route.ts`,
   each response wrapped in `withPublicCdnCache`.
5. Direct cost of the two structurally-heavy live-aggregators, measured on prod
   read-only with `EXPLAIN (ANALYZE, BUFFERS)` under a `statement_timeout` guard:
   - `treemap_recipients_by_contracts` body → **>45s** (timed out).
   - Heaviest per-official chord for the #1 most-funded official (2,831
     donation rows) → **6.85s** on cold cache (`read=10562` pages).

---

## Why leave-live is correct here

- **Not hot.** ≤4 DB calls/14d each; six at zero. The hotness criterion the
  gate set is not met by any candidate.
- **Not anon-reachable.** service_role-only; no `POST /rpc/` path a bot can
  hammer. Traffic arrives only through the route handler.
- **Already edge-cached.** Long `s-maxage` on every route means the DB cost is
  incurred on cache-miss/revalidation only.
- **Half already materialized.** 5 of 9 read an MV / derived table.
- Materializing would trade near-zero DB cost for real refresh cost + staleness.

---

## Follow-ups filed (not fixed here)

1. **`treemap_recipients_by_contracts` >8s on any real cache-miss** (**FIX-838**) →
   materialize via the **FIX-507** contract-flow MV. On a cold cache-miss it exceeds the 8s
   service_role ceiling, errors, and the route CDN-caches an empty `[]` for 1h.
   It happens to have 0 traffic today so nobody sees it, but it is a latent
   correctness bug, not just a perf one. Owner = FIX-507 (contract-flow MV
   design); this audit is the concrete surface that needs it. Filed as a
   follow-up cross-referencing FIX-507.

2. **Per-official chord modes ~7s cold for top-funded officials** (**FIX-839**) → optional.
   The only clean zero-new-refresh path is reusing `official_sector_dollars_mv`
   (FIX-506) for the `chord_industry_flows_for_official` mode, but that MV INNER
   JOINs `entity_tags` (excludes the `untagged` bucket the RPC currently emits
   via LEFT JOIN), so it is a semantics change requiring its own verification,
   not a drop-in. `chord_top_pacs_for_official` / `chord_donor_brackets_for_official`
   have no existing MV at their grain and would need new per-official rollups —
   not justified by 0 traffic. Filed low-priority.
