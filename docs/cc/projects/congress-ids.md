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
---

# Congress-legislators FEC ids (FIX-1189)

The congress-legislators `id.fec[]` list and our official↔candidate binding
disagree in a small, classifiable set of ways. O2 (cc-170) reports the
divergence nightly and writes nothing.

**Gate on s4:** O1 turns the design's §4 table into write actions. It is written
only after a week of O2 report rows (design D2), and its first run is
supervised.
