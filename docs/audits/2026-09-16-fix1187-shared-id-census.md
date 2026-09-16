# FIX-1187 — the shared-CAND_ID class: census on clone and prod, the five office-changed Senators, the reader split, and two clone dry runs

Run cc-128, 2026-09-16 (UTC). Prod contact for FIX-1187 was **read-only
throughout** — the manifests are committed for cc-129 to apply. The one prod
WRITE this session made belongs to FIX-1185 and is a separate item.

Manifests: [`2026-09-16-fix1187-shared-id-manifest.tsv`](2026-09-16-fix1187-shared-id-manifest.tsv)
(151 rows) and [`2026-09-16-fix1187-office-promotion-manifest.tsv`](2026-09-16-fix1187-office-promotion-manifest.tsv)
(5 rows). Both are AUTHORISATIONS and say so in their headers.

---

## 1. The population — clone and prod agree exactly

Selection: `officials` self-joined on `source_ids->>'fec_candidate_id'`, survivor
`tier='elected' AND is_active`, dup `tier='candidate'`, dup holds ≥ 1
`financial_relationships` row, neither side carrying a retired-claim marker for
that id (both marker shapes), first-name keys compared on FIX-929's 3-letter key.

| | clone | prod |
|---|---:|---:|
| pairs | **151** | **151** |
| first-name key agrees | 151 | 151 |
| undecidable / disagrees | 0 / 0 | 0 / 0 |
| state agrees | 151 | 151 |
| distinct CAND_IDs / survivors / stubs | 151 / 151 / 151 | 151 / 151 / 151 |

A clean 1:1:1, and **no difference to explain** — the clone's dump date does not
enter into it. The read-5 STOP (a pair whose first-name keys DISAGREE) does not
fire; there is no such pair.

The old FIX-953 own-seat verdict, recomputed on the same population:

| verdict | pairs |
|---|---:|
| pass | **117** |
| fail — district digits | **29** |
| fail — office char + district | **4** |
| fail — office char only | **1** (Lummis: `H8WY00148`, at-large, so the `00` digits match her district_int 0) |

117 / 29 / 5 — the FIX-953 census of 2026-08-10 reproduced exactly.

### Stub money by cycle × source (clone; prod re-derived the same cells)

| cycle | type | source | rows | dollars | stubs |
|---:|---|---|---:|---:|---:|
| 2026 | donation | fec_bulk_indiv | 46,561 | $72,951,060 | 88 |
| 2026 | donation | fec_bulk_pac | 19,851 | $69,019,312 | 117 |
| 2026 | ie_support | fec_bulk_ie | 56 | $12,235,671 | 28 |
| 2026 | ie_oppose | fec_bulk_ie | 22 | $2,674,595 | 15 |
| 2024 | donation | fec_bulk_pac | 31,083 | $122,787,036 | 148 |
| 2024 | ie_oppose | fec_bulk_ie | 104 | $119,061,496 | 33 |
| 2024 | ie_support | fec_bulk_ie | 343 | $61,253,820 | 85 |
| 2024 | donation | fec_bulk_indiv | 469 | $575,460 | 3 |
| 2022 | ie_oppose | fec_bulk_ie | 112 | $114,062,351 | 25 |
| 2022 | ie_support | fec_bulk_ie | 277 | $86,488,015 | 42 |
| 2020 | ie_oppose | fec_bulk_ie | 123 | $211,776,631 | 19 |
| 2020 | ie_support | fec_bulk_ie | 216 | $53,704,520 | 34 |
| | | **total** | **99,217** | **$926,589,966** | |

$926,589,966 reproduces the FIX-953 figure to the dollar, and the 2026
`fec_bulk_indiv` slice reproduces cc-126's prod measurement to the row. Max
`updated_at` on any stub row is **2026-07-28** — the stubs have been frozen since
FIX-941 handed the shared binding to the elected rows.

### Attachments: zero, on both databases

All eleven decision-5 tables (votes, career_history, committee memberships,
promises, cosponsorships, community comments, civic responses, lobbying
disclosures, sponsored bills, proposal actions, `external_relationships`) count
**0** across all 151 stubs on **clone and prod**. FIX-1020's class is empty in
this population, so no pair is refused on it.

### Candidate-vs-candidate shared ids

Reported, not selected: the selection requires `survivor.tier='elected'`, and
the structural test locks that. They remain a separate question.

---

## 2. The five office-changed Senators (read 7)

Every active elected row on **prod** whose `fec_candidate_id` prefix disagrees
with its `role_title` — exactly **five**, each with exactly two candidate stubs:

| survivor | state | holds (House) | Senate stub | Senate id | FR rows | $ | House stub | FR rows | $ |
|---|---|---|---|---|---:|---:|---|---:|---:|
| Adam B. Schiff | CA | H0CA27085 | `2c0f0bd2` | S4CA00555 | 19,632 | $23,862,028 | `41d2af4c` | 34 | $119,535 |
| Roger Marshall | KS | H6KS01179 | `60f87348` | S0KS00315 | 4,678 | $40,482,480 | `ce2b114f` | 51 | $325,540 |
| Gary C. Peters | MI | H8MI09068 | `cdc8ae79` | S4MI00355 | 23,464 | $80,077,206 | `b05ae301` | 3 | $3,000 |
| John R. Curtis | UT | H8UT03238 | `f073c8ba` | S4UT00282 | 1,850 | $13,457,973 | `71a323fc` | 321 | $1,478,365 |
| Cynthia M. Lummis | WY | H8WY00148 | `60bfd339` | S0WY00137 | 1,852 | $5,002,244 | `12b08a65` | 6 | $30,000 |

Marshall's House-id stub `ce2b114f` carries `role_title = 'Candidate for
Senator'` while holding `H6KS01179` — the prompt predicted it and it is there.
Its role does not matter to the shared-id path, which applies no seat gate.

The design's §0.5 FR counts (Schiff 17,832; Marshall 2,042; Peters 3,343;
Curtis 1,845; Lummis 932) were **clone** figures. Prod is materially higher —
Peters in particular is 23,464, not 3,343 — because prod has emitted several
times since the clone's dump. The table above is prod as of 2026-09-16.

### fec.gov evidence (D2) — all five verify, none excluded

Checked against the OpenFEC API, `https://api.open.fec.gov/v1/candidate/<ID>/`,
on 2026-09-16:

| id | name returned | state | office | party |
|---|---|---|---|---|
| S4CA00555 | `SCHIFF, ADAM` | CA | S (Senate) | DEM |
| S0KS00315 | `MARSHALL, ROGER W` | KS | S (Senate) | REPUBLICAN PARTY |
| S4MI00355 | `PETERS, GARY` | MI | S (Senate) | DEM |
| S4UT00282 | `CURTIS, JOHN` | UT | S (Senate) | REPUBLICAN PARTY |
| S0WY00137 | `LUMMIS, CYNTHIA MARIE MRS.` | WY | S (Senate) | REP |

Name, state and office agree with the survivor row in every case. No id failed
to verify, so no Senator is excluded from set 2.

---

## 3. What contradicted the design

### 3.1 The collision-direction premise is false as stated — and the gate it guards is met by a different, stronger fact

The design (§3A) premised that "the stubs are frozen July snapshots; the
survivor's rows are the ones every run since July refreshes", and asked for a
**STOP if the direction is not ≥ 99 % survivor-fresher**.

Measured, on **prod**, over all 99,217 collisions:

| | prod | clone |
|---|---:|---:|
| survivor-fresher | 58,568 (**59.0 %**) | 54,345 (55.0 %) |
| dup-fresher | 40,649 | 44,533 |
| ties | 0 | 0 |

**The gate does not pass, and it is not a clone artefact.** The whole dup-fresher
population is one cell — 2026 `fec_bulk_indiv`, where the survivor rows range
2026-07-13 … 2026-09-01 and the stub rows 2026-05-17 … 2026-07-27, so for 40,551
of 46,561 the stub's July stamp is genuinely the later one.

The cause is that **`updated_at` moves only when a row's VALUE changes.** A
survivor row that the last emit re-confirmed unchanged keeps an old stamp, so
`updated_at` is a poor proxy for "which binding is live" in exactly this class.

What IS true is strictly stronger for money, and was measured on prod and clone:

> In **every** cycle × source cell, the count of collisions where the two
> amounts **differ** AND the dup is fresher is **ZERO**.

On prod the amounts differ on 8,456 collisions; in all 8,456 the survivor is the
fresher row and already wins the tie-break. Where the dup wins (40,649) the
amounts are identical and the outcome is the same either way. Direction of the
difference where it exists: survivor larger in 8,431 of 8,456, $11.21 M of
survivor excess against $54,850 of dup excess — cycle-to-date growth on the live
binding, which is the binding story the design told.

The set-1 dry run confirms it independently and end-to-end: **all 151 survivors'
donation totals are UNCHANGED** by the merge, every stub goes to $0, and the
conservation difference is exactly $0.

**Disposition.** Per the prompt's STOP, set 1 does **not** claim readiness on the
stated gate, and cc-129 should not treat the ≥ 99 % line as satisfied. The
substantive question the gate exists to answer — can the tie-break delete the
right dollars — is answered yes by a directly measured invariant. The manifest
header carries both facts, and names the check cc-129 must re-run on prod
immediately before applying: `diff_and_dup_fresher = 0`.

### 3.2 `fec-orphan-classify`'s `twin_fec_id` is a SEAT reader, not a claim reader

The design's §3B put `fec-orphan-classify`'s `twin_fec_id` in the **claim /
has-id** list. The tree says otherwise: `twin_fec_id` is
`COALESCE(fec_candidate_id, fec_id)` and its only consumers are `stateAgrees` →
`stateMatches` and `seatAgrees` → `seatMatches`, both of which **decode a seat**
from the id. Feeding a prior-office id there would make the seat test compare the
person's current seat against a previous office's id and report a false
disagreement.

The two genuine has-id sites in that file are the ones §3B did not name: the
`suspect` CTE's `fec_candidate_id IS NULL` (otherwise a promoted member reads as
an orphan) and `lk.has_fec` (the twin pool). Both now read the array;
`twin_fec_id` deliberately does not, and the asymmetry is commented in the SQL
ten lines apart.

### 3.3 The two stubs of one Senator cannot be in one set

§3B said the House stub "merges in the same set" as the Senate stub. It cannot:
`_manifest` is `(survivor PRIMARY KEY, dup UNIQUE)` because the merge SQL assumes
1:1, and two stubs for one survivor would move both stubs' colliding rows onto
the survivor and violate `financial_relationships_relcycle_unique`.

The fix costs nothing, because each House stub is **already** an ordinary shape-A
pair today — the survivor's live `fec_candidate_id` IS the House id, which is why
all five appear among the 151. So the House stubs ride set 1 and set 2 takes only
the Senate stubs. **Set 1 must run before set 2**, and a structural test locks the
partition.

### 3.4 What did NOT contradict the design

The population (151, both databases), the money by cycle × source, the 117/29/5
seat split, zero attachments, the five Senators and their stub shapes, the
`pg_proc` reader list (exactly the five §3B named), the merge core, the
manifest-path plumbing, and the FIX-1165 tail classification all held as written.

---

## 4. The reader census (read 8)

`grep -rn "fec_candidate_id"` over `packages/`, `apps/`, `scripts/` plus the prod
`pg_proc` census (`prosrc LIKE '%fec_candidate_id%'`).

**Prod `pg_proc` returned exactly the five the design predicted** —
`rebuild_all_primary_sources`, `refresh_primary_source_for_entities`,
`treemap_officials_by_donations` (two overloads), `promote_candidate_to_elected`,
`rebuild_entity_search_index` — all **display / URL / seat**, none changed.

| site | verdict | changed |
|---|---|---|
| `index.ts` `buildMatchIndex` pass 1 | claim | **yes** — `authoritativeClaims` |
| `index.ts` `perCycleNameFallback` pool filter | has-id | **yes** — `priorClaims` |
| `candidates.ts` `loadOfficialsByFecIds` | claim | **yes** — `authoritativeClaims` |
| `mint-ie-targets.ts` `existingByFecCandId` | claim | inherits — it consumes the map `loadOfficialsByFecIds` builds |
| `fec-orphan-classify.ts` `suspect` CTE | has-id | **yes** (not in §3B) |
| `fec-orphan-classify.ts` `lk.has_fec` | has-id | **yes** (not in §3B) |
| `fec-orphan-classify.ts` `twin_fec_id` | **seat** | **no** — §3B had this on the wrong side (§3.2) |
| merge script `OWN_SEAT_MANIFEST_SQL` survivor identity line | claim | **yes** — `auth_claims` |
| merge script `OWN_SEAT_MANIFEST_SQL` office/state/district gate | seat | no |
| merge script `verifyManifestInDb` `survivor_has_fec` | has-id | **yes** |
| merge script `SUSPECT_SQL` | retired-claim keyed, not live-id keyed | no |
| `writer.ts` `persistNewFecIds` | write path, retired-claim guarded | **no** — confirmed unaffected |
| `apps/.../api/attribution/[type]/[id]` | URL | no |
| `apps/.../api/graph/entities` | seat (state from prefix) | no |
| `apps/.../api/graph/treemap` | seat (state from prefix) | no |
| five prod `pg_proc` functions | display / URL / seat | no |

**What the grep added to §3B:** `mint-ie-targets.ts` (inherits), the two
`fec-orphan-classify` predicates, `verifyManifestInDb`'s `survivor_has_fec`, and
the three app routes (all display/seat). **What it removed:**
`fec-orphan-classify`'s `twin_fec_id`.

### `promote-candidates.ts` (read 9) — unchanged, and now explained

`:153` loads candidates with `.filter("source_ids->>fec_candidate_id", "not.is",
null)`, so a stub whose id has moved into `merged_fec_candidate_ids` leaves that
load after the merge. `:201-203` keys on `normName(full_name)|state|roleFamily`
and skips when `matches.length !== 1`. That is why these pairs never promoted:
"Adam B. Schiff" ≠ "Adam Schiff" on the exact-name key, and Marshall has **two**
Cand-for-Senator stubs so his key resolves to 2. No change made.

---

## 5. The clone dry runs

Both rolled back. `--defer-tails` on both.

| | set 1 (shared-id) | set 2 (office promotion) |
|---|---:|---:|
| rows in | 151 | 5 |
| accepted / refused | **151 / 0** | **5 / 0** |
| wall (clone) | **2m 35.7s** | **51.5s** |
| collisions | 98,878 | 23,830 |
| — dup-fresher | 44,533 | **23,802** |
| — survivor-fresher | 54,345 | 9 |
| — ties | 0 | 19 |
| losers deleted (survivor side) | 44,533 | 23,821 |
| losers deleted (dup side) | 54,345 | 9 |
| FR rows moved to survivors | 44,872 | 25,985 |
| stale EC money edges deleted | 87,206 | 23,615 |
| `official_donor_totals` deleted (dups) | 149 | 5 |
| CAND_IDs retired on stubs | 151 | 5 |
| manifest donation $ before → after | $1,291,599,329 → $1,026,266,461 | $94,229,595 → $54,422,039 |
| observed drop = deleted losers | $265,332,868 = $265,332,868 | $39,807,556 = $39,807,556 |
| **conservation difference** | **$0 OK** | **$0 OK** |
| dups still holding money | 0 | 0 |
| `official_donor_totals` diffs outside manifest | 0 | 0 |

**The collision directions are opposites, and both are the expected sign.** Set 1
runs survivor-fresher (the stubs are frozen); set 2 runs 99.96 % dup-fresher,
because there the Senate stub holds the live binding and the survivor's own
2024/2026 rows are stale May copies. The design predicted exactly this inversion
for shape B and it is reported separately, not folded in.

Set 2's survivors' donation totals RISE — Schiff $28.91 M → $29.38 M, Marshall
$6.14 M → $7.57 M, Peters $5.69 M → $6.79 M, Curtis $7.49 M → $7.69 M, Lummis
$2.80 M → $3.00 M — while set 1's are all unchanged. That difference is the two
shapes in one line: shape A removes a double count, shape B reunites a person
with money that was never on their row.

### Tail cost table (identical for both sets)

Three **manifest-scoped** steps run (`donor_rollup_rebuild_recipients(affected)`,
`financial_entity_donation_totals_rebuild`, `donor_party_rollup_rebuild_donors`);
**fourteen platform-scoped** steps defer, each naming a scheduled owner; **zero
platform-orphans**. No step's cost is independent of the manifest and ownerless,
which is the FIX-1165 condition.

### Proposed set split for cc-129 (D4)

Set 1's clone wall is 2m 35.7s. The prod multiplier for this script is not a
constant to quote — the FIX-953 precedent is that the prod apply was
byte-identical to a clone restore that took 78m58s, and
`reference_clone_understates_scan_bound_costs` records the clone lying in both
directions (6× vs prod on some shapes, 42× cold-vs-warm on others). The honest
statement is a range, not a number: at 6× set 1 projects to ~16 min and at 20× to
~52 min, both inside the ~60 min-per-set target, so **one set of 151 is the
proposal** rather than a split. Set 2 at 51.5s projects to 5–17 min.

Two caveats cc-129 should clock rather than assume: the dominant step is
`FR move to_id → survivor` (96.3s of set 1's 155s on the clone), which is
write-bound and the shape most sensitive to prod's buffer pressure; and
`entity_connections delete stale money edges` removes 87,206 rows, whose vacuum
tail belongs to the FIX-1152 daily owners and is deferred, not skipped. If the
first prod run's phase-1 timings exceed the projection, the split lever is
`stub_cents` descending, which is the manifest's row order.

---

## 6. Block A (FIX-1185) — the ceiling read, recorded here for completeness

Read 2's numbers, prod 2026-09-16, trailing 30 days (2026-08-17 … 2026-09-16):

- **Watchdog max lateness 963.8 s**, re-derived as `acted_at − (start_time +
  budget_seconds)` over `cron_job_budget_action` (12 rows in window). cc-125's
  973.9 s is the `age_seconds` form, measured at scan time. STOP threshold
  1,800 s — **does not fire**.
- **30-day longest `complete` per budgeted job**, from each procedure's own
  terminal row in `data_sync_log`: `run_rule_taggers` weekly 4,837.7 s;
  `donor_rollup_refresh` 4,405.8 s; `entity_connections_rebuild` 2,654.1 s;
  `contract_flow_rollups_rebuild` 1,949.2 s; `refresh_derived_mvs` 1,620.9 s
  weekly / 1,394.4 s daily; nothing else above 1,084.0 s. **Nothing in the window
  completes above 4,837.7 s.**
- Neither cut job has a 30-day `complete` above its new 9,000 s budget
  (4,405.8 and 1,949.2). No active job has one above 10,800 s. **No STOP fires.**
- Ordering: 10,800 − 963.8 = **9,836.2 ≥ 9,000**, the largest active budget after
  the migration.

**Two things worth flagging that the prompt's expected values did not have:**

1. **`donor-rollup-refresh`'s 30-day maximum is a `partial`, not a `complete`.**
   The prompt expected "~7,201.7 s complete". 7,201.7 s is the 30-day maximum
   **wall**; that run's terminal row reads `partial` with
   `stop_reason: budget_exhausted` — FIX-973's 2 h internal budget stopping it
   cleanly. The longest actual `complete` is 4,405.8 s. Both are under 9,000, so
   the decision is unaffected, but the instrument matters: reading
   `cron.job_run_details.status` instead would have called a 21,919.4 s
   `refresh-derived-mvs-daily` run "succeeded" when the procedure logged
   `partial` with 8 of 13 units.
2. **`donor-rollup-refresh`'s existing budget note records a 9,388 s
   observation** for the FIX-1018 pre-loop dirty-set build, which the new 9,000 s
   budget does **not** cover. It predates the 30-day window, and the job is
   resumable (a cancel resumes from its cursor rather than losing work), so this
   is a documented trade rather than a blocker — the migration header and the
   row's own note both say so.

**One ordering consequence the migration does not fix, stated so it is not
discovered later:** the two INACTIVE `rebuild-ec-incremental` rows keep an
18,000 s budget, now **above** the 10,800 s ceiling. Nothing is demoted today
because they are inactive; re-enabling either one has to revisit its number
first.

### The post-push verification, and a pooler gotcha worth keeping

After `pnpm db:push:prod` at 03:24:03 UTC the role row reads
`{statement_timeout=3h,work_mem=256MB}` and all three budget rows are 9,000. But
**`SELECT current_setting('statement_timeout')` through `db-query --prod`
returned `6h`, repeatedly.**

That is not a failed push. Supavisor's session pooler was handing back one warm
backend (pid 73477, `backend_start` 03:23:52 — **11 seconds before** the
migration committed), and a role default applies to NEW sessions only. Opening a
second *concurrent* connection forced a fresh backend: pid 73490,
`backend_start` 03:25:12, `statement_timeout` = **`3h`**.

So the ceiling is armed for every new session, including every pg_cron firing
(pg_cron opens its own connection per run, not through the pooler). The lesson
for any future role-GUC change: **the fresh-session check through the pooler can
report the OLD value indefinitely** — force concurrency to observe a new backend
before concluding anything.

Receipt (A3) is **not** in: `contract-flow-rollups-refresh` next fires Thu
2026-09-17 14:00 UTC. cc-129 carries the FIX-1185 record commit.
