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
  - {id: s3b, kind: design, ref: "FIX-1453", title: "the bill-details walker's schedule: a dispatcher unit beside crs-summaries (cc-318's D3 row — stale_after 2 hours, group proposals, yield_to nightly, 15-minute runs through a bill-details-request target). Waits on the co_sponsorship-edge decision (cc-327 read 4): a dispatched walker would run the fill. cc-318 moved only crs-summaries; the dispatcher's one-row end it needs (FIX-1454) is on prod"}
  - {id: s3c, kind: cc, ref: "cc-328", title: "the cosponsor EC arm becomes a merge (FIX-1456, on prod); bill-details-request deployed; the 25-measure prod chunk read 21.9 s of database time a measure, so the dispatcher row is held on FIX-1459", done: 2026-11-26}
  - {id: s3d, kind: cc, ref: "cc-329", title: "fix the walker's first-vote read (FIX-1459), prove it with EXPLAIN on prod and a 25-measure chunk, then land and push the held row (0b631eaf) and read the first dispatched run (FIX-1453)"}
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

- **cc-328** made the cosponsor arm of the entity-connections crawl a merge
  (FIX-1456, `20261126007000`, on prod 2026-11-26 22:17:35Z), on Craig's
  ruling that `co_sponsorship` edges are wanted. It deployed the
  `bill-details-request` door and ran a 25-measure chunk on prod. That chunk
  read 21.9 s of database time a measure: the first-vote read plans as a
  backward scan of `votes_voted_at` (FIX-1459). So the dispatcher row was held
  (`0b631eaf` on `origin/feature/fix-328`). The chunk's 701 cosponsor rows
  give the next crawl cycle the first edges.

The later steps have no prompt yet, so they carry no `ref`. How the
walker is scheduled is FIX-1453's (s3b). cc-318 made the CRS walker a dispatcher
unit and kept bill-details out on Craig's call: the dispatcher would start the
fill that waits on the edge decision. When that is decided, the row is one
INSERT and the request target one allowlist line and one Vercel cron (cc-318's
D3 / D8; OPERATIONS §The CRS walker as a dispatcher unit is the model). The
walker already reports `metadata.next_due_at` on an empty selection (cc-318 D7).
