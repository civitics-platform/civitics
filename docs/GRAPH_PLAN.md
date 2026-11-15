# Graph Refinement Plan

> Authoritative reference for ongoing graph work. Created 2026-04-25.
> FIX-120 through FIX-150 reference sections of this document for full context — keep
> FIXES.md bullets one-liners that point here, instead of repeating the rationale.
>
> Update this doc when scope shifts. Mark sections COMPLETE inline when their FIX lands.

---

## Vision

The connection graph is the core product of Civitics. Today it has the right bones —
three-layer GraphView, registry-driven viz, TreeNode primitive, real-time wiring —
but the panels were built before the entity universe got rich. Browse is flat. The
Connections tree treats all 9 types uniformly regardless of focus. Viz options
ignore what's selected. Custom groups are unwireable. The USER node ships invisibly.

The plan: keep the architecture, refine the surface. Make the panels *react* to
what's selected. Make Browse a real hierarchy. Add the three connection types and
four viz types the data already supports. Update CLAUDE.md to match.

## Order of work

**Direction 1 → Direction 3 → Direction 2 → New types → New viz → Compare upgrade.**

Direction 1 cleans the slate (and finishes FIX-042 surfacing). Direction 3 is the
biggest UX win per LOC. Direction 2 is structurally ambitious and benefits from the
cleanup of 1 + 3 first. New types and viz are additive after the panels are solid.

## Cross-cutting principles

- **Never auto-switch viz type on the user.** Suggest via toast at most. The viz
  *dropdown* should self-filter to applicable types, but selection stays manual.
- **Disable, don't hide.** Non-applicable controls render with a tooltip explaining
  why. Hiding teaches no one.
- **Force graph is universal.** Every entity/connection combination renders in
  Force. Other viz types may be data-restricted (Treemap/Chord = donations only).
- **Reactive ≠ destructive.** When focus changes, never silently disable user
  choices in the connection state. Hide irrelevant rows; preserve the toggle state
  underneath.
- **AI gate.** Every Anthropic API call site on the platform must check
  `FLAGS.AI_SUMMARIES_ENABLED` before invoking. The flag is the kill switch.

---

## Direction 1 — Tighten what's there

### 1.1 USER node visible & toggleable — FIX-120

`NodeType` includes `'user'` and `useGraphData` already merges alignment edges from
`/api/graph/my-representatives`. Missing: panel affordance, default connection
state for `alignment`, and a toggle to show/hide the USER node independent of
follows.

Acceptance criteria:
- `alignment` added to `DEFAULT_CONNECTION_STATE` in `connections.ts` (purple,
  opacity 0.7, thickness 0.5, default enabled).
- A "👤 You" entry near the top of FocusTree's Active section when authenticated.
  Toggle button to show/hide; visible regardless of whether other entities exist.
- USER node renders with a distinct visual (larger, ring color = green when
  alignment ratio > 0.6, red < 0.4, gray otherwise). Per spec the alignment
  *scoring* itself stays Stage 2; this is visibility only.
- ConnectionsTree shows `alignment` row when USER node is on the canvas.
- Add `alignment` to `CONNECTION_TYPE_REGISTRY` filter logic so it appears in
  type counts.

Out of scope: AlignmentPanel ↔ alignment edge weighting, scoring pipeline. That's
Stage 2.

### 1.2 `addGroup`/`removeGroup` markDirty — FIX-121

`useGraphView.addGroup` and `removeGroup` don't call `markDirty()`. Adding/removing
a group from a loaded preset never surfaces the "Save changes" button.

Acceptance: both ops call `markDirty()` to mirror `addEntity`/`removeEntity`.

### 1.3 AI Explain gated by AI_SUMMARIES_ENABLED — FIX-122

`/api/graph/narrative` calls Anthropic without checking the flag. The flag exists
in `packages/data/src/feature-flags.ts` and gates 8 other AI sites. The graph
narrative is the only graph-side AI call site missing the gate.

Acceptance:
- `/api/graph/narrative/route.ts` early-returns 503 with `{ disabled: true }` when
  `FLAGS.AI_SUMMARIES_ENABLED === false`.
- `GraphHeader` ✨ Explain button hidden (or disabled with tooltip) when flag off —
  read flag via a `/api/platform/flags` endpoint or via a server prop on the page.
- Update `docs/OPERATIONS.md` to reflect graph narrative gating.

### 1.4 Bills show titles, not IDs — FIX-123

`entity_connections` API returns proposal nodes with `id` set to `external_id`
("HR-1234") and no `title`. Force graph node labels are unreadable as a result.

Acceptance:
- `/api/graph/connections/route.ts` joins `proposals.title` and returns
  `node.name = title` for proposal-type nodes.
- Force graph node label uses `node.name`. Tooltip shows external_id as subtitle.

### 1.5 State data on officials — FIX-124

Federal officials have empty `metadata.state_abbr` and blank `district_name`.
State only lives in `source_ids->>'fec_candidate_id'` (positions 2-3). Treemap
"by state" returns "Unknown" for the entire Senate. HIT_LIST flag.

Acceptance:
- One-shot SQL or pipeline pass to populate `officials.metadata.state_abbr` for
  federal reps via FEC ID parsing.
- Verify `/api/graph/treemap?groupBy=state` returns proper state buckets.
- Investigate whether this also unblocks any FIX-042 prereqs.

### 1.6 Procedural votes filter by default — FIX-125

The toggle is per-roll-call (`metadata->>'vote_question'`), but graph defaults
include procedural votes. HIT_LIST: "procedural votes should be filtered by
default". Verify the filter actually fires end-to-end.

Acceptance:
- `DEFAULT_VIEW.focus.includeProcedural = false`.
- `/api/graph/connections?include_procedural=false` excludes any vote whose
  `metadata.vote_question` starts with "On the Cloture Motion", "On Motion to
  Proceed", "On the Motion", "On Ordering the Previous Question", etc. (regex
  list, configurable).
- ConnectionsTree procedural toggle reflects current state correctly on first
  render (no flicker).

### 1.7 `user_custom_groups` DB table — FIX-126

User-defined `FocusGroup`s persist per-user. Per Craig's call: skip localStorage,
go straight to DB.

Acceptance:
```sql
CREATE TABLE user_custom_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  filter      JSONB NOT NULL,      -- GroupFilter shape
  icon        TEXT,
  color       TEXT,
  is_public   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX user_custom_groups_user_idx ON user_custom_groups(user_id);
```
- RLS: read own + public; write own.
- Migration applied locally + Pro.
- `/api/graph/custom-groups` route: GET (list mine + public), POST (create), DELETE.

### 1.8 Custom group builder UI — FIX-127

Surface `createCustomGroup()` in the panel. Per Craig: also wire into the agencies
page so users can build "all defense agencies" without leaving the agency context.

Acceptance:
- "+ Build custom group" row at the bottom of GroupBrowser. Opens an inline form:
  entity_type / party / chamber / state / industry, all optional. Shows live
  count via `/api/graph/group/preview`. Save → POST to `/api/graph/custom-groups`,
  add as FocusGroup to current view.
- Agencies page (`/agencies`): same form embedded as a sidebar widget. Clicking
  an agency in the form jumps to the graph with that custom group focused.

---

## Direction 3 — Reactive panels

### 3.1 Connections tree gates by focus entity types — FIX-128

Today: ConnectionsTree shows all 9 types regardless of what's focused. A user
focusing only PACs sees `vote_yes`/`vote_no` toggles that can never produce edges.

Acceptance:
- New helper `applicableConnectionTypes(focus): Set<string>` in `connections.ts`:
  - `donation` — applicable when any focus entity is `official` or any
    financial/pac type.
  - `vote_*`, `nomination_vote_*`, `co_sponsorship` — applicable when any focus
    entity is `official` or any focus group resolves to officials.
  - `oversight` — applicable when any focus is `official` or `agency`.
  - `appointment`, `revolving_door`, `contract` — applicable per their data shape.
  - `alignment` — applicable when USER node is on the canvas.
- ConnectionsTree renders applicable types in the Active section; non-applicable
  types fall under a collapsed "Not applicable to current focus" sub-tree (still
  reachable, with a one-line explanation).

### 3.2 Viz dropdown self-populates by focus + connections — FIX-129

Per Craig: "the available visualization types for the selected entities/connections
should self-populate."

Acceptance:
- Each VIZ_REGISTRY entry gains an `isApplicable(focus, connections, graphMeta)`
  method (default: always true).
- `force` → always applicable.
- `treemap` → applicable when donation data present *or* official data present.
- `chord` → applicable when donation data present (≥2 donors).
- `sunburst` → applicable when ≥1 entity in focus.
- `spending` → applicable when an agency or contract data is present.
- Header viz dropdown groups: "Available", "Not yet applicable" (greyed, click =
  toast "Add a PAC to enable Chord").
- Right panel Visualization section mirrors the same grouping.

### 3.3 Settings panel disables non-applicable controls — FIX-130

Today the Settings section in the right panel renders the active viz's controls
flatly. Some are useless (e.g., Treemap "Group by State" when no state data
loaded).

Acceptance:
- Each `LabeledSelect`/`LabeledSlider`/`LabeledToggle` accepts a `disabledReason`
  prop. When set, control is greyed and shows tooltip: `Not available — {reason}`.
- ForceSettings, TreemapSettings, ChordSettings, SunburstSettings each map control
  applicability against `graphMeta`. Don't filter the option list — disable.

### 3.4 Empty-state preset buttons — FIX-131

Per Craig: keep the search prompt, but add 2-3 visual preset buttons so a one-click
gets newbies started. Each button has a thumbnail showing what that viz looks like.

Acceptance:
- Empty graph state shows current "Search to start exploring" copy plus three
  cards stacked horizontally:
  - **Force — "Top 10 senators + their donors"** (uses default-view query)
  - **Treemap — "All PACs by industry"** (loads `/api/graph/treemap-pac`)
  - **Chord — "Industries → parties: $1.7B"** (loads chord)
- Each card has a static SVG/PNG thumbnail (not a live render — keep it cheap).
- Clicking the card sets focus + viz + applies the matching preset.

### 3.5 Surface PathFinder — FIX-132

Today PathFinder is buried in a collapsed section deep in FocusTree. It's one of
the highest-leverage features.

Acceptance:
- Add a `🔗 Path` button to GraphHeader (between viz dropdown and search).
- Clicking opens PathFinder as a floating overlay (similar pattern to AiNarrative).
- Keep the FocusTree collapsible section in place (redundancy is fine here).
- Result path edges highlight on Force graph (already partially supported).

### 3.6 Header button consolidation — FIX-133

Header is a flat row of 7 buttons. Group with thin separators:
- **Left cluster:** logo, viz dropdown, presets dropdown
- **Center cluster:** entity search, path finder, AI Explain
- **Right cluster:** share, screenshot, fullscreen

Acceptance: visual grouping with `border-r border-gray-700` separators between
clusters. No behavior change.

### 3.7 Right-panel collapsed icons jump to sections — FIX-134

When right panel is collapsed, two icons (`⬡`, `⚙`) both expand the panel without
scrolling to a section. Make them target-specific.

Acceptance:
- `⬡` icon → expand and scroll to Visualization section.
- `⚙` icon → expand and scroll to Settings section.
- Add a third `📋` icon → expand and scroll to Presets.
- Same pattern on left panel: `🎯` → Focus, `🔗` → Connections.

---

## Direction 2 — Browse like a file system

### 2.1 Five-category hierarchy refactor — FIX-135

Replace flat `GROUP_CATEGORIES` (Congress + Industry PACs) with a 5-category tree.
Use TreeNode recursively.

```
📂 People
  └ Federal: Senate / House / Federal judges
  └ State legislatures (drill by state — FIX-136)
  └ By committee (FIX-139)
📂 Money
  └ PACs by industry (existing 8)
  └ Top donors (top 100 by total)
  └ Corporations
📂 Government
  └ Executive agencies (with budget — FIX-145 hierarchy viz)
  └ Departments (hierarchical)
  └ Courts
📂 Legislation
  └ Active proposals (open comment now)
  └ By topic tag (FIX-137)
  └ By chamber / status
📂 Saved
  └ My presets (from BUILT_IN_PRESETS + user)
  └ My custom groups (from FIX-126 table)
  └ Recently viewed (FIX-140)
```

Acceptance:
- `groups.ts` exports a `GROUP_TREE` recursive structure.
- `GroupBrowser` renders recursively via TreeNode.
- Existing flat categories migrate without breaking BUILT_IN_GROUPS IDs (saved
  sessions reference these IDs).

### 2.2 By-state drill-down — FIX-136

Under "State legislatures" expand to a list of 50 states. Each state is itself
a group filter (`entity_type=official, state=XX`). Same pattern for "Officials
by state" generally.

Prereq: FIX-124 (state data populated).

### 2.3 By-topic-tag — FIX-137

`entity_tags` table has 5,978 tags. Surface top tags as group filters.

Acceptance:
- New API: `/api/graph/tag-groups` returns `[{ tag, count }]` for tags with
  count ≥ 10, ordered by count desc, top 30.
- Under Legislation → "By topic tag" → list of clickable tags. Each click adds
  a custom FocusGroup with filter `{ entity_type: 'proposal', tag: <name> }`.
- `applyGroupFilter()` extended to handle the `tag` field.

### 2.4 By-location — FIX-138

Surface a "My state" / "My district" group when the user has `home_state` /
`home_district` set. Cross-references the user_preferences table (FIX-042
prereq — Stage 2).

Acceptance: row appears in People > Federal > "My state's reps" when home_state
is set; clicking adds a custom group of officials matching that state.

### 2.5 By-committee — FIX-139

**Investigation outcome (2026-04-25):** No standalone `committees` table. Committees
are conceptually `governing_bodies` rows but the `governing_body_type` enum has no
`'committee'` value. `officials.governing_body_id` is a single FK — a senator can
only belong to one body, but real senators sit on multiple committees. No data is
ingested today.

**Prereqs filed:**
- **FIX-152** — schema: add `'committee'` to `governing_body_type` enum +
  `official_committee_memberships` join table (official_id, committee_id, role,
  started_at, ended_at).
- **FIX-153** — pipeline: Congress.gov committees endpoint → backfill
  `governing_bodies` rows of type='committee' + memberships join rows.

After 152 + 153 land, FIX-139 itself is small: People → "By committee" expands to
all major committees; click adds a custom group whose filter resolves via the
membership join.

### 2.6 Recently viewed — FIX-140

LocalStorage-backed list of last 20 entities the user added to focus.

Acceptance: Saved → Recently viewed → most-recent-first list. Click adds to
focus.

---

## New connection types

### 4.1 `appointment` — FIX-141

Already mentioned in CLAUDE.md presets but not in `CONNECTION_TYPE_REGISTRY`.
Source: `career_history` table or existing `entity_connections` rows of type
`appointment`.

Acceptance:
- Registry entry with description and color (suggest #d97706 amber).
- Verify pipeline derivation in `packages/data/src/pipelines/connections/`.
- DEFAULT_CONNECTION_STATE entry.

### 4.2 `revolving_door` — FIX-142

Same shape as appointment but tracks official ↔ corporation movement (career
history). Source: `career_history` joined to corporations.

Acceptance: registry + DEFAULT_CONNECTION_STATE + pipeline derivation. Suggest
icon 🔁, color #ec4899.

### 4.3 `contract` — FIX-143

Agency → corporation spending edges. USASpending data is ingested as
`spending_records`; not yet derived into `entity_connections`.

Acceptance:
- Registry entry: icon 💵, color #14b8a6.
- DEFAULT_CONNECTION_STATE.
- Pipeline derivation: groups `spending_records` by (agency_id, recipient) and
  emits `entity_connections` with `connection_type='contract'`,
  `metadata.fy_total_usd`.
- Verify the connection renders in Force graph.

---

## New visualization types

### 5.1 Hierarchy viz (D3 tree/dendrogram) — FIX-144

Agency org chart with budget-weighted node sizes. HIT_LIST flag. Per Craig: also
embed on `/agencies` page.

Acceptance:
- New `visualizations/HierarchyGraph.tsx` using `d3.tree()` or `d3.cluster()`.
- Registry entry. `requiresEntity: false`. `supportedConnectionTypes: ['oversight']`.
- API `/api/graph/hierarchy?root=<agency_id>` returns nested structure.
- Right panel settings: orientation (horizontal/vertical), node-size encoding
  (budget/employees/uniform), collapse depth.
- Embed compact variant on `/agencies` for top-of-page department drill-down.

### 5.2 Matrix viz (N×N adjacency heatmap) — FIX-145

"Which senators voted with which other senators most often." Sortable, clusterable.

Acceptance:
- New `visualizations/MatrixGraph.tsx` rendering N×N grid via D3.
- Registry entry. Applicable when ≥2 officials in focus.
- Cell color = vote agreement % (Cohen's kappa or simple match rate).
- Sort: alphabetical, by-cluster (k-means on rows), by-party.

### 5.3 Alignment viz (USER-centric radial) — FIX-146

Custom for USER node. User in center; reps fan out radially; alignment ratio is
bar fill. Could be the headline civic feature.

Acceptance:
- New `visualizations/AlignmentGraph.tsx` — radial bar chart, USER at center,
  one bar per representative.
- Registry entry. `isApplicable` true only when USER node + alignment edges are
  present.
- Preset: "How aligned are my reps?" — auto-loads USER + reps + alignment edges,
  switches to AlignmentGraph.

### 5.4 Sankey budget flow — FIX-147

Treasury → agency → vendor → state. Plays well with USASpending data.

Acceptance:
- New `visualizations/SankeyGraph.tsx` using `d3-sankey`.
- Registry entry. Applicable when contract data present.
- Settings: levels (2 / 3 / 4), min flow USD, top-N at each level.

### 5.5 SpendingGraph wire-up + investigation — FIX-148

**Investigation outcome (2026-04-25):** The `spending_records` table was DROPPED
in the cutover migration (`20260422000000_promote_shadow_to_public.sql:256`).
USASpending data now lives in `financial_relationships` rows where
`relationship_type IN ('contract', 'grant')`. The pipeline already migrated
(`packages/data/src/pipelines/usaspending/index.ts`). The route's two RPCs
(`chord_contract_flows`, `treemap_recipients_by_contracts`) were restored in
FIX-110 (migration `20260424000001`).

**However:**
- `pipelines/index.ts:45` still queries `spending_records` for the status
  dashboard count — broken read.
- `apps/civitics/CLAUDE.md`, root `CLAUDE.md`, and `docs/PHASE_GOALS.md:202` all
  reference `spending_records` as the data store. Stale.

**FIX-151** filed for the cleanup. Once it lands, FIX-148 itself is small:

- Wire `defaultOptions` in viz registry's `spending` entry (sliders for
  fiscal year, min award size, top-N agencies).
- Confirm `/api/graph/spending?type=chord` and `?type=treemap` return expected
  shape end-to-end against current data.
- Add SpendingSettings component in GraphConfigPanel (sibling of ChordSettings).
- Update registry's `supportedConnectionTypes` from `['contract']` → resolves
  cleanly once FIX-143 adds `contract` to `CONNECTION_TYPE_REGISTRY`.

---

## Compare mode upgrade

### 6.1 Shared connections pill list — FIX-149

When 2+ entities are focused, "shared edges" already render thicker. But the
*list* of shared connections is invisible.

Acceptance:
- Floating pill bar above the canvas (only when ≥2 entities focused):
  `3 shared connections between Warren and Cruz: [Goldman Sachs PAC] [BlackRock] [Citi PAC]`
- Clicking a pill highlights that edge + nodes.
- Hide pill bar when only 1 entity focused.

---

## Documentation

### 7.1 Update packages/graph/CLAUDE.md — FIX-150

Reflect:
- File-system browse hierarchy (replaces flat GROUP_CATEGORIES).
- Reactive-panels rule (Connections gates by focus, viz dropdown self-populates,
  settings disable-don't-hide).
- USER node Stage 1 (visible/toggleable; alignment scoring is Stage 2).
- Custom groups backed by `user_custom_groups` table (not localStorage).
- AI Explain gated by `AI_SUMMARIES_ENABLED` flag.
- New connection types (`alignment`, `appointment`, `revolving_door`, `contract`).
- New viz types (Hierarchy, Matrix, Alignment, Sankey).
- Reference this GRAPH_PLAN doc as the live workplan.

---

## Prerequisites & open investigations

**Resolved 2026-04-25:**

- ~~Committee data presence~~ — investigated; no committees table exists. **FIX-152**
  (schema) + **FIX-153** (ingestion pipeline) filed as prereqs for FIX-139.
- ~~USASpending column drift~~ — investigated; `spending_records` was dropped at
  cutover, data lives in `financial_relationships` with `relationship_type IN
  ('contract','grant')`. Pipeline already migrated. RPCs restored by FIX-110.
  **FIX-151** filed to clean up stale references in `pipelines/index.ts:45` and
  three CLAUDE.md / PHASE_GOALS.md mentions.

**Still open:**

- **Federal officials state metadata** — FIX-124 prereq for FIX-136 and any
  state-keyed groups.
- **AI flag check at request time** — confirm `/api/graph/narrative` is the
  only graph-side AI call. Quick grep for `client.messages.create` in the graph
  package and `apps/civitics/app/api/graph/` would confirm before FIX-122 lands.
- **`user_preferences` table** — FIX-042 spec calls for it. FIX-138 (by-location)
  consumes it. Confirm it's already created or file the prereq before FIX-138.

---

## Open designs (parked 2026-11-14)

Moved from `docs/FIXES.md` by cc-284. Both re-open at the next graph design session (`docs/PHASE_GOALS.md`, Phase 2 · Graph Enhancements).

- **Attribution on the graph routes — was FIX-405.** (1) The per-edge model: one source, a `(from_source, to_source)` pair, or a source typed by relationship? (2) Attribution after aggregation: when N edges collapse into one chord arc, what does `attribution.primary` name — the most common source, the union, or null? (3) The cost of a per-row `source_count` on list endpoints: benchmark first, and materialize `attribution_source_count` if it becomes a hotspot.
- **Governing bodies, jurisdictions and meetings on the graph — was FIX-468, its design half.** Does a governing body become a node with member and jurisdiction edges, or a group that expands to its members? Do jurisdictions seed as geographic group expansions or as nodes? Are meetings worth graph presence at all? Should the hard-coded presets (`apps/civitics/app/graph/EmptyStatePresets.tsx`) derive from `governing_bodies` rows, so the two mechanisms become one? The guard half shipped with FIX-764, and institutions already seed as gb-backed groups (FIX-490).

---

## Done log

When a FIX in this plan lands, append a one-liner here so future readers see what
was finished without re-reading commit history.

- (none yet)
