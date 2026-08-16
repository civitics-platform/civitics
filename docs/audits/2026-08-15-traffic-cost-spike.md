# Traffic and Cost Spike — 2026-08-14 → 2026-08-15

Triage of the overnight Vercel / Upstash spike. **Investigation only — nothing was
remediated.** All queries read-only; no Cloudflare or Vercel dashboard state was
changed.

**Verdict in one line:** a crawler is walking the entity-detail families on
`www.civitics.com` while the Upstash free-tier command allotment is exhausted, so
every crawl-defense bucket built by FIX-637 / FIX-683 / FIX-797 is failing open.
The crawl was **still running at 2026-08-16 01:41 UTC — 3 h 41 m after Under
Attack mode was enabled**.

> **Revision 2026-08-16 01:45 UTC — three user-supplied facts.** Under Attack
> mode was enabled **2026-08-15 15:00 PDT / 22:00 UTC**, *not* 2026-08-08 as
> `docs/CLOUDFLARE.md` records — so it was **OFF for the entire spike window**.
> The Upstash limit email arrived **~14:30 PDT / 21:30 UTC on 08-15**. The
> `Speed Insights Data Points` $0.65 is a once-per-billing-cycle fixed charge.
>
> **Revision 2026-08-16 02:00 UTC — Cloudflare analytics obtained as text, and
> it moves the cost finding by an order of magnitude.** `docs/CLOUDFLARE.md` §5
> says the Cloudflare layer "cannot be verified by script". That is true of the
> *request path* and **false of the Analytics API**, which the existing
> `CLOUDFLARE_API_TOKEN` already has scope for. New tool:
> **`node scripts/cf-analytics.mjs --hours 24`**. What it showed:
>
> 1. **The crawl began 2026-08-15 06:00 UTC** and ran at a machine-flat
>    **7,163–7,562 requests/hour for 16 hours**. Billing day 15 — the "spike day"
>    this audit was built around — contains **exactly one hour** of it.
>    **Every cost figure in draft 1 was therefore ~15× too low.**
> 2. **Under Attack mode worked, decisively.** At 21:00 UTC: 7,313 × HTTP 200,
>    **0 × 403**. At 22:00 UTC: 445 × 200, **6,850 × 403**. Origin-reaching
>    traffic fell **~99 %**. The "it hurt" verdict is retracted outright.
> 3. **The crawler has not backed off at all** — still 7,033–7,336 req/hour,
>    now absorbed by Cloudflare instead of by Vercel.
>
> Superseded conclusions are struck through and corrected, not deleted.

Companion FIXes: [[FIX-1038]], [[FIX-1039]], [[FIX-1040]], [[FIX-1041]].

---

## User-supplied facts, and what is still outstanding

Everything not in this section is drawn from the repo, the prod DB, `gh`, and the
Vercel CLI, and is measured.

**Answered (user-supplied — treat as authoritative, not measured here):**

| Fact | Value | What it settled |
|---|---|---|
| Under Attack mode enabled | **2026-08-15 15:00 PDT = 22:00 UTC** | It was **OFF** during the spike window. `docs/CLOUDFLARE.md`'s 2026-08-08 "enabled" row is wrong or was reverted — see the correction below |
| Upstash limit email received | **~14:30 PDT = ~21:30 UTC, 2026-08-15** | Dates exhaustion to **14.5 h after** the spike window closed. **Confirms the H5 ordering** |
| Observed effect of enabling UA mode | "usage dropped off shortly following" | See the caveat under H1 — a frozen counter and a stopped crawl look identical |
| `Speed Insights Data Points` $0.65 | Once-per-billing-cycle fixed charge, ~1×/month regardless of usage | **Retracts** the anomaly section below entirely |

**Answered by dashboard screenshots + the new `scripts/cf-analytics.mjs`:**

| Question | Answer |
|---|---|
| Did traffic stop, or stop being counted? | **Both, separately.** Origin traffic fell 99 % at 22:00 UTC (UA mode); the Upstash counter froze at 21:30 UTC (exhaustion). Two different causes 30 min apart |
| Cloudflare volume | 147,611 requests / 24 h; 117,092 reached origin; 29,764 mitigated |
| Upstash tier + burn | **Free tier**, ~8–9 commands/sec at crawl volume → 500 k lasts **~15.5 h** |
| Observability Plus | **Active** — Vercel usage page states it explicitly |
| Observability Events quantity | **3,860,211 events** in the current cycle. This is the number [[FIX-1041]] says the snapshot cannot see |
| Vercel billing cycle | **Aug 14 – Sep 14**, i.e. cycle start ≈ the calendar day the Speed Insights line appeared. Confirms the retraction |

**Still outstanding — all low priority now:**

1. **Cloudflare → Security → Events**, post-22:00 UTC: top user-agents and top
   ASNs, to identify *who* the crawler is. Not needed for any verdict; useful if
   you want a targeted WAF rule instead of blanket UA mode. *(The
   challenge-solved count is no longer needed — the ~1 % leak rate answers it.)*
2. Anything deployed, linked, posted or announced in the last 48 h.

---

## Method and its resolution limit

`public.platform_usage_snapshot` on **prod** was the primary dataset. Two
corrections to how the prompt framed it, both material:

- **The Vercel window is month-to-date, not a trailing ~7 days.**
  `payload->'vercel_breakdown'->>'window_days'` reads **15** on 2026-08-15, and
  it has incremented by exactly one per calendar day since 2026-08-03. The
  FIX-648 header in `packages/db/src/vercel-usage.ts` says `/v1/billing/charges`
  "only ever returns a trailing ~7-day window (it ignores `from`)". That is no
  longer true — it now honours `from`. The projection arithmetic
  (`raw/window_days × daysInMonth`) is unaffected and still correct.

- **Every value is a cumulative MTD sum that changes once per day, not per
  snapshot.** Consecutive 10-minute snapshots are byte-identical to 16 decimal
  places. The counters step at ~06:00–07:00 UTC, i.e. **midnight Pacific** — so
  Vercel's `ChargePeriodStart` days are Pacific days.

Because the series is cumulative, it can be **differentiated** into per-day
usage, which is what every table below does. But the honest consequence is:

> **The effective resolution of this dataset is ONE DAY. The prompt's request for
> a per-10-minute series and a first-departure timestamp per metric cannot be
> satisfied from it.** "Observability events departed baseline at 03:10 UTC" is
> not a statement this data can support for any metric.

The spike lands on billing day 15 = **2026-08-14 07:00 UTC → 2026-08-15 07:00
UTC** = **2026-08-14 00:00–24:00 PDT**. That matches the reported "overnight
2026-08-14 → 2026-08-15" exactly, but it cannot be narrowed further.

**Snapshot coverage across the incident is complete** — no gap. 1–4 snapshots per
hour continuously from 2026-08-11 23:00 UTC through 2026-08-16 00:49 UTC, one
`error` row at 2026-08-15 09:00 (transient, single tick). The 2026-08-11
07:00→23:00 UTC gap is the known FIX-1026 outage and predates the window.

All SQL below ran against **prod** (`xsazcoxinpgttgquwvuf`) via
`node scripts/db-query.mjs --prod --file …`, which wraps every statement in
`SET TRANSACTION READ ONLY`. The working-tree `.env.local` pointed at **local**
Docker throughout (`grep "^NEXT_PUBLIC_SUPABASE_URL" .env.local` →
`http://127.0.0.1:54321`), so no pipeline or app path touched prod.

---

## Timeline

| UTC | America/Los_Angeles | Event | Source |
|---|---|---|---|
| 2026-08-08 | 2026-08-07 | `docs/CLOUDFLARE.md` records Security Level = "I'm Under Attack: enabled" | repo, dated snapshot |
| 2026-08-14 04:38 | 2026-08-13 21:38 | Last deploy — `9092361c` (FIX-902 `.in()` chunking) | `git log` |
| **2026-08-14 07:00 → 2026-08-15 07:00** | **2026-08-14 all day** | **Spike window.** Invocations 4.4×, edge requests 3.8×, edge CPU 4.3×, observability-event cost 3.7× | `platform_usage_snapshot` |
| 2026-08-15 02:52–03:02 | 08-14 19:52 | Nightly sync ran normally (4.6 min) | `data_sync_log` |
| 2026-08-15 06:00–06:11 | 08-14 23:00 | `refresh_derived_mvs` (10.9 min) | `data_sync_log` |
| 2026-08-15 06:30–06:42 | 08-14 23:30 | `run_rule_taggers` (12.5 min) | `data_sync_log` |
| **2026-08-15 ~21:30** | **08-15 ~14:30** | **Upstash limit email received** — allotment exhausted | **user-supplied** |
| **2026-08-15 22:00** | **08-15 15:00** | **Under Attack mode enabled** | **user-supplied** |
| 2026-08-16 00:28 → 01:26 | 08-15 17:28 | **Crawl observed live**, Upstash exhausted, limiter fully open, 92/100 on `www.civitics.com` | `vercel logs` |
| 2026-08-16 01:41 | 08-15 18:41 | **Crawl still running** — 4/4 sampled requests `www.civitics.com` → `/officials/<uuid>`, HTTP 200, `MISS/cold`, `entity_leaf`, all fail-open | `vercel logs` (re-measured) |

**The two user-supplied timestamps are the spine of this incident.** The spike
window closed at 2026-08-15 07:00 UTC. Upstash exhausted ~21:30 UTC. Under Attack
mode went on at 22:00 UTC. So the ordering is: **crawl → 14.5 h → quota
exhaustion → 30 min → mitigation**, and the mitigation post-dates the spike it
was reaching for by nearly a full day.

**No deploy occurred inside the spike window.** `d_build_min = 0.00` on billing
day 15 — the build-minutes counter did not move at all. The FIX-902 deploy landed
in the *previous* window, and that window was the second-quietest of the series
(4,413 invocations against a 4,413 median). Self-inflicted-by-deploy is ruled out
on the metric rather than on the timestamp.

Scheduled jobs overlap the window (nightly at 02:52, MVs at 06:00, taggers at
06:30) but all three ran normal-length and are DB-side, not request-path. Noted
and not chased, per scope.

---

## The data

### Per-day usage (differentiated from the cumulative MTD series)

```sql
-- q6_beacons.sql — ran against prod
WITH s AS (
  SELECT fetched_at, payload FROM public.platform_usage_snapshot
   WHERE fetched_at >= now() - interval '12 days'
), m AS (
  SELECT s.fetched_at, e->>'metric' AS metric,
         (e->'metadata'->>'raw_window_value')::numeric AS raw_val,
         (e->'metadata'->>'window_days')::int AS wd
    FROM s, jsonb_array_elements(s.payload->'metrics') e
   WHERE e->>'service'='vercel' AND e->'metadata' ? 'raw_window_value'
), d AS (
  SELECT wd,
         max(raw_val) FILTER (WHERE metric='web_analytics_events') AS wae,
         max(raw_val) FILTER (WHERE metric='function_invocations') AS inv,
         max(raw_val) FILTER (WHERE metric='edge_requests')        AS edge,
         max(raw_val) FILTER (WHERE metric='fluid_cpu_seconds')    AS cpu,
         max(raw_val) FILTER (WHERE metric='edge_cpu_ms')          AS edgecpu,
         max(raw_val) FILTER (WHERE metric='build_minutes')        AS build,
         max(raw_val) FILTER (WHERE metric='isr_reads')            AS isr
    FROM m GROUP BY wd
)
SELECT wd AS mtd_day,
       round(wae  - lag(wae)  OVER (ORDER BY wd), 0) AS d_web_analytics,
       round(inv  - lag(inv)  OVER (ORDER BY wd), 0) AS d_invocations,
       round(edge - lag(edge) OVER (ORDER BY wd), 0) AS d_edge_requests,
       round(cpu  - lag(cpu)  OVER (ORDER BY wd), 1) AS d_fluid_cpu_s,
       round(edgecpu - lag(edgecpu) OVER (ORDER BY wd), 0) AS d_edge_cpu_ms,
       round(build - lag(build) OVER (ORDER BY wd), 2) AS d_build_min,
       round(isr  - lag(isr)  OVER (ORDER BY wd), 0) AS d_isr_reads
  FROM d ORDER BY wd;
```

| MTD day (PDT) | web-analytics beacons | invocations | edge requests | fluid CPU s | edge CPU ms | build min | ISR reads |
|---|---|---|---|---|---|---|---|
| 04 | 9 | 3,043 | 1,997 | 404.8 | 830 | 16.00 | 2 |
| 05 | 3 | 3,900 | 2,350 | 472.3 | 1,080 | 12.00 | 31 |
| 06 | 14 | 3,102 | 1,906 | 407.1 | 1,520 | 128.00 | 3 |
| 07 | 5 | 3,391 | 2,101 | 448.9 | 1,030 | 132.00 | 31 |
| 08 | 13 | 6,767 | 3,993 | 813.1 | 2,100 | 36.00 | 15 |
| 09 | 6 | 5,810 | 3,430 | 643.5 | 1,620 | 48.00 | 39 |
| 10 | 3 | 3,040 | 1,866 | 376.8 | 880 | 248.00 | 0 |
| 11 | 16 | 8,277 | 4,633 | 894.1 | 2,620 | 72.00 | 356 |
| 12 | 11 | 5,876 | 3,336 | 761.9 | 1,930 | 72.00 | 35 |
| 13 | 26 | 10,857 | 8,259 | 1,012.1 | 3,760 | 124.00 | 1,702 |
| 14 | 10 | 4,413 | 2,970 | 511.0 | 1,470 | 48.00 | 548 |
| **15** | **8** | **19,368** | **11,396** | **1,382.2** | **6,610** | **0.00** | **1,688** |
| median (04–14) | 10 | 4,413 | 2,970 | 511.0 | 1,520 | 72.00 | 31 |
| **day-15 multiple** | **0.8×** | **4.4×** | **3.8×** | **2.7×** | **4.3×** | **0.0×** | — |

### Per-service effective cost, de-projected to raw MTD dollars

`vercel_breakdown.services[].usd` is stored **projected**; de-projected with
`raw = usd × window_days / 31`. Verified against the `Pro` line, which must
accrue `$20/31 = $0.6452/day`: day 15 reads exactly `$9.6774 = 0.6452 × 15`. ✓

| MTD day | Observability | Fluid CPU | Fluid mem | ISR writes | Speed Insights | Fast origin | Build CPU | Pro base |
|---|---|---|---|---|---|---|---|---|
| 10 | 0.6247 | 0.1597 | 0.4974 | 0.2348 | — | 0.0325 | 1.1060 | 6.4516 |
| 11 | 0.7649 | 0.1916 | 0.5922 | 0.2931 | — | 0.0405 | 1.2320 | 7.0968 |
| 12 | 0.8446 | 0.2187 | 0.7404 | 0.3261 | — | 0.0447 | 1.3580 | 7.7419 |
| 13 | 1.0148 | 0.2548 | 0.7861 | 0.3924 | — | 0.0568 | 1.4840 | 8.3871 |
| 14 | 1.1067 | 0.2734 | 0.8067 | 0.4292 | — | 0.0629 | 1.5680 | 9.0323 |
| **15** | **1.3891** | 0.3228 | 0.8591 | 0.5741 | **0.6500** | 0.0844 | 1.5680 | 9.6774 |

Observability Events daily delta on day 15 = **$0.2824**, against a trailing
median of **$0.0773** → **3.7×**. In absolute terms: **28 cents**.

### Cloudflare edge truth (revision 3) — `node scripts/cf-analytics.mjs --hours 24`

The measurement that should have anchored this audit from the start. Hourly,
UTC, all through the `civitics.com` zone:

| hour UTC | total | 200 (reached origin) | 403 (mitigated) | cache hit |
|---|---|---|---|---|
| 02:00–05:00 | 231–1,144 | 53–350 | 139–696 | ≤31 |
| **06:00** | **7,231** | **7,176** | **0** | 0 |
| 07:00–21:00 | 7,163–7,562 | 7,143–7,442 | 0 (four hours: 3–101) | ≤24 |
| **22:00** ← UA mode on | **7,310** | **445** | **6,850** | 0 |
| 23:00 | 7,313 | **28** | 7,268 | 0 |
| 00:00 (08-16) | 7,336 | 86 | 7,232 | 0 |
| 01:00 | 7,033 | 75 | 6,932 | 14 |
| **24 h total** | **147,611** | **117,092** | **29,764 (20.2 %)** | ~0.1 % |

Four things fall straight out of this table:

- **Onset is 06:00 UTC on 08-15** (23:00 PDT 08-14), not "somewhere in billing
  day 15". The plateau is flat to ±3 % across 16 hours — no human diurnal curve,
  no ramp. A machine.
- **Billing day 15 (Aug 14 07:00 → Aug 15 07:00 UTC) contains ONE crawl hour.**
  Everything draft 1 called "the spike" was a single hour bleeding into the last
  hour of that billing day. The other 15 hours land in **billing day 16, which
  has not been billed yet**.
- **UA mode's effect is a step function at exactly 22:00 UTC**, matching the
  user-supplied 15:00 PDT to the hour. This is unambiguous.
- **Cloudflare cache hit rate is ~0.1 %** (165 of 140.6k on the dashboard; ~146
  of 147,611 here). Every crawl request was a cold origin render — which is
  *why* it cost what it did. Entity pages are `no-store` by design, so this is
  expected rather than a defect, but it sets the per-request price.

### Cost quantified — **REVISED, draft 1 was ~11× low**

Draft 1 read billing day 15 as a full day of spike and projected **$57.62/mo**.
It was one crawl hour. Rebuilt from the Cloudflare request counts, which are the
authoritative volume measure:

| | |
|---|---|
| Day-15 excess consumption (measured) | **$0.885** |
| Crawl requests reaching origin in day 15 (06:00–07:00 UTC) | **~7,176** |
| → **cost per origin-reaching crawl request** | **~$1.23 × 10⁻⁴** |
| Crawl requests reaching origin in day 16 (07:00–22:00 UTC) | **~108,600** |
| → **projected day-16 excess** | **~$13.40** (vs a $0.33 baseline day ≈ **40×**) |
| Unmitigated 30-day run (24 h × 7,240/h × $1.23×10⁻⁴) | **~$21/day → ~$640/month** |

**So the real exposure was roughly $600–700/month, not $58.** Treat that as
order-of-magnitude — it chains a measured per-request cost onto a measured
request count — but the conclusion does not depend on the precision: this was a
two-orders-of-magnitude-over-baseline burn, and **Under Attack mode is currently
saving about $21/day.** That reframes it from "a mitigation with a real cost" to
"the thing standing between this project and a $600/month bill".

Cross-check on the burn rate, which corroborates independently: the crawl started
06:00 UTC and Upstash's 500,000-command allotment was exhausted by ~21:30 UTC —
**15.5 hours**, i.e. ~9 commands/second sustained. That matches the Upstash
throughput graph (~8/sec) and means **the free tier lasts well under one day at
crawl volume**, against ~55 days at baseline traffic. That is the sizing number
for [[FIX-1038]].

### Cost quantified — draft 1 figures, retained for the record

| | |
|---|---|
| Effective cost MTD through billing day 15 | **$15.19** |
| Projected full month at current MTD rate | **$31.39** |
| Day-15 effective delta | **$1.8589** |
| Baseline daily delta (median, days 05–14) | **$0.9740** |
| Less prorated Pro base ($20 / 31) | $0.6452/day |
| → baseline **consumption** | **$0.3288/day** |
| → day-15 **consumption** | **$1.2137/day** (**3.7×**) |
| Excess attributable to the spike, one day | **$0.885** |
| **30-day projection if the peak rate held** | **$57.62/mo** ($37.62 consumption + $20 Pro) |
| Increase over current run-rate | **+$26/mo** |

**The spike is real in ratio and small in dollars.** Observability Events — the
line that prompted this investigation — is a **$2.87/month** projected line item.
Nothing here is a financial emergency. The reason to act is the **defense
posture**, not the bill.

---

## Hypothesis verdicts

### H1 — Crawler/bot flood via `civitics.com` — **CONFIRMED as the primary mechanism, with a correction that inverts the remediation**

`pnpm dlx vercel logs https://civitics-civitics.vercel.app --json`, 100 rows,
2026-08-16 00:28:41 → 01:26:36 UTC (57.9 min):

| dimension | result |
|---|---|
| Host (`domain`) | **92 `www.civitics.com`**, 8 `civitics-civitics.vercel.app` |
| status | **100 × HTTP 200** — zero 429s, zero challenges |
| cache | **92 × `MISS` / `cold`** — every one a full cold SSR render |
| path family | `/officials` 46, `/donors` 26, `/proposals` 16, `/jurisdictions` 4, `/institutions` 2 |
| distinct entity UUIDs | **46 in 100 rows** — id-by-id walk |
| rate-limit bucket | `entity_leaf` 48, `entity_pages` 44 |
| `[ratelimit]` warn present | **92 / 100** |

This is the FIX-637 / FIX-683 crawl shape precisely: distinct entity IDs across
the high-cardinality detail families, every one a cold miss.

**Correction (revision 2).** The first draft asserted that Under Attack mode was
on during the spike and therefore that H1 required a challenge-solving crawler to
be viable at all. **That was wrong** — UA mode was enabled 2026-08-15 22:00 UTC
(user-supplied), which is **15 hours after the spike window closed**. During the
spike, Cloudflare was at its normal security level and a plain crawler needed to
defeat nothing. H1 stands on the traffic evidence alone and is *simpler* than
first written.

**What survives, and it is still load-bearing.** Probed this session, *after*
UA mode was on:

```
https://www.civitics.com/              → 403
https://civitics.com/                  → 403
https://civitics-civitics.vercel.app/  → 200
```

Apex and www both 403 a browser-UA `curl`, exactly as `docs/CLOUDFLARE.md` §5
describes — **and at 2026-08-16 01:41 UTC, 3 h 41 m after UA mode was enabled,
the crawler was still getting 200s on `www.civitics.com`** (4/4 sampled requests,
`/officials/<uuid>`, `MISS/cold`, `entity_leaf`, every one fail-open). Cloudflare
issues `cf_clearance` for ~30 minutes under UA mode, so cookies minted before
22:00 UTC cannot explain traffic 3.5 h later. The client is passing the
challenge.

So the corrected H1 reads: **an ordinary crawl during an ordinary security
posture, which Under Attack mode has since reduced but not stopped.**

> ### ⚠️ Caveat on "usage dropped off shortly following"
>
> The observed drop is **user-supplied and real**, but it has two candidate
> causes and they are indistinguishable from the Vercel/Upstash graphs alone:
>
> 1. UA mode is blocking most of the crawl. (Craig's reading.)
> 2. **The Upstash command counter physically cannot increase.** It is frozen at
>    `Usage: 500002` against a `Limit: 500000` — every subsequent command is
>    *rejected*, not counted. An Upstash usage graph flatlining at ~14:30 PDT is
>    the **expected** shape of quota exhaustion and says nothing about traffic.
>    Note the email (21:30 UTC) precedes UA mode (22:00 UTC) by 30 minutes, so
>    the flatline starts *before* the mitigation.
>
> Cause 2 is confirmed to be occurring regardless. Cause 1 is unverified. The
> direct measurement above shows the crawl still running, which is evidence
> against a *complete* stop but says nothing about the rate — `vercel logs` is
> capped and sampled and cannot measure volume. **Cloudflare Analytics →
> Traffic, requests by hostname, is the only clean discriminator** and is
> outstanding ask #1.

### H2 — Traffic hitting `*.vercel.app` directly, bypassing Cloudflare — **KILLED**

Only 8 of 100 log rows carry `domain: civitics-civitics.vercel.app`, and every
one is our own monitoring: `/api/cron/platform-snapshot` plus the FIX-1026 probe
triple (`/`, `/officials`, `/api/officials/<PROBE_OFFICIAL_ID>/responsiveness`).
There is no unexplained origin-hostname traffic.

The **exposure** is nonetheless real and proven — the origin answers 200 with no
protection whatsoever — it is simply not what happened. Carried into D2 as a
hardening proposal, not as an incident cause.

### H3 — RSC / prefetch amplification caused by Under Attack mode — **KILLED**

The discriminator is per-visitor cost shape, and it did not move:

| ratio | day 15 | median (days 04–14) | verdict |
|---|---|---|---|
| invocations per edge request | **1.70** | 1.63 (band 1.31–1.79) | unchanged |
| **fluid CPU seconds per invocation** | **0.0714** | 0.1211 | **41% CHEAPER** |

If challenged RSC fetches were degrading to hard navigations and landing in the
strict SSR buckets, cost *per request* would rise. It fell to the lowest value in
the entire series. The extra traffic was cheaper per request than normal — which
is itself informative: it is consistent with a crawler hitting many small cold
pages, not with expensive render fan-out.

### H4 — Legitimate traffic — **KILLED**

`web_analytics_events` counts client-side JS beacons from `<Analytics />` in
`apps/civitics/app/layout.tsx`. On the spike day it read **8**, against a
trailing median of **10** — flat, marginally down, while invocations went 4.4×.
Corroborated independently by the app's own analytics table:

```sql
SELECT date_trunc('day', viewed_at) AS day_utc, count(*) AS views,
       count(*) FILTER (WHERE is_bot) AS bot_views,
       count(DISTINCT session_id) AS sessions
  FROM public.page_views WHERE viewed_at >= now() - interval '12 days'
 GROUP BY 1 ORDER BY 1 DESC;
```

→ 14 views on 08-15, 4 on 08-14, 0 bot-flagged on both.

*Stated limitation:* `page_views` is written by `PageViewTracker.tsx` via a
client-side `fetch("/api/track-view")` and is mounted on only a few surfaces, so
it cannot see a non-JS crawler and is not a traffic measure. It is used here only
as weak corroboration; `web_analytics_events` is the load-bearing evidence.

Real human traffic to this site is a handful of sessions per day and did not
change. Shipping bot defenses will not harm readers who are not there.

### H5 — Upstash exhaustion → per-request `console.warn` → observability inflation — **CONFIRMED as an active, ongoing amplifier; KILLED as the cause of the 08-14 spike**

**Confirmed half.** Directly observed in the Vercel logs, verbatim:

```
[ratelimit] Upstash error on bucket=entity_leaf — failing open (allow):
Command failed: ERR max requests limit exceeded. Limit: 500000, Usage: 500002.
```

92 of 100 sampled requests carry it. The free-tier allotment is spent, the
limiter is fully open, and `apps/civitics/src/lib/ratelimit.ts:168` is emitting
one `console.warn` per bucketed request exactly as the hypothesis predicted.

**Killed half — the ordering.** H5 predicted observability-event growth would be
*superlinear* against `edge_requests`. It was not:

| MTD day | observability $ per edge request (×10⁻⁵) |
|---|---|
| 09 | 1.962 |
| 10 | 3.644 |
| 11 | 3.026 |
| 12 | 2.389 |
| 13 | 2.061 |
| 14 | 3.094 |
| **15** | **2.478** |
| median (05–14) | **2.882** |

Day 15 sits **below** the baseline ratio (0.86×). Observability events scaled
*linearly* with request count — more requests, proportionally more events, no new
per-request log line. **The `[ratelimit]` warn was not yet firing during the
spike window.**

So the true ordering is the reverse of the prompt's — and it is now **confirmed
by an independent timestamp** rather than inferred:

1. The crawl started (~08-14 PDT) and drove invocations / edge requests /
   observability up ~4×, **all in proportion**.
2. The crawl kept running and, **14.5 h after the spike window closed**, burned
   through the remaining Upstash monthly allotment — Upstash's limit email
   arrived **~21:30 UTC on 08-15** (user-supplied).
3. The limiter went fully open, the per-request warn began firing, and the crawl
   is now completely unthrottled — still true at 08-16 01:41 UTC.
4. Under Attack mode was enabled at **22:00 UTC**, 30 minutes after (2) and a day
   after (1).

The inference and the user-supplied timestamp agree: the ratio evidence said the
warn was not yet firing during the spike window, and the email confirms
exhaustion happened 14.5 h later. **H5 is a genuine second-order amplifier that
began after the incident it was proposed to explain.**

`Usage: 500002` is only 2 over the cap because the counter freezes on crossing —
so the *value* dates nothing, but the *email* does. This also means the Upstash
usage graph cannot rise any further no matter what the traffic does; see the H1
caveat.

**Falsifiable prediction — now datable, and still open.** Exhaustion at 21:30 UTC
falls **inside billing day 16** (08-15 07:00 → 08-16 07:00 UTC), about 14.5 h in.
So day 16 should carry roughly **9.5 h of per-request warn**, and its
observability-cost-per-edge-request should break above the 1.96–3.64×10⁻⁵ band —
but **diluted to ~40 % of a full day**. Day 17 is the full-strength test. As of
08-16 01:42 UTC the counters still read `window_days = 15`; they step at ~07:00
UTC. Re-run `q4` / `q6` then.

Per decision 6, the fail-open behaviour is **not** proposed for change. It did
its job: the site stayed up. The defects are that it is **silent** and that its
failure path **logs per request** — filed as [[FIX-1038]] and [[FIX-1040]].

---

## ~~Anomaly: a `Speed Insights Data Points` charge line appeared from nothing~~ — RETRACTED

**Retracted 2026-08-16 on user-supplied information.** The $0.65 is a
**once-per-billing-cycle fixed charge**, billed roughly monthly regardless of
usage. It is not a usage step and carries no signal about traffic.

What the first draft said, and why it was wrong: it observed the line appearing
at $0.65 on billing day 15 having been bounded at ≤ $0.0471 the day before, read
that as a 13.8× usage step, and offered it as corroboration that the crawler
executes JavaScript. The reasoning was sound given the data available and the
conclusion was still wrong, because a fixed cycle charge and a usage spike are
indistinguishable in a cumulative MTD series — which is itself another instance
of the [[FIX-1041]] resolution limitation.

The inference it supported (JS-capable crawler) does **not** fall with it: that
now rests on the independent 403-vs-200 measurement under H1, taken 3 h 41 m
after Under Attack mode was enabled. One leg removed, the other verified.

**Method note worth keeping:** the de-projection used here (`raw = usd ×
window_days / 31`, validated against the `Pro` line) is correct and reusable, but
a de-projected cumulative series cannot distinguish *fixed* charges from *usage*
charges. Check the Vercel usage page before reading any new line as a spike.

---

## Did Under Attack mode help, do nothing, or hurt?

**It helped, decisively. ~~It hurt.~~ ~~It partially helped.~~** Both earlier
verdicts are retracted; the Cloudflare data settles it and the answer is not
ambiguous.

The step function at 22:00 UTC, from `scripts/cf-analytics.mjs`:

| hour UTC | reached origin (200) | mitigated (403) |
|---|---|---|
| 21:00 | 7,313 | 0 |
| **22:00** | **445** | **6,850** |
| 23:00 | **28** | 7,268 |

**Origin-reaching traffic fell ~99 % within one hour of enablement**, worth about
**$21/day**. Craig's call was correct, and draft 1's "it hurt" verdict was an
artifact of the wrong enablement date plus a 4-row log sample that happened to
catch the residual.

Three things remain true and matter for what comes next:

1. **The crawler has not backed off.** It is still sending **7,033–7,336
   requests/hour**; Cloudflare is absorbing them instead of Vercel. **Turn UA
   mode off today and the $21/day resumes within the hour.** UA mode is not a
   fix, it is a dam.
2. **~1 % still leaks to origin** — 28–86 × HTTP 200 per hour, which is exactly
   the ~1 req/min measured independently via `vercel logs` at 01:49–01:53 UTC.
   Nothing throttles that residual, because the limiter is still fail-open.
   ~~The crawler solves the JS challenge.~~ **Softened:** a ~1 % leak is
   consistent with ordinary challenge-bypass edge cases and does **not** require
   a JS-capable crawler. A challenge-solving client would show a far higher
   200 rate. Draft 1 over-read this; the Speed Insights leg that supported it has
   also been retracted.
3. **It still 403s every legitimate scripted client** — measured on both apex and
   www. Now *more* dangerous than when first written, because UA mode is staying
   on: see the `CIVITICS_APP_URL` landmine below.

**The order of operations that follows:** UA mode stays on. Fix the limiter
([[FIX-1038]]) and get Upstash instrumented, because that is the defense that
works without collateral damage. Only then consider dropping the security level,
and watch Fluid CPU when you do — per `docs/CLOUDFLARE.md` §2 that is the real
test of whether the `Common Exploit Paths` WAF rule alone holds the line.

### Blast radius — verified against this repo, what is broken right now

| Caller | Hostname | Status now | Note |
|---|---|---|---|
| `platform-snapshot.yml` `trigger` job | `secrets.CIVITICS_APP_URL \|\| …vercel.app` | **surviving** | 40/40 recent runs `success` |
| `platform-snapshot.yml` `request-path-probe` (FIX-1026) | same | **surviving** | same fallback |
| Vercel `vercel.json` crons (`/api/cron/nightly-sync`, `/api/cron/notify-followers`) | deployment URL, internal | **surviving** | never traverses Cloudflare |
| Any browser-UA scripted probe of apex or www | `civitics.com` / `www.` | **403** | measured this session |
| External uptime checks on `civitics.com` | — | **would be 403** | none configured today |
| Real users' RSC soft-navigations | `www.civitics.com` | **degraded** | FIX-799 mechanism |
| Search-engine crawlers | `civitics.com` | **challenged** | ~31k sitemap URLs at risk |

**A live landmine.** Both monitoring jobs survive *only* because
`CIVITICS_APP_URL` is unset or points at the `.vercel.app` host. `docs/CLOUDFLARE.md`
§5 says Cloudflare 403s every scripted probe including browser-UA curl, and this
session measured exactly that. **The day anyone sets `CIVITICS_APP_URL` to
`https://civitics.com`, the platform snapshot and the FIX-1026 request-path probe
both die instantly** — and per FIX-1026's own header, a timed-out probe reports as
`cancelled` and pages nobody. That would blind the platform during the next
incident. Recorded in [[FIX-1039]].

**Also confirmed:** `docs/CLOUDFLARE.md`'s Pending item "Add the FIX-799 Skip
rule … more urgent while Under Attack is on" is still open, and the two Pending
items this incident touches are now escalated out of doc checkboxes into
[[FIX-1039]].

`robots.txt` is present and correct (`apps/civitics/public/robots.txt`) —
`Disallow: /*?` from FIX-513 is in place, and AhrefsBot / SemrushBot / DotBot are
disallowed. The crawler is either ignoring it or is not one of those three.
Notably **`/donors/*` is 26% of observed traffic and is not in the sitemap at
all** (`LIMITS = { proposals, institutions, officials }`), so this is
link-following, not sitemap-following.

---

## D2 — Ranked remediation options (proposals only, nothing implemented)

### 1. Restore the rate limiter — the only thing that stops the crawl today

Every crawl defense the codebase has (FIX-637, FIX-683, FIX-797) is currently a
no-op because Upstash is out of commands. Nothing else on this list matters until
this is true again.

| Option | Cost | Effect | Risk | Reversible |
|---|---|---|---|---|
| Wait for the monthly Upstash reset | $0 | Limiter returns at cycle rollover | Crawl runs unthrottled until then; next allotment burns at the same rate | n/a |
| Reduce commands per request (skip the check on cache hits; coarsen buckets) | $0, S | Extends the free allotment | Some requests unmetered | yes |
| Raise the Upstash tier | $ | Immediate | **Explicitly out of scope this pass** | yes |

Software lever before compute lever (decision 5): the cheapest real fix is to
spend fewer commands per request, not to buy more commands.

### 2. Make the fail-open observable — [[FIX-1038]]

`platform_usage_snapshot` tracks anthropic, supabase, cloudflare, github and
vercel. **Upstash is absent** — confirmed by reading
`packages/db/src/platform-snapshot.ts` end to end. That is why a hard $0-ceiling
cost control switched itself off and nothing anywhere noticed.

Adding an Upstash block to the snapshot is the **cheapest durable fix on this
entire list**: it reuses the existing 10-minute cron, the existing
`platform_limits` warning/critical machinery, and the existing alerting path. The
tension the prompt flags is real — silencing the log without adding an alarm
makes the fail-open *more* invisible — so the alarm should land **before or with**
the log-volume fix, never after.

### 3. Observability-event containment — [[FIX-1040]]

Rate-limit or sample the `[ratelimit]` warn, or replace it with a counter. Note
the honest sizing: at the observed ratio this is worth roughly **$0.03–0.30/day**,
so it is a hygiene fix, not a cost fix. Its real value is that a per-request log
line makes the failure mode expensive to leave running. Pair with #2.

There is also **no durable record of 429s anywhere** — `rateLimitResponse` in
`apps/civitics/middleware.ts:144` returns the status and logs nothing, and
`public.abuse_events` (the FIX-880 substrate) holds **0 rows** for the last 12
days. The app cannot answer "was the limiter firing?" after the fact except from
Vercel logs, which retain about an hour. Folded into [[FIX-1040]].

### 4. An exit plan for Under Attack mode — [[FIX-1039]]

What has to be true before it goes off: the limiter working again (#1), and the
`Common Exploit Paths` WAF rule verified as actually carrying the load that
`docs/CLOUDFLARE.md` §2 says it carries — that is still an untested assumption.
Turning UA mode off costs little given it is not stopping the crawler anyway, and
restores scripted monitoring and crawler access.

### 5. The FIX-799 RSC Skip rule

Already on the `docs/CLOUDFLARE.md` Pending list. H3 was killed, so this is **not
urgent for cost** — it is a UX fix for soft-navigation fallback. Keep it on the
list, deprioritise it against #1–#4.

### 6. Origin-hostname lockdown — real exposure, but H2 says it is not the leak

The `.vercel.app` origin answers 200 with no protection (measured). Enumerating
every caller, as the prompt requires:

| Caller | Survives a host restriction? |
|---|---|
| `.github/workflows/platform-snapshot.yml` — `trigger` job | Only via a `CRON_SECRET` bearer-auth exemption |
| `.github/workflows/platform-snapshot.yml` — `request-path-probe` (FIX-1026) | **No — this job sends no auth header at all.** Would need its own exemption or a rewrite |
| `apps/civitics/vercel.json` crons (`/api/cron/nightly-sync`, `/api/cron/notify-followers`) | Yes — Vercel invokes these internally |
| Every other workflow (`nightly.yml`, `sync-canary-check.yml`, `rebuild-entity-connections.yml`, `audit.yml`) | **Not affected — none of them call the app hostname.** Verified by grep; `platform-snapshot.yml` is the *only* workflow that does |

The prompt anticipated several workflows needing exemptions; there is exactly one
file, with two jobs, and **the unauthenticated probe job is the one that breaks**.
Given H2 is killed, this is defence-in-depth, ranked last. If done, a
`Host`-header 308 in `middleware.ts` is preferable to Vercel Deployment
Protection, because it keeps the auth exemption in code the repo can test.

### 7. Bucket/limit retuning — **not proposed**

Per the prompt's own instruction, no tuning on vibes. The observed per-IP
distribution is not measurable while the limiter is fail-open and Vercel log
retention is ~1 hour. One observation worth recording for when it *is*
measurable: `/donors/*` was 26% of sampled crawl traffic and falls into
`entity_pages` (120/min) rather than the stricter `entity_leaf` (45/min), because
`LEAF_PAGE_RE` covers only `jurisdictions|districts|officials`. That may be worth
revisiting — but not before the limiter works and the distribution can be seen.

---

## Premise corrections

Where this prompt's stated assumptions were falsified by repo, DB or CLI evidence:

| Premise | Verdict |
|---|---|
| Snapshot gives a per-10-minute series with a first-departure time per metric | **False.** One-day resolution; consecutive snapshots byte-identical |
| The Vercel window is a trailing ~7 days (FIX-648 header) | **False.** Now month-to-date, `window_days = 15` |
| Payload key path needs reconciling between `vercel_breakdown.services[]` and `cost_breakdown[].effective_usd` | **Both, at different layers** — stored as `vercel_breakdown.services[{service, usd}]`, projected; also on `metrics[].metadata.cost_breakdown` |
| UA mode already on since 08-08 makes H1 "close to dead on arrival" | **False, and the doc is wrong.** UA mode was enabled **2026-08-15 22:00 UTC** (user-supplied), 15 h *after* the spike window. `docs/CLOUDFLARE.md`'s "Security level: I'm Under Attack: enabled" row dated 2026-08-08 does not match reality and needs correcting. H1 is confirmed and needed no challenge-solving to occur |
| UA mode may have killed the platform snapshot / request-path probe | **False today** — both green throughout; but true the moment `CIVITICS_APP_URL` is set to `civitics.com` |
| *(this audit, draft 1)* Speed Insights $0.65 was a 13.8× usage step | **Self-falsified — retracted.** Fixed once-per-cycle charge (user-supplied) |
| *(this audit, draft 1)* Under Attack mode "hurt" | **Self-falsified — revised.** It post-dates the spike; partial mitigation, not a failed one |
| Observability Events has no quantity metric | **True.** `mapChargeQuantity` returns `null` for it — cost is the only signal |
| Upstash is not tracked in `platform_usage_snapshot` | **True.** Five services tracked, Upstash absent |
| H5 explains both symptoms from one cause | **Half.** Exhaustion is real and active, but it began *after* the spike, not before |
| Observability events bill per ingested event | **Not verified** — no unit available without the Vercel usage page |
| Several workflows call the `.vercel.app` hostname | **False.** Exactly one (`platform-snapshot.yml`) |
| `docs/OPERATIONS.md` / `docs/ARCHITECTURE.md` stale on Bot Fight Mode | **Confirmed still stale** — Pending item unactioned |

One defect found in the instrument itself: `platform-snapshot.ts:425` truncates
the cost breakdown with `.slice(0, 8)`. `n_services` is **8 on every single day**
— the cap is always binding. On day 15 `Speed Insights Data Points` entered the
top 8 and silently **displaced `Function Invocations`** out of the stored record.
A service can therefore vanish from the audit trail purely by rank change, which
is exactly the kind of gap that makes an incident un-reconstructable. Filed as
[[FIX-1041]] together with the missing Observability quantity metric.

---

## Appendix — remediation-session measurements (2026-08-16 02:38 UTC)

Taken while implementing [[FIX-1038]] / [[FIX-1040]] / [[FIX-1042]]. All four
queries below run against the **historical** window 2026-08-15 06:00–22:00 UTC,
so they are immune to any edge-posture change made after the fact. `clientAsn`
and `firewallEventsAdaptiveGroups` are both **refused to this Free zone** — the
outstanding-ask #1 "top ASNs from Security Events" is not reachable by script;
`clientIP` and `userAgent` on `httpRequestsAdaptiveGroups` are.

### The crawl came from 569 IPs, none of them fast enough to trip a bucket

| | |
|---|---|
| Requests in window | **116,636** |
| Distinct `clientIP` | **569** (exact — the result set was not truncated) |
| Inside Meta's `2a03:2880::/32` | **140 IPs carrying 114,489 requests (98.2 %)** |
| Busiest single IP | 1,752 requests / 16 h = **1.82 req/min** |
| IPs sustaining >45 req/min (the `entity_leaf` cap) | **0** |
| Top 50 IPs / top 100 IPs | 70.6 % / 98.4 % of volume |

**This inverts the premise the deny-cache was proposed on.** The remediation
prompt assumed "the limiter's Upstash spend was highest precisely while it was
blocking — it burned its own budget issuing 429s." It never blocked. The
busiest participating IP ran **25× under the strictest bucket**, so no bucket
could have rejected anything, and every one of the ~500,000 commands was spent
issuing **allows**. The deny-cache would have saved approximately zero on
2026-08-15. It ships anyway because it is correct for the case the limiter is
actually for — one noisy identifier — but it is **not** an incident fix, and
per-IP limiting must be documented as the human-scale layer. That is now in
`ratelimit.ts`'s header.

### `/graph` share, and why it is nevertheless cheap

| path family | requests | share |
|---|---|---|
| **`/graph` (exact)** | **27,534** | **23.6 %** |
| `/donors/*`, `/officials/*`, `/jurisdictions/*`, `/proposals/*` | long tail of distinct UUIDs | — |
| `/graph/*` (the `[code]` share route) | **0** | 0 % |

23.6 % over 06:00–22:00 is consistent with the ~30 % the FIX-1039 bullet records
over the full 24 h. Every one of the 27,534 was `cacheStatus: dynamic` at the
Cloudflare edge (the zone has no cache rules — §3 of `docs/CLOUDFLARE.md`), 27,530
× 200, 3 × 307, 1 × 522.

**But `/graph` is `○ (Static)` in the Next build table** — `export const dynamic
= "force-static"` in `apps/civitics/app/graph/page.tsx`, and the `?entity=`
param is read **client-side** (`new URL(window.location.href).searchParams` in
the `"use client"` `GraphPage.tsx`). So a `/graph?entity=<uuid>` request is a
prerendered HTML file off the CDN plus one edge-middleware invocation: no
server render, no Supabase read, no Fluid CPU. The real cost sits behind
`/api/graph*`, which **is** bucketed (`graph` 60/min, `graph_ai` 5/min), and a
non-JS crawler never fires it. [[FIX-1042]] therefore closes measured-no-op:
adding a `graph_page` bucket would have spent ~27.5 k extra Upstash commands per
crawl window to throttle the cheapest request class on the site.

### The crawler rotates 18 user-agent strings — a WAF rule must match a substring

63 distinct `userAgent` values in the window. **18 of them contain
`meta-webindexer`, together carrying 114,526 requests (98.2 %).** They differ
only in the browser-impersonation prefix: `Windows NT 10.0` (66,213),
`Macintosh; Intel Mac OS X 10_15_7` (34,090), `X11; Linux x86_64` (7,549),
`… Edg/145` (4,690), `… Chrome/144 … Edg/144` (799), and 13 more.

> **Operationally load-bearing for the WAF rule:** a rule matching the exact UA
> string quoted in [[FIX-1039]] catches **66,213 of 116,636 — 57 %**. The rule
> must be `User Agent **contains** "meta-webindexer"` (or an ASN-32934 match) to
> reach 98 %.

`/robots.txt` was fetched **52 times inside this window** and the crawl
continued — consistent with the FIX-1042 conclusion that the robots.txt half is
dead: Cloudflare's bot directory documents Meta-WebIndexer as not respecting
robots.txt by default, and RFC 9309 §2.2.3 makes `*` support mandatory
("Crawlers **MUST** support"), so FIX-513's `Disallow: /*?` is
standards-conformant and the "wildcard unsupported" hypothesis is falsified.

### Upstash was STILL exhausted at 2026-08-16 03:08 UTC — and the allotment may not be daily

The new `getUpstashHealth()` probe (FIX-1038), run live against the real Upstash
REST endpoint:

```json
{ "state": "quota_exhausted",
  "detail": "ERR max requests limit exceeded. Limit: 500000, Usage: 500002. …",
  "limit_commands": 500000, "usage_commands": 500002,
  "latency_ms": 287, "checked_at": "2026-08-16T03:08:07.832Z" }
```

Two things follow.

1. **The limiter is still degraded right now.** Exhaustion was ~21:30 UTC on
   08-15; this reading is 5h38m later.
2. **"500k daily commands" is not established.** The counter did not reset
   across the 00:00 UTC boundary. This audit's own "~55 days at baseline"
   figure only makes sense for a per-period (monthly) allotment as well. If it
   is monthly, **one crawl removes the durable limiter for the remainder of the
   cycle** — which makes the FIX-1038 fail-over materially more load-bearing
   than a daily reset would. Not asserted here, because it can only be settled
   from the Upstash console; recorded as measured-and-open, and the
   `platform_limits` row is named `period_commands` rather than
   `daily_commands` so the card does not repeat the unverified claim.

### An over-quota Upstash refuses only ~38% of commands — "fully open" is too strong

Eight probes, 3 s apart, same credentials, same process, 2026-08-16 03:10 UTC,
while the counter sat frozen at `Usage: 500002`:

```
03:10:23 healthy   03:10:26 healthy   03:10:29 QUOTA   03:10:32 healthy
03:10:35 healthy   03:10:38 QUOTA     03:10:41 healthy 03:10:44 QUOTA
```

**3 of 8 refused (~38%); the rest answered PONG.** So over-quota Upstash
degrades *probabilistically*, and two conclusions follow that this audit got
slightly wrong:

- **"Every subsequent command is rejected, not counted" / "the limiter is fully
  open" is an overstatement.** It is *intermittently* open. Roughly 6 in 10
  checks still limited correctly. (The incident's `92/100 requests carried the
  warn` implies a much higher refusal rate under crawl load than at idle, which
  is consistent — refusal rate is presumably load-dependent.)
- **A one-ping health probe would have been blind to its own incident**, calling
  it "healthy" through ~60% of ticks. `getUpstashHealth()` therefore issues
  three PINGs and reports `quota_exhausted` if **any** refuses, plus a
  `refusals/attempts` ratio: a PONG is not evidence of health, a refusal is
  proof of exhaustion. Caught live on the very next run —
  `"1/3 PINGs refused"` at 03:12:39 UTC, two minutes after a single-ping probe
  had returned `healthy`.

### Reproduction

```bash
node scripts/cf-analytics.mjs --since 2026-08-15T06:00:00Z --hours 16
node scripts/cf-analytics.mjs --since 2026-08-15T06:00:00Z --hours 16 --by clientIP --top 20
node scripts/cf-analytics.mjs --since 2026-08-15T06:00:00Z --hours 16 --by userAgent --top 20
node scripts/cf-analytics.mjs --since 2026-08-15T06:00:00Z --hours 16 --by clientRequestPath --top 20
```

`--by` / `--top` were added to `scripts/cf-analytics.mjs` by this session; the
`--by` mode reports distinct-value cardinality and a cumulative-coverage ladder
alongside the top-N, which is what makes the "569 IPs, 0 above the cap" reading
possible. It also prints an explicit truncation warning when the API's 10,000-row
group cap binds (it does bind on `clientRequestPath`: the per-UUID entity walk
produces >10,000 distinct paths, so **only `/graph`, which is a single constant
path, has a trustworthy absolute count in that mode**).

---

## Reproduction

Every query in this document is in the session scratchpad and re-runnable:

```bash
node scripts/db-query.mjs --prod --file q1_coverage.sql    # snapshot coverage + errors
node scripts/db-query.mjs --prod --file q3_series.sql      # cumulative MTD vercel metrics
node scripts/db-query.mjs --prod --file q4_breakdown.sql   # per-service cost, de-projected
node scripts/db-query.mjs --prod --file q6_beacons.sql     # per-day deltas incl. beacons
node scripts/db-query.mjs --prod --file q7_svclist.sql     # slice(0,8) truncation check
node scripts/db-query.mjs --prod --file q5_request_path.sql # abuse_events, page_views, sync log

pnpm dlx vercel@latest logs https://civitics-civitics.vercel.app --json   # ~1h retention, 100-row cap
gh run list --workflow=platform-snapshot.yml --limit 40 --json name,conclusion,startedAt

curl -sS -o /dev/null -w "%{http_code}" -A "<browser UA>" https://www.civitics.com/   # → 403
curl -sS -o /dev/null -w "%{http_code}" -A "<browser UA>" https://civitics-civitics.vercel.app/  # → 200
```

**Caveat on the log sample:** `vercel logs` returned 100 rows over 57.9 minutes and
is both capped and sampled. The 1.7 req/min it implies is a **lower bound only**
and must not be read as the crawl rate — the billing counters (19,368 invocations
in a day) are the authority on volume.
