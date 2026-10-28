# Civitics — Project Handoff Document
*Last updated: Session 4, April 2026*
*Use this file to bootstrap new Claude chat sessions for prompt generation.*

---

## 1. PROJECT OVERVIEW

**Mission:** Civic accountability platform — "Your seat at the table." Shows citizens how their representatives vote, who funds them, and whether they represent constituent interests.

**Tagline:** Running a civic accountability platform tracking $1.75B in donations costs less than a streaming subscription.

**Scale:** 8,251 officials · 2,066 proposals · 227,153 votes · 143,077 connections · $1.75B donation flows

**Stack:**
- Frontend: Next.js 14 (App Router), Tailwind CSS, D3.js
- Backend: Supabase (PostgreSQL + PostgREST), Cloudflare R2
- AI: Anthropic Claude API (Haiku for summaries)
- Hosting: Vercel (hobby plan) + Cloudflare proxy
- Monorepo: pnpm workspaces

**Monorepo Structure:**
```
apps/civitics/          # Main Next.js app
apps/social/            # Phase 3 social platform (not started)
packages/graph/         # D3 visualization package
packages/db/            # Supabase client + types
packages/data/          # Data ingestion pipelines
packages/ui/            # Shared UI components
```

---

## 2. DEVELOPER PROFILE (Craig)

**Location:** Bainbridge Island, WA
**Style:** Conversational, decisive, thinks architecturally
**Workflow:** Uses Claude (this chat) for design/brainstorming + Claude Code for implementation
**Preferred prompt format:** Detailed step-by-step with VERIFY section
**Communication preferences:**
- Paste terminal output directly — don't summarize errors
- Ask before writing long prompts — check current state first
- Flag prod DB risk explicitly before any DB operations
- Short questions get short answers; architectural questions get full treatment
- Appreciates when Claude spots the real problem vs the stated problem

**What works well:**
- Check files before writing prompts (`Get-Content`, `Select-String`)
- Write targeted prompts with exact line references
- Verify via PowerShell API calls before and after
- `[skip vercel]` in commit messages = no deploy, when every commit since the last deployment carries it (`apps/civitics/vercel.json` `ignoreCommand`, FIX-1359 — before 2026-10-28 the tag did nothing)

**What doesn't work:**
- Claude Code touching prod Supabase (has happened — always use `--local`)
- Writing prompts without seeing current file state
- Assuming field names — always verify schema first

---

## 3. ARCHITECTURE DECISIONS

### Why D3 not React Flow
The organic force layout IS the analysis. Dense clusters = deep entanglement. Bridge nodes reveal hidden connections. React Flow cannot reproduce this. **Never suggest React Flow.**

### Groups as Queries not Lists
Groups store a filter `{entity_type, chamber, party, state, industry}` not a list of IDs. This means:
- Lightweight to store
- Self-updating (new senators auto-included)
- Single API call for aggregate data
- 1000× more egress-efficient than loading individual members

### No Auto-refresh
Dashboard fetches once on load, manual refresh only. Every auto-refresh = Supabase egress cost.

### DB Safety Rules
- **ALWAYS** `supabase migration up --local` (never without --local)
- Local Studio: `http://127.0.0.1:54323`
- Local DB: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- Never unpause prod Supabase during development

### V2 Field Name Contract (CRITICAL)
```
NODES: id (plain UUID), name (NOT label), type, collapsed (NOT metadata.collapsed)
EDGES: fromId (NOT source), toId (NOT target), connectionType (NOT type), amountUsd (NOT amountCents)
API PARAMS: entityId (NOT entity_id)
```
Legacy V1 names cause silent bugs. Always verify field names before writing API code.

### PostgREST URL Limit
`.in('column', largeArray)` with 100+ IDs hits PostgREST URL length limits and **silently returns empty**. Always use RPC functions for large array queries.

### Supabase Enum Casting
`.eq('party', 'democrat')` can fail silently on enum columns. Use `.filter('party::text', 'eq', 'democrat')` or RPC functions that cast explicitly.

---

## 4. CURRENT STATE

### Working ✓
- Dashboard with live data, platform costs, pipeline status
- Global search (nav + hero) — `/api/search`
- Graph page with all 4 viz types
- Groups as queries (Senate Dems, House Reps, Finance PACs, etc.)
- ForceGraph with group nodes (large, colored, count badges)
- ChordGraph with group mode + cross-group mode
- TreemapGraph with group mode + PAC treemaps
- SunburstGraph with group mode, multi-ring, drill-down, octagon shape
- Official profile pages with tabs (Overview, Votes, Donations, Connections)
- Votes by Issue tab with keyword tagging + alignment colors
- GroupBrowser in Focus panel (premade + custom filter + by state)
- AlignmentPanel with issue priority sliders (localStorage)
- Civic badge (CivicBadge component, size variants)
- PAC classification pipeline (18,815 PACs tagged by sector)
- Local dev environment (Supabase Docker + ngrok)
- Cloudflare proxy (bot protection)

### Broken / Incomplete ✗
- Sunburst ring2 option doesn't affect API output (API ignores ring2)
- Sunburst shape/showLabels don't update without removing group (re-render issue)
- Settings buttons don't show current selection clearly (viz type buttons)
- Chord: individual official mode ("No donation flow data")
- Treemap entity mode (get_official_donors RPC column mismatch)
- Vercel billing API (requires Pro plan — returns 404)
- Supabase card in dashboard (project paused — shows no data)
- Self-configuring settings (hardcoded, not data-driven yet)
- Official profile: opponents section is placeholder only
- Official profile: mini sunburst badge wiring

### Pending / Backlog
- Unified search page `/search?q=...` (GlobalSearch "view all" goes nowhere)
- Mobile layout fixes
- Error/404 pages
- Upgrade Supabase Pro ($25/mo)
- Upgrade Vercel Pro ($20/mo)
- Unpause prod Supabase + re-enable cron jobs
- Bill issue scoring AI pipeline (Phase 2)
- Civic profile / alignment quiz (Phase 2)
- User accounts via Supabase Auth (Phase 2)
- Grant applications (Knight Foundation, Mozilla, Democracy Fund)
- Documentation (OPERATIONS.md, ARCHITECTURE.md)

---

## 5. DATA MODEL

### Key Tables
```sql
officials           -- 8,251 rows. role_title='Senator'|'Representative'
proposals           -- 2,066 rows. type='bill'|'regulation'|'resolution'
votes               -- 227,153 rows. vote='yes'|'no'|'abstain'|'not_voting'
entity_connections  -- 143,077 rows. connection_type=vote_yes|vote_no|donation|oversight|...
financial_relationships -- 18,815 PAC rows + 617 individual rows
financial_entities  -- PACs and donors (NOT joined to financial_relationships via FK)
agencies            -- Federal agencies
ai_summary_cache    -- AI-generated plain language summaries
platform_usage      -- Platform cost tracking
pipeline_state      -- Pipeline run history + recency guards
```

### Important Schema Notes
- `officials.party` is a PostgreSQL ENUM: democrat|republican|independent|green|libertarian|nonpartisan|other
- `financial_relationships` has NO FK to `financial_entities` — they're separate tables
- `financial_relationships.industry` column = org NAME not industry category (mislabeled)
- `financial_relationships.metadata->>'sector'` = PAC sector (set by pac-classify pipeline)
- `financial_relationships.donor_type` = 'pac'|'individual'|'party_committee'
- Vote titles like "On Passage", "On the Motion to Proceed" = procedural (not real bill votes)
- `entity_connections.from_id` = official UUID, `to_id` = proposal/financial entity UUID

### Key RPC Functions
```sql
get_officials_by_filter(p_chamber, p_party, p_state)  -- returns UUID[]
get_group_connections(p_member_ids UUID[], p_limit)    -- avoids URL limit
get_group_sector_totals(p_member_ids UUID[], p_min_usd) -- chord/sunburst sectors
get_crossgroup_sector_totals(p_group1_ids, p_group2_ids) -- cross-group chord
get_pac_donations_by_party()                           -- PAC by party treemap
treemap_officials_by_donations(lim)                    -- treemap data
search_graph_entities(q, lim)                          -- graph search RPC
```

### Migrations (0001-0029)
All applied locally. Key ones:
- 0027: `get_officials_by_filter` — fixes enum cast issue
- 0028: `get_group_sector_totals`, `get_crossgroup_sector_totals`
- 0029: `get_group_connections` — fixes PostgREST URL limit

---

## 6. API ROUTES

### Graph APIs
```
GET /api/graph/connections?entityId&depth&viz
  Returns nodes+edges for an official/entity
  Uses V2 field names: fromId, toId, connectionType, amountUsd, name

GET /api/graph/group?groupId&entity_type&chamber&party&state&industry&groupName&groupIcon&groupColor
  Returns aggregate nodes+edges for a group filter
  Official groups: top 50 donors → group node
  PAC groups: top 50 official recipients ← group node

GET /api/graph/chord?minFlowUsd&[groupId&groupFilter&groupName]&[secondaryGroupId&secondaryFilter]
  Mode 0: aggregate industry→party flows
  Mode 2: single group → industry donors
  Mode 3: cross-group flows between two groups
  Uses get_group_sector_totals RPC

GET /api/graph/treemap?groupBy&sizeBy&[entityId]&[chamber&party&state]
  Groups officials by party/state/chamber
  Filtered mode: pass chamber+party params

GET /api/graph/treemap-pac?groupBy=sector|party
  PAC money by industry sector or recipient party
  Excludes: 'PAC/Committee Contributions', Other, Party Committee

GET /api/graph/sunburst?entityId&ring1&ring2&maxRing1&maxRing2&[entityLabel]
  OR: ?groupId&groupFilter&groupName&ring1...
  ring1: connection_types|donation_industries|vote_categories
  ring2: top_entities|by_amount|by_count (NOTE: ring2 not yet implemented in API)

GET /api/graph/search?q&lim
  Returns ranked results: officials, agencies, financial_entities
  Uses search_graph_entities RPC

GET /api/platform/anthropic  -- Anthropic usage, 15min DB cache
GET /api/platform/vercel     -- Vercel billing (needs Pro plan)
GET /api/platform/usage      -- All platform metrics from platform_usage table
GET /api/claude/status       -- Dashboard health check + all metrics
```

### Known API Gotchas
- `/api/graph/group` with official filter: uses `get_officials_by_filter` RPC (not `.eq('party', ...)`)
- `/api/graph/chord` group mode: uses `get_group_sector_totals` RPC (not `.in()`)
- `/api/graph/treemap-pac`: excludes donor_name ILIKE '%PAC/Committee%'
- All graph APIs use V2 field names — legacy V1 names cause silent failures

---

## 7. COMPONENT ARCHITECTURE

### Graph Package (`packages/graph/src/`)
```
SunburstGraph.tsx      -- Radial viz, gradient arcs, drill-down, group mode
ChordGraph.tsx         -- Industry→party flows, group mode, cross-group
TreemapGraph.tsx       -- Officials/PACs by group, drill-down
ForceGraph.tsx (viz/)  -- D3 force simulation, group nodes
ForceGraph.tsx (root)  -- Used by OfficialGraph on profile pages

GroupBrowser.tsx       -- Premade groups + custom filter + by state
AlignmentPanel.tsx     -- Issue priority sliders (localStorage)
FocusTree.tsx          -- Focus panel with search + browse + active list
GraphConfigPanel.tsx   -- Right panel: viz picker, presets, settings
NodePopup.tsx          -- Click popup for nodes (group-aware)
DataExplorerPanel.tsx  -- Left panel container (260px fixed width)
```

### Key Types (`packages/graph/src/types.ts`)
```typescript
FocusEntity    -- Individual entity in focus
FocusGroup     -- Group query: {id, name, type:'group', filter, icon, color, count}
FocusItem      -- FocusEntity | FocusGroup
GroupFilter    -- {entity_type, chamber?, party?, state?, industry?}
GraphNode      -- V2: {id, name, type, collapsed, metadata}
GraphEdge      -- V2: {id, fromId, toId, connectionType, amountUsd, strength}
SunburstOptions -- {ring1, ring2, maxRing1, maxRing2, shape, showLabels, badgeSize}
```

### Built-in Groups (`packages/graph/src/groups.ts`)
```
Congress: Full Senate, Full House, Senate Democrats, Senate Republicans,
          House Democrats, House Republicans, Federal Judges
Industry PACs: Finance, Energy, Healthcare, Defense, Labor, Tech,
               Agriculture, Real Estate
By State: Dynamic via createCustomGroup()
```

### Data Flow
```
GraphPage
  → useGraphView (view state: focus, connections, style)
  → useGraphData (fetches nodes/edges, handles groups vs individuals)
  → ForceGraph / ChordGraph / TreemapGraph / SunburstGraph
  → GraphConfigPanel (settings, presets)
  → DataExplorerPanel → FocusTree → GroupBrowser / EntitySearchInput
```

### useGraphData Group Handling
- Individual entities: calls `/api/graph/connections?entityId=...`
- Groups: calls `/api/graph/group?groupId=...&entity_type=...`
- Tracks group-connected nodes in `groupNodeIds` ref for proper cleanup
- Removal of group also removes all connected nodes via `groupConnectedToRemove`

---

## 8. KNOWN BUGS & PATTERNS

### Infinite Loop Pattern
Any `useEffect` with an object in deps causes infinite re-render:
```typescript
// WRONG:
}, [entityId, primaryGroup, ring1])  // primaryGroup is new object each render

// CORRECT:
}, [entityId, primaryGroup?.id, primaryGroup?.filter.entity_type, ring1])
```

### PostgREST URL Limit (CRITICAL)
```typescript
// WRONG — silently returns empty with 100+ IDs:
supabase.from('table').select('*').in('column', largeArray)

// CORRECT — use RPC:
supabase.rpc('get_group_connections', { p_member_ids: memberIds })
```

### Supabase Enum Cast
```typescript
// WRONG — silently fails on enum columns:
.eq('party', 'democrat')

// CORRECT:
.filter('party::text', 'eq', 'democrat')
// OR use RPC with: WHERE o.party::TEXT = p_party
```

### Hydration Errors
- Always add `suppressHydrationWarning` to elements using `Date.now()`
- Use `"use client"` + mounted guard for components with loading states
- Wrap client components with `dynamic(() => import(...), { ssr: false })`

### Browser Cache in Dev
- **NEVER enable "Disable Cache" in browser DevTools during Next.js dev**
- Caused hours of debugging — makes changes appear not to work

### Docker / Supabase Recovery
```powershell
supabase start           # recreates containers, data volumes persist
# If data lost:
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f data.sql
```

### React Strict Mode
Dev-only double-render can mask real issues. If hydration errors persist in dev but not prod, accept them — they're cosmetic.

---

## 9. WORKFLOW

### Daily Dev Routine
```powershell
# Morning:
supabase start
pnpm dev

# Evening:
supabase stop
```

### Commit Conventions
```
git commit -m "[skip vercel] description"  # no deploy (per push: FIX-1359's ignoreCommand)
git commit -m "feat: description"           # deploys to prod
```

### Env Files
- `.env.local.dev` → local Supabase
- `.env.local.prod` → prod Supabase
- Copy to `.env.local` to activate

### Key Env Vars
```
NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
SUPABASE_PROJECT_REF=xsazcoxinpgttgquwvuf
ANTHROPIC_API_KEY / ANTHROPIC_ADMIN_API_KEY
ANTHROPIC_ORG_ID=439c7c52-18cd-4af4-b98d-817a1afa32b0
VERCEL_API_TOKEN (needs Pro plan for billing)
NEXT_PUBLIC_MAPBOX_TOKEN / CONGRESS_API_KEY / CRON_SECRET
CRON_DISABLED=true / SUPABASE_AVAILABLE=false (when paused)
NEXT_PUBLIC_ADMIN_KEY=civitics-admin / ADMIN_SECRET=civitics-admin
```

### Pipeline Commands
```powershell
pnpm --filter @civitics/data data:nightly            # full source + entity_connections rebuild
```

Entity connections are derived by the SQL function `rebuild_entity_connections()` invoked from the nightly orchestrator (see `packages/data/CLAUDE.md` § "Entity Connections Derivation"). The standalone TS `data:connections` script and `data:pac-classify` were removed during the post-cutover cleanup (FIX-111, FIX-187).

### Guardrails
- AI pipelines: 2h recency guard
- `generateStaticParams` returns `[]` everywhere
- No auto-refresh in dashboard

---

## 10. PENDING WORK (Prioritized)

### HIGH — Do Next
1. **Fix sunburst ring2** — API reads param but never uses it for sort order
2. **Fix sunburst shape/showLabels** — need to trigger re-render, not refetch
3. **Fix viz type button active state** — no visual indicator of selected viz
4. **Self-configuring settings** — derive options from loaded data metadata
5. **Unified search page** — `/search?q=...` (GlobalSearch "view all" goes nowhere)

### MEDIUM
6. **Upgrade Supabase Pro** ($25/mo) — when billing resets
7. **Upgrade Vercel Pro** ($20/mo) — after confirming bot traffic reduced
8. **Unpause prod Supabase** + re-enable cron jobs
9. **Official profile** — opponents section with real data
10. **Mobile layout fixes**
11. **Error/404 pages**

### PHASE 2 — Civic Profile
12. **Bill issue scoring pipeline** — AI tags each bill 0-1 per issue category
13. **Zip → representatives** — `/me` page entry point
14. **Alignment quiz** — 10 real bills, vote, reveal how rep voted
15. **Score card + sharing** — viral mechanic
16. **User accounts** — Supabase Auth (already configured, not used)
17. **Check-in notifications** — "Your rep voted against your priorities"

---

## 11. PHASE 2 VISION — "Your Seat at the Table"

### The YOU Node
Center of sunburst = the citizen. Three modes:
1. **Official Profile** — official at center, connections radiate out
2. **Group Profile** — group at center, aggregate connections
3. **YOUR Alignment Badge** — YOU at center, issue priorities in Ring 1, reps in Ring 2, donors in Ring 3

### The Civic Profile Quiz
- Show 10 real bills with AI plain-language summaries
- User votes: Yes / No / Abstain
- Reveal how their reps actually voted
- Generate alignment score per issue category
- Uses `ai_summary_cache` (already populated)

### The Alignment Badge
- Mini sunburst showing user's issue priorities
- Color = alignment with their reps (green/amber/red)
- Shareable: `civitics.com/score/[id]`
- Sizes: 32px (nav) → 200px (profile page)
- Shape: circle or octagon (civic seal aesthetic)

### Three User Types
- **Informed Citizen** — just wants data, no account needed
- **Engaged Citizen** — creates account, saves score, gets notifications
- **Active Citizen** — submits comments, contacts reps, organizes

### The Viral Loop
"My rep scores 31% on my priorities. What's yours?"
→ Everyone gets their own result
→ No partisan framing — just public data
→ Shareable card with mini sunburst

---

## 12. PROMPT WRITING GUIDE FOR CLAUDE CODE

### Always Start With
```
Read [file1]
Read [file2]
(check current state before writing any code)
```

### Prompt Structure That Works
```
[Context: what exists, what's broken]
[Diagnosis: root cause]

FIX 1 — [specific named fix]:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Exact change with before/after]
[Line references when known]

VERIFY:
  pnpm dev
  [specific test command]
  Expected: [exact output] ✓

[skip vercel] commit
Push to GitHub.
```

### What to Include
- Exact field names (V2 contract above)
- "Local only — no prod" for DB changes
- `supabase migration up --local` (never without --local)
- PowerShell test commands to verify
- TypeScript error check: `pnpm build`

### What NOT to Do
- Don't write prompts without reading current file state first
- Don't use `.in()` with large arrays — use RPC
- Don't touch `entity_id` — it's `entityId` (camelCase)
- Don't join `financial_relationships` to `financial_entities` with Supabase auto-join (no FK)
- Don't use `supabase migration up` without `--local`
- Don't add `primaryGroup` (object) to useEffect deps — use `primaryGroup?.id`

### PowerShell Gotchas
```powershell
# Path with [id] must be escaped:
Get-Content "apps\civitics\app\officials\``[id``]\page.tsx"

# JSON filter for API testing:
$filter = '{"entity_type":"official","chamber":"senate","party":"democrat"}'
$encoded = [System.Uri]::EscapeDataString($filter)

# Load env vars:
Get-Content "apps\civitics\.env.local" |
  Where-Object { $_ -match "^[^#].*=.*" } |
  ForEach-Object {
    $parts = $_ -split "=", 2
    [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
  }
```

---

## 13. GRANT APPLICATIONS (When Ready)

Target funders:
- **Knight Foundation** — civic tech, journalism tools
- **Mozilla Open Source Award** — privacy-respecting civic tools
- **Democracy Fund** — electoral accountability
- **MacArthur Foundation** — democracy/accountability

Pitch angle:
> "We give every American citizen a personalized civic accountability score, powered by public data and AI, showing exactly how well their representatives serve their actual interests — not their donors."

Key stats for grant apps:
- $1.75B in tracked donations
- 8,251 officials across federal and state
- 227,153 voting records
- Runs for less than a streaming subscription/month
- 100% public data, 0% partisan framing

---

*End of handoff document. Import this into new Claude sessions to restore context without re-reading the full conversation history.*
