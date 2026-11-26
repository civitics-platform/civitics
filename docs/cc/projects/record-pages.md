---
slug: record-pages
title: Record pages — the bill and officials pages show what Congress recorded
lanes: [app]
status: active
plan: handoff-2026-11-24b-wave-0-ratified-cc317-written-bill-page-mockup-published-stored-rolls-short-of-official-counts
steps:
  - {id: s1, kind: cc, ref: "cc-317", title: "wave 0 — the proposal page reads votes for every voted type, grouped by roll; recorded counts, never a result", done: 2026-11-26}
  - {id: s2, kind: cc, ref: "cc-325", title: "the officials page — the vote breakdown says what it counts; procedural from the roll question", done: 2026-11-26}
  - {id: s3, kind: cc, ref: "cc-327", title: "wave 1, the bill half — the congress.gov bill-details walker (FIX-1452) and the proposal_actions source key"}
  - {id: s4, kind: cc, ref: "", title: "per-roll official totals and results (FIX-1448)"}
  - {id: s5, kind: cc, ref: "", title: "bill and officials pages show sponsor, cosponsors, actions"}
  - {id: s6, kind: cc, ref: "", title: "wave 2: AI enrichment"}
---

# Record pages

The bill page and the officials page print what the record says and how much
of it is stored: a roll's recorded counts beside the source's own result
(FIX-1448), a measure's sponsor, cosponsors and actions, a member's bills
sponsored. The design of record is Cowork's wave-0 handoff (the mockup's
COLLECT blocks) and `handoff-2026-11-25e-app-lane-…` (the sizing).

- **cc-317** (wave 0) put votes for every voted type on the proposal page,
  one row per roll, through `proposal_vote_rolls(uuid)` (FIX-1447).
- **cc-325** made the officials page's vote breakdown say what it counts.
- **cc-327** (wave 1, the bill half) built the walker that fills sponsor,
  cosponsors, actions, real titles and introduced dates from congress.gov
  (`packages/data/src/pipelines/congress/bill-details.ts`, run by hand through
  `.github/workflows/bill-details.yml`; OPERATIONS §The bill-details walker),
  and re-keyed `proposal_actions` on `(proposal_id, source, source_key)`. Its
  prod fill did not run: `proposal_cosponsors` feeds the entity-connections
  rebuild's cosponsor arm, which would derive `co_sponsorship` edges (see the
  cc-327 report). FIX-1452 stays open until the voted measures are filled.

The three later steps have no prompt yet, so they carry no `ref`. How the
walker is scheduled is FIX-1453's.
