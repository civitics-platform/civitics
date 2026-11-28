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
  - {id: s3d, kind: cc, ref: "cc-330", title: "fix the walker's first-vote read (cc-329, FIX-1459), prove it with a 25-measure prod chunk (cc-330: 393 ms of database time a measure), then push the held row (20261126008000) and read the first dispatched run (FIX-1453: 132 measures, reaped succeeded: GHA)", done: 2026-11-27}
  - {id: s4, kind: cc, ref: "cc-331", title: "per-roll official totals and results (FIX-1448): vote_rolls, the nightly's write, the walker and its dispatcher unit"}
  - {id: s5, kind: cc, ref: "cc-332", title: "the bill page shows official roll counts and results, sponsor, cosponsors, actions"}
  - {id: s5b, kind: cc, ref: "", title: "the officials page shows bills sponsored and cosponsored, after the fill is whole"}
  - {id: s5c, kind: cc, ref: "cc-340", title: "the vote-rolls walker reads first the Senate rolls whose list result reads against its count (FIX-1463); a prod census of the members with no officials row (FIX-1464) and the 54 short House rolls of 2026-05 (FIX-1465)"}
  - {id: s5e, kind: cc, ref: "cc-342", title: "guards first: irs990, plum-book and LittleSis resolve an official by name under a stated rule and a refusal, never by row order (FIX-1468); a prod census of today's collisions, of the existing bindings the rules would not choose (FIX-1469), and of the 192 members with no bioguide row"}
  - {id: s5d, kind: design, ref: "", title: "former members get officials rows (FIX-1464): the design waits on the census — docs/audits/2026-11-28-members-with-no-officials-row.md lists what its first prompt decides"}
  - {id: s5e, kind: cc, ref: "cc-341", title: "the cut member map's rolls repaired from their own files by the re-read walker (FIX-1465, FIX-1466): Write 1 the 158 short 119th rolls, Write 2 every House roll on Craig's go; the nightly refuses a short map or roll (FIX-1467)"}
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

- **cc-329** took the first-vote read off that walk (`bdd69660`: its own
  statement behind an `OFFSET 0` fence, read only when the placeholder rule
  consults it; prod plans `votes_bill`). The cold worst case read 978 ms against
  its 500 ms bar, so no chunk ran. The merged cosponsor arm's first cycle wrote
  the 701 `co_sponsorship` edges (FIX-1456 on prod).
- **cc-330** accepted the ~1 s cold tail and ran the second 25-measure chunk:
  393 ms of database time a measure (max 3,703), against cc-328's 21,948
  (FIX-1459 on prod). Then it pushed the held row (`20261126008000`, 04:44:59Z
  11-27), so the dispatcher runs the fill: 15 minutes when 2 hours stale,
  voted measures first. The first dispatched run (06:05–06:21Z) stamped 132
  voted measures at 113 ms of database time a measure and reaped `succeeded:
  GHA` (FIX-1453 on prod). FIX-1452 stays open until the voted measures are
  filled.

The later steps have no prompt yet, so they carry no `ref`. How the
walker is scheduled is FIX-1453's (s3b). cc-318 made the CRS walker a dispatcher
unit and kept bill-details out on Craig's call: the dispatcher would start the
fill that waits on the edge decision. When that is decided, the row is one
INSERT and the request target one allowlist line and one Vercel cron (cc-318's
D3 / D8; OPERATIONS §The CRS walker as a dispatcher unit is the model). The
walker already reports `metadata.next_due_at` on an empty selection (cc-318 D7).
- **cc-331** built `public.vote_rolls` (FIX-1448, `20261127000000`): one row
  per federal roll with the source's own yea / nay / present / not voting,
  result, title and majority requirement, because `votes` stores only members
  with an `officials` row. The nightly writes the row for each new roll; the
  vote-rolls walker seeds every stored roll, reads the six Senate session lists
  (every Senate roll gets its result, the 1,893 empty ones included) and then
  the per-roll files. Its prod chunk ran at 43 ms of database time a roll, and
  its dispatcher row (`20261127001000`, its own group) runs it 15 minutes when
  2 hours stale. FIX-1448 stays open until the House is whole. cc-332 is the
  display.
- **cc-332** put both on the bill page, with no migration
  (`apps/civitics/src/lib/proposal-detail/vote-rolls.ts`, `bill-record.ts`).
  Each roll now prints the source's result with a requirement that has a
  fraction ("Result: Failed · two-thirds required"). Beside it are the official
  count (present and not voting only when the file carried them), "N of M
  member votes on record", the roll's title, a tie-breaker, and on final and
  advance rolls the clerk's party totals (FIX-1461). For federal bills and
  resolutions the page also prints: the shorter of the stored and short titles
  as the heading; the sponsor; the source's cosponsor count with the rows on
  record and their party split; the actions, one line per date and text; the
  policy area; and a "not collected yet" sentence for a measure the walker
  has not reached (FIX-1462). On prod at 11-27 23:50Z, 1,249 of 9,782
  congress_gov refs were stamped. 504 of those hold fewer cosponsor rows than
  the source counts, 450 of them in the 117th and 118th Congresses; each
  ref's `detail.cosponsors_unresolved` names the members who did not resolve.
  The officials page's "bills sponsored" waits for the whole fill (s5b).
- **cc-340** moved the Senate rolls whose session-list result reads against
  its own count to the front of the walker's Senate pick (FIX-1463). On prod at
  11-28 03:40Z there were 132 of them: 67 more-yeas rows under a negative word
  (three-fifths, two-thirds, a veto sustained, an acquittal) and 65 ties, 39 of
  them under an affirmative word. Its census
  (`docs/audits/2026-11-28-members-with-no-officials-row.md`) found at least 185
  members of the 117th–119th Congresses with no `officials` row. They account
  for 92.5 % of the House's missing member votes, which fall in the 117th and
  118th, and for every unresolved cosponsor and sponsor (FIX-1464). The census
  also found a second cause: 54 House rolls of May–June 2026 store a quarter
  of their votes (FIX-1465). The backfill is s5d's design.
- **cc-341** found FIX-1465 wider than 54 rolls. From about 04-24 to 06-09 the
  votes writer's member map held only the first 1,000 `officials` rows
  (FIX-545 fixed the read, nothing repaired the rolls). On prod at 11-28 that
  left 154 House rolls of the 119th short by more than 10 (19,735 votes) and
  four Senate rolls short (170). The 117th–118th House backfill of 04-29 ran
  inside the window: 43 sitting members with a row have no 118th vote and 35
  no 117th vote (FIX-1466). The re-read walker (`votes-reread.ts`) inserts
  what a stored roll's own file says it is missing and changes no stored row.
  Write 1 takes the 158 short 119th rolls from the terminal; Write 2, on
  Craig's go, takes every House roll from `votes-reread.yml`. The nightly now
  refuses a member map under its floor and a 119th roll under 97 % resolved
  (FIX-1467).
- **cc-342** put the guards in before any former-member row exists (FIX-1468).
  irs990's officer index resolves a shared name to its one active elected
  row, else to nobody; on prod at 11-28 that sends 1,980 of 2,943 shared keys
  to nobody. plum-book drops sitting members, links one row or none, and never
  writes a member's `is_active`. LittleSis binds a lone surname only on a
  first-name agreement. Its census
  (`docs/audits/2026-11-28-name-keyed-resolvers-census.md`) found existing
  bindings the rules would not choose: 12 of 58 irs990 officers, 69 of 191
  PLUM name links, and at least 31,354 of 41,443 LittleSis bindings. No run
  re-derives them (FIX-1469). It also found that **190 of the 192** members
  with no bioguide row already have an `officials` row, the FEC candidate stub
  that claims their `id.fec`. So s5d is mostly a promotion of those stubs,
  not an insert.
