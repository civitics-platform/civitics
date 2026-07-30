# FEC orphan attribution — local — 2026-07-30

Read-only enumeration for FIX-930. Row-level detail: `2026-07-30-fec-orphan-attribution.tsv`.

## Signal

Officials holding `relationship_type='donation'` rows sourced `fec_bulk*` whose
`source_ids` carries neither `fec_candidate_id` nor a role-prefix-matching `fec_id`
— i.e. officials the current match index would never select, yet who hold FEC money.

- **suspects: 155** holding **$133,049,110**
- platform-wide donation money on officials: $4,803,650,534 across 4,321 officials → suspects are **2.8%** of official-attributed donation dollars
- with a same-surname official that DOES carry an FEC id: 119 ($129,279,663)

| tier | officials | dollars |
|---|---:|---:|
| elected | 37 | $81,781,666 |
| elected (inactive) | 117 | $51,264,944 |
| former (inactive) | 1 | $2,500 |

## Branch boundary

Drawn on the **overlap fraction** (shared `(from_id, cycle_year)` pairs / the suspect's
own donation rows), not on the raw shared count — 90 shared out of 100 rows is damning,
90 out of 45,000 is noise. Cut placed at the midpoint of the widest empty band in the
observed fraction distribution within [0.02, 0.6].

- widest empty band: **0.2270 → 0.3333** (width 0.1064)
- **fraction cut = 0.2802**
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
| 0.30–0.35 | 1 |
| 0.40–0.45 | 3 |
| 0.45–0.50 | 3 |
| 0.50–0.55 | 4 |
| 0.55–0.60 | 2 |
| 0.60–0.65 | 2 |
| 0.65–0.70 | 4 |
| 0.70–0.75 | 2 |
| 0.75–0.80 | 3 |
| 0.80–0.85 | 1 |
| 0.85–0.90 | 2 |
| 0.90–0.95 | 8 |
| 0.95–1.00 | 16 |
| 1.00 (exact) | 59 |

## Branches

| branch | officials | dollars | remediation |
|---|---:|---:|---|
| CROSS-PERSON MISATTRIBUTION | 60 | $113,233,132 | delete the mis-bound rows — another person's donors |
| SAME-PERSON DUPLICATE | 3 | $3,202,261 | merge the two official rows, carrying the FK surface |
| UNIQUE HOLDER | 92 | $16,613,717 | **write the missing `source_ids` id** — do NOT remove rows |

### How SAME vs CROSS is decided

Same-person evidence is the **union of two independent signals** — `name` (first names agree
on a 3-letter key) and `seat` (the twin's CAND_ID describes the chamber AND state this official
actually holds). CROSS-PERSON is the residual: neither signal fires.

- decided `name+seat`: 0
- decided `seat` only: 0
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

**Low-confidence corner:** 47 suspect(s) clear the fraction cut but not the absolute floor, so they are filed as UNIQUE HOLDER (the non-destructive default). They are the ambiguous population, not confident singletons — re-check them by hand in PR 2. Grep the TSV for `overlap_frac >= 0.2802` with `branch=UNIQUE HOLDER`.

## Reference cases

| case | expected branch | observed | shared pairs | ✓ |
|---|---|---|---:|:-:|
| Shontel M. Brown → Sherrod Brown | CROSS-PERSON MISATTRIBUTION | CROSS-PERSON MISATTRIBUTION | 42681 | ✓ |
| Jon Ossoff (elected) → Ossoff (candidate) | SAME-PERSON DUPLICATE | REMEDIATED (no longer a suspect) | — | ✓ |

## Top suspects by dollars

| official | tier | branch | rows | dollars | window | twin | shared |
|---|---|---|---:|---:|---|---|---:|
| Shontel M. Brown | elected | CROSS-PERSON MISATTRIBUTION | 43,960 | $50,998,289 | 2018-10-17→2026-03-31 | Sherrod Brown (S6OH00163) | 42,681 |
| David Porter | elected | CROSS-PERSON MISATTRIBUTION | 6,133 | $7,391,766 | 2019-02-19→2025-09-19 | Katherine Porter (S4CA00522) | 5,660 |
| Heather Cooke | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 4,871 | $6,001,754 | 2022-06-06→2026-03-31 | Rebecca Cooke (H2WI03130) | 4,667 |
| Al Green | elected | CROSS-PERSON MISATTRIBUTION | 2,026 | $3,941,878 | 2019-01-07→2026-03-31 | Mark Green (H8TN07076) | 912 |
| Mike Collins | elected | CROSS-PERSON MISATTRIBUTION | 1,534 | $3,496,690 | 2019-01-22→2026-03-31 | Michael Collins (S6GA00390) | 754 |
| Chuck Grassley | elected | UNIQUE HOLDER | 888 | $3,348,824 | 2019-01-04→2026-02-07 | Charles Grassley (S0IA00028) | 187 |
| Scott Wiener | elected (inactive) | SAME-PERSON DUPLICATE | 1,169 | $2,695,222 | 2023-03-01→2026-03-26 | Scott Wiener (H8CA11116) | 1,169 |
| David Coleman | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 1,002 | $2,585,174 | 2015-10-14→2026-02-11 | Bonnie Coleman (H4NJ12149) | 527 |
| Beverly Andrews | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 2,705 | $2,254,585 | 2020-04-20→2026-03-31 | Annie Andrews (S6SC04239) | 2,529 |
| Gregory Phillips | elected | CROSS-PERSON MISATTRIBUTION | 1,484 | $2,121,088 | 2019-01-15→2026-02-27 | Dean Phillips (P40016131) | 1,066 |
| Radhika Fox | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 1,813 | $1,975,721 | 2023-09-23→2024-12-03 | Whitney Fox (H4FL13200) | 1,813 |
| Richard Greene | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 2,028 | $1,961,461 | 2019-12-26→2024-12-31 | Marjorie Greene (H0GA06192) | 1,985 |
| Brandon Williamson | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 1,408 | $1,913,472 | 2020-01-21→2025-11-08 | Marianne Williamson (P00009910) | 1,283 |
| Stuart Duncan | elected | CROSS-PERSON MISATTRIBUTION | 718 | $1,912,303 | 2019-02-06→2023-12-27 | Jeffrey Duncan (H0SC03077) | 356 |
| Mark Bennett | elected | CROSS-PERSON MISATTRIBUTION | 1,205 | $1,837,966 | 2019-07-22→2026-03-26 | Rebecca Bennett (H6NJ07201) | 1,064 |
| Sage Lawrence | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 655 | $1,753,417 | 2019-01-16→2026-02-06 | William Lawrence (H6MI07298) | 275 |
| Jane Roth | elected | CROSS-PERSON MISATTRIBUTION | 724 | $1,734,583 | 2023-06-02→2025-12-31 | Michael Roth (H6NJ07235) | 379 |
| Gena McKinley | elected (inactive) | UNIQUE HOLDER | 464 | $1,652,618 | 2019-01-25→2022-09-01 | — | 0 |
| Teresa Dixon | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 773 | $1,575,179 | 2023-04-05→2025-12-15 | Peter Dixon (H4CA16247) | 743 |
| Yvette Mendoza | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 1,185 | $1,571,436 | 2024-05-10→2026-03-27 | Joanna Mendoza (H6AZ06099) | 955 |
| Joy Hollingsworth | elected | UNIQUE HOLDER | 450 | $1,490,344 | 2019-01-28→2024-01-01 | Trey Hollingsworth (H6IN09176) | 1 |
| HB Harper | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 1,566 | $1,444,024 | 2019-12-11→2025-07-31 | Frank Harper (S4MI00553) | 1,539 |
| Jacquel Gibbs | elected (inactive) | UNIQUE HOLDER | 467 | $1,394,118 | 2019-01-24→2025-12-18 | Jason Gibbs (H6CA27306) | 106 |
| Jesse Franz | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 943 | $1,316,422 | 2023-11-10→2024-11-04 | Hilary Franz (H4WA06109) | 943 |
| Saroja Reddy | elected (inactive) | CROSS-PERSON MISATTRIBUTION | 605 | $1,313,782 | 2023-07-01→2024-12-20 | Prasanth Reddy (H4KS03212) | 605 |

---

Figures are environment-specific. **Re-derive on prod before acting on any of them.**
