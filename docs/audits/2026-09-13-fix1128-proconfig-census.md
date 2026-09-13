# FIX-1128 — the `statement_timeout` proconfig census

Companion to [`2026-09-13-fix1128-proconfig-census.tsv`](2026-09-13-fix1128-proconfig-census.tsv),
regenerated from `pg_proc` on 2026-09-13 (UTC) at `67077b2b`, not copied from
the design doc.

## The count is 91, not 89 or 90

| source | count |
|---|---|
| the FIX-1128 bullet, when filed | 89 |
| the design of record, §1 | 90 |
| **measured, clone and prod, 2026-09-13** | **91** |

The design's own prose implies 91 — it says 89 at filing plus
`derive_nh_floterials` (FIX-914) and `revoke_grant` (FIX-928/1167) landing
since — and then states the total as 90. 91 is what `pg_proc` says.

All 91 are `prokind = 'f'`. **Zero procedures carry the pattern**, and
experiment 2 shows why that is structural rather than lucky: a procedure with
any `SET` clause cannot execute `COMMIT`, so the pattern and the repo's
COMMITting procedures are mutually exclusive by construction.

## Clone and prod are byte-identical

The same query was run against the local clone and against prod (read-only).
The two CSVs diff clean — same 91 rows, same identities, same claimed values,
same remaining proconfig entries, same `anon`/`authenticated`/`service_role`
EXECUTE matrix. No migration drift, so nothing to file on that count.

## Classes

Assigned from evidence — in-DB callers from `pg_proc.prosrc`, EXECUTE grants
from `has_function_privilege`, trigger use from `pg_trigger`, call sites from
the repo tree — not from the design's example lists.

| class | n | what decides the real bound |
|---|---:|---|
| **A** — request path, granted to `anon` and/or `authenticated` | 24 | the impersonated role's timeout: 3 s (anon) / 8 s (authenticated) |
| **B** — `service_role` only, reached through PostgREST `.rpc()` | 21 | measured — see the probe in the bounds table; **not** 8 s |
| **C1** — called from a procedure that COMMITs between units | 15 | the whole `CALL`, from the `postgres` role's 6 h |
| **C2** — called from a procedure that is one transaction | 5 | the whole `CALL`, from the `postgres` role's 6 h |
| **D** — called over direct pg by a script | 10 | the script's own session `SET` |
| **E** — trigger functions, predicate helpers, inner functions | 16 | the enclosing statement's timer |

Precedence, where a function carries more than one kind of evidence: C1 > C2 >
trigger > granted > `.rpc()` site > direct-pg site > E. Every piece of evidence
is kept in its own column, so a `_full` function that is both a C2 callee and a
`service_role` RPC still shows both.

### Where this departs from the design's §1

- The design put `get_financial_entity_naics`, `get_group_donor_totals`,
  `get_official_donor_rollup_full` and `get_official_bipartisan_stats_full` in
  class B (service-role RPCs). They are not. `get_financial_entity_naics` is in
  `heavy-rebuild.ts`'s direct-pg RPC list and is called from
  `pipelines/tags/rules.ts` as `get_financial_entity_naics (direct-pg)` — class
  **D**, and prod `pg_stat_statements` agrees: 0 calls through
  `pgrst_source`, 4 calls outside it, max 107.0 s. A 107-second call is not
  coming through an 8-second role.
- The design said all four `_full` functions are also called from pg_cron
  procedures. Only two are (`chord_contract_flows_full` and
  `treemap_recipients_by_contracts_full`, both from
  `refresh_contract_flow_rollups`). `get_official_donor_rollup_full` and
  `get_official_bipartisan_stats_full` are called only by their non-`_full`
  siblings — class E.
- Class C is 20, not "~25": 15 C1 and 5 C2, which is exactly the C1/C2 split
  the design described, just smaller.

### Three functions have no caller at all

`get_group_donor_totals`, `has_active_official_grant` and
`rebuild_financial_entity_donation_totals_full` are named nowhere — no in-DB
caller, no repo call site outside the generated `database.ts` types, no trigger.
Filed as **FIX-1179**, not touched here.

## Callers of the class-C functions

| enclosing procedure | COMMITs? | class | callees |
|---|---|---|---|
| `refresh_derived_mvs` | yes | C1 | `rebuild_entity_search_index`, `rebuild_all_primary_sources` |
| `run_entity_connections_rebuild` | yes | C1 | the eleven `rebuild_entity_connections_*` arms |
| `run_rule_taggers` | yes | C1 | `rebuild_financial_entity_size_tags`, `rebuild_pre_vote_timing_tags` |
| `refresh_contract_flow_rollups` | no | C2 | `chord_contract_flows_full`, `treemap_recipients_by_contracts_full` |
| `refresh_platform_counts` | no | C2 | `get_quality_counts`, `refresh_connection_type_counts` |
| `run_group_donor_rollup_refresh` | no | C2 | `refresh_group_donor_rollup` |

The `COMMIT` test reads `prosrc` for a real `COMMIT;` statement, with the
`ON COMMIT DROP` matches excluded by reading each hit — two functions match
`ON COMMIT` (`rebuild_browse_facet_counts`, `rebuild_entity_connections_votes_full`)
and neither is a COMMITting caller.

Per experiment 3, the C1/C2 distinction turns out **not** to change the real
bound: neither shape can arm anything from inside, so both are bounded only by
the top-level `CALL`. The split still matters to Half 2, because it decides
whether a unit can be abandoned without losing the run's earlier work.

## Readers of the GUC — the strip's behaviour dependency (rule 103)

The strip is behaviour-neutral only if nothing reads `statement_timeout` back.
Checked in both places:

**In the database** — `pg_proc.prosrc ILIKE '%current_setting(''statement_timeout''%'`
on the clone and on prod: **0 rows** on each. No function body reads it.

**In the repo** — one reader, by name:

- `packages/data/src/lib/statement-timeout-probe.ts:34` —
  `ARMED_PROBE_SQL = "SELECT current_setting('statement_timeout') AS st"`,
  imported by `donor-rollup-bulk.ts`, `donor-rollup-sweep.ts` and
  `treemap-global-sweep.ts` (FIX-968).

It reads the **session** GUC on a direct `pg.Client`, immediately after the
script itself has issued `SET statement_timeout = 0` at session level, to
confirm the break-glass disarm took. It never reads a function's proconfig, and
no function it guards is in the census. Removing a proconfig entry cannot change
what it observes.

Everything else matching `statement_timeout` in `packages`, `apps`, `scripts`
and `supabase/migrations` is either a comment, a `SET`/`set_config` write, or a
`pg.Client({ statement_timeout: … })` connection option — writes, not reads.

**Conclusion: no reader is affected, so `RESET statement_timeout` on all 91 is
behaviour-neutral, and the stop condition in the prompt's autonomous loop does
not fire.**
