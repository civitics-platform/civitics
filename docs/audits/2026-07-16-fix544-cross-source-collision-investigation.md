# FIX-544 — cross-source canonical-collision residue: investigation & gated merge

**Date:** 2026-07-16
**Author:** Claude Code session (FIX-544)
**Outcome:** Org-only, gated merge implemented as
`packages/data/src/scripts/merge-cross-source-fe-collisions.ts`
(`data:merge-fe-collisions`). Individuals: 0 merged. Local-proven; prod apply
pending (see end).

---

## What FIX-544 tracked

The FIX-380 closeout (`docs/audits/2026-06-09-littlesis-intra-source-dedup-finding.md`)
flagged that the LittleSis dedup pressure had moved **cross-source**: a
LittleSis-bound `financial_entities` row sharing a `canonical_name` with non-LS
(FEC / IRS / EDGAR / USASpending) rows — nominally **3,414 clusters / ~20,786
collapsible rows**. FIX-544 was to investigate signal quality and design a gated
merge (never a bulk name-merge, per the FIX-273 lesson).

## Re-measurement (live prod, 2026-07-16) — the 3,414 does NOT reproduce

Cluster = `(canonical_name, entity_type)` with exactly one LittleSis-bound FE +
≥1 non-LS FE.

| Metric | Value |
|---|--:|
| Total clusters | **54,055** |
| Collapsible non-LS rows | **182,091** |

Segmented by the **strength of the non-LS partner**:

| Non-LS partner | Clusters | Note |
|---|--:|---|
| Bare, unbound FEC individual-donor row | **53,555** | ~99% `individual` — common-name collisions |
| USASpending-recipient only | **464** | orgs / contractors |
| FEC-committee / IRS / EDGAR-bound | **36** | all non-individual |

**Why it is ~15× the audit's figure:** `financial_entities.canonical_name` for
FEC individuals is the bare natural-order name — the zip lives only in the
separate `donor_fingerprint` UNIQUE column — so one name legitimately spans many
*different people*. Example: **ADAM BECK** = 6 FEC donor rows across MA/NH/DC/DC/
OR/WA with unrelated employers (AHIP attorney, Vigor Marine ops, self-employed
physician…) + 1 LittleSis Adam Beck. Every individual cluster is shaped like
this.

Best reconstruction of the original 3,414: it was the *bound-partner* residue on
the 2026-06-09 snapshot, which has since **shrunk to ~500** (36 FEC/IRS/EDGAR +
464 USASpending) as `resolve_entity_by_canonical` dedups new org ingest, while
the *individual* bare-partner noise **grew**. The exact figure is not recoverable
without the original query.

## Signal quality

- **Individuals — false positives, no usable signal.** FIX-271 already ships the
  only safe individual rule (merge only clusters with *exactly one* FEC donor
  row). On the prod-clone that is **762 eligible** clusters (1,072 loser rows);
  the other **20,653** are multi-FEC = multiple real people, correctly excluded.
  Even the 762 have no corroborating signal — an LS stub shares nothing with the
  single FEC donor beyond the name. **Decision: merge 0 individuals.**
- **36 FEC-committee clusters** — LittleSis *profiles* of named committees
  (END CITIZENS UNITED, CONGRESSIONAL LEADERSHIP, LATINO VICTORY FUND, BEN CARDIN
  FOR SENATE…) + the real FEC committee. LS rows carry `external_relationships`
  (31/35), FEC rows carry `financial_relationships` (37/37) — **complementary**
  edge sets, so a merge *unions* board-side + money-side edges. Trap: ~5–6 are
  distinct committees sharing a name — e.g. COALITION FOR PROGRESS `C00582841`
  vs the LS row's own `C00948075` (also OUR FUTURE UNITED, UNITED WE DREAM
  ACTION, WORKING AMERICA, COLLINS FOR CONGRESS; GREAT AMERICA / HEAL AMERICA
  have two FEC committees each). Gate: exactly one FEC committee row in the
  cluster, and the LS loser carries no `fec_committee_id`.
- **166 non-committee org clusters** (FIX-271 org shape) — a source-bound org
  (LittleSis / USASpending / EDGAR / IRS) + unbound same-name stub(s).
  Distinctive corp names (CARDINAL HEALTH, COVINGTON & BURLING LLP, CONSUMER
  BANKERS ASSOCIATION, EDISON INTERNATIONAL) are genuine dupes; generic phrases
  (COMMON SENSE, DEMOCRACY FOR AMERICA) are ambiguous.

A regex "org-suffix" distinctiveness guard was rejected — it drops obvious real
dupes (EDISON INTERNATIONAL, BROOKDALE SENIOR LIVING, EVENTBRITE, FEDERATION OF
AMERICAN HOSPITALS…). The **exactly-one-binding** gate already guarantees a
single source-verified survivor, which is the operative safety property.

## Merge predicate (org-only, gated) — implemented

Two disjoint, non-individual populations by `(canonical_name, entity_type)`:

- **P3 committee dupes:** exactly 1 `fec_committee_id` row (the FEC committee is
  the source-verified survivor). Losers = same-name non-committee rows that are
  either LS profiles (`littlesis` xsr) OR unbound stubs (no source binding).
  Other-bound rows (usaspending / edgar / irs, not LS) are LEFT — a same-named
  federal-contractor/filer identity may be genuinely distinct. Multi-committee
  clusters (distinct committees sharing a name) excluded.
- **P2 non-committee org dupes:** `fec_committee_id IS NULL`, no committee row in
  the canonical, ≥2 rows, exactly 1 source-bound row. Winner = the bound row;
  losers = unbound stubs. Multi-binding clusters (e.g. CARDINAL HEALTH:
  usaspending + littlesis) excluded and left for a future edge-confirmed pass.

**Projected ≈ 275 loser rows → ~168 surviving winners** (local prod-clone;
re-measure on prod). Most losers are \$0 edgeless stubs, so the value is graph
edge-union (LittleSis board/exec edges land on the FEC committee — e.g. END
CITIZENS UNITED gained the `littlesis:244516` provenance + 12 board edges), not
donation totals.

## FK merge surface — GREW since the 2026-05-25 audit

The 2026-05-25 audit (`docs/audits/2026-05-25-fe-fk-surface-audit-*.md`)
enumerated 11–12 tables. Re-confirmed on the prod-clone (Pass B), the current
FE-ref surface the merge must handle:

**FK-rewrite (loser id → winner id):**
`financial_relationships`, `external_relationships`, `external_source_refs`,
`edgar_companies`, `edgar_executive_officers`, `edgar_major_shareholders`,
`irs990_filings`, `irs990_officers.matched_entity_id`,
`irs990_grants_out.matched_entity_id`, `financial_entities.parent_entity_id`,
`entity_tags`, `enrichment_queue`, `ai_summary_cache`
— plus **new since 2026-05-25**: `evidence_cards` (from/to; 14+3 FE rows),
`synthetic_entities` (entity_id; 8 FE rows), and the
`entity_comments` / `entity_positions` / `entity_statements` /
`entity_activity_state` / `position_events` / `synthetic_position_rollup` family
(FE allowed by CHECK; 0 FE rows today, rewritten defensively).

**Delete-affected, let scheduled rebuilds repopulate** (per FIX-544 decision):
`entity_connections`, `entity_search_index`, `group_donor_rollup`, and the
`entity_connection_stats_next` / `donor_party_rollup_next` staging tables when
present. Graph/search stale up to a few days until the twice-weekly
`rebuild_entity_connections` + pg_cron rollup refreshes run.

## Verification (in-transaction, aborts the merge on any failure)

- `SUM(total_donated_cents)` and `SUM(total_received_cents)` across
  `financial_entities` unchanged (loser totals fold into winners).
- FE row count = pre − losers.
- Post-merge eligible residue (P3 + P2) = 0.
- No core FK table still references a deleted loser id.

## Status

- **Local (prod-clone):** dry-run + apply proven; invariants hold; residue → 0.
- **Prod:** apply pending. The merge itself is small and surgical (~277 FK
  rewrites + scoped rollup deletes, one transaction) — NOT a heavy rebuild — but
  it was deferred this session because the Supavisor pooler was intermittently
  failing its auth query under investigation load. Apply with:
  `pnpm --filter @civitics/data data:merge-fe-collisions:prod -- --dry-run`
  then `-- --apply`, off-peak, then re-verify counts + a spot-checked merged
  entity. FIX-544 stays **open** until prod is applied and verified.

Cross-ref: FIX-271 (canonical FE-merge template), FIX-379 (preserve-data merge),
FIX-273 (common-name false-positive lesson), FIX-380 (predecessor finding).
