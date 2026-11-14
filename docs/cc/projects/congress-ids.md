---
slug: congress-ids
title: Congress-legislators FEC ids — report first, then write
lanes: [fec]
status: active
plan: design-fix1189-congress-legislators-fec-ids-2026-09-19
goal: "P1 · Data Quality"
steps:
  - {id: s1, kind: design, ref: "FIX-1189", title: "design note; D1–D5 ratified 2026-09-20", done: 2026-09-20}
  - {id: s2, kind: cc, ref: "cc-170", title: "O2 — classifyBinding() + nightly report step, no writes"}
  - {id: s3, kind: receipt, ref: "FIX-1189", title: "a week of congress_legislator_ids_report rows", after: 2026-10-06}
  - {id: s4, kind: cc, ref: "", title: "O1 — the writer; design §4 as write actions; supervised first run"}
  - {id: s5, kind: cc, ref: "cc-193", title: "promotion by dataset key + O1 code"}
  - {id: s6, kind: cc, ref: "cc-194", title: "the supervised landing"}
  - {id: s7, kind: cc, ref: "cc-196", title: "1279 rider — the promotion RPC adopts the elected row's name fields"}
  - {id: s8, kind: cc, ref: "cc-200", title: "FIX-1278 official_redirects + the RPC writes the row"}
  - {id: s9, kind: cc, ref: "cc-199", title: "shape C (--adopt-prior) + the Luján H-stub merge"}
  - {id: s10, kind: receipt, ref: "FIX-1189", title: "Thu 21:00Z §10 double_claim 46; the $622k under the Senator after jobid 24 Thu 09:00Z", after: 2026-10-09T06:00Z}
  - {id: s11, kind: receipt, ref: "cc-222", title: "the 46 other-office double_claim rows audited — A 22 prior / B 17 concurrent / C 4 same-chamber / D 3; class-A manifest drafted", done: 2026-10-11}
  - {id: s12, kind: cc, ref: "cc-274", title: "FIX-1407 the Senate's polite walk — seen-unstored record (pipeline_state congress_votes:senate_rolls:119), current session and tail first, 403/429 blocked with 30 s / 120 s retries, 1.5 s paced GETs; the House walk untouched", done: 2026-11-14}
  - {id: s13, kind: receipt, ref: "FIX-1407", title: "three nightlies at their slots (11-14, 11-15, 11-16 21:00Z): per night and session the Senate line, GETs, tail-new, seen-unstored skipped, blocked + retries, the stop; the record's row (N known by reason, tail_closed for session 1). Met when, from the second night on, each session sends ≤ 10 GETs and none stops on blocked", after: 2026-11-17T01:00Z}
  - {id: s14, kind: receipt, ref: "FIX-1372", title: "the same three nights: every Senate roll voted on day D is in votes by the nightly of D+1 — evidence for Craig's close-or-hold, not a close", after: 2026-11-17T01:00Z}
  - {id: s15, kind: cc, ref: "cc-277", title: "FIX-1408 the Senate's amendment rolls — the parent bill from <amendment_to_document_number> when <document> names none, metadata.amendment_number on each row, SENATE_UNSTORED_VERSION 2, the graph prefix 'on the amendment'; FIX-1409 (the EC vote arm) filed, not built", done: 2026-11-14}
  - {id: s16, kind: receipt, ref: "FIX-1408", title: "the nightlies after the ff: per night and session the Senate line and the record line; on prod, Senate rolls and vote rows carrying metadata.amendment_number per session, their distinct parent bills, the record's remaining no_proposal_reference count with five ids named, the proposals minted for an amendment's parent. Met when both sessions' gap passes have completed once at v2 and every roll still unstored is named with its reason", after: 2026-11-17T01:00Z}
  - {id: s17, kind: receipt, ref: "FIX-1409", title: "the same nights: Senate (official, bill) pairs on prod whose latest roll carries metadata.amendment_number, beside cc-277 read 3's local baseline (29,070 pairs, 11,452 decided by a non-passage, non-nomination roll) — a reading, not a close", after: 2026-11-17T01:00Z}
---

# Congress-legislators FEC ids (FIX-1189)

The congress-legislators `id.fec[]` list and our official↔candidate binding
disagree in a small, classifiable set of ways. O2 (cc-170) reports the
divergence nightly and writes nothing.

**Gate on s4:** O1 turns the design's §4 table into write actions. It is written
only after a week of O2 report rows (design D2), and its first run is
supervised.

**The Senate vote collector (s12–s14, FIX-1372 / FIX-1407).** senate.gov serves
a few dozen GETs a night, then answers 403. Wed 11-11's nightly fetched 163
Senate rolls and stored 2. The other 161 had no bill reference and were fetched
again every night. cc-274 records them in `pipeline_state`, walks each session's
new rolls before its gaps, and retries a 403 instead of reading it as the end.
The runbook is `docs/OPERATIONS.md` §The Senate roll walk. The UA and
`vote_menu_*.xml` as a roll index are the next levers if the block survives.

**The Senate's amendment rolls (s15–s17, FIX-1408 / FIX-1409).** Those 161 were
not housekeeping: an amendment roll's `<document>` is `S.Amdt.` with an empty
number, and its bill is in `<amendment><amendment_to_document_number>`. cc-277
stores them against that bill (as the House's amendment rolls already are),
carries the amendment's number in `votes.metadata`, and bumps the record to v2
so every roll is fetched once more. The polite walk's gap pass lands them; no
backfill. FIX-1409 is what that exposes: the EC vote arm lets an official's
latest roll on a bill decide the edge, whatever its question.
