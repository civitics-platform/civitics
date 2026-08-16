# Traffic and Cost Spike — 2026-08-14 → 2026-08-15

Triage of the overnight Vercel / Upstash spike. **Investigation only — nothing was
remediated.** All queries read-only; no Cloudflare or Vercel dashboard state was
changed.

**Verdict in one line:** a JS-executing crawler is walking the entity-detail
families on `www.civitics.com`, **passing straight through Under Attack mode**,
while the Upstash free-tier command allotment is exhausted so every crawl-defense
bucket built by FIX-637 / FIX-683 / FIX-797 is failing open. The crawl was still
running at 2026-08-16 01:26 UTC, when this audit was written.

Companion FIXes: [[FIX-1038]], [[FIX-1039]], [[FIX-1040]], [[FIX-1041]].

---

## Blocked on user — dashboards this session cannot reach

None of the following were available; every conclusion below is drawn from the
repo, the prod DB, `gh`, and the Vercel CLI. **No number in this document is
user-supplied.**

1. **Cloudflare audit log** — exact time Under Attack mode was enabled, and
   whether it was ever off since 2026-08-08. Needed to date the posture change.
2. **Cloudflare Analytics** — requests by hostname, top user-agents, top
   ASNs/countries, challenge-issued vs challenge-solved counts. **The
   challenge-solved count is the single most valuable missing number** — see H1.
3. **Upstash console** — command count over the last 72 h and **when** the
   500,000 limit was hit. Bounds the H5 ordering claim below.
4. **Vercel usage page** — the Observability Events unit and current-cycle
   quantity; whether Observability Plus is on; and **why a `Speed Insights Data
   Points` charge line appeared on 2026-08-14** (see the anomaly section).
5. Anything deployed, linked, posted or announced in the last 48 h.

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
| 2026-08-16 00:28 → 01:26 | 08-15 17:28 | **Crawl observed live**, Upstash exhausted, limiter fully open | `vercel logs` |

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

### Cost quantified

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

**The correction.** Cloudflare *is* challenging right now — probed this session:

```
https://www.civitics.com/              → 403
https://civitics.com/                  → 403
https://civitics-civitics.vercel.app/  → 200
```

So apex and www both 403 a browser-UA `curl`, exactly as `docs/CLOUDFLARE.md` §5
describes — **and the crawler is getting 200s on `www.civitics.com` anyway.**
The only way both are true is that **the crawler is solving the challenge**: it
is a JS-executing client (headless browser, or one holding a valid
`cf_clearance`). Under Attack mode is filtering out exactly the clients that
cannot run JS — legitimate scripted ones — and letting the actual crawler
through.

Craig's hypothesis is therefore **right about the mechanism and wrong about the
remedy**: this is a crawl, it is arriving on `civitics.com`, and raising the
Cloudflare security level does not touch it.

*What would settle the residual:* Cloudflare Analytics challenge-**solved** count
for the window. A high solve rate confirms headless-browser crawling directly.

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

So the true ordering is the reverse of the prompt's:

1. The crawl started (~08-14 PDT) and drove invocations/edge requests/observability up ~4×, all in proportion.
2. The crawl kept running and **later** burned through the remaining Upstash monthly allotment.
3. The limiter went fully open, the per-request warn began firing, and the crawl is now completely unthrottled — the state observed at 08-16 01:26 UTC.

`Usage: 500002` is only 2 over the cap, i.e. the counter froze on crossing, so it
carries **no information about when** exhaustion happened. That is the Upstash
console item.

**Falsifiable prediction.** If this ordering is right, the day-16 delta — visible
after the next daily step — will show observability-event cost rising
**superlinearly** against `edge_requests`, breaking out of the 1.96–3.64×10⁻⁵
band above for the first time. Re-run `q4`/`q6` tomorrow to confirm or refute.

Per decision 6, the fail-open behaviour is **not** proposed for change. It did
its job: the site stayed up. The defects are that it is **silent** and that its
failure path **logs per request** — filed as [[FIX-1038]] and [[FIX-1040]].

---

## Anomaly: a `Speed Insights Data Points` charge line appeared from nothing

On billing day 15 a `Speed Insights Data Points` line appears at **$0.65** raw
MTD. It is absent from every prior day. Bounding it from the residual (total
effective minus the eight stored lines), on day 14 it was **≤ $0.0471** — so this
is at minimum a **13.8× single-day step**, and the largest single cost mover in
the incident, larger than Observability Events.

`<SpeedInsights />` has been mounted in `apps/civitics/app/layout.tsx` since
`0b521cf6` (2026-03-17), so this is **not** a code change.

This does not reconcile cleanly with `web_analytics_events` staying flat at 8 —
both are browser-side beacons. The most likely explanation is that Vercel Web
Analytics filters known bots from its counts while Speed Insights does not, so a
headless-browser crawler would show up in one and not the other. **That is
inference, not measurement** — it needs the Vercel usage page to confirm, and it
is USER item 4. If it holds, it is independent corroboration that the crawler
executes JavaScript, which is the H1 correction.

---

## Did Under Attack mode help, do nothing, or hurt?

**It hurt.** It is not stopping the crawler — which solved the challenge and was
still walking entity pages on `www.civitics.com` at 2026-08-16 01:26 UTC — while
it 403s every legitimate non-JS client, which is a strict net loss.

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
| UA mode already on since 08-08 makes H1 "close to dead on arrival" | **Backwards.** UA mode is on *and* H1 is confirmed — the crawler solves the challenge |
| UA mode may have killed the platform snapshot / request-path probe | **False today** — both green throughout; but true the moment `CIVITICS_APP_URL` is set to `civitics.com` |
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
