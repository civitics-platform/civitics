# FEC orphan attribution — local — 2026-07-29

Read-only enumeration for FIX-930. Row-level detail: `2026-07-29-fec-orphan-attribution.tsv`.

## Signal

Officials holding `relationship_type='donation'` rows sourced `fec_bulk*` whose
`source_ids` carries neither `fec_candidate_id` nor a role-prefix-matching `fec_id`
— i.e. officials the current match index would never select, yet who hold FEC money.

- **suspects: 202** holding **$445,133,521**
- platform-wide donation money on officials: $5,023,195,233 across 4,368 officials → suspects are **8.9%** of official-attributed donation dollars
- with a same-surname official that DOES carry an FEC id: 166 ($441,364,074)

| tier | officials | dollars |
|---|---:|---:|
| elected | 84 | $393,866,077 |
| elected (inactive) | 117 | $51,264,944 |
| former (inactive) | 1 | $2,500 |

## Branch boundary

Drawn on the **overlap fraction** (shared `(from_id, cycle_year)` pairs / the suspect's
own donation rows), not on the raw shared count — 90 shared out of 100 rows is damning,
90 out of 45,000 is noise. Cut placed at the midpoint of the widest empty band in the
observed fraction distribution within [0.02, 0.6].

- widest empty band: **0.2270 → 0.3108** (width 0.0839)
- **fraction cut = 0.2689**
- **absolute floor = 52 shared pairs** — widest empty band in the low tail (45 → 52) of the shared counts *among suspects that already clear the fraction cut*. That is the only population the floor acts on. Its job is the tiny-N corner: an official with 2 rows that both land on a same-surname twin scores frac=1.0 by chance, because one PAC giving to two same-surname officials in a cycle is entirely ordinary.
- distribution **IS cleanly bimodal** on the fraction.

Raw shared-pair counts alone are **not** bimodal — they spread near-continuously from 0
to the maximum, which is exactly why the boundary is normalised before it is cut.

| overlap fraction | suspects |
|---|---:|
| 0.00–0.05 | 40 |
| 0.05–0.10 | 1 |
| 0.10–0.15 | 1 |
| 0.15–0.20 | 1 |
| 0.20–0.25 | 2 |
| 0.30–0.35 | 3 |
| 0.40–0.45 | 3 |
| 0.45–0.50 | 5 |
| 0.50–0.55 | 5 |
| 0.55–0.60 | 4 |
| 0.60–0.65 | 5 |
| 0.65–0.70 | 11 |
| 0.70–0.75 | 7 |
| 0.75–0.80 | 14 |
| 0.80–0.85 | 4 |
| 0.85–0.90 | 3 |
| 0.90–0.95 | 14 |
| 0.95–1.00 | 19 |
| 1.00 (exact) | 60 |

## Branches

| branch | officials | dollars | remediation |
|---|---:|---:|---|
| CROSS-PERSON MISATTRIBUTION | 60 | $113,233,132 | delete the mis-bound rows — another person's donors |
| SAME-PERSON DUPLICATE | 50 | $315,286,672 | merge the two official rows, carrying the FK surface |
| UNIQUE HOLDER | 92 | $16,613,717 | **write the missing `source_ids` id** — do NOT remove rows |

### How SAME vs CROSS is decided

Same-person evidence is the **union of two independent signals** — `name` (first names agree
on a 3-letter key) and `seat` (the twin's CAND_ID describes the chamber AND state this official
actually holds). CROSS-PERSON is the residual: neither signal fires.

- decided `name+seat`: 1
- decided `seat` only: 46
- decided `name` only: 3
- `neither` → CROSS-PERSON: 60

**Why not first-name agreement alone, as originally scoped.** FEC files candidates under their
LEGAL name while we hold the name they go by, and that pair disagrees constantly — Ted/Rafael
Cruz, Mike/James Johnson, Jack/John Reed, Bill/William Cassidy, Jim/James Banks, Andy/Garland
Barr were **ten of the top twelve overlaps** on this clone. Routing those into CROSS-PERSON tells
PR 2 to delete a person's own donors as though they were someone else's, so name-only is not
merely imprecise here — it is destructive. Nor is a name match *necessary*: a first name can be
uncomparable because the twin is an FEC initial (`T Ossoff`) or because the suspect's own first
name is under three letters (`Ro` Khanna, `Al` Green). **Undecidable is not "disagrees".**

Seat alone would not do either — it cannot see municipal officials at all, and Scott Wiener /
Connie Chan are same-name pairs on a city seat. And chamber without state is far too coarse:
most suspects are Representatives, so Al Green (TX) would have merged into Mark Green's
`H8TN07076`. Both reference cases land correctly for the right reason — Shontel Brown is a
Representative against a *Senate* CAND_ID (both signals fail), Jon Ossoff a GA Senator against
`S8GA00180` (seat fires where the name cannot).

**Merge-blockers:** 3 SAME-PERSON DUPLICATE row(s) were decided on name agreement but their jurisdiction does NOT match the state in the twin's CAND_ID — a shared name across state lines. Confirm identity by hand before merging: Scott Wiener (SF) → Scott Wiener (H8CA11116); Christine Jones (AUS) → Chris Jones (H6AR02286); Connie Chan (SF) → Connie Chan (H6CA11268).

**Low-confidence corner:** 47 suspect(s) clear the fraction cut but not the absolute floor, so they are filed as UNIQUE HOLDER (the non-destructive default). They are the ambiguous population, not confident singletons — re-check them by hand in PR 2. Grep the TSV for `overlap_frac >= 0.2689` with `branch=UNIQUE HOLDER`.

## Reference cases

| case | expected branch | observed | shared pairs | ✓ |
|---|---|---|---:|:-:|
| Shontel M. Brown → Sherrod Brown | CROSS-PERSON MISATTRIBUTION | CROSS-PERSON MISATTRIBUTION | 42681 | ✓ |
| Jon Ossoff (elected) → Ossoff (candidate) | SAME-PERSON DUPLICATE | SAME-PERSON DUPLICATE | 15779 | ✓ |

## Top suspects by dollars

| official | tier | branch | rows | dollars | window | twin | shared |
|---|---|---|---:|---:|---|---|---:|
| Shontel M. Brown | elected | CROSS-PERSON MISATTRIBUTION | 43,960 | $50,998,289 | 2018-10-17→2026-03-31 | Sherrod Brown (S6OH00163) | 42,681 |
| Ted Cruz | elected | SAME-PERSON DUPLICATE | 32,142 | $32,022,084 | 2019-01-17→2026-03-31 | Rafael Cruz (S2TX00312) | 32,009 |
| Raja Krishnamoorthi | elected | SAME-PERSON DUPLICATE | 8,722 | $24,008,210 | 2018-12-18→2026-03-23 | S Krishnamoorthi (H6IL08147) | 4,397 |
| Ro Khanna | elected | SAME-PERSON DUPLICATE | 5,210 | $18,049,625 | 2019-09-25→2025-12-31 | Rohit Khanna (H4CA12055) | 4,905 |
| Jon Ossoff | elected | SAME-PERSON DUPLICATE | 16,006 | $14,585,287 | 2020-02-28→2026-03-31 | T Ossoff (S8GA00180) | 15,779 |
| Andy Barr | elected | SAME-PERSON DUPLICATE | 5,312 | $12,918,813 | 2019-02-06→2026-03-31 | Garland Barr (H0KY06104) | 1,805 |
| Eugene Simon Vindman | elected | SAME-PERSON DUPLICATE | 10,655 | $11,201,296 | 2023-11-14→2026-03-31 | Yevgeny Vindman (H4VA07234) | 7,897 |
| Mike Johnson | elected | SAME-PERSON DUPLICATE | 4,010 | $10,761,685 | 2019-01-28→2026-03-31 | James Johnson (H6LA04138) | 3,714 |
| Bill Cassidy | elected | SAME-PERSON DUPLICATE | 3,380 | $10,371,440 | 2019-01-24→2026-03-31 | William Cassidy (S4LA00107) | 2,649 |
| Tom Emmer | elected | SAME-PERSON DUPLICATE | 3,100 | $10,232,245 | 2019-01-08→2026-03-30 | Thomas Emmer (H4MN06087) | 2,355 |
| Brett Guthrie | elected | SAME-PERSON DUPLICATE | 3,204 | $10,041,040 | 2019-01-23→2026-03-31 | S Guthrie (H8KY02031) | 2,445 |
| J. French Hill | elected | SAME-PERSON DUPLICATE | 3,576 | $9,523,019 | 2019-03-05→2026-03-31 | James Hill (H4AR02141) | 2,475 |
| Bill Huizenga | elected | SAME-PERSON DUPLICATE | 2,181 | $7,923,723 | 2019-01-07→2026-03-31 | William Huizenga (H0MI02094) | 1,556 |
| David Porter | elected | CROSS-PERSON MISATTRIBUTION | 6,133 | $7,391,766 | 2019-02-19→2025-09-19 | Katherine Porter (S4CA00522) | 5,660 |
| Jim Banks | elected | SAME-PERSON DUPLICATE | 3,002 | $6,908,506 | 2019-01-24→2026-03-25 | James Banks (S4IN00196) | 2,509 |
| Bill Foster | elected | SAME-PERSON DUPLICATE | 2,590 | $6,428,410 | 2019-01-28→2026-03-16 | G Foster (H8IL14067) | 2,032 |
| Jack Reed | elected | SAME-PERSON DUPLICATE | 2,170 | $6,099,758 | 2014-09-07→2026-03-09 | John Reed (S6RI00163) | 1,412 |
| Heather Cooke | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 4,871 | $6,001,754 | 2022-06-06→2026-03-31 | Rebecca Cooke (H2WI03130) | 4,667 |
| Mike D. Rogers | elected | SAME-PERSON DUPLICATE | 2,084 | $5,899,319 | 2019-02-08→2026-03-31 | Michael Rogers (H2AL03032) | 1,656 |
| Mike Bost | elected | SAME-PERSON DUPLICATE | 2,106 | $5,759,483 | 2019-02-04→2026-03-27 | Michael Bost (H4IL12060) | 1,611 |
| Troy Balderson | elected | SAME-PERSON DUPLICATE | 1,975 | $5,366,235 | 2019-02-13→2026-03-27 | William Balderson (H8OH12180) | 1,381 |
| Tom Cotton | elected | SAME-PERSON DUPLICATE | 2,386 | $5,318,707 | 2019-01-29→2026-03-20 | Thomas Cotton (S4AR00103) | 2,051 |
| Jim Jordan | elected | SAME-PERSON DUPLICATE | 4,330 | $5,200,549 | 2019-02-12→2026-03-27 | James Jordan (H6OH04082) | 4,128 |
| Lizzie Fletcher | elected | SAME-PERSON DUPLICATE | 1,978 | $5,165,303 | 2019-01-17→2026-03-31 | Elizabeth Fletcher (H8TX07140) | 1,221 |
| Beth Van Duyne | elected | SAME-PERSON DUPLICATE | 1,991 | $5,030,612 | 2019-08-27→2026-03-26 | Elizabeth Van Duyne (H0TX24209) | 1,463 |

---

Figures are environment-specific. **Re-derive on prod before acting on any of them.**
