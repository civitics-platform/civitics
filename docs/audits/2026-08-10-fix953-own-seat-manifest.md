# FIX-953 phase 1 — OWN-SEAT twin census + manifest (prod)

Generated 2026-08-10, from prod, **read-only — nothing written**. Phase 1 ends here;
phase 2 needs Craig's go.

Companion TSV: `2026-08-10-fix953-own-seat-manifest.tsv` (122 rows, classes A + B).

---

## Headline — the class is not two pairs

FIX-953 names two pairs worth $3.9M. The structurally identical class, derived
platform-wide, is **146 pairs**; **122** of them pass the exclusion gate.

| class | what it is | pairs | stub rows | stub $ (all types) | stub $ (donation) |
|---|---|---:|---:|---:|---:|
| **A** double-claim | survivor ALREADY carries the stub's exact CAND_ID | 117 | 80,546 | $815,433,444 | $209,691,577 |
| **B** orphan-survivor | survivor carries no FEC binding at all | 5 | 10,394 | $28,663,565 | $20,923,695 |
| **C** different-id | survivor holds a DIFFERENT CAND_ID → **excluded, FIX-956** | 24 | 28,269 | $147,907,129 | — |
| | **structural total** | **146** | **119,209** | **$992,004,138** | |

**Neither named pair is in the state the FIX-953 bullet describes.** The bullet says
Shontel Brown's elected row also claims `H2OH11169`, making it a live double-claim
race. On prod today her elected row carries **only** `{"congress_gov": "B001313"}`,
and Al Green's only `{"congress_gov": "G000553"}`. `H2OH11169` and `H4TX09095` are each
**single-claimed by the stub**. Both are therefore class B, not the double-claim class —
they are plain FIX-930 attribution orphans, and the *only* thing that ever blocked
FIX-933 from taking them is the classifier's best-twin ranking, exactly as the bullet's
last sentence says. 522 elected rows do carry both `congress_gov` and
`fec_candidate_id` (refreshed by tonight's `congress_officials` run at 03:57 UTC), so
this is not a clobbering bug — those two rows were simply never bound.

---

## The seat gate is NOT a same-person proof — class C proves it

§2 decision 4 specifies selection by "a candidate-tier twin whose CAND_ID describes the
SAME seat the elected holder actually occupies" plus `ownerRelation()`'s name rules and
donor-cycle overlap. **Measured, that gate set is not sufficient**, and adding the
district digits (which this manifest does, and which FIX-954 correctly demanded to stop
the Robert-vs-Mike-Garcia collapse) does not make it sufficient.

Same surname, same office, same state, **same district**, provably different people:

| survivor | stub | seat | relationship |
|---|---|---|---|
| Adelita S. Grijalva | Raul Grijalva `H2AZ07070` | AZ-7 | her father |
| Julia Letlow | Luke Letlow `H0LA05120` | LA-5 | her late husband |
| Troy E. Nehls | Trever Nehls `H6TX22283` | TX-22 | his twin brother |
| Robert Garcia | Cristina Garcia `H2CA42213` | CA-42 | unrelated |
| Derek Schmidt | Patrick Schmidt `H2KS02143` | KS-2 | his 2022 opponent |
| Sylvia R. Garcia | Adrian / Roel / Christian Garcia | TX-29 | unrelated |
| Adam Smith | Sarah Smith, Daniel Smith | WA-9 | unrelated |
| Daniel Webster | Royal Webster `H6FL11241` | FL-11 | unrelated |

Relatives, spouses, siblings and opponents contest the same seat constantly. Every one
of the rows above is held back **only** because the survivor happens to carry its own
different CAND_ID (class C) — an accident of those particular rows, not something the
seat gate earned. Treat the seat gate as a **necessary** condition only.

What supplies the missing sufficiency differs by class, and that is why the two are
never selected together (`--own-seat-class`):

- **class A is self-sufficient.** A CAND_ID names exactly one FEC candidate, the stub
  was *minted from that CAND_ID* by the `cn{yy}` stage, and the survivor's identical
  binding was written by the FIX-952 backfill's authoritative bioguide path. Two rows
  claiming one CAND_ID are the same candidate, on evidence that never passed through a
  surname. Corroborating: all 117 also agree on the 3-letter first-name key, and all
  117 have non-zero donor-cycle overlap.
- **class B is not.** The survivor is unbound, so nothing but the seat gate is talking.
  Every class-B pair is enumerated and judged individually below.

---

## Class B — the FIX-953 scope, per pair

| survivor ← stub | CAND_ID | name signal | overlap | stub $ donation | stub rows | survivor $ | votes | ext_rel | EC non-money | verdict |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Shontel M. Brown ← M Brown | `H2OH11169` | undecidable | **32.6%** | $6,466,355 | 3,522 | $4,242,275 | 0 | 0 | 0 | **MERGE** |
| Mike Collins ← Michael Collins | `H4GA10071` | DISAGREES | **56.7%** | $1,952,030 | 886 | $3,496,690 | 0 | 0 | 0 | **MERGE** |
| Chuck Grassley ← Charles Grassley | `S0IA00028` | DISAGREES | **26.7%** | $6,826,931 | 3,332 | $3,348,824 | 0 | 0 | 15 stale | **MERGE** (note) |
| Al Green ← Alexander Green | `H4TX09095` | undecidable | **69.1%** | $1,990,815 | 982 | $1,286,478 | 0 | **6** | 6 | **EXCLUDE** |
| Austin Scott ← James Scott | `H0GA08099` | DISAGREES | **0.0%** | $3,687,564 | 1,672 | **$0** | 0 | **10** | 9 | **EXCLUDE ×2** |

Notes, per decision 5 ("anything beyond FR money + provenance metadata ⇒ exclude"):

- **Al Green is excluded, and it is one of the two named pairs.** His stub anchors **6
  real `external_relationships` rows** (3 as `from`, 3 as `to` — LittleSis
  `affiliated_with` / `business_partner` / `member_of` / `owns`). The merge moves money
  and deletes only `donation`/`opposition` EC edges, so those source records would be
  stranded on a $0 stub. This is FIX-940's lesson exactly ("money and nothing else" was
  once wrong by 1,755 votes). Small and fixable — but it is a decision-5 exclusion as
  the rule is written, and the rule is the safety.
- **Austin Scott fails two independent gates**: 10 stranded `external_relationships`
  rows, **and zero donor-cycle overlap** — the stub shares not one
  `(relationship_type, from_id, cycle_year)` key with the survivor, who holds $0 and no
  FR rows at all. Under §2 decision 4's "meaningful donor-cycle overlap" signal this
  pair does not qualify on the money evidence either.
- **Chuck Grassley's 15 EC edges are stale artifacts, not data.** They are `vote_yes` /
  `vote_no` with `evidence_source='votes'`, but the stub's `votes` count is **0** — the
  underlying votes were cleared by FIX-940/941 and `entity_connections` was never
  re-derived, because the rebuild has not succeeded in 11.8 days (see below). Zero
  `external_relationships`. Recommend merging; the stale edges are FIX-990's problem.
- `official_content_ids` hits on 65 stubs are `(official_id, refreshed_at)` — cache
  bookkeeping, no payload. Benign.
- Platform-wide, class A carries **zero** votes and **zero** `external_relationships`;
  23 stubs carry stale EC non-money edges of the same FIX-990 origin.

---

## 1:1 integrity

`_manifest` is `(survivor PRIMARY KEY, dup UNIQUE)`, so the selection must be 1:1.
Measured across the **full 146-row structural class**: 5 survivors appear more than
once, 0 stubs repeat, 0 ids appear on both sides. **All 5 multi-pair survivors are
inside class C** (Todd Young ×5, Sylvia R. Garcia ×3, Adam Smith ×2 …), which is
excluded regardless — so across the 122-row A+B manifest the mapping is **already
1:1 and `enforceOneToOne` drops nothing**.

## Double-claim reconciliation — what remains of FIX-933 step 0's 153

Step 0 auto-retires a duplicate's CAND_ID claim only when the duplicate holds **no**
money, and deliberately refuses the rest. That refused population today:

| bucket | pairs | $ on the duplicate |
|---|---:|---:|
| duplicate HOLDS money (step 0 refuses) | **151** | $926,589,966 |
| duplicate holds no money (step 0 retires) | 0 | — |

It decomposes cleanly against this census — **117 + 34 = 151**:

| | pairs |
|---|---:|
| pass the own-seat structural gate → **class A** | **117** |
| fail it: survivor `Representative` vs stub `Candidate for Representative`, office/district differs | 29 |
| fail it: survivor `Senator` vs stub `Candidate for Representative` | 4 |
| fail it: survivor `Senator` vs stub `Candidate for Senator`, office/district differs | 1 |

The 34 that fail are the House→Senate shape and its relatives — the same territory as
class C, and the same answer: **FIX-956**, not this script.

---

## §0 answers

- **P1** — cycle-2026 backfill complete before anything was read: `fec_bulk` finished
  2026-08-09 23:43:25 UTC (74.6 min, 2,283,060 rows). Zero running pipelines, zero
  active backends at clone time.
- **P2** — `fec_indiv_watermark['2026']` recorded at manifest time as
  `"Sun, 09 Aug 2026 16:03:26 GMT"`, etag `"9167f97b6dfbd1c58e4f4f50997b8c2f-246"`;
  **re-read after the manifest was built: identical**. The manifest is not stale. The
  FIX-998 hold was NOT re-enabled.
- **P4** — `entity_connections_rebuild` last **succeeded 2026-07-29 09:29 UTC —
  283.5 hours (11.8 days) ago**; the 2026-08-03 08:00 firing was `reaped`. FIX-990
  logged 232h/84h, so this has **degraded further**, and it is the direct cause of the
  stale `vote_*` EC edges on Grassley's and 23 class-A stubs.
- **P5** — **no selection signal reads `updated_at`.** Own-seat selection reads
  `source_ids`, `tier`, `role_title`, `jurisdiction`, `district_name`, `last_name`,
  `first_name` and an `EXISTS` on `financial_relationships`. The FIX-1008 semantics
  change does, however, land on the **collision tie-break**
  (`merge-same-person-official-dupes.ts:1361-1363`, `keep_dup = d.updated_at >=
  s.updated_at`), which is a resolution rule, not a selection rule. Its population has
  changed meaning, so decision 8's assertions must be re-run after the next `fec_bulk`
  dispatch as well as after the apply.

## Detectors (decision 8 precondition, re-confirmed at manifest time)

| detector | result |
|---|---|
| both ids present AND holding money | **0** |
| merged marker, no live id, holding money | **0** |
| FIX-956 both-ids-DIFFERENT trio | **0** |

---

## Local dry-run (fresh prod clone, 2026-08-10T05:41:41Z restore, 78m58s)

The clone restored to **10,394,462 `financial_relationships` / 3,670,461
`financial_entities` — byte-for-byte the prod row counts** — with
`pipelines_running_at_dump: ""` (nothing in flight during the dump) and 0 tables
missing planner stats. The census **re-derived on the clone reproduces prod exactly**:
122 structural pairs, 117 double-claim + 5 orphan-survivor.

Decision 5 is now enforced **by the script**, not by eye — `verifyOwnSeatInDb` counts
every non-derived attachment and refuses the pair. It rejected exactly the two this
audit had excluded by hand, unprompted:

```
REJECTED Al Green  <-  Alexander Green    stub carries non-money records (6 external_relationships)
REJECTED Austin Scott  <-  James Scott    stub carries non-money records (10 external_relationships)
```

`--own-seat-class=orphan` dry-run, 3 pairs confirmed:

| official | survivor before | stub before | survivor after | stub after |
|---|---:|---:|---:|---:|
| Shontel M. Brown | $4,242,275 | $6,466,355 | **$6,469,605** | $0 |
| Chuck Grassley | $3,348,824 | $6,826,931 | **$6,826,931** | $0 |
| Mike Collins | $3,496,690 | $1,952,030 | **$4,348,705** | $0 |

The result is the **union, not the sum** (decision 8's check): Shontel lands at
$6,469,605, not $4,242,275 + $6,466,355 = $10,708,630.

| conservation | |
|---|---|
| platform donation dollars | $6,924,742,053 → $6,916,054,189 |
| observed drop | $8,687,864 |
| deleted colliding losers | $8,687,864 |
| **difference (must be $0)** | **$0 OK** |
| FR rows moved onto survivors | 7,740 |
| duplicates still holding money | 0 OK |
| `official_donor_totals` diffs outside the manifest | 0 OK |

**The collision tie-break is 100% one-directional and worth knowing before apply:**
2,539 donation collisions + 2 `ie_support`, of which **2,539 resolve dup-fresher, 0
survivor-fresher, 0 ties**. So "keep the fresher row" degenerates to "the stub's copy
always wins" for this manifest — the survivor's own pre-existing amounts are replaced
wholesale wherever a key collides. That is defensible (the stub holds the live CAND_ID,
so its copies are the ones each run actually maintains) but it means the outcome does
not depend on the tie-break discriminating, which matters because FIX-1008 changed what
`updated_at` measures. Re-check after the next `fec_bulk` per §0 P5.

## Prod apply — 2026-08-10 22:20 UTC

Applied with `--own-seat-class=orphan --apply`. The census re-derived live on prod
matched the clone exactly (122 pairs, 117 + 5), and the decision-5 gate rejected Al
Green and Austin Scott unprompted, as it had locally. **Every number came out
byte-identical to the local run:**

| official | before | after |
|---|---:|---:|
| Shontel M. Brown | $4,242,275 | **$6,469,605** |
| Chuck Grassley | $3,348,824 | **$6,826,931** |
| Mike Collins | $3,496,690 | **$4,348,705** |

2,539 donation collisions + 2 `ie_support`, 7,740 rows moved, platform drop
$8,687,864 exactly equal to the deleted colliding losers — **conservation difference
$0**, zero strays, duplicates at $0. Verified post-apply on prod: stubs at $0 with
`merged_fec_candidate_id` set and no live id; each CAND_ID single-claimed by the
ELECTED row; all three damage detectors 0 platform-wide; census B-orphan 5 → 2.

### The tail took prod down — see FIX-1017

`refresh_treemap_individuals_global()` hit its 2400s statement_timeout at chunk 53/64
and correctly aborted phase 2. **Phase 3 then ran anyway** (`runRollups` swallows the
abort; `main` calls `runMvsAndVacuum` unconditionally), pushing six MV refreshes into
an instance that had just declared itself degraded — 25–70× their local timings. Prod
went fully unresponsive: pooler `ECHECKOUTTIMEOUT`, effectively every PostgREST GET
returning Cloudflare 522 for 30+ minutes, cleared by a manual project reset. Filed as
**FIX-1017**; the fix is to propagate the abort and skip phase 3, which costs nothing
because every MV in `MV_REFRESH_FNS` is also refreshed by the 06:00 UTC
`refresh_derived_mvs('daily')` cron.

The committed money was never at risk — a killed `REFRESH MATERIALIZED VIEW
CONCURRENTLY` leaves prior contents intact, and the merge was verified intact again
after the reset (a restart cannot roll back a committed transaction).

Outstanding, all self-healing: two chord MVs (06:00 UTC daily refresh);
`refresh_treemap_individuals_global` (Tue 08:15 UTC cron, resumes from the committed
`chunk_cursor: 53`, advisory lock cleared by the restart); `VACUUM` of the four churned
tables (deferred — ~10k dead tuples on a 10.4M-row table, 0.1%, far under FIX-943's
threshold).

### Found while verifying, unrelated to this merge

Lucy McBath — **not** in this manifest — reconciles at $776,207,400 from
`financial_relationships` against $770,121,900 in `official_donor_totals`. Cause is
**not** the merge: the 12:00 UTC `donor_rollup_refresh` died `partial` at 14:36 with
*"budget exhausted — resumable at recipient 2 of 2889"*, eight hours before this run
started. It completed **2 of 2,889 recipients**, so ~2,887 officials carry stale
`official_donor_totals`. The three officials this merge rebuilt explicitly all
reconcile to the cent. Filed as **FIX-1018**.

## Recommendation

1. **Merge class B minus the two exclusions — 3 pairs**: Shontel M. Brown, Mike Collins,
   Chuck Grassley. ~$15.2M of stub donation money onto the correct elected rows. This is
   FIX-953's scope, and it is what `--own-seat-class=orphan` selects (the default),
   minus the two the gates reject.
2. **Al Green and Austin Scott need a decision, not improvisation.** Both are almost
   certainly the same human (FEC files legal names — *Alexander* Green, *James* Austin
   Scott). The blocker is the stranded `external_relationships` rows, which the merge
   machinery has no step for. Either extend the machinery to re-anchor those rows to the
   survivor (new work, new FIX), or accept stranding them explicitly. Austin Scott
   additionally has zero overlap and a $0 survivor.
3. **Class A (117 pairs / $815M) is a separate action.** It is sound on evidence
   stronger than class B's, but it is 200× FIX-953's stated scope and would visibly
   move very large numbers on 117 sitting members' pages (e.g. Raphael Warnock
   $177.7M → ~$406M). It is really the backlog FIX-933 step 0 deliberately refused.
   It should get its own FIX, its own sign-off, and its own prod window — not a
   silent ride on FIX-953.
