# Session Log

---

## 2026-05-17 (FIX-290 + FIX-291 — split rebuild_entity_connections out of nightly, accept partial in canary)

**Driver:** PR 4 canary fired 2026-05-17 reporting 4 "missing" nightly_cron rows
over 2026-05-10 → 2026-05-16. Audit
([docs/audits/missing-nightlies-2026-05-10-to-16.md](audits/missing-nightlies-2026-05-10-to-16.md))
showed two distinct root causes:

1. **Canary false positives (5/13 + 5/16).** `nightly_cron` rows DID exist but
   with `status='partial'` — the canary's `.eq("status","complete")` filter
   excluded them. Result: "ran with errors" looked identical to "didn't run."
2. **Workflow SIGTERM (5/10 + 5/14 + 5/17).** Nightly hit `timeout-minutes: 120`
   while `rebuild_entity_connections` chunks were still grinding. Donations +
   votes alone now burn ~90 min wall-clock on prod. Completion row never
   written → canary correctly fires but on a misleading signal.

**FIX-290 (monitoring bundle):**

- `packages/data/src/scripts/canary-check.ts`: accept `status IN
  ('complete','partial')` for the "did it run?" question. Partial runs still
  ran. Error-tracking is the dashboard's job (FIX-287 banner).
- New `packages/data/src/scripts/mark-killed.ts` + `data:mark-killed` /
  `data:mark-killed:ci` scripts. Writes a synthetic
  `pipeline='nightly_killed'` row to `data_sync_log` only when the source
  pipeline has a recent `status='running'` row and no terminal row. Always
  exits 0 — observability, never a gate.
- `if: always()` post-step in `.github/workflows/nightly.yml` runs the
  marker after `Run nightly sync` regardless of step outcome.
- Canary surfaces `nightly_killed` rows with a distinct subject line
  ("⚠️ Nightly killed by workflow timeout") so "didn't run at all" and
  "ran but SIGTERM'd" stay separate signals.

**FIX-291 (structural fix):**

- New workflow `.github/workflows/rebuild-entity-connections.yml` — runs
  `rebuild_entity_connections` chunks on a Sun + Wed 08:00 UTC cadence,
  240-min budget, NODE_OPTIONS=12 GB. 6h after nightly's 02:00 UTC start.
- New script `packages/data/src/scripts/rebuild-entity-connections.ts` —
  copies the per-chunk pg.Client loop out of `runNightlySync` verbatim,
  writes `entity_connections_rebuild` sync-log rows. PostgREST RPC fallback
  preserved for local dev.
- `runNightlySync` no longer calls rebuild RPCs at step 3c. The block was
  replaced with a comment pointing at the new workflow. Unused imports
  (`startSync`, `completeSync`, `failSync`) and the now-dead `buildDbUrl`
  helper were removed alongside it.
- New migration `supabase/migrations/20260517060000_donations_chunk_timeout_raise.sql`
  raises the donations chunk's function-level `statement_timeout` from
  60min → 90min via `ALTER FUNCTION`. Cleaner than CREATE OR REPLACE
  FUNCTION (body byte-identical, just the GUC moves).
- `packages/data/CLAUDE.md` Update Schedules section now lists the
  twice-weekly rebuild as a distinct cadence.

**Decisions logged here for future reference:**

- **Why not raise nightly `timeout-minutes` further?** Because the rebuild
  was the only thing burning the budget. With it gone, nightly should run
  in 30-60 min and 120 is plenty of margin. Raising would have papered
  over the underlying creep.
- **Why not split the donations chunk further (per cycle / per state)?**
  Months-long refactor; out of scope. Filed mentally as a future FIX if
  90 min stops being enough.
- **Why not put `nightly_killed` into the same pipeline name as `nightly_cron`?**
  Separating them keeps the canary's "did the nightly run?" query simple
  and unambiguous. A `nightly_cron` row means runNightlySync wrote it;
  a `nightly_killed` row means the GHA post-step did. Different writers,
  different semantics.
- **Why not add a separate canary for the rebuild workflow?** GHA UI
  surfaces failures already. Adding a SQL-level canary would be premature
  until proven necessary. Filed as follow-up if the workflow starts
  silently degrading.

**Out of scope (filed mentally as follow-ups):**

- Incremental rebuild — only re-derive edges for source rows that changed.
  Months-long.
- Audit of read paths that assume daily-fresh `entity_connections`. Should
  be none (all reads go through MVs or current state), but worth a grep
  pass when there's time.
- Backfilling `entity_connections` between PR merge and the first
  scheduled rebuild — handled by manual `gh workflow run` after deploy.

---

## 2026-04-27 evening (FIX-160 OpenStates bulk + FIX-022 elections + state-district maps)

**Done (all verified local; prod runs queued — see below):**

- **FIX-160 — OpenStates bulk people pipeline** (commit `eb691f90`).
  - `pnpm data:states` now downloads `data.openstates.org/people/current/{abbr}.csv` per state — no API key, no rate limit, no daily quota. ~5.7 MB total, ~1 minute end-to-end. 7,368 legislators upserted on local; idempotent on re-run (0 inserts).
  - Original `/people` + `/bills` API pipeline preserved as `pnpm data:states-api`. Master orchestrator runs bulk-people daily, full API weekly. The 250-call/day API quota now goes entirely to `/bills` since `/people` no longer competes.
  - Bills bulk (`open.pluralpolicy.com/data/session-csv/`) is gated behind a Plural Policy Django session that the API key doesn't satisfy — kept on the API path.
  - Writer hardening: `LOOKUP_CHUNK_SIZE` 200 → 100 (URLs were overflowing PostgREST limits on bigger states like NH/IL/NY, causing failed lookups → silent orphan re-inserts; cleaned up 3,520 duplicate state legislators on local). `termStart`/`termEnd` made optional so the bulk path doesn't clobber API-set dates.

- **State-legislative district maps** (commit `4448cd4d`, FIX-163 filed for tracking).
  - New `pnpm data:districts` — Census TIGER 2024 SLD-U + SLD-L for all 50 states. 6,775 districts loaded with PostGIS MULTIPOLYGON geometry (skipped DC, NE-SLDL since unicameral). ~197 MB downloaded, ~30–50 MB persisted. Annual cadence; not in nightly orchestrator.
  - New migration `20260428061525_district_boundaries.sql`:
    - Partial unique index `(parent_id, type, census_geoid, metadata->>'chamber')` — chamber is required because TIGER GEOIDs are STATE_FIPS+DISTRICT and the same district number appears in both SLD-U and SLD-L files (caught this when first run wrote 6775 but DB held only 5063 — SLDL was clobbering SLDU).
    - `upsert_district_jurisdiction()` — accepts GeoJSON text + chamber, casts to MULTIPOLYGON via `ST_GeomFromGeoJSON` + `ST_Multi`.
    - `link_officials_to_districts()` — derives `metadata.district_jurisdiction_id` for each state legislator via leading-zero-normalised match on `(state_abbr, chamber, district_id)`. ~84% link rate (6,534/7,818); the unlinked 16% are NH/MA/VT multi-member, ID A/B subdistricts, and DC. Called automatically at the end of both bulk-people and the districts pipeline.
    - `query_districts(...)` — single RPC supporting id-lookup, bbox, point-in-polygon, state, and chamber filters; returns simplified GeoJSON (default Douglas-Peucker tolerance 0.001 ~ 111 m).
  - **Maps UI:**
    - `/api/districts` route returns GeoJSON FeatureCollection. 5-min browser cache, 15-min CDN.
    - `/districts/[id]` page renders the boundary + linked officials. Geometry fetched server-side via the id-fast-path on the RPC.
    - Homepage `DistrictMap` exposes State Senate / State House layer toggles. Layers debounce-refetch on map move (300 ms after `moveend`) so the bbox query stays aligned. Click a polygon → `/districts/[id]`.
  - `packages/maps/CLAUDE.md` updated — Mapbox blocker removed (`NEXT_PUBLIC_MAPBOX_TOKEN` is in `.env.local`); documented `/api/districts`, `/districts/[id]`, layer toggles. Bulk-people pipeline buckets unicameral chambers (NE) as `'upper'` to match TIGER's SLDU-only publication.

- **FIX-022 — accurate per-state election dates** (commit `89d470ca`).
  - New `packages/data/src/pipelines/elections/calendar.ts` with `STATE_ELECTION_CALENDAR` covering NJ/VA/KY/LA/MS odd-year cycles through 2032. Each entry comments its SoS source URL.
  - Pipeline now detects federal officials via `governing_body.name LIKE 'United States%'` (instead of `jurisdiction.type='country'`). The old check missed federal House members whose `jurisdiction_id` points at their state — they were getting bucketed as state-cycle officials.
  - Governor detection added (separates KY/LA/MS odd-year governor races from their on-federal-cycle legislatures).
  - Verified local: NJ state legislators → `2027-11-02`; NJ federal Reps → `2026-11-03`; KY state legislators → `2026-11-03` (KY uses federal cycle for legislature); MS state legislators → `2027-11-02`.

- **`pnpm fixes:sync`** (commit `b8096bb2`) — flipped FIX-022 and FIX-160 to `[x]`. Logged as `local-only` in `done.log`; flips to `local+prod` once the runs below complete.

**⚠️ Action needed tomorrow — prod runs (env switched to `.env.local.prod` for the duration):**

```powershell
# 1. Confirm target
Copy-Item .env.local.prod .env.local
grep "^NEXT_PUBLIC_SUPABASE_URL" .env.local   # must be xsazcoxinpgttgquwvuf

# 2. Push the new migration to Pro
supabase db push --linked

# 3. Run bulk-people against Pro (~1 min, idempotent)
pnpm --filter @civitics/data data:states

# 4. Run TIGER districts against Pro (~5–10 min, ~197 MB download, ~30–50 MB written)
pnpm --filter @civitics/data data:districts

# 5. Run elections recompute against Pro
pnpm --filter @civitics/data data:elections

# 6. Smoke-test prod
#    Visit https://civitics-civitics.vercel.app — homepage DistrictMap should show
#    State Senate / State House layer toggles; visiting /districts/<any-id> should
#    render the boundary + officials.

# 7. Restore env
Copy-Item .env.local.dev .env.local
```

**Then update verification trailers** — append a new commit (or amend an empty status commit) with the per-fix `Verified: local + prod` trailer for FIX-022 and FIX-160 and re-run `pnpm fixes:sync`. The `done.log` row will flip from `local-only` to `local+prod`.

**Known caveats for the prod runs:**
- `data:districts` is slow (annual TIGER zips, all 50 states). Don't kill it midway — the unique constraint on `(parent_id, type, census_geoid, chamber)` makes it idempotent, but partial runs leave gaps in coverage until the next full pass.
- `data:states` will refresh ~7,400 legislators with bulk-CSV data. **Won't touch term dates** (the bulk CSV doesn't carry them). Term dates on prod will only refresh when `data:states-api` runs (weekly via nightly cron, or manually).
- `data:elections` is fast (~30 s) and idempotent. Re-run anytime.

**Up next (after prod sync):**

1. **Verification + trailer update** for FIX-022 + FIX-160 (above).
2. **FIX-163** filed in HOMEPAGE — state-legislative district overlay on homepage map. Already shipped functionally; flips to `[x]` whenever a future commit references it. Could be closed by including `Fixes: FIX-163` in the prod-verification commit.
3. **Improve unlinked-legislator coverage (~16%)** — NH/MA/VT/ID multi-member naming quirks. Optional follow-up; the unlinked legislators still display correctly with their `district_name` string, they just lack a clickable link to `/districts/[id]`.

**Commits pushed to `main`:**
- `eb691f90` — feat(openstates): bulk people pipeline → FIX-160
- `4448cd4d` — feat(districts): TIGER state-legislative boundaries + maps UI
- `89d470ca` — feat(elections): per-state election calendar → FIX-022
- `b8096bb2` — chore(fixes): sync status after FIX-022, FIX-160

---

## 2026-04-27 (Donations on prod + local↔prod drift audit + 6 FIX items)

**Done:**

- **Reported symptom:** "0 donations" in graph Active Types after selecting a senator, even though FIX-154 (committed `8eeb20d2` on 2026-04-26) had verified donor wiring against local Docker.

- **Root cause was data drift, not code drift.** The full graph donation path (`mapNodeType`, `financialIds` filter, `useGraphData.ts` count derivation, `ConnectionsTree.tsx` rendering, `CONNECTION_TYPE_REGISTRY`) is correct on `main`. Local Docker had 16,263 donation rows in `entity_connections`. **Prod had 0** — despite 22,715 donation rows sitting in `financial_relationships`. `rebuild_entity_connections()` ran on Pro once on 2026-04-22 (votes-only, before FEC bulk landed) and was never re-invoked. FEC bulk and USASpending (830k contracts) loaded source data after that, but nothing called the SQL derivation against Pro.

- **Fix path:** ran `SELECT * FROM public.rebuild_entity_connections()` against Pro via the PostgREST RPC endpoint. 88s execution. Wrote 22,715 donation edges + 36,032 contract_award edges + refreshed votes (81,476 → 100,311). Prod graph UI now shows real donation counts for federal senators — Schumer 23, McConnell 24, Durbin 7, Warren 10.

- **Pivoted to systemic audit** at Craig's request after the symptom fix: where in the codebase / docs does the local-vs-prod distinction lose Claude? Answer: pretty much everywhere. Root `CLAUDE.md` never mentioned the `.env.local.dev` / `.env.local.prod` Copy-Item pattern (documented only in `docs/OPERATIONS.md`). The standard autonomous loop pushes schema (`supabase db push --linked`) but has no analogous step for runtime data actions (RPC invocations, pipeline runs, seeds). Pipelines silently inherit whichever env is active. FIXES.md / done.log have no per-environment field — FIX-101 was checked off after pipelines re-ran on Pro, but the implicit follow-up `rebuild_entity_connections()` never happened and nothing surfaced that.

- **CLAUDE.md surgical edits** (commit `b50b68d8`):
  - New row in Session Continuity table: verify active DB before any data work.
  - New "Active environment check (CRITICAL)" section: explains `.env.local.{dev,prod}` template files, the grep one-liner to confirm target DB, and the requirement to confirm with the user before running data-writing pipelines against prod.
  - New "Data-state changes vs schema changes" section: codifies the per-env runtime-action loop (run local → verify → switch to prod → re-run → switch back → trailer `Verified: local + prod`).

- **Fixed latent pipeline bug** (FIX-156, commit `e97c9b08`): `packages/data/src/pipelines/connections/index.ts:355` still wrote `from_type: "financial"` for donor rows; bypassed in production by the SQL rebuild path, but `pnpm data:connections` would have re-introduced exactly the rendering bug FIX-154 closed. Aligned to `"financial_entity"`.

- **Manual full prod refresh** (env switched to `.env.local.prod`, restored after):
  - **FEC bulk** — 1,959 PAC entities + 22,684 financial_relationships upserted, 0 failures
  - **USASpending bulk** — skipped cleanly (no new delta since 2026-04-06)
  - **CourtListener** — 365 judges + 280 opinions
  - **OpenStates** — aborted mid-run (took too long state-by-state); deferred to FIX-160 (bulk rewrite)
  - **agencies-hierarchy** — current, no changes
  - **elections** — 2,956 officials updated
  - **congress committees** — 230 committees + 3,879 memberships
  - **`data:nightly`** — Regulations 39 new, congress votes/officials updated, `rebuild_entity_connections()` invoked again (donation 22,715 → 22,904, post-delta), tag-rules clean, tag-ai queue-staged 63 new jobs (1,882 already pending), ai-summaries queue-staged 3 officials and **0 proposals — surfaced FIX-161**

- **AI kill-switches verified before run.** `.env.local.prod` has both `AI_SUMMARIES_ENABLED=false` and `CIVITICS_ENRICHMENT_MODE=queue`. Verified that `runAiTagger` ([ai-tagger.ts:527](packages/data/src/pipelines/tags/ai-tagger.ts#L527)) and `runAiSummariesPipeline` ([ai-summaries/index.ts:509](packages/data/src/pipelines/ai-summaries/index.ts#L509)) both early-return into queue staging mode before any `createAiClient()` call. Confirmed `runAiClassifier` is not invoked by the orchestrator. **Total Anthropic spend for the night: $0.**

- **FIX-161 caught and shipped same session** (commit `b85dba8f`): `ai-summaries/index.ts` `fetchOpenProposals` was still hitting the dropped `proposals.comment_period_end` top-level column (post-cutover it lives in `metadata` JSONB). Same drift pattern as FIX-112 fixed in `tags/rules.ts` but in a different file. Switched `.gt()` and `.order()` to `metadata->>comment_period_end`. ISO 8601 strings sort lexicographically the same as chronologically, so still-open semantics preserved. Smoke-tested against local: returns expected open-comment proposals in correct sort order.

- **Three audit-driven FIX items filed for systemic ambiguity** (deferred to their own sessions):
  - **FIX-157 (🟡 M)** — `/api/claude/status` should compare source-table counts to `entity_connections` derived counts and flag drift. The bug we just hit (22,715 source / 0 derived) would have been visible immediately.
  - **FIX-158 (🟡 S)** — pipelines should announce their target DB on startup and refuse to run against prod without `--allow-prod`. Prevents accidental cross-env writes when `.env.local` was last copied from `.env.local.prod`.
  - **FIX-159 (🟡 S)** — `fixes:sync` should track `Verified: local + prod` (or `local-only` / `prod-only`) trailers; surface in `done.log` so incomplete prod state becomes greppable.

- **One additional FIX item filed** during the OpenStates timing:
  - **FIX-160 (🟡 M)** — Rewrite OpenStates pipeline to use bulk dumps from `data.openstates.org`. Current per-state API approach is slow enough that the full state refresh got deferred mid-stream tonight. Same playbook as FEC bulk and FIX-118 USASpending bulk migrations.

**Final prod entity_connections (post-rebuild + post-nightly):**

| connection_type | rows |
|---|---:|
| donation | 22,904 |
| vote_yes | 100,311 |
| vote_no | 51,833 |
| contract_award | 36,032 |
| co_sponsorship / appointment / oversight / holds_position / gift_received / lobbying | 0 (no source data yet) |

**Commits:**
- `e97c9b08` — FIX-156 pipeline `from_type` align with SQL rebuild
- `b50b68d8` — CLAUDE.md additions: active-env check, data-state loop, session-continuity row
- `948ee874` — fixes:sync after FIX-156
- `28f663e7` — file FIX-160 (OpenStates bulk) and FIX-161 (ai-summaries column drift)
- `b85dba8f` — FIX-161 fix
- `815f0889` — fixes:sync after FIX-161

**⚠️ Action needed — none.** All commits pushed to `main`. Env restored to `.env.local.dev`.

**Up next:**

1. **FIX-161 verification on next prod nightly** — ai-summaries proposals queue-staging path should populate alongside officials. No code follow-up required if it works.
2. **FIX-157 (🟡 M)** — drift detection in `/api/claude/status`. Highest leverage of the three systemic FIXes; closes the loop that allowed tonight's bug to ship undetected for 5 days.
3. **FIX-158 (🟡 S)** — pipeline target-DB banner. Trivial, high cognitive ROI.
4. **FIX-159 (🟡 S)** — per-env trailer in fixes:sync. Trivial, makes existing patterns more honest.
5. **FIX-160 (🟡 M)** — OpenStates bulk rewrite. Unblocks future state-data refreshes from Claude sessions.

---

## 2026-04-25 (Graph 2.0 plan + FIX-120)

**Done:**

- **Graph audit** — comprehensive read of every panel component, hook, viz, registry, and API route under `packages/graph/` and `apps/civitics/app/api/graph/`. Surfaced ~15 dead-code / inconsistency findings: USER node had no panel affordance, `alignment` missing from `DEFAULT_CONNECTION_STATE`, AlignmentPanel writes to localStorage but never feeds graph state, ConnectionsTree filters by data-presence not focus-type, Browse hierarchy is flat (Congress + Industry PACs only), `addGroup`/`removeGroup` skip `markDirty()`, AI Explain isn't gated by `AI_SUMMARIES_ENABLED`, Spending viz orphaned, custom group builder unwired, PathFinder buried.

- **GRAPH_PLAN.md** — new authoritative plan organised by Direction 1 (cleanup) → Direction 3 (reactive panels) → Direction 2 (file-system browse hierarchy) → new connection types → new viz types → compare upgrade. Cross-cutting principles: never auto-switch viz, disable-don't-hide non-applicable controls, force graph stays universal, custom groups DB-backed, AI flag is the kill switch.

- **FIX-120 → FIX-153 filed** — 34 backlog items in `docs/FIXES.md`, each a one-liner pointing to a `GRAPH_PLAN.md §N.N` section so the FIXES file stays scannable. Includes new viz types (Hierarchy/Matrix/Alignment/Sankey), three new connection types (`appointment`, `revolving_door`, `contract`), and the file-system browse refactor.

- **FIX-120** — *(committed by Craig in `f3fdabdc`)* — surfaced USER node toggle in FocusTree, added `alignment` to `DEFAULT_CONNECTION_STATE`, alignment edge color-coded by ratio.

- **Prereq investigations completed inline:**

  1. **`spending_records` (FIX-148):** table was DROPPED in the cutover migration `20260422000000_promote_shadow_to_public.sql:256`. Data now lives in `financial_relationships` with `relationship_type IN ('contract','grant')`. USASpending pipeline already migrated. RPCs `chord_contract_flows` + `treemap_recipients_by_contracts` restored by FIX-110. **One real bug remains**: `packages/data/src/pipelines/index.ts:45` still queries the dropped table for the status dashboard. **Three docs are stale:** root `CLAUDE.md`, `apps/civitics/CLAUDE.md`, `docs/PHASE_GOALS.md:202`. → **FIX-151** filed.

  2. **Committees (FIX-139):** no `committees` table exists. `governing_body_type` enum has no `'committee'` value. `officials.governing_body_id` is a single FK so multi-committee membership isn't modelable today. No data ingested. → **FIX-152** (schema: enum value + `official_committee_memberships` join table) and **FIX-153** (Congress.gov committees endpoint ingestion) filed as prereqs.

- **Direction & priorities locked with Craig:**
  - Order: Direction 1 → 3 → 2.
  - USER node visible/toggleable is enough for now; full alignment-scoring pipeline stays Stage 2.
  - Custom groups go straight to a `user_custom_groups` DB table — skip localStorage.
  - Empty-state UX: keep the search prompt; add 2–3 visual preset buttons (Force / Treemap / Chord) so newbies get one-click started.
  - **Never auto-switch viz on the user.** The viz dropdown should self-populate based on focus + connections; selection stays manual.
  - AI Explain button must be gated by `FLAGS.AI_SUMMARIES_ENABLED` — the flag is the platform-wide kill switch for Anthropic calls. → **FIX-122** filed.
  - Custom group builder also embedded on `/agencies` page (Craig's add).

- **packages/graph/CLAUDE.md** — pointer-only update at the top; deeper rewrites land per FIX-150 as each section ships. Saved-session compatibility preserved (BUILT_IN_GROUPS / BUILT_IN_PRESETS IDs unchanged).

**Commits:**
- `f3fdabdc` (FIX-120 — Craig)
- `efc07a23` (FIX-120 sync — Craig)
- `4b87e166` (GRAPH_PLAN + FIX-121..153 backlog)
- `a6830150` (HIT_LIST session notes)

**⚠️ Action needed — none.** All commits pushed to `main`. No migrations this session.

**Up next:**

1. **FIX-122 (🟡 M)** — Gate `/api/graph/narrative` by `AI_SUMMARIES_ENABLED`; hide ✨ Explain button when off. Small, high signal-to-noise.
2. **FIX-121 (🟢 S)** — `addGroup`/`removeGroup` call `markDirty()`. Trivial.
3. **FIX-126 (🟠 L)** — `user_custom_groups` table + `/api/graph/custom-groups` route. Unblocks FIX-127 (custom group builder UI), which itself unblocks the agencies-page sidebar widget.
4. **FIX-128/129/130** — the reactive-panels trifecta (Connections gates by focus, viz dropdown self-populates, settings disable-don't-hide). Highest UX leverage in the plan.
5. **FIX-151** — once it lands, FIX-148 (Spending viz wire-up) becomes small.

---

## 2026-04-25 (USER node in connection graph — FIX-042)

**Done:**

- **FIX-042** — Added the signed-in user as a first-class node in the D3 force graph, connected to their district's federal representatives (2 senators + 1 house rep) with alignment score edges.

  **Migrations (local + Pro):**
  - `20260425101000_user_preferences_location.sql` — adds `home_state TEXT` and `home_district INT` to `user_preferences`
  - `20260425102000_compute_alignment_score.sql` — `compute_alignment_score(user_id, official_id)` RPC; joins `civic_comments × votes` on substantive proposals; returns `alignment_ratio`, `matched_votes`, `total_votes`, `vote_details JSONB`; `SECURITY DEFINER`, `GRANT EXECUTE TO authenticated`

  **New API routes:**
  - `GET/PUT /api/profile/preferences` — reads/upserts `home_state + home_district` for signed-in user
  - `GET /api/profile/districts?state=CO` — returns sorted distinct House CD numbers for a state
  - `GET /api/graph/my-representatives` — returns 3 federal reps (senators + house rep) with alignment scores

  **Profile page:**
  - New `DistrictPickerForm.tsx` client component — state dropdown, district dropdown (fetched from API), save button, live preview of 3 federal representatives after save

  **Graph package:**
  - Added `'user'` to `NodeType` union
  - Added `'alignment'` to `CONNECTION_TYPE_REGISTRY`
  - `ForceGraph.tsx` — user node renders as purple double-ring circle with "YOU" label, pinned at canvas center; alignment edges color-coded by ratio (green ≥0.6 / amber ≥0.4 / red <0.4 / gray = no overlap); `AlignmentEdgeTooltip` shows %, vote count, and up to 5 specific votes on edge hover

  **GraphPage.tsx:**
  - Fetches `/api/graph/my-representatives` on mount; injects synthetic USER node + alignment edges via `displayNodes`/`displayEdges` useMemo (bypasses useGraphData — no DB connection fetch for a synthetic node); unauthenticated and unconfigured users see no USER node, no errors

  **Pre-check confirmed:** 0 federal officials missing `state_abbr` — conditional migration step was skipped

**Commits:** `44829221` (feat — 11 files), `6a606412` (chore sync)

**Deferred as new FIX items:**
- ZIP code → district lookup
- Issue-area breakdown in alignment tooltip (needs `proposals.category`)
- State legislators

**⚠️ Action needed — none.** Both migrations applied local + Pro. All commits pushed to `main`.

**Up next:**

1. **Drain sessions** — continue draining `enrichment_queue` (~114k pending). Standard drain prompt with `drain-worker` subagent type.
2. **FIX-116 (🟡 S)** — Tighten OpenStates people-endpoint rate limiting.
3. **FIX-110 (🟡 M)** — New RPCs for contract/grant flow visualisations.

---

## 2026-04-25 (USASpending bulk pipeline — FIX-118, FIX-119)

**Done:**

- **FIX-118** — Replaced the paginated USASpending API pipeline (top-20 agencies, top-100 awards ≥$1M, FY2024 only) with a full bulk archive approach. Downloads `FY{YEAR}_All_Contracts_Full_{YYYYMMDD}.zip` (529 MB → 2GB uncompressed) on first run; uses consolidated Delta files on subsequent runs. State tracked in `packages/data/.usaspending-bulk-state.json` (gitignored). Filters to agencies in `public.agencies`, reuses `upsertSpendingRelationshipsBatch` writer. New script: `pnpm --filter @civitics/data data:usaspending-bulk`; `--force` flag forces full re-run. First run: **837k contracts upserted** across all federal agencies. USASpending storage budget raised to 250MB in `packages/data/CLAUDE.md`.

- **FIX-119** — Fixed sub-agency attribution. Three bugs combined to zero out several agencies:
  1. Pipeline only checked `awarding_agency_name` — Forest Service contracts landed on USDA instead of FS.
  2. CSV sub-agency names sometimes carry "U.S." prefix (e.g. `"U.S. Immigration and Customs Enforcement"`) while DB names don't — ICE, CBP, USCG, USCIS contracts were routing to DHS.
  3. DB names like "U.S. Department of Agriculture" didn't match CSV's "Department of Agriculture".
  
  Fixes: (a) pipeline now checks `awarding_sub_agency_name` before `awarding_agency_name`; (b) strips `"U.S. "` from both DB name keys and CSV lookup keys; (c) seeded ICE, TSA, FEMA as DHS sub-agencies via migration `20260425000800`. Re-ran `--force` after fix — same 841k matched (contracts were already landing on DHS; they now correctly route to ICE/CBP/etc.).

- **Display fix** — `DHS`, `EOP`, `ICE` were missing from `AGENCY_NAMES` in `packages/db/src/agency-names.ts`. `agencyFullName()` returns the acronym itself when a key is missing (not null), so the `?? agency.name` fallback in `agencies/page.tsx` never fired — those cards showed "DHS", "EOP", "ICE" instead of the full name. Added all three.

**Commits:** `773a5fd6` (FIX-118 docs), `4fe275f6` (FIX-036–041 reimpl), `9f645a00` (FIX-119), `81395fbe` (sync), `f2f5b710` (display + pipeline lookup fix).

**⚠️ Action needed — none.** All migrations applied local + Pro. All commits pushed to `main`.

**Up next:**

1. **Drain sessions** — continue draining `enrichment_queue` (~114k pending). Standard drain prompt with `drain-worker` subagent type.
2. **FIX-116 (🟡 S)** — Tighten OpenStates people-endpoint rate limiting.
3. **FIX-110 (🟡 M)** — New RPCs for contract/grant flow visualisations (`chord_contract_flows`, `treemap_recipients_by_contracts`).

---

## 2026-04-24 (pipeline cleanup — FIX-111, FIX-113, FIX-115)

**Done:**

- **FIX-111** — Deleted 6 dead shadow-era pipeline files (`fec/index.ts`, `pac-classify/index.ts`, `financial-entities/index.ts`, `connections/shadow.ts`, `connections/delta.ts`, `initiatives/shadow-backfill.ts`) and removed `shadowClient`/`ShadowDb` from `utils.ts`. Dropped the `runConnectionsDelta` call + import from the nightly sync orchestrator. Removed 5 dead scripts from `packages/data/package.json`. **–2,001 lines.**
- **FIX-113** — Replaced the single-query `loadOfficials()` in `fec-bulk/index.ts` with a `range(offset, offset+999)` pagination loop. PostgREST's `max_rows=1000` was silently truncating local dev (9,158 officials → 1,000) and would eventually bite Pro as the federal roster grows.
- **FIX-115** — Refactored both the House and Senate vote-ingestion loops in `congress/votes.ts` from a per-roll `findOrCreateBillProposal` (1 SELECT + 1 INSERT per novel bill, serially) to a two-pass approach: Pass 1 fetches + parses all novel XML rolls and buffers bill args; new `resolveBillsBatch()` in `bills.ts` does one bulk `external_source_refs` lookup + one `upsertBillProposalsBatch` for novel bills; Pass 2 writes vote records using the resolved proposalId map. Also dropped the unused `upsertBillProposal` (singular) import.

**⚠️ Action needed — none** (no DB migrations; all commits pushed to `main`).

**Up next:**

1. **FIX-116 (🟡 S)** — Tighten OpenStates people-endpoint rate limiting (100ms → 1000ms inter-call sleep to reduce 429 retry stalls).
2. **FIX-117 (🟡 S)** — Add index on `enrichment_queue(entity_type, task_type)` to fix statement timeouts during seed snapshot reads; will close the ~17k gap in the Pro queue.
3. **Drain sessions** — continue draining the enrichment queue (~114k remaining). Use standard drain prompt with `drain-worker` subagent type.

---

## 2026-04-24 (enrichment drain session 2 — ~3,200 items landed, drain-worker agent locked down)

**Done:**

- **Resumed the interrupted drain.** Session 1 (previous day) had left 3,600 rows stuck in `processing` (1,800 tag + 1,800 summary) with 3,240 done. Reclaimed via new `pnpm data:drain:status --reclaim` helper (see below).
- **5 waves × 12 subagents (6 tag + 6 summary, parallel).** Items landed on Pro this session:
  - **Tag: +1,436** done (waves 1–4 clean; wave 5 tag agents all hit the Haiku rate limit before writing any results file)
  - **Summary: +1,790** done (every wave landed, a few agents shorted by 1–10 items, one overshot by 4 which submit silently dropped)
- **`enrichment_queue` final state:** 59,931 tag + 59,083 summary pending, 3,059 tag + 3,407 summary done. Total done across both sessions: ~6,500 of 120k. Rate-limit was the binding constraint, not throughput.
- **New `packages/data/src/drain/status.ts`** — `data:drain:status` script. Snapshots counts by status × task_type, flags stale `processing` claims with `--stale-minutes N` (default 10), reclaims with `--reclaim`. Added `pnpm data:drain:status` to `packages/data/package.json`.
- **Subagent permission lockdown.** Caught a `general-purpose` drain subagent installing `@anthropic-ai/sdk` at workspace root and billing Anthropic API calls mid-drain despite the prompt's "no external APIs" instruction. Created `.claude/agents/drain-worker.md` with `tools: Read, Write` only — the subagent now physically cannot shell out, install packages, or call external APIs. Belt-and-braces denies added to `.claude/settings.local.json` for `pnpm add` / `npm install` / `yarn add`. Updated `CLAUDE.md` with a drain runbook so next session picks up correctly with the standard prompt.

**Hazards observed this session (recorded in CLAUDE.md runbook):**

- **CWD trap** — `cd packages/data` in a chained Bash line fails silently if cwd is already `packages/data`, and the claim script then resolves `--output` relative to the wrong dir. Cost us 720 orphaned claims in wave 2 before reclaim. Fix: the runbook now says to check cwd first, and the reclaim sweep catches it.
- **Count drift** — 3 subagents shorted the batch count (50/60 instead of 60/60), 1 overshot (64/60). `applyResult()` handles both correctly; missing ids stay `processing` for next reclaim sweep.
- **Rate-limit return** — Haiku rate limit manifests as `"You've hit your limit · resets <time>"` in the subagent's return string with no results file written. 7 of 12 wave-5 agents hit it simultaneously once we were ~5k items in.

**Uncommitted state (needs Craig's attention):**

- `packages/data/src/drain/status.ts` (new) + `packages/data/package.json` (added `data:drain:status`) — keep.
- `.claude/agents/drain-worker.md` (new) + `.claude/settings.local.json` (added install denies) — keep.
- `docs/SESSION_LOG.md`, `CLAUDE.md` — this entry + the runbook.
- `.env.example` was already dirty pre-session, unrelated.

**⚠️ Action needed:** review + commit the files above. No DB migrations this session.

**Up next:**

1. Re-run the same drain prompt once the Haiku rate limit resets (shown as 11:10pm PT on the last agent failure). With `drain-worker` in place, wave 5 will complete cleanly instead of burning credits on side-channel API calls.
2. Eventually — FIX-109 industry tagger (highest-signal unlock still unblocked).
3. Continue drain sessions until `enrichment_queue` done count ≈ 120k. At ~3,500 items/session this is ~30 sessions; worth considering whether to batch larger waves or run a pure CLI drain against a real Anthropic account if Claude Max pacing becomes the limiting factor.

---

## 2026-04-23 (FIX-101 closed — all 6 deferred pipelines landed + AI queue seeded)

**Done — FIX-101 bundle, 10 commits:**

- **FEC bulk** (`3274609d`) — writer.ts batched, dropped partial unique on `canonical_name`/`entity_type`, added full unique on `(relationship_type, from_id, to_id, cycle_year)`. Pro: **1,960 PACs + 22,659 donations** in 1m5s (was estimated ~55 min pre-batching).
- **Quick wins** (`06a049a8`) — `congress/bills.ts` proactive sync batched via new `upsertBillProposalsBatch()`; `tags/rules.ts` `upsertTags()` chunked.
- **USASpending** (`e3a02108`) — `writer.ts` with batched recipient resolution via `external_source_refs` (source='usaspending_recipient'). Converted `financial_relationships_usaspending_unique` from partial to full. Deleted `spending-shadow/` (two-pass migration obsolete). Pro: **679 corps + 1,480 contracts** in 16s.
- **Followups filed** (`ebcc3c88`) — FIX-107 through FIX-115 (missing agencies, RPC chamber/state inference, industry tagging, contract-flow RPCs, shadow-pipeline cleanup, tags/rules stale refs, FEC bulk officials pagination, USASpending grants, reactive bills batching).
- **Regulations.gov** (`3d49dd49`) — dropped writes to the removed `regulations_gov_id` / `comment_period_{start,end}` / `source_ids` columns; all regulations-specific fields ride in `proposals.metadata` + dedup via `external_source_refs`. Added `UNIQUE(acronym)` on agencies. Added 5 missing agency names (RHS, ONCD, FSOC, FAS, OFAC) + backfilled names on Pro. Pro: **+1,000 regulation proposals** in 16.6s.
- **OpenStates** (`8043c29a`) — writer.ts with batched `resolveGoverningBodies()` + `upsertLegislatorsBatch()` + `upsertStateBillsBatch()`. Backfill migration for officials with `source_ids->>'openstates_id'`. Pro: **1,161 legislators + 440 state bills** across 11 states; daily quota paused at GA. Idempotent re-run picks up remaining 39 states.
- **Legistar × 3 metros** (`2004ae97`) — writer.ts with six batched helpers. 67,155 matters + 1,620 persons + 255 bodies landed on Pro in under 4 minutes (was ~7h as per-row SELECT+INSERT; **~100x speedup**). SF events phase hits the same HTTP 400 documented 2026-04-20 — bodies/persons/matters land, meetings skipped.
- **CourtListener** (`4eb90ec6`) — writer.ts with `resolveJudicialGovBodies()` + `upsertJudgesBatch()` + `upsertOpinionsBatch()`. Backfill migration for courtlistener judges' source_refs. Pro: **365 judges updated + 280 opinions + 280 case_details** in 46s.
- **AI enrichment queue seed** (`645c51ae`) — `data:enrich-seed` ran against Pro, **125,480 items staged** (60k proposal tags + 60k summaries + 3k official tags + 3k official summaries). Zero Anthropic calls — worker drains out-of-band via `claim_enrichment_batch()` in a separate session. Tuned `UPSERT_CHUNK` 500 → 100 and `PAGE` 1000 → 500 after hitting Pro's ~8s statement timeout on bigger batches. **Closes FIX-101 via trailer.**
- **fixes:sync status** (`72db20c7`) — flipped FIX-101 to `[x]`, appended to `docs/done.log`.

**Final Pro state:**

| Table | Count |
|---|---|
| `officials` | 3,684 (903 federal + 1,161 state + 1,620 city) |
| `proposals` | 69,557 (congress + regulations + state + city + opinions) |
| `bill_details` | 68,276 |
| `case_details` | 280 |
| `meetings` | 130 (SF events blocked by sfgov HTTP 400) |
| `financial_entities` | 2,639 |
| `financial_relationships` | 24,139 (22,659 donation + 1,480 contract) |
| `external_source_refs` | ~71,000 |
| `enrichment_queue` | 125,480 pending |

**Architectural pattern established across all 6 writers:**

1. Collect records into an array
2. Batch-lookup existing via `external_source_refs.in("external_id", chunk)` with chunk ≤ 200
3. Partition into `toUpdate` (known id) and `toInsert` (new)
4. Batched `upsert(records, { onConflict: "id" })` for updates — always pass **full-row records**, not partial, because `ON CONFLICT DO UPDATE` still validates the INSERT clause against NOT NULL
5. Batched `insert(records).select("id")` for new — Postgres preserves input order so zip back to the source array
6. Batched insert of `external_source_refs` and child tables (bill_details / case_details) after IDs are known
7. `onConflict` column lists must target a **full unique index**, not partial — PostgREST's column-list inference doesn't reliably match partials; converted 3 partials to full during the session

**Followups filed this session (FIX-107 through FIX-117):**

- FIX-107 — 6 missing top-20 federal agencies (DOD, TREAS, DOS, DOL, GSA, SSA); USASpending silently skips these
- FIX-108 — `treemap_officials_by_donations` chamber/state inference mis-classifies House reps whose FEC id starts with 'S'
- FIX-109 — tag `financial_entities` with industry (chord viz is stuck at "Untagged" without it)
- FIX-110 — new RPCs to surface contract/grant flows (`chord_contract_flows()`, `treemap_recipients_by_contracts()`)
- FIX-111 — delete obsolete shadow-era pipelines (`fec/index.ts`, `pac-classify/`, `financial-entities/`, `connections/shadow.ts`, `connections/delta.ts`, `initiatives/shadow-backfill.ts`, `shadowClient` helper)
- FIX-112 — `tags/rules.ts` references dropped columns (`proposals.comment_period_end`, `financial_relationships.official_id`)
- FIX-113 — FEC bulk `loadOfficials()` silently truncated at PostgREST max_rows=1000
- FIX-114 — USASpending grants fetch (contracts-only today)
- FIX-115 — batch reactive `findOrCreateBillProposal` path in `congress/votes.ts`
- FIX-116 — tighten OpenStates people-endpoint rate limiting (100ms → 1000ms to avoid 429 retry stalls)
- FIX-117 — index `enrichment_queue(entity_type, task_type)` so seed snapshot reads don't hit statement timeout; closes the remaining ~17k gap on next seed run

**⚠️ Action needed — none** (all migrations applied on both local + Pro; all commits pushed to `main`; prod deploys triggered).

**Up next — everything post-FIX-101:**

1. **FIX-109 (🟠 L)** — industry tagger for `financial_entities`. Single highest-signal unlock: the chord viz has all the financial data it needs, it's just one JOIN away from visible. Could be rules-based (CONNECTED_ORG_NM / NAICS keyword match) or a one-shot AI classify pass.
2. **Drain the enrichment queue** — run a worker session to call `claim_enrichment_batch()` + process tags/summaries. 125k items, can run over multiple sessions.
3. **FIX-110 (🟡 L)** — surface contract/grant flows in graph.
4. **FIX-108 (🟡 M)** — fix treemap chamber/state inference.
5. **FIX-111 (🟡 M)** — delete dead shadow-era pipeline code. Cleanup commit.
6. Smaller items: FIX-107 agency seed, FIX-112 rules.ts fixes, FIX-113/114/115/116/117.

---

## 2026-04-22 (FIX-101 pt 1 — FEC bulk rewritten, batched, landed on Pro)

**Done:**

- **FEC bulk pipeline — shadow → public rewrite.** New `packages/data/src/pipelines/fec-bulk/writer.ts` replaces the deleted `shadow-writer.ts`. Writes directly to `public.financial_entities` + `public.financial_relationships` (post-promotion schema). Old per-row `SELECT → INSERT/UPDATE` pattern replaced with chunked `upsert({ onConflict })`. Entities chunk on `fec_committee_id`; donations chunk on the new `(relationship_type, from_id, to_id, cycle_year)` tuple.
- **Migration `20260423000000`** — adds `financial_relationships_relcycle_unique` (full unique, not partial — PostgREST's upsert can't target a partial unique index via column-list `ON CONFLICT`), drops legacy `UNIQUE(canonical_name, entity_type)` on `financial_entities` that forced false merges between distinct FEC committees whose normalised names collide. Replaces with a non-unique lookup index of the same shape. Applied to local + Pro (`supabase db push --linked`).
- **`supabase/config.toml`** — dropped `shadow` from PostgREST exposed schemas (was causing schema-cache failures on local since the shadow schema no longer exists).
- **Client-side relationship dedup** — officials with multiple FEC IDs (e.g. old House `fec_candidate_id` + newer Senate `fec_id`) cause the same PAC → same-official aggregate to appear twice under different committee-candidate keys. Batched upsert rejects internal conflict-target collisions; the writer now merges these client-side before the upsert (sum amounts, sum tx_count, keep latest `occurred_at`).
- **`spending-shadow/index.ts`** — stopgap import redirect from deleted `../fec-bulk/shadow-writer` to `../fec-bulk/writer` (spending-shadow is scheduled for deletion as part of the broader FIX-101 backlog).

**Pro counts (post-run):**
- `financial_entities`: **1,960** (was 0 pre-cutover)
- `financial_relationships`: **22,656** donation rows for cycle 2024 (was 0)
- FEC match rate: 479 by direct `fec_id` + 383 by name fallback = 862 of 903 officials
- Top donors: AIPAC $3.2M, American Crystal Sugar $2.3M, Realtors $2.1M, Machinists $2.0M

**Perf:**
- Local: **8.5s** end-to-end (was ~90s with per-row round-trips)
- Pro: **1m 5s** (estimated ~55 min pre-batching — first attempt was killed at 40% after 30 min of silent per-row progress)

**RPCs verified against Pro:**
- `chord_industry_flows()` → returns rows ($61.7M Rep House, $57.9M Dem House, etc.). All `industry='untagged'` for now — `entity_tags` industry tagging still pending as a separate enrichment task.
- `treemap_officials_by_donations(3)` → returns top-raising officials with real `total_donated_cents`.

**⚠️ Action needed — none** (migration applied, data loaded, RPCs green).

**FIX-101 progress** — 1 of 8 pipelines done:
- ✅ **FEC bulk** (this session)
- ⬜ USASpending
- ⬜ Regulations.gov
- ⬜ OpenStates
- ⬜ CourtListener
- ⬜ Legistar × 4 metros
- ⬜ tag-rules / ai-summaries / tag-ai (via `CIVITICS_ENRICHMENT_MODE=queue` when run)

**Up next (FIX-101 continuation):**

1. **USASpending** (264 lines, writes `financial_relationships` with `relationship_type='contract'/'grant'`) — expands chord/treemap with government spending flows.
2. **Regulations.gov** (300 lines, writes `proposals` for active rulemakings).
3. **Legistar × 4** (1,106 lines, writes metro officials + proposals).
4. **OpenStates** → **CourtListener** → deletion pass for `spending-shadow/`, `connections/shadow.ts`, `initiatives/shadow-backfill.ts`, `shadowClient` helper.

---

## 2026-04-22 (Supabase Pro cutover + smoke-test fixes)

**Done — Supabase Pro provisioning + shadow→public promotion:**

- Provisioned Pro project `xsazcoxinpgttgquwvuf` ($25/mo). Linked CLI via `supabase link --project-ref xsazcoxinpgttgquwvuf`.
- Wrote + applied `20260422000000_promote_shadow_to_public.sql`: dropped 11 legacy RPCs + `proposal_trending_24h` materialized view, truncated stale public child tables, `ALTER … SET SCHEMA` moved 17 shadow tables + helper functions to `public`, dropped the empty `shadow` schema, rebuilt RLS.
- **Latent bug fix** (`20260422000001`): `ALTER FUNCTION … SET SCHEMA` moves function membership but **does not rewrite body text**. `bill_details_sync_denorm()` trigger body still read `FROM shadow.proposals` after the move, so every `bill_details` INSERT 500ed. Fixed via `CREATE OR REPLACE FUNCTION` with `public.proposals` in body. Documented in runbook as carry-forward lesson.

**Done — Option C pipeline rewrites (scoped to minimum viable):**

- `packages/data/src/pipelines/congress/bills.ts` — single-write to `public.proposals` + `public.bill_details` + `public.external_source_refs`. Dedup via `external_source_refs` (unique on source+external_id). Shadow mirror deleted.
- `packages/data/src/pipelines/congress/votes.ts` — references `bill_details.proposal_id` via `bill_proposal_id`; synthesizes `roll_call_id` (House `${year}-house-${paddedRoll}`, Senate `senate-${congress}-${session}-${paddedRoll}`); populates `voted_at`, `vote_question`, `source_url`. Reactive-create fallback now uses bill number as title (prevents "On Passage" garbage).
- All other pipelines (FEC, regulations, USASpending, OpenStates, CourtListener, Legistar, connections, tags, AI) left untouched — tracked for reimplementation as FIX-101.

**Done — data backfill:**

- Backfilled 243 of 550 orphan proposals (missing bill_details from early broken runs) via INSERT from `proposals.metadata`. Remaining 307 duplicates blocked by `(jurisdiction_id, session, bill_number)` unique — tracked as FIX-102.
- Rewrote 786 procedural-title proposals (e.g. "On Passage", "On Cloture Motion") to use `metadata->>'legacy_bill_number'` as title.
- Post-cutover Pro counts: **903 officials · 989 proposals · 682 bill_details · 217,548 votes**. Integrity audit shows 4 pre-existing data-scope errors (POTUS/VP not ingested, 3 House vacancies, 1 senator NULL state) — zero pipeline errors.

**Done — branch + Vercel ops:**

- Pushed cutover commit to `qwen/phase1`, user renamed `master` → `main` on GitHub, local `git branch -m master main && git branch -u origin/main main`, fast-forwarded, deleted `qwen/phase1` local + remote.
- Fixed Vercel Hobby cron limit failure: changed `notify-followers` from `0 */6 * * *` to `0 3 * * *` (once/day max on Hobby). Commit `d8174f86`.
- Locked git identity: `user.email = civitics.platform@gmail.com`, `user.name = Civitics Platform`. Machine's default `craig.a.denny@gmail.com` attributes to a separate personal GitHub account (`midnighttoker420`). Saved as persistent memory.
- Deployed green. Prod URL: `https://civitics.com` (custom domain; Vercel default `civitics-civitics.vercel.app` still active).

**Done — docs + post-cutover backlog:**

- New: `docs/MIGRATION_RUNBOOK.md` (archives plan §4 as actuals + lessons).
- Updated: `CLAUDE.md`, `docs/OPERATIONS.md`, `docs/REBUILD_STATUS.md` to reflect two-tier env (local Docker + Pro), `main` as prod, schema now `public.*`.
- Filed POST-CUTOVER section in `docs/FIXES.md`: FIX-097 (chord/treemap RPCs), FIX-098 (officials-breakdown RPCs), FIX-099 (search_graph_entities), FIX-100 (rebuild_entity_connections derivation), FIX-101 (deferred pipeline re-runs), FIX-102 (307 orphan proposals cleanup), FIX-103 (officials_breakdown `.catch is not a function`), FIX-104 (recreate proposal_trending_24h + refresh fn).

**Done — smoke-test fixes (same session):**

- **FIX-105**: `/proposals` default filter changed from `"open"` to `"all"`. Root cause: `"open"` required `status='open_comment'` AND `metadata->>comment_period_end > now()`; all 989 congress-bill proposals have `status='introduced'` with no comment period, so landing was empty.
- **FIX-106 (filed, not implemented)**: Add 6-digit OTP option alongside magic link in `SignInForm`. Not a regression — never actually existed in code; user misremembered.
- **Auth magic link** was failing on Pro because Supabase project Auth → URL Configuration didn't allowlist the prod host. User added `https://civitics.com/**` + `https://civitics-civitics.vercel.app/**` + `http://localhost:3000/**` to Redirect URLs and set Site URL to `https://civitics.com`. `NEXT_PUBLIC_SITE_URL=https://civitics.com` set in `.env.local` and Vercel.

**Smoke test results (user walk-through):**

| # | Surface | Result |
|---|---|---|
| 1 | Homepage | ✅ |
| 2 | Officials list + detail | ✅ |
| 3 | /proposals | ❌ 0 rows → fixed via FIX-105 |
| 4 | Graph page | ✅ |
| 5 | Dashboard | ✅ (Transparency/Operations panels partially blank — FIX-097/098) |
| 6 | Search | ✅ (basic) — graph-search broken (FIX-099) |
| 7 | Auth | ❌ magic link + no OTP → fixed via Supabase URL config + FIX-106 filed |

**⚠️ Action needed — none** (all work pushed to `main`; prod green).

**Up next — POST-CUTOVER queue, in suggested order:**

1. **FIX-103** (🟡 S) — Fix `.catch is not a function` in `/api/claude/status` officials_breakdown handler. 5 min.
2. **FIX-104** (🟡 S) — Recreate `proposal_trending_24h` mat view + `refresh_proposal_trending()`. Restores homepage trending + /proposals Featured section.
3. **FIX-100** (🟠 L) — Implement `rebuild_entity_connections()` derivation rules. Unblocks graph.
4. **FIX-097 / FIX-098 / FIX-099** (🟠 M–L) — Rewrite the 10 dropped RPCs against polymorphic `financial_relationships`.
5. **FIX-101** (🟠 L) — Re-run deferred pipelines against Pro (FEC, Regulations.gov, OpenStates, CourtListener, Legistar × 4, USASpending, tag-rules, ai-summaries, tag-ai).
6. **FIX-102** (🟡 M) — Delete 307 orphan proposals (after confirming zero vote FKs).
7. **FIX-106** (🟠 M) — 6-digit OTP option in SignInForm.

---

## 2026-04-20 (Legistar city council pipeline — 4-metro load)

**Done:**

- **shadow-initiatives backfill** (`data:shadow-initiatives`) and **shadow-connections** (`data:shadow-connections`) pipelines both ran clean from the previous session.

- **Legistar pipeline built and fully validated** across 3 working metros:
  - `packages/data/src/pipelines/legistar/` — types, client, mappers, orchestrator (index.ts)
  - 6-step pipeline per metro: Bodies → governing_bodies, Persons → officials, Matters → shadow.proposals + bill_details, Events → shadow.meetings, EventItems → shadow.agenda_items, Votes → shadow.votes
  - Delta cursor support via `pipeline_state` keyed `legistar_{client}_last_run`
  - `data:pilot-metros` script seeds 5 city jurisdictions (Seattle, SF, NYC, Austin, DC)

- **4 bugs found and fixed during validation:**
  1. `officials` NOT NULL on `governing_body_id`, `jurisdiction_id`, `role_title` — `syncPersons` now resolves primary council body before inserting
  2. `external_source_refs` queries hitting `public` schema instead of `shadow` — all reads/writes switched to `sdb` client
  3. Source key collision — matters and events both used `config.source` ("legistar:seattle"), so EventId=N matched MatterId=N in the UNIQUE(source, external_id) constraint; fixed by scoping keys: `:body`, `:person`, `:matter`, `:event`, `:item`
  4. `bill_details` duplicate key on `(jurisdiction_id, session, bill_number)` — cities (Austin) reuse file numbers; switched to `upsert … ignoreDuplicates: true`

- **Final loaded state:**

  | Metro | Bodies | Officials | Proposals | Meetings |
  |---|---|---|---|---|
  | Seattle | 81 | 605 | 13,411 | 91 |
  | Austin | 23 | 604 | 19,857 | 36 |
  | San Francisco | 151 | 410 | 33,880 | 0 |
  | **Total** | **255** | **1,619** | **67,148** | **127** |

- **Known blockers documented in code:**
  - NYC: Legistar slug is `nyc` (not `newyork`), requires API token (403) — commented out pending auth
  - SF meetings: `sfgov` Events endpoint returns server-side Legistar config error (`Agenda Draft Status not setup`) — no workaround; bodies/officials/proposals fully loaded

**⚠️ Action needed — none** (no migrations this session; all pipeline state in local Supabase)

**Up next:**

- NYC Legistar access — either request API token from NYC Council or find alternative (NYC Open Data)
- Re-run FEC bulk on 2022/2020 cycles (was "up next" from previous session, still pending)
- Open data quality bugs: FIX-068/069 (President/VP missing), FIX-070 (3 House reps missing), FIX-071 (senators NULL state), FIX-066 (proposals contamination root cause)
- `shadow.rebuild_entity_connections()` — L5 derivation job (was on list from 2026-04-19)

---

## 2026-04-19 (Stage 1B vertical slices — congress + FEC bulk)

**Done — Stage 1B congress.bills shadow dual-write:**

- Extracted `bills.ts` from the monolithic congress pipeline into its own module.
- Added shadow dual-write for votes alongside the existing public write (per L7 polymorphic plan; bills themselves stay public for now).
- All shadow inserts hit `shadow.*` via the new `shadowClient(db)` helper in `pipelines/utils.ts`, which hoists the `(db as any).schema("shadow")` cast and exports a `ShadowDb` type — keeps every pipeline's shadow path one-line consistent until the generated `Database` types catch up.

**Done — Stage 1B FEC bulk shadow-native rewrite (Decision #4):**

- Replaced the legacy `pipelines/fec-bulk/index.ts` (~920 lines rewritten) with a shadow-only path. No dual-write — public.financial_* freezes at last legacy state and Stage 1B read-cutover flips queries to shadow.
- New `shadow-writer.ts` (~262 lines) exports `canonicalizeEntityName`, `cmteTypeToShadowEntityType`, `upsertPacEntityShadow`, `upsertDonationRelationshipShadow`. Two-pass pipeline:
  - Pass A — unique committees → `shadow.financial_entities` (dedup on `fec_committee_id` UNIQUE).
  - Pass B — each (cmte × cand × cycle) aggregate → `shadow.financial_relationships` (dedup via SELECT on the `financial_relationships_derivation` compound index).
- 23505 handler has both `fec_committee_id` race recovery **and** `(canonical_name, entity_type)` fallback so canonical-name collisions self-heal on the next run instead of failing.
- Removed the four synthetic weball aggregates ("Individual Contributors", "PAC/Committee", "Party", "Self-Funded") — artifacts of the old narrow schema, no place in the polymorphic model.
- Removed inline `entity_connections` writes per L5 (derivation-only — `runConnectionsDelta` step in master orchestrator handles it).
- New post-check `supabase/scripts/stage1/03_fec_postcheck.sql` with five RAISE-EXCEPTION invariants (counts non-zero, polymorphic shape correct, no orphan from_id/to_id, donation temporal model honored) plus spot-check queries.
- Pipeline run: **1824 entities, 16263 relationships, zero invariant violations.** Top donor AIPAC PAC at $2.46M; top recipient Hakeem Jeffries with 264 distinct PAC donors.

**Done — PostgREST allowlist fix:**

- Initial run failed with "Invalid schema: shadow" (1825 failures). Root cause: `supabase/config.toml [api].schemas` defaulted to `["public", "graphql_public"]` so PostgREST rejected `.schema("shadow")` requests. Added `"shadow"` to the list (with a comment to drop it at Stage 1 cutover) — committed `05b8315d`. Fix requires `supabase stop && supabase start` to reload PostgREST.

**⚠️ Action needed — none** (config.toml already applied; pipeline already verified clean)

**Up next:**

- `shadow.rebuild_entity_connections()` TypeScript implementation (the L5 derivation job that consumes shadow.financial_relationships)
- `civic_initiatives` I-B shadow migration (next vertical slice)
- Legistar adapter scaffold for the 5-metro deep pilot (SEA/SF/NYC/DC/AUS)
- Seed `jurisdictions.coverage_status` for the 5 pilot metros (claim-queue feature)
- Re-run FEC bulk on additional cycles (2022, 2020) once 2024 is fully validated

---

## 2026-04-17 (session 2)

**Done:**
- GENERAL / CROSS-CUTTING FIXES sweep — all 5 remaining items cleared:
  - Marked already-completed items: loading/skeleton states (all 4 `loading.tsx` files), empty states (TASK-20), 404/error pages (TASK-24), Initiatives nav link (TASK-17) — checkboxes updated
  - **Clickable links audit**: agency chips in `ProposalCard` and proposal detail now link to `/proposals?agency=…`; dead `href="#"` "Submit comment" on agency detail page fixed to `/proposals/${rule.id}`; bill number and regulations.gov ID chips on agency detail are now `<a>` tags; agency acronym in search results `ProposalCard` now links to `/proposals?agency=…`
  - **Footer**: `Footer.tsx` created (`app/components/Footer.tsx`) — Civitics wordmark + mission tagline, all 6 nav links, copyright line, Privacy + Terms legal links; added to root `layout.tsx` (universal, appears on all scrollable pages; invisible below fold on full-screen layouts like officials/graph)
  - **Header consistency**: NavBar added to: `proposals/page.tsx`, `proposals/[id]/page.tsx`, `officials/[id]/page.tsx` (replaced custom breadcrumb header), `dashboard/page.tsx`, `profile/page.tsx`; full-screen layouts (`officials/page`, `agencies/page`, `graph/page`) retain specialized chrome; search page retains its custom search-form header

**Up next:**
- Officials: filtering improvements (chamber / state / issue area filter — 🟡 M)
- Community commenting UI on proposals (🟠 L — `civic_comments` table exists)
- Proposals: better filtering (source, status, topic, date range — 🟡 M)

---

## 2026-04-17

**Done:**
- Agency activity bar chart (`AgencyActivityChart.tsx`): CSS bar chart showing top 12 agencies by proposal count, rendered above the agency grid on `/agencies`; no D3 needed — Tailwind width-percentage bars
- White House / EOP featured card: migration `20260417000000_insert_whitehouse_eop.sql` inserts EOP with `is_whitehouse: true` in metadata; `WhiteHouseFeaturedCard` component pinned above the grid with gradient border; hidden when filters are active
- Sector filter: `AgenciesList.tsx` now has a "All sectors" dropdown that filters using the same 15-rule SECTOR_RULES inference already used for tags
- Agency inline slide-over panel: card clicks now open `AgencySlideOver` right-side drawer (stats, description, open-comment callout, graph + website links, "View full profile" CTA); Escape + backdrop to close; `aria-modal` + focus management

**⚠️ Action needed:**
- Run `supabase migration up --local` to apply `20260417000000_insert_whitehouse_eop.sql` (inserts the White House / EOP agency record)

**Up next:**
- Header/footer consistency audit (🟢 S) — Initiatives link still missing from header nav

---

## 2026-04-18 (session 2 — FIXES verification + proposals sort)

**Done:**

- **Proposals list sort-by dropdown** — added "Sort by" to `proposals/page.tsx` filter form with three options (Closing soon / Newest / A–Z), persists via `?sort=` URL param, included in `buildUrl` + Clear button check, default "closing_soon" is omitted from URL to keep canonical URLs clean.
- **FIXES.md stale-open sweep** — verified 9 items were already built and ticked them:
  - Homepage: Civic Initiatives featured section (`InitiativesSection` on `page.tsx`)
  - Proposals: Better filtering (all filters + sort done)
  - Proposals [id]: Reduce Official Comments friction (layout already separates community from official cleanly)
  - Initiatives: Add to header nav (dup of TASK-17)
  - Initiatives: Filters on list (stages, scope, topics, sort, Mine tab)
  - Initiatives: Argument board Sprint 3 (`ArgumentBoard.tsx` has 12-type comment system + reply threading + votes + flags)
  - Initiatives: "Post a problem" pathway (`/initiatives/problem`)
  - Initiatives: Draft → argument creation decision (`ArgumentBoard` enforces via draft lockout banner)
  - Community & Auth: Community commenting UI + Position tracking (`CivicComments` + `PositionWidget` both wired)

**⚠️ Action needed — none** (no migrations)

**Up next:**
- Proposals: Trending / Most Commented / New tabs (🟢 S) — now unblocked since comments exist
- Dashboard: browsable sitemap section (🟡 M)
- API response caching headers (🟡 M)
- Documentation: CONTRIBUTING.md (🟡 S) + public roadmap (🟢 S)

---

## 2026-04-18

**Done — Officials FIXES sweep:**

- **"View full profile" button**: `OfficialCard.tsx` button changed from subdued gray to `bg-indigo-600 text-white` primary style.
- **Federal/State badge**: Added to OfficialsList list item rows (compact "Fed"/"State") and officials detail page header (`[id]/page.tsx` — `source_ids` added to the DB select, badge placed beside the chamber badge). OfficialCard right-panel already had it.
- **Individual votes expand on click** (`VotesTab.tsx`): Vote rows with a `proposalId` or `voteQuestion` now show a ▼ chevron and expand on click. Expanded panel shows the `vote_question` from metadata and a "View proposal →" link. `metadata` added to the votes select in `[id]/page.tsx`; `voteQuestion` threaded through `allVotesForTab` → `ProfileTabs` type → `VotesTab` type.
- **Pre-existing TypeScript fix**: `byParent[a.parent_id]!.push(a)` in `api/initiatives/[id]/arguments/route.ts` (non-null assertion to satisfy `noUncheckedIndexedAccess`).
- **FIXES.md**: Ticked Federal/State badge, tabs (already done), votes expand, "View full profile" button, filtering (already done), share button (already done). Only "Current term + election status" (🟡 L) remains — requires data pipeline.

**⚠️ Action needed — none** (no migrations)

**Up next:**
- `PromoteSolutionButton` + `POST /api/initiatives/from-comment` (solution → initiative UI — 🟠 M)
- Community commenting UI on proposals (🟠 L — `civic_comments` table exists)

---

## 2026-04-16

**Done:**
- Verified migration `20260415223406_official_community_comments.sql` applied ✓
- Rate limiting on public API routes (`middleware.ts`):
  - `/api/search` — 30 req/min per IP
  - `/api/graph/narrative` — 5 req/min per IP (AI/Claude calls, stricter)
  - `/api/graph/*` — 60 req/min per IP
  - Returns 429 + `Retry-After` header; in-memory sliding window with 5-min cleanup
  - No new services; documented Upstash upgrade path in comments
- JSON-LD structured data on detail pages (SEO):
  - Officials: `schema.org/Person` (name, jobTitle, affiliation, party, image, sameAs)
  - Proposals: `schema.org/Legislation` (name, description, legislationType, publisher, datePublished, sameAs)
  - Both use `NEXT_PUBLIC_SITE_URL` env var for canonical URLs (falls back to `https://civitics.com`)

**Up next:**
- Clickable links audit (🟢 S) — pass across all pages, ensure every name/title/tag routes correctly
- Add Initiatives link to main header nav (🟢 S)
- Node right-click / options menu in graph (🟠 M)
- Agencies card improvements (🟡 M)

---

## 2026-04-15

**Done:**
- Paused Qwen workflow — Qwen Code no longer free; Claude now handles all implementation directly (updated CLAUDE.md + QWEN_PROMPTS.md)
- Marked TASK-04 through TASK-11 as COMPLETE (were done in earlier session, statuses not updated)
- TASK-22 complete: `ProposalShareButton.tsx` — share button on proposal detail page header and each `ProposalCard`
- TASK-23 complete: `OfficialComments.tsx` + `/api/officials/[id]/comments/route.ts` + migration `20260415223406_official_community_comments.sql` — community comments on official profile pages (new table, requires `supabase migration up --local`)
- TASK-24 complete: `not-found.tsx` (branded 404, 4 quick-link cards) + `error.tsx` (client-side error boundary, Try Again + Go Home)

**⚠️ Action needed:**
- Run `supabase migration up --local` to apply `20260415223406_official_community_comments.sql` before testing TASK-23

**Up next:**
- Rate limiting on public API routes (🟠 M — `/api/search`, `/api/graph/*`)
- Clickable links audit (🟢 S)
- FIXES.md items: agencies improvements, graph node right-click menu

---

## 2026-04-13 (a11y sprint)

**Done:** Full a11y (accessibility) audit and fix pass across the app.

**Files changed:**
- `app/components/NavBar.tsx` — skip-to-content link (sr-only, visible on focus); `aria-label="Main"` / `"Mobile"` on nav elements; `aria-controls="mobile-nav"` on hamburger; `id="mobile-nav"` on mobile menu; `focus-visible:ring` on all interactive elements
- `app/components/GlobalSearch.tsx` — `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-autocomplete="list"`, `aria-controls` on input; `role="listbox"` + `aria-label` on dropdown; `role="option"` + `aria-selected` on result links; `role="status" aria-live="polite"` region for search feedback
- `app/components/AuthButton.tsx` — `aria-expanded`, `aria-haspopup="menu"`, `focus-visible:ring` on avatar button; `focus-visible:ring` on sign-in button
- `app/page.tsx` — added `id="main-content"` to `<main>`
- `app/officials/page.tsx` — outer `<div>` → `<main id="main-content">`
- `app/proposals/page.tsx` — outer `<div>` → `<main id="main-content">`; `htmlFor`/`id` pairs on all filter labels/selects; `aria-current` on active topic pills; `aria-hidden` on pulse dot + empty state SVG; `aria-labelledby` on featured section; pagination `<div>` → `<nav aria-label="Pagination">`; `aria-current="page"` on active page link; `aria-label` on prev/next/numbered links
- `app/initiatives/page.tsx` — added `id="main-content"` to existing `<main>`
- `app/officials/components/OfficialsList.tsx` — `aria-label` on search input; `aria-label` on chamber/party/state selects; `role="group" aria-label` on pill groups; `type="button" aria-pressed` on issue/pattern pills; `aria-pressed + aria-label + focus-visible:ring` on official row buttons; `aria-hidden` on empty state SVG
- `packages/ui/src/components/layout/PageHeader.tsx` — `aria-label="Breadcrumb"` on nav; `<ol>/<li>` structure; `aria-hidden` on separators; `aria-current="page"` on last breadcrumb; `focus-visible:ring` on action buttons/links; `type="button"` on action button
- `packages/graph/src/components/GraphConfigPanel.tsx` — `aria-label` on all sliders, selects; `role="switch" aria-checked aria-label focus-visible:ring` on toggles; `aria-label + focus-visible:ring` on collapse and strip buttons; `aria-hidden` on decorative icon spans/SVGs

**Key architectural rule established:**
> Use `focus-visible:ring` (not `focus:ring`) throughout — only shows ring for keyboard navigation, not mouse clicks. Use `role="switch"` (not just `role="button"`) for toggle controls.

**Up next:**
- Queue next Qwen batch from FIXES.md: officials filtering improvements, proposal filtering, share buttons, community commenting UI
- SEO/OG metadata (🟠 M) — next high-priority item in FIXES.md

---

Newest entry first. Each entry covers: what was done, what's now unblocked, and
what should happen next. Read this at the start of any session to get context
without trawling git history or old chat windows.

---

## 2026-04-13 (auth session)

**Done:** Full auth sign-in flow fixed end-to-end (magic link + 6-digit OTP both working).

**Root cause chain that took multiple attempts to unravel:**

1. **`/?error=access_denied&error_code=otp_expired` landing on home page** — Supabase redirects auth errors to the site URL root, which had no handler. Fixed by checking `searchParams.error` in `app/page.tsx` and redirecting to `/auth/sign-in?error=auth`.

2. **`PKCE code verifier not found in storage`** — `signInWithOtp` called from the browser client stores the code verifier via `document.cookie`, but Next.js never reliably delivers it to the `/auth/callback` Route Handler because cookies set by `document.cookie` can be dropped/lost in certain browser/hydration states. Fixed by moving `signInWithOtp` into a Server Action (`app/auth/actions.ts`).

3. **`redirect_to=http://127.0.0.1:3000` in email link** — No `supabase/config.toml` existed, so local Supabase defaulted to `http://127.0.0.1:3000` as site URL. Cookies set by the Server Action were for `localhost`, but the callback landed on `127.0.0.1` — different host, cookies not sent. Fixed by creating `supabase/config.toml` with `site_url = "http://localhost:3000"`.

4. **`@supabase/ssr`'s `createServerClient` hardcodes `flowType: 'pkce'`** — Even in a Server Action, using `createServerClient` embeds a PKCE challenge in the email. The Server Action's `setAll: () => {}` was discarding the verifier. Fixed by switching to a plain `createClient` in the Server Action (auth-js defaults to `flowType: 'implicit'`).

5. **Implicit flow tokens land in URL hash `#access_token=xxx`** — Servers never see hash fragments. Browser-side `setSession()` (via `createBrowserClient`) stores in localStorage, NOT cookies — so SSR middleware still sees no session. **Final fix (by Qwen):** two-step redirect:
   - `AuthHashHandler` (client, in root layout): detects `#access_token=`, extracts tokens, redirects to `/auth/callback-hash?access_token=xxx&refresh_token=xxx`
   - `/auth/callback-hash` (server Route Handler): receives tokens as query params → creates `createServerClient` with cookie adapter → calls `setSession()` → server buffers auth cookies → applies to redirect response → redirects to `/`

**Key architectural rule established:**
> **Never call `setSession()` on the browser Supabase client expecting the server to see the result.** The `@supabase/ssr` browser client writes to `document.cookie` / localStorage. Only a `createServerClient` with a cookie adapter (in a Route Handler, Server Action, or middleware) can write session cookies that the SSR layer will see.

**Files changed this session:**
- `app/page.tsx` — redirect on `?error` param
- `app/auth/actions.ts` — NEW: Server Action using plain `createClient` (implicit flow)
- `app/auth/callback/route.ts` — better error handling, profile upsert on sign-in
- `app/auth/callback-hash/route.ts` — NEW: handles implicit-flow hash redirect
- `app/auth/confirm/route.ts` — added `magiclink` to allowed OTP types
- `app/components/AuthHashHandler.tsx` — NEW: client component in root layout
- `app/components/SignInForm.tsx` — 6-digit OTP code input added; calls Server Action
- `app/layout.tsx` — mounts `<AuthHashHandler />`
- `middleware.ts` — early-return for all `/auth/*` routes (no `getUser()` interference)
- `supabase/config.toml` — NEW: `site_url = "http://localhost:3000"`, localhost in redirect URLs

---

## 2026-04-13

**Done:**
- TASK-17 reviewed — clean. Initiatives nav link added to homepage header.
- TASK-18 reviewed — clean. Federal/State badge on official cards using `source_ids->>'congress_gov'`.
- TASK-19 reviewed — clean. `generateMetadata` with OG tags on Officials, Proposals, Initiatives detail pages.
- TASK-20 reviewed — clean. Consistent empty states on Officials, Proposals, Agencies list pages.
- TASK-21 — Qwen created files correctly but didn't commit (went in circles on preexisting type errors). Claude recovered and committed 4 clean `loading.tsx` files.
- TASK-12 marked COMPLETE — routes already implemented in earlier sprint work (`api/initiatives/` has `route.ts`, `[id]/route.ts`, `[id]/sign/`, `[id]/signature-count/`).
- Qwen's circular working-tree changes (truncated files in ~20 files) discarded via `git checkout HEAD`.
- QWEN_PROMPTS.md and SESSION_LOG.md re-synced after git restore.

**Unblocked:**
- All TASK-17 through TASK-21 complete. Branch is clean.

**Up next:**
- FIXES.md priorities: mobile responsiveness (🟠 M) and a11y audit (🟠 M) — better handled by Claude than Qwen
- Queue next Qwen batch: pull from FIXES.md (officials filtering improvements, proposal filtering, share buttons) or Phase 1 remaining (community commenting UI)

---

## 2026-04-12

**Done:**
- Sprint 9 migrations (20260411020000–20260411100000) applied locally — `jurisdiction_id` now on `civic_initiatives`, plus 5 other schema additions
- `apps/civitics/app/api/initiatives/[id]/advance/route.ts` patched: PGRST116 (no rows) now returns 404; other query errors return 500 with code. Previously all errors silently became 404.
- TASK-13 reviewed — clean. `text-gray-900` added to `LabeledSelect` in `GraphConfigPanel.tsx`
- TASK-14 reviewed — Qwen truncated `InlineEditor.tsx` at line 203 mid-className. Repaired by Claude.
- TASK-15 reviewed — clean. All 8 `.label` → `.name` in `ForceGraph.tsx` correct.
- TASK-16 reviewed — Qwen truncated `useGraphData.ts` at line 261 mid-declaration (`const isPac`). Repaired by Claude.
- DB types regenerated (`packages/db/src/types/database.ts`) after migrations. Note: on Windows PowerShell use `[System.IO.File]::WriteAllLines()` — `>` redirect produces UTF-16.
- FIXES.md and QWEN_PROMPTS.md statuses brought up to date.

**Unblocked:**
- TASK-12 (Civic Initiatives: core API routes) — was BLOCKED on sprint 1 migrations; those are now applied locally. Can queue now.
- "Open for deliberation" button should now work — test on a draft initiative to confirm.

**Up next:**
- Queue next Qwen batch from remaining FIXES.md items and PHASE_GOALS.md gaps
- Remaining BUGS in FIXES.md: all resolved this session — no open bugs
- Next FIXES.md priorities: mobile responsiveness (🟠 M), a11y audit (🟠 M), SEO/OG metadata (🟠 M), skeleton states (🟡 M)
- TASK-12 is unblocked and ready to queue
