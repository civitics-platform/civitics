---
slug: industry-tags
title: Industry tag remediation
lanes: [fec]
status: active
plan: project_industry_tag_remediation
goal: "P2 · Accountability Tools"
steps:
  - {id: s1, kind: op, ref: "FIX-910", title: "PR1 908–910 vocabulary 17 keys", done: 2026-07-27}
  - {id: s2, kind: op, ref: "FIX-917", title: "PR2 916–917 curated overrides", done: 2026-07-27}
  - {id: s3, kind: op, ref: "FIX-923", title: "PR3 sweep 908–923", done: 2026-08-01}
  - {id: s4, kind: cc, ref: "cc-166", title: "918 one home for the primary tag + 919 NAICS repoint"}
  - {id: s5, kind: receipt, ref: "FIX-1240", title: "official_donor_rollup_mv / donor_party_rollup_mv see a tag change (filed by cc-166)", after: 2026-10-03T21:40Z}
  - {id: s6, kind: cc, ref: "cc-173", title: "1246 NAICS-54 retire + 1247 label unification", done: 2026-09-30}
  - {id: s7, kind: cc, ref: "cc-176", title: "1252 dominant code + 1245 provenance-first + 1254 label pairs", done: 2026-09-30}
  - {id: s8, kind: cc, ref: "cc-180", title: "1255 map + defense cohort; upsert provenance guard"}
  - {id: s9, kind: receipt, ref: "FIX-1255", title: "jobid 28 Thu 10-08 — the twelve under Defense, Humana under Health Care", after: 2026-10-08T14:45Z}
  - {id: s10, kind: cc, ref: "cc-182", title: "1240 labels follow tag changes; 1211 scoped donation-edge rebuild", done: 2026-10-03}
  - {id: s11, kind: cc, ref: "cc-184", title: "CACI NSS joins the defense cohort (806)", done: 2026-10-03}
  - {id: s12, kind: receipt, ref: "FIX-1255", title: "the first tail after the CACI NSS override — one defense/ai row, no tech", after: 2026-10-04T21:40Z}
  - {id: s13, kind: cc, ref: "cc-191", title: "1273 kept counts to data_sync_log + receipts; 1266 audit (reads)"}
  - {id: s14, kind: cc, ref: "cc-196", title: "1266 cohort (814) + the super-PAC keyword pass reads the sponsor"}
  - {id: s15, kind: receipt, ref: "FIX-1280", title: "the Mon 10-05 tail — 24 rule rows on O/U/V/W committees; the six 1266 picks", after: 2026-10-05T22:45Z}
---

# Industry tag remediation

Donor industry tags were a 17-key vocabulary with curated overrides (PR1–PR3,
July). cc-166 gave a donor's primary tag one home, `primary_industry_tag()`
(FIX-918), and repointed the NAICS tagger at the contractor side (FIX-919).

cc-182 (FIX-1240) made `official_donor_rollup_mv` and `donor_party_rollup_mv`
see a tag change. Path 3 of the nightly sector-affinity refresh now updates the
two label columns in place for the night's changed donors, and the migration
backfilled the drift that had built up. s5 is the first prod stamp,
`rollup_labels_updated`, on the 10-03 tail.

cc-173 and cc-176 retired the NAICS-54 catch-all, tagged contractors by their
dollar-dominant code, and ranked a rule tag ahead of an ai tag. cc-180 settled
the two groups that left behind (FIX-1255): 524114 health insurers back to
health, and twelve defense IT and R&D primes under a curated `defense` override.
It also stopped a rule tag from overwriting an ai row on a shared key
(FIX-1259). s9 is the contract-side receipt. cc-184 added CACI NSS, the one
sibling cc-180 listed with the same shape, as a thirteenth cohort row in a
second migration (s11). s12 is its first tail.

cc-191 (s13) moved the FIX-1259 kept counts into the `tag_rules` sync row and
receipts §1 (FIX-1273). It also audited the top-200 donor picks (FIX-1266):
193 right, 1 wrong, 3 none, 3 unsure, 1.24% of the dollars. The proposed
overrides wait on Craig's verdicts in
`docs/audits/2026-10-04-fix1266-proposed-overrides.tsv`. The vocabulary is
**16 keys**, as the live CHECK and `VALID_INDUSTRIES` agree (read 2026-10-04); s1's "17" is the
historical title.

s3's date is `done.log`'s (2026-08-01). The plan of record said 2026-07-29, and
the log wins.
