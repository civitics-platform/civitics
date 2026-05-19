# Request-Path Aggregation Audit — 2026-05-18

Systematic sweep for `count:'exact'`, per-enum-value query loops, and other
aggregations on the request path. Triggered after FIX-298 (a 16-query fan-out
in `getConnectionTypes` had been hiding a 9.5 s long pole inside
`/api/claude/status/core`). Scope per the PR brief: status-section helpers,
homepage Wave 1/2/3 fallback path, dashboard non-status sections, and any
`count:'exact'` hit on the big tables (`entity_connections`,
`financial_relationships`, `votes`, `proposals`, `officials`,
`api_usage_logs`).

Companion to [[FIX-301]] (this audit + inline fix), [[FIX-302]] (docs
codification of the materialization pattern in `packages/db/CLAUDE.md`), and
[[FIX-303]] (follow-up filed below for a finding that exceeds the
inline-fix criterion).

---

## Summary

| Bucket | Count |
|---|---|
| Total candidates examined | 11 |
| Fixed inline this PR | 1 |
| Filed as follow-up FIX | 1 |
| Already fine (correctly materialized / cheap / out of scope) | 9 |

The audit confirms the materialization pattern is now applied across every
high-cardinality long pole on the surfaces in scope. Remaining candidates are
either trivially cheap (small/filtered counts on indexed columns) or already
served from an MV / snapshot table. One real find is filed for follow-up
because it needs a new RPC + caller swap across two surfaces (out of the
inline-fix budget); the other lurking issue is a correctness bug rather than
a perf finding so it's noted but not actioned here.

---

## Inline fix applied this PR

### `checkDerivedDrift()` — 11 sequential `count:'exact'` on entity_connections → 1 RPC call

**File:** `apps/civitics/app/api/claude/status/_lib/sections.ts:495-518`

**Problem.** `getQuality()` calls `checkDerivedDrift()` to flag derivation
rules where the source table has rows but `entity_connections` has none
(FIX-157's drift detector). The derived side ran 11 sequential
`count:'exact'` queries against the 5.1 M-row `entity_connections` table —
one per rule, even though every count scans the same table on the same
indexed `connection_type` column. Exactly the FIX-298 shape but scoped to
the drift check.

`getQuality()` is invoked from the cron compute path that writes
`status_snapshot` (FIX-297), not on every request — so this isn't a
user-facing latency issue. But it's ~11 redundant index scans inside the
10-min cron, on the table whose size triggered FIX-298 in the first place.

**Fix.** Replace the 11-query fan-out with a single
`get_connection_type_counts()` RPC call (already exists from FIX-298) plus
a `Map<connection_type, total>` lookup. The RPC does one indexed GROUP BY
scan, returns one row per type present, and zero-fills any absent type via
`byType.get(r.type) ?? 0`.

```ts
const [sourceCounts, derivedRes] = await Promise.all([
  Promise.all(DRIFT_RULES.map((r) => r.source(db).then((res) => res.count ?? 0))),
  db.rpc("get_connection_type_counts"),
]);
const byType = new Map<string, number>();
for (const r of derivedRes.data ?? []) byType.set(r.connection_type, Number(r.total));
const drifted = DRIFT_RULES.flatMap((r, i) => {
  const source = sourceCounts[i] ?? 0;
  const derived = byType.get(r.type) ?? 0;
  return source > 0 && derived === 0 ? [{ type: r.type, source, derived }] : [];
});
```

No new migration (reuses FIX-298's RPC), no caller-side changes elsewhere.

---

## Follow-up filed (not in this PR): FIX-303

### `/agencies` page proposal-count fan-out — 200 × 2 = up to 400 sub-queries

**Files:**
- `apps/civitics/app/agencies/page.tsx:51-67`
- `apps/civitics/app/page.tsx:521-535` (smaller variant, 4 agencies on homepage Wave 2)

**Problem.** The `/agencies` route loads up to 200 active agencies and then
fires **two** `count:'exact'` queries per agency to compute totalProposals +
openProposals — up to 400 sub-queries hitting `proposals` per pageload.

The query filters on `metadata->>'agency_id'` (JSONB extraction) — there's
no functional index on the JSON path, so each count is potentially a partial
scan. Bigger blast than FIX-298 (16 queries) and on a smaller-but-still-
multi-table-join surface.

**Why not inline.** This is the same *shape* as FIX-298 (per-key loop →
GROUP BY + new RPC) but needs:
- A new RPC `get_proposal_counts_by_agency()` returning
  `(agency_id, total, open)` via two-axis GROUP BY on
  `(metadata->>'agency_id', status)` with a time filter on
  `metadata->>'comment_period_end'`.
- A new migration to ship that RPC + an index on `metadata->>'agency_id'`
  to back the GROUP BY (today the JSONB path is unindexed).
- Caller swaps in two places (`agencies/page.tsx` + homepage Wave 2's
  `agencyStatPairs` loop).
- A latent correctness bug to untangle in the open-proposals filter (see
  below).

That's three artifacts (RPC, index, two callers) plus a correctness fix —
beyond the single-query / single-loop criterion the PR brief draws for
inline changes. Filed as a self-contained follow-up.

**Latent correctness bug to fold into FIX-303.** `agencies/page.tsx:64`
filters `.gt("comment_period_end", now)` — but `comment_period_end` lives
on `metadata->>'comment_period_end'`, not as a top-level column on
`proposals`. PostgREST silently treats the missing column as "no filter
applied" → `openProposals` likely returns the same number as
`totalProposals` rather than open-only. (The homepage Wave 2 variant at
`page.tsx:533` got the JSONB path right — `metadata->>comment_period_end`
— so this drift only affects `/agencies`.)

---

## Out of scope but noted

### `OfficialCard.tsx` — broken `official_id` filter (correctness, not perf)

**File:** `apps/civitics/app/officials/components/OfficialCard.tsx:89-96`

The client-side `useEffect` runs two queries against `financial_relationships`
using `.eq("official_id", official.id)` — but `financial_relationships` has
no `official_id` column post-cutover. Donations to an official are keyed by
`(to_type='official', to_id=<id>, relationship_type='donation')`. PostgREST
silently returns 0 rows for the missing-column filter, so `donorCount` and
`totalDonations` always render `0` / `$0` for every card.

The homepage hit the same shape and was fixed by FIX-223 by replacing the
in-card loop with a read from `official_homepage_stats_mv`. `OfficialCard` is
a *client* component on `/officials`, so the same MV read can apply once the
component is restructured to take the stat fields as props (or via a
parent-side fetch). Pure correctness fix, not a perf finding — out of scope
for this PR. Worth filing on its own when next someone touches `/officials`.

---

## Already-fine inventory (audit scope)

These were examined and confirmed correct — listed so future audits can skip
them. Most have a `// FIX-NNN` comment in-line pointing at the fix that put
them in this shape.

| Site | Status | Why fine |
|---|---|---|
| `sections.ts:getDatabase` (11 counts in parallel) | ✓ | `count:'estimated'` on big tables (FIX-206), `count:'planned'` on filtered medium tables, `count:'exact'` reserved for `proposals_regulations` + `page_views_24h` which are cheap. Explicit comment block documents the rationale. |
| `sections.ts:getConnectionTypes` | ✓ | Single `get_connection_type_counts()` RPC (FIX-298). |
| `sections.ts:getPipelines` enrichment_queue counts | ✓ | 3 `count:'exact'` on enrichment_queue with composite `(status, enrichment_type)` filter — small index range, cheap. |
| `sections.ts:getQuality` vote_categories | ✓ | 5 `count:'exact'` × `proposals.vote_category`. Proposals table is small; cumulative cost is sub-100 ms even without aggregation. Not worth the RPC. |
| `sections.ts:getActivity` page_views | ✓ | Filtered to 24h with `is_bot=false`; indexed on `viewed_at`. Cheap. |
| `sections.ts:getSelfTests` warrenVotesRes, voteYesTotal | ✓ | One count each on `entity_connections` with `(from_id+connection_type)` and `(connection_type)` index ranges. Cheap. |
| `app/page.tsx` Wave 1 hero stats | ✓ | Served from `homepage_stats_mv` (FIX-223). The `count:'exact'` at line 360 is the defensive `donor_records_count` fallback only — runs only when the MV row is missing or returns 0. |
| `app/page.tsx` Wave 3 per-official stats | ✓ | Served from `official_homepage_stats_mv` (FIX-223). |
| `dashboard/page.tsx getOpenProposalCount` | ✓ | `count:'planned'` — pg_class.reltuples-derived, sub-ms. |
| `dashboard/page.tsx getInitialStatus` | ✓ | Served from `status_snapshot` (FIX-297) with 30-min staleness + live fallback. |
| `dashboard/page.tsx getOpenProposals / getBrowsingFlows / getManualMetrics` | ✓ | `.limit(3)` and dedicated RPCs respectively. No aggregation on big tables. |

---

## Cross-cutting observations (for the docs section)

Patterns surfaced during the audit that informed the
`packages/db/CLAUDE.md — Materialization pattern` section in this PR:

1. **`count:'estimated'` is underused as the cheap default.** Most of the
   "Common Mistakes Avoided" instances in `sections.ts:getDatabase` set
   `count:'estimated'` for the big-table unfiltered case (FIX-206); but
   several latent surfaces (`/api/notifications`, `/api/initiatives/*`)
   still use `count:'exact'` on tables that will grow. The docs section
   makes the mode-rationale comment from `getDatabase` discoverable so
   the next author can pick the right mode without rediscovering FIX-206.

2. **Per-enum-value loops are the FIX-298 trap.** Both the inline fix
   here (`checkDerivedDrift`) and the filed follow-up (`/agencies` page)
   are the same shape: an array of N values → N queries on the same
   table → one GROUP BY. Documenting the "single GROUP BY + Map lookup"
   recipe (with the `byType.get(x) ?? 0` zero-fill) inline in the
   materialization section gives future authors a copy-paste template.

3. **Snapshots as a "superset payload + multiple consumers" beat
   per-route snapshots.** `status_snapshot` already serves /core,
   /quality, AND the dashboard SSR with one 11-section payload — three
   surfaces, one snapshot. The docs section calls out this preference
   explicitly so the next person reaching for a snapshot doesn't
   accidentally fragment the surface.

4. **Function-level `statement_timeout` is mandatory for aggregation
   RPCs on tables > 1 M rows.** FIX-291 (rebuild_entity_connections
   chunked) and FIX-298 (get_connection_type_counts via
   `ALTER FUNCTION ... SET statement_timeout = '120s'`) both ran into
   service_role default timeouts on cold-cache aggregations. The docs
   section codifies the sizing rule.

---

## Bookkeeping

- **FIX-301** = this audit + the inline `checkDerivedDrift()` fix.
- **FIX-302** = `packages/db/CLAUDE.md` materialization-pattern section
  (shipped in the same PR).
- **FIX-303** = `/agencies` page proposal-count fan-out follow-up — filed
  in `docs/FIXES.md` for separate execution.
- **OfficialCard `official_id` bug** = noted in this audit but not filed
  — correctness bug, scope creep relative to the audit's perf framing.
  File when next touching `/officials`.
