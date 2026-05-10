# FIXES — Civitics Platform

Actionable improvement backlog. Every item has a priority, complexity, and enough context to hand to Qwen or Claude Code directly.

**Priority key:**
- 🔴 Critical — Bug that breaks or blocks real functionality
- 🟠 High — Meaningful product/UX gap, address soon
- 🟡 Medium — Worthwhile improvement, schedule when practical
- 🟢 Quick Win — Small effort, high visible impact (batch these)
- ⬜ Future — Phase 2+ or requires significant design/pipeline work

**Complexity key:** S = <2h · M = 2–8h · L = 1–3 days · XL = multi-day + planning

**Workflow:** Every bullet has a stable ID (`<!--id:FIX-NNN-->`). Don't remove or renumber IDs — they're the handle commits reference via `Fixes: FIX-NNN` trailers. Completion state is sourced from `docs/done.log`; regenerate this file's checkboxes with `pnpm fixes:sync`. See [CLAUDE.md](../CLAUDE.md#fixes-workflow) for details.

**Section rules:**
- Active sections — `[x]` items are fine (checked by `fixes:sync`). Periodically move completed clusters to `## COMPLETED` for readability.
- `## COMPLETED` — **`[x]` only**. A `[ ]` item here means it was moved before it shipped — move it back to the active section.
- Deferred / blocked items always stay in active sections as `[ ]`, never in COMPLETED. If a deferred item was closed by a broad "closeout" commit, add a `reopen` line to `done.log` and uncheck it.

---

## STRATEGIC PILLARS
> Directional goals, not checkable tasks. Concrete sub-tasks are threaded throughout this doc. Phase 2+ strategy, architecture, and the Social App live in `docs/ROADMAP.md`.

---

## BUGS — Fix These First

- [x] 🔴 L — **Graph presets ignore focused entity — Ted Cruz treemap shows disjoint PAC sets across "By State" and "PAC Money by Sector"** — `/api/graph/treemap-pac` accepts no `entityId` and returns ALL PACs globally, while `/api/graph/treemap` is entity-aware. Same toolbar, two scopes. Root cause: presets carry no entity-type metadata; `GraphConfigPanel.tsx:827-841` filter only checks `vizType`. Fix: (a) extend `GraphViewPreset.meta` with `applicableEntityTypes`, `dataModeByEntity`, `intent`; (b) add `resolvePresetForFocus` helper that runs in `applyPreset` and re-runs on focus change unless `meta.isDirty`; (c) add `entityId` param to `/api/graph/treemap-pac` (pre-filter PAC set to donors of that official); (d) fix three drifted presets per `packages/graph/CLAUDE.md` Built-in Presets table — `COMMITTEE_POWER` add `appointment`, `INDUSTRY_CAPTURE` add `oversight,revolving_door`, `CO_SPONSOR_NETWORK` add `vote_yes`; (e) `GraphConfigPanel` renders presets in two buckets — "Native" + "Adapted for {focusName}". <!--id:FIX-216-->
- [x] 🔴 M — **Treemap aggregate mode shows $0 for everyone except one official (PostgREST 1000-row truncation)** — Senate Democrats > Treemap > Group by State showed Maria Cantwell at $1.9M and 44 other senators at $0. Per-batch financial_relationships scan returned at most 1000 rows; Cantwell's rows happened to be in the first 1000 and the rest dropped. Fix: read `officials.total_received_cents` (denormalized May 8 column) directly in default aggregate mode; use `range()` pagination on industry_filter path and on the connection-count / vote-count aggregations. <!--id:FIX-219-->
- [x] 🟠 M — **Donation floor as a user option (right panel slider)** — Prior to this fix `treemap-pac` party mode hardcoded `> $10k` and `treemap` ignored `donation.minAmount` entirely. Force respected the buried Min $ field in Connections row but no other viz did. Added `DonationFloorControl` log-scale slider ($0 / $200 / $1k / $10k / $100k / $1M stops) to TreemapSettings + ForceSettings; binds to `view.connections.donation.minAmount`. Wired both `/api/graph/treemap` (entity + aggregate mode) and `/api/graph/treemap-pac` (sector + party mode) to honor `minAmountUsd` query param. Replaces the hardcoded $10k cutoff. <!--id:FIX-220-->
- [x] 🟢 S — **Materialize the three global-aggregate chord RPCs** — `chord_donor_type_party_flows()`, `chord_donor_state_party_flows()`, `chord_subject_party_flows()` (all introduced in FIX-221) full-scanned `financial_relationships` (~2.2M rows on prod) and consistently exceeded the 5s `withDbTimeout` ceiling, returning empty groups for the global mode of each chord. Same pattern as FIX-207 (`chord_industry_flows_mv`): pre-aggregate nightly into `chord_donor_type_party_flows_mv`, `chord_donor_state_party_flows_mv`, `chord_subject_party_flows_mv`; replace each function body with `SELECT FROM mv WHERE param IS NULL UNION ALL <cohort path>` so the MV serves the global case and the live aggregation handles per-cohort calls. Three new `refresh_*` helpers wired into `runNightlySync()` step 7 alongside the existing chord MV refresh. <!--id:FIX-222-->
- [x] 🟢 L — **Chord multi-mode + granularity + compare + Full Senate edge bug** — Chord was locked to one hardcoded "industry → party" view inferred from props. Now exposes 8 user-selectable data modes via Settings → Data picker: industry-party (global default), industry-official, sector-group, sector-group-pair, sector-vote (donor sectors ↔ yea/nay/abstain), subject-party (bill topics × party chamber by yes-vote count), donor-type-party (Individual/PAC/Super-PAC/Corp/Union × party), state-party (donor home state × party). Added "Group by" dropdown for donor-side modes — aggregate (sectors), top-pacs (top-N PAC arcs colored by industry), by-bracket (Mega/Major/Mid/Small size brackets). Multi-official compare mode: when 2+ officials are focused, each becomes a recipient arc with shared donors visible as ribbons fanning to multiple recipients. Top N (1–50) and Min Flow ($0 → $10M, 12 log-stops) replaced with sliders that filter client-side after a single fetch — dragging never refetches (eliminated 429s on slider drag). Per-mode color palettes: vote outcomes green/red/grey, donor types distinct hues, brackets match force-graph BRACKET_TIERS. Seven new SQL RPCs in `20260509000003_chord_new_modes.sql`: `chord_sector_vote_for_officials`, `chord_subject_party_flows`, `chord_donor_type_party_flows`, `chord_donor_state_party_flows`, `chord_industry_flows_for_official`, `chord_top_pacs_for_official`, `chord_donor_brackets_for_official`. Four new presets: Sector vs Vote Outcome, Topics by Party, Donor Type by Party, Out-of-State Money. **Bug fixes folded in:** (1) entity-mode chord branch was reading the dropped `financial_entities.industry_category` column and the renamed `official_id`, returning empty for any "Industries → Official" view — replaced with `chord_industry_flows_for_official` RPC. (2) `/api/graph/group` `financial_entities` lookup was unbatched while sibling queries batched at 100 — Full Senate hit ~900 distinct donors, blew past PostgREST URI cap, returned silently empty so force graph showed only the group node and chord greyed out. Batched at 100 to match. (3) Chord registry `isApplicable` rule was too strict (required loaded edges); chord can render globally without any data, so simplified to `() => APPLICABLE` and let the per-mode picker handle gating. <!--id:FIX-221-->


---

## GENERAL / CROSS-CUTTING


---

## HOMEPAGE

- [x] 🟢 M — **State legislative district overlay on homepage map** — DistrictMap exposes SLD-U and SLD-L layer toggles backed by Census TIGER boundaries (`pnpm data:districts`). Click any district polygon to navigate to `/districts/[id]`. Layers debounced-refetch on map move via `/api/districts?bbox=…&chamber=…`. <!--id:FIX-163-->
- [x] 🔴 L — **Homepage perf + "Donor records — Coming soon" fix** — hero stats and per-official stats are computed at request time (4× `count: "exact"` Wave 1 + ~60 sub-queries Wave 3, including a JS-side donation sum). Donor count intermittently times out and falls back to `0` → renders "Coming soon". Precompute via `homepage_stats_mv` (single row) and `official_homepage_stats_mv` (keyed by official_id), refresh nightly in `runNightlySync()` step 7, replace inline queries with single-row reads wrapped in `withDbTimeout`. Add `console.time` + hidden `<script id="__perf">` payload for per-phase timing visibility. <!--id:FIX-223-->

---

## OFFICIALS


---

## PROPOSALS

- [ ] ⬜ S — **Add "Trending", "Most Commented", "New" tabs** — add to FeaturedSection; requires trending-score pipeline and comments data <!--id:FIX-029-->

---

## PROPOSALS [ID]


---

## CIVIC INITIATIVES


---

## AGENCIES

- [x] 🟠 L — **Agency enrichment pipeline — social media, FTE headcount, Wikidata metadata** — Three-pass pipeline (`pnpm data:agency-enrichment`): (1) USASpending `/api/v2/agency/{toptier_code}/employees/` → `personnel_fte` for agencies with a toptier code. (2) USA.gov Social Media Registry `registry.usa.gov/accounts.json` → `metadata.twitter_handle / youtube_handle / facebook_url / instagram_handle`. (3) Federal Register `/api/v1/agencies.json` → fill empty `description` / `website_url`; Wikidata SPARQL → `founded_year`, `wikidata_id`. New migration adds `founded_year INT`, `personnel_fte INT`, `wikidata_id TEXT` columns to `agencies`. <!--id:FIX-208-->
- [x] 🟠 L — **Agency leadership pipeline — Wikidata SPARQL → officials + entity_connections** — Depends on FIX-208 (needs `wikidata_id`). SPARQL P488 (head of government) queries per agency, filtered to last 15 years. For each leader: upsert `officials` (dedup via `source_ids->>'wikidata_id'`), upsert `entity_connections` with `connection_type='appointment'`, `metadata.{start_date, end_date, position_title, is_current}`. Agencies with 0 Wikidata leaders enqueued in `enrichment_queue` with `entity_type='agency'`, priority=40. <!--id:FIX-209-->
- [x] 🟠 M — **Extend enrichment_queue for agency entity type + AI gap-fill prompts** — Migration adds `'agency'` to the entity_type allowed values. New drain prompts: `agency-summary.md` (2–3 sentence civic description) and `agency-leadership.md` (extract current head name/title from context). New `buildAgencyContext()` in enrichment seed. Run 5–10 item test batch and tune prompts before full drain. <!--id:FIX-210-->
- [x] 🟠 M — **Wire enriched agency data into agencies[id] page** — Depends on FIX-208 + FIX-209. Header: social media icon links (Twitter/X, YouTube, Facebook) + "Est. {founded_year}" pill. Quick stats: add Personnel FTE stat. Leadership section: split into Current / Past, show position title + tenure dates ("Jan 2021 – Jan 2025"), mark current leaders distinctly. Query must also fetch `entity_connections.metadata`. <!--id:FIX-211-->
- [x] 🟡 M — **SEC CIK matching in usaspending writer (revolving door groundwork)** — After upserting a `financial_entity` for a new contractor, attempt EDGAR EFTS CIK lookup: `efts.sec.gov/LATEST/search-index?q="{name}"&forms=10-K`. Store confident matches in `source_ids->>'sec_cik'`. 120ms inter-request delay. Misses cached per-run in a local Set to avoid duplicate queries. <!--id:FIX-212-->
- [ ] ⬜ XL — **Corporate officer pipeline — SEC EDGAR → officials + revolving_door edges** — Phase 2. Depends on FIX-212 for SEC CIK. For each `financial_entity` with `source_ids->>'sec_cik'`, fetch `data.sec.gov/submissions/{CIK}.json` → extract `officers[]`. Cross-reference against `officials` table (name fuzzy-match). For matches: upsert `entity_connections` with `connection_type='revolving_door'`, metadata `{direction: 'industry_to_govt'|'govt_to_industry', position_title, start_date, end_date}`. <!--id:FIX-213-->
- [x] 🟡 M — **OPM FedScope bulk pipeline → agencies.personnel_fte** — USASpending `/api/v2/agency/{toptier_code}/employees/` was removed. OPM publishes quarterly employment cubes at `fedscope.opm.gov` as ZIP/CSV. Download the "Employment" cube (CPDF extract), aggregate `Employment` column by `Agency` code, join against `agencies.usaspending_agency_id` (toptier code), write `personnel_fte`. OPM agency codes differ from USASpending toptier codes — maintain a mapping table or match by normalized agency name. Cadence: quarterly (OPM updates March/June/September/December). Add `data:opm-fte` script to `packages/data/`. <!--id:FIX-214-->
- [x] 🟠 L — **PLUM Book pipeline → full political appointment coverage** — OPM PLUM Act data via OpenSanctions `us_plum_book` daily mirror (~10MB FTM NDJSON). Covers ~9,000 positions: Senate-confirmed (PAS), presidential (PA), Schedule C (SC), noncareer SES (NA), and career SES. Fixes gaps in Wikidata (sparse) and Congress.gov nominations (PAS-only): e.g. FCC Chair (designated by executive action). Agency matched by stripping the last comma-segment of position name. Weekly cron with ETag version check to skip if unchanged. Script: `pnpm data:plum-book`. <!--id:FIX-215-->
- [x] 🟡 S — **Schedule `data:agency-leadership` weekly** — Currently manual-only despite FIX-209 wiring leadership data into `entity_connections`. Leadership shifts with appointments/confirmations; manual cadence means the site can stay stale through real political-news events. Sources (Wikidata SPARQL + Congress.gov nominations) are cheap. Add to the Sunday-only weekly block in `runNightlySync()` (`packages/data/src/pipelines/index.ts`). Daily-during-transition-window invocation can be a separate scripted call. See [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) §3a. <!--id:FIX-227-->
- [x] 🟢 S — **Schedule `data:agency-enrichment` monthly** — Social media handles + agency descriptions (FIX-208) drift slowly but predictably; currently manual-only. Monthly is sufficient (quarterly would also be fine). Either guard the call inside the weekly block with a "first Sunday of month" check, or add a dedicated GitHub Actions workflow with `0 3 1-7 * 0` (first Sunday). Sources are USA.gov + Federal Register + Wikidata — all cheap. See [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) §3a. <!--id:FIX-228-->

---

## GRAPH

- [x] 🟠 L — **Eight new graph presets exploiting May 2026 data pipelines** — Tier 1 (~4): "Fundraising by Donor Type" (treemap groupBy=donor_type), "Top Individual Donors by State" (treemap of `financial_entities` where `entity_type='individual'`), "Federal Spending Flows" (sankey `agency → sector → vendor` from USASpending bulk), "Agencies by Staffing" (scatter — see FIX-217). Tier 2 (~4): "Leadership Tenure" (gantt — see FIX-217), "Voting Divergence Map" (choropleth — see FIX-217), "Small-Dollar Dependency" (alignment-style horizontal bar of % donations under $500), "Sector Affinity" (alignment-style top industries via `chord_industry_flows_mv`). All declare `applicableEntityTypes` per FIX-216 framework. New endpoints: `/api/graph/treemap-individuals`, `/api/graph/small-dollar`, `/api/graph/sector-affinity`. Adds `groupBy='donor_type'` and `dataMode='individuals_by_state'` branches to `TreemapGraph.tsx`. Migrations: partial index on `financial_entities (metadata->>'state') WHERE entity_type='individual'`. Updates `packages/graph/CLAUDE.md` Built-in Presets table. <!--id:FIX-218-->


### New connection types


### New visualization types

- [x] 🟠 L — **Add Scatter, Choropleth, and Gantt visualizations** — Three new viz components added to `packages/graph/src/`: (1) `ScatterGraph.tsx` for "Agencies by Staffing" (FTE × appointment count, bubble size = contracts, color by agency type) — uses `agencies.personnel_fte` (FIX-214), `entity_connections` count (FIX-209/215), `total_contract_cents` (FIX-194); (2) `ChoroplethGraph.tsx` for "Voting Divergence Map" (district choropleth from `jurisdictions.boundary_geometry` + per-district party-cohesion-rate computed on-the-fly; `proposals.party_line` doesn't exist so use within-district cohesion as the metric); (3) `GanttGraph.tsx` for "Leadership Tenure" (per-position bars from `entity_connections WHERE connection_type='appointment' AND to_id=$agencyId` with `metadata.start_date/end_date`). New endpoints: `/api/graph/agency-staffing`, `/api/graph/voting-divergence`, `/api/graph/leadership-tenure`. Registry entries with `isApplicable` rules. Adds `'scatter'|'choropleth'|'gantt'` to `VizType` union. <!--id:FIX-217-->


### Documentation


### Prerequisites


### Pipelines

- [ ] 🟢 S — **Add R2 cache layer for FEC bulk files** — Follow-up to FIX-181. The indiv pipeline currently downloads `indiv{yy}.zip` (~2 GB) from `fec.gov/files/bulk-downloads` on every run. R2 plumbing exists in [packages/db/src/storage.ts](packages/db/src/storage.ts) but is unused by the FEC pipeline. Add a HEAD-based freshness check: on each run, HEAD `civitics-cache/fec/indiv{yy}.zip` in R2 + HEAD the FEC URL; if R2 is fresh (Last-Modified ≥ FEC's), download from R2 instead. After successful FEC download, upload to R2 in the background. Saves ~10 minutes per repeat run + insulates against FEC bulk-download outages. Requires `@aws-sdk/lib-storage` for multipart upload. Same pattern can be retrofitted to pas2/cm/weball. Defer until cadence justifies it (pipeline runs more than once a quarter). <!--id:FIX-192-->
- [ ] 🟡 M — **Verify weekly FEC cron handles indiv stage cleanly + add a `closed-cycles skip` knob** — FIX-181 lands `FEC_INCLUDE_INDIV=true` as the pipeline default, so the weekly nightly orchestrator at [packages/data/src/pipelines/index.ts:464-468](packages/data/src/pipelines/index.ts#L464-L468) (which runs `FEC_CYCLES={prev},{current}`, currently 2024,2026) now downloads two indiv zips totalling ~5.5 GB and streams ~80M rows per Sunday run. Local + Pro test runs land cleanly in 60-90 min, well under GitHub Actions' 6h job cap, but it's wasteful: 2024 is closed (last FEC quarterly drop was Jan 31 2026) so re-fetching it weekly burns bandwidth + Pro write IO for ~zero new data. Plan: (1) confirm one full Sunday run of `data:nightly:ci` completes green with the indiv stage on (no GitHub Actions timeout, no OOM, no Pro pooler exhaustion); (2) add `FEC_INDIV_CYCLES` env knob — defaults to active-cycle-only ({current}) for the cron, while the manual `pnpm data:fec-bulk` keeps the broader `FEC_CYCLES` default for backfills; (3) optional: skip indiv when FEC's Last-Modified header matches a recorded watermark in `pipeline_state` (avoids reprocessing identical files). <!--id:FIX-193-->
- [x] 🔴 L — **USASpending contracts + grants pipeline** — `financial_relationships` has the schema (`relationship_type = 'contract'|'grant'`, `usaspending_award_id`) but no pipeline writes to it. Corporations and agencies on the search page show $0 because only FEC donation data is ingested. Ingest federal awards from USASpending.gov bulk download API (`/api/bulk_download/v2/awards/`) into `financial_relationships` as `contract`/`grant` rows (from_type=`agency`, to_type=`financial_entity`). Add `total_contract_cents` and `total_grant_cents` aggregated columns to `financial_entities` (migration + backfill). Update search API to read and display the dominant amount type per entity (contracts for corporations, donations for PACs). Label amounts in the search result card accordingly. <!--id:FIX-194-->
- [x] 🟡 S — **Deprecate legacy `data:usaspending` (API path) — superseded by bulk** — Per `packages/data/CLAUDE.md`, the API-based [pipelines/usaspending/index.ts](../packages/data/src/pipelines/usaspending/index.ts) is "retained for reference, superseded by FIX-118 bulk approach", but the script entry still ships a fully-functional pipeline. NOT called from `runNightlySync()` (orchestrator imports only `runUsaSpendingBulkPipeline`). Manual invocation can write duplicate `financial_relationships` rows under different `usaspending_award_id` formats (API response vs bulk archive). **Prod `data_sync_log` shows 4 invocations in last 180 days, latest 2026-04-25 (3 days post-cutover — likely operator validation, not recurring usage).** Two-step removal: (1) drop the `data:usaspending` line from `packages/data/package.json` so it can't be invoked via `pnpm data:*`; (2) after 60 days with no `pipeline='usaspending'` row in `data_sync_log`, delete `pipelines/usaspending/index.ts` and `pipelines/usaspending/writer.ts`. `canonicalizeEntityName` lives in `fec-bulk/writer.ts` (still imported by `usaspending-bulk`), so removing the legacy dir is safe. Migration steps in [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) §5a. <!--id:FIX-224-->


---

## DASHBOARD

- [ ] 🟠 L — **Add sparklines to stat cards** — build `/api/stats/trends` returning last 30 days of daily counts per metric <!--id:FIX-090-->
- [ ] 🟡 M — **DEFERRED --- Parse FIXES.md into per-phase task lists with real done state** — reads `docs/done.log`; replaces hard-coded PHASE1_TASKS <!--id:FIX-095-->

---

## INFRASTRUCTURE & PERFORMANCE

- [x] 🟠 S — **Phase 2 pipeline skeletons return `status='skipped'` not `status='complete'`** — `govtrack-cosponsors`, `federal-register`, `opensecrets-bulk` are intentional Phase 2 placeholders (TODO bodies, return 0 rows), but all call `completeSync(logId, result)` with `inserted: 0` → dashboard reads `status='complete'` and "0 rows", indistinguishable from a real pipeline that legitimately had no new rows that day. False-positive signal that hides forever in logs. Replace with `status='skipped', reason='not_implemented'` so the dashboard can render no-op stubs differently (or filter them out). Touches three files — one-line change each. NOT a removal; these are kept as Phase 2 placeholders. See [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) §4c. <!--id:FIX-229-->
- [x] 🟠 M — **Schedule `data:audit` weekly + publish report to `docs/audits/`** — Integrity audit is the safety net for catching invariant violations after schema/pipeline changes, but only runs when invoked manually → no audit-on-divergence signal exists. New GitHub Actions workflow `.github/workflows/audit.yml` runs `pnpm data:audit` on a weekly schedule (e.g. `0 4 * * 1` Mondays 4 UTC, after the Sunday nightly block), writes the report to `docs/audits/{YYYY-MM-DD}.md`, and commits directly to `main`. Diffs surface naturally via `git log docs/audits/`. Confirm `pipelines/integrity-audit/reporter.ts` writes a stable filename pattern so the workflow can locate it (or update the reporter to do so). See [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) §3a. <!--id:FIX-226-->
- [x] 🟢 S — **Reconcile `packages/data/CLAUDE.md` cadence section against the orchestrator** — Drift items per [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) §3c: "Hourly Regulations" → actual daily-via-nightly; "Daily CourtListener" → actual Sunday-only; "Daily spending data" → actual Sunday-only; "Weekly AI summary regeneration" → actual daily incremental. Also remove the `data:fec` "retained for reference only" line — `packages/data/src/pipelines/fec/` directory has been deleted entirely. Pure doc PR; no code or schema impact. <!--id:FIX-225-->
- [x] 🟡 S — **Add `--confirm` gate to `data:ai-summaries` (non-incremental path)** — `pnpm data:ai-summaries` (no flags) runs against ALL entities with no cost cap. Orchestrator invokes it with `incremental=true` so production is safe, but a manual operator can overspend silently. `data:tag-ai` and `data:tag-industry` already gate on `--confirm`; matching that pattern keeps AI-cost discipline consistent. Touches the args-parse block in `pipelines/ai-summaries/index.ts`. <!--id:FIX-230-->
- [x] 🟡 S — **Schedule `data:tag-industry` in nightly Sunday block** — Currently only chained from manual `data:tag-all`. Pipeline only runs against unclassified PACs, so re-running it weekly catches PACs that arrived in the prior Sunday FEC bulk. Without this, newly-arrived PACs sit untagged until someone runs `data:tag-all` by hand. Add as a step after the Sunday FEC-bulk in `runNightlySync()`. The existing `--confirm` gate may need an `ORCHESTRATOR=true` bypass (or split the dry-run vs apply paths). See [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) §3a. <!--id:FIX-232-->
- [x] 🟢 S — **Archive `src/scripts/copy-pac-tags-to-prod.ts`** — One-shot post-FIX-179 cross-env migration (copies AI-generated PAC industry tags from local to prod via `fec_committee_id`). No `data:*` script entry, no orchestrator hook, last touch was an unrelated workspace-import refactor. Job is almost certainly complete. Spot-check: query prod for PACs with `tag_category='industry'` rows present locally but missing in prod; if zero, `git mv` to `docs/archive/scripts/` (or just `git rm`). <!--id:FIX-231-->
- [x] 🟡 M — **Pipeline runtime + memory observability from `data_sync_log`** — `data_sync_log` captures `started_at`/`completed_at`/`status` per pipeline run but nothing surfaces the trends. As pipelines scale (FEC indiv ~80M rows/week, USASpending bulk multi-GB), watching p95 duration per pipeline is the only way to catch any creeping toward the 60-min GHA job cap or Pro pooler exhaustion before they fail outright. Add (a) a `pipeline_runtime_stats_mv` materialized view with `pipeline`, `p50/p95/max duration_ms`, `success_rate`, `last_30d_runs` — refreshed nightly; (b) a `/admin/pipeline-health` page rendering the table with red/amber/green tiering against the 60-min ceiling; (c) optionally fold the same data into the weekly audit report (FIX-226). Memory metrics require a small instrumentation pass per pipeline: write `peak_rss_mb` into `data_sync_log.metadata` via `process.memoryUsage().rss` at completion. See [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) Open Question #4. <!--id:FIX-233-->
- [x] 🟠 M — **Alert when Vercel cron canary fires but GHA nightly never lands** — Two cron paths write to `data_sync_log` daily: Vercel `/api/cron/nightly-sync` writes a `triggered` row at 2:00 UTC (canary, no pipeline work), and GitHub Actions writes a `nightly_cron` row when `runNightlySync()` completes. If GHA dies (auth expired, runner outage, OOM), only the canary row exists — silent failure. Add a check that (a) runs once daily at ~5 UTC (3h after the canary), (b) selects canary rows from the last 7 days with no matching `nightly_cron` row landing within 4h, (c) on mismatch, surfaces an admin-dashboard banner and/or emails `ADMIN_EMAIL` via Resend. Implementation: Vercel cron `0 5 * * *` hitting `/api/cron/sync-canary-check` (simpler than a Postgres trigger, rate-limit-safer than a GHA job). See [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) Open Question #6. <!--id:FIX-234-->
- [x] 🟢 S — **Fix tsc error: `cache` property on RequestInit in `packages/db/src/supabase-usage.ts`** — Line 119 passes `cache: "no-store"` to `fetch()` (correct behavior — opts out of Next.js fetch caching for the live Supabase Management API call), but `packages/db/tsconfig.json` correctly excludes the DOM lib (server-only package), so the Node-native `RequestInit` type in scope doesn't declare `cache`. tsc errors with TS2353. Pre-existing — surfaced during FIX-234 typecheck run. Inline cast at the call site to `RequestInit & { cache?: RequestCache }` — localized, no global type pollution. Do NOT add `"dom"` lib to the package's tsconfig; this is a server-only package and DOM globals would pollute downstream consumers. <!--id:FIX-235-->


---

## COMMUNITY & AUTH


---

## DOCUMENTATION (Open Source Readiness)


---

## COMPLETED (archive, don't delete — useful reference)

_Completed items moved here by `pnpm fixes:clean`. `pnpm fixes:archive` moves them to `docs/archive/fixes-archive.md`._
