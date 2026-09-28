---
slug: industry-tags
title: Industry tag remediation
lanes: [fec]
status: active
plan: project_industry_tag_remediation
steps:
  - {id: s1, kind: op, ref: "FIX-910", title: "PR1 908–910 vocabulary 17 keys", done: 2026-07-27}
  - {id: s2, kind: op, ref: "FIX-917", title: "PR2 916–917 curated overrides", done: 2026-07-27}
  - {id: s3, kind: op, ref: "FIX-923", title: "PR3 sweep 908–923", done: 2026-08-01}
  - {id: s4, kind: cc, ref: "cc-166", title: "918 one home for the primary tag + 919 NAICS repoint"}
  - {id: s5, kind: receipt, ref: "FIX-1240", title: "official_donor_rollup_mv / donor_party_rollup_mv see a tag change (filed by cc-166)"}
---

# Industry tag remediation

Donor industry tags were a 17-key vocabulary with curated overrides (PR1–PR3,
July). cc-166 gave a donor's primary tag one home, `primary_industry_tag()`
(FIX-918), and repointed the NAICS tagger at the contractor side (FIX-919).

**Open:** FIX-1240. `official_donor_rollup_mv` and `donor_party_rollup_mv` do not
yet see a tag change.

s3's date is `done.log`'s (2026-08-01). The plan of record said 2026-07-29, and
the log wins.
