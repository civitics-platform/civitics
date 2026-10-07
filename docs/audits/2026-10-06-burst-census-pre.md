# FIX-1125 burst census — observation one: the pre-move ring (cc-202)

**Instrument.** Upstash ring `civitics:box_health:mem` via `data:box-health:series --hours 24 --json`, read **2026-10-07T23:44:10Z**. No Postgres. Saved whole as `2026-10-06-burst-census-ring-pre.json` (rule 24). The file name carries the census design's date because cc-203 reads it by that name. **The samples are 10-07's:** 687 rows, 00:50:22Z → 23:42:22Z, 0 gaps. The ring holds nothing from 10-06 16:04Z to 10-07 00:50Z, which is the wedge ([[FIX-1284]]). Profile: `node scripts/box-health-minute-profile.mjs <ring.json> [--after <ISO>]`.

**Stamps.** `route_at` sits at :x2:22.12–:x2:23.00 on every sample (median 22.26 s), e.g. `10:02:22.186Z`, `11:02:22.236Z`, `12:02:22.524Z`. A row's rate is backward over the previous sample, so the ":02" row covers **:00:22 → :02:22**. The owner fires at :00/:30.

**Minute-of-hour profile** (pages/s; Δavail = mean MemAvailable change from the previous sample, MB):

| min | n | swap-in mean | median | max | swap-out mean | median | max | Δavail |
|---|---|---|---|---|---|---|---|---|
| :02 | 23 | **399.7** | **335.7** | 1,675.7 | 283.1 | 125.7 | 1,671.9 | −103.8 |
| :32 | 23 | **331.2** | **295.0** | 778.0 | 292.2 | 179.1 | 1,117.8 | −65.8 |
| :08 | 23 | 200.0 | 6.0 | 3,484.9 | 175.5 | 0 | 3,168.9 | −5.9 |
| :38 | 23 | 14.2 | 9.6 | 44.6 | 1.3 | 0 | 16.0 | −11.2 |
| :16 | 23 | 94.9 | 16.4 | 906.8 | 69.2 | 0.3 | 923.3 | −7.6 |
| :46 | 22 | 42.4 | 16.3 | 404.2 | 28.1 | 0 | 246.9 | −8.8 |
| other | 550 | 59.3 | 17.7 | 3,344.3 | 75.7 | 0.4 | 3,187.6 | +8.2 |

**The signature is present.** At :02/:32 the medians are 335.7/295.0 against ≤ 46 at every other minute. 45 of the 46 :02/:32 samples read above 170; the exception is 01:02Z at 34.2. The cc-192 shape (mean ≥ 240 there, < 120 elsewhere) holds except at :04–:12, where the means run 126.7–201.2 but the medians run 6.0–43.8. One event inflates those means: 02:04–02:18Z, peaking at 3,484.9 at 02:08:22Z with MemAvailable at 180 MB at 02:14 (the day's minimum).

**For cc-203:** the :08 pre-move MEAN (200.0) is that one event, not a background level. Compare :08/:38 by **median**, or exclude 02:00–02:20Z. :38 (mean 14.2, median 9.6) is the clean comparison.

**Lead or lag.** Nothing leads. The sample before each burst is flat: swap-out 6–31 pages/s, Δavail −18 to −27 MB. On the burst sample, MemAvailable falls together with the swap-in.
- When there is headroom (15 of 46 slots, swap-out < 50), MemAvailable falls 146 MB with no swap-out.
- When there is not (31 of 46), swap-out roughly matches swap-in and MemAvailable falls 55 MB.

That shape fits **an allocator**: something takes about 50–150 MB at :00/:30 and pages its own cold memory back in. It does not fit a reader after a steady leak, which would show swap-in with no MemAvailable drop.

**The nightly in the same ring.** 21:02–21:14Z read 590.5–946.7 pages/s (21:02 740.7, 21:08 946.7, 21:12 590.5, 21:14 615.9). That burst sits in the first minutes after the 21:00Z slot. It matters for the receipts window: see cc-202's report and the FIX filed there.

**Read 3: `status_snapshot`'s own clock (prod, one read, 2026-10-07 ~23:50Z, 48 rows).** The columns are `fetched_at` (the insert's `NOW()`, so the END of the compute), `query_time_ms` (the whole `computeStatusPayload` wall), `section_times` (per-section walls in ms, plus `self_tests:<op>` and `derived_drift:<rule>` sub-keys) and `error`. **There are per-section walls but no start stamp.** The start is approximately `fetched_at − query_time_ms`.

The route runs `writePlatformUsageSnapshot` first and `writeStatusSnapshot` second (`route.ts:543-544`). The status half therefore starts at :x0:26–:x1:14 and ends by :x1:30, entirely inside the :00:22→:02:22 sample. Three rows:
- `2026-10-07 23:31:01.056Z`: 5,561 ms, starting about 23:30:55. pipelines 5,554, self_tests 4,687, ai_costs 3,557, connection_types 0.
- `2026-10-07 23:00:54.040Z`: 8,095 ms, starting about 23:00:45. self_tests 8,089, pipelines 7,034, ai_costs 5,507, quality 2,617.
- `2026-10-07 08:01:30.511Z`: 49,756 ms, starting about 08:00:40. self_tests 49,750, ai_costs 49,360, pipelines 6,278.

From 01:01Z to 16:31Z self_tests/ai_costs ran 35–50 s; from 17:00Z they ran 4.7–11 s. FIX-328's `connection_types` long pole now reads 0–125 ms. The status_snapshot has no rows from 10-06 16:01Z to 10-07 01:01Z, which is the same dark window as the ring.
