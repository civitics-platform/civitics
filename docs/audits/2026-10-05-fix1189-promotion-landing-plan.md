# FIX-1189 — the promotion landing plan (inputs for cc-194)

**Written** by cc-193, 2026-10-04 (Sun) ~18:00–20:00 UTC, from reads against
prod taken 17:37–17:50 UTC. **Nothing in this file was run against prod
except the reads it quotes.** cc-194 is the supervised session that runs §5.

Code it depends on (all on `origin/main` before cc-194 starts):

| commit (cc-193) | what |
|---|---|
| item 1 | `selectPromotionPairs` pass 2, the congress-legislators dataset key; `pnpm data:promote:candidates` |
| item 2 | O1, the id writer: `data:legislator-ids-report -- --apply`; the nightly step `congress_legislator_ids_bind` |
| item 3 | FIX-1277, the accent fold in the merge script's gates |
| item 4 | the stamp lists every current-id double claim |

Both nightly switches are **unset** in `nightly.yml`:
`CIVITICS_PROMOTION_DATASET_KEY` (pass 2 in the congress phase) and
`CIVITICS_LEGISLATOR_IDS_BIND` (O1). So the Monday 2026-10-05 21:00 UTC
nightly runs pass 1 only and O1 logs `disabled`. cc-194 flips both **after**
its supervised run (§5 step 8).

---

## 1. Read 2 — the before-table (prod, 2026-10-04 17:40–17:48 UTC)

Instrument: `scripts/db-query.mjs --prod` (read-only transaction) · Database:
prod · Unit: one officials row. **STOP check passed:** none of the eleven
elected rows holds a live FEC id, and no stub has votes or committee
memberships.

### 1a. Identity

| member | bioguide | elected id | elected `source_ids` | stub id | stub `full_name` | CAND_ID (stub's only key) |
|---|---|---|---|---|---|---|
| April McClain Delaney | M001232 | `3ba56de6-f313-4f1f-afbe-c4e360f459db` | `{congress_gov}` | `8ab73c89-3703-43f3-9ed4-1023bf465527` | April Delaney | H4MD06340 |
| Ashley Hinson | H001091 | `1fcd4ca1-8598-476e-a469-d0abdf604863` | `{congress_gov}` | `369bd6b6-2e5c-409d-82fd-bb426b7a66aa` | Ashley Arenholz | H0IA01174 |
| Aumua Amata Coleman Radewagen | R000600 | `e1824501-eb21-4c20-8596-b8a86b543ccd` | `{congress_gov}` | `439f33bb-0ed0-4a27-aedd-3d1e1c8fa8a2` | Aumua Amata | H4AS00036 |
| Austin Scott | S001189 | `88b9e155-0d06-48f3-94e5-bec952869441` | `{congress_gov}` | `893a581e-4fc0-4190-b43f-6afafc7aa917` | James Scott | H0GA08099 |
| Ben Ray Luján | L000570 | `eadbf1fd-e245-44ff-91ec-794407411f69` | `{congress_gov}` | `93a6040f-402c-4f85-8d0d-55cf1b0350b2` | Ben Lujan | S0NM00058 |
| Bonnie Watson Coleman | W000822 | `6a01a39b-8283-40a8-9017-a1eb5d6a340c` | `{congress_gov}` | `eb6e7f4c-dc9c-47c5-a016-5d499dccd0ac` | Bonnie Coleman | H4NJ12149 |
| Jesús G. "Chuy" García | G000586 | `42d07b67-ae64-4276-ac92-3b40fc4a46a3` | `{congress_gov}` | `71c5b1c0-7436-499f-a2e1-61f2e2f681a2` | Jesus Garcia | H8IL04134 |
| Linda T. Sánchez | S001156 | `e899cac1-7982-4a3b-96a0-eb25e39553dc` | `{congress_gov}` | `29714b2c-42bf-4b43-a82d-60785caa4af7` | Linda Sanchez | H2CA39078 |
| Nanette Diaz Barragán | B001300 | `380c47ba-e2b2-4008-8847-1c405343ffc2` | `{congress_gov}` | `499e1266-e4cd-4188-b9b8-4ff321e9863f` | Nanette Barragan | H6CA44103 |
| Nydia M. Velázquez | V000081 | `838ab3f3-760f-4e65-9f3a-08bb474a8692` | `{congress_gov}` | `cd949887-7a4e-4c1d-827d-501ad06522de` | Nydia Velazquez | H2NY00010 |
| Pablo Jose Hernández | H001103 | `cccaae0a-35fd-48ad-a365-c005da9c12b4` | `{congress_gov}` | `02942ed7-fec5-4384-b0cb-d94775ba7d26` | Pablo Hernandez Rivera | H4PR01010 |
| *Luján, prior office* | | | | `6dc78f88-fe6f-4ff5-8a75-bd242e07d0ec` | Ben Lujan (Cand. for Representative) | H8NM03196 |
| Gilbert Ray Cisneros (set 3) | C001123 | `1f0fcc25-c88d-4112-9e90-e873d106d32d` | `{congress_gov, fec_candidate_id: H8CA39174}` | `a1766a0b-a4ee-4117-afb6-6aec28a1af18` | Gilbert Cisneros | H4CA31170 |
| Keith Self (set 3) | S001224 | `0104dd77-938f-4f0f-aa18-cb5c04b51f1d` | `{congress_gov, fec_candidate_id: H2TX00064}` | `60de154b-9dde-4eb9-9b0f-d519172335a9` | Keith Self | H2TX03290 |

All 13 elected rows: `tier='elected'`, `is_active`, created 2026-04-22 (Self
2026-09-13). All 14 stubs: `tier='candidate'`, `is_active`, created 2026-05-11
(Cisneros 2026-07-18, Self 2026-09-19); every stub's `metadata->>'state'` equals
its elected row's jurisdiction.

### 1b. What hangs off each row — the read-back's "before"

FR = `financial_relationships` with the row as `to_id` (`to_type='official'`);
ER = `external_relationships` from / to; EC = `entity_connections` either side.
`follows`, `page_views`, `cosponsors` and `entity_grants` read **0 on all 27
rows**.

| member | elected: votes · memberships · ER from/to · tags · EC | stub: FR rows · $ · ER from/to · tags · EC |
|---|---|---|
| McClain Delaney | 615 · 5 · 0/0 · 2 · vote_yes 204, vote_no 176 | 1,487 · $4,076,867 · 6/0 · 3 · donation 1,270, opposition 5, appointment 1, member_of 2, affiliated_with 3 |
| Hinson | 2,507 · 6 · 1/0 · 2 · vote_yes 1,083, vote_no 269, member_of 1 | 6,589 · $19,908,202 · 0/0 · 3 · donation 4,554, opposition 5 |
| Radewagen | 508 · 9 · 6/0 · 2 · vote_yes 12, vote_no 10, appointment 1, member_of 3 | 113 · $232,073 · 0/0 · 2 · donation 87 |
| Austin Scott | 2,507 · 13 · 3/3 · 2 · vote_yes 1,067, vote_no 275, appointment 1, business_partner 1, member_of 2, affiliated_with 2 | 1,960 · $4,022,424 · 9/1 · 4 · donation 1,325, appointment 7, member_of 1, affiliated_with 1, opposition 1 |
| Luján (S stub) | 107 · 15 · 0/0 · 2 · vote_yes 25, vote_no 38 | 5,494 · $10,126,311 · 0/0 · 3 · donation 4,776, **vote_yes 17, vote_no 27** (0 votes — FIX-990 artefacts), opposition 1 |
| Watson Coleman | 2,507 · 4 · 0/0 · 2 · vote_yes 910, vote_no 411 | 1,440 · $2,673,148 · 2/3 · 4 · donation 936, appointment 1, member_of 2, affiliated_with 2 |
| García | 2,507 · 7 · 0/0 · 2 · vote_yes 880, vote_no 433 | 1,436 · $2,907,072 · 1/0 · 4 · donation 944, appointment 1 |
| Sánchez | 2,507 · 3 · 0/0 · 2 · vote_yes 945, vote_no 400 | 2,055 · $6,074,739 · 1/0 · 4 · donation 1,259, appointment 1 |
| Barragán | 2,507 · 4 · 0/0 · 2 · vote_yes 946, vote_no 385 | 1,683 · $4,556,380 · 2/0 · 4 · donation 1,013, appointment 2 |
| Velázquez | 2,507 · 4 · 0/0 · 2 · vote_yes 912, vote_no 407 | 1,264 · $2,001,133 · 0/0 · 3 · donation 919 |
| Hernández | 84 · 6 · 0/0 · 2 · vote_yes 2, vote_no 9 | 1,565 · $1,970,163 · 0/0 · 3 · donation 1,419 |
| Luján (H stub, not promoted) | — | 171 · $619,552 · 0/0 · 4 · donation 144 |
| Cisneros | 615 · 6 · 0/0 · 5 · FR 2,029 / $5,384,249; donation 1,885, vote_yes 204, vote_no 184, opposition 1 | 68 · $213,523 · 0/0 · 4 · donation 65, opposition 1 |
| Self | 1,612 · 8 · 4/0 · 5 · FR 308 / $556,182; donation 305, vote_yes 565, vote_no 247, appointment 1, member_of 2, affiliated_with 1 | 159 · $392,313 · 0/0 · 4 · donation 117 |

The eleven elected rows hold **0 FR rows**; all $58.55M of the eleven's money
(excluding Luján's H stub) is on the stubs. The six LittleSis stubs carry 25 ER
rows (Scott 10, McClain Delaney 6, Watson Coleman 5, Barragán 2, García 1,
Sánchez 1) — they stay where they are, because the stub is the survivor.

## 2. Read 3 — the dataset (2026-10-04 17:48 UTC)

`legislators-current.json`: HTTP 200, ETag `W/"6ab4f9aa-166a83"` (**unchanged**
from the 10-03 stamp), Last-Modified Thu, 24 Sep 2026 10:21:30 GMT, 539
members. Through the repo's own `parseLegislators` + `currentFecId`:

| member | bioguide | last term | `id.fec[]` | `currentFecId` | stub holding it |
|---|---|---|---|---|---|
| Hinson | H001091 | rep IA-2 | H0IA01174 | ok H0IA01174 | 369bd6b6 |
| Barragán | B001300 | rep CA-44 | H6CA44103 | ok H6CA44103 | 499e1266 |
| McClain Delaney | M001232 | rep MD-6 | H4MD06340 | ok H4MD06340 | 8ab73c89 |
| García | G000586 | rep IL-4 | H8IL04134 | ok H8IL04134 | 71c5b1c0 |
| Watson Coleman | W000822 | rep NJ-12 | H4NJ12149 | ok H4NJ12149 | eb6e7f4c |
| Velázquez | V000081 | rep NY-7 | H2NY00010 | ok H2NY00010 | cd949887 |
| Austin Scott | S001189 | rep GA-8 | H0GA08099 | ok H0GA08099 | 893a581e |
| Hernández | H001103 | rep PR-0 | H4PR01010 | ok H4PR01010 | 02942ed7 |
| Radewagen | R000600 | rep AS-0 | H4AS00036 | ok H4AS00036 | 439f33bb |
| Sánchez | S001156 | rep CA-38 | H2CA39078 | ok H2CA39078 | 29714b2c |
| Luján | L000570 | sen NM | H8NM03196, S0NM00058 | ok S0NM00058 | 93a6040f (H8NM03196 on 6dc78f88) |
| Cisneros | C001123 | rep CA-31 | H8CA39174, H4CA31170 | ok H4CA31170 | a1766a0b |
| Self | S001224 | rep TX-3 | H2TX03290, H2TX00064 | ok H2TX03290 | 60de154b |

All 13 are `ok`; **none is among the dataset's 9 ambiguous current ids**
(Castor, McClintock, Schweikert, Turner, Amodei, Mfume, Ivey, Gillen, McGuire).
Every id matches the census's DB-derived id, including the six the stamp never
carried and Self's inferred one.

## 3. Read 4 — the promotion's recent history

- `data_sync_log` `congress_officials`, last 14 days: 14 rows, all `complete`,
  `rows_updated` 539 each; the step owns no metadata (FIX-758).
- The step's GHA log line, the last five nightlies (runs 37153548243,
  37064147454, 36925657969, 36776521293, 36630299596; 09-29 → 10-03): every one
  `promote-candidates: detected=0 promoted=0 failed=0 skipped_bound=527`.
- `pg_stat_statements` (reset 2026-09-22 22:32 UTC): **no** call to
  `promote_candidate_to_elected` since the reset.
- The pass-2 input set on prod is **12** unbound elected rows: the eleven plus
  Alan Armstrong (A000383, OK Senator), whose listing has `id.fec = []` —
  `currentFecId` is `none`, so pass 2 skips him uncounted (O2 calls him
  `dataset_lag`).

## 4. Read 5 — the set-3 gates (prod, 2026-10-04 17:49 UTC)

`verifySharedIdInDb`'s SQL by hand (read-only), plus donor-cycle overlap:

| | survivor live = prior_id | stub live = current_id | first-name key | decision-5 (11 tables) | overlap |
|---|---|---|---|---|---|
| Cisneros | H8CA39174 ✓ | H4CA31170 ✓ | GIL / GIL ✓ | 0 ✓ | 21 / 68 = 30.9 % |
| Self | H2TX00064 ✓ | H2TX03290 ✓ | KEI / KEI ✓ | 0 ✓ | 67 / 159 = 42.1 % |

Shape B rewrites the survivor's ids BEFORE `verifySharedIdInDb` runs, so
"survivor claims current_id" is true by then. **Both should pass.** The manifest:
`docs/audits/2026-10-05-fix1189-set3-office-promotion-manifest.tsv`.

## 5. The run, in order (cc-194)

Every command from the **primary checkout** (a worktree carries no
`.env.local.prod`). Expected walls: the promotion 11 × ~17 s ≈ 3–4 min; set 3
moves 227 stub FR rows (set 2 moved 46,790 in 238 s) plus manifest-scoped
tails; O1's dry run ~30 s.

0. **Gates.** `pnpm session:held` → `held=false`; the drain-and-wait gates of
   `docs/cc/PROMPT_TEMPLATE.md` (a)–(g) with instants, or
   `SELECT public.prod_op_gate(900)` + the census for (f). The nightly fires
   21:00 UTC — finish ≥ `2 × wall + 15 min` before it, or start after it
   completes.

1. **Promotion, dry run** — plan only, writes nothing, takes no session claim:
   ```
   pnpm --filter @civitics/data data:promote:candidates:prod -- --dry-run --dataset-key
   ```
   Expected, exactly (rehearsed on the clone 2026-10-04, which also lists Al
   Green — see §6):
   ```
   April McClain Delaney          MD representative 3ba56de6-f313-4f1f-afbe-c4e360f459db 8ab73c89-3703-43f3-9ed4-1023bf465527 dataset_key
   Ashley Hinson                  IA representative 1fcd4ca1-8598-476e-a469-d0abdf604863 369bd6b6-2e5c-409d-82fd-bb426b7a66aa dataset_key
   Aumua Amata Coleman Radewagen  AS representative e1824501-eb21-4c20-8596-b8a86b543ccd 439f33bb-0ed0-4a27-aedd-3d1e1c8fa8a2 dataset_key
   Austin Scott                   GA representative 88b9e155-0d06-48f3-94e5-bec952869441 893a581e-4fc0-4190-b43f-6afafc7aa917 dataset_key
   Ben Ray Luján                  NM senator        eadbf1fd-e245-44ff-91ec-794407411f69 93a6040f-402c-4f85-8d0d-55cf1b0350b2 dataset_key
   Bonnie Watson Coleman          NJ representative 6a01a39b-8283-40a8-9017-a1eb5d6a340c eb6e7f4c-dc9c-47c5-a016-5d499dccd0ac dataset_key
   Jesús G. "Chuy" García         IL representative 42d07b67-ae64-4276-ac92-3b40fc4a46a3 71c5b1c0-7436-499f-a2e1-61f2e2f681a2 dataset_key
   Linda T. Sánchez               CA representative e899cac1-7982-4a3b-96a0-eb25e39553dc 29714b2c-42bf-4b43-a82d-60785caa4af7 dataset_key
   Nanette Diaz Barragán          CA representative 380c47ba-e2b2-4008-8847-1c405343ffc2 499e1266-e4cd-4188-b9b8-4ff321e9863f dataset_key
   Nydia M. Velázquez             NY representative 838ab3f3-760f-4e65-9f3a-08bb474a8692 cd949887-7a4e-4c1d-827d-501ad06522de dataset_key
   Pablo Jose Hernández           PR representative cccaae0a-35fd-48ad-a365-c005da9c12b4 02942ed7-fec5-4384-b0cb-d94775ba7d26 dataset_key
   detected=11 planned=11 skipped_bound=527
   promote-candidates: by_name=0 by_dataset_key=11 dataset_no_stub=0 dataset_ambiguous=0 prior_office_stub=1 family_mismatch=0 conflict=0 listing_etag=…
   ```
   **STOP** if the list is not exactly these eleven pairs, or any `conflict` /
   `dataset_ambiguous` / `family_mismatch` is non-zero. `prior_office_stub=1` is
   Luján's House stub, counted and not paired.

2. **Promotion, apply** — claims the FIX-950 session for its run; against prod
   prints the host and waits 5 s:
   ```
   pnpm --filter @civitics/data data:promote:candidates:prod -- --apply --dataset-key
   ```
   Expected: eleven `promote-candidates: <name> (… ) — N votes + M total FKs
   moved` lines, then `detected=11 promoted=11 failed=0 skipped_bound=527`.

3. **Read-back** (`db-query --prod --file`; write the SQL with the Write tool):
   - the eleven **stub** ids above: `tier='elected'`, `is_active`,
     `role_title` = the elected row's, `source_ids.fec_candidate_id` = the
     CAND_ID of §1a, `source_ids.congress_gov` = the bioguide, and
     `prior_fec_candidate_ids` absent (Luján's H8NM03196 is NOT added — §6);
   - the eleven **elected** ids: **0 rows** in `officials`;
   - per survivor, against §1b: FR rows = the stub's (the elected rows had
     none); votes = the elected row's (e.g. Hinson 2,507, Luján 107);
     memberships = the elected row's; ER = stub + elected (Scott 9+3 from,
     1+3 to = 16); tags = per the RPC's FIX-463 dedupe (≤ stub + elected);
     Luján's 44 stale `vote_*` edges stay until the Wednesday votes-arm cycle.

4. **Set 3, dry run** (rolls back):
   ```
   pnpm --filter @civitics/data data:merge:official-dupes:prod -- \
     --promote-manifest ../../docs/audits/2026-10-05-fix1189-set3-office-promotion-manifest.tsv \
     --defer-tails
   ```
   Expected: `OFFICE-PROMOTION manifest → 2 row(s)`, two `PROMOTE` lines
   (H4CA31170, H2TX03290), no `REJECTED`. Quote the conservation and the
   collision census it prints.

5. **Set 3, apply:** the same command with `--apply`. Read back: Cisneros
   live H4CA31170 with H8CA39174 in `prior_fec_candidate_ids`; Self live
   H2TX03290 with H2TX00064 in prior; both stubs `merged_fec_candidate_ids` =
   [current id], 0 FR rows.

6. **O1, dry run on prod** — plan only, writes nothing:
   ```
   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local.prod \
     src/pipelines/congress/legislator-ids-report.ts --apply --dry-run
   ```
   Expected: `O1 plan: … bind 0, promote 2, prior_append ≤ 29` (the 10-03 stamp
   had `prior_office_live` 2 — Bill Foster, Lois Frankel — and
   `prior_incomplete` 29; a `prior_incomplete` row whose missing id is retired
   on it plans nothing, so ≤). **STOP** if any of the eleven, Cisneros or Self
   appears with `bind` or `promote`. The class counts it prints should read
   `double_claim` 59 → **47** and `noop` 444 → **456** (§6: Luján stays a
   double claim).

7. **Release** — each script releases its own claim; `pnpm session:held` →
   `held=false`.

8. **Flip both switches** — add to `nightly.yml`'s `fec-phase` `env:` (the
   comment block there names them):
   ```
   CIVITICS_PROMOTION_DATASET_KEY: "1"
   CIVITICS_LEGISLATOR_IDS_BIND:   "1"
   ```
   Commit, push. The Tuesday 2026-10-06 21:00 UTC nightly is then the first
   unattended run of both: the promotion's log line should read
   `by_dataset_key=0` (the eleven are done) and O1 stamps
   `congress_legislator_ids_bind` with `acted {bound 0, promoted 2,
   prior_appended ≤ 29, refused_changed 0}`.

**The receipts that close it:** Tuesday's receipt §10 — `double_claim` 59 →
47, its current-id split 13 → 0 and its other-office split 46 → 47 (Luján
moves halves), `noop` 444 → 456 (ten of the eleven + Cisneros + Self);
Wednesday's §10 — the O1 line with `acted`, `prior_office_live` 2 → 0,
`prior_incomplete` → 0 or the retired-id residue.

## 6. What the reads changed in the design

- **Luján's House id is not O1's to write while his House stub exists.** The
  design (§5) expected O1's `prior_incomplete` write to add H8NM03196 to the
  promoted row. It will not: stub `6dc78f88` still claims H8NM03196, so the
  classifier puts Luján in `double_claim`, which O1 never acts on. The id
  arrives only with D6's shape-A merge of that stub (after FIX-1277, cc-194 or
  later) or by hand. The same fact moves the receipt's arithmetic: Luján stays
  in `double_claim` (its other-office half) after his promotion, so the design's
  `double_claim` 59 → 46 / `noop` 444 → 455 is **47 / 456**.
- **The clone is not prod for this population.** The clone's dry run lists
  twelve pairs — the eleven plus Al Green (`e9015ab5` ← `a92cfc2e`). On prod his
  elected row holds H4TX09095 live and the Alexander Green stub carries it only
  in `merged_fec_candidate_ids`, so the FIX-1196 guard refuses him and the stub
  is not even a candidate input. Prod's plan is eleven.
- **The promotion is not held by a supervised session.** It runs inside the
  fec phase's Phase-1 daily ingest, which FIX-950 deliberately keeps running
  under a hold. The dataset-key switch, not the session, is what keeps Monday's
  21:00 UTC nightly from promoting the eleven unattended.
- **O1's step runs after the promotion, in the same job.** It sits last in
  the fec phase's daily block (after congress officials, before `fec_bulk`),
  not at the top of the job, so a night's promotions are in the reading O1
  classifies.
