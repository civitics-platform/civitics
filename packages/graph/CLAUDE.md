# packages/graph/CLAUDE.md

The rules for the connection graph that a session cannot read off the code.
The inventories are the code: `ls packages/graph/src` (components, hooks,
one file per viz), `visualizations/registry.ts` (`VIZ_REGISTRY`),
`connections.ts` (`CONNECTION_TYPE_REGISTRY`), `presets.ts`
(`BUILT_IN_PRESETS`), `groups.ts` (`BUILT_IN_GROUPS`), `types.ts` (`GraphView`,
`FocusEntity`, `MAX_FOCUS_ENTITIES`). The pre-haircut file, with the April 2026
build plan and the panel specs, is `docs/archive/claude-md-graph-2026-10-24.md`.

---

## The Critical Rule: Viz Switching Is Style-Only

Switching viz type sets `style.vizType` only.

`focus` and `connections` **NEVER change** on viz switch.

The user's entities, depth and connection filters persist when they switch from
Force → Chord → Treemap → Sunburst. The user's context is sacred — never throw
it away on a UI mode change. Never auto-switch the viz on the user either;
suggest it with a toast at most.

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

## Real-Time Wiring (CRITICAL)

Every panel control MUST drive the graph in real time. No "Apply" buttons. No
"Refresh". Every change is immediate.

Three categories of updates:

**Category A — Visual only (< 16ms):** no simulation restart. Update SVG
styles directly via D3 select — connection color, opacity and thickness, label
visibility, node highlight colors.

**Category B — Simulation restart (~200ms):** data already loaded. Restart the
simulation with new parameters — physics (charge, distance, gravity), layout
mode, node size encoding, adding or removing a connection TYPE.

**Category C — Re-fetch (~500-1000ms):** new data needed from the API. Show a
loading state on the affected nodes only — not a full graph reload. Adding or
removing a focus entity, a depth change for an entity.

**Rule:** Never reload the full graph when a partial update will do. Merge new
data into the existing graph state.

---

## Never build custom panel rows.

If you need a new panel element, it's a `TreeNode` (`components/TreeNode.tsx`)
with the appropriate variant and children.

---

## Connection Type Registry

Single source of truth for all connection types. Never hardcode these strings
anywhere in the codebase — always use `CONNECTION_TYPE_REGISTRY` keys
(`connections.ts`). The keys today: `donation`, `opposition`, `vote_yes`,
`vote_no`, `vote_abstain`, `nomination_vote_yes`, `nomination_vote_no`,
`oversight`, `co_sponsorship`, `appointment`, `revolving_door`,
`contract_award`, `alignment`.

- `opposition` (FIX-747) is `ie_oppose` super-PAC spend AGAINST a candidate, a
  distinct red/dashed edge. Support spend (`ie_support`) is folded into
  `donation`. Never merge the two.
- `nomination_vote_yes` / `nomination_vote_no` are VALID and DISTINCT from
  `vote_yes` / `vote_no`. They are derived from proposals with
  `vote_category = 'nomination'`. Show them in the UI as "Nomination Votes",
  separate from "Legislation Votes". Never merge them.
- The connection-type key for federal contract data is **`contract_award`**,
  not `contract`. Every API write path uses `contract_award`; viz registry
  `supportedConnectionTypes` and applicability checks must reference the same
  key (FIX-148 cleaned up entries that had drifted to `'contract'`).

---

## Interaction Contracts

Every viz type MUST implement both: a hover tooltip (`tooltip()` on its
`VIZ_REGISTRY` entry) and a click handler (`onNodeClick(node, actions)`), with
the popup rendered by the shared `components/NodePopup.tsx` through the
`NodeActions` interface so it stays viz-agnostic.

---

## Screenshot Contract

The screenshot button calls the active viz's registry entry: `GraphPage.tsx`
`handleScreenshot` runs that viz's `screenshotPrep()` (hide tooltips, reset zoom)
and `ScreenshotPanel` captures the viz's SVG. Each viz registers its own
`screenshotTarget` and optional `screenshotPrep`.

**Never put viz-specific screenshot logic in the header or the button
handler.** That logic belongs in the viz's registry entry.

### Watermark (always included, non-removable)
```
civitics.com/graph/[SHARE_CODE]
Data: [source list — FEC, Congress.gov, etc.]
Generated: [date]
```

The URL watermark is the single most strategically important feature in
this package. Every shared screenshot drives new users back to the
platform. It is non-removable by design (`apps/civitics/app/graph/ScreenshotPanel.tsx`).

---

## Presets and groups

A preset is a named `GraphView`. `BUILT_IN_PRESETS` (`presets.ts`) and
`BUILT_IN_GROUPS` (`groups.ts`) are authoritative. Each `presetId` and group id
is a stable handle that saved sessions reference: never renumber or drop one.

---

## Smart Graph Expansion Rules

`MAX_AUTO_EXPAND = 50` (`apps/civitics/app/api/graph/connections/route.ts`) — if
a neighbor has 50+ connections, it is collapsed. Show as a node with an orange
`[+]` badge. User must click then use "Expand."

`donation` neighbors are **never** auto-expanded: financial entities connect to
hundreds of officials. Follow the Money defaults to depth 1; depth 2 of
donations is an explicit manual opt-in — never automatic.

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

## API Field Name Contract

The graph uses V2 field names throughout. ALL API routes and hooks MUST
use these names — never the legacy V1 names.

**Nodes** (`GraphNode` from `packages/graph/src/types.ts`):
```
id             ← plain "type:uuid" composite key (e.g. "official:86328793-…")
name           ← NOT 'label'
type           ← NodeType from types.ts (e.g. "official", "agency", "pac")
collapsed      ← NOT 'metadata.collapsed'
connectionCount ← NOT 'metadata.connectionCount'
```

**Edges** (`GraphEdge` from `packages/graph/src/types.ts`):
```
fromId         ← NOT 'source'
toId           ← NOT 'target'
connectionType ← NOT 'type'
amountUsd      ← NOT 'amountCents'
strength
occurredAt
```

**API query params** (`/api/graph/connections`): `entityId` ← NOT `entity_id`.

**NodeType** — use the union in `types.ts`. `"governing_body"` does NOT exist
in V2. Map it to `"agency"`.

**Never use legacy V1 field names:**
```
✗ source, target       → use fromId, toId
✗ type on edges        → use connectionType
✗ label on nodes       → use name
✗ amountCents          → use amountUsd
✗ metadata.collapsed   → use collapsed directly
✗ entity_id param      → use entityId
✗ governing_body type  → use agency
✗ focus.entityId       → use focus.entities[] and addEntity/removeEntity
```

Any new API route or hook that touches graph data must import from
`@civitics/graph` using the V2 aliases:
```ts
import type {
  GraphNodeV2 as GraphNode,
  GraphEdgeV2 as GraphEdge,
  NodeTypeV2 as NodeType,
} from "@civitics/graph";
```
