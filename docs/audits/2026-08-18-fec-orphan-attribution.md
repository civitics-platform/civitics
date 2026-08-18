# FEC orphan attribution — prod — 2026-08-18

Read-only enumeration for FIX-930. Row-level detail: `2026-08-18-fec-orphan-attribution.tsv`.

## Signal

Officials holding `relationship_type='donation'` rows sourced `fec_bulk*` whose
`source_ids` carries neither `fec_candidate_id` nor a role-prefix-matching `fec_id`
— i.e. officials the current match index would never select, yet who hold FEC money.

- **suspects: 86** holding **$6,286,743**
- platform-wide donation money on officials: $7,696,856,800 across 7,510 officials → suspects are **0.1%** of official-attributed donation dollars
- with a same-surname official that DOES carry an FEC id: 82 ($5,948,650)

| tier | officials | dollars |
|---|---:|---:|
| elected (inactive) | 64 | $4,461,771 |
| elected | 21 | $1,822,472 |
| former | 1 | $2,500 |

## Branch boundary

Drawn on the **overlap fraction** (shared `(from_id, cycle_year)` pairs / the suspect's
own donation rows), not on the raw shared count — 90 shared out of 100 rows is damning,
90 out of 45,000 is noise. Cut placed at the midpoint of the widest empty band in the
observed fraction distribution within [0.02, 0.6].

- widest empty band: **0.0000 → 0.3333** (width 0.3333)
- **fraction cut = 0.1667**
- **absolute floor = 146 shared pairs** — widest empty band in the low tail (45 → 146) of the shared counts *among suspects that already clear the fraction cut*. That is the only population the floor acts on. Its job is the tiny-N corner: an official with 2 rows that both land on a same-surname twin scores frac=1.0 by chance, because one PAC giving to two same-surname officials in a cycle is entirely ordinary.
- distribution **IS cleanly bimodal** on the fraction.

Raw shared-pair counts alone are **not** bimodal — they spread near-continuously from 0
to the maximum, which is exactly why the boundary is normalised before it is cut.

| overlap fraction | suspects |
|---|---:|
| 0.00–0.05 | 4 |
| 0.30–0.35 | 1 |
| 0.40–0.45 | 1 |
| 0.50–0.55 | 1 |
| 0.55–0.60 | 1 |
| 0.65–0.70 | 4 |
| 0.70–0.75 | 1 |
| 0.75–0.80 | 1 |
| 0.85–0.90 | 1 |
| 0.90–0.95 | 2 |
| 0.95–1.00 | 4 |
| 1.00 (exact) | 65 |

## Branches

| branch | officials | dollars | remediation |
|---|---:|---:|---|
| CROSS-PERSON MISATTRIBUTION | 0 | $0 | delete the mis-bound rows — another person's donors |
| SAME-PERSON DUPLICATE | 4 | $4,488,739 | merge the two official rows, carrying the FK surface |
| UNIQUE HOLDER | 82 | $1,798,004 | **write the missing `source_ids` id** — do NOT remove rows |

### How SAME vs CROSS is decided

Same-person evidence is the **union of two independent signals** — `name` (first names agree
on a 3-letter key) and `seat` (the twin's CAND_ID describes the chamber AND state this official
actually holds). CROSS-PERSON is the residual: neither signal fires.

- decided `name+seat`: 0
- decided `seat` only: 1
- decided `name` only: 3
- `neither` → CROSS-PERSON: 0

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

**Low-confidence corner:** 78 suspect(s) clear the fraction cut but not the absolute floor, so they are filed as UNIQUE HOLDER (the non-destructive default). They are the ambiguous population, not confident singletons — re-check them by hand in PR 2. Grep the TSV for `overlap_frac >= 0.1667` with `branch=UNIQUE HOLDER`.

## Reference cases

| case | expected branch | observed | shared pairs | ✓ |
|---|---|---|---:|:-:|
| Shontel M. Brown → Sherrod Brown | CROSS-PERSON MISATTRIBUTION | **ABSENT — delete evidence missing** (money=true, cand_id=true) | — | ✗ |
| Jon Ossoff (elected) → Ossoff (candidate) | SAME-PERSON DUPLICATE | MERGED (holds $39,800,406, carries its CAND_ID, no rival claim) | — | ✓ |

> **STOP — a reference case is missing or in the wrong branch. The signal is wrong;
> do not act on these numbers until it is re-derived.**

## Top suspects by dollars

| official | tier | branch | rows | dollars | window | twin | shared |
|---|---|---|---:|---:|---|---|---:|
| Scott Wiener | elected (inactive) | SAME-PERSON DUPLICATE | 1,169 | $2,695,222 | 2023-03-01→2026-03-26 | Scott Wiener (H8CA11116) | 1,169 |
| Al Green | elected | SAME-PERSON DUPLICATE | 680 | $1,286,478 | 2019-01-16→2026-03-31 | Alexander Green (H4TX09095) | 679 |
| Christine Jones | elected (inactive) | SAME-PERSON DUPLICATE | 473 | $352,051 | 2025-07-24→2026-02-11 | Chris Jones (H6AR02286) | 473 |
| Sarah Duffy | elected (inactive) | UNIQUE HOLDER | 134 | $324,593 | 2019-01-15→2019-10-03 | — | 0 |
| Alan Armstrong | elected | UNIQUE HOLDER | 28 | $162,500 | 2023-03-03→2024-06-03 | Kelly Armstrong (H8ND00096) | 28 |
| Connie Chan | elected (inactive) | SAME-PERSON DUPLICATE | 146 | $154,988 | 2025-11-15→2026-03-30 | Connie Chan (H6CA11268) | 146 |
| John Bush | elected | UNIQUE HOLDER | 21 | $110,000 | 2023-02-14→2024-08-01 | Cori Bush (H8MO01143) | 21 |
| Ken Bruce | elected (inactive) | UNIQUE HOLDER | 22 | $72,400 | 2022-02-18→2022-07-27 | Kalena Bruce (H2MO04173) | 21 |
| Louis Sarmiento | elected (inactive) | UNIQUE HOLDER | 39 | $72,192 | 2025-11-14→2026-02-12 | Crystal Sarmiento (H6TX09199) | 39 |
| James May | elected (inactive) | UNIQUE HOLDER | 61 | $70,934 | 2022-10-05→2026-03-31 | Karla May (S4MO00276) | 45 |
| Brad Sinclair | elected (inactive) | UNIQUE HOLDER | 17 | $55,550 | 2022-01-21→2023-03-29 | Kyle Sinclair (H2TX20096) | 10 |
| Jacqueline Nguyen | elected | UNIQUE HOLDER | 11 | $55,000 | 2023-02-28→2024-03-01 | Kim Nguyen (H4CA45121) | 11 |
| Gabriel Cabrera | elected (inactive) | UNIQUE HOLDER | 33 | $48,100 | 2023-09-05→2024-05-28 | Ming Cabrera (H4MT02056) | 33 |
| Cassandra Costello | elected (inactive) | UNIQUE HOLDER | 30 | $42,384 | 2019-03-12→2025-12-31 | David Costello (S4ME00113) | 28 |
| Jana Mims | elected (inactive) | UNIQUE HOLDER | 36 | $38,350 | 2025-09-21→2026-03-10 | Dan Mims (H6TX09165) | 36 |
| Robert Moyer | elected (inactive) | UNIQUE HOLDER | 43 | $38,281 | 2025-08-14→2026-03-19 | Eric Moyer (H6NE01135) | 43 |
| Emily Diamond | elected (inactive) | UNIQUE HOLDER | 14 | $38,000 | 2021-05-25→2022-04-13 | Ben Diamond (H2FL13220) | 14 |
| Mona Sanchez | elected (inactive) | UNIQUE HOLDER | 39 | $36,750 | 2025-11-13→2025-12-31 | Monica Sanchez (H6CA38147) | 39 |
| Mayor Kirk Watson | elected | UNIQUE HOLDER | 12 | $33,812 | 2019-03-14→2026-03-08 | Colby Watson (H6NC08202) | 4 |
| Michele Thompson | elected (inactive) | UNIQUE HOLDER | 21 | $30,621 | 2023-03-29→2025-01-24 | Michael Thompson (H6FL01275) | 20 |
| Donna Hall | elected (inactive) | UNIQUE HOLDER | 38 | $30,068 | 2023-12-05→2024-09-08 | Donyale Hall (H4DE00060) | 38 |
| Marisela Reyes | elected (inactive) | UNIQUE HOLDER | 10 | $26,750 | 2020-07-10→2021-08-27 | Victor Reyes (H2NM01177) | 9 |
| Kara Stoll | elected | UNIQUE HOLDER | 15 | $26,150 | 2022-02-17→2022-04-11 | Matthew Stoll (H2CA22249) | 15 |
| Britt Grant | elected | UNIQUE HOLDER | 27 | $24,619 | 2020-01-30→2026-03-23 | Madaris Grant (H6OH08364) | 26 |
| Sandra O'Connor | elected | UNIQUE HOLDER | 3 | $22,750 | 2020-07-16→2021-06-28 | Kevin O'Connor (S0MA00232) | 2 |

---

Figures are environment-specific. **Re-derive on prod before acting on any of them.**
