# FIX-1189: the 46 other-office `double_claim` rows, classified

**cc-222, 2026-10-11.** Read-only audit. Nothing was applied, merged, adopted or
retired. Written at `6ae6d062`. FIX-1189 and FIX-1288 are both closed (rule 70),
so this file is the record, and the class-A apply is a new filing.

**Outcome.** The 46 rows split **A 22 / B 17 / C 4 / D 3**:

- **A, prior other-office id: 22.** 20 rows are an office the member held (A1).
  2 are an other-office candidacy that predates their current service and was
  never won (A2).
- **B, concurrent other-office candidacy: 17.** Every one is a sitting
  Representative with a 2026 Senate CAND_ID.
- **C, a second id in the same chamber: 4.** All four are House.
- **D, everything else: 3.** One presidential id, and two whose year evidence is
  missing.

Most of the money sits on class B, at **$257.2M across 40,679 FR rows**, of
which $188.9M is IE spending. Class A carries $134.3M across 43,843 rows. The
manifest drafted for class A has 22 rows.

Two findings fall outside the class question, and both bear on any apply:

1. **The `--adopt-prior` gate's other-chamber test is a letter inequality.**
   It therefore accepts 13 of the 17 class-B rows and the presidential id. The
   other 4 class-B rows are refused only because their first names disagree. So
   the gate does not separate prior from concurrent.
2. **The merge's collision rule** ("keep the fresher row, never sum", FIX-933)
   would delete **$22.2M of colliding rows in class A and $41.9M in class B**.
   That rule assumes both rows are the same FEC data under two bindings. A
   heuristic split says $8.7M (A) and $14.2M (B) of those losers sit on rows that
   both bindings were still maintaining (§4(c)).

---

## §1 Method and instruments

All prod reads used `node scripts/db-query.mjs --prod`, which is read-only by
construction and runs `max_parallel_workers_per_gather = 0`. They ran from
2026-10-11T23:41Z to 23:57Z, each under a `SET LOCAL statement_timeout` guard.

| # | what | instrument | wall |
|---|---|---|---|
| P | population | `docs/receipts/2026-10-12.json` → `legislator_ids.complete.metadata`. Nightly GHA run 38174539706; `congress_legislator_ids_report` started 2026-10-11T22:43:19Z. `counts.double_claim` 46, `double_claim_split` `{other_id: 46, current_id: 0}`, `top_20_truncated` `{}`, and `top_20.double_claim` lists 46. | — |
| DS | dataset | One fetch of `legislators-current.json` at 23:45:24Z, the URL `fetchFeed()` reads (`legislator-ids-report.ts:96-98`). It was fetched raw because `parseLegislators()` keeps only the last term. HTTP 200, ETag `W/"6ab4f9aa-166a83"`, Last-Modified Thu 24 Sep 2026 10:21:30 GMT. That is the same ETag as the receipt's `dataset_ref.current`, so this is the file the nightly classified. 539 members, and 46/46 bioguides matched in the current file, so the historical file was not needed. | <1 s |
| R1 | member + stub rows | `officials` by PK, `id = ANY(92 ids)`, LEFT JOIN `governing_bodies` and `jurisdictions` | <1 s |
| R2 | stub FR, batched | FR `to_type='official' AND to_id = ANY(46)`, planned on `financial_relationships_to`. **Cancelled at the 30 s guard.** The plan estimated 27,324 rows; the actual is 85,007, heap-read cold. Replaced by R4. | 30 s |
| R3 | totals | `official_donor_totals` and `official_homepage_stats_mv` by PK for all 92; `data_sync_log` for the last 4 h (the nightly finished 22:53Z) | 0.75 s |
| R4 | stub FR | Per stub, one call each: `relationship_type, count, sum(amount_cents), min/max(cycle_year)` on the `to` side and the `from` side. Index Scan on `financial_relationships_to`, ~0.7 ms/row cold (EXPLAIN ANALYZE on Moore's stub: 1,014 rows, 575 buffer reads, 710 ms). | 0.37–6.6 s each |
| R5 | edges + the gate's attachment counts | One batched read, `= ANY(46)`. `entity_connections` to/from used Index Only Scan on `entity_connections_to_id_connection_type` / `_from_id_connection_type` (EXPLAIN ANALYZE: 80,255 rows, 1.77 s). Also `votes` (`votes_official`), `external_relationships` (`_to` / `_from`), `entity_tags` (`idx_entity_tags_entity`), `career_history`, `official_committee_memberships`, `promises`, `proposal_cosponsors`, `official_community_comments`, `civic_initiative_responses`, `lobbying_disclosures` (48 kB, no `official_id` index), `bill_details.primary_sponsor_id` and `proposal_actions.performed_by_id`. These are the gate's attachment list, `merge-same-person-official-dupes.ts:795-807`. | 0.9 s |
| R6 | survivor FR Σ | Per survivor: `count, sum` by type for `donation`/`ie_support`/`ie_oppose` from `financial_entity`. Index Only Scan on `financial_relationships_donor_rollup_idx`. Ossoff, the largest, was EXPLAINed first: 116,329 rows, 6,787 heap fetches, 4.5 s. That is under the 200k whale line, so every survivor got a live Σ. It is **not** a full FR SUM, because other relationship types to the survivor are not counted. On the stub side R4 found no other type. | 0.37–3.0 s each |
| R7 | collisions | Per pair: stub FR joined to the survivor on `(relationship_type, from_id, cycle_year)`, which is `financial_relationships_relcycle_unique`, driven from the stub with hash and merge joins off for this read (EXPLAIN ANALYZE on Moore: Nested Loop, 1,014 probes, 1.7 s). Loser = the side the merge's `keep_dup = d.updated_at >= s.updated_at` rule deletes (`merge-same-person-official-dupes.ts:2492-2505`). Re-run split by `s.updated_at >= d.created_at` (§4(c)). | 0.4–17 s each |

**Column premises (rule 151), read from the writers.**

- `source_ids`: `fec_candidate_id` (live), `prior_fec_candidate_ids` and
  `merged_fec_candidate_ids` / `merged_fec_candidate_id` (retired) — all read by
  `authoritativeClaims()` (`fec-bulk/claims.ts:100-108`) — and `congress_gov`
  (bioguide).
- **The candidate-stub insert is not in `fec-bulk/writer.ts`** as the prompt
  says. It is in two places:
  - `fec-bulk/candidates.ts:311-333` (the cn stage). Metadata keys: `state`,
    `cand_status`, `cand_ici`, `fec_election_yr`, `principal_committee`,
    `source='fec_bulk_cn'`, `cycle`.
  - `fec-bulk/mint-ie-targets.ts:205-223` (the IE stage). Metadata keys:
    `state`, `source='fec_bulk_ie'`, `fec_office`. **There is no election
    year.**
- Both writers set `is_active: true` and `tier: 'candidate'` on every stub. So
  `is_active` on a stub is the writer's default, not evidence of a live
  candidacy.
- The chamber comes from `governing_body_id` → `governing_bodies.name`. Each of
  the 46 survivors sits on the chamber its last dataset term names.

**Classification rule**, as the prompt states it. The office letter is the
contested id's first character. The member's chamber is the `type` of their last
dataset term.

- **D**: a `P` id, a stub with a bioguide, or a stub that is `elected`.
- **C**: the letter equals the current chamber.
- **A1**: an other-chamber letter, and a dataset term in that chamber with
  `end` < 2026-10-11.
- **B**: an other-chamber letter, no such term, and the stub's
  `fec_election_yr` ≥ 2026.
- **A2**: an other-chamber letter, no such term, and the stub's
  `fec_election_yr` before the start of the member's current continuous
  service.
- **D (undecided)**: an other-chamber letter, no such term, and no
  `fec_election_yr` (IE-minted stubs).

**Gate prediction.** Each row runs through `verifySharedIdInDb`'s checks in
order (`merge-same-person-official-dupes.ts:819-881`):

1. The tiers are elected/candidate, and the survivor is active.
2. The stub's live id is the pair's id.
3. If the survivor does not claim it, the adopt branch applies. That branch
   needs the survivor's live letter ≠ the id's letter, the live id ≠ the pair's
   id, and evidence present.
4. The FIX-929 first-name key: the first three letters, folded, of
   `COALESCE(NULLIF(first_name,''), split_part(full_name,' ',1))`, on both sides.
5. Zero non-money attachments.

No survivor holds `prior_fec_candidate_ids` (R1), so **no survivor claims its
contested id, and all 46 go through the adopt branch.**

---

## §2 The 46 rows

Dollar figures are FR `amount_cents` sums, with **IE = ie_support + ie_oppose**.
IE oppose is money spent *against* the candidate. "Stub FR" is R4, "stub EC" is
R5 (donation + opposition edges, all on the `to` side), "survivor FR" is R6,
"gate" is §1's prediction and "collisions" is R7.

| # | class | member | live (current) | contested id → stub | stub source · election yr | dataset terms (runs) | stub FR: donations · IE · rows · cycles | stub EC | survivor FR (rows) | gate (`--adopt-prior`) | collisions · loser $ (stale / live-both) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **A (A1)** | Andy Kim (NJ) `526e530f` | S4NJ00466 | H8NJ03206 → "Andy Kim" `44c85a80` | cn 2024 · 2024 · C | rep NJ-3 2019-01-03..2024-12-08 (3 terms); sen NJ 2024-12-09..2031-01-03 (2 terms) | $11,077,039 · $3,264,281 · 6,514 · 2020–2026 | 5,299 | $12,460,731 (6,551) | accept | 566 · $2,225,694 ($2,049,269 / $176,425) |
| 2 | **A (A1)** | Bill Cassidy (LA) `fa237ff5` | S4LA00107 | H8LA00017 → "William Cassidy" `03d38fae` | IE-minted · — | rep LA-6 2009-01-06..2015-01-03 (3 terms); sen LA 2015-01-06..2027-01-03 (2 terms) | $59,800 · $106,940 · 19 · 2020–2026 | 16 | $20,263,162 (6,345) | refuse — first names disagree (BIL vs WIL) | 3 · $113,440 ($0 / $113,440) |
| 3 | **A (A1)** | Chris Van Hollen (MD) `82cb033e` | S6MD03441 | H2MD08126 → "Chris Van Hollen" `a3b33a19` | cn 2020 · 2016 · N | rep MD-8 2003-01-07..2017-01-03 (7 terms); sen MD 2017-01-03..2029-01-03 (2 terms) | $17,209 · $0 · 8 · 2020–2022 | 8 | $8,060,521 (4,967) | accept | 7 · $15,000 ($13,000 / $2,000) |
| 4 | **A (A1)** | Edward J. Markey (MA) `bb23212c` | S4MA00028 | H6MA07101 → "Edward Markey" `3a0a8ed8` | IE-minted · — | rep MA-7/MA-5 1975-01-14..2013-07-15 (20 terms); sen MA 2013-07-16..2027-01-03 (3 terms) | $31,500 · $6,549 · 12 · 2020–2026 | 10 | $18,591,840 (7,253) | accept | 1 · $4,000 ($0 / $4,000) |
| 5 | **A (A1)** | Elissa Slotkin (MI) `dfd9dd3c` | S4MI00470 | H8MI08102 → "Elissa Slotkin" `6eb02baf` | cn 2024 · 2024 · C | rep MI-8/MI-7 2019-01-03..2025-01-03 (3 terms); sen MI 2025-01-03..2031-01-03 | $13,884,478 · $9,056,117 · 9,807 · 2020–2024 | 7,818 | $108,795,279 (23,467) | accept | 718 · $2,997,793 ($1,833,748 / $1,164,045) |
| 6 | **A (A1)** | Jacky Rosen (NV) `a333edfb` | S8NV00156 | H6NV03139 → "Jacky Rosen" `1bc2d810` | cn 2024 · 2018 · P | rep NV-3 2017-01-03..2019-01-03; sen NV 2019-01-03..2031-01-03 (2 terms) | $73,000 · $2,191,939 · 34 · 2020–2026 | 31 | $64,009,438 (16,841) | accept | 34 · $2,265,439 ($21,000 / $2,244,439) |
| 7 | **A (A1)** | James Lankford (OK) `c489979d` | S4OK00232 | H0OK05114 → "James Lankford" `d928d018` | cn 2024 · 2014 · P | rep OK-5 2011-01-05..2015-01-03 (2 terms); sen OK 2015-01-06..2029-01-03 (3 terms) | $62,000 · $0 · 24 · 2020–2024 | 22 | $8,111,864 (3,896) | accept | 24 · $62,000 ($47,500 / $14,500) |
| 8 | **A (A1)** | Jim Banks (IN) `ef1811ae` | S4IN00196 | H6IN03229 → "James Banks" `30489b7e` | cn 2024 · 2024 · N | rep IN-3 2017-01-03..2025-01-03 (4 terms); sen IN 2025-01-03..2031-01-03 | $3,193,112 · $95,269 · 1,658 · 2020–2026 | 1,389 | $11,420,067 (3,312) | refuse — first names disagree (JIM vs JAM) | 509 · $1,875,897 ($1,812,056 / $63,841) |
| 9 | **A (A2)** | John James (MI-10) `3c1674a2` | H2MI10150 | S8MI00372 → "John James" `9c34c1b6` | cn 2024 · 2020 · P | rep MI-10 2023-01-03..2027-01-03 (2 terms) | $23,760,564 · $51,041,074 · 19,762 · 2020–2024 | 19,744 | $17,006,809 (4,007) | accept | 187 · $1,495,692 ($1,463,192 / $32,500) |
| 10 | **A (A1)** | Kevin Cramer (ND) `7aa932bb` | S8ND00120 | H0ND01026 → "Kevin Cramer" `db447fea` | cn 2024 · 2018 · P | rep ND-0 2013-01-03..2019-01-03 (3 terms); sen ND 2019-01-03..2031-01-03 (2 terms) | $112,000 · $0 · 31 · 2020–2026 | 25 | $5,096,094 (2,428) | accept | 31 · $112,000 ($36,500 / $75,500) |
| 11 | **A (A1)** | Lisa Blunt Rochester (DE) `7a9f177b` | S4DE00060 | H6DE00206 → "Lisa Blunt Rochester" `0b877e0e` | cn 2024 · 2024 · C | rep DE-0 2017-01-03..2025-01-03 (4 terms); sen DE 2025-01-03..2031-01-03 | $5,572,406 · $7,692 · 2,778 · 2020–2026 | 1,995 | $9,500,535 (4,573) | accept | 1,127 · $3,655,029 ($2,568,424 / $1,086,605) |
| 12 | **A (A1)** | Maria Cantwell (WA) `4ca98eee` | S8WA00194 | H2WA01054 → "Maria Cantwell" `e3202c43` | IE-minted · — | rep WA-1 1993-01-05..1995-01-03; sen WA 2001-01-03..2031-01-03 (5 terms) | $0 · $933 · 1 · 2020–2020 | 1 | $9,496,491 (6,565) | accept | 0 · $0 ($0 / $0) |
| 13 | **A (A1)** | Marsha Blackburn (TN) `4a8644ab` | S8TN00337 | H2TN06030 → "Marsha Blackburn" `ace66c2a` | cn 2024 · 2018 · P | rep TN-7 2003-01-07..2019-01-03 (8 terms); sen TN 2019-01-03..2031-01-03 (2 terms) | $97,000 · $0 · 30 · 2020–2024 | 26 | $9,174,372 (4,096) | accept | 30 · $99,500 ($42,000 / $57,500) |
| 14 | **A (A1)** | Martin Heinrich (NM) `f2e35edd` | S2NM00088 | H8NM01224 → "Martin Heinrich" `44ca3016` | cn 2024 · 2012 · P | rep NM-1 2009-01-06..2013-01-03 (2 terms); sen NM 2013-01-03..2031-01-03 (3 terms) | $67,313 · $0 · 20 · 2020–2026 | 18 | $11,986,274 (6,395) | accept | 20 · $68,313 ($26,500 / $41,813) |
| 15 | **A (A1)** | Peter Welch (VT) `6148b393` | S2VT00235 | H6VT00160 → "Peter Welch" `0a59ec0e` | cn 2024 · 2022 · P | rep VT-0 2007-01-04..2023-01-03 (8 terms); sen VT 2023-01-03..2029-01-03 | $1,043,049 · $0 · 529 · 2020–2026 | 442 | $3,746,444 (1,829) | accept | 310 · $870,522 ($749,522 / $121,000) |
| 16 | **A (A1)** | Ruben Gallego (AZ) `90353c1a` | S4AZ00139 | H4AZ07043 → "Ruben Gallego" `76475811` | cn 2024 · 2024 · C | rep AZ-7/AZ-3 2015-01-06..2025-01-03 (5 terms); sen AZ 2025-01-03..2031-01-03 | $3,422,931 · $3,169,103 · 1,556 · 2020–2026 | 1,283 | $78,041,199 (23,135) | accept | 492 · $5,020,042 ($1,645,756 / $3,374,286) |
| 17 | **A (A1)** | Steve Daines (MT) `f9b9bf43` | S2MT00096 | H2MT01060 → "Steven Daines" `153bc6c4` | cn 2024 · 2014 · P | rep MT-0 2013-01-03..2015-01-03; sen MT 2015-01-06..2027-01-03 (2 terms) | $89,312 · $119,343 · 24 · 2020–2024 | 21 | $76,878,977 (11,497) | accept | 23 · $83,812 ($58,812 / $25,000) |
| 18 | **A (A1)** | Tammy Baldwin (WI) `7fe9c3a6` | S2WI00219 | H8WI00018 → "Tammy Baldwin" `4bfa6d18` | cn 2024 · 2012 · P | rep WI-2 1999-01-06..2013-01-03 (7 terms); sen WI 2013-01-03..2031-01-03 (3 terms) | $84,500 · $61,365 · 31 · 2020–2026 | 25 | $87,465,216 (24,495) | accept | 5 · $15,000 ($0 / $15,000) |
| 19 | **A (A1)** | Ted Budd (NC) `1fce3e17` | S2NC00505 | H6NC13129 → "Theodore Budd" `fccec21a` | cn 2024 · 2022 · P | rep NC-13 2017-01-03..2023-01-03 (3 terms); sen NC 2023-01-03..2029-01-03 | $1,973,121 · $347,865 · 955 · 2020–2026 | 921 | $49,844,728 (6,375) | refuse — first names disagree (TED vs THE) | 275 · $1,045,192 ($1,003,692 / $41,500) |
| 20 | **A (A1)** | Todd Young (IN) `1f7f59ae` | S6IN00191 | H0IN09070 → "Todd Young" `99257045` | cn 2024 · 2016 · P | rep IN-9 2011-01-05..2017-01-03 (3 terms); sen IN 2017-01-03..2029-01-03 (2 terms) | $114,353 · $0 · 38 · 2020–2026 | 31 | $13,585,396 (5,492) | accept | 38 · $122,853 ($59,353 / $63,500) |
| 21 | **A (A1)** | Tom Cotton (AR) `033ba554` | S4AR00103 | H2AR04083 → "Thomas Cotton" `17443fa7` | cn 2024 · 2014 · P | rep AR-4 2013-01-03..2015-01-03; sen AR 2015-01-06..2027-01-03 (2 terms) | $29,500 · $7,698 · 8 · 2020–2024 | 7 | $11,243,699 (7,009) | refuse — first names disagree (TOM vs THO) | 7 · $29,500 ($29,500 / $0) |
| 22 | **A (A2)** | Wesley Bell (MO-1) `b9f695d4` | H4MO01134 | S4MO00250 → "Wesley Bell" `23ef6620` | cn 2024 · 2024 · C | rep MO-1 2025-01-03..2027-01-03 | $14,750 · $0 · 4 · 2024–2026 | 3 | $15,441,820 (6,208) | accept | 3 · $4,750 ($0 / $4,750) |
| 23 | **B** | Andy Barr (KY-6) `1f984c1a` | H0KY06104 | S6KY00286 → "Garland Barr" `339c8d60` | cn 2026 · 2026 · C | rep KY-6 2013-01-03..2027-01-03 (7 terms) | $6,207,248 · $15,469,205 · 3,407 · 2026–2026 | 3,405 | $24,110,378 (7,818) | refuse — first names disagree (AND vs GAR) | 1,728 · $3,483,330 ($3,369,830 / $113,500) |
| 24 | **B** | Angie Craig (MN-2) `fb83472a` | H6MN02131 | S6MN00499 → "Angie Craig" `378629ab` | cn 2026 · 2026 · C | rep MN-2 2019-01-03..2027-01-03 (4 terms) | $8,919,402 · $13,931,102 · 5,727 · 2026–2026 | 5,726 | $30,444,145 (13,408) | accept | 3,715 · $6,099,437 ($5,458,979 / $640,458) |
| 25 | **B** | Barry Moore (AL-1) `8a916c94` | H8AL02171 | S6AL00476 → "Felix Moore" `d7442ef3` | cn 2026 · 2026 · C | rep AL-2/AL-1 2021-01-03..2027-01-03 (3 terms) | $2,944,496 · $18,714,083 · 1,014 · 2022–2026 | 1,012 | $6,179,818 (1,671) | refuse — first names disagree (BAR vs FEL) | 394 · $1,269,868 ($1,196,868 / $73,000) |
| 26 | **B** | Chris Pappas (NH-1) `7f62648d` | H8NH01210 | S6NH00141 → "Chris Pappas" `2450fd78` | cn 2026 · 2026 · C | rep NH-1 2019-01-03..2027-01-03 (4 terms) | $9,749,244 · $25,022,936 · 8,011 · 2026–2026 | 8,008 | $19,281,952 (8,412) | accept | 2,896 · $4,449,882 ($7,500 / $4,442,382) |
| 27 | **B** | Earl L. "Buddy" Carter (GA-1) `5cc3a04d` | H4GA01039 | S6GA00374 → "Earl Carter" `52b04f5f` | cn 2026 · 2026 · C | rep GA-1 2015-01-06..2027-01-03 (6 terms) | $2,469,122 · $488,718 · 1,363 · 2026–2026 | 1,363 | $8,840,821 (4,267) | accept | 982 · $1,921,326 ($1,878,826 / $42,500) |
| 28 | **B** | Haley M. Stevens (MI-11) `9e8dbddd` | H8MI11254 | S6MI00426 → "Haley Stevens" `2f4dd5a4` | cn 2026 · 2026 · C | rep MI-11 2019-01-03..2027-01-03 (4 terms) | $9,038,239 · $35,007,712 · 5,314 · 2026–2026 | 5,312 | $27,658,505 (9,926) | accept | 2,663 · $4,747,910 ($4,323,416 / $424,494) |
| 29 | **B** | Harriet M. Hageman (WY-0) `ee4b5b14` | H2WY00166 | S6WY00209 → "Harriet Hageman" `0e5c0b25` | cn 2026 · 2026 · C | rep WY-0 2023-01-03..2027-01-03 (2 terms) | $1,107,288 · $1,072,086 · 722 · 2026–2026 | 721 | $6,565,377 (3,422) | accept | 171 · $319,409 ($298,909 / $20,500) |
| 30 | **B** | Jasmine Crockett (TX-30) `78d12b0d` | H2TX30178 | S6TX00552 → "Jasmine Crockett" `087d0095` | cn 2026 · 2026 · C | rep TX-30 2023-01-03..2027-01-03 (2 terms) | $1,335,161 · $5,224,625 · 2,032 · 2026–2026 | 2,032 | $9,697,540 (5,462) | accept | 1,617 · $1,204,928 ($2,580 / $1,202,348) |
| 31 | **B** | Julia Letlow (LA-5) `45b3e2b2` | H2LA05126 | S6LA00664 → "Julia Letlow" `6d68c031` | cn 2026 · 2026 · C | rep LA-5 2021-04-14..2027-01-03 (3 terms) | $2,106,940 · $23,826,621 · 807 · 2026–2026 | 801 | $6,851,111 (3,099) | accept | 342 · $906,432 ($80,500 / $825,932) |
| 32 | **B** | Kevin Hern (OK-1) `85b6c252` | H8OK01157 | S6OK04247 → "Kevin Hern" `685df28a` | cn 2026 · 2026 · C | rep OK-1 2018-11-13..2027-01-03 (5 terms) | $2,147,415 · $2,622,593 · 700 · 2026–2026 | 693 | $6,787,001 (2,710) | accept | 149 · $554,678 ($116,215 / $438,463) |
| 33 | **B** | Mike Collins (GA-10) `ee27066e` | H4GA10071 | S6GA00390 → "Michael Collins" `1a912fd3` | cn 2026 · 2026 · C | rep GA-10 2023-01-03..2027-01-03 (2 terms) | $2,835,033 · $15,666,836 · 2,057 · 2026–2026 | 2,053 | $4,481,132 (1,921) | refuse — first names disagree (MIK vs MIC) | 757 · $1,494,973 ($1,467,973 / $27,000) |
| 34 | **B** | Raja Krishnamoorthi (IL-8) `b1db79b2` | H6IL08147 | S6IL00482 → "S Krishnamoorthi" `77e50adb` | cn 2026 · 2026 · C | rep IL-8 2017-01-03..2027-01-03 (5 terms) | $10,776,746 · $4,004,665 · 4,643 · 2026–2026 | 4,642 | $33,744,706 (16,316) | refuse — first names disagree (RAJ vs S) | 4,237 · $9,975,254 ($8,583,995 / $1,391,259) |
| 35 | **B** | Ralph Norman (SC-5) `c2aba245` | H8SC05158 | S6SC04445 → "Ralph Norman" `6c439160` | cn 2026 · 2026 · N | rep SC-5 2017-06-26..2027-01-03 (5 terms) | $532,956 · $6,369,207 · 271 · 2026–2026 | 271 | $1,988,324 (1,328) | accept | 4 · $7,700 ($7,700 / $0) |
| 36 | **B** | Robin L. Kelly (IL-2) `6a8536b9` | H2IL02172 | S6IL00474 → "Robin Kelly" `2d8ed423` | cn 2026 · 2026 · C | rep IL-2 2013-04-09..2027-01-03 (7 terms) | $1,007,528 · $1,774,009 · 802 · 2026–2026 | 802 | $6,387,303 (3,386) | accept | 695 · $825,196 ($716,053 / $109,143) |
| 37 | **B** | Russell Fry (SC-7) `3bb36c37` | H2SC07280 | S6SC04403 → "Russell Fry" `54e64909` | cn 2026 · 2026 · N | rep SC-7 2023-01-03..2027-01-03 (2 terms) | $538,560 · $1,240,450 · 177 · 2026–2026 | 176 | $4,595,208 (2,102) | accept | 52 · $168,829 ($150,561 / $18,268) |
| 38 | **B** | Seth Moulton (MA-6) `0e8eb264` | H4MA06090 | S6MA00296 → "Seth Moulton" `5da96cec` | cn 2026 · 2026 · C | rep MA-6 2015-01-06..2027-01-03 (6 terms) | $5,841,251 · $4,488,304 · 2,841 · 2026–2026 | 2,841 | $8,781,037 (3,798) | accept | 1,789 · $3,973,481 ($0 / $3,973,481) |
| 39 | **B** | Wesley Hunt (TX-38) `4b857eea` | H0TX07170 | S6TX00511 → "Wesley Hunt" `8c79899e` | cn 2026 · 2026 · C | rep TX-38 2023-01-03..2027-01-03 (2 terms) | $777,371 · $13,974,469 · 791 · 2026–2026 | 791 | $13,758,294 (6,820) | accept | 276 · $453,199 ($0 / $453,199) |
| 40 | **C** | Glenn Ivey (MD-4) `fed7caaa` | H2MD04232 | H2MD04315 → "Glenn Ivey" `62165949` | IE-minted · — | rep MD-4 2023-01-03..2027-01-03 (2 terms) | $317,500 · $5,341 · 103 · 2024–2026 | 103 | $3,511,741 (501) | refuse — survivor does not claim H2MD04315 (same letter) | 100 · $302,841 ($261,341 / $41,500) |
| 41 | **C** | John J. McGuire (VA-5) `84b91068` | H0VA07133 | H2VA07196 → "John Mcguire" `3d66bd76` | cn 2022 · 2022 · C | rep VA-5 2025-01-03..2027-01-03 | $266,900 · $0 · 87 · 2022–2026 | 87 | $5,891,432 (1,213) | refuse — survivor does not claim H2VA07196 (same letter) | 1 · $2,000 ($2,000 / $0) |
| 42 | **C** | Laura Gillen (NY-4) `bd53f3dd` | H2NY04244 | H4NY04158 → "Laura Gillen" `5815cd64` | IE-minted · — | rep NY-4 2025-01-03..2027-01-03 | $440,886 · $7,374,399 · 169 · 2024–2026 | 166 | $13,538,454 (2,745) | refuse — survivor does not claim H4NY04158 (same letter) | 168 · $7,810,785 ($7,680,399 / $130,386) |
| 43 | **C** | Robert F. Onder (MO-3) `f7ca909b` | H4MO03221 | H8MO09146 → "Robert Onder Jr" `36b1de16` | cn 2024 · 2008 · P | rep MO-3 2025-01-03..2027-01-03 | $275,260 · $0 · 109 · 2024–2026 | 99 | $7,375,729 (747) | refuse — survivor does not claim H8MO09146 (same letter) | 96 · $243,055 ($216,800 / $26,255) |
| 44 | **D** | Daniel Webster (FL-11) `8f4e4de5` | H0FL08208 | S4FL00256 → "Daniel Webster" `9f07bc0d` | IE-minted · — | rep FL-8/FL-10/FL-11 2011-01-05..2027-01-03 (8 terms) | $4,500 · $1,765 · 4 · 2020–2026 | 4 | $2,522,970 (1,457) | accept | 0 · $0 ($0 / $0) |
| 45 | **D** | Jon Ossoff (GA) `1376dc1e` | S8GA00180 | H8GA06195 → "T Ossoff" `b4159588` | IE-minted · — | sen GA 2021-01-20..2027-01-03 | $0 · $91,883 · 1 · 2020–2020 | 1 | $272,223,234 (116,329) | refuse — first names disagree (JON vs T) | 1 · $91,883 ($0 / $91,883) |
| 46 | **D** | Mark R. Warner (VA) `9539fa43` | S6VA00093 | P80003023 → "Mark Warner" `9616422c` | IE-minted · — | sen VA 2009-01-06..2027-01-03 (3 terms) | $30,500 · $2,417 · 12 · 2020–2026 | 11 | $22,162,062 (13,410) | accept | 4 · $7,884 ($0 / $7,884) |

R4 found no `from`-side FR on any stub.

R5 found **0** votes, career_history, committee memberships, promises,
cosponsors, community comments, civic responses, lobbying disclosures,
sponsored bills, proposal actions and external_relationships on all 46 stubs.
It found 128 industry and 23 pattern `entity_tags` on 44 stubs; Ossoff's and
Cantwell's stubs, which carry no donations, have none.

R3 found `official_donor_totals` rows for 44 stubs (none for Ossoff's or
Cantwell's) and agreed with the FR donation sums to within a few thousand
dollars. For example, Moore's survivor reads `official_donor_totals` $3,912,410
against FR donations $3,914,910.

## §3 Per class

| class | rows | stub FR rows | stub Σ (all FR) | of which donations | of which IE (support + oppose) | stub EC edges | gate accept / refuse | collisions | loser $ | stale / live-both loser $ |
|---|---|---|---|---|---|---|---|---|---|---|
| **A** (A1 20 · A2 2) | 22 | 43,843 | $134,255,104 | $64,778,937 | $69,476,167 | 39,135 | 18 / 4 | 4,410 | $22,181,468 | $13,459,824 (3,418) / $8,721,644 (992) |
| **B** | 17 | 40,679 | $257,231,620 | $68,334,000 | $188,897,620 | 40,649 | 13 / 4 | 22,467 | $41,855,832 | $27,659,905 (14,518) / $14,195,927 (7,949) |
| **C** | 4 | 468 | $8,680,285 | $1,300,546 | $7,379,739 | 455 | 0 / 4 | 365 | $8,358,680 | $8,160,539 (288) / $198,141 (77) |
| **D** | 3 | 17 | $131,065 | $35,000 | $96,065 | 16 | 2 / 1 | 5 | $99,767 | $0 (0) / $99,767 (5) |
| **all** | 46 | 85,007 | $400,298,075 | $134,448,483 | $265,849,592 | 80,255 | 33 / 13 | 27,247 | $72,495,747 | |

The three biggest stubs by total FR are **John James (A2), $74,801,638**
(19,762 rows; his 2018/2020 Senate runs, $23.76M donations + $51.04M IE),
**Haley Stevens (B), $44,045,951**, and **Chris Pappas (B), $34,772,180**.

**A: 22 rows (A1 20, A2 2). Gate: 18 accept, 4 refuse.**

- A1 is every row where the dataset lists a past term in the contested id's
  chamber. All 20 are House ids on sitting Senators. Three of the stubs are
  IE-minted and carry no election year (Cassidy, Markey, Cantwell), but the
  terms decide them.
- A2 is John James (`S8MI00372`, `fec_election_yr` 2020, before his House
  service from 2023-01-03) and Wesley Bell (`S4MO00250`, 2024, before 2025-01-03).
- The four refusals are all the first-name key, where the cn writer stored the
  FEC legal first name:

  | member | survivor key | stub key (legal first name) |
  |---|---|---|
  | Cassidy | BIL | WIL (William) |
  | Banks | JIM | JAM (James) |
  | Budd | TED | THE (Theodore) |
  | Cotton | TOM | THO (Thomas) |

- Cramer (`H6ND00074`) and Welch (`H8VT00034`) also have a second listed House
  id that nobody claims. After an adopt, O1 reads them `prior_incomplete` and its
  existing `prior_append` write closes that, so no manifest is needed for it.

**B: 17 rows. Gate: 13 accept, 4 refuse.** The gate would accept these
mechanically: the survivor's live id is H and the stub's is S. The four
refusals are first names only:

| member | survivor key | stub key |
|---|---|---|
| Barr | AND | GAR (Garland) |
| Moore | BAR | FEL (Felix) |
| Collins | MIK | MIC (Michael) |
| Krishnamoorthi | RAJ | S |

No refusal says anything about whether the candidacy is live. Two of the 17
have FEC `cand_status` **N** (not yet a candidate): Norman `S6SC04445`, which
also has no principal committee, and Fry `S6SC04403`. All 17 stubs' money is
cycle 2026 only, except Moore's, which runs 2022–2026.

**After an adopt, `authoritativeClaims` would read the B row as follows.**
`fec_candidate_id` stays the House id, which is the seat held. That is rule
157: live and prior split by chamber, and the live slot names the seat, because
the fec.gov link and the treemap chamber read it. The 2026 Senate id goes into
`prior_fec_candidate_ids`. `authoritativeClaims` returns `[H…, S6…]`, and O1
then classifies the row `noop`: the live id is the current-office id, and every
listed id is claimed.

**C: 4 rows. Gate: 0 accept, 4 refuse** ("survivor does not claim …"; the
letters match).

- Three have no determinable current id: the receipt's `current_id` is empty,
  and `currentFecId` returns ambiguous.
  - Ivey `H2MD04232`/`H2MD04315` are both MD-04.
  - Gillen `H2NY04244`/`H4NY04158` are both NY-04.
  - McGuire `H0VA07133`/`H2VA07196` are both VA-07, and he sits for VA-5.
- Onder's current id is determinable: `H4MO03221` agrees with MO-3, and
  `H8MO09146` is the 2008 MO-9 race. His row's money starts in 2024, though, so
  the stub is not dormant.

**D: 3 rows. Gate: 2 accept, 1 refuse.**

- **Warner `P80003023`**: a presidential id, IE-minted, $32,917. The gate's
  letter test reads P ≠ S as "other chamber" and would **accept** it.
- **Webster `S4FL00256`**: an IE-minted Senate stub with no
  `fec_election_yr` and no Senate term, $6,265. The terms cannot decide whether
  it is a dead prior registration (A2) or a live one (B). The FEC cn record for
  the id would decide it (`CAND_ELECTION_YR`, `CAND_STATUS`), and this audit did
  not read that. The gate would **accept** it.
- **Ossoff `H8GA06195`**: the 2017 GA-06 special. It is IE-minted, he never held
  a House term, there is no election year, and the stub holds $91,883 of 2020 IE
  support. The id's registration digit ('8') is the only year evidence. The gate
  **refuses** it (JON vs T).

## §4 What the Luján precedent covers, and what it does not

cc-199 applied shape C to one pair. Survivor `93a6040f` (Senator, live
`S0NM00058`) took stub `6dc78f88` (`H8NM03196`, prior House id, 171 FR,
$622,052). The run moved 149 FR rows to the Senator, deleted 24 colliding
losers ($79,802), retired the stub's id and deleted 144 money EC edges. Its
"Σ conserved" means the Σ is conserved **net of the deleted losers**
(`merge-same-person-official-dupes.ts:2431-2433`).

**It covers.** An A1 row: a sitting member, an other-chamber id from an office
the member held, an empty-shell stub, and agreeing first-name keys. **18 of the
22 class-A rows match that shape as read tonight.**

**It does not cover:**

- **(a) First-name keys on FEC legal names.** These refuse 4 A rows (Cassidy,
  Banks, Budd, Cotton), 4 B rows and Ossoff. The evidence column does not
  override the key. For these rows the dataset's bioguide → `id.fec[]` link is
  stronger evidence than a three-letter name match. Accepting it would be a gate
  change (FIX-929's ground), not a manifest edit.
- **(b) A2: a prior candidacy never won.** John James carries the largest stub
  in class A. FIX-1187 defines `prior_fec_candidate_ids` as "the CAND_IDs this
  official held under a PREVIOUS office". A CAND_ID is held as a candidacy, so
  A2 fits the field, but Luján's was a prior office actually held. Flagged in
  §5 Q2.
- **(c) The collision rule's premise.** The FIX-933 rule deletes the staler of
  two rows on `(type, from_id, cycle)` because "the two rows are the same FEC
  data written under two bindings" (`merge-same-person-official-dupes.ts:38-45`).
  These pairs are two **different** CAND_IDs, so two committees.
  - When both ids resolve to one official, the writer **sums** them
    (`fec-bulk/writer.ts:992-1011`: "a House fec_candidate_id + a later Senate
    fec_id … sum amounts"). So the correct post-merge value of a live collision
    is the sum, not the fresher row.
  - The heuristic split: a collision is **stale** when the survivor's row was
    last updated before the stub's row was first written. That is consistent
    with residue of an earlier binding of the same id, where the FIX-933 premise
    holds. It is **live-both** when the survivor's row was refreshed after that,
    meaning both bindings were being maintained, and the loser is plausibly real
    money from the other committee.
  - A sample from Moore, 2026: a $62,000 PAC row is identical on both sides and
    was last touched on the survivor 05-01, before the stub existed (05-11), so it
    is stale. A pair of $5,000 (survivor, refreshed 09-01) against $15,000 (stub,
    3 tx) is live-both, and the rule would delete the stub's $15,000.

  | class | collisions | loser $ | stale | live-both |
  |---|---|---|---|---|
  | A | 4,410 | $22.18M | $13.46M | $8.72M |
  | B | 22,467 | $41.86M | $27.66M | $14.20M |

  - The split is a heuristic. Pappas, Moulton and Crockett are almost entirely
    live-both, and Pappas's Senate stub names his House committee `C00660464` as
    its principal committee, so one committee is linked to both ids.
  - A next FEC pass would rewrite a deleted live-both loser to the sum only if it
    re-emits that cycle. Cron narrows the indiv stage to the active cycle
    (`fec-bulk/index.ts:1602-1604`). For class B (2026) the weekly pass heals it;
    for class A's 2020–2024 indiv collisions it does not, though an
    `FEC_CYCLES` backfill would.
  - IE collisions are a separate case. Several are equal to the cent on both
    sides: Rosen's 8 IE rows ($2,191,939), Gillen's 19, and Gallego's
    ie_oppose row. Gallego's 7 ie_support rows are within 2%. Those are genuine duplicates, and today they count twice in platform
    aggregates.
- **(d) The letter test.** It is not a chamber test. It accepts `P` (Warner) and
  any concurrent other-chamber candidacy (class B). Rule 157 has no slot for a
  presidential id, and a live candidacy is not "prior".
- **(e) Same-chamber ids (class C).** These are refused by construction, and
  three of the four have no determinable live id at all.
- **(f) What a merge leaves on the stub.** `entity_tags` (industry/pattern, on
  44 stubs) are not in the gate's attachment list and stay on the retired stub.
  This was not checked: whether the tagger re-derives them on the survivor from
  the moved donations.

## §5 Questions for Craig

**Q1 (class B, the product rule; the audit takes no position).** 17 sitting
Representatives each hold a 2026 Senate CAND_ID on a separate candidate row.
Together those rows carry $68.3M in donations and $188.9M in IE across 40,679
FR rows. Three options:

1. **Merge under the person now.** Use `--adopt-prior`; the S id goes to
   `prior_fec_candidate_ids` and the H id stays live.
   - The Representative's profile then shows the Senate money summed with the
     House money.
   - O1 reads the row `noop`. If they win, O1 reads `prior_office_live` once the
     dataset shows the Senate term and promotes live ← S, H → prior. The chamber
     move comes from the members pipeline, and the `promote_candidate_to_elected`
     RPC is not used because no stub is left.
   - The collision rule deletes $41.86M of losers, of which $14.20M is
     live-both. That cycle is 2026, so the next weekly indiv pass rewrites
     those rows to sums.
   - The field name "prior" is then wrong for a live candidacy, a cosmetic cost
     today's schema forces.
2. **Keep the stub until the election.** This is the status quo.
   - O1 reports these 17 every night.
   - Senate-race candidate rows carry FEC legal names: "Garland Barr", "Felix
     Moore", "S Krishnamoorthi".
   - After the election: a winner needs a promotion path for a person who
     already has an elected row. The W1/Luján promotion was a candidate row
     replacing the elected one, which would move a sitting member's record. A
     loser becomes A2 and takes the class-A recipe.
3. **Neither.** Link the two rows without moving money (a pointer from the stub
   to the member), and teach O1 to exclude linked stubs from `double_claim`.

**Q2 (A2).** Should John James (`S8MI00372`, $74.8M on the stub) and Wesley
Bell (`S4MO00250`, $14,750) ride the class-A apply, or be held? They are prior
candidacies, never won. The manifest lists both, and its evidence column says
so.

**Q3 (first-name refusals).** Should a bioguide-keyed dataset listing be allowed
to override the FIX-929 three-letter key? It affects 4 A rows, 4 B rows and
Ossoff. As things stand the A apply lands 18 of 22.

**Q4 (collision rule under shape C).** Should a shape-C merge sum the live-both
collisions instead of keeping the fresher row, given that the writer itself
sums? Or should the apply leave the losers for a re-derive and say so? This
applies to the class-A apply before it runs. Class-A collisions span cycles
2020–2026; this audit did not read their split by cycle. Only 2026 is
re-emitted by the weekly indiv pass.

**Q5 (class D).** Warner's `P` id needs a gate refusal, or a rule for where a
presidential id lives. Webster's `S4FL00256` needs its FEC cn record read
before it can be classed.
