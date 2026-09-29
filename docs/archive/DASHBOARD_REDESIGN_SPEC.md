# Dashboard Redesign Spec

**Scope:** Full audit + redesign of `/dashboard` (Platform Transparency).
**Goal:** Sleek, powerful, efficient. Two clear audiences (public / operator) without two pages to maintain.
**Written:** 2026-04-20. Decisions locked with Craig; open items flagged at end.

---

## 1. Audit — what's actually there

Current dashboard lives at `apps/civitics/app/dashboard/`. One server page renders `DashboardClient` plus three extras (`SitemapSection`, `BrowsingFlowsSection`, `ModerationSection`). The client composes **10 sections** that stack vertically, with occasional two-column pairs.

### 1.1 Section inventory

| # | Section | Source | Data |
|---|---|---|---|
| 1 | Page header + "Our receipt" amber banner | `page.tsx` | static |
| 2 | Alert banner (self-tests failing) | `DashboardClient` | `status.self_tests` |
| 3 | Refresh timestamp line | `DashboardClient` | `status.meta` |
| 4 | 6 stat cards (Officials, Proposals, Votes, Connections, Donor Records, AI Summaries X) | `StatsSection` | `status.database` |
| 5 | Open Comment Periods (3 cards) | `CommentPeriodsSection` | server-side `getOpenProposals` |
| 6 | Data Pipelines | `PipelinesSection` | `status.pipelines` |
| 7 | Data Quality & Coverage | `DataQualitySection` | `status.quality` + `status.database` |
| 8 | Notable Connections (chord top flows) | `ConnectionHighlightsSection` | `status.chord.top_flows` |
| 9 | Site Activity (top pages 24h) | `ActivitySection` | `status.activity` OR server-side `getActivity` (duplicated) |
| 10 | Platform Costs — 5 collapsible service cards | `PlatformCostsSection` | `/api/platform/usage` + `/api/platform/anthropic` |
| 11 | Development Progress (Phase 1 of 5 + 20 task checklist) | `DevelopmentProgressSection` | **hard-coded** in source |
| 12 | Community Compute Pool ($0 / $0) | `CommunityComputeSection` | **hard-coded** |
| 13 | What Civitics Tracks (prose list) | `PlatformStorySection` | `status.database` + `chordTotalFlowUsd` |
| 14 | System Self-Tests (6 checks) | `SelfTestsSection` | `status.self_tests` |
| 15 | How People Explore the Site (browsing flows) | `BrowsingFlowsSection` | server-side RPCs |
| 16 | Explore the Platform (10-route sitemap) | `SitemapSection` | **hard-coded route list** |
| 17 | Moderation queue (admin-only) | `ModerationSection` | `/api/admin/moderation` (403s for non-admins) |
| — | Floating "Refresh" admin button (bottom-right) | `DashboardClient` | — |

### 1.2 Dead code (delete)

| File | Lines | Why it exists | Action |
|---|---|---|---|
| `PipelineOpsSection.tsx` | 687 | Earlier attempt at ops view, never wired up | Delete |
| `BudgetControlForm.tsx` | 94 | Inline admin form, superseded by service dashboards | Delete |
| `DashboardStatsSection.tsx` | 134 | Standalone stats section, inline-replaced by `StatsSection` in DashboardClient | Delete |
| `DashboardAutoRefresh.tsx` | 54 | Auto-refresh shell, `useDashboardData` replaced it | Delete |

**~970 lines of zombie code.** Confirmed zero importers via grep.

### 1.3 Hard-coded / stale data

| Location | What's hard-coded | Problem |
|---|---|---|
| `DashboardClient.tsx:93-100` | `PHASES` array with % completion | Phase 1 hard-coded at 88%; CLAUDE.md says ~90%; will drift |
| `DashboardClient.tsx:102-123` | `PHASE1_TASKS` (20 items) | Manually maintained; includes non-eng items ("500 beta users", "Grant applications submitted"); "Dashboard redesign" marked `done: true` — false |
| `CommunityComputeSection` | Always renders `$0` / `$0` | Phase 4 placeholder reads as broken |
| `PlatformCostsSection.tsx:860` | "tracking **$1.75B** in donations" | Literal string; should pull from `chord_total_flow_usd` |
| `StatsSection`, AI Summaries card | Label is `"AI Summaries X"` | Looks like a debug artifact; the X should not be there |
| `SitemapSection.tsx:10-71` | 10-route array | Fine as hard-coded but needs `/initiatives` deep-linking check; "Post a Problem" item points to `/proposals/problem` which may not exist |
| `DashboardClient.tsx:65-77` | `PIPELINE_NAMES` + `KNOWN_PIPELINES` | Five pipelines hard-coded; new pipelines won't surface unless added here |

### 1.4 Visible data issues (production right now)

- **All 5 pipelines show "Pending / 0 rows"** — last nightly was Mar 21 (1 month stale). Self-test `nightly_ran_today` is failing, which is correct.
- **Industry tags: 0 of 1,850 (0%)** — regression from earlier coverage.
- **Site Activity: "0 human page views in last 24h"** — either `is_bot` filter is over-aggressive or real traffic is zero. Worth confirming.
- **All 3 open comment periods show "Closes in 0h"** — either date-diff is buggy or these are actually closing today. Worth verifying.
- **Stat card "AI Summaries X"** — trailing X in label.
- **Officials breakdown sublabel** shows `"Federal, state & judicial officials"` fallback instead of `"9,886 federal · X state · Y judges"` — `get_officials_breakdown` RPC returned null.

### 1.5 Efficiency problems

Observed in network panel on a fresh load at `localhost:3000/dashboard`:

- **Triple-fire**: `/api/claude/status`, `/api/platform/usage`, `/api/platform/anthropic` each fire **3×** in the first 10 seconds. Source: `useDashboardData.useEffect` runs `fetchData()` unconditionally, starts an interval **and** registers a `visibilitychange` handler that also calls `fetchData()`. On mount with the tab visible, all three paths fire nearly simultaneously.
- **`/api/claude/status` runs 10 parallel DB sections** on every poll, including `search_graph_entities('warren')` RPC, full `page_views` scan, per-category `VOTE_CATEGORIES` counts, `chord_industry_flows` RPC. Measured 4.7s on localhost. Endpoint has `revalidate = 300` at the edge but client cache-busts via interval.
- **Duplicated activity query**: `page.tsx` does `getActivity()` server-side and `/api/claude/status` returns `status.activity` — client then uses `activity from status if present, else server activity`. Two identical queries running on page load.
- **Moderation fetch**: `ModerationSection` fires `/api/admin/moderation` for every visitor; non-admins get 403. ~250ms of pointless wire time per load.
- **Notifications**: `/api/notifications?limit=20` fires 2× on mount, both 401. Navbar component responsibility but worth noting.
- **Anthropic admin refresh button** (fixed bottom-right) triggers the full 3-endpoint refresh cycle.

---

## 2. New information architecture

### 2.1 Two equal tabs, one route

`/dashboard` keeps `max-w-7xl`. Below the PageHeader, a tab bar:

```
[ Transparency ]   [ Operations ]
```

URL-synced (`?tab=transparency` | `?tab=operations`, default `transparency`). Deep links preserve tab state. Browser back/forward works. No two pages to maintain.

### 2.2 Transparency tab — what the public sees

Ordered for the mission. Above the fold = stat cards + comment periods.

1. **Hero stat cards** — 4 (not 6). Officials / Proposals open / Votes on record / Donation flow (USD). Each with sparkline of last-30-day trend. Clicking drills into the resource page. Sublabels pull real breakdowns.
2. **Open Comment Periods** — unchanged structure. Fix "Closes in 0h" formatting bug.
3. **Donation flows** — promote `Notable Connections` to full width. Add a small industry-pair chip row (Labor → Dem House, etc.) + one big total ("$1.75B tracked this cycle" — from `chord.total_flow_usd`, not hard-coded).
4. **What Civitics tracks** — condensed to a one-line summary row, not its own card. Data sources pills stay.
5. **Explore the Platform** — sitemap grid, reduced from 10 routes to top 6 (Officials, Proposals, Agencies, Graph, Search, Initiatives). Move "Post a Problem" + "Your Profile" to nav, not dashboard.
6. **How people explore the site** — keep but shrink. Privacy note stays.

**Cut from Transparency tab:** pipelines, data quality bars, platform costs, self-tests, dev progress, community compute. These are not public stories — they're ops.

### 2.3 Operations tab — what the operator sees

Ordered for diagnostics. Top-down triage: are tests green → pipelines fresh → quality holding → costs under budget.

1. **Status strip** — single row of 4 chips: tests (n/6 passed), last nightly, AI budget used, resource warnings. Colored dots only, no prose.
2. **System Self-Tests** — promoted. Expanded detail row per test, not just pass/fail.
3. **Data Pipelines** — unchanged but enriched. Add sparkline of `rows_inserted` per nightly for each pipeline (30-day history already in `data_sync_log`).
4. **Data Quality & Coverage** — unchanged.
5. **Platform Costs** — unchanged. Fix the `$1.75B` literal to read from `chord.total_flow_usd`.
6. **Site Activity + Browsing Flows** — moved here. This is operator analytics, not public transparency.
7. **Development Progress** — keep (Craig's call) but drive from real data:
   - Phase percentages → parse `docs/PHASE_GOALS.md` at build time into a JSON sidecar, OR add a `/api/phases` route that counts `FIX-NNN` items in `../FIXES.md` by phase section and computes `done / total`.
   - Phase 1 task list → drop "500 beta users" and "Grant applications submitted" (non-eng milestones). Or move them to a separate "Launch readiness" mini-card.
   - "Dashboard redesign" → uncheck until this spec ships.
8. **Moderation** — admin-only, gated so non-admins never fire the request.

### 2.4 Header / hero area

```
Civitics / Transparency
Platform Transparency                              [ last updated: 30s ago · refresh ]
Live data on what Civitics tracks, how pipelines are performing, and what
the platform costs to run. This page is our receipt.

[ Transparency ] [ Operations ]
```

- **Delete amber banner.** Append `"This page is our receipt."` to the description under the title (Craig's call).
- Add a subtle "last updated" + manual refresh inline in the header (replaces the floating bottom-right button).
- Keep breadcrumb.

---

## 3. Visual system

Direction: **light, Stripe/Linear-sleek**. Keep gray-50 background. Tighten spacing, replace emoji with Lucide, introduce tabular numerals everywhere that shows a count or dollar amount.

### 3.1 Typography

| Role | Current | New |
|---|---|---|
| Page title | `text-2xl font-bold` | unchanged |
| Stat card value | `text-3xl font-bold` | `text-3xl font-semibold tabular-nums tracking-tight` |
| Stat card label | `text-xs uppercase` | unchanged |
| Section title | `text-base font-semibold` | unchanged |
| Numbers in tables | default | **`tabular-nums`** everywhere — makes columns line up |
| Body | `text-sm text-gray-700` | unchanged |

### 3.2 Icons — replace emoji with Lucide

Shipping `lucide-react` (already a dep in packages/ui). Mapping:

| Current | Lucide |
|---|---|
| 👤 Officials | `Users` |
| 📋 Proposals | `ScrollText` |
| 🗳 Votes | `Vote` |
| 🔗 Connections | `Network` |
| 💰 Donors / costs | `DollarSign` |
| 🤖 AI | `Sparkles` |
| 🔄 Pipelines | `RefreshCw` |
| 📊 Quality | `BarChart3` |
| 💡 Highlights | `Lightbulb` |
| 👀 Activity | `Eye` |
| 🚀 Dev progress | `Rocket` |
| ⛏ Community pool | `Pickaxe` (deleting anyway) |
| 🔍 Self-tests | `CircleCheck` / `CircleX` |
| 🏠 Home | `Home` |
| 🏛 Agencies | `Landmark` |
| 🗺 Sitemap | `Map` |

Icons render at `size={16}` with `text-gray-500` (or status color). `SectionHeader` accepts `icon` as a React node, not a string — small API tweak in `packages/ui`.

### 3.3 Stat cards — tighter

- Reduce from 6 to 4 (Officials / Open Proposals / Votes / Flow $).
- Add **sparkline** row (20px high, last 30 days). Pull from new `/api/stats/trends` or reuse `data_sync_log.rows_inserted` history. Use `recharts` `<Sparkline>` or a hand-rolled SVG.
- Replace trailing arrow (`→`) with a proper hover state: card itself is the link, no separate arrow.
- Badge style unchanged but use `rounded-md` not `rounded-full` for consistency with rest of app.

### 3.4 Section cards

- `SectionCard` keeps white bg, `border-gray-200`, `rounded-xl`, `p-6`.
- **Swap `shadow-sm` for no shadow** + `border` only. Stripe/Linear don't use shadows on cards. Cleaner.
- Dense variant (`<SectionCard dense>`) drops padding to `p-4` and header spacing for operator content.

### 3.5 Tables / rows

- Pipeline rows, self-test rows, service cards: `text-sm`, 12px horizontal padding, 8px vertical. Dividers `border-gray-100`.
- Status dots: 6px circle, color from `--status-ok / warning / error`. No emoji.
- Numbers always `tabular-nums text-right`.

### 3.6 Color

Keep `--blue-600` as primary. Introduce a narrow status palette and **use it consistently**:

| Status | Text | Dot / Bar |
|---|---|---|
| ok | `text-emerald-600` | `bg-emerald-500` |
| warning | `text-amber-600` | `bg-amber-500` |
| error | `text-rose-600` | `bg-rose-500` |
| neutral | `text-gray-500` | `bg-gray-300` |

(Switch `red-500` → `rose-500` and `yellow-*` → `amber-*`. Rose/amber pair better with blue-600.)

### 3.7 Grid

- Max width bumped from `max-w-7xl` (1280px) to `max-w-[1400px]` on screens ≥ 1440px. Keeps data density without sprawling.
- Stat card row: `grid-cols-2 md:grid-cols-4` (no 6-wide mobile).
- Section pairs: `grid-cols-1 lg:grid-cols-2` with related content only.

---

## 4. Efficiency plan

### 4.1 Fix the triple-fire (P0)

`useDashboardData` runs three overlapping triggers on mount:

```ts
useEffect(() => {
  fetchData();                                 // ← #1
  start();                                      // ← schedules interval (15 min, fine)
  document.addEventListener("visibilitychange", onVisibility);
  return cleanup;
}, [fetchData]);

const onVisibility = () => {
  if (!document.hidden) {
    fetchData();                                // ← #2 — fires on mount because doc is visible
    start();                                    // ← re-creates interval every time
  }
};
```

**Fix:** only register the visibility handler, don't call `fetchData()` from it on mount; let the initial `useEffect` seed the data once. Also guard `start()` so it doesn't create a second interval.

### 4.2 Split hot / cold state

Right now one `useDashboardData` hook fetches everything every 15 minutes. Split into two hooks:

| Hook | Endpoints | Refresh |
|---|---|---|
| `useHotStatus()` | `/api/claude/status` (stats + pipelines + self-tests) | 60s |
| `useColdStatus()` | `/api/platform/usage` + `/api/platform/anthropic` | 15min |

Or just let the existing hook stay and rely on edge-cache + `Cache-Control` headers on the routes.

### 4.3 Trim `/api/claude/status`

Currently returns 10 sections in one response. Three are rarely-changing (`quality`, `self_tests` self-test for Warren, `chord`). Extract them:

- `/api/claude/status/core` → meta, version, database counts, pipelines, ai_costs, activity
- `/api/claude/status/quality` → quality, self_tests, chord (15-min cache)

Client fetches core every 60s, quality every 15min. Reduces Warren search + chord RPC from every 60s to every 15min.

Alternative: keep single endpoint but memoize expensive sections server-side in Redis / edge cache by section (`revalidateTag('quality')` with 15min TTL). Less plumbing.

### 4.4 Drop duplicate activity query

`page.tsx` does `getActivity()` server-side AND `/api/claude/status` returns `status.activity`. Client falls back from status to server. **Drop the server-side function.** Client always reads from status. One less DB roundtrip on every page load.

Same pattern: `getBrowsingFlows` and `getOfficialsBreakdown` — move into status endpoint, drop server functions.

### 4.5 Gate moderation behind admin check

`ModerationSection` currently calls `/api/admin/moderation` and conditionally renders based on the 403. Better: `useSession()` check client-side, only render the section (and fire the fetch) if user is admin. Saves the round trip for all non-admins.

### 4.6 Cache the Anthropic admin button

The floating `Refresh` button POSTs to `/api/platform/anthropic` to invalidate the cache and re-fetch. Keep, but move it into the header area (not floating bottom-right, which overlaps the Cowork dev badge). Only show when `isAdmin`.

### 4.7 Expected impact

| Metric | Before | After |
|---|---|---|
| API calls on initial load | 11 | 4 |
| DB queries/minute while tab open | ~20 | ~6 |
| Time to first meaningful paint | ~5s (waiting on status) | ~1s (server renders stats directly, status populates async) |
| `/api/claude/status` p50 | 4700ms | <1500ms (core only, quality async) |

---

## 5. Phased implementation

Break into batches so each lands as a shippable commit.

### Phase A — Cleanup (low-risk, unblocking)

- **FIX-074**: Delete `PipelineOpsSection.tsx`, `BudgetControlForm.tsx`, `DashboardStatsSection.tsx`, `DashboardAutoRefresh.tsx`.
- **FIX-075**: Fix "AI Summaries X" label (remove trailing X).
- **FIX-076**: Fix "Closes in 0h" formatting in `CommentPeriodCard` (inspect date math).
- **FIX-077**: Replace hard-coded "$1.75B" footer string with `chord.total_flow_usd`.
- **FIX-078**: Delete `CommunityComputeSection` entirely.

### Phase B — Efficiency

- **FIX-079**: Fix triple-fire in `useDashboardData` (visibility handler + interval dedupe).
- **FIX-080**: Drop server-side `getActivity`, `getBrowsingFlows`, `getOfficialsBreakdown` in `page.tsx`; read all from `/api/claude/status` on client.
- **FIX-081**: Gate `ModerationSection` behind `useSession()` admin check; skip fetch for non-admins.
- **FIX-082**: Split `/api/claude/status` into `/core` + `/quality`, or section-level memoization with `revalidateTag`. Client fetches hot/cold separately.

### Phase C — IA + Tabs

- **FIX-083**: Add `<TabBar>` to `PageHeader` (URL-synced via `searchParams.tab`). Two tabs: Transparency, Operations. Default to Transparency.
- **FIX-084**: Reorganize `DashboardClient` — extract `<TransparencyTab>` + `<OperationsTab>`; move sections per IA spec in §2.
- **FIX-085**: Move "How people explore the site" + Moderation + Self-Tests + Pipelines + Quality + Costs + Dev Progress into Operations tab.
- **FIX-086**: Delete amber receipt banner from `page.tsx`. Append "This page is our receipt." to the description prop of `PageHeader`.

### Phase D — Visual polish

- **FIX-087**: Add Lucide icon support to `SectionHeader` (accept `icon: React.ReactNode`). Keep string emoji as fallback for a release.
- **FIX-088**: Replace all dashboard emoji with Lucide per mapping in §3.2.
- **FIX-089**: Reduce stat cards from 6 to 4 (Officials / Open Proposals / Votes / Flow $). Bundle into `<StatsRow>` in packages/ui.
- **FIX-090**: Add sparklines to stat cards. Either build `/api/stats/trends` route that returns last 30 days of daily counts per metric, or reuse `data_sync_log.rows_inserted` history.
- **FIX-091**: Swap shadow for border-only on `SectionCard`. Swap `red-*` → `rose-*`, `yellow-*` → `amber-*` across dashboard.
- **FIX-092**: Move admin refresh button into the page header (next to "last updated"). Delete floating bottom-right variant.
- **FIX-093**: Bump max-w-7xl → max-w-[1400px] on screens ≥ 1440px.

### Phase E — Data-drive the dev progress section

- **FIX-094**: Add `/api/phases` route that reads `docs/PHASE_GOALS.md` at build time and returns `{ phase, label, pct, done }[]`. Replace hard-coded `PHASES` array.
- **FIX-095**: Parse `docs/FIXES.md` into per-phase task lists with real `done` state from `docs/done.log`. Replace hard-coded `PHASE1_TASKS`.
- **FIX-096**: Drop non-engineering tasks from the tracker view ("500 beta users", "Grant applications submitted") — surface them in a separate "Launch readiness" mini-card instead.

---

## 6. Open decisions (flag for Craig)

1. **Stat card trends** — build `/api/stats/trends` endpoint fresh, or reuse `data_sync_log.rows_inserted` history? The latter is free but only reflects pipeline inserts, not organic growth (e.g., `proposals` table size over time). Recommend: build a lightweight view.
Answer: Build Lightweight View
2. **Phase data source** — parse `../PHASE_GOALS.md` at build time (static, fast, but requires a build step to refresh) or read at runtime via an API (live, slightly slower)? Recommend: runtime.
Answer: Runtime
3. **Are "500 beta users" and "Grant applications submitted" dashboard-worthy at all?** They feel like launch-readiness items, not engineering progress. Options: separate card, separate page, or delete from the dashboard entirely.
Answer: Delete
4. **Max width** — confirm `max-w-[1400px]` on ≥ 1440 screens matches the rest of the app. Currently every page is `max-w-7xl` (1280px). Bumping just the dashboard may look inconsistent.
Answer: Keep it consistent with rest of app
5. **Officials breakdown RPC** — `get_officials_breakdown` is returning null in prod, so we fall back to "Federal, state & judicial officials". Is this RPC broken or just not deployed? Worth checking before Phase D.
Answer: Unsure 
6. **Keep the development progress section at all?** You said yes, but if we can't cleanly data-drive it without 3 more FIX items, moving it to `/internal` (admin-only) or deleting it is an option. It doesn't contribute to the "accountability" narrative.
Answer: Keep in operations tab if possible

---

## 7. Out of scope (intentionally)

- Mobile redesign — current dashboard is desktop-first; mobile gets the same layout stacked. Separate effort.
- Dark mode — deferred. Craig selected light Stripe/Linear-sleek, not hybrid.
- Any new DB schema — this spec works with existing tables.
- Changes to `packages/ui` beyond the `SectionHeader` icon prop extension, `StatsRow`, and sparkline component.

---

## Appendix A — Reference material

Dashboard inspiration used to anchor the visual direction:

- **Linear dashboard** — dense, light, tabular nums, no emoji, minimal chrome
- **Vercel new dashboard** — sidebar + top tabs, clean hierarchy between project/ops content
- **Stripe dashboard** — the gold standard for light-and-powerful; borderless cards, restrained color, strong numbers
