# Site-wide efficiency audit — hunting the FEC/rollup arc's defect classes everywhere else

**Date:** 2026-08-07 · **Standard:** `docs/ENGINEERING_PLAYBOOK.md` · **Discipline:** measurement-only,
the FIX-930 shape. **This audit fixed nothing.** Every surviving finding is filed as a FIX bullet;
this document is the remediation queue.

**Why now:** the eight classes below were each found *reactively* during FIX-929 → FIX-974 — a page
was wrong, a job was dead, a window ran long. This pass hunts the same classes *proactively*, before
PR 3 multiplies the data and before launch multiplies the traffic.

---

## Measurement conditions — read before quoting any number

| | |
|---|---|
| Instance | Supabase Pro Small, PG **17.6**, `shared_buffers` = **256 MB** (32,768 × 8 kB) |
| Prod reads | read-only via `scripts/db-query.mjs --prod`. No writes, no data operations, no schedule changes |
| Window | 04:29 – 05:05 UTC, **before** the 05:50 nightly and clear of the 09:00/12:00 donor-rollup firings |
| Box state | **NOT idle.** An `INSERT INTO financial_relationships` ran throughout. The heavy `EXPLAIN`s below are *live-traffic* measurements — stated explicitly per playbook **B3**: measure a real unit of work with a known cache state, or say which one you measured |
| Excluded by scope | FIX-902 (unbounded `.in()` fan-out), FIX-969's seven named over-ceiling jobs, FIX-935/936/937 (name matching), FIX-953, FIX-967 |

Two numbers moved *while this document was being written*; both are recorded with timestamps rather
than averaged (playbook **E3**).

---

## How the population was covered

Per the prompt's first design rule, every class was enumerated **by mechanism**, not by known sites.
Populations walked:

| Class | Enumeration mechanism | Population |
|---|---|---|
| 1 — per-entity loops (SQL) | every `public` plpgsql body from live `pg_proc` containing `LOOP` | **22** of 154 plpgsql functions |
| 1 — per-entity loops (TS) | brace/string/comment-aware matcher over 645 files → 3,159 loop constructs → 264 with a DB call in body → interprocedural closure (+56 sites literal grep cannot see) | **230** (162 per-entity loops, 43 touching a >500k-row table) |
| 2 — heap-forced reads | every `public` table > 200 MB × `relallvisible/relpages` × `vacuum_count` × `pg_stat_user_indexes`, then cold `EXPLAIN (ANALYZE, BUFFERS)` on the top 3 covering indexes | **18** tables, 40 indexes > 50 MB |
| 3 — stale quanta | live `pg_proc` bodies + `proconfig` for every CONSTANT / chunk / budget / timeout, cross-checked against current `pg_class.reltuples` | **363** constant sites, 80 bulk-write sites |
| 4 — jobs near the ceiling | all `cron.job` joined to `cron.job_run_details` **by jobname** (rule D3), p95/max as a fraction of the 6 h ceiling | **21** jobs, 185 retained runs |
| 5 — lying timestamps | live bodies where `prosrc` matches `NOW()` **and** `COMMIT`; plus a reader-census of every `*_at` progress column | **153** routines, 20 progress columns |
| 6 — freshness-only monitoring | union of three sweeps: `pg_proc` `check_*`/`detect_*`, repo grep for canary/health/freshness, `.github/workflows` schedules | **7** scheduled detectors |
| 7 — equal-by-coincidence | every live `refresh_|rebuild_|backfill_|reconcile_|promote_|merge_` body, each typed predicate compared against its column's actual CHECK domain | **88** routines, 274 predicate sites |
| 8 — status-as-liveness | repo-wide grep for `'running'` / `data_sync_log` readers / advisory locks, across code, SQL, docs and `.github` | **60** sites |

**47 findings** were produced. Every one was then sent to an adversarial verifier whose default was
`refuted=true`, instructed to re-derive independently (playbook E3). **The kill rate was material and
is reported rather than hidden** — see *Refuted* below.

---

## Ranked surviving findings

| # | Sev | Class | Site | Measured | FIX |
|---|---|---|---|---|---|
| 1 | 🔴 | 2 | `financial_entities` — no VACUUM owner anywhere | `relallvisible` 145,898 → **112,162 in 13 min**; 53.7% all-visible; `vacuum_count`=0; covering index **47.8% Heap Fetches** | **FIX-975** |
| 2 | 🔴 | 6 | `canary-check.ts:35-40` — `ROLLUP_PIPELINES` has **length 1** | 4 unwatched pipelines 1.1–2.4 cycles behind; FE totals **403.8 h**, graph **212.8 h**; 29 of 36 derived relations unwatched | **FIX-977** |
| 3 | 🔴 | 6 | No detector measures a **rate** | 0 of 7; rate substrate has **zero readers** repo-wide; derivable for 11 of 12 pipelines, computed for 0 | **FIX-978** |
| 4 | 🟠 | 3 | `financial_entities` walks sized by stale comments | "~78k" vs **226,640** (2.9×); "~30k orgs" vs 226,640 (7.6×); 611 s + 2,997 s measured | **FIX-976** |
| 5 | 🟠 | 5/8 | `data_sync_log` terminal rows stamped at txn entry | **8 of 46** pipelines report p50=p95=max=**0 ms**; a 7,125.6 s run records as 0 | **FIX-979** |
| 6 | 🟠 | 6 | Nothing watches the canary | **zero rows on 2026-08-06** — the day with the most incidents; 6 of 7 detectors run only inside it | **FIX-980** |
| 7 | 🟠 | 5 | `refresh_treemap_individuals_global` — FIX-972's untouched twin | `NOW()` in a per-chunk COMMIT loop; lie bounded at **59 s** today, one chunk of 6 h at blowout | **FIX-981** |

*Findings 8+ are appended after the second verification pass completes; see the per-class sections.*

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
(14,785,744 deletes) and clears its trigger constantly (61 autovacuums). **That exception is what makes
the rest a mechanism rather than a coincidence.**

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
day it runs *concurrently with a six-hour squatter*. Note the mechanism differs from FIX-969's: those
jobs are starved *before they start* (the ~10 s libpq window → `job startup timeout`); this one **starts
fine and runs 5.5× slower**. Contention, not starvation.

The class-1 and class-3 passes independently found the structural half: the live body has **no budget
guard, no reservation, no cursor and no `partial` status**, and its dominant cost — the stage build over
`2 × 5,059,971` rows — is a **single unchunked statement**, so the 6 h `statement_timeout` is its only
stop and a blowout discards everything.

### `contract-flow-rollups-refresh` — 7.2× in one week

986 s (07-23) → **7,126 s (07-30)** → firing dropped 08-06 (`job startup timeout`). Unlike the above this
*is* a rising curve, but on 3 retained runs, so it is filed with its trail depth stated.

### Honest correction to the class-4 premise

The prompt defines the trending set as *"any job whose p95 exceeds ~50% of its ceiling"*. **That test
misfires here.** `entity-connection-stats-rebuild` has p95 = 80.1% purely because half its runs are slow
— a *bimodality artifact*, not a trend. Conversely `refresh-derived-mvs-daily` has p95 = 7.6% with a max
of **58.1%** (12,547 s), and `rule-taggers-daily` p95 = 5.3% with max **64.9%** (14,028 s) — both pass a
p95 test while carrying single runs two-thirds of the way to the ceiling. **max/p95 ratio is the better
detector than p95 alone**, and neither substitutes for reading the trail. Playbook **E4** —
decomposition, not magnitude — applied to the audit's own instrument.

---

## Class 6 — Freshness-only monitoring

Population 7 scheduled detectors; **7 findings, i.e. every detector carries at least one D4 signature.**
The one best-in-class detector is `check_sector_affinity_tag_staleness`, which compares a live content
signature to a stored one — it is the only *content-level* rather than *age-level* check in the system,
and it covers exactly 1 relation.

Headlines → **FIX-977**, **FIX-978**, **FIX-980**. The staleness measurements re-derived independently:

| pipeline | last complete | hours behind | cadence | watched? |
|---|---|---|---|---|
| `financial_entity_totals_refresh` | 2026-07-21 | **403.8 h** | 168 h | ✗ |
| `donor_party_rollup_refresh` | 2026-07-28 | 236.1 h | 168 h | ✗ |
| `entity_connections_rebuild` | 2026-07-29 | 212.8 h | 84 h | ✗ |
| `contract_flow_rollups_rebuild` | 2026-07-30 | 182.8 h | 168 h | ✗ |
| `donor_rollup_refresh` | 2026-08-02 | 115.8 h | 24 h | **✓** |

**The only watched pipeline is the freshest of the five.**

---

## Class 7 — Equal-by-coincidence predicates

Population 88 routines / 274 predicate sites; 6 findings. Of the 88, 52 carry a typed predicate and 36
carry none (MV-refresh one-liners with no predicate to be wrong about).

The headline is a live correctness defect with a dollar figure: `official_donor_totals` buckets an
**11-value** `entity_type` CHECK domain with a **3-value** predicate, so **$84,279,762 across 2,359
officials (34.8% of all officials with a row)** is counted in `total_cents` but in neither `pac_cents`
nor `individual_cents` — and the public **PAC-Heavy** pill (`tags/rules.ts:1109`) divides by that
inflated denominator. Also found: the agency-side twin of the FIX-974 invariant is **already violated**
(54 contract/grant rows carry `from_type='financial_entity'`, $14,777,827, and five sibling routines
disagree about them today), and `pg_statistic_ext` holds **0 rows database-wide** so 24 routines
carrying both `from_type` and `relationship_type` on FR are planned under a provably false independence
assumption.

---

## Refuted — reported, not hidden

Adversarial verification killed a material fraction of the first pass. Recording them is the point
(playbook E3):

| finding | why it died |
|---|---|
| `check_cron_job_health` `missing_daily` covers 5 of 21 jobs | Arithmetic re-derives exactly, but the bounded event class is **empty** — zero row-less firings in 185 runs / 21 jobs / 40 days — and every mechanism that produces one drops *all* jobs, so the 5 daily jobs are a complete canary within the 26 h window. Removing the `*` predicate would emit **16 false escalations every day**, verbatim what D4's Apply clause forbids. **The predicate is what makes the escalating branch safe.** |
| platform-snapshot has no escalation path | **Measurably false** — `platform_alert_state` shows a `critical` Resend escalation that fired 2026-08-06, and two further ungated alert paths exist. The "24× miss" quoted a superseded constant (`SNAPSHOT_STALE_MS` = 4 h per FIX-327, which measured and accepted this exact GHA best-effort behaviour). Closed duplicate. |
| 5 of 21 pg_cron jobs write no `running` start-row | The enumeration is true but the proof was a **null test** that cannot distinguish the two designs (start-row writers INSERT NULL then UPDATE the same row). And playbook **D2 inverts the claim**: a `running` row is *not* liveness, so its absence is not by itself a defect. |
| `donor_rollup_rebuild_bulk` mixes `now()`/`clock_timestamp()` | Measurement wrong (observable gap 11.3 s, not 59 s), and the failure mode **cannot occur** — the sites are in one transaction, so no observer can see the cursor stamp without simultaneously seeing that chunk's arm rows. The ordering it called false is correct. |

---

*Second verification pass over the remaining findings is in flight; classes 1, 3, 5, 7 and 8 detail
lands with it, along with the companion TSV.*
