# Platform Rebuild — Status (ARCHIVED 2026-04-26)

> **Archived:** the Stage 0 → Stage 2 rebuild closed cleanly with the
> 2026-04-22 cutover and the FIX-097 / 098 / 099 / 100 / 101 / 102 / 103 / 104
> backlog. All Stage 1B pipeline rewrites landed (FEC bulk, USASpending —
> 841k contracts via FIX-118 bulk archive, Regulations, OpenStates,
> CourtListener, Legistar, tags, AI). Live work tracking moved to
> `docs/FIXES.md` and `docs/archive/SESSION_LOG.md`.
>
> Remaining ⬜ items below are not rebuild scope — they are future pipeline
> expansions (cosponsorship / federal register / lobbying stubs, older FEC
> cycles, NYC Legistar token, Stage 3 local rollout).

_Original purpose: reference point for current state, decisions, and critical path._
_Updated at the end of every session that touched rebuild work._

---

## Stage Progress

| Stage | Status | Notes |
|---|---|---|
| Stage 0 — Investigation + writer catalog | ✅ Complete | `STAGE_0_WRITER_CATALOG.md` |
| Stage 1A — Shadow schema + migrations | ✅ Complete | Migrations `20260421000000–20260421000007` applied locally |
| Stage 1B — Pipeline shadow rewrites | 🔄 Partial | See table below — Option C shipped only congress; rest deferred |
| Stage 2 — Cutover to Pro | ✅ **Complete (2026-04-22)** | Shadow→public promoted; Vercel flipped; `main` is prod. See `docs/archive/MIGRATION_RUNBOOK.md` |
| Stage 3 — Local data rollout | ⬜ Not started | 5 metros locked in (SEA, SF, AUS, DC + NYC pending token) |

---

## Stage 1B Pipeline Status

| Pipeline | Status | Notes |
|---|---|---|
| `congress/bills` dual-write to shadow | ✅ Done | `packages/data/src/pipelines/congress/bills.ts` |
| FEC bulk → shadow rewrite | ✅ Done | 1,824 entities · 16,263 relationships · 0 audit violations |
| Legistar — Seattle, Austin, SF | ✅ Done | 67,148 proposals · 1,619 officials · 127 meetings |
| shadow-initiatives backfill | ✅ Done | civic_initiatives → shadow.proposals type='initiative' |
| shadow-connections (vote + donation edges) | ✅ Done | |
| **Congress votes → shadow (bill re-anchoring)** | ✅ Done | `b039e0ca` — bills-first ordering, lookup-only shadow inserts, title self-healing |
| **`shadow.rebuild_entity_connections()` L5 job** | ✅ Done | `shadow/connections/shadow.ts` upgraded to read shadow.votes; full 4-type derivation |
| CourtListener → shadow.case_details | ✅ Done | `41c40618` — 280 opinions, 365 judges re-anchored to judicial govbodies |
| OpenStates → shadow | ⬜ Not started | Priority 5 |
| spending_records → financial_relationships | ✅ Done | `ccfa5ff7` — agency→entity, contract/grant type, dedup on usaspending_award_id |
| FEC bulk 2022/2020 cycles | ⬜ Not started | Low priority until shadow is complete |
| NYC Legistar | 🔴 Blocked | 403 — needs API token. Skipped for Stage 2; document for grant applications |
| Cosponsorship pipeline | ⬜ Stub | Migration `20260420000000` exists |
| Federal Register pipeline | ⬜ Stub | Migration `20260420010000` exists |
| Lobbying pipeline | ⬜ Stub | Migration `20260420020000` exists |

---

## Decisions Locked

| # | Question | Decision | Date |
|---|---|---|---|
| L1 | Initiatives structure | I-B: migrate civic_initiatives → proposals.type='initiative' + initiative_details | 2026-04-19 |
| L2 | external_source_refs FK | App-level enforcement + orphan cleanup job (no DB-level polymorphic FK) | 2026-04-19 |
| L3 | bill_details uniqueness | Denormalize jurisdiction_id + session onto bill_details for compound unique index | 2026-04-19 |
| L4 | votes.agenda_item_id | Nullable FK, yes | 2026-04-19 |
| L5 | entity_connections | Derivation-only for Phase 1 (no manual edges) | 2026-04-19 |
| L6 | Cutover deadline | 30-day dual-write window | 2026-04-19 |
| L7 | financial_relationships | Keep name, make polymorphic with relationship_type enum | 2026-04-19 |
| E.4 | spending_records | Migrate into financial_relationships (type='contract'/'grant'); ingest from ~2010+ only | 2026-04-19 |
| A | Local pilot scope | Current 5 metros only (SEA, SF, AUS, DC + NYC when unblocked) | 2026-04-20 |
| B | Senate votes | Accept looser bill linkage at Stage 2 launch; full resolution filed as Phase 2 item | 2026-04-20 |
| C | Spending records timeline | Merge into financial_relationships as part of Stage 1 shadow build | 2026-04-20 |
| D | NYC Legistar | Skip Stage 2; document data gap for grant applications (Knight, Mozilla, Democracy Fund) | 2026-04-20 |

---

## Architecture Fixes Required Before Cutover

These are correctness and integrity issues — do not cut over to shadow until all are done.

### Critical (wrong data if skipped)
1. **Votes anchor to bills, not vote-questions** — 216k public.votes currently point at synthetic "On Passage" proposals. Shadow rewrite fixes this; don't cut over until shadow vote count is sane.
2. **One FEC aggregation path** — retire `connections/delta.ts` and `financial-entities/index.ts` donor paths; shadow FEC writer is now canonical.
3. **Federal judges governing_body** — ✅ Fixed. 14 judicial governing bodies seeded; 365 judges re-anchored to correct circuit courts.
4. **`data_sync_log` column name** — `pipeline` vs `pipeline_name` split; one path silently fails. Fix in shadow.

### Important (UX / query correctness)
5. **Officials state from FK, not JSON** — `officials.metadata->>'state'` is null for all 100 senators. In shadow, state derives from `jurisdiction_id → jurisdictions.short_name`. Fixes AI tagger "Unknown" state for all federal officials.
6. **`pipeline_state` formalization** — split into pipeline_cursors, pipeline_runs, pipeline_locks.

### Workflow
7. **Shadow audit gate** — run integrity audit against `shadow.*` tables before any cutover. Same audit code, different schema prefix. Green = safe to cut over.
8. **New Supabase Pro project** — shadow currently lives in local Docker. Needs to move to a cloud Pro project before Stage 2 cutover.

---

## Critical Path to Stage 2 — ✅ Complete

```
1. Congress votes shadow rewrite                    ✅ done (b039e0ca)
2. shadow.rebuild_entity_connections() L5 job       ✅ stubbed (full derivation → FIX-100)
3. spending_records → financial_relationships merge  ✅ done (ccfa5ff7)
4. CourtListener → shadow.case_details              ✅ done (41c40618)
5. OpenStates → shadow                              ⚠️  WIP (66b5032d) — deferred to post-cutover
6. App query audit                                  ✅ done (promotion migration 20260422000000)
7. Provision new Supabase Pro project               ✅ done (xsazcoxinpgttgquwvuf, 2026-04-22)
8. Run integrity audit against shadow → Pro         ✅ done (docs/audits/post-cutover/2026-04-22.md)
9. Write Stage 2 cutover runbook                    ✅ done (docs/MIGRATION_RUNBOOK.md)
10. Craig signs off → swap Vercel env vars          ✅ done (2026-04-22)
```

## Post-cutover backlog

The cutover was scoped as "Option C" — rewrite only `congress/bills.ts` + `congress/votes.ts` to write against `public` post-promotion, defer everything else. See `docs/FIXES.md` §POST-CUTOVER:

- **FIX-097, 098, 099, 104** — reimplement the 11 dropped RPCs (chord, treemap, search, officials breakdown, etc.) against the new polymorphic `financial_relationships` shape.
- ~~**FIX-100** — build the `rebuild_entity_connections()` derivation rules; `entity_connections` is currently empty.~~ **Done 2026-04-22.** 9 derivation rules implemented in `20260422000002–5`; first run on Pro produced 124,943 edges (vote_yes 81,476 + vote_no 43,467) from votes alone. Other rule outputs grow as FIX-101 lands. Wired into nightly-sync as step 3c.
- **FIX-101** — re-run against Pro: FEC bulk, USASpending, Regulations.gov, OpenStates, CourtListener, Legistar (4 metros), tag-rules, ai-summaries, tag-ai. Each needs its shadow→public writer rewrite similar to what was done for congress.
- ~~**FIX-102** — clean 307 orphan proposals from the early broken ingest runs.~~ **Done 2026-04-22.** Verified zero FK refs (civic_comments / submissions / cosponsors / promises / init_links all 0), then `DELETE FROM proposals WHERE id IN (...)` via direct psql. proposals now 1:1 with bill_details.
- **FIX-103** — fix `officials_breakdown` chain bug in `/api/claude/status`.

Post-cutover Pro row counts (snapshot at 2026-04-22, immediately after cutover):
- 903 officials · 682 proposals · 682 bill_details · 217,548 votes
- 124,943 entity_connections (FIX-100 ✓) · 0 financial_relationships · 0 financial_entities (FIX-101 not yet run)

Post-FIX-101 + FIX-118 (current snapshot, archived 2026-04-26):
- FEC bulk: 16,263 donations · 1,824 financial_entities (2026-04-23)
- USASpending bulk: ~841,264 contracts (2026-04-25, FIX-118 archive pipeline)
- See `docs/archive/SESSION_LOG.md` 2026-04-23 / 2026-04-25 entries for full breakdown.

---

## Reference Files

| File | Purpose |
|---|---|
| `docs/archive/PLATFORM_REBUILD_SPEC.md` | Why we're doing this, original decision questions |
| `docs/archive/STAGE_0_WRITER_CATALOG.md` | Full pipeline writer audit, 17 architectural findings |
| `docs/STAGE_1_SCHEMA_DESIGN.md` | Schema decisions L1–L7, table-by-table design rationale |
| `supabase/migrations/20260421*` | Shadow migrations (applied locally, then moved to public via promotion) |
| `supabase/migrations/20260422000000_promote_shadow_to_public.sql` | Cutover migration |
| `supabase/migrations/20260422000001_fix_promoted_function_bodies.sql` | Trigger body fix (post-promotion) |
| `docs/archive/MIGRATION_RUNBOOK.md` | The runbook that executed the cutover |
| `packages/data/docs/audits/post-cutover/2026-04-22.md` | Post-cutover integrity audit (written under `packages/data/`, the pipeline's cwd) |
| `docs/archive/SESSION_LOG.md` | Session-by-session work log |
