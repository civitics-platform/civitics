# FIX-1274 — the USASpending bucket read: publish timing, what a delta covers, the catch-up sized

**cc-191, 2026-10-04. Reads only, nothing built.** No code change, no workflow
edit and no prod write. Sources:

- the bucket listing (HTTPS GET, **04:36:01 UTC**);
- the GHA run history and run logs of `usaspending-bulk.yml` (`gh`);
- prod `data_sync_log` and `pipeline_state` (read-only, `db-query --prod`,
  04:3x UTC);
- USASpending's own site and API source (via `gh`).

Craig's call stands: **the Thu 10-08 scheduled run is the first live read** of
this FIX. §4's code shapes are the input to the build prompt after it.

## 0. Headline

- **A delta is MONTHLY and INCREMENTAL.** It holds "only new, modified, and
  deleted data since the date the last month's files were generated" (§3).
  There is one file per category, replaced each month. The bucket has held no
  delta at all for about ten days after a monthly Full refresh.
- **Nothing is lost; the September changes are late.** The 08-06 delta was
  ingested on 08-13 (baseline `20260806`). Every run from 08-20 to 09-10 saw it
  again and correctly skipped it. On 09-17 and at the 09-24 run the bucket
  held **no** delta. The 09-24 deltas landed at **19:17Z, 4 h 38 min after**
  that Thursday's run. The 10-01 run died on the FIX-1268 FY gate before the
  mode decision.
- **So the 0924 delta has never been offered to a run that could ingest it.**
  The 10-08 run, with FIX-1268's FY−1 fallback, takes it. Coverage is
  continuous from 08-06, *provided* USASpending generated it from the August
  delta's date — the inference is labelled in §3.
- **The bullet's premise is half right.** "The weekly run never sees the
  rolling delta file" is not what happened. Each run saw what the bucket held,
  and for five of those Thursdays that was the already-ingested 0806 file or
  nothing. What cost a week is the schedule (09-24); what cost the next week
  is the FY gate (10-01).
- **The waiting deltas are big.** Contracts is 1.52 GB, larger than the whole
  FY2026 Full contracts zip (1.38 GB). Assistance is 2.29 GB, 2.2× the Full
  assistance zip. Sized from July's figures, the 10-08 run could approach the
  workflow's 350-minute timeout (§5a).

## 1. The bucket now (04:36:01 UTC 10-04)

`https://files.usaspending.gov/award_data_archive/?prefix=…`. Every listing
returned `<IsTruncated>false</IsTruncated>`.

| prefix | `<Key>` | `<LastModified>` | `<Size>` (bytes) |
|---|---|---|---|
| `FY(All)_All_Contracts_Delta` | `FY(All)_All_Contracts_Delta_20260924.zip` | `2026-09-24T19:17:54.000Z` | 1,524,399,293 |
| `FY(All)_All_Assistance_Delta` | `FY(All)_All_Assistance_Delta_20260923.zip` | `2026-09-24T19:17:19.000Z` | 2,288,518,476 |
| `FY2026_All_Contracts_Full` | `FY2026_All_Contracts_Full_20260906.zip` | `2026-09-14T01:07:39.000Z` | 1,383,095,241 |
| `FY2026_All_Assistance_Full` | `FY2026_All_Assistance_Full_20260906.zip` | `2026-09-14T01:07:39.000Z` | 1,041,965,198 |
| `FY2027_All_Contracts_Full` | (no keys) | | |
| `FY2027_All_Assistance_Full` | (no keys) | | |

**There is no second publish-time data point.** The prompt expected a newer
delta by now; nine days on, the bucket still holds the 09-24 pair. The
assistance key is dated `20260923` and the contracts key `20260924`; both were
written within the same minute. Both dates are past the baseline `20260806`,
so `deltasSince` (`f.date > since`, `index.ts:272`) selects both.

Prod `pipeline_state.usaspending_bulk_state` (read 04:3x UTC; last written
2026-08-13 11:09:34Z):
`{"version": 1, "contracts": {"baseline": {"lastRunAt": "2026-08-13T11:06:21.900Z", "lastRunType": "delta", "lastArchiveDate": "20260806"}}, "assistance": {"baseline": {"lastRunAt": "2026-08-13T11:09:34.052Z", "lastRunType": "delta", "lastArchiveDate": "20260806"}}}`.
**There is no `fullInProgress` stub.** The 10-01 failure returned at the FY
check, before `startFullRun` could write one.

## 2. Publish timing vs the run

Each scheduled run's `createdAt` (the real firing; the cron is `0 10 * * 4`,
Thu 10:00 UTC), what its log says it found, and its `data_sync_log` rows
(`rows_inserted` is the pipeline's `totalUpserted`: rows written to
`financial_relationships` after the agency match and, for assistance, the
grant-type filter):

| run (createdAt, UTC) | drift | delta in the bucket then (from the log) | result (contracts / assistance) |
|---|---|---|---|
| 07-16 11:39 | 1.7 h | `…_Delta_20260706` (new since baseline `20260606`) | 1,750,478 / 646,101 — 73 + 102 min |
| 07-23 11:50 | 1.8 h | 0706, already ingested | 0 / 0 |
| 07-30 11:51 | 1.9 h | 0706 | 0 / 0 |
| 08-06 12:02 | 2.0 h | 0706 (0806 not yet visible) | 0 / 0 |
| 08-13 11:00 | 1.0 h | `…_Delta_20260806` — new | 96,292 / 37,992 — 6 + 3 min |
| 08-20 10:29 | 0.5 h | 0806, already ingested | 0 / 0 |
| 08-27 20:09 | 10.2 h | 0806 | 0 / 0 |
| 09-03 14:10 | 4.2 h | 0806 | 0 / 0 |
| 09-10 14:05 | 4.1 h | 0806 | 0 / 0 |
| 09-17 14:42 | 4.7 h | **none** ("Delta files available: 0"); the Full 0906 landed 09-14 01:07Z | 0 / 0 |
| 09-24 14:38 | 4.6 h | **none** — 0924 lands at 19:17Z, 4 h 38 min later | 0 / 0 |
| 10-01 16:53 | 6.9 h | 0924, **never examined** | `failed`: "No Full Contracts archive found for FY2027" (and Assistance) |

The publish points we have:

- the 0806 delta became visible between 08-06 12:02Z and 08-13 11:00Z;
- the 0806 delta was withdrawn between 09-10 14:05Z and 09-17 14:42Z, in the
  same window as the 09-14 Full refresh;
- the 0924 pair was written at 2026-09-24 19:17Z.

USASpending's own cadence statement: "New files are uploaded by the 15th of
each month" (§3). September's delta came on the 24th.

**One line:** deltas publish **monthly**, on an unpredictable day (the one
exact instant we have is a Thursday at 19:17Z). A weekly run sees each one
within a week of publication, and a missed week costs a week of latency rather
than data. That holds unless the run misses the delta for its whole life in
the bucket, about four weeks between its publication and the next Full
refresh. The 09-24 miss was the time of day. The 10-01 miss was the FY gate.

## 3. What a delta covers — USASpending's own words

The archive page, `https://www.usaspending.gov/download_center/award_data_archive`,
renders client-side. WebFetch returned only the title. The text below is
quoted verbatim from the page's own source component,
`src/js/components/bulkDownload/archive/AwardDataArchiveContent.jsx` in
`fedspendingtransparency/usaspending-website` (last commit `e7181c15`,
2026-08-03):

> New files are uploaded by the 15th of each month.
> Check the 'Data As Of' column to see the last time files were generated.
> There are two downloadable archive file types:
>
> - **Full files** - data for the fiscal year up until the date the file was prepared
> - **Delta files** - only new, modified, and deleted data since the date the last month's files were generated.
>   The `correction_delete_ind` column in the delta files indicates whether a record has been modified (C), deleted (D), or added (blank).

The generator agrees: `usaspending_api/download/management/commands/populate_monthly_delta_files.py`
in `fedspendingtransparency/usaspending-api` (last commit `ccff672c`,
2026-08-06). Its one required argument is `--last_date`, help text **"Date of
last Delta file creation. YYYY-MM-DD"**, and it selects
`etl_update_date >= generate_since`.

**Verdict:** a delta is **incremental from the previous month's delta**. It is
not cumulative since the last Full, and it is not weekly. It covers **every
fiscal year** (`FY(All)`), which a `FY2026_*_Full` does not.

**Inference, labelled (rule 96):** whether the 0924 delta starts exactly at
the 0806 delta depends on the operator passing `--last_date 2026-08-06` (or
-07). Nothing here can read that. Two things support it:

- No delta was visible between them in any weekly sample. The 0806 file was
  present through 09-10, and the bucket was empty on 09-17 and at the 09-24
  run.
- The 0924 contracts delta outweighs a whole FY2026 Full, which fits seven
  weeks of all-fiscal-year changes across fiscal year-end.

The 0806 delta's byte size was never recorded, so growth cannot be compared
directly. What can be compared is the CSV part count: the 0706 delta had 4
contract parts and the 0806 delta 1.

**Consequence for FIX-1274's filing question:** `deltasSince`'s
rolling-single-file assumption *works* with the bucket. Each monthly file is
taken once and the next starts where it ended, as long as a run lands inside
the file's life. Nothing is filed.

## 4. The defects as the code has them, and the smallest shape for each

1. **The Full-listing gate.** `runUsaSpendingBulkPipeline` (`index.ts:573`)
   resolves the Full listing unconditionally (`:599`). It then `failSync`s when
   that listing is empty (`:611-615`), **before** the mode decision at `:624`.
   A delta run needs only `discoverDeltaFiles`. FIX-1268's fallback to FY−1
   makes the gate pass this October, but the coupling remains: a month where
   neither FY's Full is listed still blocks a delta. **Smallest shape:** move
   `resolveFullFiles` and the empty check inside the `!baseline` arm. Delta mode
   then never lists Fulls; `fyMeta` is stamped only on full runs (or as `null`
   on delta runs).
2. **The schedule.** `cron: "0 10 * * 4"` fired 0.5–10.2 h late across these
   twelve runs (median 3.05 h, the last five 4.1–6.9 h). The one publish
   instant we have is Thu 19:17Z. **Smallest shape: `0 2 * * 5` (Fri 02:00
   UTC)**, rather than Thu 22:00Z, for three reasons:
   - 22:00Z sits on the nightly, which is dispatched at 21:00Z (FIX-1218) and
     runs ~15 min on a weekday and ~100 min on a drop night;
   - with the drift measured above, a Thu 22:00Z cron lands on Friday anyway;
   - Fri 02:00Z is clear of jobid 28 (`contract-flow-rollups-refresh`, Thu
     14:00Z, budget 9,000 s). The *current* firings (14:05–16:53Z) land
     **inside** that job's window, writing contract rows while it rolls them
     up.

   The drift-proof shape is to fire it from the gha-dispatch route like the
   nightly (FIX-1218), which gives an exact slot. With 10.2 h drift possible,
   Fri 02:00Z can still slide toward the 05:45–09:00Z blackout.

**Two observations for the build prompt** (not defects this FIX names, and not
filed):

- **The interlock.** The standalone path (`pipelines/index.ts:1398`) takes no
  part in `prod_session_state()`, the FIX-950 interlock.
- **The vacuum tail.** It ends with no `VACUUM (ANALYZE)` on
  `financial_relationships`, which CLAUDE.md's FIX-943 rule requires of a bulk
  rewrite. A 2.5M-row landing currently leans on `fr-vacuum-analyze` (jobid 38,
  daily 03:00Z).

A third, smaller one: the pipeline never reads `correction_delete_ind` (grep:
no hit under `usaspending-bulk/`). So a delta's `D` rows go through the same
path as adds and modifies, and what that writes is not established here.

## 5. The catch-up — three options, sized from §2's figures

**The figures.** Every option below is sized from these:

- **July Full** (FY2026 0606, run 28918247877, 07-08): contracts 3 parts,
  2,535,114 upserts, **126 min**; assistance 4 parts, 189,873 upserts, **9 min**.
- **July delta** (0706, 07-16): contracts 4 parts, 1,750,478 upserts, **73 min**
  (18 min/part); assistance 6 parts, 646,101 upserts, **102 min** (17 min/part).
- **August delta** (0806): contracts 1 part, 96,292, 6 min; assistance 1 part,
  37,992, 3 min.

**Parts by size (inference).** The FY2026 Full zips ran ~0.46 GB per contracts
part and ~0.26 GB per assistance part. At those ratios the 0924 contracts delta
is about 4 parts and the 0923 assistance delta about 9.

**Derived work, by FIX-1165 cost class.** It follows any landing:

| step | cost class | owner |
|---|---|---|
| the upsert into `financial_relationships` | scales with the landing | the pipeline |
| `VACUUM (ANALYZE) financial_relationships` | platform-scoped, **has an owner but not the rule's** | jobid 38 daily 03:00Z; the landing itself does none (§4) |
| the EC `_contracts` arm | platform-scoped, owned | `ec-crawl` (jobid 45, `*/15`); gated 31 d (FIX-1075), so the landing is absorbed when the gate next opens |
| `contract_agency_sector_rollup` / `contract_recipient_rollup` | platform-scoped, owned | jobid 28, Thu 14:00Z, budget 9,000 s. Its FIRST gated run is 10-08, the FIX-1255 chord receipt |
| agency staffing | platform-scoped, owned | jobid 25, Tue 00:05Z, budget 3,600 s |

| option | what it does | covers (per §3) | size | prod-write posture |
|---|---|---|---|---|
| **(a) do nothing** | the Thu 10-08 scheduled run, under FIX-1268, takes the 0924/0923 deltas in delta mode | 08-06 → 09-24, every fiscal year (inference above) | contracts ~4 parts × 18–42 min = **~75–170 min**; assistance ~9 parts × 2–17 min = **~20–150 min**. Upper total **~320 min against the job's 350-min timeout**. A delta run has no per-part resume (`fullInProgress` is Full-only), so a timeout re-runs that category from part 1 the next Thursday. Contracts and assistance keep separate baselines, so contracts would still land | unsupervised, as every Thursday has been. It lands at 14–17Z, **inside jobid 28's 14:00Z window** on the very day that job's first gated run is the FIX-1255 receipt |
| **(b) `--force` Full re-ingest of `FY2026_*_Full_20260906`** | rebuilds FY2026 from the September Full, then sets the baseline to `20260906`. The next run still takes the 0924 delta (`20260924 > 20260906`) | **FY2026 awards only**, as of 09-06. It misses every change to a pre-FY2026 award and everything from 09-06 → 09-24, both of which the delta has | contracts 3–4 parts, ~2.5–3.4M upserts, **~126–170 min**; assistance 4 parts, ~190k upserts, **~9 min**; then (a)'s delta on top | a supervised landing under the FIX-950 claim, in a weekend-night slot. Its tail is the vacuum the pipeline lacks, run by hand, and jobid 28 / the `_contracts` arm absorbing ~3M rewritten rows |
| **(c) Full re-ingest only if deltas were incremental-weekly** | the lost-weeks case: if each delta covered one week, the weeks between published deltas would exist only in a Full | §3 settles it: deltas are monthly-incremental. **There are no lost weeks, so (c) does not apply** | — | — |

## 6. Recommendation — a numbered choice for Craig

1. **Take (a): let the 10-08 run ingest the deltas.** This is cheapest, it
   covers every fiscal year, and it is already Craig's call. It owes one
   watch: whether the run fits in 350 min, and how its firing overlaps jobid
   28.
2. **Make the 10-08 overlap with jobid 28 deliberate rather than accidental.**
   Either accept that the contract-flow receipt (FIX-1255) reads a table mid-ingest, or
   read the FIX-1255 receipt against the *next* Thursday. Moving either job
   for 10-08 is a workflow edit, out of scope here.
3. **After 10-08, build §4's two shapes.** First the gate inside `!baseline`,
   then the schedule (Fri 02:00Z, or the gha-dispatch route). Fold in the
   interlock and the vacuum tail, which give a 2.5M-row landing its unpaid
   bills.
4. **Do not take (b)** unless (a) fails twice. It costs more and covers less
   (FY2026 only).
