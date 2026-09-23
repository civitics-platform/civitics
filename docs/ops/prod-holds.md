# Prod holds — the three mechanisms, and which one to reach for

**FIX-950, 2026-09-11.** Three things in this platform can tell a writer to
stand down. They have three different scopes, three different lifetimes and,
until now, no shared documentation. This file is that documentation. It does
**not** merge them — merging would mean retiring a deploy-time control and a
runtime one into each other, and they answer different questions — it makes
them legible.

Precedence is trivial and intentional: **any of the three held ⇒ the consumer
skips.** There is no ordering to remember because there is no case where one
overrides another.

---

## 1. `prod_supervised_session` — a human is on the box

| | |
|---|---|
| **Scope** | Every guarded pg_cron procedure (20, table below) + the nightly's writer phases |
| **Lifetime** | Exactly as long as a process holds a Postgres connection. No TTL. |
| **Who sets it** | `pnpm --filter @civitics/data session:claim-prod`, or any of the five FR-rewrite landing scripts, automatically |
| **Reader** | `public.prod_session_state()` |
| **Visible in** | `/admin/pipeline-health` banner, the nightly canary's meta row, every deferred firing's `data_sync_log.metadata.skip_reason` |

This is the one FIX-950 added, and the one to reach for when you are landing a
migration, applying a remediation manifest, or otherwise going to be writing
prod by hand for a while.

### How to claim

```bash
# A session that is not a script — a migration push, a manual investigation.
pnpm --filter @civitics/data session:claim-prod --reason "FIX-954 set 3 apply" --minutes 90
# …work…
# Ctrl-C releases.

# Against the local clone instead (the active .env.local), for a walk-through:
pnpm --filter @civitics/data session:claim --reason "clone walk-through" --minutes 10
```

The five FR-rewrite landing scripts — `remediate-role-ineligible-holders`,
`remediate-cross-person-misattribution`, `remediate-fec-emit-residue`,
`remediate-bound-cross-person`, `merge-same-person-official-dupes` — claim for
you. You do not run `session:claim-prod` first; doing so would make the script
refuse (see below). They claim around their **whole** `main()`, dry runs
included, because FIX-1165 Rule 1 established that the DERIVATION is the
expensive half: the 2026-09-07 dry run cost 81 minutes and 132 of that day's 202
statement cancellations without writing a row.

### There is no `session:release-prod`, deliberately

A release verb implies detached state that can outlive the thing that set it,
and that in turn implies a TTL, a reaper, a "did someone forget to release?"
check, and eventually a stale-hold incident. **The hold IS the process.** To
release it, stop the process; if the process dies, Postgres drops the
session-scoped advisory lock with the backend.

The one residue a crash can leave is the `pipeline_state.prod_session` **label**
— which is documentation, defers nothing, shows as `prod_session_label_stale` in
the canary, and is overwritten by the next claim.

### The preflight refuses; `--force` overrides one of the two refusals

| Refusal | Meaning | `--force`? |
|---|---|---|
| `writers-live` | One of the guarded procedures holds its own advisory lock, the FEC pipeline lock is held, or a nightly phase has an open `running` row younger than 6 h | **Yes** — recorded as `forced_over` in the label |
| `session-held` | Another supervised session holds the box | **No, ever.** Two supervised sessions is the precise thing the lock prevents |

This is rule 43's first clause ("no concurrent heavy reads during a supervised
run") moved out of prompt prose and into code.

### Running a guarded procedure UNDER the claim (FIX-1213)

Until FIX-1213, claiming and then CALLing a guarded procedure deferred **your
own** CALL: `defer` was `held`, and `held` is "does ANY backend hold the lock",
so the procedure's guard logged `skipped` with `prod session held: …` at the
operator who had claimed precisely in order to run it (cc-146 §4). The lock
lives on a private connection inside the claim, so a pid match cannot fix it;
what the CALL's own backend can carry is a session GUC.

```sql
-- On the connection that will CALL, AFTER the claim is held.
-- Each line its OWN statement — never one multi-statement string.
SET civitics.prod_session_claimant = '<the claim reason>';
SELECT public.prod_session_state();   -- expect defer=false, claimant_bypass=true
CALL public.<guarded procedure>();
```

```bash
# The same, through db-query (the claim is held in another terminal):
node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
  --claimant "FIX-NNN landing" "CALL public.refresh_donor_party_rollup_incremental();"
```

- `prod_session_state()` returns `defer = held AND the GUC is unset`, plus
  `claimant` (the value) and `claimant_bypass` (`held AND set`). `reason_text`
  reads `prod session held by this claimant: <value>` — the string a guard would
  have written, so a bypassed defer is visible.
- **`held` is unchanged.** The claim preflight reads it, so a second claim is
  still refused from a backend with the GUC set. The GUC bypasses the DEFER,
  never the claim.
- **Everyone else still defers.** A pg_cron firing is a fresh bgworker session;
  the nightly reads `defer` on its own connection; neither sets the GUC.
- **Separate statements, SET in front.** A multi-statement string is an
  implicit transaction block, and a procedure that COMMITs dies at its first
  COMMIT (FIX-1128). The guard reads the GUC when the procedure starts, so the
  SET must precede the CALL on the same connection (rule 109).
- **An operator affordance, not a security boundary.** Any role can set a
  `civitics.*` placeholder, but EXECUTE on every guarded procedure is
  `{postgres, service_role}` and only `postgres` opens direct-pg sessions. That
  role could already run an unclaimed CALL — strictly worse, because nothing
  else would stand down.
- `session:wait-for-gate --then "<cmd>"` (FIX-1215) claims, then runs the
  command with `CIVITICS_PROD_SESSION_CLAIMANT` set; `db-query.mjs --call` reads
  that variable when `--claimant` is not given.

### What it does NOT stop

- **The Phase 1 daily ingest** (Regulations.gov, Congress.gov, the OpenStates
  bulk-people refresh, the EDGAR 13D/G poll). Deliberate: these are the
  platform's primary data intake, they are watermarked or upserted so a missed
  night is re-collected by the next one, and the whole fec phase took 3m50s on
  prod on 2026-09-11. Costing a day of congressional votes to save four minutes
  of contention is the wrong trade. What the hold *does* stop is derived and
  re-derives itself on its next firing.
- **The FEC drop probe.** It is a HEAD plus one `pipeline_state` write, and
  FIX-1166 escalates when it goes stale — so skipping it would make every
  supervised session a `probe-missing` true positive.
- **The `*/2` watchdogs** (`enforce_cron_job_budgets`,
  `enforce_derived_mvs_unit_budget`). A session must not disarm the thing that
  cancels runaway jobs.
- **The twelve VACUUM jobs.** A top-level `VACUUM` is not a procedure and cannot
  branch.
- **`refresh_platform_counts`, `purge_abuse_events`, the canary.**
  Observational; a session must not blind the instruments.

### A long hold no longer trips a freshness report — the session holds the guarded set

**Changed by FIX-1177 / FIX-1172 (cc-133).** Before that, this section warned
that a hold past ~48 minutes would be reported stale. It no longer will, for the
guarded pipelines.

`check_rollup_freshness()` and `list_scheduled_rollup_pipelines()` both count
only `status='complete'` (FIX-1140), so a `skipped` firing correctly does **not**
advance the freshness clock. That is still the honest reading — nothing happened.
What changed is that `claimProdSession()` now writes `held_since` /
`hold_reason` into `rollup_watch_overrides` for every **guarded** pipeline for
the duration of the session, and `list_scheduled_rollup_pipelines()` NULLs both
`report_after_hours` and `escalate_after_hours` on a held pipeline. So the
thresholds below are suppressed while a session holds the box, and restored the
moment it releases.

The thresholds are still the measured facts, and still what applies the instant
a hold ends (prod, 2026-09-11):

| Pipeline | cadence | reports after | escalates after |
|---|---|---|---|
| `financial_entity_totals_refresh` (fe-crawl) | 0.50 h | **0.8 h** | 1.3 h |
| `entity_connections_rebuild` (ec-crawl) | 7.75 h | 11.6 h | 19.4 h |
| `donor_rollup_refresh` | 12 h | 18 h | 30 h |
| everything else | ≥ 24 h | ≥ 36 h | ≥ 60 h |

**Which pipelines get held: the guarded set only** — the ones whose writer
procedure consults `prod_session_state()`, derived at claim time from
`cron.job.command` → the procedure → its `data_sync_log` pipeline literal
(`packages/data/src/lib/cron-job-pipelines.ts`, shared with the receipts file).
Sixteen rows get written today: seventeen guarded pipelines minus
`entity_connection_stats_rebuild`, which carries a `retired_at` and is left
alone by the upsert.

A GHA-driven or Vercel-driven pipeline is **not** held, and that is the point: a
hold cannot make one of those late for its own reasons, so suppressing its
threshold would turn the hold into a blindfold rather than a mute.

Two holds are never overwritten by a session: a row with `retired_at` set (the
`not_both` CHECK forbids holding it, and it reports nothing anyway) and a row
somebody **already** holds — a human's stated reason is the one an operator
needs to see.

### `prod_session_hold_stale` — a hold that outlived its session

A hold suppresses instruments, so a hold nobody is behind has blinded them. The
nightly canary reports `prod_session_hold_stale` (tier `report`, never
`escalate`) when `rollup_watch_overrides` carries session-prefixed holds and
`prod_session_state()->>'held'` is false. The detail names the pipelines and the
age of the oldest hold.

It happens when a claim is killed hard — SIGKILL, a `process.exit()` from inside
a landing's `main()`, the machine going away. The advisory lock dies with the
backend; the rows do not.

Three things clear it, and you rarely need to do anything:

1. **A normal release** clears the holds it set, then drops the lock.
2. **The next claim** sweeps leftovers *before* its own preflight and says so
   (`swept N leftover hold(s) from a session that did not release`). So the
   blind window is bounded by "until somebody claims again".
3. **By hand**, if neither is coming soon — claim and release, which is
   `pnpm --filter @civitics/data session:claim --reason "clearing a stale hold"
   --hold-seconds 5`.

A hold a **human** declared is not counted by this finding and is never cleared
by a release. The discriminator is the `hold_reason` prefix
`prod session held: `, which is the same prefix the guard procedures write into
`skip_reason` — so one `LIKE 'prod session held:%'` finds every artefact a
session caused, the deferred firings and the threshold suppressions together.

Session-created rows that end up declaring nothing (no hold, no retirement, no
asserted cadence) are deleted on release, so `rollup_watch_overrides` stays a
table of human decisions rather than a residue of sessions.

---

## 2. `FEC_NIGHTLY_BULK_DISABLED` — the deploy-time env flag

| | |
|---|---|
| **Scope** | `fec_bulk` on the nightly path only. Nothing else. |
| **Lifetime** | Indefinite, until someone edits the workflow and pushes |
| **Who sets it** | An `env:` line in `.github/workflows/nightly.yml` |
| **Reader** | `FLAGS.FEC_NIGHTLY_BULK_ENABLED` → `pipelines/fec-hold.ts` |

FIX-995/FIX-998. The ingest runs via `fec-backfill.yml` `workflow_dispatch`
while it is set. Re-enable by deleting the env line. The module exists because
fec_bulk has three independent triggers that hand off to each other, so a guard
on one branch was not a guard — see `fec-hold.ts`'s header.

Under FIX-950 the nightly's fec chain is held by **`flag OR session`**, one OR,
and the log line says which of the two stopped it.

---

## 3. `pipeline_state.kill_switches.cron` — **removed by FIX-1173 (cc-133)**

There is no `cron` kill switch. It was removed from `KillSwitchName`, from
`ENV_RULES`, and from the admin route's `ALLOWED_NAMES`, and `FLAGS.CRON_ENABLED`
was deleted.

Why it went rather than being made real: it was flippable from
`/api/admin/kill-switches` alongside switches that DO work, and read by nothing.
`isKillSwitchEnabled(db, "cron")` was never called; `FLAGS.CRON_ENABLED` had zero
consumers. So an operator who flipped "cron" off expecting the platform's
scheduled work to stop would have been wrong, would have got no feedback saying
so, and would then have been surprised by a rollup rebuild landing mid-incident.
A dead switch that looks live is worse than no switch.

**`CRON_DISABLED` remains the env-only control for the two Vercel cron routes
and nothing else:**

- `apps/civitics/app/api/cron/nightly-sync/route.ts`
- `apps/civitics/app/api/cron/notify-followers/route.ts`

Both read `process.env["CRON_DISABLED"] === "true"` directly. It does not affect
the GitHub-Actions nightly and it does not affect a single one of the 38 pg_cron
jobs.

**A real platform-wide cron stop does not exist and was deliberately not built
here.** FIX-1173's options (b) "make it real by having the pg_cron guard family
consult it the way they consult `prod_session_state()`" and (c) "rename it to
what it gates" are both out of scope: (b) is a genuine design decision about
whether an indefinite operator-level platform-wide stop should exist at all,
which is a different question from removing a switch that never worked. What
exists today for stopping scheduled work is section 1 — claim the box — which is
bounded by a live process rather than by somebody remembering to undo it.

**The data was NOT migrated.** Prod's `pipeline_state.kill_switches` row still
carries a `cron` key, and `kill_switch_events` still carries its flip history.
Rewriting a JSONB blob to satisfy a TypeScript union is a schema change in
service of a type, and the history rows would survive either way. Instead the
union is enforced at the parse boundary: `filterKillSwitchesMap()` in
`packages/db/src/kill-switches.ts` drops keys outside the union, so the retired
key never reaches typed code. Any new reader of that map must filter, not cast —
`auto-trip-evaluator.ts` iterates the keys, and its cast to `KillSwitchName` was
only ever true because of this filter.

---

## The guarded set

Read from prod `cron.job` and `cron.job_run_details` on 2026-09-11. "Mean" is
across every retained successful run.

| Procedure | jobid(s) | job name(s) | schedule | mean | lock | guarded |
|---|---|---|---|---|---|---|
| `refresh_derived_mvs` | 9, 10 | refresh-derived-mvs-daily / -weekly | `0 6 * * *`, `47 0 * * 2` | 1300 s / 1943 s | session | ✅ |
| `run_entity_connections_rebuild` | 45, (2, 22 inactive) | ec-crawl | `*/15 * * * *` | 56 s (max 2114 s) | session | ✅ |
| `run_fe_totals_crawl` | 46 | fe-crawl | `*/30 * * * *` | 71 s (max 1579 s) | session | ✅ |
| `run_rule_taggers` | 11, 12 | rule-taggers-daily / -weekly | `30 6 * * *`, `0 16 * * 2` | 836 s / 3717 s | session | ✅ |
| `donor_rollup_rebuild_bulk` | 24 | donor-rollup-refresh | `0 9,12 * * *` | 2704 s | session | ✅ |
| `refresh_official_donor_rollup_incremental` | — (called by 24) | — | — | — | session | ✅ |
| `refresh_donor_party_rollup_incremental` | 17 | donor-party-rollup-refresh | `0 15 * * 2` | 387 s | session | ✅ |
| `refresh_financial_entity_totals_incremental` | 13 (inactive) | financial-entity-totals-incremental | `0 10 * * 2` | 1596 s | session | ✅ |
| `refresh_sector_affinity_from_tag_changes` | — (called by the tagger) | — | — | — | session | ✅ |
| `refresh_treemap_individuals_global` | 26 | treemap-individuals-global-refresh | `0 14 * * 2` | 1408 s | session | ✅ |
| `rebuild_entity_connection_stats` | 16 (inactive) | entity-connection-stats-rebuild | `0 16 * * 1,3` | 6026 s | session | ✅ |
| `refresh_agency_staffing_rollup` | 25 | agency-staffing-rollup-refresh | `5 0 * * 2` | 509 s | session | ✅ |
| `run_group_donor_rollup_refresh` | 49 | group-donor-rollup-refresh | `10 3 * * 3` | 56 s | **xact** | ✅ |
| `rebuild_official_vote_stats` | 27 | vote-stats-refresh | `30 3 * * *` | 37 s (full rewrite) | **xact** | ✅ |
| `refresh_contract_flow_rollups` | 28 | contract-flow-rollups-refresh | `0 14 * * 4` | 2393 s | **xact** | ✅ |
| `reconcile_donation_edge_orphans` | 23 | donation-edge-orphan-sweep | `30 11 1 * *` | 152 s | session | ✅ |
| `reconcile_donor_party_rollup_orphans` | 18 | donor-party-rollup-orphan-sweep | `0 13 1 * *` | 162 s | session | ✅ |
| `reconcile_donor_rollup_orphans` | 15 | donor-rollup-orphan-sweep | `30 12 1 * *` | 1708 s | session | ✅ |
| `reconcile_entity_connection_stats_orphans` | 19 | entity-connection-stats-orphan-sweep | `30 13 1 * *` | 923 s | session | ✅ |
| `reconcile_financial_entity_totals` | 14 | financial-entity-totals-reconcile | `0 12 1 * *` | 203 s | session | ✅ |
| `refresh_platform_counts` | 48 | platform-counts-daily | `53 3 * * *` | 69 s | xact | ❌ observational |
| `purge_abuse_events` | 29 | abuse-events-retention | `15 4 * * *` | 0 s | session | ❌ retention |
| `enforce_cron_job_budgets` | 44 | cron-job-budget-watchdog | `*/2 * * * *` | 0 s | — | ❌ must not be disarmed |
| `enforce_derived_mvs_unit_budget` | 40 | derived-mvs-unit-watchdog | `*/2 * * * *` | 0 s | — | ❌ must not be disarmed |
| *twelve `VACUUM (ANALYZE)` jobs* | 6, 30–39, 47 | `*-vacuum-analyze` | various | 1–134 s | — | ❌ cannot branch |

The inactive jobs (2, 13, 16, 22) are guarded anyway: a job that is re-enabled
later must not silently be outside the interlock.

**The xact-lock three** (`group_donor_rollup_refresh`,
`official_vote_stats_rebuild`, `contract_flow_rollups_rebuild`) hold their
advisory lock only for the duration of their transaction, so they appear in
`prod_session_state()->'live_writers'` exactly while they are running — which is
the correct reading, not a gap.

---

## What a deferred firing looks like, and what recovers it

```
pipeline        | status  | metadata->>'skip_reason'
----------------+---------+------------------------------------------
fe-crawl's      | skipped | prod session held: FIX-954 set 3 apply
  pipeline name |         |
```

plus `metadata->>'held_by'` naming the claimer, and `metadata->>'source' =
'pg_cron'`. The nightly writes the identical `skip_reason` spelling from
TypeScript (`prodSessionHoldReason()` in `packages/data/src/pipelines/nightly-hold.ts`),
which is what lets one prefix — `skip_reason LIKE 'prod session held%'` — find
both mechanisms' skipped firings.

**Nothing re-fires them.** A firing skipped because a human held the box is
missed exactly like a `job startup timeout` firing, and FIX-1137's re-fire (with
its eligibility table) is the mechanism that would recover it. This design
deliberately did not build a second one. The skip rows carry the reason so 1137
can key on them.

---

## Cross-references

`packages/data/src/lib/prod-session.ts` · `packages/data/src/lib/session-lock.ts`
· `packages/data/src/pipelines/nightly-hold.ts` ·
`packages/data/src/pipelines/fec-hold.ts` ·
`supabase/migrations/20260911000000_fix950_prod_session_state.sql` and the two
guard migrations beside it · `supabase/tests/verify_fix950.sql`,
`verify_fix950_guards.sql`.

FIXES: 950 (this), 1067 (the lock shape), 998 (the fec chain's `held`), 1011 /
1135 (the census), 1140 (only `complete` advances freshness), 1137 (re-fire),
1165 (what two writers on one disk costs), 462 (the nightly's `running` row).
