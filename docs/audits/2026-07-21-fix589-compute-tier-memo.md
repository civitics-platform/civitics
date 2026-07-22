# FIX-589 — Compute-tier upgrade memo (costed)

**Date:** 2026-07-21 · **For:** Craig · **Status:** decision memo — the call is yours; no action taken.
**Sources:** docs/audits/2026-05-24-iowait-diagnosis.md (measured prod values), supabase.com/docs compute-and-disk (pricing/specs pulled 2026-07-21), FIX-837/838 ship reports (fresh runtime datapoints).

## 1. The measured constraint

Prod runs Supabase Pro **Small**: 2 GB RAM, `shared_buffers` 256 MB, `effective_cache_size` 768 MB, 2-core shared ARM, **22 MB/s baseline disk throughput** (burst 261 MB/s, credit-limited). The top-3 tables (entity_connections 5.12 GB, financial_relationships 4.79 GB, financial_entities 2.61 GB) sum to a **12.5 GB working set — a ~2% shared_buffers ratio**. Every heavy read is a disk workload; cache thrashing is structural, not a tuning miss. (Numbers from 2026-05-24; the tables have only grown since — FR alone gained ~1.5M rows in the FIX-672/677 era.)

Fresh corroboration from last week: the FIX-838 contract-flow rebuild ran **16.7s local vs 991s prod cold (~59x)**, and FIX-837's vote-stats rebuild 1.9s → 23.8s (~12x). That multiplier IS the Small tier's I/O ceiling — at 22 MB/s baseline, re-reading a few-GB slice of the working set takes a quarter hour.

## 2. What software already fixed (why this is not urgent)

The materialization program routed the *user-facing* timeout class around the hardware: page caches (663/683/685), the graph rollups (776–779, 868), the tagger rollups (836/837), contract flows (838), plus the RPC EXECUTE lockdown. The FIX-780 audit measured the request path after all that: **no RPC is hot on the DB anymore** — the CDN absorbs nearly everything and cache-misses land on rollup tables, not live aggregations. A role-level timeout bump was rejected (FIX-589 analysis) because raising `authenticator`/`service_role` also raises request-path routes and worsens cache starvation.

What hardware would still buy, in order of real value today:

1. **Cold-read latency** — first-visit/cache-miss pages and the anon 3s / API 8s classes get their margin from cache hits instead of careful routing. The 12–59x prod-vs-local multiplier shrinks toward low single digits once the working set fits in RAM.
2. **Rebuild/refresh windows** — the nightly/weekly rollup rebuilds (991s, 16-min donor rollup class, 31–64-min incremental refreshes) compress dramatically; cron-vs-traffic contention mostly disappears.
3. **Headroom for growth and launch traffic** — the working set grows every FEC cycle; Small has no slack for a traffic spike coinciding with a cron tick.

## 3. The tiers (current Supabase pricing)

Pro base is $25/mo and includes a **$10/mo compute credit**. Small costs ~$15/mo, so today's all-in is ~$30/mo. Deltas below are vs. that.

| Tier | $/mo compute | All-in ≈ | Δ/mo | RAM | CPU | Disk baseline | shared_buffers (est.) | Working-set coverage |
|---|---|---|---|---|---|---|---|---|
| **Small (now)** | ~$15 | ~$30 | — | 2 GB | 2-core shared | 22 MB/s | 256 MB (measured) | ~2% |
| Medium | ~$60 | ~$75 | **+$45** | 4 GB | 2-core shared | 43 MB/s | ~512 MB | ~4% buffers; OS cache still ≪ working set |
| Large | ~$110 | ~$125 | **+$95** | 8 GB | 2-core **dedicated** | 79 MB/s | ~1 GB | ~8% buffers; OS cache ~½ the working set |
| **XL** | ~$210 | ~$225 | **+$195** | 16 GB | 4-core dedicated | 149 MB/s | ~2 GB | **RAM ≥ working set — effectively fully cached** |
| 2XL | ~$410 | ~$425 | +$395 | 32 GB | 8-core dedicated | 297 MB/s | ~4 GB | Fully cached + years of growth |

Caveats: shared_buffers beyond Small are extrapolated from the measured 12.5%-of-RAM anchor — verify post-resize (`SHOW shared_buffers`). The docs list Small at 90 direct connections but prod measured `max_connections=60`; expect per-tier connection limits to move on resize too. Small/Medium disk is burstable (credits), Large+ is sustained — relevant because our pain windows are exactly the sustained-read rebuilds that exhaust burst credits.

## 4. Expected effect per pain class

- **Medium (+$45):** doubles RAM and disk baseline, but 4 GB against 12.5 GB still means every heavy read is a disk read. It softens the pain without changing the regime. Weak value per dollar for this workload shape — the working set is the problem, and Medium doesn't approach it.
- **Large (+$95):** first tier with dedicated cores and sustained (non-burst) I/O at 3.6x today's baseline. Rebuild windows shrink roughly 3–4x (991s → ~4–5 min class); ~8 GB RAM caches the hot halves of EC+FR so typical cold pages stop paying full disk latency. The regime is still partial-cache, but the cliff edges (8s API ceiling brushes, cron contention) get real margin.
- **XL (+$195):** the regime change. 16 GB ≥ the 12.5 GB working set — the "cache-starved Small" phrase exits the vocabulary. Cold-read multiplier collapses, rebuilds become minutes-not-quarter-hours, and the whole class of "materialize it because live is impossible" pressure relaxes (the shipped rollups stay — they're cheaper regardless). Two caveats: the working set grows (~1–2 GB/cycle-year at current ingest), so XL's full-cache guarantee erodes over a couple of years; and I/O still bounds the write-heavy rebuild bursts (149 MB/s, not infinite).

## 5. Recommendation shape (decision is yours)

Given pre-revenue cost posture: **staying on Small is defensible today** — the software program genuinely removed the user-facing symptom, and remaining pain is operational (slow rebuilds, supervised-backfill patience), not user-visible. The trigger to upgrade is launch/traffic, not the current backlog.

If/when upgrading, **skip Medium**. Large is the value pick for operational comfort; **XL is the one that changes the regime** and is what the iowait audit's arithmetic actually points at.

Cheap de-risk before committing: compute is billed **hourly**, so an XL trial costs ~$0.27/h ≈ **$7–10 for a 24–36h window**. Resize to XL, let the nightly + a donor-rollup refresh + one graph-heavy browse session run, measure (buffer-hit %, `pg_stat_statements` means on the known-cold RPCs, one rebuild runtime), resize back. That converts this memo's estimates into your own numbers for a coffee's worth of spend. Only wrinkle: each resize is a brief restart (~2 min downtime) — do it in a quiet window.

**Closing FIX-589:** this memo is the bullet's remaining deliverable. Whenever you've made the call (including "stay on Small for now"), any CC session can commit this file to `docs/audits/` with `Fixes: FIX-589` / `Verified: local` and note the decision in the commit body.

---

## Decision (2026-07-22)

**Call: stay on Pro Small.** Craig reviewed the memo and decided to remain on the
current Small tier for now. Rationale matches §5: the materialization program
(FIX-663/683/685/776–779/836/837/838/868) already removed the user-facing timeout
class, so the residual pain is operational (slow supervised rebuilds), not
user-visible. Paying +$95–$195/mo pre-revenue to compress rebuild windows that run
unattended on cron isn't justified yet.

**Revisit trigger:** launch prep, or sustained real traffic — whichever comes
first. Concretely, re-open this decision when any of:

- Launch is being scheduled (want cold-read headroom before real users arrive).
- Prod shows sustained concurrent traffic (buffer-hit % dropping under load, or
  request-path routes brushing the 8s API / 3s anon ceilings on cache miss).
- A cron rebuild window starts colliding with user traffic in a user-visible way.

When that trigger fires, the memo's guidance stands: **skip Medium**, trial **XL**
hourly (~$7–10 for a 24–36h window) to convert the §4 estimates into measured
numbers, then decide XL (regime change) vs Large (operational comfort).

FIX-589 is closed by this decision. No compute resize performed.
