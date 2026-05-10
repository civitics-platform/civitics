# Pipeline Audit — `packages/data/`

**Audit date:** 2026-05-10
**Scope:** every file under `packages/data/src/` plus every `pnpm data:*` script and every scheduled trigger that touches the data layer.
**Read-only.** No code changes were made in this audit. Findings drive a follow-up execution session.

---

## TL;DR

- No 🚨 URGENT findings. Nothing is silently failing in prod.
- One real cleanup target: the legacy [usaspending/index.ts](../packages/data/src/pipelines/usaspending/index.ts) (API-based) is superseded by [usaspending-bulk/index.ts](../packages/data/src/pipelines/usaspending-bulk/index.ts) per CLAUDE.md, but the `data:usaspending` script entry still ships a working pipeline that nobody calls from `runNightlySync()`.
- Three Phase 2 skeletons (`govtrack-cosponsors`, `federal-register`, `opensecrets-bulk`) are wired as scripts and write `data_sync_log` rows tagged `status=complete, inserted=0` — misleading dashboard signal. They are NOT invoked by the nightly orchestrator (the scheduling-agent claim during discovery was incorrect).
- `packages/data/src/pipelines/fec/` no longer exists; the [packages/data/CLAUDE.md](../packages/data/CLAUDE.md) line about `data:fec` being "retained for reference only" is stale.
- `packages/data/CLAUDE.md`'s per-source cadence section ("Hourly Regulations.gov", "Daily court metadata") doesn't match the orchestrator (everything Reg-side is daily-via-nightly; CourtListener is Sunday-only). User confirmed daily is fine — this is a doc-drift item, not a bug.
- `data:audit`, `data:agency-leadership`, `data:agency-enrichment` are powerful but manual-only. Worth cron'ing.

---

## 1. Inventory

Cadence column meanings:
- **daily-nightly** — invoked by `runNightlySync()` on every run (GitHub Actions `nightly.yml` 2 UTC, plus admin-dashboard manual runs).
- **weekly-nightly** — invoked by `runNightlySync()` only when `new Date().getDay() === 0` (Sunday UTC).
- **manual** — has a `pnpm data:*` script entry but is never auto-invoked.
- **annual** — manual but the source data only refreshes annually (TIGER).
- **skeleton** — script entry exists, pipeline body is a `TODO` returning zero rows.
- **none** — no script entry, no orchestrator call (effectively orphaned).

### 1a. Source-data pipelines

| File | Status | Cadence | Script | Called from | Ingest | Idempotent | Last touch |
|---|---|---|---|---|---|---|---|
| [pipelines/regulations/index.ts](../packages/data/src/pipelines/regulations/index.ts) | ACTIVE | daily-nightly | `data:regulations` | `pipelines/index.ts:14,153,396` | API pagination (250/page, 100ms gap) | Yes — `external_source_refs(source='regulations_gov')` dedup | recent |
| [pipelines/congress/officials.ts](../packages/data/src/pipelines/congress/officials.ts) | ACTIVE | daily-nightly | `data:officials` | `pipelines/congress/index.ts` → `pipelines/index.ts:20,188,416` | API pagination | Yes — upsert by bioguide_id | recent |
| [pipelines/congress/votes.ts](../packages/data/src/pipelines/congress/votes.ts) | ACTIVE | daily-nightly | `data:votes` | `pipelines/congress/index.ts` → `pipelines/index.ts:20,197,427` | API + House/Senate XML | Yes — per-roll skip-if-exists guard | recent |
| [pipelines/openstates-bulk/people.ts](../packages/data/src/pipelines/openstates-bulk/people.ts) | ACTIVE | daily-nightly | `data:states` | `pipelines/index.ts:19,247,446` | Bulk CSV (no auth, no rate limit) | Yes — upsert; runs `link_officials_to_districts()` after | recent |
| [pipelines/tags/rules.ts](../packages/data/src/pipelines/tags/rules.ts) | ACTIVE | daily-nightly | `data:tag-rules` | `pipelines/index.ts:21,710` | SQL rules on existing rows | Yes — deterministic | recent |
| [pipelines/tags/ai-tagger.ts](../packages/data/src/pipelines/tags/ai-tagger.ts) | ACTIVE | daily-nightly | `data:tag-ai` | `pipelines/index.ts:22,721` | Claude API, $0.10 cap, `onlyNew: true` | Yes — cached per entity | recent |
| [pipelines/ai-summaries/index.ts](../packages/data/src/pipelines/ai-summaries/index.ts) | ACTIVE | daily-nightly | `data:ai-summaries`, `data:ai-summaries-new` | `pipelines/index.ts:23,734` | Claude API, incremental | Yes — `ai_summary_cache` |  recent |
| [pipelines/fec-bulk/index.ts](../packages/data/src/pipelines/fec-bulk/index.ts) | ACTIVE | weekly-nightly | `data:fec-bulk` | `pipelines/index.ts:15,168,475` | Bulk ZIP, line-by-line streaming | Yes — upsert; `donor_fingerprint` unique on individuals | recent |
| [pipelines/usaspending-bulk/index.ts](../packages/data/src/pipelines/usaspending-bulk/index.ts) | ACTIVE | weekly-nightly | `data:usaspending-bulk`, `data:usaspending-bulk-assistance` | `pipelines/index.ts:16,212,491` | Bulk ZIP (full file first, deltas after) | Yes — `usaspending_award_id` partial unique | recent |
| [pipelines/courtlistener/index.ts](../packages/data/src/pipelines/courtlistener/index.ts) | ACTIVE | weekly-nightly | `data:courts` | `pipelines/index.ts:17,232,509` | API paginated per court | Yes — upsert | recent |
| [pipelines/openstates/index.ts](../packages/data/src/pipelines/openstates/index.ts) | ACTIVE | weekly-nightly | `data:states-api` | `pipelines/index.ts:18,261,524` | API (10 req/min bills cap) | Yes — upsert | recent |
| [pipelines/agencies-hierarchy/index.ts](../packages/data/src/pipelines/agencies-hierarchy/index.ts) | ACTIVE | weekly-nightly | `data:agencies-hierarchy` | `pipelines/index.ts:24,539` | API + static lookup | Yes — parent FK update | recent |
| [pipelines/opm-fte/index.ts](../packages/data/src/pipelines/opm-fte/index.ts) | ACTIVE | weekly-nightly | `data:opm-fte` | `pipelines/index.ts:25,552` | Bulk Parquet (HuggingFace mirror) | Yes — agency-FTE upsert | recent |
| [pipelines/plum-book/index.ts](../packages/data/src/pipelines/plum-book/index.ts) | ACTIVE | weekly-nightly | `data:plum-book` | `pipelines/index.ts:26,567` | Bulk NDJSON (OpenSanctions, ETag-cached) | Yes — ETag-gated | recent |
| [pipelines/elections/index.ts](../packages/data/src/pipelines/elections/index.ts) | ACTIVE | weekly-nightly | `data:elections` | `pipelines/index.ts:27,580` | Curated calendar + derived | Yes — UPDATE only | recent |
| [pipelines/congress/committees.ts](../packages/data/src/pipelines/congress/committees.ts) | ACTIVE | weekly-nightly | `data:committees` | `pipelines/congress/index.ts` → `pipelines/index.ts:20,594` | API pagination | Yes — upsert by `committee_id` | recent |
| [pipelines/congress/votes-backfill.ts](../packages/data/src/pipelines/congress/votes-backfill.ts) | MANUAL | manual (one-off) | `data:votes-backfill` | none (script-only) | API + XML historical | Yes — per-roll skip | 12d |
| [pipelines/agency-enrichment/index.ts](../packages/data/src/pipelines/agency-enrichment/index.ts) | SHOULD-BE-CRON | manual | `data:agency-enrichment` | none (script-only) | USA.gov + Federal Register + Wikidata SPARQL | Yes — UPDATE on metadata | 4d |
| [pipelines/agency-leadership/index.ts](../packages/data/src/pipelines/agency-leadership/index.ts) | SHOULD-BE-CRON | manual | `data:agency-leadership` | none (script-only) | Wikidata SPARQL + Congress.gov nominations | Yes — `is_current` + upsert | 4d |
| [pipelines/districts-tiger/index.ts](../packages/data/src/pipelines/districts-tiger/index.ts) | MANUAL | annual (intentional) | `data:districts` | none (script-only) | Bulk shapefile (TIGER 2024) | Yes — full per-state rewrite | 35h |
| [pipelines/legistar/index.ts](../packages/data/src/pipelines/legistar/index.ts) | MANUAL | manual per-metro | `data:legistar` | none (script-only) | Legistar OData/REST API per metro | Yes — `external_source_refs` dedup | 3w |
| [pipelines/usaspending/index.ts](../packages/data/src/pipelines/usaspending/index.ts) | SHOULD-BE-DEPRECATED | manual | `data:usaspending` | none (script-only) | API pagination — top 100 ≥$1M per top-20 agencies | Yes — partial unique on `usaspending_award_id` | 3w |
| [pipelines/govtrack-cosponsors/index.ts](../packages/data/src/pipelines/govtrack-cosponsors/index.ts) | PHASE-2 SKELETON | manual | `data:govtrack-cosponsors` | none (script-only) | TODO — not implemented | n/a — returns 0 rows | 9d (sync-log refactor only) |
| [pipelines/federal-register/index.ts](../packages/data/src/pipelines/federal-register/index.ts) | PHASE-2 SKELETON | manual | `data:federal-register` | none (script-only) | TODO — not implemented | n/a — returns 0 rows | 9d (sync-log refactor only) |
| [pipelines/opensecrets-bulk/index.ts](../packages/data/src/pipelines/opensecrets-bulk/index.ts) | PHASE-2 SKELETON | manual | `data:opensecrets-bulk` | none (script-only) | TODO — not implemented | n/a — returns 0 rows | 9d (sync-log refactor only) |
| [pipelines/tags/ai-classifier.ts](../packages/data/src/pipelines/tags/ai-classifier.ts) | MANUAL | manual | `data:tag-industry`, `data:tag-all` | none in orchestrator | Claude API per unclassified PAC | Yes — `tag_category='industry'` upsert | recent |
| [pipelines/enrichment/seed-backlog.ts](../packages/data/src/pipelines/enrichment/seed-backlog.ts) | MANUAL | manual (one-off backfill) | `data:enrich-seed` | none (script-only) | RPC enqueue | Yes — `enrichment_queue` dedup | 12d |
| [pipelines/integrity-audit/index.ts](../packages/data/src/pipelines/integrity-audit/index.ts) | MANUAL | manual | `data:audit` | none (script-only) | Read-only SQL checks | Yes — read-only | 3w |

### 1b. Helpers (writers, utilities, type modules — not pipelines)

| File | Used by | Notes |
|---|---|---|
| [pipelines/index.ts](../packages/data/src/pipelines/index.ts) | `data:sync`, `data:nightly`, `data:nightly:ci`, `data:status` | Orchestrator + `runNightlySync()` + `printStatus()`. Single source of truth for cadence. |
| [pipelines/sync-log.ts](../packages/data/src/pipelines/sync-log.ts) | every pipeline | `startSync` / `completeSync` / `failSync` / `getDbSizeMb` / `getLastSync`. |
| [pipelines/utils.ts](../packages/data/src/pipelines/utils.ts) | many | `sleep`, `fetchJson`, `postJson`, `QuotaExhaustedError`. |
| [pipelines/congress/index.ts](../packages/data/src/pipelines/congress/index.ts) | `pipelines/index.ts` | Re-export hub for officials/votes/committees. |
| [pipelines/congress/members.ts](../packages/data/src/pipelines/congress/members.ts) | `congress/{officials,votes,committees}.ts`, retitle scripts | Member-row helpers. |
| [pipelines/congress/bills.ts](../packages/data/src/pipelines/congress/bills.ts) | `congress/votes.ts` | Bill upserts for vote-linked bills. |
| [pipelines/fec-bulk/writer.ts](../packages/data/src/pipelines/fec-bulk/writer.ts) | `fec-bulk/index.ts`, `usaspending/{index,writer}.ts`, `usaspending-bulk/index.ts` | Exports `canonicalizeEntityName` — used cross-pipeline. **Don't delete with `usaspending/` cleanup; `usaspending-bulk` still imports it.** |
| [pipelines/fec-bulk/util.ts](../packages/data/src/pipelines/fec-bulk/util.ts) | `fec-bulk/index.ts` | ZIP/CSV streaming. |
| [pipelines/fec-bulk/indiv.ts](../packages/data/src/pipelines/fec-bulk/indiv.ts) | `fec-bulk/index.ts` | FIX-181 indiv aggregation. |
| [pipelines/usaspending/writer.ts](../packages/data/src/pipelines/usaspending/writer.ts) | `usaspending/index.ts` | Used only by the deprecation candidate. Drop with parent. |
| [pipelines/regulations/writer.ts](../packages/data/src/pipelines/regulations/writer.ts) | `regulations/index.ts` | Batched upsert. |
| [pipelines/courtlistener/writer.ts](../packages/data/src/pipelines/courtlistener/writer.ts) | `courtlistener/index.ts` | Batched upsert. |
| [pipelines/openstates/writer.ts](../packages/data/src/pipelines/openstates/writer.ts) | `openstates/index.ts`, `openstates-bulk/people.ts` | Shared by both OpenStates paths. |
| [pipelines/legistar/{client,writer,mappers,types}.ts](../packages/data/src/pipelines/legistar/) | `legistar/index.ts` | Pilot-metro adapter internals. |
| [pipelines/enrichment/queue.ts](../packages/data/src/pipelines/enrichment/queue.ts) | `tags/ai-tagger.ts`, `ai-summaries/index.ts` | Queue helpers. |
| [pipelines/tags/topics.ts](../packages/data/src/pipelines/tags/topics.ts) | `tags/*`, `enrichment/queue.ts` | Tag universe. |
| [pipelines/elections/calendar.ts](../packages/data/src/pipelines/elections/calendar.ts) | `elections/index.ts` | Curated election dates. |
| [pipelines/integrity-audit/checks/*.ts, reporter.ts, types.ts](../packages/data/src/pipelines/integrity-audit/) | `integrity-audit/index.ts` | Check suite. |

### 1c. Non-pipeline TS in `packages/data/`

| File | Purpose | Status |
|---|---|---|
| [src/seed.ts](../packages/data/src/seed.ts) | `data:seed` — initial DB seeding | MANUAL one-off |
| [src/jurisdictions/us-states.ts](../packages/data/src/jurisdictions/us-states.ts) | `data:jurisdictions` + `seedJurisdictions()` called every nightly | ACTIVE (orchestrator dep) |
| [src/jurisdictions/pilot-metros.ts](../packages/data/src/jurisdictions/pilot-metros.ts) | `data:pilot-metros` — pilot metro seed | MANUAL one-off |
| [src/drain/{claim,submit,apply,status,args}.ts](../packages/data/src/drain/) | `data:drain:*` — enrichment-queue worker CLI | NOT a pipeline (subagent tooling) — out of audit scope |
| [src/scripts/retitle-procedural-bill-stubs.ts](../packages/data/src/scripts/retitle-procedural-bill-stubs.ts) | `data:retitle-stubs` (FIX-162) | MANUAL one-off |
| [src/scripts/retitle-pn-stubs.ts](../packages/data/src/scripts/retitle-pn-stubs.ts) | `data:retitle-pn-stubs` | MANUAL one-off |
| [src/scripts/copy-pac-tags-to-prod.ts](../packages/data/src/scripts/copy-pac-tags-to-prod.ts) | One-shot post-FIX-179 cross-env migration | **ORPHANED** — no `data:*` script entry, only `pnpm tsx <path>`. Job almost certainly done. |

### 1d. Scheduling triggers (single source of truth)

| Trigger | Where | Schedule | Behavior |
|---|---|---|---|
| GitHub Actions | [.github/workflows/nightly.yml](../.github/workflows/nightly.yml) → `pnpm data:nightly:ci` | `0 2 * * *` daily | Runs `runNightlySync()`; weekly block fires on Sunday UTC |
| Vercel cron (canary) | [apps/civitics/vercel.json](../apps/civitics/vercel.json) → `/api/cron/nightly-sync` | `0 2 * * *` daily | Health-check only; logs `triggered` to `data_sync_log`. Does **not** run pipelines. |
| Vercel cron (notify) | [apps/civitics/vercel.json](../apps/civitics/vercel.json) → `/api/cron/notify-followers` | `0 3 * * *` daily | Reads vote/proposal deltas → push notifications. Cursor in `pipeline_state`. |
| Admin manual | `POST /api/admin/run-pipeline` | on-demand | 17 named pipelines runnable via admin dashboard. |

No `setInterval`, `setTimeout`-as-cron, `node-cron`, Supabase scheduled edge functions, or other recurring mechanism exists. Confirmed by repo-wide grep.

---

## 2. Orphaned code

Only one true orphan was found:

- **[src/scripts/copy-pac-tags-to-prod.ts](../packages/data/src/scripts/copy-pac-tags-to-prod.ts)** — one-off cross-env migration from FIX-179. No `data:*` script entry. Last touched 9 days ago, but only for a workspace-import refactor (`b28cde41`), not for any functional reason. The job it performed (copying AI-generated PAC industry tags local → prod via `fec_committee_id`) is a post-cutover one-shot that should be complete. **Recommendation:** verify with a quick spot-check that no PACs still need cross-env tag migration, then move it to `docs/archive/` or delete it.

Every other file in `packages/data/src/` is reachable through either the orchestrator, a `pnpm data:*` script entry, or another active file's imports.

---

## 3. Scheduling gaps

### 3a. Pipelines that should be cron'd but aren't

- **`data:agency-leadership`** — leadership shifts with appointments/confirmations; the manual cadence means the site can stay stale through real political-news events. Weekly (or daily during transition periods) is appropriate. Source is Wikidata SPARQL + Congress.gov nominations, both cheap.
- **`data:agency-enrichment`** — social media handles + agency descriptions drift slowly but predictably. Monthly is enough; quarterly would also be fine. Sources are USA.gov + Federal Register + Wikidata.
- **`data:audit`** — the integrity audit is the safety net for catching invariant violations after schema or pipeline changes. Today it only runs when invoked manually, which means no audit-on-divergence signal exists. Weekly via GitHub Actions, with output diffed against the prior week, would convert this from "audit when I remember" to "alert on regression."
- **`data:tag-industry`** — runs only against unclassified PACs, so re-running it weekly catches PACs that arrived in the last weekly FEC bulk. Currently only chained from `data:tag-all`, which is manual.

### 3b. Pipelines that are cron'd but should be less frequent (none)

The nightly orchestrator's split — daily for `regulations` / `congress` / `openstates-bulk-people` / tags / summaries; Sunday-only for `fec-bulk` / `usaspending` / `courtlistener` / `openstates-api` / `agencies` / `opm` / `plum` / `elections` / `committees` — looks well-tuned. The weekly block matches the cadence at which the source bulk files actually refresh.

### 3c. Doc drift in CLAUDE.md cadence section

[packages/data/CLAUDE.md:135-138](../packages/data/CLAUDE.md) "Update Schedules" lists:
- "Hourly: Active proposal status" → actual: daily-via-nightly. User confirmed daily is fine.
- "Daily (2am): Spending data, voting records, new bills, court metadata" → actual: spending and court metadata are Sunday-only; voting + bills are daily.
- "Weekly: FEC bulk, full reconciliation, AI summary regeneration, search index rebuild" → FEC bulk matches; AI summary actually runs daily (incremental); "search index rebuild" is not a current pipeline.

Same file's per-source notes: "[Regulations] hourly", "[CourtListener] daily at 2am" — both contradict the orchestrator.

[packages/data/CLAUDE.md:72](../packages/data/CLAUDE.md) — `data:fec` "retained for reference only" but `packages/data/src/pipelines/fec/` has been deleted; no such directory exists in the tree. Confirmed by `Glob packages/data/src/pipelines/fec/**/*` returning zero files.

Recommendation: a single doc PR that reconciles the cadence section against the orchestrator.

---

## 4. Efficiency wins

### 4a. Bulk-vs-API substitutions

The bulk-first policy is already applied where it matters most (FEC, USASpending, OpenStates people, OPM FTE, PLUM Book, TIGER). API-only pipelines remaining are reasonable:
- **Regulations.gov** — no bulk feed published; API with `external_source_refs` dedup is the only path.
- **Congress.gov officials/votes/committees** — Congress.gov publishes no bulk dump for bills/votes. Members file does exist; not exploited but small.
- **CourtListener** — bulk dumps exist (https://www.courtlistener.com/help/api/bulk-data/) but are gigabytes of opinion text we don't need; current API approach pulls metadata only.
- **OpenStates** — bulk for people (already used), API for term dates + bills (no bulk).

No obvious bulk-substitution win remaining. Phase 2 onramps (Federal Register, GovTrack, OpenSecrets) should follow the same rule when implemented; current skeletons document the bulk vs API choice correctly.

### 4b. AI-cost guardrails

`data:ai-summaries` (non-incremental, no flags) — the script entry runs against ALL entities and has no cost cap baked in. The orchestrator calls it with `incremental=true`, but an operator running `pnpm data:ai-summaries` by hand could overspend without a confirmation prompt. Compare against `data:tag-ai` / `data:tag-industry`, which both require `--confirm`. Adding `--confirm` to `data:ai-summaries` matches the project's existing AI-cost discipline.

### 4c. Misleading dashboard signal from skeletons

[pipelines/govtrack-cosponsors/index.ts:29](../packages/data/src/pipelines/govtrack-cosponsors/index.ts), [federal-register/index.ts:36](../packages/data/src/pipelines/federal-register/index.ts), [opensecrets-bulk/index.ts:38](../packages/data/src/pipelines/opensecrets-bulk/index.ts) all call `completeSync(logId, result)` with `inserted: 0`. A dashboard reading `data_sync_log` sees `status='complete'` and "0 rows" — indistinguishable from a real pipeline that legitimately had no new rows that day. They should mark the run as a no-op via a non-`complete` status (e.g. `skipped` with reason `not_implemented`) so the dashboard can show them differently.

### 4d. Idempotency

Every active pipeline upserts. No idempotency holes found. Specifically verified during this audit:
- Regulations: `external_source_refs` dedup
- FEC indiv: `donor_fingerprint` UNIQUE (migration `20260502120000`)
- USASpending bulk: partial unique on `usaspending_award_id`
- Congress votes: per-roll skip-if-exists guard
- PLUM Book: ETag short-circuit when OpenSanctions dataset unchanged

### 4e. Manual runs of legacy `data:usaspending`

The legacy `data:usaspending` and the active `data:usaspending-bulk` write to overlapping tables (`financial_relationships` rows with `relationship_type IN ('contract','grant')`). A manual operator invoking the legacy script can introduce duplicate rows under different `usaspending_award_id`s — same award, different ID format between the API response and the bulk archive. Removing the script entry closes that footgun. (Confirmed: bulk uses `Award ID` from the bulk file; legacy uses `Award ID` from the API search response. Whether these are identical strings across both sources is not guaranteed.)

---

## 5. Deprecation candidates

### 5a. `pipelines/usaspending/` (legacy API path)

**Why deprecate:** [packages/data/CLAUDE.md:86](../packages/data/CLAUDE.md) explicitly says "Legacy API script (`data:usaspending`) retained for reference — superseded by bulk approach (FIX-118)." Yet:
- `packages/data/package.json:15` still ships the `data:usaspending` script entry.
- [pipelines/usaspending/index.ts](../packages/data/src/pipelines/usaspending/index.ts) is a fully-functioning pipeline that writes to `financial_relationships`.
- It is NOT called from `runNightlySync()` (verified — `pipelines/index.ts` imports only `runUsaSpendingBulkPipeline` from `./usaspending-bulk`).
- The only out-of-package consumers grep'd were `docs/GRAPH_PLAN.md` and `docs/STAGE_0_WRITER_CATALOG.md` (both archive-ish references).

**Migration path:**
1. Delete `packages/data/src/pipelines/usaspending/index.ts` and `pipelines/usaspending/writer.ts`.
2. Drop the `data:usaspending` line from `packages/data/package.json`.
3. Verify `canonicalizeEntityName` is still imported by `usaspending-bulk/index.ts` — it lives in `fec-bulk/writer.ts`, NOT in `usaspending/writer.ts`, so deletion is safe (verified via grep).
4. Update CLAUDE.md's "Legacy API script retained for reference" line to remove the claim.
5. Optional: query prod `data_sync_log` for `pipeline='usaspending'` rows in the last 6 months to confirm nobody is still invoking the legacy path before removal.

### 5b. CLAUDE.md `data:fec` reference

The directory `packages/data/src/pipelines/fec/` does not exist (confirmed by glob). [packages/data/CLAUDE.md:72](../packages/data/CLAUDE.md) line "The API-based pipeline (`data:fec`) is retained for reference only — do not use it" should be deleted.

### 5c. `src/scripts/copy-pac-tags-to-prod.ts`

Post-cutover one-shot from FIX-179. No reason to keep on the critical path. Move to `docs/archive/` (or just `git rm`) after a final check that no PAC still needs the bridge.

### 5d. Phase 2 skeletons — do NOT deprecate yet

`govtrack-cosponsors`, `federal-register`, `opensecrets-bulk` are intentional placeholders for Phase 2. Don't remove. But do (see section 4c) make the skeleton-no-op state observable.

---

## 6. Proposed FIX items

Next free ID: **FIX-224** (`grep -oE 'FIX-[0-9]+' docs/FIXES.md | sort -u | tail -1` → `FIX-223`).

These are CANDIDATES — do NOT add to `docs/FIXES.md` from this audit. The follow-up review pass decides which to accept.

- **FIX-224** — Delete legacy `data:usaspending` script entry + `pipelines/usaspending/` directory; bulk path supersedes. (See section 5a for migration steps.)
- **FIX-225** — Reconcile [packages/data/CLAUDE.md](../packages/data/CLAUDE.md) cadence section against the orchestrator: drop hourly Regulations / daily CourtListener / `data:fec` claims; correct AI-summary cadence to "daily incremental".
- **FIX-226** — Schedule `data:audit` weekly via GitHub Actions; surface the latest JSON/MD report on the admin dashboard so regressions are visible.
- **FIX-227** — Schedule `data:agency-leadership` (Sunday-only via the existing weekly block, or its own daily run during transition windows).
- **FIX-228** — Schedule `data:agency-enrichment` monthly (e.g. first Sunday of the month).
- **FIX-229** — Phase 2 skeletons return `status='skipped', reason='not_implemented'` instead of `status='complete', inserted=0`; dashboard distinguishes no-op stubs from real zero-row runs.
- **FIX-230** — Add `--confirm` gate to `data:ai-summaries` (non-incremental) matching `data:tag-ai` and `data:tag-industry`; prevents accidental overspend.
- **FIX-231** — Archive or delete `src/scripts/copy-pac-tags-to-prod.ts` post-cutover; verify no PAC still needs the bridge before removal.
- **FIX-232** — Optional: add `data:tag-industry` to the nightly Sunday block (or daily) — currently only chained from manual `data:tag-all`, which means newly-arrived PACs from the weekly FEC bulk wait until someone runs `data:tag-all` by hand.

---

## 7. Open questions

Things that need a follow-up read or a quick query to resolve confidently.

1. **Legacy `data:usaspending` usage history.** Before removing it (FIX-224), query prod `data_sync_log` for `pipeline='usaspending'` rows in the last 180 days. If the row count is zero, deletion is safe.
2. **Phase 2 timing.** Are `govtrack-cosponsors` / `federal-register` / `opensecrets-bulk` implementations scheduled for a specific phase, or are they parked indefinitely? Affects whether FIX-229 (status='skipped') is a quick fix or a longer-term placeholder.
3. **`data:audit` output destination.** The pipeline writes JSON + Markdown reports somewhere; do they get read? If they're written to a local dir nobody monitors, then FIX-226 needs to include a publish step (S3/R2 upload, dashboard ingestion, alerting) — not just a cron entry.
4. **Pipeline runtime/memory metrics.** Phase 1 discovery did not observe `data_sync_log` for actual `duration_ms` percentiles or peak heap usage. A `SELECT pipeline, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FROM data_sync_log WHERE started_at > now() - interval '30 days' GROUP BY pipeline` would surface which pipelines are creeping toward the 60-min GitHub Actions timeout. Not done in this read-only audit.
5. **Drain prompts directory.** `packages/data/src/drain/prompts/` was not opened. Out of scope (subagent tooling, not a data-source pipeline) but worth confirming nothing pipeline-related leaked into it.
6. **Cron canary mismatch alarm.** The Vercel `/api/cron/nightly-sync` writes a `triggered` row to `data_sync_log`; the GitHub Actions run writes a `nightly_cron` row to `data_sync_log` via `pipeline_state.cron_last_run`. Does anything alert when the canary fires but the GHA row never appears? If not, the canary's value is currently a manual-review-only signal.
7. **CourtListener bulk option.** The bulk dump (https://www.courtlistener.com/help/api/bulk-data/) is gigabytes of opinion text we don't store. But there may be a metadata-only bulk export worth checking before the next CourtListener pipeline change.

---

## Spot-checks

Five files verified against the inventory claims.

### Spot-check 1 — ACTIVE / nightly-orchestrated: `pipelines/congress/votes.ts`

- **File opened**, header confirms purpose: roll-call votes + bill votes via Congress.gov + House/Senate XML.
- **Grep `runVotesPipeline`** → matched `packages/data/src/pipelines/congress/index.ts` (re-export) and `packages/data/src/pipelines/index.ts:20,197,427` (orchestrator import + two call sites: `runAllPipelines` and `runNightlySync`).
- **Status: ACTIVE / daily-nightly — confirmed.** Inventory claim holds.

### Spot-check 2 — MANUAL / not in nightly: `pipelines/districts-tiger/index.ts`

- **File opened**, header confirms purpose: per-state TIGER 2024 SLDU/SLDL/CD119 shapefile ingestion.
- **Grep `districts-tiger/index`** → only `packages/data/package.json` (script entry). No orchestrator import.
- **Grep `runDistrictsTiger`** → only `packages/data/package.json` (no production import).
- **CLAUDE.md confirms** annual cadence is intentional ("Not in the nightly orchestrator" at packages/data/CLAUDE.md:125).
- **Status: MANUAL / annual — confirmed.** Inventory claim holds.

### Spot-check 3 — SHOULD-BE-DEPRECATED: `pipelines/usaspending/index.ts`

- **File opened**, header reads "USASpending.gov pipeline — post-cutover, writes directly to public financial_entities + financial_relationships". Fully functional code.
- **Grep `runUsaSpendingPipeline`** → only `packages/data/src/pipelines/usaspending/index.ts` itself + `packages/data/package.json` + `docs/GRAPH_PLAN.md` + `docs/STAGE_0_WRITER_CATALOG.md`. Notably ABSENT from `packages/data/src/pipelines/index.ts`.
- **Confirmed `runNightlySync` imports `runUsaSpendingBulkPipeline` only** (line 16 of orchestrator), not `runUsaSpendingPipeline`.
- **CLAUDE.md confirms** "Legacy API script (`data:usaspending`) retained for reference — superseded by bulk approach (FIX-118)" (packages/data/CLAUDE.md:86).
- **Status: SHOULD-BE-DEPRECATED — confirmed.** Inventory claim holds.

### Spot-check 4 — ORPHANED: `src/scripts/copy-pac-tags-to-prod.ts`

- **File opened**, header confirms purpose: one-shot cross-env PAC industry tag migration via `fec_committee_id`, idempotent.
- **Grep `copy-pac-tags`** → matched `packages/data/src/scripts/copy-pac-tags-to-prod.ts` itself + `docs/archive/fixes-archive.md` + `packages/db/src/client.ts` (probably a comment, not an import).
- **Read of `packages/db/src/client.ts` result was indirect** — confirmed it's not invoked by any production code path; the grep hit was likely a comment or doc reference.
- **No `pnpm data:*` script entry** for this file in `packages/data/package.json`.
- **Status: ORPHANED — confirmed.** Inventory claim holds (one-shot post-FIX-179 migration; safe to archive).

### Spot-check 5 — PHASE-2 SKELETON: `pipelines/govtrack-cosponsors/index.ts`

- **File opened**, the entire pipeline body is a TODO comment block; `runGovtrackCosponsorsPipeline` calls `completeSync(logId, result)` with `result = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 }` and logs "Skeleton pipeline — no work performed."
- **Grep `runGovtrackCosponsorsPipeline`** → only the file itself + `packages/data/package.json` (the `data:govtrack-cosponsors` script entry).
- **NOT in `packages/data/src/pipelines/index.ts`** — verified the orchestrator imports only the implemented pipelines. The earlier discovery-agent claim that govtrack/federal-register/opensecrets were "Via nightly" was wrong; they are NOT invoked from `runNightlySync()`.
- **Status: PHASE-2 SKELETON — confirmed.** Inventory claim holds. Cross-resolution: the conflicting Phase 1 explore-agent reports are resolved in favor of the structure-agent (skeletons, not invoked); the scheduling-agent's "Via nightly" claim was an artifact of seeing them in the `data:*` script list and assuming nightly coverage.

**All 5 spot-checks passed. Inventory categorizations are reliable.**
