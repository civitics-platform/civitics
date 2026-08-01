# FIX-934 phase 1 — CROSS-PERSON misattribution manifest (local)

Generated 2026-08-01T06:56:41.947Z — **read-only, nothing written**.

## Headline

- Branch size re-derived live: **60** suspects (59 after by-name exclusions).
- Total money under review: **$109,736,442**.

| verdict | officials | dollars |
|---|---:|---:|
| MIXED | 30 | $94,236,522 |
| DUPLICATED | 29 | $15,499,920 |

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
| 2020 | $4,936,977 | 1506 | 1506 |
| 2022 | $5,285,529 | 1429 | 1429 |
| 2024 | $5,450 | 8 | 0 |
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

28 officials hold a CROSS copy whose amount DISAGREES with the true
owner's copy of the same key, totalling $118,950 held above the owner.
These are aggregated rows, so two bindings written at different times hold different
cumulative totals. Phase 2 must apply FIX-933's fresher-wins rule to them rather than an
unconditional delete.

| official | mismatched rows | of CROSS rows | suspect excess | owner excess |
|---|---:|---:|---:|---:|
| Shontel M. Brown | 339 | 42517 | $600 | $173,701 |
| Heather Cooke | 260 | 4870 | $17,500 | $242,534 |
| Al Green | 21 | 1038 | $300 | $22,435 |
| Beverly Andrews | 134 | 2679 | $0 | $85,128 |
| Gregory Phillips | 49 | 1461 | $93,300 | $0 |
| Brandon Williamson | 1 | 1407 | $0 | $250 |
| Mark Bennett | 210 | 1166 | $0 | $202,710 |
| Sage Lawrence | 50 | 375 | $0 | $43,290 |
| Jane Roth | 68 | 721 | $1,000 | $47,808 |
| Yvette Mendoza | 183 | 1185 | $0 | $252,397 |
| Rachel Morris | 30 | 474 | $0 | $48,123 |
| Darryl Brooks | 32 | 336 | $0 | $48,150 |
| Tammy J. Morales | 1 | 609 | $1,000 | $0 |
| Helen Daniels | 2 | 661 | $250 | $250 |
| Emily Villegas | 117 | 574 | $0 | $115,616 |
| Bill Reeves | 1 | 213 | $0 | $1,500 |
| Emilia Sanchez | 20 | 56 | $5,000 | $75,800 |
| Trinh Bartlett | 9 | 247 | $0 | $13,550 |
| Noelle Simmons | 26 | 394 | $0 | $12,350 |
| Barbara Kaufman | 16 | 219 | $0 | $8,400 |
| Alex Zamora | 13 | 187 | $0 | $10,450 |
| Richard Whipple | 19 | 120 | $0 | $19,300 |
| Luis Herrera | 2 | 209 | $0 | $2,000 |
| Myrna Rios | 9 | 125 | $0 | $2,930 |
| Mark Farrell | 13 | 89 | $0 | $11,050 |
| Becky Nagel | 1 | 108 | $0 | $291 |
| Julia Joseph | 4 | 91 | $0 | $2,250 |
| Rob Lloyd | 4 | 94 | $0 | $2,750 |

## Manifest

| official | role | juris | verdict | total | own (keep) | cross (deletable) | diverted (move) |
|---|---|---|---|---:|---:|---:|---:|
| Shontel M. Brown | Representative | OH | MIXED | $50,998,289 | $2,984,275 | $45,928,314 | $2,085,700 |
| David Porter | Federal Judge | US | MIXED | $7,391,766 | $0 | $5,718,759 | $1,673,007 |
| Heather Cooke | Council Member | AUS | MIXED | $6,001,754 | $0 | $5,996,754 | $5,000 |
| Al Green | Representative | TX | MIXED | $3,941,878 | $941,978 | $1,808,246 | $1,191,654 |
| David Coleman | Council Member | AUS | MIXED | $2,585,174 | $0 | $1,320,006 | $1,265,168 |
| Beverly Andrews | Council Member | AUS | MIXED | $2,254,585 | $0 | $2,193,639 | $60,946 |
| Gregory Phillips | Federal Judge | US | MIXED | $2,121,088 | $0 | $2,064,010 | $57,078 |
| Radhika Fox | Council Member | SF | DUPLICATED | $1,975,721 | $0 | $1,975,721 | $0 |
| Richard Greene | Council Member | SEA | MIXED | $1,961,461 | $0 | $1,635,798 | $325,663 |
| Brandon Williamson | Council Member | AUS | MIXED | $1,913,472 | $0 | $1,913,097 | $375 |
| Stuart Duncan | Federal Judge | US | MIXED | $1,912,303 | $0 | $629,506 | $1,282,797 |
| Mark Bennett | Federal Judge | US | MIXED | $1,837,966 | $0 | $1,700,444 | $137,522 |
| Sage Lawrence | Council Member | SEA | MIXED | $1,753,417 | $0 | $813,740 | $939,677 |
| Jane Roth | Federal Judge | US | MIXED | $1,734,583 | $0 | $1,723,283 | $11,300 |
| Teresa Dixon | Council Member | AUS | DUPLICATED | $1,575,179 | $0 | $1,575,179 | $0 |
| Yvette Mendoza | Council Member | AUS | DUPLICATED | $1,571,436 | $0 | $1,571,436 | $0 |
| HB Harper | Council Member | SEA | MIXED | $1,444,024 | $0 | $1,423,368 | $20,656 |
| Jesse Franz | Council Member | SEA | DUPLICATED | $1,316,422 | $0 | $1,316,422 | $0 |
| Saroja Reddy | Council Member | SEA | DUPLICATED | $1,313,782 | $0 | $1,313,782 | $0 |
| Rachel Morris | Council Member | AUS | DUPLICATED | $1,270,266 | $0 | $1,270,266 | $0 |
| Darryl Brooks | Council Member | SEA | MIXED | $993,733 | $0 | $475,550 | $518,183 |
| Conor Johnston | Council Member | SF | DUPLICATED | $926,011 | $0 | $926,011 | $0 |
| Jason Elliott | Council Member | SF | MIXED | $883,848 | $0 | $606,030 | $277,818 |
| Tammy J. Morales | Council Member | SEA | DUPLICATED | $745,008 | $0 | $745,008 | $0 |
| Paul Niemeyer | Federal Judge | US | DUPLICATED | $720,866 | $0 | $720,866 | $0 |
| Abigail Maher | Council Member | SF | MIXED | $719,298 | $0 | $704,898 | $14,400 |
| Helen Daniels | Council Member | SF | MIXED | $689,698 | $0 | $655,948 | $33,750 |
| Emily Villegas | Council Member | AUS | MIXED | $667,509 | $0 | $560,709 | $106,800 |
| Bill Reeves | Council Member | AUS | MIXED | $465,226 | $0 | $346,726 | $118,500 |
| Terrence O'Brien | Federal Judge | US | DUPLICATED | $448,587 | $0 | $448,587 | $0 |
| Robin Harvey | Council Member | AUS | DUPLICATED | $424,149 | $0 | $424,149 | $0 |
| Adam Schaefer | Council Member | SEA | DUPLICATED | $385,511 | $0 | $385,511 | $0 |
| Emilia Sanchez | Council Member | SEA | DUPLICATED | $385,000 | $0 | $385,000 | $0 |
| Trinh Bartlett | Council Member | AUS | MIXED | $377,366 | $0 | $372,866 | $4,500 |
| Noelle Simmons | Council Member | SF | MIXED | $358,389 | $0 | $345,877 | $12,512 |
| Barbara Kaufman | Council Member | SF | DUPLICATED | $346,024 | $0 | $346,024 | $0 |
| Alex Zamora | Council Member | AUS | DUPLICATED | $338,474 | $0 | $338,474 | $0 |
| Monica Guzman | Council Member | SF | DUPLICATED | $204,638 | $0 | $204,638 | $0 |
| Donna Hood | Council Member | SF | MIXED | $197,900 | $0 | $173,900 | $24,000 |
| Richard Whipple | Council Member | SF | DUPLICATED | $194,890 | $0 | $194,890 | $0 |
| Danielle  Love | Council Member | AUS | MIXED | $190,662 | $0 | $185,662 | $5,000 |
| Norman Stahl | Federal Judge | US | MIXED | $186,909 | $0 | $184,009 | $2,900 |
| Sadie Spalding | Council Member | AUS | MIXED | $183,663 | $0 | $182,413 | $1,250 |
| Maureen Singleton | Council Member | SF | DUPLICATED | $183,257 | $0 | $183,257 | $0 |
| Luis Herrera | Council Member | SF | DUPLICATED | $178,024 | $0 | $178,024 | $0 |
| Myrna Rios | Council Member | AUS | DUPLICATED | $164,989 | $0 | $164,989 | $0 |
| Lish Whitson | Council Member | SEA | DUPLICATED | $155,528 | $0 | $155,528 | $0 |
| Jocelyn Kane | Council Member | SF | DUPLICATED | $151,628 | $0 | $151,628 | $0 |
| Sandra Campbell | Council Member | AUS | MIXED | $133,880 | $0 | $77,130 | $56,750 |
| Mark Farrell | Council Member | SF | MIXED | $123,734 | $0 | $121,734 | $2,000 |
| Cynthia Goldstein | Council Member | SF | MIXED | $119,072 | $0 | $115,272 | $3,800 |
| Ruben Aleman | Council Member | AUS | DUPLICATED | $103,406 | $0 | $103,406 | $0 |
| Julius Richardson | Federal Judge | US | MIXED | $93,875 | $0 | $93,325 | $550 |
| Don Willett | Federal Judge | US | DUPLICATED | $93,250 | $0 | $93,250 | $0 |
| Ketil Freeman | Council Member | SEA | DUPLICATED | $89,194 | $0 | $89,194 | $0 |
| Becky Nagel | Council Member | AUS | DUPLICATED | $65,445 | $0 | $65,445 | $0 |
| Julia Joseph | Council Member | AUS | DUPLICATED | $65,242 | $0 | $65,242 | $0 |
| Rob Lloyd | Council Member | SEA | DUPLICATED | $56,249 | $0 | $56,249 | $0 |
| Charice Pennie | Council Member | SEA | DUPLICATED | $51,744 | $0 | $51,744 | $0 |

## Per-official detail

### Shontel M. Brown — Representative / OH / elected — MIXED

Total $50,998,289 across 43960 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $47,250,274 | 42681 | 2024–2026 | Sherrod Brown [S6OH00163] holding $47,287,141 |
| **OWN** | $2,984,275 | 881 | 2024–2026 | M Brown [H2OH11169] holding $2,261,183 |
| CROSS | $288,100 | 44 | 2024–2024 | Sam Brown [S2NV00308] holding $9,432,588 |
| CROSS | $1,500 | 2 | 2026–2026 | Brandon Brown [S6SC04270] holding $9,550 |
| CROSS | $19,500 | 2 | 2024–2024 | Leigh Brown [H0NC09203] holding $38,954 |
| CROSS | $6,000 | 2 | 2024–2024 | Sam Brown [S4NV00288] holding $553,412 |
| CROSS | $13,000 | 1 | 2024–2024 | Shaun Brown [H6VA02115] holding $3,500 |
| CROSS | $2,000 | 1 | 2026–2026 | Yumeka Brown [H6IL02330] holding $60,453 |
| DIVERTED | $343,600 | 135 | 2020 | held by nobody (135 PAC rows) |
| DIVERTED | $1,738,850 | 423 | 2022 | held by nobody (423 PAC rows) |
| DIVERTED | $3,250 | 4 | 2024 | held by nobody (0 PAC rows) |

$0 same-surname destinations to review: Thomas Brown [H0AL02160] Candidate for Representative; Jeremy Brown [H0FL14099] Candidate for Representative; Mauricus Brown [H0SC05056] Candidate for Representative; Corrine Brown [H2FL10358] Candidate for Representative; Jesse Brown [H2MA09239] Candidate for Representative; Mary Brown [H2TX13117] Candidate for Representative; Jay Brown [H4IA04121] Candidate for Representative; Jason Brown [H4IN01228] Candidate for Representative; Mason Brown [H4NY20162] Candidate for Representative; Mason Brown [H4NY20170] Candidate for Representative; David Brown [H6CA32157] Candidate for Representative; Deirdre Brown [H6DC00188] Candidate for Representative; Te Brown [H6FL14203] Candidate for Representative; Jerico Brown [H6IL07313] Candidate for Representative; Tedora Brown [H6IL11158] Candidate for Representative; Anthony Brown [H6MD04209] Candidate for Representative; Joshua Brown [H6PA05190] Candidate for Representative; David Brown [H6SC02126] Candidate for Representative; Kenneth Brown [H6TN05348] Candidate for Representative; Robert Brown [H6TX17127] Candidate for Representative; Robert Brown [H6TX17135] Candidate for Representative; Jason Brown [H6VA04095] Candidate for Representative; Kelly Brown [H6WI06134] Candidate for Representative; Alvin Brown [H8FL05140] Candidate for Representative; David Brown [H8NC10097] Candidate for Representative; Branden Brown [H8SC07089] Candidate for Representative; George Brown [P00005595] Candidate for President; Erik Brown [P00010637] Candidate for President; Doris Brown [P00011429] Candidate for President; Kyle Brown [P00014761] Candidate for President; Bendu Brown [P00017814] Candidate for President; Theodis Brown [P20005187] Candidate for President; Harvey Brown [P40003667] Candidate for President; Jessica Brown [P40004582] Candidate for President; Daniel Brown [P40013781] Candidate for President; Gary Brown [P40014938] Candidate for President; Samuel Brown [P40015448] Candidate for President; Tyrone Brown [P80006646] Candidate for President; Charley Brown [P80008352] Candidate for President; Damon Brown [P80009160] Candidate for President; Sam Brown [S2NV00156] Candidate for Senator; Pamela Brown [S4DE00102] Candidate for Senator; Pamela Brown [S4DE00110] Candidate for Senator; Sam Brown [S4NV00308] Candidate for Senator; Lola Brown [S4TN00559] Candidate for Senator; Tyrone Brown [S8FL00307] Candidate for Senator; Zachary Brown [S8NC00338] Candidate for Senator

### David Porter — Federal Judge / US / elected — MIXED

Total $7,391,766 across 6133 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $5,693,249 | 5660 | 2024–2024 | Katherine Porter [S4CA00522] holding $5,693,249 |
| CROSS | $25,510 | 31 | 2026–2026 | Ferguson Porter [H6CA41232] holding $25,510 |
| DIVERTED | $967,837 | 256 | 2020 | held by nobody (256 PAC rows) |
| DIVERTED | $705,170 | 186 | 2022 | held by nobody (186 PAC rows) |

$0 same-surname destinations to review: John Porter [H2CA33253] Candidate for Representative; Kevin Porter [H2FL11182] Candidate for Representative; Deshon Porter [H6TX18208] Candidate for Representative; Deshon Porter [H6TX18216] Candidate for Representative; Katherine Porter [H8CA45130] Candidate for Representative; Stevan Porter [H8VA11088] Candidate for Representative; Dorsey Porter [P40009631] Candidate for President; Deshon Porter [S2MO00569] Candidate for Senator

### Heather Cooke — Council Member / AUS / elected — MIXED

Total $6,001,754 across 4871 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $5,294,601 | 4667 | 2024–2026 | Rebecca Cooke [H2WI03130] holding $6,330,566 |
| CROSS | $756,153 | 212 | 2024–2026 | Rebecca Cooke [H4WI03169] holding $850,353 |
| DIVERTED | $5,000 | 1 | 2022 | held by nobody (1 PAC rows) |

$0 same-surname destinations to review: Alexander Cooke [H6FL21109] Candidate for Representative; Robert Cooke [P40006116] Candidate for President; John Cooke [S2NC00539] Candidate for Senator

### Al Green — Representative / TX / elected — MIXED

Total $3,941,878 across 2026 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,725,986 | 912 | 2024–2026 | Mark Green [H8TN07076] holding $1,714,236 |
| **OWN** | $941,978 | 596 | 2024–2026 | Alexander Green [H4TX09095] holding $1,195,809 |
| CROSS | $77,807 | 74 | 2026–2026 | Amanda Green [H6FL02299] holding $176,195 |
| CROSS | $30,161 | 32 | 2026–2026 | Jennifer-Ruth Green [H2IN01172] holding $38,296 |
| CROSS | $10,826 | 17 | 2026–2026 | Troy Green [S6OK04171] holding $14,265 |
| CROSS | $7,016 | 9 | 2026–2026 | Terri Green [H6AR01155] holding $16,183 |
| DIVERTED | $392,765 | 142 | 2020 | held by nobody (142 PAC rows) |
| DIVERTED | $798,889 | 250 | 2022 | held by nobody (250 PAC rows) |

$0 same-surname destinations to review: Jacquetta Green [H0CA08184] Candidate for Representative; Karen Green [H2FL08139] Candidate for Representative; Curtis Green [H2NJ02227] Candidate for Representative; Steven Green [H2NY09136] Candidate for Representative; Bradley Green [H4UT02338] Candidate for Representative; Dan Green [H6FL09294] Candidate for Representative; Malcolm Green [H6SC86012] Candidate for Representative; Malcolm Green [H6SC86020] Candidate for Representative; Rick Green [H8MA03114] Candidate for Representative; Wednesday Green [P00010488] Candidate for President; Justin Green [S6FL00681] Candidate for Senator; Carmen Green [S6IN00282] Candidate for Senator

### David Coleman — Council Member / AUS / elected — MIXED

Total $2,585,174 across 1002 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,103,208 | 527 | 2024–2026 | Bonnie Coleman [H4NJ12149] holding $1,112,208 |
| CROSS | $60,504 | 56 | 2024–2024 | Merika Coleman [H4AL02097] holding $60,504 |
| CROSS | $120,338 | 53 | 2024–2024 | Mary Coleman [H4MO03213] holding $120,338 |
| CROSS | $14,100 | 30 | 2026–2026 | Tayhlor Coleman [H6TX10171] holding $14,100 |
| CROSS | $10,356 | 5 | 2026–2026 | Keith Coleman [H6TX08225] holding $10,356 |
| CROSS | $1,500 | 3 | 2026–2026 | Calvin Coleman [H6IL02280] holding $1,500 |
| CROSS | $10,000 | 1 | 2026–2026 | Linda Coleman [H8NC02110] holding $10,000 |
| DIVERTED | $783,818 | 194 | 2020 | held by nobody (194 PAC rows) |
| DIVERTED | $481,350 | 133 | 2022 | held by nobody (133 PAC rows) |

$0 same-surname destinations to review: Jeff Coleman [H0AL02145] Candidate for Representative; Kim Coleman [H0UT04043] Candidate for Representative; Simone Coleman [H2MI13410] Candidate for Representative; Bernard Coleman [H4CO02128] Candidate for Representative; Octavia Coleman [H4GA13059] Candidate for Representative; Valerie Coleman [P40006082] Candidate for President; Gerry Coleman [P40012189] Candidate for President; Rodshawn Coleman [P80008618] Candidate for President

### Beverly Andrews — Council Member / AUS / elected — MIXED

Total $2,254,585 across 2705 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $2,030,563 | 2529 | 2026–2026 | Annie Andrews [S6SC04239] holding $2,511,558 |
| CROSS | $115,031 | 101 | 2024–2024 | Russ Andrews [H4CO03316] holding $115,031 |
| CROSS | $48,045 | 49 | 2024–2024 | Aliscia Andrews [H0VA10186] holding $48,045 |
| DIVERTED | $36,746 | 15 | 2020 | held by nobody (15 PAC rows) |
| DIVERTED | $24,200 | 11 | 2022 | held by nobody (11 PAC rows) |

$0 same-surname destinations to review: Robert Andrews [H0NJ01066] Candidate for Representative; Naomi Andrews [H2OK02307] Candidate for Representative; Annie Andrews [H2SC01127] Candidate for Representative; Cody Andrews [S4TX00763] Candidate for Senator; Robert Andrews [S8NJ00392] Candidate for Senator

### Gregory Phillips — Federal Judge / US / elected — MIXED

Total $2,121,088 across 1484 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,471,509 | 1066 | 2024–2024 | Dean Phillips [P40016131] holding $1,330,359 |
| CROSS | $797,499 | 373 | 2024–2024 | Dean Phillips [H8MN03143] holding $688,849 |
| CROSS | $39,792 | 64 | 2024–2024 | Stephanie Phillips [S4NV00262] holding $39,792 |
| CROSS | $5,010 | 7 | 2026–2026 | Rio Phillips [S6WV00170] holding $5,782 |
| DIVERTED | $43,578 | 17 | 2020 | held by nobody (17 PAC rows) |
| DIVERTED | $13,500 | 6 | 2022 | held by nobody (6 PAC rows) |

$0 same-surname destinations to review: Trenten Phillips [H4CA01090] Candidate for Representative; James Phillips [H4NC13181] Candidate for Representative; Mia Phillips [H6CA32165] Candidate for Representative; Xavier Phillips [H6MO01329] Candidate for Representative; Luke Phillips [H6VA08302] Candidate for Representative; John Phillips [P00011619] Candidate for President; Justin Phillips [P40012429] Candidate for President; Christopher Phillips [P80007214] Candidate for President

### Radhika Fox — Council Member / SF / elected — DUPLICATED

Total $1,975,721 across 1813 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,975,721 | 1813 | 2024–2024 | Whitney Fox [H4FL13200] holding $1,975,721 |

$0 same-surname destinations to review: Stephanie Fox [H2PA18226] Candidate for Representative; Jeremy Fox [H6CA20244] Candidate for Representative; Teresa Fox [H6WA06286] Candidate for Representative; Glynndeavin Fox [P40005894] Candidate for President; Cherunda Fox [P60005303] Candidate for President; Jimmy Fox [P60023751] Candidate for President

### Richard Greene — Council Member / SEA / elected — MIXED

Total $1,961,461 across 2028 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,635,798 | 1985 | 2024–2024 | Marjorie Greene [H0GA06192] holding $1,636,998 |
| DIVERTED | $91,716 | 23 | 2020 | held by nobody (23 PAC rows) |
| DIVERTED | $232,747 | 17 | 2022 | held by nobody (17 PAC rows) |
| DIVERTED | $1,200 | 3 | 2024 | held by nobody (0 PAC rows) |

$0 same-surname destinations to review: David Greene [H0OK05197] Candidate for Representative; Shaun Greene [H4TN07174] Candidate for Representative; Clifford Greene [H8WA08064] Candidate for Representative; Rosalind Greene [P00005868] Candidate for President

### Brandon Williamson — Council Member / AUS / elected — MIXED

Total $1,913,472 across 1408 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,799,117 | 1283 | 2024–2024 | Marianne Williamson [P00009910] holding $1,799,117 |
| CROSS | $113,980 | 124 | 2026–2026 | Michael Williamson [H6VA02156] holding $114,980 |
| DIVERTED | $375 | 1 | 2020 | held by nobody (1 PAC rows) |

$0 same-surname destinations to review: W Williamson [H2AZ06254] Candidate for Representative; Monaca Williamson [H6NC12147] Candidate for Representative

### Stuart Duncan — Federal Judge / US / elected — MIXED

Total $1,912,303 across 718 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $629,506 | 356 | 2024–2024 | Jeffrey Duncan [H0SC03077] holding $629,506 |
| DIVERTED | $643,876 | 191 | 2020 | held by nobody (191 PAC rows) |
| DIVERTED | $638,921 | 171 | 2022 | held by nobody (171 PAC rows) |

$0 same-surname destinations to review: Hunter Duncan [H0CA50194] Candidate for Representative; Darren Duncan [H0IL15186] Candidate for Representative; Daniel Duncan [H4SC03145] Candidate for Representative; Vince Duncan [H4TX18112] Candidate for Representative; John Duncan [H8TN02069] Candidate for Representative; Scott Duncan [S6KY00195] Candidate for Senator; James Duncan [S6KY00419] Candidate for Senator; Alexander Duncan [S6TX00339] Candidate for Senator; Alexander Duncan [S6TX00354] Candidate for Senator

### Mark Bennett — Federal Judge / US / elected — MIXED

Total $1,837,966 across 1205 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,605,663 | 1064 | 2026–2026 | Rebecca Bennett [H6NJ07201] holding $2,387,584 |
| CROSS | $40,800 | 47 | 2026–2026 | Christopher Bennett [H6CA06268] holding $93,119 |
| CROSS | $25,740 | 30 | 2024–2024 | Jim Bennett [H4GA03050] holding $25,740 |
| CROSS | $22,666 | 19 | 2026–2026 | Candice Bennett [H6VA11082] holding $22,666 |
| CROSS | $5,575 | 6 | 2026–2026 | Timothy Bennett [H6CO07122] holding $12,188 |
| DIVERTED | $137,522 | 39 | 2020 | held by nobody (39 PAC rows) |

$0 same-surname destinations to review: Adrienne Bennett [H0ME02075] Candidate for Representative; Lynda Bennett [H0NC11191] Candidate for Representative; John Bennett [H2OK02224] Candidate for Representative; Justin Bennett [H2SC04162] Candidate for Representative; Robert Bennett [H6NC02197] Candidate for Representative; Douglas Bennett [H8IL10115] Candidate for Representative; Shantele Bennett [S2FL00540] Candidate for Senator; Shantele Bennett [S4FL00751] Candidate for Senator; Douglas Bennett [S6IL00391] Candidate for Senator

### Sage Lawrence — Council Member / SEA / elected — MIXED

Total $1,753,417 across 655 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $279,640 | 275 | 2026–2026 | William Lawrence [H6MI07298] holding $426,366 |
| CROSS | $524,900 | 84 | 2024–2024 | Case Lawrence [H4UT03278] holding $524,900 |
| CROSS | $8,950 | 15 | 2026–2026 | Jacob Lawrence [H6NC11230] holding $8,950 |
| CROSS | $250 | 1 | 2026–2026 | Diana Lawrence [H6AR03136] holding $250 |
| DIVERTED | $670,177 | 182 | 2020 | held by nobody (182 PAC rows) |
| DIVERTED | $269,500 | 98 | 2022 | held by nobody (98 PAC rows) |

$0 same-surname destinations to review: Michael Lawrence [H0TX27079] Candidate for Representative; Brenda Lawrence [H2MI14111] Candidate for Representative; Jim Lawrence [H6NH02238] Candidate for Representative

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

$0 same-surname destinations to review: David Roth [S2ID00178] Candidate for Senator

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

$0 same-surname destinations to review: Sandra Mendoza [H2CA37338] Candidate for Representative; M.V. Mendoza [H6LA02173] Candidate for Representative; Manlio Mendoza [S2LA00184] Candidate for Senator

### HB Harper — Council Member / SEA / elected — MIXED

Total $1,444,024 across 1566 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $1,406,119 | 1539 | 2024–2024 | Frank Harper [S4MI00553] holding $1,407,119 |
| CROSS | $17,249 | 17 | 2026–2026 | Alex Harper [H6SC05178] holding $17,249 |
| DIVERTED | $12,000 | 3 | 2020 | held by nobody (3 PAC rows) |
| DIVERTED | $7,656 | 6 | 2022 | held by nobody (6 PAC rows) |
| DIVERTED | $1,000 | 1 | 2024 | held by nobody (0 PAC rows) |

$0 same-surname destinations to review: Charles Harper [H6TX32100] Candidate for Representative; Justin Harper [P00011510] Candidate for President; Morgan Harper [S2OH00469] Candidate for Senator

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

$0 same-surname destinations to review: Spence Morris [H2IL17154] Candidate for Representative; Robert Morris [H2NV03237] Candidate for Representative; Vincent Morris [H6DC00204] Candidate for Representative; Nate Morris [H6KY00302] Candidate for Representative; Rickey Morris [P00014498] Candidate for President; Lawrence Morris [P80008956] Candidate for President

### Darryl Brooks — Council Member / SEA / elected — MIXED

Total $993,733 across 512 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $475,550 | 336 | 2026–2026 | Bob Brooks [H6PA07188] holding $966,270 |
| DIVERTED | $413,787 | 148 | 2020 | held by nobody (148 PAC rows) |
| DIVERTED | $104,396 | 28 | 2022 | held by nobody (28 PAC rows) |

$0 same-surname destinations to review: Mo Brooks [H0AL05163] Candidate for Representative; Clayton Brooks [H0NC09278] Candidate for Representative; Susan Brooks [H2IN05082] Candidate for Representative; Raymond Brooks [H2MS04266] Candidate for Representative; Natisha Brooks [H2TN05347] Candidate for Representative; Janis Brooks [H8PA18272] Candidate for Representative; John Brooks [P40009854] Candidate for President; Sharon Brooks [P40012767] Candidate for President; Rochelle-Maretta Brooks [P40020067] Candidate for President; Shyyan Brooks [P60021680] Candidate for President; Christopher Brooks [S6MN00523] Candidate for Senator; Mo Brooks [S8AL00381] Candidate for Senator

### Conor Johnston — Council Member / SF / elected — DUPLICATED

Total $926,011 across 561 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $923,511 | 558 | 2024–2024 | Courtney Johnston [H4TN05137] holding $923,511 |
| CROSS | $2,500 | 3 | 2026–2026 | Mark Johnston [H6NE02166] holding $2,500 |

$0 same-surname destinations to review: Clayton Johnston [H4FL01254] Candidate for Representative; Michael Johnston [S0CO00468] Candidate for Senator

### Jason Elliott — Council Member / SF / elected — MIXED

Total $883,848 across 814 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $398,223 | 427 | 2024–2024 | Glenn Elliott [S4WV00399] holding $398,223 |
| CROSS | $207,807 | 273 | 2024–2026 | Steven Elliott [H2MI13311] holding $207,807 |
| DIVERTED | $275,818 | 113 | 2020 | held by nobody (113 PAC rows) |
| DIVERTED | $2,000 | 1 | 2022 | held by nobody (1 PAC rows) |

$0 same-surname destinations to review: Joyce Elliott [H0AR02131] Candidate for Representative; Joyce Elliott [H0AR02206] Candidate for Representative; Stephen Elliott [H6FL19210] Candidate for Representative

### Tammy J. Morales — Council Member / SEA / elected — DUPLICATED

Total $745,008 across 609 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $562,006 | 468 | 2024–2024 | Eduardo Morales [H4OR03168] holding $561,006 |
| CROSS | $32,700 | 61 | 2024–2024 | Jesus Morales [H4CA20132] holding $31,700 |
| CROSS | $123,750 | 58 | 2026–2026 | Richard Morales [H6NJ12383] holding $123,750 |
| CROSS | $16,180 | 14 | 2024–2024 | Adianis Morales [H2FL09277] holding $16,180 |
| CROSS | $12,372 | 9 | 2026–2026 | Mario Morales [H6TX34056] holding $12,372 |

$0 same-surname destinations to review: Joshua Morales [H0MD03246] Candidate for Representative; Robert Morales [H4NC02168] Candidate for Representative; Cristian Morales [H6CA43188] Candidate for Representative

### Paul Niemeyer — Federal Judge / US / elected — DUPLICATED

Total $720,866 across 446 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $720,866 | 446 | 2024–2024 | Randell Niemeyer [H4IN01210] holding $720,866 |

### Abigail Maher — Council Member / SF / elected — MIXED

Total $719,298 across 365 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $702,148 | 354 | 2024–2024 | Michael Maher [H2CA22215] holding $702,148 |
| CROSS | $2,750 | 6 | 2024–2024 | Patricia Maher [H4NY04141] holding $2,750 |
| DIVERTED | $14,400 | 5 | 2022 | held by nobody (5 PAC rows) |

### Helen Daniels — Council Member / SF / elected — MIXED

Total $689,698 across 674 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $529,643 | 441 | 2024–2026 | Anthony Daniels [H4AL02162] holding $529,393 |
| CROSS | $92,373 | 154 | 2026–2026 | Sholdon Daniels [H4TX30109] holding $92,623 |
| CROSS | $33,432 | 64 | 2024–2026 | Shamaine Daniels [H2PA10124] holding $32,932 |
| CROSS | $1,250 | 3 | 2024–2024 | Bret Daniels [H2CA07133] holding $1,250 |
| DIVERTED | $500 | 1 | 2020 | held by nobody (1 PAC rows) |
| DIVERTED | $33,250 | 12 | 2022 | held by nobody (12 PAC rows) |

$0 same-surname destinations to review: Teddy Daniels [H0PA08197] Candidate for Representative; Pamela Daniels [H2NJ04249] Candidate for Representative; Defonsio Daniels [H6GA01125] Candidate for Representative; Sholdon Daniels [H8TX04154] Candidate for Representative

### Emily Villegas — Council Member / AUS / elected — MIXED

Total $667,509 across 611 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $560,709 | 574 | 2026–2026 | Randy Villegas [H6CA22190] holding $1,108,858 |
| DIVERTED | $106,800 | 37 | 2022 | held by nobody (37 PAC rows) |

$0 same-surname destinations to review: Gilbert Villegas [H2IL03154] Candidate for Representative

### Bill Reeves — Council Member / AUS / elected — MIXED

Total $465,226 across 256 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $289,773 | 159 | 2026–2026 | Lee Reeves [H6TN07187] holding $289,773 |
| CROSS | $41,492 | 40 | 2026–2026 | Bryce Reeves [S6VA00176] holding $41,492 |
| CROSS | $15,461 | 14 | 2026–2026 | Latonya Reeves [H6MN05365] holding $23,411 |
| DIVERTED | $100,000 | 34 | 2020 | held by nobody (34 PAC rows) |
| DIVERTED | $18,500 | 9 | 2022 | held by nobody (9 PAC rows) |

$0 same-surname destinations to review: Kristine Reeves [H0WA10042] Candidate for Representative; Bryce Reeves [H2VA10216] Candidate for Representative; Jay Reeves [H4MN06152] Candidate for Representative; Darrell Reeves [H6CA30235] Candidate for Representative; Ernest Reeves [H6NC03161] Candidate for Representative; Jay Reeves [P40016669] Candidate for President

### Terrence O'Brien — Federal Judge / US / elected — DUPLICATED

Total $448,587 across 502 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $448,587 | 502 | 2024–2026 | Michael O'Brien [H4PA10088] holding $448,587 |

$0 same-surname destinations to review: Joshua Obrien [H4MD01192] Candidate for Representative; Megan O'Brien [P00005793] Candidate for President; James Obrien [P00016576] Candidate for President

### Robin Harvey — Council Member / AUS / elected — DUPLICATED

Total $424,149 across 436 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $368,749 | 385 | 2024–2024 | Kathryn Harvey [H4SC04101] holding $368,749 |
| CROSS | $55,400 | 51 | 2024–2024 | Ted Harvey [H4CO04249] holding $55,400 |

$0 same-surname destinations to review: William Harvey [H4NH02449] Candidate for Representative; Cooke Harvey [H6VA05241] Candidate for Representative; Terrance Harvey [P00006734] Candidate for President; Terrance Harvey [P20005955] Candidate for President; Terrance Harvey [P40009425] Candidate for President; Jimmy Harvey [P40012635] Candidate for President; Matthew Harvey [S4WI00272] Candidate for Senator

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
| CROSS | $380,000 | 55 | 2024–2024 | Linda Sanchez [H2CA39078] holding $2,929,364 |
| CROSS | $20,000 | 2 | 2024–2024 | Tim Sanchez [H4CA12188] holding $88,700 |

$0 same-surname destinations to review: Michael Sanchez [H0TX14242] Candidate for Representative; Louie Sanchez [H2NM01367] Candidate for Representative; Jana Sanchez [H8TX06183] Candidate for Representative; Daniel Sanchez [P80009715] Candidate for President; Louie Sanchez [S0NM00116] Candidate for Senator; William Sanchez [S2FL00623] Candidate for Senator; Loretta Sanchez [S6CA00691] Candidate for Senator

### Trinh Bartlett — Council Member / AUS / elected — MIXED

Total $377,366 across 250 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $363,466 | 243 | 2026–2026 | John Bartlett [H8NJ11167] holding $377,016 |
| CROSS | $9,400 | 4 | 2024–2026 | Lisa Bartlett [H2CA49267] holding $9,400 |
| DIVERTED | $4,500 | 3 | 2022 | held by nobody (3 PAC rows) |

### Noelle Simmons — Council Member / SF / elected — MIXED

Total $358,389 across 400 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $343,127 | 388 | 2026–2026 | Mike Simmons [H6IL09293] holding $379,317 |
| CROSS | $2,750 | 6 | 2026–2026 | Deva Simmons [H6FL18204] holding $2,750 |
| DIVERTED | $12,512 | 6 | 2020 | held by nobody (6 PAC rows) |

$0 same-surname destinations to review: Landry Simmons [H4OH11116] Candidate for Representative; Ifetayo Simmons [H4TX09145] Candidate for Representative; Richard Simmons [H6NY08154] Candidate for Representative; Kerry Simmons [P40008823] Candidate for President; Jade Simmons [S6TX00495] Candidate for Senator; Jade Simmons [S6TX00503] Candidate for Senator

### Barbara Kaufman — Council Member / SF / elected — DUPLICATED

Total $346,024 across 219 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $346,024 | 219 | 2024–2026 | Joe Kaufman [H2FL20043] holding $404,949 |

$0 same-surname destinations to review: Joseph Kaufman [H4FL23142] Candidate for Representative; Broderick Kaufman [P40021909] Candidate for President; Brody Kaufman [P80006638] Candidate for President

### Alex Zamora — Council Member / AUS / elected — DUPLICATED

Total $338,474 across 187 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $338,474 | 187 | 2026–2026 | Martin Zamora [H6NM03083] holding $391,824 |

$0 same-surname destinations to review: Eddie Zamora [H6TX15113] Candidate for Representative

### Monica Guzman — Council Member / SF / elected — DUPLICATED

Total $204,638 across 157 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $204,638 | 157 | 2024–2024 | Elizabeth Guzman [H4VA07275] holding $204,638 |

$0 same-surname destinations to review: Mario Guzman [P20005500] Candidate for President

### Donna Hood — Council Member / SF / elected — MIXED

Total $197,900 across 71 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $173,900 | 64 | 2024–2024 | Ron Hood [H4OH02271] holding $173,900 |
| DIVERTED | $24,000 | 7 | 2022 | held by nobody (7 PAC rows) |

$0 same-surname destinations to review: Michael Hood [H0OH11114] Candidate for Representative; Ronald Hood [H0OH18101] Candidate for Representative; Brandon Hood [H8IN09123] Candidate for Representative; Michael Hood [P40011546] Candidate for President

### Richard Whipple — Council Member / SF / elected — DUPLICATED

Total $194,890 across 120 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $194,890 | 120 | 2026–2026 | Cody Whipple [H6NV04111] holding $286,610 |

$0 same-surname destinations to review: Lee Whipple [H6NC11289] Candidate for Representative; Krista Whipple [P00010371] Candidate for President

### Danielle  Love — Council Member / AUS / elected — MIXED

Total $190,662 across 269 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $69,274 | 160 | 2024–2024 | John Love [H4TX06224] holding $69,274 |
| CROSS | $107,988 | 93 | 2024–2024 | Preston Love [S4NE00223] holding $107,988 |
| CROSS | $8,400 | 15 | 2024–2024 | Leslie Love [S4MI00504] holding $8,400 |
| DIVERTED | $5,000 | 1 | 2020 | held by nobody (1 PAC rows) |

$0 same-surname destinations to review: Mia Love [H2UT04023] Candidate for Representative; John Love [S0TX00308] Candidate for Senator

### Norman Stahl — Federal Judge / US / elected — MIXED

Total $186,909 across 62 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $184,009 | 61 | 2026–2026 | Brian Stahl [H6TX06229] holding $188,590 |
| DIVERTED | $2,900 | 1 | 2022 | held by nobody (1 PAC rows) |

### Sadie Spalding — Council Member / AUS / elected — MIXED

Total $183,663 across 250 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $182,413 | 248 | 2024–2024 | Carla Spalding [H0FL23090] holding $184,463 |
| DIVERTED | $1,000 | 1 | 2020 | held by nobody (1 PAC rows) |
| DIVERTED | $250 | 1 | 2022 | held by nobody (1 PAC rows) |

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

### Myrna Rios — Council Member / AUS / elected — DUPLICATED

Total $164,989 across 125 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $164,989 | 125 | 2026–2026 | Lorenzo Rios [H6CA21234] holding $212,416 |

$0 same-surname destinations to review: Angel Rios [H2CA42163] Candidate for Representative; Angel Rios [H4MS03066] Candidate for Representative; Angel Rios [H6DC01012] Candidate for Representative; Felipe Rios [H6IN07428] Candidate for Representative; Ruben Rios [H6TX16210] Candidate for Representative; Felipe Rios [P40007122] Candidate for President

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

$0 same-surname destinations to review: Jared Kane [H6FL19202] Candidate for Representative; Nickie Kane [H6NY10184] Candidate for Representative

### Sandra Campbell — Council Member / AUS / elected — MIXED

Total $133,880 across 114 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $75,130 | 90 | 2024–2024 | Stanley Campbell [S4FL00637] holding $75,130 |
| CROSS | $2,000 | 3 | 2024–2024 | Thomas Campbell [H4ND01051] holding $2,000 |
| DIVERTED | $56,750 | 21 | 2022 | held by nobody (21 PAC rows) |

$0 same-surname destinations to review: Samantha Campbell [H0CA15288] Candidate for Representative; Walter Campbell [H0FL18223] Candidate for Representative; Walter Campbell [H0FL18231] Candidate for Representative; Walter Campbell [H0FL18249] Candidate for Representative; Matthew Campbell [H0IA05092] Candidate for Representative; Rayla Campbell [H0MA07054] Candidate for Representative; David Campbell [H0OR02192] Candidate for Representative; Landon Campbell [H2FL14293] Candidate for Representative; Heidi Campbell [H2TN05438] Candidate for Representative; William Campbell [H2UT01276] Candidate for Representative; Cameron Campbell [H4TX38029] Candidate for Representative; Bill Campbell [H4UT01132] Candidate for Representative; Andrew Campbell [H4VA08372] Candidate for Representative; Shelby Campbell [H6MI13270] Candidate for Representative; Shelby Campbell [H6MI13288] Candidate for Representative; Melvin Campbell [H6PA05158] Candidate for Representative; Douglas Campbell [H8MI09084] Candidate for Representative; Christopher Campbell [P40004616] Candidate for President; Brandon Campbell [P40013526] Candidate for President; Johnnie Campbell [P40019648] Candidate for President; Johnnie Campbell [P60005147] Candidate for President; Christopher Campbell [S6KY00377] Candidate for Senator

### Mark Farrell — Council Member / SF / elected — MIXED

Total $123,734 across 91 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $97,500 | 88 | 2026–2026 | Patrick Farrell [H6GA01083] holding $142,520 |
| CROSS | $24,234 | 1 | 2026–2026 | Michael Farrell [H6UT01236] holding $50,334 |
| DIVERTED | $2,000 | 2 | 2022 | held by nobody (2 PAC rows) |

$0 same-surname destinations to review: Eugene Farrell [H0IL17109] Candidate for Representative

### Cynthia Goldstein — Council Member / SF / elected — MIXED

Total $119,072 across 94 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $81,772 | 52 | 2024–2024 | Michael Goldstein [H0CT04229] holding $81,772 |
| CROSS | $28,500 | 36 | 2026–2026 | Alexis Goldstein [H6MD06303] holding $28,500 |
| CROSS | $5,000 | 4 | 2024–2024 | Michael Goldstein [H4CT04163] holding $5,000 |
| DIVERTED | $3,800 | 2 | 2020 | held by nobody (2 PAC rows) |

$0 same-surname destinations to review: Robbie Goldstein [H0MA08045] Candidate for Representative; Matthew Goldstein [H2NY10290] Candidate for Representative; Beverly Goldstein [H6OH11160] Candidate for Representative; Shmuel Goldstein [P40006330] Candidate for President

### Ruben Aleman — Council Member / AUS / elected — DUPLICATED

Total $103,406 across 192 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $103,406 | 192 | 2026–2026 | Katherine Aleman [H6CA41315] holding $103,406 |

$0 same-surname destinations to review: Julian Aleman [P00016774] Candidate for President

### Julius Richardson — Federal Judge / US / elected — MIXED

Total $93,875 across 127 rows.

| class | dollars | rows | cycles | counterparty |
|---|---:|---:|---|---|
| CROSS | $90,075 | 117 | 2024–2024 | Jerica Richardson [H4GA06145] holding $90,075 |
| CROSS | $3,250 | 8 | 2024–2024 | Erik Richardson [H4MO06109] holding $3,250 |
| DIVERTED | $550 | 2 | 2020 | held by nobody (2 PAC rows) |

$0 same-surname destinations to review: Chris Richardson [H0CA07145] Candidate for Representative; Mark Richardson [H0OH03111] Candidate for Representative; Keith Richardson [H2IL12148] Candidate for Representative; John Richardson [H4FL16195] Candidate for Representative; John Richardson [H4FL18126] Candidate for Representative; Jonathan Richardson [H4KY06205] Candidate for Representative; Quincy Richardson [H4PA01129] Candidate for Representative; Bruce Richardson [H6TX23240] Candidate for Representative; Robert Richardson [H8CA07080] Candidate for Representative; Laura Richardson [H8CA37137] Candidate for Representative; David Richardson [H8FL27060] Candidate for Representative; Darcy Richardson [P20001376] Candidate for President; Anthony Richardson [P40014623] Candidate for President; Anthony Richardson [P80008584] Candidate for President; Max Richardson [S2PA00620] Candidate for Senator

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

$0 same-surname destinations to review: Morgann Freeman [H0NE02177] Candidate for Representative; Kymone Freeman [H4DC00100] Candidate for Representative; Sean Freeman [H6OH11202] Candidate for Representative; Jake Freeman [P00016139] Candidate for President

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

$0 same-surname destinations to review: Vladimy Joseph [H2NY12171] Candidate for Representative; James Joseph [H6TX18240] Candidate for Representative; Dejawon Joseph [P00008037] Candidate for President; Vladimy Joseph [S4NY00453] Candidate for Senator

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

