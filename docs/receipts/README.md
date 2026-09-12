# `docs/receipts/` — the standing reads, as a file

One file per UTC-nominal day, written by `pnpm receipts:daily` (FIX-1176) and
committed by the `receipts` job at the end of `nightly.yml`.

```
YYYY-MM-DD.md     human — every number next to the SQL that produced it
YYYY-MM-DD.json   machine — the same data, for Cowork and any tooling
bands.json        hand-edited duration bands; the script NEVER writes this
```

**Why it exists.** Most of the "reads to bank" in a Cowork prompt are the same
dozen queries every day. None of them needs a model. Once they are a file,
*receipt = the next scheduled run* becomes *receipt = tomorrow's file*, and the
standing rule about not touching prod while a receipt is being taken shrinks
from a whole session to this job's own runtime — which every file states, in its
Instrument cost table.

---

## The nominal-day rule — read this before you look for a date

**The file is named for the nightly's NOMINAL day, not for the wall clock.**

`nightly.yml`'s cron is `0 21 * * *`: it fires at 21:00 UTC on the day *before*
the run it names (FIX-1163, because GitHub applies a large near-constant offset
to this workflow's scheduled start). Each phase job carries
`NIGHTLY_SLOT_OFFSET_HOURS=3` so the orchestrator reads the day off `now + 3h`
rather than off the clock — see `packages/data/src/pipelines/weekly-gate.ts`.
The receipts file uses the same rule, so the file and the run it describes agree
about what day it is.

Concretely: the run that fires **Fri 21:00 UTC** and starts **Fri 22:54 UTC**
lands in **`2026-09-13.md`** — Saturday's file. The window that maps to nominal
day `d` is exactly `[d − offset, d + 24h − offset)`, which is the widest correct
window and covers every offset ever observed for this workflow, including the
11h51 outlier.

Two deliberate differences from `weekly-gate.ts`, both load-bearing:

| | weekly-gate.ts | receipts-daily.ts |
|---|---|---|
| default offset when the env is absent | **0** (a plain `workflow_dispatch` wants wall clock) | **3** (this file always describes a scheduled nightly; offset 0 on a hand run would put last night's 22:5x start one day outside the window and render an empty section 1) |
| projection | local `getDay()` — correct there, GHA runners are UTC | UTC `toISOString()` — a file NAME must not move with the machine's zone |

Override with `--slot-offset N`, or with `NIGHTLY_SLOT_OFFSET_HOURS` (which the
workflow sets, mirroring the phase jobs' expression exactly, so a manual
dispatch of `nightly.yml` names its file the same way the run gated).

---

## The sections

Fixed order. Every one carries its queries in a collapsed block, so a number is
never a claim without its instrument.

| # | Section | Reads |
|---|---|---|
| 1 | The nightly | slot, `createdAt`, offset, nominal day, `isWeekly`; per-phase status / duration / `peak_rss_mb` / `skip_reason` |
| 2 | pg_cron jobs vs their bands | every job in `cron.job`: last firing, duration, cron status, band, verdict |
| 3 | The 06:00 UTC daily | `units_ok`/`units`, wall, `rebuild_entity_search_index` vs its band (FIX-1152), the run's own `vm_before`, the visibility map now, and when the weekly last ran |
| 4 | Hour-04 vacuums | `ec-`/`fe-vacuum-analyze` durations — FIX-1169's series |
| 5 | FEC | `fec_drop_probe`, `fec_indiv_watermark`, `fec_bulk_run_state`, `fec_emit_runs` latest per cycle, the emit-key population |
| 6 | Interlock footprint | `prod_session_state()` now, and every `skipped` row in the last 24 h with its reason (FIX-950) |
| 7 | Canary conditions | the last `canary_check` run's keyed conditions, tier and unchanged-run counter (FIX-1036) |
| 8 | SLD linkage | total / linked / residual, and the residual by state and chamber (FIX-913 / FIX-859 / FIX-914) |
| 9 | Not capturable here | the named reads with **no SQL surface**, listed so their absence is never read as a clean check |

Section 9 is not filler. `57014` cancellation counts live in `postgres_logs`,
which the Supabase Logs API serves and SQL cannot reach; GHA step logs age out.
Saying so is the difference between "checked and clean" and "not checked".

---

## Verdicts

```
in-band | above | below | missing | skipped | no-band | failed | running
```

Precedence, and the reason for it:

1. **`skipped`** outranks everything. The FIX-950 prod-session interlock turns a
   firing into a `skipped` `data_sync_log` row *on purpose*; rendering that as
   `missing` reports an operator's correct action as a fault. This file reads
   `data_sync_log` directly so it can tell them apart — the shared freshness
   readers (`check_rollup_freshness`, `list_scheduled_rollup_pipelines`) count
   only `status='complete'` and therefore cannot. That is **FIX-1177**.
2. **`running`** — no `end_time`, so no duration to compare.
3. **`failed`** — the number is how long it took to die, not how long it took.
   A crash that died in 3 s must never read as `in-band`.
4. **`missing`** — no firing in the lookback window.
5. **`no-band`** — nobody has written down what normal is. This is **not a
   pass**. "Nobody wrote it down" and "this is normal" are different facts, and
   collapsing them is how a detector quietly stops covering what it enumerates.
6. Only then is the duration compared against the band. Both bounds are
   inclusive.

`failed` and `running` are additions to cc-123 D2's list. D2 assumed every
firing yields a duration; `cron.job_run_details.status` does not.

---

## `bands.json`

```json
{
  "rule-taggers-daily": { "lo_s": 713, "hi_s": 858, "source": "cc-prompt-118 Item 5 — stated band" }
}
```

- **Keyed by pg_cron job NAME.** Never by `jobid` — jobids differ between prod
  and the local clone and are not portable (CLAUDE.md, FIX-946).
- **A key containing `:` is a `job:unit` band**, compared against that unit's
  entry in the run row's `unit_seconds` rather than the job's wall time. Today
  there is one: `refresh-derived-mvs-daily:rebuild_entity_search_index`.
- **`source` is required.** An entry without one is ignored (the job reads
  `no-band`). An unsourced band is folklore; say where the numbers came from and
  over how many runs.
- **The script never writes this file.** Bands are a human judgement about what
  normal is; letting the job move its own goalposts is how a creep becomes
  invisible.

### Known limitation — one band per job

The schema is one band per job name, but `donor-rollup-refresh` fires twice a
day with two different expected costs (≤ 400 s at 09:00, ≈ 0 at 12:00 when there
is nothing dirty). The looser ceiling is used, so the 12:00 firing is trivially
in-band. Expressing a per-firing-hour band needs a schema change; it has not
been made because nothing has yet been missed by the loose ceiling.

### Adding a band

1. Take the measurements. `docs/receipts/*.json` is the series once a few days
   have accumulated — `jq '.cron_jobs[] | select(.jobname=="X") | .duration_s'`.
2. Add the entry with `lo_s`, `hi_s` and a `source` naming the window and `n`.
3. Commit it on its own. A band change is a claim about what normal is, and it
   should be reviewable as one.

---

## Running it by hand

```bash
pnpm receipts:daily --local --dry-run          # print, write nothing
pnpm receipts:daily --prod  --dry-run          # same, against prod (read-only)
pnpm receipts:daily --prod                     # write docs/receipts/<nominal day>.{md,json}
pnpm receipts:daily --prod --date 2026-09-10   # a specific nominal day
```

**It cannot write to the database.** The session sets
`default_transaction_read_only = on` before its first read, so a write would
fail with SQLSTATE 25006 rather than land. `statement_timeout` is 15 s per
statement and a statement that fails degrades its section rather than killing
the run — a receipts file that is 90 % present beats no file at all on the night
something is broken, which is exactly the night it is worth having.
