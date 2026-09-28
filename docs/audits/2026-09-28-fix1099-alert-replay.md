# FIX-1099 — the Vercel alert replay: vendor billing period vs calendar month (2026-09-28)

cc-168 D2 (ii). FIX-1099 ships **only** with this pass: replay the retained
snapshot history under both projection bases, and STOP the wiring if any day's
alert state differs.

**Result: STOP.** On the vendor basis, `vercel.included_usage_usd` changes
state on **15 of 31** replayed days. `vercel.billable_overage_usd` and
`vercel.overage_present` change on **none**. The code landed with the alert rows
still on the calendar month (`VERCEL_ALERT_BASIS = "calendar"`, `022c6345`), and
both bases are now computed every tick. FIX-1099 stays open. **The re-tune is
Craig's decision.** Nothing in `platform_limits` was touched.

Every figure below names its instrument. All prod reads went through
`scripts/db-query.mjs --prod`, which wraps the SQL in `SET TRANSACTION READ ONLY`.

---

## 1. What was replayed, and how

**Source.** `public.platform_usage_snapshot` on **prod**, read 2026-09-28
~00:40 UTC. Retention is **30 days**, not the 35 the prompt asked for:
`min(fetched_at)` = 2026-08-28 11:35:55 UTC, 1,352 rows, 1,336 of which carry
`vercel_billing`. The window crosses one calendar boundary (09-01) and one
vendor boundary (09-14 07:00Z).

**Resolution.** Vercel's charge figures step once a day at ~07:00 UTC, and
consecutive ticks within a day are identical (FIX-1041). One row per day is the
last snapshot of each `(calendar month, window_days)` group:

```sql
WITH s AS (
  SELECT fetched_at,
         (payload->'vercel_breakdown'->>'window_days')::int AS wd,
         (payload->'vercel_billing'->>'usage_mtd_usd')::numeric AS usage_mtd,
         (payload->'vercel_billing'->>'plan_base_mtd_usd')::numeric AS base_mtd,
         (payload->'vercel_billing'->>'gross_effective_mtd_usd')::numeric AS gross_mtd,
         (payload->'vercel_billing'->>'projected_usage_usd')::numeric AS proj_usage,
         (payload->'vercel_billing'->>'projected_billable_overage_usd')::numeric AS proj_over,
         (payload->'vercel_billing'->>'billable_overage_mtd_usd')::numeric AS over_mtd,
         (payload->'vercel_billing'->>'included_credit_usd')::numeric AS credit,
         payload->'cycles'->'vercel'->>'start' AS vstart,
         payload->'cycles'->'vercel'->>'source' AS vsrc,
         row_number() OVER (PARTITION BY (payload->'vercel_breakdown'->>'window_days'),
                            date_trunc('month', fetched_at - interval '7 hours')
                            ORDER BY fetched_at DESC) AS rn
  FROM platform_usage_snapshot
  WHERE payload ? 'vercel_billing'
)
SELECT to_char(fetched_at,'MM-DD HH24:MI') AS last_at, wd, usage_mtd, base_mtd, gross_mtd,
       proj_usage, proj_over, over_mtd, credit, vstart, vsrc
FROM s WHERE rn = 1 ORDER BY fetched_at;
```

The JSON keys the replay reads are `vercel_billing.{usage_mtd_usd,
plan_base_mtd_usd, gross_effective_mtd_usd, projected_usage_usd,
projected_billable_overage_usd, billable_overage_mtd_usd, included_credit_usd}`,
`vercel_breakdown.window_days`, and `cycles.vercel.{start,end,source}`.

**The calendar window is not quite the calendar month.** `getVercelUsage` sends
`from` = midnight UTC on the 1st, which is 17:00 PDT on the last day of the
previous month, so the window's first charge day is that previous Pacific day.
Window day *k* of month *M* covers the Pacific days `[last day of M−1, M/1 …
M/(k−1)]`. On 2026-09-28 00:30Z, `window_days` = 27 means Aug 31 PDT + Sep 1–26
PDT. The replay's calendar column recomputes `usage_mtd × days_in_month /
window_days` and matches every stored `projected_usage_usd` to the cent (31/31).

**The vendor cycles** come from each snapshot's own `cycles.vercel`, which is
that tick's `getVercelAccount()` read (`source: "api"`):
`2026-08-14T07:00Z → 2026-09-14T07:00Z` (31 days, Pacific Aug 14 – Sep 13) and
`2026-09-14T07:00Z → 2026-10-14T07:00Z` (30 days). Read 3 used these stored
readings rather than issuing a separate `/v2/teams/{id}` call. The latest one
(2026-09-28 00:30:31Z) reads plan `pro`, `plan_iteration` `plus`, status
`active`, subscription $20 and credit $20.

**The vendor cycle is the one Vercel bills on.** Two things in the same series
show it:
- The `Pro` subscription line accrues $20/31 a day through Sep 13 PDT
  (`plan_base_mtd_usd` 9.0323 at `window_days` 14 = 14 × 0.64516) and $20/30
  from Sep 14 PDT onward (+0.6667 at `window_days` 15). It switches at the
  vendor boundary, not on Sep 1.
- `Speed Insights Plus Events` $0.65 — a once-per-cycle fixed charge (retracted
  as an anomaly in `2026-08-15-traffic-cost-spike.md`) — first appears at
  `window_days` 15, i.e. on Sep 14 PDT, the vendor cycle's day 1. It stays flat
  at $0.65 afterwards. In August it landed on Aug 14.

**The vendor cycle-to-date, reconstructed.** Daily usage is the difference of
the cumulative calendar-window usage. For the Aug 14 cycle the replay needs the
August usage through Aug 13 PDT (`window_days` 14). That is older than
retention, so it is taken from `2026-08-15-traffic-cost-spike.md`: gross MTD at
billing day 15 = $15.19, day-15 delta = $1.8589, and Pro accrues $20/31 a day.
So `A14 = (15.19 − 1.8589) − 14 × 20/31 = $4.2988`. The source rounds to cents,
so A14 is ±$0.01; moving it by ±$0.01 moves the worst Aug-cycle vendor
projection between $24.03 and $24.07 and changes no state.

| row | vendor cycle-to-date usage | vendor days elapsed |
|---|---|---|
| August, `window_days` k | `usage_aug(k) − A14` | k − 14 |
| September, k ≤ 14 | `usage_aug(31) − A14 + usage_sep(k)` | 17 + k |
| September, k ≥ 15 | `usage_sep(k) − usage_sep(14)` | k − 14 |

`projected = cycle_to_date × days_in_cycle / days_elapsed`, the same arithmetic
`computeVercelBilling` does, with the vendor cycle's length as the divisor.

**The bands** are read 4, from prod `platform_limits`. The `pro` rows render,
because `pipeline_state.platform_plan` overrides vercel to `pro`:

| row | included_limit | warning_pct | critical_pct | fed by |
|---|---|---|---|---|
| `vercel.included_usage_usd` | 20 (usd) | 80 → $16 | 100 → $20 | `projected_usage_usd` |
| `vercel.billable_overage_usd` | 20 (usd) | 50 → $10 | 50 → $10 | `projected_billable_overage_usd` |
| `vercel.overage_present` | 1 (state) | 1 | 101 (never) | `billable_overage_mtd_usd > 0` (actual, not projected) |

`computeMetricStatus`: `pct ≥ critical_pct` → critical, else `pct ≥ warning_pct`
→ warning. The prompt named two alert rows. `included_usage_usd` is a third,
driven by the same projection, and it is the only one that flips.

**Who reads these states** (rule 103, by grep of
`billable_overage_usd|overage_present|included_usage_usd` in packages + apps):
- `emailMetricThresholdAlerts` in `api/cron/platform-snapshot/route.ts` reads
  every non-`estimated` row. All three are `source: 'api'`. It emails on
  escalation only, when `EMAIL_ALERTS_ENABLED=true`.
- `platform-costs-view.ts` builds the dashboard alert list from the bands. It
  also raises a "credit ≥ 90%" watch off `credit_used_pct` (actual) and a
  first-cent line off `billable_overage_mtd_usd` (actual). Neither flips in
  this window: the vendor Aug cycle ended at 73% of the credit, the calendar
  August at 78%.
- The route's response field `vercel_billable_overage_usd`.
- The cost roll-up (`vercelBillableUsd` → `total_monthly_usd`).
- No kill switch maps a `vercel.*` metric (`pipeline_state.kill_switches` read
  on prod).

---

## 2. The table

`cal → ven` = calendar basis (what prod computed) → vendor basis. The three
state columns are the band each basis puts the row in.

| snapshot (last, UTC) | through (PDT) | calendar day | vendor day | proj usage cal → ven | proj billable cal → ven | overage_present cal → ven | included_usage_usd | billable_overage_usd | overage_present | flip |
|---|---|---|---|---|---|---|---|---|---|---|
| 08-29 03:21 | Aug 27 | 28/31 | Aug 14 d14/31 | $16.78 → $24.05 | $0.00 → $4.05 | 0 → 0 | warning→critical | healthy→healthy | healthy→healthy | **incl** |
| 08-30 06:30 | Aug 28 | 29/31 | Aug 14 d15/31 | $16.34 → $22.71 | $0.00 → $2.71 | 0 → 0 | warning→critical | healthy→healthy | healthy→healthy | **incl** |
| 08-31 06:03 | Aug 29 | 30/31 | Aug 14 d16/31 | $16.04 → $21.75 | $0.00 → $1.75 | 0 → 0 | warning→critical | healthy→healthy | healthy→healthy | **incl** |
| 08-31 23:30 | Aug 30 | 31/31 | Aug 14 d17/31 | $15.60 → $20.61 | $0.00 → $0.61 | 0 → 0 | healthy→critical | healthy→healthy | healthy→healthy | **incl** |
| 09-02 06:30 | Aug 31 | 1/30 | Aug 14 d18/31 | $5.35 → $19.77 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-03 06:30 | Sep 1 | 2/30 | Aug 14 d19/31 | $6.61 → $19.16 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-04 06:30 | Sep 2 | 3/30 | Aug 14 d20/31 | $8.46 → $18.83 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-05 06:30 | Sep 3 | 4/30 | Aug 14 d21/31 | $8.04 → $18.27 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-06 06:30 | Sep 4 | 5/30 | Aug 14 d22/31 | $8.45 → $17.91 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-07 06:30 | Sep 5 | 6/30 | Aug 14 d23/31 | $7.89 → $17.36 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-08 06:30 | Sep 6 | 7/30 | Aug 14 d24/31 | $7.62 → $16.90 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-09 06:30 | Sep 7 | 8/30 | Aug 14 d25/31 | $8.43 → $16.80 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-10 06:30 | Sep 8 | 9/30 | Aug 14 d26/31 | $7.93 → $16.31 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-11 06:30 | Sep 9 | 10/30 | Aug 14 d27/31 | $8.19 → $16.11 | $0.00 → $0.00 | 0 → 0 | healthy→warning | healthy→healthy | healthy→healthy | **incl** |
| 09-12 06:30 | Sep 10 | 11/30 | Aug 14 d28/31 | $7.63 → $15.61 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-13 06:30 | Sep 11 | 12/30 | Aug 14 d29/31 | $7.53 → $15.30 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-14 06:30 | Sep 12 | 13/30 | Aug 14 d30/31 | $7.17 → $14.89 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-15 06:30 | Sep 13 | 14/30 | Aug 14 d31/31 | $7.16 → $14.64 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-16 06:30 | Sep 14 | 15/30 | Sep 14 d1/30 | $8.23 → $23.26 | $0.00 → $3.26 | 0 → 0 | healthy→critical | healthy→healthy | healthy→healthy | **incl** |
| 09-17 06:30 | Sep 15 | 16/30 | Sep 14 d2/30 | $7.87 → $12.85 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-18 06:30 | Sep 16 | 17/30 | Sep 14 d3/30 | $7.57 → $9.50 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-19 06:30 | Sep 17 | 18/30 | Sep 14 d4/30 | $7.42 → $8.32 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-20 06:30 | Sep 18 | 19/30 | Sep 14 d5/30 | $7.42 → $8.16 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-21 06:30 | Sep 19 | 20/30 | Sep 14 d6/30 | $7.28 → $7.56 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-22 06:30 | Sep 20 | 21/30 | Sep 14 d7/30 | $7.26 → $7.45 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-23 06:30 | Sep 21 | 22/30 | Sep 14 d8/30 | $7.34 → $7.65 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-24 06:30 | Sep 22 | 23/30 | Sep 14 d9/30 | $7.32 → $7.58 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-25 06:30 | Sep 23 | 24/30 | Sep 14 d10/30 | $7.23 → $7.33 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-26 06:30 | Sep 24 | 25/30 | Sep 14 d11/30 | $7.35 → $7.59 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-27 06:30 | Sep 25 | 26/30 | Sep 14 d12/30 | $7.49 → $7.88 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |
| 09-28 00:30 | Sep 26 | 27/30 | Sep 14 d13/30 | $8.04 → $8.99 | $0.00 → $0.00 | 0 → 0 | healthy→healthy | healthy→healthy | healthy→healthy |  |

Summary: `included_usage_usd` differs on 15 of 31 days. It goes warning →
critical on 3 of them, healthy → critical on 2, and healthy → warning on 10.
`billable_overage_usd` peaks at $4.05 on the vendor basis, 20% of its $10
page, and never leaves healthy. `overage_present` stays 0: neither basis's
actual cycle-to-date usage passed $20.

**Supplementary, outside retention — day 1 of the Aug 14 cycle.** The 08-15
audit gives Aug 14 PDT consumption as $1.2137, $0.65 of it Speed Insights.
- Vendor basis on that day: $1.2137 × 31 = **$37.62**. That puts
  `included_usage_usd` at 188% (critical) and `billable_overage_usd` at $17.62,
  88% (critical).
- Calendar basis: $5.5125 × 31/15 = $11.39. That is 57% (healthy), with $0
  overage (healthy).

Both rows flip, and `billable_overage_usd` would have paged. That day was the
crawl, so this page is arguably the one you wanted. See §3.

---

## 3. Why it flips

**(a) Linear extrapolation over a front-loaded cycle.** The Aug 14–16 crawl
sits at the start of the vendor cycle. The calendar month diluted it with 13
quiet August days (A14 = $4.30 over 14 days ≈ $0.31/day). The vendor cycle
divides it by only the days since Aug 14. The realised totals show which
projection was closer:

| basis | realised total | projections in the window | worst error |
|---|---|---|---|
| vendor, Aug 14 cycle | **$14.64** (d31 row) | $24.05 → $14.64 | +64% (d14) |
| calendar, August | **$15.60** (`window_days` 31 row) | $16.78 → $15.60 | +8% |

The vendor basis is the *right cycle*, but it is less accurate early in a cycle
that front-loads. It projects a flat rate onto a spike.

**(b) A fixed once-per-cycle charge projected ×30.** `Speed Insights Plus
Events` is $0.65 on day 1 of every vendor cycle, regardless of use. Projected
×30 it contributes **$19.50** of "month-end usage" before any metered
consumption. From the fixed charge alone, that is already past the $16 warning
band and 97.5% of the $20 critical band. Day 1 crosses 100% (critical) once its
total reaches $0.667. Sep 14's was $0.7752 (the mean metered day over Sep 1–26
PDT, fixed charge excluded, is ≈ $0.25). So on the current bands, day 1 of
every vendor cycle is at least warning and usually critical. On the calendar
basis the same charge lands mid-month and is diluted ×30/15.

**(c) Not a flip, but the re-tune should know.** For the first ~7 hours of any
window, before its first charge day closes, `/v1/billing/charges` answers
**HTTP 404 `costs_not_found`**. Prod recorded it every tick from 09-01 00:01
to 06:30 UTC at the calendar rollover. The vendor-basis read (`from` = cycle
start) will do the same for ~7 hours after each 07:00Z vendor boundary. The code
reports it as `vercel_billing_shadow: {basis: "vendor", error: …}`. If the
vendor basis ever drives the alerts, those hours fall back to the calendar
basis, and the fallback says so.

*Incidental, not investigated:* no snapshot rows at all exist from 08-31 06:03
to 23:02 UTC — a 17-hour gap in the 30-minute series.

---

## 4. The re-tune — options, not applied

The bands, not the constant, are the decision. Flip `VERCEL_ALERT_BASIS` only
together with whichever of these is chosen, then re-run this replay. The shadow
block is now accumulating the vendor-basis numbers live, so the next replay
needs no reconstruction and no audit-derived anchor.

1. **Project fixed per-cycle charges once, not ×days.**
   `projected = fixed + (usage − fixed) × days_in_cycle / days_elapsed`. This
   removes cause (b), and it is a correctness fix on either basis.
   Re-computed on the Sep 14 day 1: $0.65 + $0.1252 × 30 = $4.41 (healthy).
   It does **not** remove the Aug-cycle flips. On d14 it still reads
   $0.65 + ($10.86 − $0.65) × 31/14 = $23.26 (critical), which is cause (a).
   It needs a stated list of which services are fixed; today that is one
   (`Speed Insights Plus Events`).
2. **A minimum projection divisor**, e.g. `max(days_elapsed, 7)`. This damps
   both causes, including the Aug 14 page that caught a real crawl. It trades
   early-cycle sensitivity for stability.
3. **Move `included_usage_usd`'s bands.** The worst vendor-basis reading in
   the window was $24.05 (120%) on a cycle that ended at $14.64 (73%). No band
   separates that from a genuinely over-budget cycle on day 14, so this
   treats the symptom.
4. **Leave the alert rows on the calendar month** and use the vendor basis for
   display. That is the state this commit ships.

If a recommendation is wanted: **1 and 2 together**. Option 1 is right on
any basis. Option 2 is what makes a front-loaded cycle stop reading as an
overrun. Then re-replay against the shadow series. That is a judgement about
how early in a cycle you want to be woken, and it is yours to make.
