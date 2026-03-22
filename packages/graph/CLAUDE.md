# packages/graph/CLAUDE.md

## Purpose
The connection graph is not a feature — it IS the core product of Civitics.
Every journalist who uses it to break a story, every citizen who shares a
screenshot, every researcher who embeds it is the mission made tangible.
Build it accordingly.

## The One Rule
The graph must be beautiful enough to screenshot, powerful enough to
investigate, simple enough for anyone, and deep enough for experts.

---

## The Three-Layer Model

Every graph state is a `GraphView`. This is the single source of truth
for all state — what entities are focused, which connections are visible,
and how they are rendered.

```ts
interface GraphView {
  // LAYER 1 — FOCUS
  // A SET of entities to explore.
  // Not one — a collection.
  // The graph shows all of them
  // plus their connections,
  // with shared connections
  // becoming visually prominent.
  focus: {
    entities: FocusEntity[]
    depth: 1 | 2 | 3
    scope: 'all' | 'federal'
      | 'state' | 'senate' | 'house'
    includeProcedural: boolean
  }

  // LAYER 2 — CONNECTIONS
  // Which relationships to show and how to weight/style them
  connections: {
    [connectionType: string]: {
      enabled: boolean
      color: string
      opacity: number      // 0–1
      thickness: number    // 0–1
      minAmount?: number   // donations only
      dateRange?: {
        start: string | null
        end: string | null
      }
    }
  }

  // LAYER 3 — STYLE
  // How to render the data
  style: {
    vizType: VizType
    // Viz-specific options live here, keyed by vizType.
    // Switching viz type preserves each viz's own settings.
    vizOptions: {
      force?: ForceOptions
      chord?: ChordOptions
      treemap?: TreemapOptions
      sunburst?: SunburstOptions
    }
  }

  // METADATA
  meta?: {
    name?: string        // if saved/preset
    isPreset?: boolean
    presetId?: string
    isDirty?: boolean    // modified from preset baseline
  }
}
```

### FocusEntity Interface

```ts
interface FocusEntity {
  id: string
  name: string
  type: 'official' | 'agency'
    | 'proposal' | 'financial'
  role?: string
  party?: string
  photoUrl?: string

  // Per-entity overrides
  depth?: 1 | 2 | 3
    // overrides global depth
    // for this entity only
  highlight?: boolean
    // render as larger node
    // default: true for all
    // focused entities
  pinned?: boolean
    // lock position in simulation
  color?: string
    // custom highlight ring color
}
```

### Focus Operations (useGraphView)

```ts
// Focus operations
addEntity(entity: FocusEntity)
  // Fetch connections for entity
  // Merge into existing graph
  // Show loading ring on new node
  // Does NOT clear existing focus

removeEntity(id: string)
  // Remove node from graph
  // Remove orphaned edges
  // Keep edges shared with
  //   other focused entities

updateEntity(
  id: string,
  options: Partial<FocusEntity>
)
  // Update per-entity options
  // If depth changes: re-fetch
  // Otherwise: visual update only

clearFocus()
  // Remove all entities
  // Empty graph state
```

### The Critical Rule: Viz Switching Is Style-Only

Switching viz type sets `style.vizType` only.

`focus` and `connections` **NEVER change** on viz switch.

The user's entities, depth, scope, and connection filters persist when they
switch from Force → Chord → Treemap → Sunburst. The user's context is
sacred — never throw it away on a UI mode change.

---

## Technology

- **D3 force simulation — non-negotiable.** Never replace with React Flow
  or Cytoscape.
- The organic force clustering IS the analysis — dense clusters reveal
  entanglement.
- Bridge nodes reveal hidden connections — this insight only exists with
  real force simulation.
- WebGL upgrade path (Sigma.js/Pixi.js) when graphs exceed 500 nodes —
  Phase 3+.

---

## File Structure (Target Architecture)

```
packages/graph/src/
  types.ts            ← add FocusEntity,
                         FocusOperations
  registry.ts         ← VIZ_REGISTRY
  connections.ts      ← CONNECTION_TYPE_REGISTRY
  presets.ts          ← built-in presets

  hooks/
    useGraphView.ts   ← GraphView state
                         add/remove entity ops
    useEntitySearch.ts ← NEW: debounced
                         entity search hook
    useGraphData.ts   ← NEW: fetch + merge
                         graph data for
                         focus entity set

  components/
    -- Panels (NEW architecture):
    DataExplorerPanel.tsx  ← left panel
    GraphConfigPanel.tsx   ← right panel
    TreeNode.tsx           ← core primitive

    -- Panel sections (NEW):
    FocusTree.tsx          ← focus section
    ConnectionsTree.tsx    ← connections section
    EntitySearchInput.tsx  ← search + results
    EntityBrowse.tsx       ← browse by category
    ConnectionStyleRow.tsx ← per-type styling

    -- Shared (existing, keep):
    GraphHeader.tsx     ← top bar
    NodePopup.tsx       ← click popup
    Tooltip.tsx         ← hover tooltip

    -- OLD (to be removed):
    SettingsPanel.tsx   ← REPLACE with
                          DataExplorerPanel
                          + GraphConfigPanel
    FocusSection.tsx    ← REPLACE with
                          FocusTree
    ConnectionsSection.tsx ← REPLACE with
                          ConnectionsTree
    StyleSection.tsx    ← REPLACE with
                          GraphConfigPanel

  visualizations/
    ForceGraph.tsx      ← update to accept
                          entities[] not entityId
    ChordGraph.tsx
    TreemapGraph.tsx
    SunburstGraph.tsx
```

**Current state (as of March 2026):** Components still live flat in `src/`.
The `components/` subdirectory and the new panel architecture are being
built toward. Do not move files until the new components exist.

---

## Current State & Migration

### Existing Files in `packages/graph/src/`

| File | What it does | Status |
|---|---|---|
| `index.ts` | Barrel exports + inline type definitions: `NodeType`, `EdgeType`, `GraphNode`, `GraphEdge`, `NODE_COLORS`, `PARTY_COLORS`, `EDGE_COLORS`, `edgeWidth()`, `VisualConfig`, `DEFAULT_VISUAL_CONFIG`, `EntitySearchResult` | **MIGRATE** — type defs move to `types.ts`; constants and `edgeWidth` move to `types.ts` or remain; barrel stays but is updated |
| `ForceGraph.tsx` | Full D3 force simulation with drag, zoom, hover highlight, collapsed-node badges, arrowhead markers, drop-shadow filter, label rendering. Works well. | **MIGRATE** → `visualizations/ForceGraph.tsx`; add `screenshotTarget`, `tooltip`, `onNodeClick` registry entry |
| `ChordGraph.tsx` | Chord diagram that fetches `/api/graph/chord`, **already expands** the rectangular industry×party matrix to NxN square before calling `d3.chord()`. Tooltip on arcs and ribbons. Resize observer. | **MIGRATE** → `visualizations/ChordGraph.tsx`; the N×N matrix expansion is already correct (see Chord Fix note below) |
| `TreemapGraph.tsx` | D3 treemap grouped by party, sized by `total_donated_cents`. Hover tooltip, legend, resize observer. | **MIGRATE** → `visualizations/TreemapGraph.tsx` |
| `SunburstGraph.tsx` | D3 partition sunburst with click-to-zoom, breadcrumb trail, resize observer. Requires `entityId` prop. | **MIGRATE** → `visualizations/SunburstGraph.tsx` |
| `GraphSidebar.tsx` | Left sidebar with 6 collapsible sections: Visualization picker, Focus (entity search + depth + compare + path finder), Filters (pills + strength slider + industry filter), Appearance (node/edge encoding + theme), Presets, Export. Also contains `PRESETS` and `PRESET_ORDER` constants and inline `SidebarEntitySearch`. | **REPLACE** — replaced entirely by `SettingsPanel.tsx` + `GraphHeader.tsx`; preset data migrates to `presets.ts`; entity search logic migrates to `FocusSection.tsx` |
| `CustomizePanel.tsx` | Floating overlay panel for node size, node color, edge thickness, layout, theme. Duplicates the Appearance section of `GraphSidebar.tsx`. | **DELETE** — functionality absorbed into `StyleSection.tsx` |
| `CollapsiblePanel.tsx` | Generic collapsible section with header button and localStorage persistence. Clean, reusable. | **KEEP** — used by `SettingsPanel.tsx` sections |
| `FilterPills.tsx` | Pill-style connection type toggles. Hardcodes `PILL_CONFIG` array with type strings and colors. | **REPLACE** — replaced by `ConnectionsSection.tsx` which reads from `CONNECTION_TYPE_REGISTRY`; never hardcode type strings again |
| `EntitySelector.tsx` | Full-width entity search with categorized dropdown results (Officials / Agencies / Proposals / Donors). Debounced, with party color dots. | **MIGRATE** — logic and UX migrate into `FocusSection.tsx`; this standalone component deleted once migrated |
| `DepthControl.tsx` | Simple 1–5 depth button group with tooltips. | **MIGRATE** — migrates into `FocusSection.tsx`; deleted once migrated |
| `PathFinder.tsx` | BFS path finder UI: two entity search boxes + "Find shortest path" button. POSTs to `/api/graph/pathfinder`. Clean, standalone. | **KEEP** — remains as a standalone component; referenced from `FocusSection.tsx` |
| `AiNarrative.tsx` | Floating overlay panel; POSTs to `/api/graph/narrative`, shows streaming text, copy button, regenerate, disclaimer. Auto-generates on open. | **KEEP** — independent overlay; not part of the settings panel |
| `EmbedModal.tsx` | Modal that generates `<iframe>` embed code from a share code. Size presets + custom dimensions + copy button. | **KEEP** — independent modal |
| `visualizations/registry.ts` | `VIZ_REGISTRY` array with `id`, `label`, `civicQuestion`, `description`, `status`, `icon` for 4 viz types. | **MIGRATE** — extend each entry with `component`, `requiresEntity`, `supportedConnectionTypes`, `defaultOptions`, `screenshotTarget`, `screenshotPrep`, `tooltip`, `onNodeClick` |

---

### Stage 1 (Build Now) — COMPLETE ✓

All Stage 1 items are done as of G1–G3 (March 2026).

```
[x] types.ts
[x] connections.ts
[x] components/GraphHeader.tsx — with ✨ Explain button (opens AiNarrative)
[x] components/DataExplorerPanel.tsx — replaces SettingsPanel left column
[x] components/GraphConfigPanel.tsx — replaces SettingsPanel right column
[x] components/TreeNode.tsx — core panel primitive
[x] components/FocusTree.tsx — with PathFinder collapsible section
[x] components/ConnectionsTree.tsx
[x] components/EntitySearchInput.tsx
[x] components/EntityBrowse.tsx
[x] components/ConnectionStyleRow.tsx
[x] components/NodePopup.tsx
[x] components/Tooltip.tsx
[x] visualizations/registry.ts — all 4 viz entries complete
[x] visualizations/ForceGraph.tsx — new ForceGraph with useGraphData props
[x] hooks/useGraphView.ts
[x] hooks/useGraphData.ts — multi-entity merge, incremental fetch
[x] hooks/useEntitySearch.ts
[x] Multi-entity focus (entities[]) — addEntity/removeEntity/updateEntity
[x] Category A real-time wiring — connection styles, focus highlight, labels, loading ring
[x] Category B real-time wiring — physics charge/linkDistance/gravity, layout, node size
[x] Category C real-time wiring — nodes/edges from useGraphData, position preservation
[x] Shared edge highlighting — edges between two focused entities are 2× thick
[x] Old components removed — GraphSidebar, SettingsPanel, FocusSection,
      ConnectionsSection, StyleSection, CustomizePanel, FilterPills,
      EntitySelector, DepthControl all deleted
[x] PathFinder in FocusTree — collapsible section
[x] AiNarrative in GraphHeader — ✨ Explain button
```

---

### Stage 2 (After Launch)

```
[ ] User-saved custom views stored per-user in DB
[ ] Share URL encodes full GraphView (not just entity ID)
[ ] Community preset library (browseable public presets)
[ ] Draggable/resizable SettingsPanel (currently fixed position)
[ ] Timeline viz
[ ] Sankey viz
[ ] Geographic map viz
[ ] Collaboration / investigation rooms
[ ] Annotations layer
```

---

### Chord Diagram Fix Required

`d3.chord()` requires a square N×N matrix. Our API returns a rectangular
`M×P` matrix (M industries → P party groups), which is **not** square.

**The fix is already implemented in `ChordGraph.tsx` (lines 215–226).**
The code expands the rectangular matrix to a square N×N matrix where:
- Industries flow TO party slots (forward direction)
- Party slots mirror back to industries (symmetric, so `d3.chord()` renders arcs on both sides)
- Industries never flow to other industries
- Parties never flow to each other

```ts
const N = groups.length + recipients.length  // e.g. 13 + 4 = 17
const square: number[][] = Array.from({ length: N }, () => Array(N).fill(0))

rawMatrix.forEach((row, i) => {
  row.forEach((val, j) => {
    const partyIdx = groups.length + j
    square[i][partyIdx] = val      // industry → party
    square[partyIdx][i] = val      // party → industry (symmetric)
  })
})
```

Industry group arcs: indices `0` to `groups.length - 1`
Party group arcs: indices `groups.length` to `N - 1`

Colors:
- Industries: use `INDUSTRY_COLORS` array (already in `ChordGraph.tsx`)
- Democrat groups (`dem_senate`, `dem_house`): `#2563eb`
- Republican groups (`rep_senate`, `rep_house`): `#dc2626`

**No code changes needed for the matrix logic.** The only pending fix is
adding `id="chord-svg"` to the SVG element for screenshot targeting.

---

### Settings Panel UX

The panel:
- Starts **docked to bottom-left** of the graph canvas
- **Collapsed by default** — shows as a small pill: `[⚙ Settings ▾]`
- Click pill to expand
- When expanded: shows all 3 sections, each individually collapsible
- Width: `280px` fixed
- Height: `auto`, max `80vh` with internal scroll
- On mobile: full-width sheet from bottom

**Do NOT make it draggable in Stage 1** — fixed position is fine.
Add drag in Stage 2 once the panel content is stable.

---

## The Viz Registry

Every viz type is defined exactly once in `registry.ts`. Adding a new viz
requires only one new entry — nothing else in the codebase changes.

```ts
interface VizDefinition {
  id: VizType
  label: string
  icon: string                    // inline SVG path string
  group: 'standard' | 'coming_soon' | 'custom'
  description: string
  civicQuestion: string           // "Which industries fund which groups?"

  // The React component that renders this viz
  component: React.ComponentType<VizProps>

  // Does this viz require a focused entity?
  // true  = needs focus.entities (force, sunburst)
  // false = works globally without one (chord, treemap)
  requiresEntity: boolean

  // Which connection types this viz can display.
  // force: all types
  // chord: donation only
  // treemap: donation only
  // sunburst: all types
  supportedConnectionTypes: string[]

  // Default values for this viz's style options.
  // Auto-populates GraphView.style.vizOptions[id].
  defaultOptions: Record<string, any>

  // Screenshot target: CSS selector for the element to capture.
  // e.g. '#chord-svg', '#force-canvas'
  screenshotTarget: string

  // Called before capture: hide tooltips, reset zoom, etc.
  screenshotPrep?: () => void

  // Tooltip rendered on node/arc/cell hover.
  tooltip: (node: GraphNode) => React.ReactNode

  // Called on node/arc/cell click.
  // Receives NodeActions so the popup stays viz-agnostic.
  onNodeClick: (node: GraphNode, actions: NodeActions) => void
}

interface NodeActions {
  recenter: (nodeId: string) => void      // force only
  openProfile: (nodeId: string) => void   // all viz types
  addToComparison: (nodeId: string) => void // force only
  expandNode: (nodeId: string) => void    // force only
}
```

---

## The Settings Panel

Three collapsible sections. This is the **only** settings UI.
The old `GraphSidebar.tsx` / `CustomizePanel.tsx` pattern is being
replaced by `SettingsPanel.tsx`.

### Section 1 — FOCUS
Always the same regardless of viz type.
Controls: `GraphView.focus.*`

- Entity search / selector
- Depth (1 / 2 / 3)
- Scope filter (all / federal / state / senate / house)
- Time range (future)

### Section 2 — CONNECTIONS
Always the same regardless of viz type.
Controls: `GraphView.connections.*`

One row per connection type from `CONNECTION_TYPE_REGISTRY`:
```
[✓] checkbox  label           [━━] thickness slider
[■] color     [░░░] opacity   (min amount if type=donation)
```

**Never hardcode connection type names in the UI.** Always render from
`CONNECTION_TYPE_REGISTRY` keys.

### Section 3 — STYLE
Changes dynamically based on the active viz type.
Controls: `GraphView.style.vizOptions[activeVizType]`

Content is defined by each viz's `defaultOptions` in `VIZ_REGISTRY`.
The panel renders whatever options that viz declares.

**Never put viz-specific settings code outside of that viz's registry
entry and component file.**

### Panel Footer
```
[💾 Save as preset]   [↗ Share]
```
If view is a loaded preset and `meta.isDirty = true`:
```
[💾 Save changes]     [↗ Share]
```

---

## Panel Layout

The graph uses a three-column
layout: left panel, canvas,
right panel.
```
┌──────────┬──────────────────┬─────────┐
│  DATA    │                  │ GRAPH   │
│ EXPLORER │   GRAPH CANVAS   │ CONFIG  │
│          │                  │         │
│ 260px    │   flex-1         │ 220px   │
│ LEFT     │                  │ RIGHT   │
└──────────┴──────────────────┴─────────┘
```

### Left Panel — Data Explorer
File: `components/DataExplorerPanel.tsx`
Width: 260px, collapsible to 40px icon strip
Purpose: WHAT data is on the graph

Contains two main tree sections:

**FOCUS tree:**
- Active entities list
  (each with per-entity options)
- Search to add entities
- Browse by category

**CONNECTIONS tree:**
- Active connection types
  (each with style controls)
- Available types to add

### Right Panel — Graph Config
File: `components/GraphConfigPanel.tsx`
Width: 220px, collapsible to 40px icon strip
Purpose: HOW the graph looks and behaves

Contains:
- Viz type dropdown
- Presets
- Type-specific settings
  (changes per active viz type)
- Display settings
  (labels, node size, animation)

### Canvas
Takes all remaining horizontal space.
Tooltips, node popups, and the
watermark float inside the canvas.

### Collapse Behavior
Both panels collapse to a 40px
icon strip showing section icons.
Keyboard: [ to toggle left panel
           ] to toggle right panel
Mobile: both panels become
  bottom drawers, canvas is full screen

### Real-Time Wiring (CRITICAL)
Every panel control MUST drive
the graph in real time.
No "Apply" buttons. No "Refresh".
Every change is immediate.

Three categories of updates:

**Category A — Visual only (< 16ms):**
No simulation restart. Update
SVG styles directly via D3 select.
  - Connection color
  - Connection opacity
  - Connection thickness
  - Label visibility
  - Node highlight colors

**Category B — Simulation restart (~200ms):**
Data already loaded. Restart
simulation with new parameters.
  - Physics: charge, distance, gravity
  - Layout mode change
  - Node size encoding change
  - Add/remove connection TYPE

**Category C — Re-fetch (~500-1000ms):**
New data needed from API.
Show loading state on affected
nodes only — not full graph reload.
  - Add entity to focus
  - Remove entity from focus
  - Depth change for entity
  - Scope filter change

**Rule:** Never reload the full
graph when a partial update
will do. Merge new data into
existing graph state.

---

## TreeNode — The Core UI Primitive

Both panels are built entirely
from one recursive component:
`components/TreeNode.tsx`

Every row in both panels is a
TreeNode. This ensures complete
visual consistency across the
entire panel UI.
```ts
interface TreeNodeProps {
  // Content
  label: string | ReactNode
  icon?: string | ReactNode
  count?: number        // badge

  // Expand/collapse
  defaultExpanded?: boolean
  expanded?: boolean    // controlled
  onExpandChange?: (v: boolean)
    => void
  collapsible?: boolean // default true

  // State indicators
  active?: boolean      // has content
  loading?: boolean     // fetching
  dirty?: boolean       // modified

  // Right side actions
  // Appear on hover
  actions?: Array<{
    icon: string
    label: string        // tooltip
    onClick: () => void
  }>

  // Appearance
  depth?: number         // auto-set
  variant?: 'section'   // bold header
    | 'item'             // normal row
    | 'entity'           // with avatar
    | 'connection'       // color dot

  children?: ReactNode
}
```

### Visual Rules
- Indent: `depth * 12px` padding-left
- Max depth: 4 (redesign if exceeded)
- `variant="section"`: font-semibold,
  slightly larger, separator above
- `variant="entity"`: shows party
  color ring around avatar
- `variant="connection"`: shows
  colored dot from CONNECTION_TYPE_REGISTRY
- Actions: hidden by default,
  appear on row hover
- Count badge: gray pill, right of label

### Never build custom panel rows.
If you need a new panel element,
it's a TreeNode with appropriate
variant and children.

---

## The Viz Dropdown

Lives in the fixed `GraphHeader.tsx` bar. **Not** inside the settings panel.

Renders from `VIZ_REGISTRY`, grouped by `entry.group`:
```
─── Standard ───
⬡  Force Graph
◎  Chord Diagram
▦  Treemap
◉  Sunburst
─── Coming Soon ───
↔  Timeline
─── Custom ───
   [user saved views]
   + Create new view
```

Selecting a viz:
- Sets `style.vizType`
- Does NOT change `focus`
- Does NOT change `connections`
- Updates the Style section in the settings panel

---

## Connection Type Registry

Single source of truth for all connection types. Never hardcode these
strings anywhere in the codebase — always use `CONNECTION_TYPE_REGISTRY`
keys.

```ts
const CONNECTION_TYPE_REGISTRY = {
  donation: {
    label: 'Donations',
    icon: '💰',
    color: '#f59e0b',
    description: 'PAC and individual donor contributions',
    hasAmount: true,
  },
  vote_yes: {
    label: 'Voted Yes',
    icon: '✓',
    color: '#22c55e',
    description: 'Affirmative votes on legislation',
    hasAmount: false,
  },
  vote_no: {
    label: 'Voted No',
    icon: '✗',
    color: '#ef4444',
    description: 'Negative votes on legislation',
    hasAmount: false,
  },
  vote_abstain: {
    label: 'Abstained',
    icon: '○',
    color: '#94a3b8',
    description: 'Present / not voting',
    hasAmount: false,
  },
  nomination_vote_yes: {
    label: 'Confirmed',
    icon: '⭐',
    color: '#8b5cf6',
    description: 'Voted to confirm nomination',
    hasAmount: false,
  },
  nomination_vote_no: {
    label: 'Rejected',
    icon: '✗',
    color: '#ec4899',
    description: 'Voted against confirmation',
    hasAmount: false,
  },
  oversight: {
    label: 'Oversight',
    icon: '👁',
    color: '#06b6d4',
    description: 'Committee oversight relationships',
    hasAmount: false,
  },
  co_sponsorship: {
    label: 'Co-Sponsored',
    icon: '🤝',
    color: '#84cc16',
    description: 'Bill co-sponsorship',
    hasAmount: false,
  },
}
```

Note: `nomination_vote_yes` / `nomination_vote_no` are VALID and DISTINCT
from `vote_yes` / `vote_no`. They are derived from proposals with
`vote_category = 'nomination'`. Show in UI as "Nomination Votes" —
separate from "Legislation Votes". Never merge them.

---

## Interaction Contracts

Every viz type MUST implement both contracts below. No exceptions.

### Tooltip (hover)
- Appears on hover of any node, arc, cell, or edge
- Implemented per viz in `VIZ_REGISTRY.tooltip()`

Standard tooltip fields:
```
[name — bold]
[subtitle: role / type]
─────────────────────
[key stat 1]
[key stat 2]
[key stat 3]  (2–3 max)
[hint: "Click for more"]
```

### Click Popup
- Implemented per viz in `VIZ_REGISTRY.onNodeClick()`
- Rendered by the shared `NodePopup.tsx` component
- Each viz passes its node data through the `NodeActions` interface

Standard popup content:
```
[Name]  [Party badge]
[Role · Jurisdiction]
─────────────────────
[key stat 1]
[key stat 2]
─────────────────────
[⊙ Recenter]    (force only)
[↗ View profile] (all)
[+ Compare]     (force only)
```

---

## Screenshot Contract

Screenshot button in `GraphHeader.tsx` calls the active viz's definition:

```ts
const vizDef = VIZ_REGISTRY[activeVizType]

if (vizDef.screenshotPrep) {
  vizDef.screenshotPrep()
}

html2canvas(document.querySelector(vizDef.screenshotTarget))
```

Each viz registers its own `screenshotTarget` selector and optional
`screenshotPrep` callback.

**Never hardcode a specific viz's selector in the screenshot button handler.**
That logic belongs in the viz's registry entry.

### Watermark (always included, non-removable)
```
civitics.com/graph/[SHARE_CODE]
Data: [source list — FEC, Congress.gov, etc.]
Generated: [date]
```

The URL watermark is the single most strategically important feature in
this package. Every shared screenshot drives new users back to the
platform. It is non-removable by design.

---

## Presets

A preset is a named `GraphView`. Nothing more, nothing less.

Built-in presets live in `packages/graph/src/presets.ts`. Each is a
complete `GraphView` object with `meta.isPreset = true`.

Loading a preset replaces the entire `GraphView` state with preset values.

Modifying any value after loading sets `meta.isDirty = true` and shows
`[💾 Save changes]` in the panel footer.

User-saved presets: stored in localStorage for now. Future: per-user DB.

### Built-in Presets (never remove these)

| Preset | Connections | Focus |
|---|---|---|
| Follow the Money | donation | depth 1 default |
| Votes and Bills | vote_yes, vote_no, co_sponsorship | hide_procedural |
| The Revolving Door | revolving_door, appointment | — |
| Committee Power | oversight, appointment | — |
| Industry Capture | donation, oversight, revolving_door | — |
| Co-Sponsor Network | co_sponsorship, vote_yes | — |
| Nominations | nomination_vote_yes, nomination_vote_no | — |
| Full Record | all | include_procedural=true |
| Full Picture | all | include_procedural=false |
| Clean View | all | minStrength=0.7, verifiedOnly=true |

---

## Node Visual Language

### Shapes (never change — visual consistency matters)
| Entity | Shape |
|---|---|
| Official | Circle (photo or initials) |
| Agency | Rounded rectangle |
| Proposal/Bill | Document rectangle (folded corner) |
| Financial | Diamond |
| Organization | Hexagon |
| Court | Scale/balance icon |
| Corporation | Square with rounded corners |

### Node Size (default: connection count)
```
radius = base + Math.sqrt(connectionCount) * 2

Base sizes:
  Official:   24px
  Agency:     20px
  Proposal:   18px
  Financial:  16px
```

User can change size encoding to: `connection_count` (default),
`donation_total`, `votes_cast`, `bills_sponsored`, `years_in_office`,
`uniform`.

### Node Color (default: entity type)
```
Official borders:
  Democrat:     #2563eb
  Republican:   #dc2626
  Independent:  #7c3aed
  Other:        #d97706
Agency:         #6b7280
Proposal:       #f59e0b
Financial:      #16a34a
Corporation:    #0891b2
```

---

## Edge Visual Language

### Thickness
Donation edges: `Math.max(1, Math.log10(amountCents / 100000))`
All other edges: 2px uniform

### Opacity
Opacity = connection strength (0.3 minimum). Weak connections fade.

---

## Multi-Entity Focus Behavior

When multiple entities are focused:

**Node rendering:**
- All focused entities render
  as larger nodes (1.5× default size)
- Each gets a colored highlight ring
  (blue for Democrat, red for
  Republican, purple for Independent)
- Focused nodes are pinned to
  a loose center cluster —
  they stay roughly central
  but simulation still moves them

**Edge rendering:**
- Edges SHARED between two or
  more focused entities render
  thicker and more opaque
  — these are the "entanglement" edges
  — most analytically interesting
- Edges unique to one entity
  render at normal weight

**Example:**
  Focus: Warren + Cruz

  Shared donor → both get
  thick amber edge → visually pops

  "INDIVIDUAL CONTRIBUTORS gave
   money to BOTH Warren AND Cruz"
  → This is a civic insight
  → The graph makes it obvious

**Loading behavior:**
  When adding entity N to focus:
  - Existing graph stays visible
  - New entity node appears with
    loading spinner ring
  - Connections load and merge in
  - Spinner disappears
  - Simulation gently re-settles

  Never blank the graph to load.
  Always merge incrementally.

**MAX_FOCUS_ENTITIES = 5**
  Beyond 5 the graph becomes
  unreadable. Show a warning
  at 4 and block at 5.
  "Maximum 5 entities in focus.
   Remove one to add another."

---

## Smart Graph Expansion Rules

`MAX_AUTO_EXPAND = 50` — if a neighbor has 50+ connections, it is
collapsed. Show as a node with an orange `[+]` badge. User must click
then use "Expand."

Per connection type at depth 2:
- `vote_yes` / `vote_no` — auto-expand (proposals have bounded voter counts)
- `oversight` — auto-expand (agencies have bounded connections)
- `revolving_door` / `appointment` — auto-expand (bounded by career history)
- `donation` — **NEVER auto-expand** (financial entities connect to hundreds)

Node count warnings:
- < 200: render freely
- 200–500: amber warning bar
- 500–1000: orange warning + "Apply strength ≥ 0.5" suggestion
- 1000+: red warning + auto-apply strength 0.5 (one-shot only)

Follow the Money preset defaults to depth 1. Depth 2 of donations is an
explicit manual opt-in — never automatic.

**Never freeze the browser. Never hide data. Warn and let the user decide.**

---

## Strength Filter

Always client-side — never a server query parameter. All connections are
fetched once; the user filters locally. Default threshold: 0.0 (never
hide data by default).

Donation strength bands:
- 0.0–0.3 = under $10k
- 0.3–0.5 = $10k–$100k
- 0.5–0.7 = $100k–$500k
- 0.7–1.0 = over $500k

Votes and oversight: always 1.0 (binary — happened or didn't).

---

## Force Simulation Parameters

```
charge strength:  -300 - (connectionCount * 50)
link distance:    150 - (strength * 100)
link strength:    strength * 0.5
collision radius: nodeRadius + 10
center force:     width/2, height/2
alpha decay:      0.0228 (D3 default)
velocity decay:   0.4
```

Layout options: `force_directed` (default), `radial`, `hierarchical`,
`circular`.

---

## Performance Rules

| Node count | Rendering |
|---|---|
| < 100 | Standard SVG |
| 100–500 | Optimize with canvas |
| 500+ | WebGL via Sigma.js (Phase 3) |

- Debounce filter changes 150ms
- Cache fetched connections per entity — never re-fetch if in state
- Freeze simulation when not visible
- `requestAnimationFrame` for all animation
- Never block the UI during simulation settling

---

## Graph State Serialization (Share Codes)

```json
{
  "version": "2.0",
  "view": { /* full GraphView object */ }
}
```

Share codes stored in `graph_snapshots` table:
```
code   TEXT — format: CIV-XXXX-XXXX
state  JSONB — full serialized GraphView
```

URL pattern: `civitics.com/graph/CIV-X7K2-WARREN`

---

## Database Tables

```sql
-- Share codes
graph_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  state JSONB NOT NULL,
  title TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  view_count INTEGER DEFAULT 0,
  is_public BOOLEAN DEFAULT true
)

-- Community presets
graph_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL,
  use_count INTEGER DEFAULT 0,
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

-- Annotations (Phase 2)
graph_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID REFERENCES graph_snapshots(id),
  entity_id UUID,
  entity_type TEXT,
  note TEXT NOT NULL,
  visibility TEXT DEFAULT 'private',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

---

## AI Narrative

Model: `claude-haiku-4-5-20251001` (~$0.0003/generation)
Costs 1 civic credit. Results cached per graph state hash.
`POST /api/graph/narrative`
Always show disclaimer: "AI-generated summary. Always verify against source data."

---

## Path Finder

BFS server-side via PostgreSQL recursive CTE (`find_entity_path` RPC).
Max 4 hops. `POST /api/graph/pathfinder` with `{ from_id, to_id, max_hops: 4 }`.
Results highlighted on viz (Phase 2+).

---

## Embed Mode

`/graph/embed/[code]` — minimal chrome, watermark required, always.

---

## Default View (No Entity Selected)

Show the top 10 most connected officials and all their direct connections.
Show a persistent hint: "Select any official to explore their full network."

---

## What Not To Do

```
✗ Don't add viz-specific settings outside of that viz's registry
  entry and component file

✗ Don't hardcode connection type strings anywhere —
  always use CONNECTION_TYPE_REGISTRY keys

✗ Don't add new panels following the old GraphSidebar/CustomizePanel
  pattern — the old sidebar is being replaced by SettingsPanel.tsx

✗ Don't change Focus or Connections state when the user switches viz type

✗ Don't put screenshot logic in the header component —
  it belongs in each viz's registry entry and screenshotPrep callback

✗ Don't make the Style section content static —
  it must render from the active viz's registry entry

✗ Don't use React Flow — D3 force simulation only

✗ Don't make the screenshot watermark removable

✗ Don't auto-play the timeline on page load

✗ Don't fetch all connections at once for large entities —
  paginate and expand on demand

✗ Don't re-fetch connections already loaded in graph state

✗ Don't block the UI during simulation settling

✗ Don't use more than 6 colors in a single graph view

✗ Don't skip loading skeleton states

✗ Don't store full document text in graph state —
  store IDs and fetch on demand

✗ Don't use focus.entityId —
  it no longer exists.
  Always use focus.entities[]
  and addEntity/removeEntity ops

✗ Don't build custom panel rows —
  always use TreeNode component

✗ Don't restart the simulation
  for Category A visual changes —
  update SVG styles directly

✗ Don't reload the full graph
  when adding one entity —
  merge new data into existing
  graph state

✗ Don't show "Apply" or
  "Refresh" buttons anywhere
  in the panels — all changes
  are real-time and immediate

✗ Don't collapse both panels
  at the same time by default —
  left panel starts open,
  right panel starts collapsed
```

---

## The North Star

Every feature in this package should answer yes to one question:

> "Does this help a citizen, journalist, or researcher see a connection
> they couldn't see before?"

If yes — build it. If no — don't.
