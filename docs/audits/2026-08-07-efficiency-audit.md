# Site-wide efficiency audit — hunting the FEC/rollup arc's defect classes everywhere else

**Date:** 2026-08-07 · **Standard:** `docs/ENGINEERING_PLAYBOOK.md` · **Discipline:** measurement-only,
the FIX-930 shape. **This audit fixed nothing.** Every surviving finding is filed as a FIX bullet;
this document is the remediation queue.

**Why now:** the eight classes below were each found *reactively* during FIX-929 → FIX-974 — a page
was wrong, a job was dead, a window ran long. This pass hunts the same classes *proactively*, before
PR 3 multiplies the data and before launch multiplies the traffic.

**The headline result is not a finding — it is a hit rate.** 49 findings were produced by
mechanism-complete enumeration; adversarial verification killed **28 of them (57%)**. That
number is the most useful thing this audit learned, and §*Refuted* is the most useful section.

---

## Measurement conditions — read before quoting any number

| | |
|---|---|
| Instance | Supabase Pro Small, PG **17.6**, `shared_buffers` = **256 MB** (32,768 × 8 kB) |
| Prod reads | read-only via `scripts/db-query.mjs --prod`. No writes, no data operations, no schedule changes |
| Window | headline measurements 04:29 – 05:05 UTC, **before** the 05:50 nightly and clear of the 09:00/12:00 donor-rollup firings. Verification-pass reads ran later the same day |
| Box state | **NOT idle.** An `INSERT INTO financial_relationships` ran throughout the headline window. The heavy `EXPLAIN`s are therefore *live-traffic* measurements — stated per playbook **B3**: measure a real unit of work with a known cache state, or say which one you measured |
| Excluded by scope | FIX-902 (unbounded `.in()` fan-out), FIX-969's seven named over-ceiling jobs, FIX-935/936/937 (name matching), FIX-953, FIX-967 |

Two numbers moved *while this document was being written*; both are recorded with timestamps rather
than averaged (playbook **E3**).

---

## How the population was covered

Per the audit's first design rule, every class was enumerated **by mechanism**, not by known sites.

| Class | Enumeration mechanism | Population | Findings | Survived |
|---|---|---|---|---|
| 1 — per-entity loops (SQL) | every `public` plpgsql body from live `pg_proc` containing `LOOP` | **22** of 154 | 8 | 3 |
| 1 — per-entity loops (TS) | brace/string/comment-aware matcher over 645 files → 3,159 loop constructs → 264 with a DB call → interprocedural closure (**+56 sites** literal grep cannot see) | **230** | 7 | 3 |
| 2 — heap-forced reads | every `public` table > 200 MB × `relallvisible/relpages` × `vacuum_count` × `pg_stat_user_indexes`, then cold `EXPLAIN (ANALYZE, BUFFERS)` on the top 3 covering indexes | **18** tables, 40 indexes | 1 | 1 |
| 3 — stale quanta | live `pg_proc` bodies + `proconfig` for every CONSTANT / chunk / budget / timeout, cross-checked against current `reltuples` | **363** constant sites, 80 bulk-write sites | 7 | 3 |
| 4 — jobs near the ceiling | all `cron.job` joined to `cron.job_run_details` **by jobname** (rule D3) | **21** jobs, 185 runs | 2 | 1 |
| 5 — lying timestamps | live bodies matching `NOW()` **and** `COMMIT`; plus a reader-census of every `*_at` progress column | **153** routines, 20 columns | 6 | 2 |
| 6 — freshness-only monitoring | union of three sweeps: `pg_proc` `check_*`/`detect_*`, repo grep, `.github/workflows` schedules | **7** detectors | 7 | 5 |
| 7 — equal-by-coincidence | every live `refresh_|rebuild_|backfill_|…` body, each typed predicate vs its column's actual CHECK domain | **88** routines, 274 predicates | 6 | 2 |
| 8 — status-as-liveness | repo-wide grep for `'running'` / `data_sync_log` readers / advisory locks, across code, SQL, docs, `.github` | **60** sites | 7 | 2 |

**49 findings, 21 survived, 28 refuted.** 47 came from parallel per-class enumeration agents and were
put through 1:1 adversarial verification (**19 survived**); 2 — classes 2 and 3's `financial_entities`
findings, FIX-975 and FIX-976 — were measured directly during the orchestration pass and re-derived
against an independent source rather than agent-verified. Class 4's second finding
(`contract-flow-rollups-refresh` at 7.2× week-over-week) was **downgraded on verification**: 3 retained
runs is too thin a trail to call a trend, so it is recorded in §*Class 4* rather than filed.

**Honest zeros are results.** Class 2 produced a single finding from 18 tables because 15 of the 18 are
genuinely healthy — and that healthy majority is exactly what made the defect legible (see below).
Class 7's 82 clean routines are mostly MV-refresh one-liners with no predicate to be wrong about.

---

## Ranked surviving findings

| # | Sev | Class | Site | Measured | FIX |
|---|---|---|---|---|---|
| 1 | 🔴 | 2 | `financial_entities` — no VACUUM owner anywhere | `relallvisible` 145,898 → **112,162 in 13 min**; 53.7% all-visible; `vacuum_count`=0; covering index **47.8% Heap Fetches** | **FIX-975** |
| 2 | 🔴 | 6 | `canary-check.ts:35-40` — `ROLLUP_PIPELINES` has **length 1** | 4 unwatched pipelines 1.1–2.4 cycles behind; FE totals **403.8 h**, graph **212.8 h**; 29 of 36 derived relations unwatched | **FIX-977** |
| 3 | 🔴 | 6 | No detector measures a **rate** | 0 of 7; rate substrate has **zero readers** repo-wide; derivable for 11 of 12 pipelines, computed for 0 | **FIX-978** |
| 4 | 🟠 | 3 | `financial_entities` walks sized by stale comments | "~78k" vs **226,640** (2.9×); "~30k orgs" vs 226,640 (7.6×); 611 s + 2,997 s measured | **FIX-976** |
| 5 | 🟠 | 5 | `data_sync_log` terminal rows stamped at txn entry | **8 of 46** pipelines report p50=p95=max=**0 ms**; a 7,125.6 s run records as 0 | **FIX-979** |
| 6 | 🟠 | 6 | Nothing watches the canary | **zero rows on 2026-08-06** — the day with the most incidents; 6 of 7 detectors run only inside it | **FIX-980** |
| 7 | 🟠 | 5 | `refresh_treemap_individuals_global` — FIX-972's untouched twin | `NOW()` in a per-chunk COMMIT loop; lie bounded at **59 s** today, one chunk of 6 h at blowout | **FIX-981** |
| 8 | 🟠 | 1/3/4 | `entity-connection-stats-rebuild` — no budget, no cursor, no partial | p95 **80.1%** of ceiling, max **86.0%**; bimodal **101 s ↔ 18,568 s (184×)**; 0 failures so FIX-969 cannot see it | **FIX-982** |
| 9 | 🟠 | 5 | 8 watermark reads keyed off `NOW()`-stamped `updated_at` | a txn beginning before and committing after a watermark read is excluded **permanently** | **FIX-983** |
| 10 | 🟠 | 1/3 | OFFSET pagination across all 68 bulk-read sites, 7 duplicated helpers | **175×** row-visit amplification on the largest walk; `proposals` planner cost **174×** at the last page, 3 recorded prod timeouts | **FIX-984** |
| 11 | 🟠 | 7 | 9 unscoped DELETEs rebuild from empty sources; a predicate the CHECK forbids | lobbying arm deletes **10,431** live edges and reinserts **0**; `'organization'` matches nothing, 37 entities render $0 | **FIX-985** |
| 12 | 🟠 | 1 | `homepage_stats_mv` refreshed non-CONCURRENTLY | only MV of 13 without a unique index; **ACCESS EXCLUSIVE** on a homepage-read MV; the exact object of the 0.7 s-local / **22 min-prod** C4 receipt | **FIX-986** |
| 13 | 🟡 | 1 | `refresh_agency_staffing_rollup` has no dirty set | re-aggregates **3,822,690 entries / 575 MB** weekly to write **128 rows / 72 kB**; worst run 19m43s | **FIX-987** |
| 14 | 🟡 | 1 | Nominee lookup on an unindexed jsonb expression | `officials` has 15 indexes, none on `source_ids`; **8.2 s per weekly run** (corrected down ~10× from the finder's claim) | **FIX-988** |
| 15 | 🟡 | 8 | 3 operator probes read `status='running'` as liveness | one gates a **prod close-out**; resident orphans today **0**, so filed as latent, not active | **FIX-989** |

**15 FIX bullets from 21 surviving findings** (several pairs were folded where the fix is one sweep).
Companion data: `2026-08-07-efficiency-audit.tsv` — 49 rows, every confirmed finding carrying its FIX id.

---

## Class 2 — Heap-forced read shapes near covering indexes

### The correlation that names the defect

Sorting the 18 tables > 200 MB by *whether any script, cron job or procedure ever issues a manual
`VACUUM`* separates them completely:

| table | manual `vacuum_count` | % all-visible | vacuum-tail owner |
|---|---|---|---|
| `entity_connections` | 6 | **98.4%** | `rebuild-entity-connections.ts`, `ec-vacuum-analyze` cron, merge scripts |
| `financial_relationships` | 5 | **96.8%** | `merge-same-person-official-dupes.ts` `CHURNED_TABLES`, `fix346-vacuum.ts` |
| `official_donor_rollup_mv` | 1 | 100.0% | `donor-rollup-bulk.ts` `REWRITTEN_ARMS` |
| `treemap_individuals_rollup` | 1 | 100.0% | `donor-rollup-bulk.ts` `REWRITTEN_ARMS` |
| **`financial_entities`** | **0** | **53.7%** | **none** |
| **`donor_party_rollup_mv`** | **0** | **74.9%** | **none** |
| **`external_relationships_review_queue`** | **0** | **65.0%** | **none** (`autovacuum_count` also 0) |

`entity_tags` is the one clean exception — 97.1% at `vacuum_count` 0 — because it is DELETE-dominated
(14,785,744 deletes) and clears its trigger constantly (61 autovacuums). **That exception is what
makes the rest a mechanism rather than a coincidence.**

FIX-943 landed the standing convention *"any script that bulk-rewrites a table ends by vacuuming what
it rewrote"* and named `financial_entities` as **"the one that matters most"**. Nobody was assigned to
it. → **FIX-975**

### The decisive measurement

```
Index Only Scan using financial_entities_nonindividual_id  (actual rows=226640)
  Heap Fetches: 108419                 <-- 47.8% of rows forced to the heap
  Buffers: shared hit=205784 read=50837 dirtied=3866 written=22008
Execution Time: 47042.959 ms
```

The index is `btree(id) INCLUDE (display_name, entity_type) WHERE entity_type <> 'individual'` — 33 MB,
~4,224 pages. Returning 226,640 rows touched **256,621 buffers, 61× the index's own size**, all excess
being heap. Against the tables that do have owners, same box, same night:

| index | rows | Heap Fetches | rate |
|---|---|---|---|
| `financial_entities_nonindividual_id` | 226,640 | 108,419 | **47.8%** |
| `entity_connections_donation_to_official_idx` | 2,448,772 | 647,775 | 26.5% |
| `financial_relationships_donor_rollup_idx` (FIX-974's path) | 6,457,040 | 307,609 | **4.8%** |

**A 10× spread in heap-fetch rate, tracking vacuum ownership exactly.**

> **Methodological note worth keeping.** `relallvisible` is a *lagging* proxy — refreshed only by
> `VACUUM`, so a table dirtied since its last vacuum reads *better* than it is. `entity_connections`
> shows 98.4% all-visible yet 26.5% real heap fetches. **`Heap Fetches` in `EXPLAIN` is ground truth;
> `relallvisible` is the early warning.** Playbook B1 says watch both — this pass confirms they can
> disagree widely, and in which direction.

---

## Class 4 — Jobs near the ceiling (ADDITIVE to FIX-969 only)

Six of FIX-969's seven reproduce exactly; the seventh is the retired jobid 1. Everything here is
outside that set.

### `entity-connection-stats-rebuild` — 184× bimodal, zero failures, zero watchers

p95 = **17,296 s = 80.1%** of the 6 h ceiling; max **18,568 s = 86.0%**. It has **never failed**, which
is exactly why FIX-969 — which enumerated by *failure* — cannot see it.

| date | day | secs | % of 6 h |
|---|---|---|---|
| 07-13 | Mon | 7,112 | 32.9 |
| 07-15 | Wed | 136 | 0.6 |
| 07-20 | Mon | 128 | 0.6 |
| 07-22 | Wed | 132 | 0.6 |
| 07-27 | Mon | **18,568** | **86.0** |
| 07-29 | Wed | 7,095 | 32.8 |
| 08-03 | Mon | **14,933** | 69.1 |
| 08-05 | Wed | 101 | 0.5 |

**Bimodal, not trending** — 101–136 s or 7,095–18,568 s, a **184× spread**, no rising curve. Monday mean
10,185 s vs Wednesday mean 1,866 s (**5.5×**). It fires at 11:00, three hours after the
`rebuild-ec-incremental*` jobs at 08:00 that FIX-969 shows dying ~14:00 on the ceiling — so on a blowout
day it runs *concurrently with a six-hour squatter*. The mechanism differs from FIX-969's: those jobs
are starved *before they start* (the ~10 s libpq window → `job startup timeout`); this one **starts fine
and runs 5.5× slower**. Contention, not starvation.

Two other passes independently found the structural half: the live body has **no budget guard, no
reservation, no cursor and no `partial` status**, and its dominant cost — the stage build over
`2 × 5,059,971` rows — is a **single unchunked statement**, so the 6 h `statement_timeout` is its only
stop and a blowout discards everything.

### Honest correction to the class-4 premise

The audit brief defines the trending set as *"any job whose p95 exceeds ~50% of its ceiling"*. **That
test misfires here.** `entity-connection-stats-rebuild` has p95 = 80.1% purely because half its runs are
slow — a *bimodality artifact*, not a trend. Conversely `refresh-derived-mvs-daily` has p95 = 7.6% with a
max of **58.1%** (12,547 s), and `rule-taggers-daily` p95 = 5.3% with max **64.9%** (14,028 s) — both pass
a p95 test while carrying single runs two-thirds of the way to the ceiling. **max/p95 ratio is the better
detector than p95 alone**, and neither substitutes for reading the trail. Playbook **E4** —
decomposition, not magnitude — applied to the audit's own instrument.

`contract-flow-rollups-refresh` rose 986 s → **7,126 s in one week** and then had its 08-06 firing
dropped entirely. Its finding was **downgraded on verification** (3 retained runs is too thin a trail
to call a trend), and it is recorded here rather than filed separately.

---

## Class 6 — Freshness-only monitoring

Population 7 scheduled detectors; **7 findings, i.e. every detector carries at least one D4 signature**,
5 of which survived. The one best-in-class detector is `check_sector_affinity_tag_staleness` — the only
*content-level* rather than *age-level* check in the system, covering exactly 1 relation.

Headlines → **FIX-977**, **FIX-978**, **FIX-980**. Staleness re-derived independently:

| pipeline | last complete | hours behind | cadence | watched? |
|---|---|---|---|---|
| `financial_entity_totals_refresh` | 2026-07-21 | **403.8 h** | 168 h | ✗ |
| `donor_party_rollup_refresh` | 2026-07-28 | 236.1 h | 168 h | ✗ |
| `entity_connections_rebuild` | 2026-07-29 | 212.8 h | 84 h | ✗ |
| `contract_flow_rollups_rebuild` | 2026-07-30 | 182.8 h | 168 h | ✗ |
| `donor_rollup_refresh` | 2026-08-02 | 115.8 h | 24 h | **✓** |

**The only watched pipeline is the freshest of the five.**

---

## Refuted — reported, not hidden

Verification killed **28 of 49 findings (57%)** — 21 survived. Recording them is the point (playbook E3), and
**the failure mode was strikingly consistent: the finders measured real mechanisms and overstated their
REACH.** A pattern was genuinely present at every site. What did not survive was *"and therefore it
costs X"*.

| finding | why it died |
|---|---|
| `check_cron_job_health` `missing_daily` covers 5 of 21 jobs | Arithmetic re-derives exactly, but the bounded event class is **empty** — zero row-less firings in 185 runs / 21 jobs / 40 days — and every mechanism producing one drops *all* jobs, so the 5 daily jobs are a complete canary in the 26 h window. Removing the `*` predicate would emit **16 false escalations daily**, verbatim what D4 forbids. **The predicate is what makes the escalating branch safe.** |
| platform-snapshot has no escalation path | **Measurably false** — `platform_alert_state` shows a `critical` Resend escalation that fired 2026-08-06. The "24× miss" quoted a superseded constant (`SNAPSHOT_STALE_MS` = 4 h per FIX-327, which measured and accepted this exact GHA best-effort behaviour). |
| 5 of 21 pg_cron jobs write no `running` start-row | The proof was a **null test** that cannot distinguish the two designs (start-row writers INSERT NULL then UPDATE the same row). And playbook **D2 inverts the claim**: a `running` row is *not* liveness, so its absence is not a defect. |
| `donor_rollup_rebuild_bulk` mixes `now()`/`clock_timestamp()` | Gap is 11.3 s not 59 s, and the failure mode **cannot occur** — the sites share one transaction, so no observer sees the cursor stamp without that chunk's arm rows. |
| 10 of 11 chunked writers skip failed chunks (A4.4) | A4.4's harm is *silent* corruption. **Neither limb holds:** all 8 write `status='failed'` plus the failure list, and **5 of 5** watermark/signature owners refuse to advance on non-empty `v_failures` (prosrc 267 / 545 / 369 / 563 / 87). |
| 6 routines chunk by entity list (A2) | **Four are one-shot backfills already superseded** by FIX-974's `donor_rollup_rebuild_bulk` (run on prod 2026-08-07); they are on no cron job. Of the six, **1 is scheduled** — agency-staffing, keyed on `from_id` over **129 agencies**, not 6,793 `to_id` descents. |
| Agency-side twin of the FIX-974 invariant is violated | The 54 rows are real, but the two families are **opposite sides of the ledger** — `refresh_spending_totals` groups by `to_id` (received), the agency rollups by `from_id` (spent). B1 does not apply. Grant-only, **0.0013%** of recipient-side grant dollars. |
| FIX-974's assert isn't called by the nightly path | **Correct by design.** The guard exists because the bulk regime reads a *partial* index predicated on `from_type='financial_entity'`. The per-recipient arm 2 carries no `from_type` predicate, so it cannot use that index and already reads every `from_type`. Nothing for the guard to protect there. |
| `official_donor_totals` leaves **$84,279,762** unbucketed | **The dollar figure re-derives**, but the harm does not. `rules.ts` writes `pac_percentage` only inside `if (pacPct > 0.5)`, so the 151 fully-unbucketed officials emit **no tag at all** — "an official publishes 0% PAC" is impossible. The proposed 3-way→2-way change would *overstate* PAC share by dropping corporate/union/party money from the denominator, and the LEFT JOIN is documented as deliberate (`20260529130000_…:35-40`). No app-side reader of `pac_cents` exists. |
| `enrichment_queue` has no lease expiry | **Already filed and closed as FIX-924**, which names these exact 44 rows and explicitly defers the reclaim cron. Nothing *scheduled* ever claims. **Zero new stranded rows in 100 days.** |
| `pipeline_state.updated_at` / 11 freshness columns unread | E7 requires a stamp that *was read as progress and was wrong*; the census establishes only that they are unread — the other limb. |
| Pathfinder `v_cap` cannot fire | Cost model wrong — each BFS level is **one set-based `INSERT … SELECT DISTINCT ON`**, not a descent per visited node. |
| `pg_statistic_ext` empty; `purge_abuse_events`; `startSync()` swallow; `ai-classifier` paging | Each died on scale, on an inverted rule, or on a table that is currently empty. |

Two "refutations" were **duplicate-detections, not defect-detections** — the verifiers correctly flagged
`pipeline_runtime_stats_mv` and the three `small_dollar_rebuild_officials` sites as already filed by this
same audit (FIX-979, FIX-981), explicitly noting *"the mechanism re-derives clean; this is a duplicate,
not a bad finding."* Both bullets stand.

---

## What the walk surfaced that the class list did not name

1. **A vacuum-ownership *class*, not a vacuum bug.** FIX-943 tuned autovacuum per table; this audit found
   that the thing which actually predicts visibility-map health is whether *some script owns a manual
   vacuum tail*. Tuning narrows the window; ownership closes it. That is a stronger and more actionable
   rule than the one currently in `CLAUDE.md`, and it is now FIX-975.
2. **`relallvisible` and `Heap Fetches` can disagree by 20+ points**, in the direction that flatters the
   table. Any future use of the former as a health metric needs that caveat.
3. **Duplicated helper layers are how a defect class propagates.** Seven independently-written paging
   helpers, all OFFSET, is why the pattern is at 68 sites rather than 1.
4. **A high finder-to-verifier kill rate is itself a process finding.** See below.

## What this says about how to run the next audit

The enumeration was sound — mechanism-complete, with populations stated and honest zeros. The
**inference from enumeration to cost was not.** Two thirds of the findings named a real pattern and
then attached a consequence that a single independent check dissolved: the path was a one-shot
backfill, or ran weekly not nightly, or was already guarded, or was already filed and closed.

The cheap, decisive controls — all of which killed at least one finding here — are:

- **Is this path actually scheduled?** (`cron.job` + `data_sync_log` cadence, not the file's comment.)
- **How often does it really run?** (`pg_stat_statements` calls ÷ pages, against `stats_reset`.)
- **Does a guard downstream already mitigate it?** (Read the whole body, not the matching line.)
- **Is it already in `FIXES.md`?** (Including *closed*, with the deferral stated.)
- **Does the cited playbook rule actually apply — or invert?** (D2 inverted one; E7 failed another.)

Running those five before filing would have removed most of the noise at a fraction of the verification
cost. **That is the reusable lesson from this audit, and it belongs in the playbook.**
