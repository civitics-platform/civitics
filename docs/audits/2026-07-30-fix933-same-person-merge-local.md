# FIX-933 — SAME-PERSON duplicate officials merge — run record — 2026-07-30/31

**PROD LANDED 2026-07-31 02:5x UTC.** Local ran 2026-07-30; prod the following
night. Prod figures and the operational post-mortem are in
"Prod run — what actually happened" at the bottom; everything above it is the
local run that preceded it.

Script: `packages/data/src/scripts/merge-same-person-official-dupes.ts`
(`pnpm --filter @civitics/data data:merge:official-dupes`, dry-run by default).

Branch state before/after is in the two committed audit runs:
`2026-07-29-fec-orphan-attribution.{tsv,md}` is **pre**-merge,
`2026-07-30-fec-orphan-attribution.{tsv,md}` is **post**-merge.

---

## Manifest

| | |
|---|---:|
| SAME-PERSON DUPLICATE re-derived live | 50 |
| dropped — state mismatch (FIX-930 merge-blockers → FIX-934) | 3 |
| **merged** | **47** |
| rejected by the server-side structural re-check | 0 |

All 47 survivors were `tier='elected'` carrying only `congress_gov`; all 47
duplicates were `tier='candidate'` carrying only `fec_candidate_id`. No id
appeared on both sides; no id appeared twice.

Dropped: Scott Wiener (SF) → H8CA11116; Christine Jones (AUS) → H6AR02286;
Connie Chan (SF) → H6CA11268.

## Collisions — resolved to the fresher `updated_at`, never summed

| relationship_type | colliding pairs | dup fresher | survivor fresher | ties | loser dollars |
|---|---:|---:|---:|---:|---:|
| donation | 127,165 | 127,112 | 0 | 53 | $219,544,699 |
| ie_support | 77 | 77 | 0 | 0 | $18,050,171 |
| ie_oppose | 47 | 47 | 0 | 0 | $32,352,017 |

The duplicate's row won every non-tied collision, and ties resolve to the
duplicate (it is the row the current FEC binding refreshes), so every deleted
loser was on the survivor side: 127,289 rows.

## Conservation proof

| | |
|---|---:|
| platform donation dollars on officials, before | $5,023,195,233 |
| platform donation dollars on officials, after | $4,803,650,534 |
| observed drop | $219,544,699 |
| sum of deleted colliding losers | $219,544,699 |
| **difference** | **$0** |
| `official_donor_totals` diffs outside the manifest | **0** |
| manifest pair dollars | $544,885,352 → $325,340,653 |
| FR rows moved onto survivors | 133,637 |
| duplicates still holding money | 0 |

A small number of survivors land slightly BELOW their own pre-merge total
(Thomas P. Tiffany $2,488,607 → $2,483,607). That is correct, not a leak: where
a colliding pair's fresher row carries a lower amount, taking the fresher row
loses the difference — an aggregated donor amount can legitimately fall between
FEC file versions (refund, re-itemization). The conservation identity above is
the invariant that matters and it holds exactly.

## Reference case — Jon Ossoff

`1376dc1e-f697-40b2-8c0f-780f8fe8ea00` (elected, `congress_gov: O000174`) ←
`4719d31a-7db4-4f6f-b933-8442a1fb1f76` (candidate, `fec_candidate_id: S8GA00180`,
`full_name` literally `T Ossoff`).

| | before | after |
|---|---:|---:|
| survivor donation | $14,585,287 (16,006 rows) | **$15,633,810** (16,873 rows) |
| duplicate donation | $14,627,225 (16,646 rows) | $0 |
| survivor ie_support | — | $29,743,006 (134 rows) |
| survivor ie_oppose | $454,772 (3 rows) | $135,429,374 (46 rows) |
| survivor `total_received_cents` | $11,555,275 (stale) | $15,633,810 |

Inside the $14.6M–$16M bound — the union taking the fresher side on each of
15,779 colliding pairs. $29.2M would have meant summing.

Page render (`pnpm dev`, `/officials/1376dc1e-…`, HTTP 200): 1,801 votes on
record, 16,873 donor records, $15.6M itemized donations, +$29.7M support ·
$135.4M oppose. The IE money was previously stranded on an invisible candidate
row. 8 `official_committee_memberships` rows intact in the DB (the official
detail page has no committees section today — pre-existing, unrelated).

## CAND_ID reconciliation (step 0)

Writing `fec_candidate_id` onto the survivor leaves the same id on both rows,
and `loadOfficialsByFecIds` is last-write-wins by ascending uuid — so the
duplicate would reclaim the id and the next FEC run would re-split the money.
The duplicate's claim is retired to `merged_fec_candidate_id`.

| | |
|---|---:|
| pairs reconciled | 83 |
| — of which merged by this run | 47 |
| — of which pre-existing (same state, money already only on the elected row) | 36 |
| pre-existing pairs where the duplicate was **actively winning** the map | 21 |
| CAND_IDs still claimed by two rows (both still hold money → FIX-934/935) | 153 |
| duplicates in the manifest still claiming their CAND_ID (asserted pre-commit) | 0 |

The 36 extra are the identical defect with a provably lossless fix (the
duplicate holds zero `financial_relationships` rows), so the reconciliation
predicate covers them rather than being narrowed to this run's 47. See
[[FIX-941]] for the code-side guard.

**Pre-authorised for prod (Craig, 2026-07-30):** this step is expected to
reconcile MORE pairs than the run's own manifest, and the prod count will
differ from 83. That is the designed behaviour, not a signal to stop — the step
is scoped by the predicate, not by the manifest, because narrowing it would mean
hardcoding uuids and would knowingly leave live re-split hazards in place. The
prod run does not need this judgement re-made. Pairs where the candidate row
still holds money are refused automatically and belong to
[[FIX-934]]/[[FIX-935]].

## Rollups rebuilt

In-transaction (all plain functions — the dry run rolls them back, the apply
lands them atomically with the money move):

- `donor_rollup_rebuild_recipients(94 ids)` — `official_donor_totals`,
  `official_donor_rollup_mv`, `official_small_dollar_rollup`,
  `official_sector_affinity_rollup`, `treemap_individuals_rollup`,
  `official_donor_bracket_totals`
- `rebuild_official_donation_totals()` — `officials.total_received_cents`
- `financial_entity_donation_totals_rebuild` + `donor_party_rollup_rebuild_donors`
  over **105,732 affected donors**, 22 chunks. Deliberately explicit: both
  incremental pg_cron paths key off `financial_relationships.updated_at`, and a
  DELETE bumps nothing, so they would silently skip any donor whose only change
  was a deletion.
- plain `REFRESH` of `official_sector_dollars_mv`, `official_homepage_stats_mv`,
  `homepage_stats_mv`, `chord_industry_flows_mv`,
  `chord_donor_type_party_flows_mv`, `chord_donor_state_party_flows_mv`
  (their wrapper functions all use `CONCURRENTLY`, illegal in a transaction)

Post-commit: `rebuild_financial_entity_ie_totals`, `refresh_group_donor_rollup`,
`rebuild_entity_search_index`, `refresh_treemap_individuals_global`, then the
`CONCURRENTLY` wrappers for the 6 MVs above.

Left stale until their own schedule: `entity_connections` (twice-weekly Sun+Wed
rebuild; the 119,832 money edges pointing at a duplicate were deleted as
provably false, the survivor's own edges are understated but never wrong),
`entity_connection_stats(_mv)`, `browse_facet_counts`.

**The in-transaction plain `REFRESH` is local-only.** A plain (non-concurrent)
`REFRESH MATERIALIZED VIEW` holds an ACCESS EXCLUSIVE lock for its whole
duration — ~90s across these six — which blocks every live reader of the
homepage and chord surfaces, *and it would do that in a DRY RUN too*, so a
read-only rehearsal would have degraded the live site for no benefit. On prod
the step is skipped in-transaction and the `CONCURRENTLY` wrappers in the
post-commit phase are the only path. `refresh_homepage_stats_mv` is not
concurrent internally, so it takes a brief (~1s) exclusive lock — the same one
`refresh-derived-mvs-daily` takes at 06:00 UTC daily.

## Wall clock (local Docker)

Dry run ≈ 7 min; apply ≈ 11 min including post-commit rebuilds. The dominant
steps are the 133,637-row `to_id` update (~107s) and the
119,832-row `entity_connections` delete (~35s).

## Audit guard — absence now requires positive evidence

The audit's reference-case guard had to stop treating "in the expected branch" as
the only pass, because FIX-933 makes Ossoff correctly LEAVE the suspect
population — a bare branch assertion would `exit(2)` forever the moment the
audit's own remediation shipped. But accepting bare absence is the worse failure:
a broken suspect predicate also makes every reference case absent, so the guard
would go green on an audit that found nothing at all and report "0 suspects, all
clear". That matters most for [[FIX-934]], which leans on this same audit to
authorise DELETING rows.

So absence is accepted only with positive evidence of the specific remediation:

| reference | remediation | evidence required |
|---|---|---|
| Jon Ossoff | `merge` (FIX-933) | still HOLDS fec_bulk donation money, now CARRIES the CAND_ID, and **no rival row claims it** — i.e. the survivor holds the merged total |
| Shontel M. Brown | `delete` (FIX-934) | holds NO fec_bulk donation money and claims no CAND_ID |

A broken query cannot manufacture either: it leaves the id unwritten and the
rival row present.

Plus an independent cross-check that fails the whole audit before it writes
anything — `SUSPECT_COUNT_SQL` counts the suspect predicate ALONE and asserts it
equals `SUSPECT_SQL`'s row count. Every CTE downstream of `suspect` is a LEFT
JOIN onto it, so the count must survive the chain; a mismatch means a CTE is
dropping suspects and the report would understate the problem while looking
clean. `exit(3)` with an explicit "do not act on this report". ~6s, so it always
runs.

## Prod run — what to check

1. Re-derive everything. Every figure here is clone-measured; the audit's branch
   boundary is DERIVED from the data and moved from 0.2689 to 0.2802 between the
   pre- and post-merge runs on this clone alone.
2. Prod `officials` is polluted (~1,952 candidates mis-linked) and prod UUIDs
   differ from local, so the manifest size will differ. The script re-derives and
   re-gates; it does not need editing.
3. Do NOT run during the nightly window (05:50–08:00 UTC) — delete-then-rewrite
   mid-flight makes reads wildly wrong. Check `data_sync_log` for
   `status='running'` first.
4. `max_parallel_workers_per_gather = 0` is applied on local only; prod keeps its
   parallel workers.
5. Expect the run to be slower on prod (256MB `shared_buffers`, ~54% cache hit).
   The script sets `statement_timeout = 0` on its own direct-pg connection.
6. Invoke with `pnpm --filter @civitics/data data:merge:official-dupes:prod`
   (adds `--allow-prod`), dry-run first.
7. **The audit is the verification step and it is at risk from this merge's own
   dead tuples.** `SUSPECT_SQL` carries a 600s `statement_timeout` and, on local,
   it went from completing in ~8 min to blowing that timeout immediately after
   the merge left ~260k dead tuples in `financial_relationships` and ~120k in
   `entity_connections`. The script now ends with `VACUUM (ANALYZE)` on
   `financial_relationships`, `entity_connections` and `officials` for exactly
   this reason — same class as [[FIX-884]], where a stranded autovacuum on
   `entity_connections` turned an index-only plan into 34,534 heap fetches. Do
   not "fix" a post-merge audit timeout by raising the timeout; confirm the
   vacuum ran (`pg_stat_user_tables.last_vacuum`) first.

---

# Prod run — what actually happened (2026-07-30/31)

Landed. Two aborted attempts preceded it; both are recorded here because the
reasons are reusable, not incidental.

## Result

| | prod | local |
|---|---:|---:|
| manifest pairs | 47 | 47 |
| merge-blockers dropped | 3 | 3 |
| donation collisions | 127,165 | 127,165 |
| ties (→ keep duplicate) | 53 | 53 |
| deleted colliding losers | $219,544,699 | $219,544,699 |
| FR rows moved | 133,840 | 133,637 |
| platform before → after | $5,052,387,823 → $4,832,843,124 | $5,023,195,233 → $4,803,650,534 |
| **conservation difference** | **$0** | **$0** |
| odt diffs outside manifest | 0 | 0 |
| affected donors | 105,778 | 105,732 |

Reference case Jon Ossoff: elected row now
`{congress_gov: O000174, fec_candidate_id: S8GA00180}` holding **$15,645,810**
donations + $29,743,006 `ie_support` + $135,429,374 `ie_oppose`; the duplicate
is reduced to `{merged_fec_candidate_id: S8GA00180}` with **zero**
financial_relationships rows. Inside the $14.6M–$16M bound.

Post-merge prod audit (exit 0): SAME-PERSON **50 → 3** ($3,202,261, the excluded
blockers), CROSS-PERSON **60 unchanged** ($113,233,132), UNIQUE HOLDER **92
unchanged** ($16,613,717). Both reference cases pass; the independent
`SUSPECT_COUNT_SQL` cross-check agreed.

## Attempt 1 — aborted: one transaction exhausted Pro Small's burst I/O

The original shape held the money move AND every rollup in a single
transaction. On prod that was ~2 hours of sustained write I/O in one
transaction, and it exhausted the disk burst credits: homepage **18.7s**, a
`count(*)` on a 31k-row table past **600s**, and
`financial_entity_donation_totals_rebuild` at **66+ minutes** against the 10 it
took in rehearsal.

Cancelled server-side. **Killing the client is not enough** — Postgres does not
notice a dropped connection mid-query, so the backend kept running until
`pg_cancel_backend`. Rollback was clean and prod recovered immediately
(homepage 18.7s → 0.41s, `count(*)` >600s → 111ms), which is what identified the
run as the cause rather than a victim.

Fix: phase split. Atomicity was never the reason the rollups were in there —
the money move is what must be all-or-nothing and it is ~12 minutes. Phase 2 now
runs the rollups after COMMIT with
`financial_entity_donation_totals_rebuild` **chunked at 5,000 donors**. That step
went from 66+ min unchunked to **22 chunks averaging ~33s**, and the homepage
held at 0.39s throughout attempt 2.

## Attempt 2 — completed, then the MV tail had to be abandoned

Phases 1 and 2 landed. The six MV refreshes did not: every one degraded the
site. `refresh_homepage_stats_mv()` — **0.7s on local** — ran **22 minutes**
against an otherwise-idle prod and took the homepage to 18.5s;
`refresh_chord_industry_flows_mv()` did the same immediately after.

They were abandoned deliberately, because `refresh_derived_mvs('daily')` at
06:00 UTC refreshes **all four** MV families in the list (sector dollars,
official homepage stats, homepage stats, chord). Deferring them costs nothing.

**The budget guard did not fire, and that was a design bug.** `budgeted()`
compared elapsed time only *after* the query returned, so it could not catch the
one case that matters — a step that never returns. It now sets
`statement_timeout` per step so Postgres owns the ceiling, and translates
`57014` into a named `BudgetExceeded`. Deliberately NOT applied to the vacuums:
a vacuum killed by a timeout is worse than a slow one.

## VACUUM — the standing win

Run separately via `--vacuum-only` once prod was quiet.

| table | dead before | all-visible before | after | duration |
|---|---:|---:|---:|---:|
| `financial_relationships` | 399,168 | **64.7%** | 0 / 100% | 793.9s |
| `entity_connections` | 120,375 | 78.3% | 0 / 100% | 600.8s |
| `officials` | 0 | 100% | 0 / 100% | 9.8s |

`financial_relationships` had **never been vacuumed**. `/officials` went from
**6.3s → 0.20s** on the back of the `entity_connections` vacuum specifically.
This is a prod-wide read-performance drag that predates this PR — [[FIX-943]]
with measured before/after.

## Resume granularity

Three levels, each keyed off durable committed state rather than in-memory
progress, because this run was interrupted by a VS Code crash AND a machine
reboot and lost nothing either time:

- `--rollups-only` — re-derives the manifest from the merged state (an elected
  row carrying `congress_gov` + `fec_candidate_id` opposite a candidate row
  holding that id in `merged_fec_candidate_id`), then runs all of phase 2.
- `--mvs-only` — phase 2 tail, when the expensive rebuilds already committed.
- `--vacuum-only` — the only step with no other owner on the schedule.

## Operational notes for the next prod data run

1. **The 02:00 nightly actually starts 05:00–06:00 UTC** — GHA queue lag. Read
   the observed start, not the cron. A quiet DB plus no in-progress run does not
   prove a scheduled job will not start mid-operation; today's dispatched at
   02:00 and started 05:09, an hour after a clean all-clear check.
2. **GHA cancellation is not immediate.** The cancelled nightly still completed
   `congress_officials`, `congress_votes` and `openstates_bulk_people` before the
   SIGTERM landed, wrote a `nightly_killed`/failed row, and orphaned `tag_rules`
   mid-phase.
3. **Burst I/O credits refill over hours, not minutes.** After a long run,
   expect everything to be slow even once the DB is idle — a 0.7s view took 22
   minutes in that state. Do not interpret it as contention and push on.
4. Watch the live site, not just `pg_stat_activity`. Homepage latency was the
   signal that identified both aborts.
