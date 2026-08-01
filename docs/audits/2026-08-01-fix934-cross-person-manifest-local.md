# FIX-934 phase 1 — CROSS-PERSON misattribution manifest (local)

Generated 2026-08-01T07:25:13.360Z — **read-only, nothing written**.

## Headline

- Branch size re-derived live: **71** suspects (70 after by-name exclusions).
- Total money under review: **$70,218,542**.

| verdict | officials | dollars |
|---|---:|---:|
| DUPLICATED | 66 | $61,136,596 |
| MIXED | 4 | $9,081,946 |

## The model changed: the unit is the ROW, not the official

A surname-matched suspect accumulates money from **every** same-surname CAND_ID the
matcher ever mis-resolved, so its holding is typically a **union** of several people's
money split cleanly by cycle. A whole-official collision rate against the single best
twin therefore cannot classify it. Rows are split three ways instead:

- **OWN** — the colliding counterpart is the suspect's own other `officials` row
  (e.g. Shontel M. Brown vs `M Brown [H2OH11169]`, Representative OH-11 — her own
  candidate row). This money is **hers**. Deleting it from the suspect would delete a
  sitting member's own donors. These pairs are [[FIX-933]] merges, not deletes.
- **CROSS** — the colliding counterpart is a different person who already holds the
  money. This is the only safely deletable class.
- **DIVERTED** — held by nobody. It is the only copy, so it can only be moved.

## The DIVERTED bucket is a cycle-coverage artifact, not evidence of diversion

| cycle | dollars | rows | PAC rows |
|---|---:|---:|---:|
| 2024 | $2,200 | 4 | 0 |
| 2026 | $11,300 | 3 | 0 |

**No `tier='candidate'` row anywhere in the database holds a single cycle-2020 or
cycle-2022 `financial_relationships` row** — the `cn{yy}` stage was only ingested for
cn24/cn26, and cycles 2020/2022 additionally carry zero `fec_bulk_indiv` rows. So a
2020 or 2022 row on a mis-bound official can never have a same-surname counterpart and
lands in DIVERTED **by construction, whoever's money it is**. That bucket cannot be
remediated by this PR: it can neither be deleted (it is the only copy) nor moved (the
owner is unrecoverable — nothing in `financial_relationships` records a CAND_ID).
Tracked as FIX-952.

## Amount parity — the CROSS delete is not unconditionally lossless

35 officials hold a CROSS copy whose amount DISAGREES with the true
owner's copy of the same key, totalling $285,875 held above the owner.
These are aggregated rows, so two bindings written at different times hold different
cumulative totals. Phase 2 must apply FIX-933's fresher-wins rule to them rather than an
unconditional delete.

| official | mismatched rows | of CROSS rows | suspect excess | owner excess |
|---|---:|---:|---:|---:|
| Heather Cooke | 260 | 4871 | $17,500 | $242,534 |
| Al Green | 36 | 1346 | $36,450 | $22,435 |
| David Coleman | 7 | 1002 | $21,500 | $0 |
| Beverly Andrews | 134 | 2705 | $0 | $85,128 |
| Gregory Phillips | 49 | 1484 | $93,300 | $0 |
| Brandon Williamson | 1 | 1408 | $0 | $250 |
| Stuart Duncan | 2 | 718 | $2,000 | $0 |
| Mark Bennett | 210 | 1205 | $0 | $202,710 |
| Sage Lawrence | 50 | 655 | $0 | $43,290 |
| Jane Roth | 68 | 721 | $1,000 | $47,808 |
| Yvette Mendoza | 183 | 1185 | $0 | $252,397 |
| Jacquel Gibbs | 18 | 467 | $39,000 | $16,951 |
| Rachel Morris | 30 | 474 | $0 | $48,123 |
| Bill Barnes | 2 | 242 | $0 | $3,500 |
| Susan Delgado | 5 | 351 | $11,175 | $0 |
| Darryl Brooks | 43 | 512 | $16,000 | $48,150 |
| Wendy Harrison | 17 | 237 | $38,200 | $10,700 |
| Michelle Price | 1 | 267 | $2,500 | $0 |
| Paul Lewis | 4 | 220 | $1,000 | $5,760 |
| Tammy J. Morales | 1 | 609 | $1,000 | $0 |
| Helen Daniels | 2 | 674 | $250 | $250 |
| Emily Villegas | 117 | 611 | $0 | $115,616 |
| Bill Reeves | 1 | 256 | $0 | $1,500 |
| Emilia Sanchez | 20 | 56 | $5,000 | $75,800 |
| Trinh Bartlett | 9 | 250 | $0 | $13,550 |
| Noelle Simmons | 26 | 400 | $0 | $12,350 |
| Barbara Kaufman | 16 | 219 | $0 | $8,400 |
| Alex Zamora | 13 | 187 | $0 | $10,450 |
| Richard Whipple | 19 | 120 | $0 | $19,300 |
| Luis Herrera | 2 | 209 | $0 | $2,000 |
| Myrna Rios | 9 | 125 | $0 | $2,930 |
| Mark Farrell | 13 | 91 | $0 | $11,050 |
| Becky Nagel | 1 | 108 | $0 | $291 |
| Julia Joseph | 4 | 91 | $0 | $2,250 |
| Rob Lloyd | 4 | 94 | $0 | $2,750 |

## Manifest

| official | role | juris | verdict | total | own (keep) | cross (deletable) | diverted (move) |
|---|---|---|---|---:|---:|---:|---:|
| David Porter | Federal Judge | US | DUPLICATED | $7,391,766 | $0 | $7,391,766 | $0 |
| Heather Cooke | Council Member | AUS | DUPLICATED | $6,001,754 | $0 | $6,001,754 | $0 |
| Al Green | Representative | TX | MIXED | $3,941,878 | $1,286,478 | $2,655,400 | $0 |
| David Coleman | Council Member | AUS | DUPLICATED | $2,585,174 | $0 | $2,585,174 | $0 |
| Beverly Andrews | Council Member | AUS | DUPLICATED | $2,254,585 | $0 | $2,254,585 | $0 |
| Gregory Phillips | Federal Judge | US | DUPLICATED | $2,121,088 | $0 | $2,121,088 | $0 |
| Radhika Fox | Council Member | SF | DUPLICATED | $1,975,721 | $0 | $1,975,721 | $0 |
| Richard Greene | Council Member | SEA | MIXED | $1,961,461 | $0 | $1,960,261 | $1,200 |
| Brandon Williamson | Council Member | AUS | DUPLICATED | $1,913,472 | $0 | $1,913,472 | $0 |
| Stuart Duncan | Federal Judge | US | DUPLICATED | $1,912,303 | $0 | $1,912,303 | $0 |
| Mark Bennett | Federal Judge | US | DUPLICATED | $1,837,966 | $0 | $1,837,966 | $0 |
| Sage Lawrence | Council Member | SEA | DUPLICATED | $1,753,417 | $0 | $1,753,417 | $0 |
| Jane Roth | Federal Judge | US | MIXED | $1,734,583 | $0 | $1,723,283 | $11,300 |
| Gena McKinley | Council Member | AUS | DUPLICATED | $1,652,618 | $0 | $1,652,618 | $0 |
| Teresa Dixon | Council Member | AUS | DUPLICATED | $1,575,179 | $0 | $1,575,179 | $0 |
| Yvette Mendoza | Council Member | AUS | DUPLICATED | $1,571,436 | $0 | $1,571,436 | $0 |
| Joy Hollingsworth | Council Member | SEA | DUPLICATED | $1,490,344 | $0 | $1,490,344 | $0 |
| HB Harper | Council Member | SEA | MIXED | $1,444,024 | $0 | $1,443,024 | $1,000 |
| Jacquel Gibbs | Council Member | AUS | DUPLICATED | $1,394,118 | $0 | $1,394,118 | $0 |
| Jesse Franz | Council Member | SEA | DUPLICATED | $1,316,422 | $0 | $1,316,422 | $0 |
| Saroja Reddy | Council Member | SEA | DUPLICATED | $1,313,782 | $0 | $1,313,782 | $0 |
| Rachel Morris | Council Member | AUS | DUPLICATED | $1,270,266 | $0 | $1,270,266 | $0 |
| Bill Barnes | Council Member | SF | DUPLICATED | $1,211,822 | $0 | $1,211,822 | $0 |
| Susan Delgado | Council Member | AUS | DUPLICATED | $1,068,277 | $0 | $1,068,277 | $0 |
| Darryl Brooks | Council Member | SEA | DUPLICATED | $993,733 | $0 | $993,733 | $0 |
| Conor Johnston | Council Member | SF | DUPLICATED | $926,011 | $0 | $926,011 | $0 |
| Wendy Harrison | Council Member | AUS | DUPLICATED | $905,958 | $0 | $905,958 | $0 |
| Jason Elliott | Council Member | SF | DUPLICATED | $883,848 | $0 | $883,848 | $0 |
| Mayor Pro Tem José ''Chito'' Vela | Council Member | AUS | DUPLICATED | $843,360 | $0 | $843,360 | $0 |
| Michelle Price | Council Member | AUS | DUPLICATED | $837,250 | $0 | $837,250 | $0 |
| Paul Lewis | Council Member | AUS | DUPLICATED | $746,636 | $0 | $746,636 | $0 |
| Tammy J. Morales | Council Member | SEA | DUPLICATED | $745,008 | $0 | $745,008 | $0 |
| Elaine Hart | Council Member | AUS | DUPLICATED | $733,612 | $0 | $733,612 | $0 |
| Paul Niemeyer | Federal Judge | US | DUPLICATED | $720,866 | $0 | $720,866 | $0 |
| Abigail Maher | Council Member | SF | DUPLICATED | $719,298 | $0 | $719,298 | $0 |
| Helen Daniels | Council Member | SF | DUPLICATED | $689,698 | $0 | $689,698 | $0 |
| Emily Villegas | Council Member | AUS | DUPLICATED | $667,509 | $0 | $667,509 | $0 |
| Bill Reeves | Council Member | AUS | DUPLICATED | $465,226 | $0 | $465,226 | $0 |
| Terrence O'Brien | Federal Judge | US | DUPLICATED | $448,587 | $0 | $448,587 | $0 |
| Robin Harvey | Council Member | AUS | DUPLICATED | $424,149 | $0 | $424,149 | $0 |
| Adam Schaefer | Council Member | SEA | DUPLICATED | $385,511 | $0 | $385,511 | $0 |
| Emilia Sanchez | Council Member | SEA | DUPLICATED | $385,000 | $0 | $385,000 | $0 |
| Trinh Bartlett | Council Member | AUS | DUPLICATED | $377,366 | $0 | $377,366 | $0 |
| Noelle Simmons | Council Member | SF | DUPLICATED | $358,389 | $0 | $358,389 | $0 |
| Barbara Kaufman | Council Member | SF | DUPLICATED | $346,024 | $0 | $346,024 | $0 |
| Alex Zamora | Council Member | AUS | DUPLICATED | $338,474 | $0 | $338,474 | $0 |
| Dennis Shedd | Federal Judge | US | DUPLICATED | $301,718 | $0 | $301,718 | $0 |
| Council Member Mike Siegel | Council Member | AUS | DUPLICATED | $294,676 | $0 | $294,676 | $0 |
| Monica Guzman | Council Member | SF | DUPLICATED | $204,638 | $0 | $204,638 | $0 |
| Donna Hood | Council Member | SF | DUPLICATED | $197,900 | $0 | $197,900 | $0 |
| Richard Whipple | Council Member | SF | DUPLICATED | $194,890 | $0 | $194,890 | $0 |
| Danielle  Love | Council Member | AUS | DUPLICATED | $190,662 | $0 | $190,662 | $0 |
| Norman Stahl | Federal Judge | US | DUPLICATED | $186,909 | $0 | $186,909 | $0 |
| Sadie Spalding | Council Member | AUS | DUPLICATED | $183,663 | $0 | $183,663 | $0 |
| Maureen Singleton | Council Member | SF | DUPLICATED | $183,257 | $0 | $183,257 | $0 |
| Luis Herrera | Council Member | SF | DUPLICATED | $178,024 | $0 | $178,024 | $0 |
| Myrna Rios | Council Member | AUS | DUPLICATED | $164,989 | $0 | $164,989 | $0 |
| Lish Whitson | Council Member | SEA | DUPLICATED | $155,528 | $0 | $155,528 | $0 |
| Jocelyn Kane | Council Member | SF | DUPLICATED | $151,628 | $0 | $151,628 | $0 |
| Sandra Campbell | Council Member | AUS | DUPLICATED | $133,880 | $0 | $133,880 | $0 |
| Mark Farrell | Council Member | SF | DUPLICATED | $123,734 | $0 | $123,734 | $0 |
| Cynthia Goldstein | Council Member | SF | DUPLICATED | $119,072 | $0 | $119,072 | $0 |
| Ruben Aleman | Council Member | AUS | DUPLICATED | $103,406 | $0 | $103,406 | $0 |
| Julius Richardson | Federal Judge | US | DUPLICATED | $93,875 | $0 | $93,875 | $0 |
| Don Willett | Federal Judge | US | DUPLICATED | $93,250 | $0 | $93,250 | $0 |
| Ketil Freeman | Council Member | SEA | DUPLICATED | $89,194 | $0 | $89,194 | $0 |
| Becky Nagel | Council Member | AUS | DUPLICATED | $65,445 | $0 | $65,445 | $0 |
| Julia Joseph | Council Member | AUS | DUPLICATED | $65,242 | $0 | $65,242 | $0 |
| Rob Lloyd | Council Member | SEA | DUPLICATED | $56,249 | $0 | $56,249 | $0 |
| Charice Pennie | Council Member | SEA | DUPLICATED | $51,744 | $0 | $51,744 | $0 |

## Per-official detail

### David Porter — Federal Judge / US / elected — DUPLICATED

Total $7,391,766 across 6133 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $5,693,249 | 5660 | 2024–2024 | Katherine Porter [S4CA00522] holding $5,693,249 |
| CROSS | $1,673,007 | 442 | 2020–2022 | Katherine Porter [H8CA45130] holding $1,673,007 |
| CROSS | $25,510 | 31 | 2026–2026 | Ferguson Porter [H6CA41232] holding $25,510 |

$0 same-surname destinations to review: John Porter [H2CA33253] Candidate for Representative; Kevin Porter [H2FL11182] Candidate for Representative; Chris Porter [H2ID02232] Candidate for Representative; Jenette Porter [H2LA02255] Candidate for Representative; Deshon Porter [H6TX18208] Candidate for Representative; Deshon Porter [H6TX18216] Candidate for Representative; Ernest Porter [H8VA02095] Candidate for Representative; Stevan Porter [H8VA11088] Candidate for Representative; Crystal Porter [P00012690] Candidate for President; Dorsey Porter [P40009631] Candidate for President; Deshon Porter [S2MO00569] Candidate for Senator

### Heather Cooke — Council Member / AUS / elected — DUPLICATED

Total $6,001,754 across 4871 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $5,299,601 | 4668 | 2022–2026 | Rebecca Cooke [H2WI03130] holding $6,335,566 |
| CROSS | $756,153 | 212 | 2024–2026 | Rebecca Cooke [H4WI03169] holding $850,353 |

$0 same-surname destinations to review: Kevin Cooke [H0GA14071] Candidate for Representative; Alexander Cooke [H6FL21109] Candidate for Representative; Robert Cooke [P40006116] Candidate for President; John Cooke [S2NC00539] Candidate for Senator

### Al Green — Representative / TX / elected — MIXED

Total $3,941,878 across 2026 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $2,228,878 | 1096 | 2020–2026 | Mark Green [H8TN07076] holding $2,133,628 |
| **OWN** | $1,285,478 | 679 | 2020–2026 | Alexander Green [H4TX09095] holding $1,517,309 |
| CROSS | $509,573 | 173 | 2022–2026 | Jennifer-Ruth Green [H2IN01172] holding $479,558 |
| CROSS | $77,807 | 74 | 2026–2026 | Amanda Green [H6FL02299] holding $176,195 |
| CROSS | $10,826 | 17 | 2026–2026 | Troy Green [S6OK04171] holding $14,265 |
| CROSS | $7,016 | 9 | 2026–2026 | Terri Green [H6AR01155] holding $16,183 |
| CROSS | $11,000 | 4 | 2022–2022 | Karen Green [H2FL08139] holding $6,000 |
| **OWN** | $6,000 | 2 | 2020–2020 | Raymond Green [H2TX29030] holding $3,500 |

$0 same-surname destinations to review: Jacquetta Green [H0CA08184] Candidate for Representative; Grace Green [H2IL11181] Candidate for Representative; Edward Green [H2MN24019] Candidate for Representative; Steven Green [H2NY09136] Candidate for Representative; Bradley Green [H4UT02338] Candidate for Representative; Dan Green [H6FL09294] Candidate for Representative; Malcolm Green [H6SC86012] Candidate for Representative; Malcolm Green [H6SC86020] Candidate for Representative; Rick Green [H8MA03114] Candidate for Representative; Bill Green [H8PA02102] Candidate for Representative; James Green [H8TX22248] Candidate for Representative; Andre Green [P00006478] Candidate for President; Wednesday Green [P00010488] Candidate for President; Mathew Green [P00011551] Candidate for President; Steven Green [S6CA01038] Candidate for Senator; Justin Green [S6FL00681] Candidate for Senator; Carmen Green [S6IN00282] Candidate for Senator

### David Coleman — Council Member / AUS / elected — DUPLICATED

Total $2,585,174 across 1002 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $2,094,158 | 798 | 2020–2026 | Bonnie Coleman [H4NJ12149] holding $2,063,658 |
| CROSS | $60,504 | 56 | 2024–2024 | Merika Coleman [H4AL02097] holding $60,504 |
| CROSS | $269,500 | 53 | 2020–2020 | Jeff Coleman [H0AL02145] holding $240,000 |
| CROSS | $120,338 | 53 | 2024–2024 | Mary Coleman [H4MO03213] holding $120,338 |
| CROSS | $14,100 | 30 | 2026–2026 | Tayhlor Coleman [H6TX10171] holding $14,100 |
| CROSS | $73,468 | 9 | 2020–2020 | Kim Coleman [H0UT04043] holding $73,468 |
| CROSS | $10,356 | 5 | 2026–2026 | Keith Coleman [H6TX08225] holding $10,356 |
| CROSS | $1,500 | 3 | 2026–2026 | Calvin Coleman [H6IL02280] holding $1,500 |
| CROSS | $10,000 | 1 | 2026–2026 | Linda Coleman [H8NC02110] holding $10,000 |
| CROSS | $250 | 1 | 2020–2020 | Lynn Coleman [H6IN02155] holding $250 |

$0 same-surname destinations to review: Jeff Coleman [H2AL02182] Candidate for Representative; Simone Coleman [H2MI13410] Candidate for Representative; Bernard Coleman [H4CO02128] Candidate for Representative; Octavia Coleman [H4GA13059] Candidate for Representative; Andy Coleman [H8OK01124] Candidate for Representative; Valerie Coleman [P40006082] Candidate for President; Gerry Coleman [P40012189] Candidate for President; Rodshawn Coleman [P80008618] Candidate for President; Marilyn Coleman [S0TX00431] Candidate for Senator

### Beverly Andrews — Council Member / AUS / elected — DUPLICATED

Total $2,254,585 across 2705 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $2,030,563 | 2529 | 2026–2026 | Annie Andrews [S6SC04239] holding $2,511,558 |
| CROSS | $115,031 | 101 | 2024–2024 | Russ Andrews [H4CO03316] holding $115,031 |
| CROSS | $72,495 | 62 | 2020–2024 | Aliscia Andrews [H0VA10186] holding $72,495 |
| CROSS | $23,900 | 10 | 2022–2022 | Annie Andrews [H2SC01127] holding $23,900 |
| CROSS | $12,296 | 2 | 2020–2020 | Robert Andrews [H0NJ01066] holding $12,296 |
| CROSS | $300 | 1 | 2022–2022 | Naomi Andrews [H2OK02307] holding $300 |

$0 same-surname destinations to review: Mark Andrews [H2CA09162] Candidate for Representative; Jeanette Andrews [H2KY05193] Candidate for Representative; Cody Andrews [S4TX00763] Candidate for Senator; Robert Andrews [S8NJ00392] Candidate for Senator

### Gregory Phillips — Federal Judge / US / elected — DUPLICATED

Total $2,121,088 across 1484 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,471,509 | 1066 | 2024–2024 | Dean Phillips [P40016131] holding $1,330,359 |
| CROSS | $852,077 | 395 | 2020–2024 | Dean Phillips [H8MN03143] holding $743,427 |
| CROSS | $39,792 | 64 | 2024–2024 | Stephanie Phillips [S4NV00262] holding $39,792 |
| CROSS | $5,010 | 7 | 2026–2026 | Rio Phillips [S6WV00170] holding $5,782 |
| CROSS | $2,500 | 1 | 2020–2020 | George Phillips [H6NY22098] holding $2,500 |

$0 same-surname destinations to review: Ricky Phillips [H0IA02198] Candidate for Representative; Tom Phillips [H0NJ07253] Candidate for Representative; Jeffrey Phillips [H2CA12166] Candidate for Representative; G Phillips [H2OR01265] Candidate for Representative; Trenten Phillips [H4CA01090] Candidate for Representative; James Phillips [H4NC13181] Candidate for Representative; Mia Phillips [H6CA32165] Candidate for Representative; Xavier Phillips [H6MO01329] Candidate for Representative; Luke Phillips [H6VA08302] Candidate for Representative; Mariah Phillips [H8TN04099] Candidate for Representative; John Phillips [P00011619] Candidate for President; Andrew Phillips [P00015123] Candidate for President; Justin Phillips [P40012429] Candidate for President; Christopher Phillips [P80007214] Candidate for President

### Radhika Fox — Council Member / SF / elected — DUPLICATED

Total $1,975,721 across 1813 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,975,721 | 1813 | 2024–2024 | Whitney Fox [H4FL13200] holding $1,975,721 |

$0 same-surname destinations to review: Dr. Fox [H0CA18084] Candidate for Representative; Devorah Fox [H0CA53156] Candidate for Representative; Richard Fox [H2CA16167] Candidate for Representative; Stephanie Fox [H2PA18226] Candidate for Representative; Joy Fox [H2RI02176] Candidate for Representative; Richard Fox [H4CA18094] Candidate for Representative; Jeremy Fox [H6CA20244] Candidate for Representative; Teresa Fox [H6WA06286] Candidate for Representative; Alexander Fox [P00008318] Candidate for President; James Fox [P00011809] Candidate for President; Glynndeavin Fox [P40005894] Candidate for President; Cherunda Fox [P60005303] Candidate for President; Jimmy Fox [P60023751] Candidate for President; Albert Fox [S2FL00680] Candidate for Senator

### Richard Greene — Council Member / SEA / elected — MIXED

Total $1,961,461 across 2028 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,957,261 | 2023 | 2020–2024 | Marjorie Greene [H0GA06192] holding $1,958,461 |
| CROSS | $3,000 | 2 | 2020–2020 | Joan Greene [H8AZ05154] holding $3,000 |
| DIVERTED | $1,200 | 3 | 2024 | held by nobody (0 PAC rows) |

$0 same-surname destinations to review: David Greene [H0OK05197] Candidate for Representative; Douglass Greene [H2NJ19031] Candidate for Representative; Shaun Greene [H4TN07174] Candidate for Representative; Michael Greene [H8KY01058] Candidate for Representative; Clifford Greene [H8WA08064] Candidate for Representative; Rosalind Greene [P00005868] Candidate for President; Emily Greene [P00017061] Candidate for President; Michael Greene [S0GA00724] Candidate for Senator

### Brandon Williamson — Council Member / AUS / elected — DUPLICATED

Total $1,913,472 across 1408 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,799,492 | 1284 | 2020–2024 | Marianne Williamson [P00009910] holding $1,799,492 |
| CROSS | $113,980 | 124 | 2026–2026 | Michael Williamson [H6VA02156] holding $114,980 |

$0 same-surname destinations to review: W Williamson [H2AZ06254] Candidate for Representative; Marianne Williamson [H4CA33085] Candidate for Representative; Monaca Williamson [H6NC12147] Candidate for Representative; Joshua Williamson [H8IN06145] Candidate for Representative

### Stuart Duncan — Federal Judge / US / elected — DUPLICATED

Total $1,912,303 across 718 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,903,803 | 715 | 2020–2024 | Jeffrey Duncan [H0SC03077] holding $1,901,803 |
| CROSS | $11,000 | 3 | 2020–2022 | John Duncan [H8TN02069] holding $8,500 |
| CROSS | $4,000 | 2 | 2020–2020 | Darren Duncan [H0IL15186] holding $2,000 |

$0 same-surname destinations to review: Hunter Duncan [H0CA50194] Candidate for Representative; Daniel Duncan [H4SC03145] Candidate for Representative; Vince Duncan [H4TX18112] Candidate for Representative; James Duncan [H6NC02114] Candidate for Representative; Chris Duncan [H8TX08122] Candidate for Representative; Scott Duncan [S6KY00195] Candidate for Senator; James Duncan [S6KY00419] Candidate for Senator; Alexander Duncan [S6TX00339] Candidate for Senator; Alexander Duncan [S6TX00354] Candidate for Senator

### Mark Bennett — Federal Judge / US / elected — DUPLICATED

Total $1,837,966 across 1205 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,605,663 | 1064 | 2026–2026 | Rebecca Bennett [H6NJ07201] holding $2,387,584 |
| CROSS | $40,800 | 47 | 2026–2026 | Christopher Bennett [H6CA06268] holding $93,119 |
| CROSS | $25,740 | 30 | 2024–2024 | Jim Bennett [H4GA03050] holding $25,740 |
| CROSS | $101,924 | 30 | 2020–2020 | Lynda Bennett [H0NC11191] holding $101,924 |
| CROSS | $22,666 | 19 | 2026–2026 | Candice Bennett [H6VA11082] holding $22,666 |
| CROSS | $33,300 | 8 | 2020–2020 | Adrienne Bennett [H0ME02075] holding $33,300 |
| CROSS | $5,575 | 6 | 2026–2026 | Timothy Bennett [H6CO07122] holding $12,188 |
| CROSS | $2,298 | 1 | 2020–2020 | Douglas Bennett [H8IL10115] holding $2,298 |

$0 same-surname destinations to review: Ashley Bennett [H0NJ02163] Candidate for Representative; Justin Bennett [H2SC04162] Candidate for Representative; Ken Bennett [H6AZ01173] Candidate for Representative; Robert Bennett [H6NC02197] Candidate for Representative; Shantele Bennett [S2FL00540] Candidate for Senator; Shantele Bennett [S4FL00751] Candidate for Senator; Douglas Bennett [S6IL00391] Candidate for Senator

### Sage Lawrence — Council Member / SEA / elected — DUPLICATED

Total $1,753,417 across 655 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $939,677 | 280 | 2020–2022 | Brenda Lawrence [H2MI14111] holding $939,677 |
| CROSS | $279,640 | 275 | 2026–2026 | William Lawrence [H6MI07298] holding $426,366 |
| CROSS | $524,900 | 84 | 2024–2024 | Case Lawrence [H4UT03278] holding $524,900 |
| CROSS | $8,950 | 15 | 2026–2026 | Jacob Lawrence [H6NC11230] holding $8,950 |
| CROSS | $250 | 1 | 2026–2026 | Diana Lawrence [H6AR03136] holding $250 |

$0 same-surname destinations to review: Michael Lawrence [H0TX27079] Candidate for Representative; John Lawrence [H4MI06139] Candidate for Representative; Mary Lawrence [H6MN02123] Candidate for Representative; Jim Lawrence [H6NH02238] Candidate for Representative; Derickson Lawrence [H6NY16132] Candidate for Representative; Michele Lawrence [H8PA01245] Candidate for Representative

### Jane Roth — Federal Judge / US / elected — MIXED

Total $1,734,583 across 724 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $619,204 | 379 | 2026–2026 | Michael Roth [H6NJ07235] holding $817,237 |
| CROSS | $1,057,579 | 286 | 2024–2024 | Roger Roth [H4WI08085] holding $1,057,579 |
| CROSS | $31,800 | 35 | 2024–2024 | David Roth [H4ID02089] holding $31,550 |
| CROSS | $13,800 | 19 | 2024–2024 | Franklin Roth [H4MO08238] holding $13,550 |
| CROSS | $1,400 | 3 | 2026–2026 | David Roth [S6ID00138] holding $2,150 |
| CROSS | $10,000 | 1 | 2024–2024 | Roger Roth [H0WI08117] holding $11,000 |
| DIVERTED | $11,300 | 3 | 2026 | held by nobody (0 PAC rows) |

$0 same-surname destinations to review: Michael Roth [H0NY19170] Candidate for Representative; Marc Roth [S2CA01326] Candidate for Senator; David Roth [S2ID00178] Candidate for Senator

### Gena McKinley — Council Member / AUS / elected — DUPLICATED

Total $1,652,618 across 464 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,649,000 | 463 | 2020–2022 | David Mckinley [H0WV01072] holding $1,649,000 |
| CROSS | $3,618 | 1 | 2020–2020 | Douglas Mckinley [H6WA04141] holding $3,618 |

$0 same-surname destinations to review: Michael Mckinley [P00012138] Candidate for President

### Teresa Dixon — Council Member / AUS / elected — DUPLICATED

Total $1,575,179 across 773 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,558,795 | 743 | 2024–2024 | Peter Dixon [H4CA16247] holding $1,558,795 |
| CROSS | $10,856 | 18 | 2024–2024 | Gregg Dixon [H2SC06134] holding $10,856 |
| CROSS | $4,028 | 9 | 2026–2026 | Case Dixon [H6AL06135] holding $7,528 |
| CROSS | $1,500 | 3 | 2024–2024 | David Dixon [H4NC13124] holding $1,500 |

$0 same-surname destinations to review: Arthur Dixon [H2TX30160] Candidate for Representative; Pat Dixon [H4TX20043] Candidate for Representative; Robert Dixon [H6GA12106] Candidate for Representative; Carlos Dixon [H6WI04089] Candidate for Representative; Michael Dixon [P00005470] Candidate for President; Danielle Dixon [P40011132] Candidate for President; Miche'Al Dixon [P80009053] Candidate for President; Nate Dixon [S2SC00186] Candidate for Senator; Devante Dixon [S8MO00335] Candidate for Senator

### Yvette Mendoza — Council Member / AUS / elected — DUPLICATED

Total $1,571,436 across 1185 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,348,886 | 955 | 2026–2026 | Joanna Mendoza [H6AZ06099] holding $3,497,899 |
| CROSS | $218,951 | 223 | 2026–2026 | Anabel Mendoza [H6IL07495] holding $218,951 |
| CROSS | $2,849 | 5 | 2024–2024 | Jesus Mendoza [H4AZ03158] holding $2,849 |
| CROSS | $750 | 2 | 2026–2026 | Valentina Mendoza [H6NJ07268] holding $750 |

$0 same-surname destinations to review: Brandon Mendoza [H0CA38165] Candidate for Representative; Sandra Mendoza [H2CA37338] Candidate for Representative; Matthew Mendoza [H6CA53062] Candidate for Representative; M.V. Mendoza [H6LA02173] Candidate for Representative; Sandra Mendoza [H8CA34191] Candidate for Representative; Manlio Mendoza [S2LA00184] Candidate for Senator; Mv Mendoza [S6LA00409] Candidate for Senator

### Joy Hollingsworth — Council Member / SEA / elected — DUPLICATED

Total $1,490,344 across 450 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,490,344 | 450 | 2020–2024 | Trey Hollingsworth [H6IN09176] holding $1,490,344 |

### HB Harper — Council Member / SEA / elected — MIXED

Total $1,444,024 across 1566 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,406,119 | 1539 | 2024–2024 | Frank Harper [S4MI00553] holding $1,407,119 |
| CROSS | $17,249 | 17 | 2026–2026 | Alex Harper [H6SC05178] holding $17,249 |
| CROSS | $7,274 | 5 | 2022–2022 | Morgan Harper [S2OH00469] holding $7,274 |
| CROSS | $7,000 | 2 | 2020–2020 | James Harper [H0IN01143] holding $7,000 |
| CROSS | $5,000 | 1 | 2020–2020 | Morgan Harper [H0OH03103] holding $5,000 |
| CROSS | $382 | 1 | 2022–2022 | John Harper [H2TX04140] holding $382 |
| DIVERTED | $1,000 | 1 | 2024 | held by nobody (0 PAC rows) |

$0 same-surname destinations to review: Jack Harper [H2AZ09258] Candidate for Representative; Charles Harper [H6TX32100] Candidate for Representative; Gregg Harper [H8MS03067] Candidate for Representative; Justin Harper [P00011510] Candidate for President; Jesse Harper [S2SC00194] Candidate for Senator

### Jacquel Gibbs — Council Member / AUS / elected — DUPLICATED

Total $1,394,118 across 467 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $858,545 | 260 | 2020–2026 | Robert Gibbs [H0OH18077] holding $808,045 |
| CROSS | $214,575 | 106 | 2026–2026 | Jason Gibbs [H6CA27306] holding $335,575 |
| CROSS | $297,048 | 82 | 2022–2022 | John Gibbs [H2MI03197] holding $272,048 |
| CROSS | $118,450 | 27 | 2020–2020 | Kate Gibbs [H0NJ03211] holding $94,450 |
| CROSS | $7,500 | 2 | 2020–2020 | Chris Gibbs [H0OH04119] holding $5,000 |

$0 same-surname destinations to review: Irwin Gibbs [S4MD00640] Candidate for Senator

### Jesse Franz — Council Member / SEA / elected — DUPLICATED

Total $1,316,422 across 943 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,316,422 | 943 | 2024–2024 | Hilary Franz [H4WA06109] holding $1,316,422 |

### Saroja Reddy — Council Member / SEA / elected — DUPLICATED

Total $1,313,782 across 605 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,313,782 | 605 | 2024–2024 | Prasanth Reddy [H4KS03212] holding $1,313,782 |

### Rachel Morris — Council Member / AUS / elected — DUPLICATED

Total $1,270,266 across 474 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,269,546 | 472 | 2026–2026 | Nate Morris [S6KY00302] holding $1,478,087 |
| CROSS | $720 | 2 | 2026–2026 | Karl Morris [H6PA03211] holding $720 |

$0 same-surname destinations to review: Matthew Morris [H0DE01066] Candidate for Representative; Genevieve Morris [H0MD02222] Candidate for Representative; Spence Morris [H2IL17154] Candidate for Representative; Robert Morris [H2NV03237] Candidate for Representative; Sonia Morris [H2SC06167] Candidate for Representative; Spencer Morris [H2SC07306] Candidate for Representative; Vincent Morris [H6DC00204] Candidate for Representative; Nate Morris [H6KY00302] Candidate for Representative; Rickey Morris [P00014498] Candidate for President; Lawrence Morris [P80008956] Candidate for President

### Bill Barnes — Council Member / SF / elected — DUPLICATED

Total $1,211,822 across 242 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,135,198 | 183 | 2022–2022 | Mandela Barnes [S2WI00441] holding $1,135,198 |
| CROSS | $48,081 | 36 | 2026–2026 | Thomas Barnes [H6AL04155] holding $63,112 |
| CROSS | $24,543 | 22 | 2024–2024 | Heath Barnes [H4MD06308] holding $24,543 |
| CROSS | $4,000 | 1 | 2020–2020 | Sanjanetta Barnes [H0TX14176] holding $4,000 |

$0 same-surname destinations to review: John Barnes [H2OH11185] Candidate for Representative; Mickeda Barnes [H4RI01158] Candidate for Representative; Daryl Barnes [H4TX18146] Candidate for Representative; Brice Barnes [H6FL02398] Candidate for Representative; Chanelle Barnes [H6FL11258] Candidate for Representative; Anthony Barnes [H6IL15126] Candidate for Representative; Levy Barnes [H8TX14138] Candidate for Representative; Jason Barnes [P00008409] Candidate for President; Audwin Barnes [P00012922] Candidate for President

### Susan Delgado — Council Member / AUS / elected — DUPLICATED

Total $1,068,277 across 351 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,006,489 | 328 | 2020–2022 | Antonio Delgado [H8NY19181] holding $1,002,489 |
| CROSS | $49,750 | 20 | 2020–2022 | Antonio Delgado [H0CA40138] holding $45,750 |
| CROSS | $10,250 | 5 | 2020–2020 | Jorge Delgado [H0MD01216] holding $8,250 |
| CROSS | $11,788 | 2 | 2026–2026 | Adam Delgado [S6IL00607] holding $7,367 |

$0 same-surname destinations to review: Jimmy Delgado [P00009597] Candidate for President

### Darryl Brooks — Council Member / SEA / elected — DUPLICATED

Total $993,733 across 512 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $475,550 | 336 | 2026–2026 | Bob Brooks [H6PA07188] holding $966,270 |
| CROSS | $213,050 | 82 | 2020–2020 | Susan Brooks [H2IN05082] holding $170,550 |
| CROSS | $268,937 | 79 | 2020–2022 | Mo Brooks [H0AL05163] holding $250,937 |
| CROSS | $90,050 | 25 | 2020–2022 | Mo Brooks [S8AL00381] holding $89,550 |
| CROSS | $7,146 | 1 | 2022–2022 | Linda Brooks [H2FL02140] holding $7,146 |

$0 same-surname destinations to review: Clayton Brooks [H0NC09278] Candidate for Representative; Raymond Brooks [H2MS04266] Candidate for Representative; Janis Brooks [H2PA14092] Candidate for Representative; Natisha Brooks [H2TN05347] Candidate for Representative; Doris Brooks [H8GU01046] Candidate for Representative; Janis Brooks [H8PA18272] Candidate for Representative; John Brooks [P40009854] Candidate for President; Sharon Brooks [P40012767] Candidate for President; Rochelle-Maretta Brooks [P40020067] Candidate for President; Arthur Brooks [P60007341] Candidate for President; Shyyan Brooks [P60021680] Candidate for President; Natisha Brooks [S0TN00235] Candidate for Senator; Christopher Brooks [S6MN00523] Candidate for Senator

### Conor Johnston — Council Member / SF / elected — DUPLICATED

Total $926,011 across 561 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $923,511 | 558 | 2024–2024 | Courtney Johnston [H4TN05137] holding $923,511 |
| CROSS | $2,500 | 3 | 2026–2026 | Mark Johnston [H6NE02166] holding $2,500 |

$0 same-surname destinations to review: Clayton Johnston [H4FL01254] Candidate for Representative; Jacob Johnston [P00006163] Candidate for President; Michael Johnston [S0CO00468] Candidate for Senator

### Wendy Harrison — Council Member / AUS / elected — DUPLICATED

Total $905,958 across 237 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $851,710 | 186 | 2020–2022 | Jaime Harrison [S0SC00289] holding $806,510 |
| CROSS | $20,320 | 37 | 2026–2026 | Raven Harrison [H6FL23139] holding $37,607 |
| CROSS | $108,800 | 12 | 2020–2020 | Brigid Harrison [H0NJ02197] holding $55,800 |
| CROSS | $19,794 | 7 | 2022–2022 | Brian Harrison [H2TX06269] holding $19,794 |
| CROSS | $7,034 | 4 | 2020–2020 | Gladys Harrison [H0NE02185] holding $3,534 |

$0 same-surname destinations to review: Jayla Harrison [H0GA06150] Candidate for Representative; Peter Harrison [H0NY12191] Candidate for Representative; Sean Harrison [H2CA10210] Candidate for Representative; Raven Harrison [H2TX26200] Candidate for Representative; Leonard Harrison [H4NC04123] Candidate for Representative; Raven Harrison [H6GA23012] Candidate for Representative; Thomas Harrison [H8OR03102] Candidate for Representative; Peter Harrison [H8WA03180] Candidate for Representative; Alvin Harrison [P00009936] Candidate for President; David Harrison [P20005773] Candidate for President

### Jason Elliott — Council Member / SF / elected — DUPLICATED

Total $883,848 across 814 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $398,223 | 427 | 2024–2024 | Glenn Elliott [S4WV00399] holding $398,223 |
| CROSS | $209,807 | 274 | 2022–2026 | Steven Elliott [H2MI13311] holding $209,807 |
| CROSS | $273,818 | 111 | 2020–2020 | Joyce Elliott [H0AR02206] holding $273,818 |
| CROSS | $2,000 | 2 | 2020–2020 | Bob Elliott [H0CA10271] holding $2,000 |
| CROSS | $1,000 | 1 | 2020–2020 | Joyce Elliott [H0AR02131] holding $19,000 |

$0 same-surname destinations to review: Paul Elliott [H0FL14131] Candidate for Representative; Joshua Elliott [H0NV01052] Candidate for Representative; Josh Elliott [H0NV01227] Candidate for Representative; Paul Elliott [H2FL12065] Candidate for Representative; Stephen Elliott [H6FL19210] Candidate for Representative; Claire Elliott [P80003643] Candidate for President; Kevin Elliott [S0KY00305] Candidate for Senator

### Mayor Pro Tem José ''Chito'' Vela — Council Member / AUS / elected — DUPLICATED

Total $843,360 across 234 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $843,360 | 234 | 2020–2024 | Filemon Vela [H2TX27190] holding $843,360 |

### Michelle Price — Council Member / AUS / elected — DUPLICATED

Total $837,250 across 267 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $837,250 | 267 | 2020–2022 | David Price [H6NC04037] holding $834,750 |
| CROSS | $10,000 | 1 | 2020–2020 | Thomas Price [H4GA06087] holding $2,500 |

$0 same-surname destinations to review: Keith Price [H0NY22109] Candidate for Representative; Jordan Price [H6TN01511] Candidate for Representative; Victor Price [H6TX02269] Candidate for Representative; Phillip Price [H8NC11103] Candidate for Representative; Carroll Price [P00009548] Candidate for President; Melinda Price [S0LA00428] Candidate for Senator; Steven Price [S2MO00601] Candidate for Senator

### Paul Lewis — Council Member / AUS / elected — DUPLICATED

Total $746,636 across 220 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $416,375 | 135 | 2020–2020 | John Lewis [H6GA05217] holding $416,375 |
| CROSS | $238,076 | 54 | 2020–2022 | Jason Lewis [S0MN00328] holding $237,076 |
| CROSS | $6,260 | 8 | 2026–2026 | Shane Lewis [H6CA18172] holding $11,520 |
| CROSS | $42,475 | 8 | 2020–2020 | Jason Lewis [H6MN02149] holding $40,475 |
| CROSS | $19,500 | 5 | 2022–2022 | Jazz Lewis [H2MD04323] holding $19,500 |
| CROSS | $17,500 | 4 | 2020–2020 | Chris Lewis [H0AL05205] holding $17,500 |
| CROSS | $4,200 | 3 | 2020–2022 | Jennifer Lewis [H8VA06138] holding $4,200 |
| CROSS | $1,000 | 2 | 2026–2026 | Nicholas Lewis [H6FL02323] holding $1,000 |
| CROSS | $4,000 | 1 | 2020–2020 | Brandon Lewis [H0TX36021] holding $4,000 |
| CROSS | $250 | 1 | 2026–2026 | Joseph Lewis [H6NJ11302] holding $1,250 |

$0 same-surname destinations to review: Rick Lewis [H0WA07147] Candidate for Representative; Jeffrey Lewis [H0WV03169] Candidate for Representative; Bob Lewis [H2CO04151] Candidate for Representative; Jamie Lewis [H2MI03221] Candidate for Representative; Timothy Lewis [H2SC01143] Candidate for Representative; Nathan Lewis [H2TX19072] Candidate for Representative; Marc Lewis [H4AZ08165] Candidate for Representative; Kerry Lewis [H4CA28093] Candidate for Representative; Keven Lewis [H6ID02217] Candidate for Representative; Jerry Lewis [H8CA37079] Candidate for Representative; Marcus Lewis [H8IL02104] Candidate for Representative; Kathyrn Lewis [H8VA06195] Candidate for Representative; Leroy Lewis [P00007690] Candidate for President; Billy Lewis [P00016204] Candidate for President; Adam Lewis [P40012809] Candidate for President; Tiffany Lewis [P40020240] Candidate for President; Wayne Lewis [P40020927] Candidate for President; Wayne Lewis [P40020935] Candidate for President; Wayne Lewis [P40020943] Candidate for President; Julian Lewis [P60005717] Candidate for President; Kerry Lewis [P80006281] Candidate for President; Michelle Lewis [S2NC00679] Candidate for Senator; Chantia Lewis [S2WI00458] Candidate for Senator

### Tammy J. Morales — Council Member / SEA / elected — DUPLICATED

Total $745,008 across 609 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $562,006 | 468 | 2024–2024 | Eduardo Morales [H4OR03168] holding $561,006 |
| CROSS | $32,700 | 61 | 2024–2024 | Jesus Morales [H4CA20132] holding $31,700 |
| CROSS | $123,750 | 58 | 2026–2026 | Richard Morales [H6NJ12383] holding $123,750 |
| CROSS | $16,180 | 14 | 2024–2024 | Adianis Morales [H2FL09277] holding $16,180 |
| CROSS | $12,372 | 9 | 2026–2026 | Mario Morales [H6TX34056] holding $12,372 |

$0 same-surname destinations to review: Joshua Morales [H0MD03246] Candidate for Representative; Robert Morales [H4NC02168] Candidate for Representative; Cristian Morales [H6CA43188] Candidate for Representative; Daniel Morales [H8AZ02227] Candidate for Representative; Hector Morales [H8TX29045] Candidate for Representative

### Elaine Hart — Council Member / AUS / elected — DUPLICATED

Total $733,612 across 195 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $717,262 | 180 | 2020–2022 | Rita Hart [H0IA02156] holding $717,262 |
| CROSS | $16,350 | 15 | 2024–2024 | Rhonda Hart [H4TX14111] holding $16,350 |

$0 same-surname destinations to review: Cody Hart [H0WA02221] Candidate for Representative; James Hart [H2TN08077] Candidate for Representative; Richard Hart [H8NV03101] Candidate for Representative; Kristopher Hart [H8PA13109] Candidate for Representative; Clara Hart [S0SD00096] Candidate for Senator

### Paul Niemeyer — Federal Judge / US / elected — DUPLICATED

Total $720,866 across 446 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $720,866 | 446 | 2024–2024 | Randell Niemeyer [H4IN01210] holding $720,866 |

### Abigail Maher — Council Member / SF / elected — DUPLICATED

Total $719,298 across 365 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $716,548 | 359 | 2022–2024 | Michael Maher [H2CA22215] holding $716,548 |
| CROSS | $2,750 | 6 | 2024–2024 | Patricia Maher [H4NY04141] holding $2,750 |

$0 same-surname destinations to review: Patricia Maher [H0NY02242] Candidate for Representative; Patricia Maher [H8NY04050] Candidate for Representative

### Helen Daniels — Council Member / SF / elected — DUPLICATED

Total $689,698 across 674 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $529,643 | 441 | 2024–2026 | Anthony Daniels [H4AL02162] holding $529,393 |
| CROSS | $92,373 | 154 | 2026–2026 | Sholdon Daniels [H4TX30109] holding $92,623 |
| CROSS | $66,682 | 76 | 2022–2026 | Shamaine Daniels [H2PA10124] holding $66,182 |
| CROSS | $1,250 | 3 | 2024–2024 | Bret Daniels [H2CA07133] holding $1,250 |
| CROSS | $500 | 1 | 2020–2020 | Teddy Daniels [H0PA08197] holding $500 |

$0 same-surname destinations to review: Michael Daniels [H2MO01203] Candidate for Representative; Pamela Daniels [H2NJ04249] Candidate for Representative; Defonsio Daniels [H6GA01125] Candidate for Representative; Sholdon Daniels [H8TX04154] Candidate for Representative

### Emily Villegas — Council Member / AUS / elected — DUPLICATED

Total $667,509 across 611 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $560,709 | 574 | 2026–2026 | Randy Villegas [H6CA22190] holding $1,108,858 |
| CROSS | $106,800 | 37 | 2022–2022 | Gilbert Villegas [H2IL03154] holding $106,800 |

### Bill Reeves — Council Member / AUS / elected — DUPLICATED

Total $465,226 across 256 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $289,773 | 159 | 2026–2026 | Lee Reeves [H6TN07187] holding $289,773 |
| CROSS | $41,492 | 40 | 2026–2026 | Bryce Reeves [S6VA00176] holding $41,492 |
| CROSS | $100,000 | 34 | 2020–2020 | Kristine Reeves [H0WA10042] holding $100,000 |
| CROSS | $15,461 | 14 | 2026–2026 | Latonya Reeves [H6MN05365] holding $23,411 |
| CROSS | $18,500 | 9 | 2022–2022 | Bryce Reeves [H2VA10216] holding $18,500 |

$0 same-surname destinations to review: Jay Reeves [H4MN06152] Candidate for Representative; Jason Reeves [H4TX33020] Candidate for Representative; Darrell Reeves [H6CA30235] Candidate for Representative; Jayson Reeves [H6IN01157] Candidate for Representative; Ernest Reeves [H6NC03161] Candidate for Representative; Jay Reeves [P40016669] Candidate for President

### Terrence O'Brien — Federal Judge / US / elected — DUPLICATED

Total $448,587 across 502 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $448,587 | 502 | 2024–2026 | Michael O'Brien [H4PA10088] holding $448,587 |

$0 same-surname destinations to review: Joshua Obrien [H4MD01192] Candidate for Representative; Colin Obrien [H8CA31122] Candidate for Representative; Megan O'Brien [P00005793] Candidate for President; James Obrien [P00016576] Candidate for President; William O'Brien [S0NH00318] Candidate for Senator

### Robin Harvey — Council Member / AUS / elected — DUPLICATED

Total $424,149 across 436 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $368,749 | 385 | 2024–2024 | Kathryn Harvey [H4SC04101] holding $368,749 |
| CROSS | $55,400 | 51 | 2024–2024 | Ted Harvey [H4CO04249] holding $55,400 |

$0 same-surname destinations to review: Jenna Harvey [H0NJ02239] Candidate for Representative; Michael Harvey [H0PA03347] Candidate for Representative; Erwin Harvey [H0TX13244] Candidate for Representative; Stephen Harvey [H2KY02133] Candidate for Representative; Terrance Harvey [H2MI03213] Candidate for Representative; Floyd Harvey [H4CA42110] Candidate for Representative; William Harvey [H4NH02449] Candidate for Representative; Cooke Harvey [H6VA05241] Candidate for Representative; Terrance Harvey [P00006734] Candidate for President; James Harvey [P00013755] Candidate for President; Terrance Harvey [P20005955] Candidate for President; Terrance Harvey [P40009425] Candidate for President; Jimmy Harvey [P40012635] Candidate for President; Tom Harvey [S2CO00332] Candidate for Senator; Terrance Harvey [S2MI00276] Candidate for Senator; Matthew Harvey [S4WI00272] Candidate for Senator

### Adam Schaefer — Council Member / SEA / elected — DUPLICATED

Total $385,511 across 159 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $385,511 | 159 | 2024–2024 | Kurt Schaefer [H4MO03239] holding $385,511 |

$0 same-surname destinations to review: Mike Schaefer [H4CA45162] Candidate for Representative; Mike Schaefer [H4CA47150] Candidate for Representative; Todd Schaefer [H4FL04068] Candidate for Representative; Mike Schaefer [H6CA48385] Candidate for Representative; Mike Schaefer [S4NV00387] Candidate for Senator

### Emilia Sanchez — Council Member / SEA / elected — DUPLICATED

Total $385,000 across 56 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $380,000 | 55 | 2024–2024 | Linda Sanchez [H2CA39078] holding $5,015,235 |
| CROSS | $20,000 | 2 | 2024–2024 | Tim Sanchez [H4CA12188] holding $88,700 |

$0 same-surname destinations to review: Abdeli Sanchez [H0CA29115] Candidate for Representative; David Sanchez [H0CA34099] Candidate for Representative; Mario Sanchez [H0CO05111] Candidate for Representative; Jay Sanchez [H0NY05096] Candidate for Representative; Michael Sanchez [H0TX14242] Candidate for Representative; Louie Sanchez [H2NM01367] Candidate for Representative; Thomas Sanchez [H4TX33012] Candidate for Representative; Anthony Sanchez [H8NJ02299] Candidate for Representative; Daniel Sanchez [P80009715] Candidate for President; William Sanchez [S2FL00623] Candidate for Senator; Loretta Sanchez [S6CA00691] Candidate for Senator

### Trinh Bartlett — Council Member / AUS / elected — DUPLICATED

Total $377,366 across 250 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $363,466 | 243 | 2026–2026 | John Bartlett [H8NJ11167] holding $377,016 |
| CROSS | $13,900 | 7 | 2022–2026 | Lisa Bartlett [H2CA49267] holding $13,900 |

$0 same-surname destinations to review: Richard Bartlett [H0TX11214] Candidate for Representative

### Noelle Simmons — Council Member / SF / elected — DUPLICATED

Total $358,389 across 400 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $343,127 | 388 | 2026–2026 | Mike Simmons [H6IL09293] holding $379,317 |
| CROSS | $2,750 | 6 | 2026–2026 | Deva Simmons [H6FL18204] holding $2,750 |
| CROSS | $12,512 | 6 | 2020–2020 | Lindsey Simmons [H0MO04235] holding $12,512 |

$0 same-surname destinations to review: John Simmons [H2TX04157] Candidate for Representative; Landry Simmons [H4OH11116] Candidate for Representative; Ifetayo Simmons [H4TX09145] Candidate for Representative; Richard Simmons [H6NY08154] Candidate for Representative; Jade Simmons [P00015537] Candidate for President; Kerry Simmons [P40008823] Candidate for President; Debbie Simmons [S0AZ00525] Candidate for Senator; Jade Simmons [S6TX00495] Candidate for Senator; Jade Simmons [S6TX00503] Candidate for Senator

### Barbara Kaufman — Council Member / SF / elected — DUPLICATED

Total $346,024 across 219 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $346,024 | 219 | 2024–2026 | Joseph Kaufman [H2FL20043] holding $404,949 |

$0 same-surname destinations to review: Joseph Kaufman [H4FL23142] Candidate for Representative; Broderick Kaufman [P40021909] Candidate for President; Brody Kaufman [P80006638] Candidate for President

### Alex Zamora — Council Member / AUS / elected — DUPLICATED

Total $338,474 across 187 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $338,474 | 187 | 2026–2026 | Martin Zamora [H6NM03083] holding $391,824 |

$0 same-surname destinations to review: Eddie Zamora [H6TX15113] Candidate for Representative

### Dennis Shedd — Federal Judge / US / elected — DUPLICATED

Total $301,718 across 101 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $301,718 | 101 | 2020–2020 | Tiffany Shedd [H8AZ01237] holding $301,718 |

### Council Member Mike Siegel — Council Member / AUS / elected — DUPLICATED

Total $294,676 across 85 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $283,676 | 81 | 2020–2020 | Michael Siegel [H8TX10110] holding $283,676 |
| CROSS | $11,000 | 4 | 2020–2020 | Cynthia Siegel [H0TX07188] holding $11,000 |

$0 same-surname destinations to review: Russell Siegel [H0WV03185] Candidate for Representative

### Monica Guzman — Council Member / SF / elected — DUPLICATED

Total $204,638 across 157 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $204,638 | 157 | 2024–2024 | Elizabeth Guzman [H4VA07275] holding $204,638 |

$0 same-surname destinations to review: Alixandria Guzman [H2AZ08219] Candidate for Representative; Mario Guzman [P20005500] Candidate for President

### Donna Hood — Council Member / SF / elected — DUPLICATED

Total $197,900 across 71 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $173,900 | 64 | 2024–2024 | Ron Hood [H4OH02271] holding $173,900 |
| CROSS | $24,000 | 7 | 2022–2022 | Ronald Hood [H0OH18101] holding $24,000 |

$0 same-surname destinations to review: Michael Hood [H0OH11114] Candidate for Representative; Gerald Hood [H2TN04274] Candidate for Representative; Brandon Hood [H8IN09123] Candidate for Representative; Michael Hood [P40011546] Candidate for President

### Richard Whipple — Council Member / SF / elected — DUPLICATED

Total $194,890 across 120 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $194,890 | 120 | 2026–2026 | Cody Whipple [H6NV04111] holding $286,610 |

$0 same-surname destinations to review: Lee Whipple [H6NC11289] Candidate for Representative; Krista Whipple [P00010371] Candidate for President

### Danielle  Love — Council Member / AUS / elected — DUPLICATED

Total $190,662 across 269 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $69,274 | 160 | 2024–2024 | John Love [H4TX06224] holding $69,274 |
| CROSS | $107,988 | 93 | 2024–2024 | Preston Love [S4NE00223] holding $107,988 |
| CROSS | $8,400 | 15 | 2024–2024 | Leslie Love [S4MI00504] holding $8,400 |
| CROSS | $5,000 | 1 | 2020–2020 | John Love [S0TX00308] holding $5,000 |

$0 same-surname destinations to review: Nicholas Love [H0HI02304] Candidate for Representative; Tommy Love [H2KS03091] Candidate for Representative; Stephen Love [H2TX26051] Candidate for Representative; Mia Love [H2UT04023] Candidate for Representative; Jay Love [H8AL02080] Candidate for Representative; John Love [H8NV03192] Candidate for Representative; Shirley Love [H8WV03121] Candidate for Representative; Barry Love [S2CA01292] Candidate for Senator

### Norman Stahl — Federal Judge / US / elected — DUPLICATED

Total $186,909 across 62 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $184,009 | 61 | 2026–2026 | Brian Stahl [H6TX06229] holding $188,590 |
| CROSS | $2,900 | 1 | 2022–2022 | Judith Stahl [H2AZ04192] holding $2,900 |

### Sadie Spalding — Council Member / AUS / elected — DUPLICATED

Total $183,663 across 250 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $183,663 | 250 | 2020–2024 | Carla Spalding [H0FL23090] holding $185,713 |

$0 same-surname destinations to review: Carla Spalding [H6FL18121] Candidate for Representative; Monique Spalding [P40008682] Candidate for President

### Maureen Singleton — Council Member / SF / elected — DUPLICATED

Total $183,257 across 73 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $183,257 | 73 | 2024–2024 | Phillip Singleton [H4GA03076] holding $183,257 |

$0 same-surname destinations to review: Neil Singleton [H2GA12154] Candidate for Representative

### Luis Herrera — Council Member / SF / elected — DUPLICATED

Total $178,024 across 209 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $168,208 | 197 | 2024–2026 | Brandon Herrera [H4TX23120] holding $232,484 |
| CROSS | $9,816 | 12 | 2026–2026 | Jordan Herrera [H6MO05254] holding $16,016 |

$0 same-surname destinations to review: Nicholas Herrera [H0CA50244] Candidate for Representative

### Myrna Rios — Council Member / AUS / elected — DUPLICATED

Total $164,989 across 125 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $164,989 | 125 | 2026–2026 | Lorenzo Rios [H6CA21234] holding $212,416 |

$0 same-surname destinations to review: Angel Rios [H2CA42163] Candidate for Representative; Francisco Rios [H2NC12211] Candidate for Representative; Angel Rios [H4MS03066] Candidate for Representative; Angel Rios [H6DC01012] Candidate for Representative; Felipe Rios [H6IN07428] Candidate for Representative; Ruben Rios [H6TX16210] Candidate for Representative; Felipe Rios [P40007122] Candidate for President

### Lish Whitson — Council Member / SEA / elected — DUPLICATED

Total $155,528 across 168 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $155,528 | 168 | 2026–2026 | Stewart Whitson [H6VA11215] holding $155,528 |

$0 same-surname destinations to review: Catherine Whitson [S6TN00414] Candidate for Senator

### Jocelyn Kane — Council Member / SF / elected — DUPLICATED

Total $151,628 across 114 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $151,628 | 114 | 2024–2024 | Caroline Kane [H4TX07099] holding $151,628 |

$0 same-surname destinations to review: Jared Kane [H6FL19202] Candidate for Representative; Nickie Kane [H6NY10184] Candidate for Representative; Tim Kane [H8OH12263] Candidate for Representative

### Sandra Campbell — Council Member / AUS / elected — DUPLICATED

Total $133,880 across 114 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $75,130 | 90 | 2024–2024 | Stanley Campbell [S4FL00637] holding $75,130 |
| CROSS | $56,750 | 21 | 2022–2022 | Heidi Campbell [H2TN05438] holding $56,750 |
| CROSS | $2,000 | 3 | 2024–2024 | Thomas Campbell [H4ND01051] holding $2,000 |

$0 same-surname destinations to review: Samantha Campbell [H0CA15288] Candidate for Representative; Walter Campbell [H0FL18223] Candidate for Representative; Walter Campbell [H0FL18231] Candidate for Representative; Walter Campbell [H0FL18249] Candidate for Representative; Matthew Campbell [H0IA05092] Candidate for Representative; Rayla Campbell [H0MA07054] Candidate for Representative; David Campbell [H0OR02192] Candidate for Representative; Matthew Campbell [H0TN02108] Candidate for Representative; Joshua Campbell [H0WA09069] Candidate for Representative; Landon Campbell [H2FL14293] Candidate for Representative; Jim Campbell [H2MO04231] Candidate for Representative; William Campbell [H2UT01276] Candidate for Representative; Cameron Campbell [H4TX38029] Candidate for Representative; Bill Campbell [H4UT01132] Candidate for Representative; Andrew Campbell [H4VA08372] Candidate for Representative; John Campbell [H6CA48039] Candidate for Representative; Shelby Campbell [H6MI13270] Candidate for Representative; Shelby Campbell [H6MI13288] Candidate for Representative; Melvin Campbell [H6PA05158] Candidate for Representative; Mike Campbell [H8IN06160] Candidate for Representative; Douglas Campbell [H8MI09084] Candidate for Representative; Tom Campbell [H8ND00104] Candidate for Representative; Joseph Campbell [P00005249] Candidate for President; Christopher Campbell [P40004616] Candidate for President; Brandon Campbell [P40013526] Candidate for President; Johnnie Campbell [P40019648] Candidate for President; Johnnie Campbell [P60005147] Candidate for President; Christopher Campbell [S6KY00377] Candidate for Senator; Foster Campbell [S6LA00359] Candidate for Senator; Antono Campbell [S8MD00328] Candidate for Senator; Tom Campbell [S8ND00104] Candidate for Senator

### Mark Farrell — Council Member / SF / elected — DUPLICATED

Total $123,734 across 91 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $97,500 | 88 | 2026–2026 | Patrick Farrell [H6GA01083] holding $142,520 |
| CROSS | $2,000 | 2 | 2022–2022 | Bridie Farrell [H2NY21156] holding $2,000 |
| CROSS | $24,234 | 1 | 2026–2026 | Michael Farrell [H6UT01236] holding $50,334 |

$0 same-surname destinations to review: Eugene Farrell [H0IL17109] Candidate for Representative

### Cynthia Goldstein — Council Member / SF / elected — DUPLICATED

Total $119,072 across 94 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $81,772 | 52 | 2024–2024 | Michael Goldstein [H0CT04229] holding $81,772 |
| CROSS | $28,500 | 36 | 2026–2026 | Alexis Goldstein [H6MD06303] holding $28,500 |
| CROSS | $5,000 | 4 | 2024–2024 | Michael Goldstein [H4CT04163] holding $5,000 |
| CROSS | $3,800 | 2 | 2020–2020 | Robbie Goldstein [H0MA08045] holding $3,800 |

$0 same-surname destinations to review: Matthew Goldstein [H2NY10290] Candidate for Representative; Beverly Goldstein [H6OH11160] Candidate for Representative; Shmuel Goldstein [P40006330] Candidate for President

### Ruben Aleman — Council Member / AUS / elected — DUPLICATED

Total $103,406 across 192 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $103,406 | 192 | 2026–2026 | Katherine Aleman [H6CA41315] holding $103,406 |

$0 same-surname destinations to review: Julian Aleman [P00016774] Candidate for President

### Julius Richardson — Federal Judge / US / elected — DUPLICATED

Total $93,875 across 127 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $90,075 | 117 | 2024–2024 | Jerica Richardson [H4GA06145] holding $90,075 |
| CROSS | $3,250 | 8 | 2024–2024 | Erik Richardson [H4MO06109] holding $3,250 |
| CROSS | $550 | 2 | 2020–2020 | Jennifer Richardson [H0MI06186] holding $550 |

$0 same-surname destinations to review: Chris Richardson [H0CA07145] Candidate for Representative; Mark Richardson [H0OH03111] Candidate for Representative; Keith Richardson [H2IL12148] Candidate for Representative; Montel Richardson [H2NC07112] Candidate for Representative; William Richardson [H2SC07173] Candidate for Representative; John Richardson [H4FL16195] Candidate for Representative; John Richardson [H4FL18126] Candidate for Representative; Jonathan Richardson [H4KY06205] Candidate for Representative; Quincy Richardson [H4PA01129] Candidate for Representative; Bruce Richardson [H6TX23240] Candidate for Representative; Robert Richardson [H8CA07080] Candidate for Representative; Laura Richardson [H8CA37137] Candidate for Representative; Chardo Richardson [H8FL07054] Candidate for Representative; David Richardson [H8FL27060] Candidate for Representative; Cecil Richardson [P00006445] Candidate for President; Tambra Richardson [P00014993] Candidate for President; Darcy Richardson [P20001376] Candidate for President; Anthony Richardson [P40014623] Candidate for President; Anthony Richardson [P80008584] Candidate for President; Max Richardson [S2PA00620] Candidate for Senator

### Don Willett — Federal Judge / US / elected — DUPLICATED

Total $93,250 across 86 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $93,250 | 86 | 2026–2026 | Joel Willett [S6KY00336] holding $93,250 |

$0 same-surname destinations to review: Nathan Willett [H6MO06294] Candidate for Representative

### Ketil Freeman — Council Member / SEA / elected — DUPLICATED

Total $89,194 across 105 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $55,850 | 73 | 2024–2026 | Esau Freeman [H2KS04099] holding $55,850 |
| CROSS | $9,500 | 16 | 2024–2024 | Sarah Freeman [H4TN08123] holding $9,500 |
| CROSS | $9,094 | 10 | 2024–2024 | Sean Freeman [H4OH11074] holding $9,094 |
| CROSS | $14,750 | 6 | 2024–2026 | Kyle Freeman [S6SC04197] holding $15,250 |

$0 same-surname destinations to review: Morgann Freeman [H0NE02177] Candidate for Representative; Kevin Freeman [H0NH01274] Candidate for Representative; Gordon Freeman [H2NM02183] Candidate for Representative; Kymone Freeman [H4DC00100] Candidate for Representative; Mark Freeman [H6FL22081] Candidate for Representative; Sean Freeman [H6OH11202] Candidate for Representative; Jake Freeman [P00016139] Candidate for President

### Becky Nagel — Council Member / AUS / elected — DUPLICATED

Total $65,445 across 108 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $65,445 | 108 | 2026–2026 | John Nagel [H6MN05357] holding $66,336 |

### Julia Joseph — Council Member / AUS / elected — DUPLICATED

Total $65,242 across 91 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $45,628 | 58 | 2026–2026 | Rodenay Joseph [H6FL20069] holding $72,172 |
| CROSS | $16,215 | 29 | 2024–2024 | Rod Joseph [S4FL00512] holding $16,215 |
| CROSS | $3,399 | 4 | 2024–2024 | Nalini Joseph [H2NC12278] holding $3,399 |

$0 same-surname destinations to review: Vladimy Joseph [H2NY00069] Candidate for Representative; Vladimy Joseph [H2NY12171] Candidate for Representative; James Joseph [H6TX18240] Candidate for Representative; Dejawon Joseph [P00008037] Candidate for President; Robert Joseph [P00014647] Candidate for President; Vladimy Joseph [S4NY00453] Candidate for Senator

### Rob Lloyd — Council Member / SEA / elected — DUPLICATED

Total $56,249 across 94 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $56,249 | 94 | 2024–2026 | Tanya Lloyd [H4TX27089] holding $59,249 |

$0 same-surname destinations to review: Rashad Lloyd [H0MD05266] Candidate for Representative; Johnnie Lloyd [H4FL21088] Candidate for Representative; June Lloyd [P60004991] Candidate for President

### Charice Pennie — Council Member / SEA / elected — DUPLICATED

Total $51,744 across 53 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $51,744 | 53 | 2024–2024 | Demetrick Pennie [H4TX03122] holding $51,744 |

$0 same-surname destinations to review: Demetrick Pennie [H0TX18276] Candidate for Representative; Demetrick Pennie [H0TX32053] Candidate for Representative

