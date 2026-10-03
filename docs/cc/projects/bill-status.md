---
slug: bill-status
title: Federal bill status — monotonic, question-aware, chamber-aware (FIX-1256 → 1262)
lanes: [app]
status: active
plan: ""
goal: "P1 · Data Quality"
steps:
  - {id: s1, kind: cc, ref: "cc-177", title: "FIX-1256 — bill-key collisions bound to the key-holder, never minted beside it", done: 2026-09-30}
  - {id: s2, kind: cc, ref: "cc-180", title: "HR 4795 hand-set to passed_chamber", done: 2026-10-02}
  - {id: s3, kind: cc, ref: "cc-181", title: "FIX-1257 — status rank + proposals_advance_status(); 166 passed bills backfilled", done: 2026-10-03}
  - {id: s4, kind: cc, ref: "cc-185", title: "FIX-1261 → FIX-1260 → FIX-1262 — question-aware mint, the Senate result, chamber-aware text"}
  - {id: s5, kind: receipt, ref: "FIX-1261", title: "the first nightly whose congress_votes row carries minted{} and mints no failed from a procedural roll", after: 2026-10-04T21:30Z}
  - {id: s6, kind: receipt, ref: "FIX-1260", title: "the first Senate passage roll that advances a bill (status_advanced > 0 with a Senate roll_call_id)", after: 2026-10-10T21:30Z}
  - {id: s7, kind: design, ref: "", title: "OpenStates mapBillStatus — the unreachable passed-both branch; state bills get no rank rule yet"}
---

# Federal bill status (FIX-1256 → FIX-1262)

A federal proposal's `status` is written by two paths. The recent-bills sync
reads congress.gov's latest-action text. The vote path mints a bill it has
never seen from a House Clerk or Senate LIS roll. Both had ways to write a
stage the evidence did not prove.

- **cc-177 (FIX-1256)**: a lost ref no longer mints a stub beside its bill.
- **cc-180 / cc-181 (FIX-1257)**: a status only moves forward.
  `proposal_status_rank()` / `proposals_advance_status()` enforce it, a passed
  passage roll advances an existing bill, and 166 regressed bills were
  backfilled.
- **cc-185** closes the remaining three:
  - **FIX-1261**: the mint reads the roll's question, over every roll in the
    run. It never mints `failed`; the minted artifacts are repaired from a
    manifest.
  - **FIX-1260**: the Senate writer reads `<vote_result>`, the element the LIS
    XML actually carries.
  - **FIX-1262**: "Received in the Senate" and "Held at the desk" prove the
    origin chamber passed the bill.

There is no Cowork design note. The design of record is cc-181's report §4
plus the cc-185 prompt (D1–D5, ratified 2026-10-03). The rule itself is not
widened: corrections that must LOWER a status, or move one off `failed`, run
as a direct, manifest-scoped script (`scripts/fix1261-*.mjs`), never through
the RPC.

The passage-question list lives in one file,
`packages/data/src/pipelines/congress/passage-questions.json`. The nightly and
the manifest scripts both read it.
