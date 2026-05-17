# Audit — missing nightly_cron rows, 2026-05-10 to 2026-05-16

**Trigger:** PR 4 canary (`/api/cron/sync-canary-check`, FIX-234 + FIX-289) fired on
2026-05-17 reporting `{ missing_dates: ["2026-05-10","2026-05-13","2026-05-14","2026-05-16"] }`.

**Finding:** the "4 missing dates" are two distinct phenomena. Two of the four
("missing" 5/13 + 5/16) are **canary false positives** — `nightly_cron` rows
exist in `data_sync_log` but with `status='partial'`, which the canary filter
deliberately excludes. The other two (5/10 + 5/14) are real GHA cancellations
with no row written at all — different causes (60-min timeout, then 120-min
timeout). 5/17 (today) is a third real cancellation in the same family as 5/14.

---

## Per-date breakdown

Source: `gh run list --workflow=nightly.yml`, full `gh run view --log` per run,
and a direct read of prod `data_sync_log` over 2026-05-09 → 2026-05-17.

| Date | GHA run id | event | GHA conclusion | Duration | data_sync_log row | Root cause |
|---|---|---|---|---|---|---|
| 5/10 Sun | 25620953888 | schedule | **cancelled** | ~60 min | none | `timeout-minutes: 60` (workflow value at the time of this run; commit `e6464187` raised it to 120 later on 5/10) |
| 5/13 Wed | 25781020545 | schedule | success | 30 min | `status=partial`, 2 rows actually (one from a separate 02:59 invocation, 9.75-hour duration with `fetch failed` errors — admin-trigger or local manual run) | canary filter `.eq("status","complete")` excludes `partial` |
| 5/14 Thu | 25844219910 | schedule | **cancelled** | exactly 120 min 27s | none | `timeout-minutes: 120` hit while `rebuild_entity_connections` per-chunk loop was still running; process SIGTERM'd before reaching the completion-write |
| 5/16 Sat | 25953866556 | schedule | success | 68 min | `status=partial`, 1 row | canary filter — same as 5/13. Only the `donations` chunk failed (statement_timeout); other chunks succeeded |
| 5/17 Sun (today) | 25982781593 | schedule | **cancelled** | 120 min | none (plus a stranded `littlesis` row at `status=running` from 07:27 UTC; will be reaped by FIX-255 on next nightly run) | same as 5/14 |

The 5/13 02:59 row is a sideshow (probably an admin "run pipeline" trigger or
Craig's manual `data:nightly` invocation that got `fetch failed` from a
flaky network at that time). It does not change the conclusions — it just
underscores that 5/13 had **two** partial rows the canary missed.

---

## Common-cause summary

### Single cause for 5/13 + 5/16 (canary false positives)

[`packages/data/src/pipelines/index.ts:1022`](packages/data/src/pipelines/index.ts#L1022):

```ts
const status = results.errors.length === 0 ? "complete" : "partial";
// ...
await db.from("data_sync_log").insert({
  pipeline: "nightly_cron",
  status,                       // "complete" OR "partial"
  ...
});
```

[`packages/data/src/scripts/canary-check.ts:60-65`](packages/data/src/scripts/canary-check.ts#L60-L65):

```ts
const { data, error } = await db
  .from("data_sync_log")
  .select("started_at, completed_at")
  .eq("pipeline", PIPELINE_NAME)
  .eq("status", "complete")     // ← excludes "partial"
  .gte("started_at", since.toISOString());
```

The canary's question is "did the nightly run at all?" The answer for 5/13 and
5/16 is yes — both wrote rows. The exclusion of `partial` reduces the canary
from "did it run?" to "did it run cleanly?" — those are different questions
and conflating them produces a false alarm every time `rebuild_entity_connections`
hits a statement_timeout (which happens roughly weekly on the chunked rebuild).

### Two related causes for 5/10 + 5/14 + 5/17 (real cancellations)

- **5/10:** old `timeout-minutes: 60` (commit history confirms it was raised to
  120 in commit `e6464187` later that day). USASpending Sunday block alone
  consumed ~52 minutes of the budget before CourtListener 429s pushed it over.
  Effectively resolved by the timeout raise — but see 5/14.

- **5/14 + 5/17:** `timeout-minutes: 120` is also too tight. The per-chunk
  `rebuild_entity_connections` model (FIX-254) has each chunk inheriting
  Postgres's `statement_timeout` (~2700s = 45 min). The 5/14 log shows:
  - donations chunk → 45-min `statement_timeout` (FAILED in 2700.2s)
  - votes chunk → 45-min `statement_timeout` (FAILED in 2700.8s)
  - cosponsors, appointments, etc. then run sequentially
  - process SIGTERM'd at 120-min wall clock before the AI-tagger / completion-write
    block could execute

  So even though FIX-254 fixed the OOM, it surfaced a new failure mode where
  the rebuild's total wall-clock budget exceeds the workflow budget on busy days.

### No-runs-stuck-blocking-other-runs

`gh run list` over the window shows no queued / waiting runs. `cancel-in-progress: false`
on the concurrency group never caused a queue.

### Reaper is fine

`FIX-255: reap_stale_sync_log` is wired in [packages/data/src/pipelines/index.ts:402-416](packages/data/src/pipelines/index.ts#L402-L416)
with `stale_minutes: 60`. The 5/17 stranded `littlesis` row will be reaped at
the next nightly run (whenever that succeeds in reaching the reaper). No reaper
fixes needed.

---

## Confidence

- 5/13 + 5/16 canary false positive — **high confidence**, code path proven and
  prod rows queried directly.
- 5/10 60-min timeout — **high confidence**, git history + run duration match
  exactly.
- 5/14 + 5/17 120-min timeout — **high confidence**, run durations (2 hr 0 min 27s
  for 5/14 and 2 hr 0 min for 5/17) match the `timeout-minutes: 120` limit
  precisely, and the rebuild_entity_connections chunk timings (2700s × 2 chunks)
  explain where the wall clock went.

---

## Recommended remediation (not implemented — report-only per instructions)

1. **Canary filter fix** — replace `.eq("status","complete")` with
   `.in("status",["complete","partial"])` (or drop the status filter
   altogether). This is the lowest-risk fix and resolves 2 of the 4 reported
   missing dates immediately. If we want to keep an alert for "ran but had
   errors," it should be a separate, lower-severity signal — not folded into
   the same channel as "didn't run at all."

2. **Statement_timeout for rebuild chunks** — the `rebuild_entity_connections_donations`
   chunk is the long pole; it's hitting `statement_timeout` every time
   (5/13, 5/14, 5/16). Either raise the chunk's `statement_timeout` to a value
   that lets it actually complete (current 45-min cap means it always errors
   on busy nights), or split donations further (per cycle? per state?).
   This is a code change in the rebuild SQL — not the workflow.

3. **Workflow timeout-minutes / split** — even with the chunk fix, the
   end-to-end nightly is creeping toward 120 min on Sundays (5/15 = 58 min,
   5/16 = 68 min, 5/9 = 24 min — but 5/13 = 30 min, 5/14 hit 120 min, 5/17
   hit 120 min). Two options: raise `timeout-minutes` to 180; or split
   `rebuild_entity_connections` into its own GHA workflow that runs after the
   data ingestion completes. The split is the cleaner architecture but more
   churn. Probably worth pairing with #2.

4. **Hard-kill resilience for completion-write** — when GHA SIGTERMs the
   process at the workflow timeout, no row is written, so the canary fires
   even though the actual nightly partially succeeded. Add an `if: always()`
   step in `nightly.yml` after `Run nightly sync` that writes a "killed by
   workflow timeout" row to `data_sync_log`. Then the canary sees something
   and downgrades to a "partial" alert rather than "nightly never ran." This
   converts 5/14 and 5/17 from "true missing" into "ran but killed," which
   is a more honest signal.

---

## Out of scope for this audit

- Changing the nightly schedule, runner size, or workflow split (those are
  remediation moves above — pending decision before implementation).
- Reworking `runNightlySync` error handling beyond #4.
- Touching the canary itself — it did its job (it correctly detected 5/10 and
  5/14 and 5/17; the false positives on 5/13/5/16 are a filter bug, not a
  design flaw in the canary's existence).
