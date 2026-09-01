# Front-door degradation, 2026-09-01 — the Tuesday weekly pile-up

**Report only. No schedule was changed by this investigation.** The deliverable is
the evidence table at the end, for the parked schedule-moves decision.

Measured 2026-09-01 ~22:45–23:10 UTC, supervised window, Craig present.

---

## 1. The window, derived from records rather than from either clock

Craig reported "about 20% errors, roughly 5am to 11am" without stating a timezone.
Both readings were treated as hypotheses and the window was derived independently
from the Supabase Logs API (`analytics/endpoints/logs.all` over `edge_logs`),
which is the front door for every request the app's data layer makes.

| hour (UTC) | requests | 5xx | rate |
|---|---:|---:|---:|
| 09:00 | 392 | 1 | 0.3% |
| 10:00 | 276 | 27 | **9.8%** |
| 11:00 | 383 | 2 | 0.5% |
| 12:00 | 320 | 41 | **12.8%** |
| 13:00 | 1410 | 421 | **29.9%** |
| 14:00 | 561 | 41 | **7.3%** |
| 15:00 | 319 | 61 | **19.1%** |
| 16:00 | 368 | 39 | **10.6%** |
| 17:00 | 378 | 24 | **6.3%** |
| 18:00 | 419 | 70 | **16.7%** |
| 19:00 | 446 | 1 | 0.2% |

**The degraded window is 12:00–18:00 UTC**, seven consecutive hours, 697 5xx over
3,775 requests = **18.5% weighted**, peaking at 29.9%. It is clean on both sides:
0.5% at 11:00, 0.2% at 19:00.

12:00–18:00 UTC is **05:00–11:00 PDT**. Craig's report was correct in both
magnitude and bounds, and the timezone was PDT. The 10:00 UTC blip at 9.8% is a
separate precursor, accounted for in §4.

## 2. It was the DATA front door, not the website

Cloudflare in front of `civitics.com` served **zero 5xx in the same 24 hours**.
Verified with `scripts/cf-analytics.mjs --hours 24 --by edgeResponseStatus`: the
complete status set was 403, 200, 400, 301, 307, 404, 204, 401, 499, 302. The
45.2% 403 rate is Cloudflare's managed-challenge rate against automated clients
(`Cf-Mitigated: challenge`, "Just a moment…"), is present in every hour of the
day, and is unrelated. The one apparent spike — 216 "other" responses at 19:00 —
is 168 × 301 redirects, not errors.

So a data-plane front door can be failing 30% of requests while the website's
edge metrics look entirely healthy. Any alerting built only on the Cloudflare
side would have stayed silent through all seven hours. That asymmetry is filed
separately as **FIX-1130**.

## 3. Mechanism: I/O saturation surfacing as statement timeouts

Front-door 5xx breakdown for 12:00–18:00 UTC: **583 × 500, 112 × 504**, plus one
520 and one 525.

Postgres-side errors for the identical window, from `postgres_logs`:

| count | severity | message |
|---:|---|---|
| **683** | ERROR | canceling statement due to **statement timeout** |
| 28 | ERROR | canceling statement due to user request |
| 5 | WARNING | autovacuum worker took too long to start; canceled |
| 3 | WARNING | autovacuum worker started without a worker entry |
| 2 | FATAL | connection to client lost |
| 1 | FATAL | terminating background worker "parallel worker" |

683 statement timeouts against 695 front-door 5xx is effectively 1:1. **The 5xx
are statement timeouts.** `service_role` carries an 8 s cap, so these are ordinary
request-path reads — normally well under a second — pushed past eight seconds.

The affected paths are not one bad query; they are everything:

| path | 5xx |
|---|---:|
| `/rest/v1/rpc/get_jurisdiction_page` | 142 |
| `/rest/v1/jurisdictions` | 111 |
| `/rest/v1/officials` | 55 |
| `/rest/v1/rpc/get_official_page` | 54 |
| `/rest/v1/rpc/official_is_content_bearing` | 53 |
| `/rest/v1/enrichment_queue` | 47 |
| `/rest/v1/jurisdiction_page_cache` | 43 |
| `/rest/v1/proposals` | 37 |
| `/rest/v1/financial_relationships` | 24 |
| `/rest/v1/official_donor_rollup_mv` | 21 |
| (+ 5 more tables/RPCs, 10–17 each) | |

A degradation spread evenly across unrelated tables and RPCs is a **shared-resource**
signature. The three competing explanations are ruled out by their absence:

- **Not lock contention** — no lock waits logged, and the affected objects share
  no common lock target.
- **Not connection pressure** — no "remaining connection slots" errors, no pooler
  saturation errors.
- **Not a memory seizure** — no OOM and no `server restarted`, which is the
  sharpest contrast with the 2026-08-29 event ([[FIX-1125]]) where the postmaster
  could not fork a backend for ~50 minutes and the box had to be restarted. This
  window recovered on its own. It is *not* a clean bill of health on memory
  though: two jobs did hit `job startup timeout` at 13:00, so backend startup did
  fail briefly at the peak. See §4.

What remains is I/O. Prod is cache-starved by design (256 MB `shared_buffers`,
~54% hit rate) and has a finite daily disk burst budget ([[FIX-1107]]).

## 4. Co-tenants: a "stack" that is really a pile-up

The Tuesday schedule assumes each job fits inside its hour. Measured runtimes for
2026-09-01 say otherwise — `cron.job_run_details`, jobs 40/44/45 excluded:

| start (UTC) | jobid | job | runtime | ends | status |
|---|---:|---|---:|---|---|
| 11:30 | 23 | donation-edge-orphan-sweep | 128.7 s | 11:32 | ok |
| **12:00** | 24 | **donor-rollup-refresh** | **6747.3 s (1h52m)** | **13:52** | ok |
| 12:00 | 14 | financial-entity-totals-reconcile | 134.2 s | 12:02 | ok |
| **12:30** | 15 | **donor-rollup-orphan-sweep** | **3393.2 s (56m)** | **13:26** | ok |
| 13:00 | 25 | agency-staffing-rollup-refresh | 10.0 s | — | **failed** |
| 13:00 | 18 | donor-party-rollup-orphan-sweep | 10.0 s | — | **failed** |
| **13:30** | 19 | **ec-stats-orphan-sweep** | **1796.9 s (30m)** | **14:00** | ok |
| **14:00** | 26 | **treemap-individuals-global-refresh** | **5420.7 s (1h30m)** | **15:30** | **failed (watchdog)** |
| **15:00** | 17 | **donor-party-rollup-refresh** | **1814.6 s (30m)** | **15:30** | **failed (watchdog)** |
| **16:00** | 12 | **rule-taggers-weekly** | **7519.7 s (2h05m)** | **18:05** | **failed (watchdog)** |
| 17:05–17:20 | 32–47 | six vacuum-analyze jobs | 0.4–27.2 s | — | ok |

Heavy work is continuously in flight from **12:00:00 to 18:05**, and the degraded
window is **12:00–18:00**. The correlation is exact at both edges: the window opens
when `donor-rollup-refresh` starts and closes when `rule-taggers-weekly` is
cancelled.

Three jobs overlap for most of it. `donor-rollup-refresh` alone needs 1h52m of a
one-hour slot, so it is still running when its own orphan-sweep starts at 12:30
and when the 13:00 jobs fire. The 29.9% peak at 13:00 is exactly where the most
jobs are concurrent.

Two second-order effects worth naming:

- **jobid 25 and jobid 18 both failed after 10.0 s at the identical timestamp
  13:00:00.000398, both with `return_message = "job startup timeout"`.** That is
  not two independent failures: at 13:00 UTC pg_cron **could not fork a backend**.
  This is the [[FIX-1125]] symptom recurring, and it qualifies §3's conclusion —
  pressure reached the point of blocking process startup, not merely slowing
  queries. It is *not* proof of the 08-29 memory mechanism: there was no OOM, no
  `server restarted`, and the box recovered without intervention. Whether the
  13:00 fork failure was memory or process/connection-slot pressure is **not
  determined** by these records, and sits directly on the [[FIX-1125]] question
  of a guard that needs a new backend in order to act.
- **The cron-budget watchdog worked.** It cancelled jobid 26, jobid 17, jobid 12
  and ec-crawl (twice, at 1915 s and 2087 s). Those four cancellations are the 28
  "canceling statement due to user request" errors. The watchdog is not the
  problem; it is the only reason the window ended at 18:05 rather than later.

**The 10:00 UTC precursor (9.8%) and the ec-crawl feedback loop.** ec-crawl was
both a contributor to this window and a victim of it, and the record is unusually
clean about it. `entity_connection_stats_windows` **window 1 of 16** was attempted
three times inside the degraded window, each time inserting **zero rows** before
being cancelled, and only completed on the fourth attempt:

| cycle (UTC) | elapsed | rows | outcome |
|---|---:|---:|---|
| 10:00 | 1,812 s | 0 | cancelled — precursor blip, 9.8% |
| 12:45 | 2,112 s | 0 | cancelled |
| 15:30 | 1,928 s | 0 | cancelled |
| 18:15 | 1,563 s | 2,068 | **completed**, cursor advances to window 2/16 |

That is **7,415 s of wall clock to complete one of sixteen windows**, of which
5,852 s produced nothing. Each failed attempt re-read the same data and re-spent
the same I/O the front door needed. This is a genuine positive feedback loop: box
contention makes the unit overrun, the overrun gets it cancelled, the cancel
discards the work, and the retry re-enters the same contention.

Two corroborations that the loop is contention-driven rather than a data problem:
after the window closed, windows 3–10 ran at **235–270 s each** with ~2,000 rows
each (20:45–22:30) — 7–8× cheaper for *more* output. And ec-crawl's own throughput
backoff finally tripped at 22:45 when a unit took 767 s against that ~250 s rolling
median, parking the crawl until 2026-09-02 00:57:47.

The cancellations are correct behaviour by the budget watchdog. The problem is that
a cancelled window banks nothing, so the cost is paid again in full. That is worth
its own item if it recurs — cf. the FIX-969 resume-cursor regime, which exists
precisely so a cancel banks progress, and which the stats arm apparently does not
share at window granularity.

## 5. The stats-window regression, found while gathering the above

Not part of the original question, but it is the same box and the same budget.
`entity_connection_stats_windows` units insert zero rows and do identical work
each cycle. Their cost has moved by more than an order of magnitude in three days:

| date | windows | seconds per window |
|---|---|---|
| 08-29 (windows 3–15) | 13 | **52–108** |
| 08-31 17:18–18:05 | 5 | **298–350** |
| 08-31 18:17–19:15 | 5 | **526–750** |
| 09-01 10:00 | 1 | **1,810** |

A 17–35× regression on an unchanged unit doing zero-row work. The likely driver is
`entity_connections` bloat and visibility-map decay caused by the un-gated
contracts arm rewriting the table every cycle — precisely the loop [[FIX-1118]]
closes. **This should be re-measured after FIX-1118 has had a few cycles**; if the
windows do not come back down, the regression has a second cause and needs its own
item.

## 6. Evidence table for the parked schedule-moves decision

No moves are recommended here — that decision is Cowork's. These are the inputs.

| input | value |
|---|---|
| Degraded window | 12:00–18:00 UTC (05:00–11:00 PDT), 7 hours |
| Severity | 18.5% weighted 5xx; 29.9% peak at 13:00 UTC |
| Failure mode | 8 s `service_role` statement timeout → PostgREST 500/504 |
| Blast radius | All read paths; 15+ distinct tables and RPCs |
| Binding resource | Disk I/O ([[FIX-1107]] burst budget), not memory, locks or connections |
| Total heavy-job wall clock in window | ~7.6 h of work scheduled into a 6 h window |
| Worst overrun | jobid 24 donor-rollup-refresh, 6747 s into a 3600 s slot (1.87×) |
| Peak concurrency | 3 heavy jobs (12:30–13:52) |
| Jobs cancelled by watchdog | 4 (jobids 26, 17, 12, 45×2) |
| Already-known amplifier | ec-crawl stats windows, 1,810 s/unit for zero rows |
| Constraint on any move | 05:45–09:00 UTC is the ec-crawl blackout ([[FIX-1124]]); 06:00 derived-MVs and 06:30 rule-taggers-daily already occupy the morning |
| Cheapest non-schedule lever | [[FIX-1118]] (removes ~411 s/cycle of contracts-arm writes and the stats re-dirty loop) |

The structural observation, offered without a recommendation: the Tuesday jobs are
scheduled one-per-hour as though that serialized them, but the two largest need
1h52m and 2h05m. No arrangement of hourly start times serializes work that does not
fit in an hour. The decision is therefore about **concurrency control or job cost**,
not about start times — a schedule move alone relocates the window rather than
removing it.

## 7. Instruments used

Every claim above is reproducible with one of:

- `scripts/cf-analytics.mjs --hours 24 [--by edgeResponseStatus]` — Cloudflare edge.
- Supabase Logs API, `analytics/endpoints/logs.all`, datasets `edge_logs` and
  `postgres_logs`, BigQuery dialect, `CROSS JOIN UNNEST(metadata)`.
- `node scripts/db-query.mjs --prod "…"` — `cron.job_run_details`, `data_sync_log`,
  `pipeline_state`, `pg_stat_activity`.

Note for whoever repeats this: the Logs API free-tier window is capped and
`edge_logs` retention is short, so the hour table above cannot be re-derived
indefinitely. It is transcribed here because the source expires.
