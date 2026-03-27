# Civitics Platform — Architecture Reference

Technical architecture reference. Explains what was built, why each decision was made, and how the pieces fit together.
Last updated: 2026-03-26.

---

## Mission

Civitics is civic accountability infrastructure — "Wikipedia meets Bloomberg Terminal for democracy." It aggregates public data on officials, votes, campaign donations, regulations, and judicial appointments, then maps the relationships between them into a navigable connection graph. The goal: make democratic accountability a daily practice, not a specialist skill. Every senator's donor list, every vote on every bill, every regulation open for public comment — searchable, visualized, and connected in plain sight. Democracy with receipts.

---

## System Overview

```
                         ┌─────────────────┐
    User browser ──────► │   Cloudflare    │  Bot Fight Mode ON
                         │   (proxy + WAF) │  Orange cloud proxy
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │     Vercel      │  Next.js App Router
                         │  (Next.js app)  │  Serverless functions
                         └────────┬────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
    ┌─────────▼────────┐  ┌───────▼──────┐  ┌────────▼────────┐
    │    Supabase      │  │ Anthropic API │  │    Mapbox       │
    │   (Postgres)     │  │  (Claude AI)  │  │  (map tiles)    │
    │  project ID:     │  │  Haiku model  │  │                 │
    │ xsazcoxinpgttg.. │  │  ~$0.60/mo    │  │                 │
    └──────────────────┘  └──────────────┘  └─────────────────┘
              │
    ┌─────────▼────────┐
    │  Cloudflare R2   │
    │   (storage)      │
    │  zero egress     │
    │  civitics-docs   │
    │  civitics-cache  │
    └──────────────────┘

    Nightly at 2:00 AM UTC (Vercel Cron):
    ┌────────────────────────────────────────────────┐
    │  /api/cron/nightly-sync                        │
    │    → Congress.gov API   → officials + votes    │
    │    → Regulations.gov    → proposals            │
    │    → FEC bulk downloads → financial data       │
    │    → USASpending.gov    → spending records     │
    │    → CourtListener      → judges               │
    │    → OpenStates         → state legislators    │
    │    → connections pipeline → entity_connections │
    │    → rule-based tagger  → entity_tags          │
    │    → AI tagger (Haiku)  → entity_tags          │
    └────────────────────────────────────────────────┘
```

---

## Monorepo Structure

```
/apps
  /civitics       Next.js civic governance app (the primary product)
                  Active dir: apps/civitics/app/
                  INACTIVE:   apps/civitics/src/app/ (silently ignored — never edit here)
  /social         Future social/COMMONS app (scaffold only)

/packages
  /ui             Shared React component library
                  Pure React only — no Next.js, no Supabase deps
                  Used by apps/civitics; future apps/social
  /db             Supabase client wrappers, TypeScript types, storage utilities
                  All Supabase imports go through @civitics/db — never @supabase/supabase-js directly
  /data           Data ingestion pipelines (Node.js scripts, not part of Next.js build)
  /graph          D3 force simulation — the connection graph visualization
                  Core product, not a feature
  /ai             Claude API service layer, cost gating, caching
  /maps           Mapbox GL + Deck.gl utilities
  /blockchain     ERC-4337, Biconomy, Optimism (Phase 4 — mostly scaffold)
  /auth           Supabase Auth + Privy (Phase 4) integration
  /config         Shared ESLint, TypeScript, Tailwind configurations
```

**Why monorepo:** Shared TypeScript types flow between packages without duplication. `packages/ui` serves all future apps. Single `pnpm build` command builds and type-checks the entire platform. Turborepo handles build caching and parallel execution.

---

## Data Model

### Core Table Relationships

```
officials ──────────────────── votes ──────── proposals
    │                                              │
    │ (via financial_relationships)                │ (via entity_connections)
    │                                              │
financial_entities ────────────────────────────────
    │
    └── entity_connections (THE GRAPH)
            from_id / from_type
            to_id   / to_type
            connection_type
            strength (0.0 – 1.0)
            amount_cents (nullable)
            occurred_at (nullable)
            is_verified
            evidence (JSONB array of source URLs)

officials ──── entity_tags (AI + rule-based classification)
proposals ──── entity_tags
financial_entities ─── entity_tags

graph_snapshots (share codes → serialized graph state)
data_sync_log   (every pipeline run recorded)
platform_limits (free/pro tier limits per service)
platform_usage  (actual usage values — dashboard transparency)
```

### Schema Conventions

| Convention | Rule |
|-----------|------|
| Money | Integer cents, never floats |
| Timestamps | `TIMESTAMPTZ` always |
| IDs | `UUID DEFAULT gen_random_uuid()` |
| Flexible fields | `metadata JSONB DEFAULT '{}'` on every table |
| Amounts | `amount_cents INT` — never `amount_dollars FLOAT` |

### Key Column Names (Common Mistakes)

**officials table:**
```
full_name       (NOT name)
role_title      (NOT role_type)
is_active       BOOLEAN
source_ids      JSONB — holds: fec_id, bioguide_id, congress_id, openstates_id
metadata        JSONB — holds: state, district, level
```

**votes table:**
```
vote            (NOT vote_cast)    values: 'yes' | 'no' | 'present' | 'not voting'
voted_at        (NOT vote_date)
metadata->>'vote_question'         e.g. "On Passage", "On the Cloture Motion"
metadata->>'legis_num'             bill number
```

**financial_relationships table:**
```
source_ids      JSONB (NOT source_id — always plural)
source_ids->>'fec_committee_id'
source_ids->>'fec_candidate_id'
```

**entity_connections table:**
```
from_id / from_type / to_id / to_type
(NOT entity_a_id / entity_b_id — those names were in the original spec but are wrong)
```

### Supabase Project

- **Project ID:** `xsazcoxinpgttgquwvuf`
- **Dashboard:** `supabase.com/dashboard/project/xsazcoxinpgttgquwvuf`
- **Extensions enabled:** PostGIS, uuid-ossp, pgcrypto, pg_trgm (trigram search)

### proposals.vote_category

Added in migration `0019`. Controls graph visibility and proposal page display.

| Value | Meaning | Graph | Proposals Page |
|-------|---------|-------|----------------|
| `substantive` | Real bills with proper titles | Shown | Shown |
| `procedural` | Cloture, passage motions, parliamentary procedure | **Hidden by default** | Never shown |
| `nomination` | Judicial/cabinet/ambassador confirmations | Shown as `nomination_vote_yes`/`nomination_vote_no` | Never shown |
| `regulation` | Federal regulations from Regulations.gov | Shown | Shown |

**Why:** Procedural votes (cloture etc.) are noise in the connection graph. 221 procedural vs 801 substantive votes — hiding procedural makes the graph dramatically more useful for the accountability story. Pass `?include_procedural=true` to include them for researchers.

### entity_connections.connection_type Values

```
vote_yes             official → proposal (substantive yes vote)
vote_no              official → proposal (substantive no vote)
vote_abstain         official → proposal (present / not voting)
nomination_vote_yes  official → proposal (confirmation yes)
nomination_vote_no   official → proposal (confirmation no)
donation             financial_entity → official (PAC/individual contribution)
oversight            agency → proposal (regulatory oversight)
co_sponsorship       official → proposal (bill co-sponsorship)
appointment          official → official (nominated/appointed)
revolving_door       official → entity (career path crossing public/private)
```

Nomination votes are a separate type from regular votes because confirmations are a distinct accountability story — they deserve their own visual treatment and filtering.

---

## The Three Supabase Clients

```ts
import {
  createBrowserClient,    // 'use client' components only
  createServerClient,     // Server Components + Route Handlers (respects RLS)
  createAdminClient,      // Server only, pipelines only (bypasses RLS)
} from '@civitics/db';
```

**Critical rule:** Every route/page that calls `createAdminClient()` MUST export:
```ts
export const dynamic = "force-dynamic";
```
Without this, Next.js prerenders at build time and the secret key is unavailable on Vercel.

**generateStaticParams exception:** Use `createClient()` from `@supabase/supabase-js` with the publishable key. Never `createAdminClient()` — it fails at build time.

**API keys — new format only:**
```
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   sb_publishable_xxx   ← client-safe
SUPABASE_SECRET_KEY                    sb_secret_xxx        ← server only, never NEXT_PUBLIC_
```

---

## The Graph Package

The connection graph is not a feature — it IS the core product.

### Three-Layer GraphView Model

Every graph state is a `GraphView` — a single serializable object:

```ts
interface GraphView {
  // Layer 1: FOCUS — which entities to explore (set of up to 5)
  focus: {
    entities: FocusEntity[]   // multi-entity set, NOT a single entityId
    depth: 1 | 2 | 3
    scope: 'all' | 'federal' | 'state' | 'senate' | 'house'
    includeProcedural: boolean
  }

  // Layer 2: CONNECTIONS — which relationship types to show and how
  connections: {
    [connectionType: string]: {
      enabled: boolean
      color: string
      opacity: number       // 0–1
      thickness: number     // 0–1
      minAmount?: number    // donations only
      dateRange?: { start: string | null; end: string | null }
    }
  }

  // Layer 3: STYLE — how to render
  style: {
    vizType: VizType
    vizOptions: {
      force?: ForceOptions
      chord?: ChordOptions
      treemap?: TreemapOptions
      sunburst?: SunburstOptions
    }
  }
}
```

**The critical rule:** Switching `vizType` only changes `style.vizType`. The `focus` and `connections` layers are never changed by a viz switch. The user's entities and filters persist when switching Force → Chord → Treemap → Sunburst.

### Visualization Types

| Type | What it shows | Technology |
|------|-------------|-----------|
| Force graph | D3 force simulation — organic clustering | D3 only, never React Flow |
| Chord diagram | 13 industry groups × 4 parties — $1.75B campaign finance flow | d3.chord() |
| Treemap | Hierarchical donation breakdown by industry | D3 |
| Sunburst | Radial profile drill-down from selected node | D3 |

**Why D3 force simulation (non-negotiable):** Organic clustering IS the analysis. Dense clusters reveal entanglement — when an official connects to 40 PACs in the same industry cluster, that's a story. Bridge nodes (entities connecting otherwise-separate clusters) reveal hidden relationships. These insights only exist with real force simulation. React Flow's manual layout would destroy this.

### Chord Diagram Matrix Fix

The API returns a **13×4 matrix** (13 industry groups → 4 party slots). `d3.chord()` requires a **square N×N matrix**.

**Fix (non-obvious, took significant debugging):** Expand to a **17×17 matrix**. Industries flow to party slots; party slots mirror back. This was the key insight that made the chord diagram work.

### Panel Layout

```
┌────────────────────────────────────────────────────────┐
│  Graph Header (entity search, presets, share, export)  │
├──────────────┬─────────────────────────┬───────────────┤
│  Data        │                         │  Graph        │
│  Explorer    │    Canvas (D3 SVG)       │  Config       │
│  (260px)     │    flex-1               │  (220px)      │
│              │                         │               │
│  Focus tree  │                         │  Viz type     │
│  + entity    │                         │  Presets      │
│  search      │                         │  Physics      │
│              │                         │  settings     │
│  Connections │                         │               │
│  tree        │                         │               │
│  + per-type  │                         │               │
│  styling     │                         │               │
└──────────────┴─────────────────────────┴───────────────┘
```

### Built-in Presets

1. **Follow the Money** — donation connections, all industries
2. **Votes & Bills** — substantive vote connections
3. **Revolving Door** — career history connections
4. **Full Picture** — all connection types (default)
5. **Clean View** — minimal styling, strong connections only
6. **Nominations** — "Who did this senator confirm?" (nomination_vote_yes/no)
7. **Full Record** — all including procedural votes (researcher mode)

Pending (Phase 2): Committee Power, Industry Capture, Co-Sponsor Network.

### Share Codes

Share codes use the format `CIV-XXXX-XXXX`. A code maps to a serialized `GraphView` stored in the `graph_snapshots` table. URL: `/graph/[code]`. Generated via `/api/graph/snapshot`.

### Real-Time Update Categories

When a graph setting changes, the update is categorized to avoid unnecessary re-renders:

| Category | What triggers it | How it's handled |
|----------|-----------------|-----------------|
| A — Visual only | Colors, opacity, edge thickness | Update SVG directly, no simulation restart |
| B — Physics | Charge, link distance, gravity | Restart simulation, no re-fetch |
| C — New entity | `addEntity()` called | Fetch + merge data, show loading ring on new node, never blank the graph |

---

## The Pipeline System

### Data Sources and Volume

| Source | Budget | Update Schedule |
|--------|--------|----------------|
| Congress.gov | 80MB | Daily 2am |
| FEC bulk downloads | 50MB | Weekly |
| USASpending.gov | 60MB | Daily 2am |
| Regulations.gov | 40MB | Hourly (active periods) |
| CourtListener | 20MB | Daily 2am |
| OpenStates | 20MB | Daily 2am |
| **Total Phase 1 target** | **270MB** | |

### Current Data Counts (as of 2026-03-21)

| Table | Rows |
|-------|------|
| officials | 8,251 (2,252 federal + 6,268 state + 651 judges via CourtListener/OpenStates) |
| proposals | 2,066 |
| votes | 227,153 |
| financial_relationships | 19,647 |
| entity_connections | ~51k vote connections (full 227k pending IO recovery) |
| spending_records | 1,980 |
| entity_tags | 5,978 |

### Egress Optimization via Delta Tracking

The `pipeline_state` table stores the last successful run state per pipeline:

```
key:   'connections_last_run'
value: { last_vote_id: "uuid", timestamp: "ISO" }
```

**Impact:** After the first full run, the nightly delta processes ~50 new votes (not 227k).
- Full connections run: ~114MB egress
- Nightly delta run: ~25KB egress
- Savings: ~99.98% egress reduction

### FEC Bulk Strategy

**Never use the FEC API** — it hits rate limits immediately.

Use bulk file downloads instead:
- `weball24.zip` — all candidates summary (totals per candidate)
- `cm24.zip` — committee master (maps committee IDs to names)
- `pas224.zip` — PAC to candidate contributions (~200MB compressed, **streamed line-by-line**)

The `pas224.zip` file is never fully loaded into memory — it is streamed and filtered in chunks.

### Nightly Cron

Vercel Cron fires at `0 2 * * *` (2:00 AM UTC), calling `/api/cron/nightly-sync` with `Authorization: Bearer ${CRON_SECRET}`.

Full sequence: Congress → FEC (weekly only) → USASpending → Regulations → CourtListener → OpenStates → Connections (delta) → Tag rules → AI summaries → AI tagger.

### Recency Guards

```ts
CONNECTIONS_PIPELINE: minGapMs = 4 * 60 * 60 * 1000  // 4 hours
AI_PIPELINES:         minGapMs = 2 * 60 * 60 * 1000  // 2 hours
```

Override with `-- --force` flag.

### AI Cost Gating

Every Anthropic API call passes through `generateSummary()` in `packages/ai/src/client.ts`, which:
1. Checks `platform_limits` for the current monthly budget
2. Checks `platform_usage` for current-month spend
3. Only calls the API if under budget
4. Logs every call to `api_usage_logs`

Current self-imposed budget: $3.50/month hard cap.

---

## Key Technical Decisions

### Supabase (vs. PlanetScale / Neon / other Postgres)

- **PostGIS** built-in — future geo queries for district mapping
- **Row Level Security** native — civic data is public read, user data is auth-gated, enforced at DB level
- **Realtime subscriptions** — future live comment feeds, Phase 2
- **Full Postgres** — no ORM needed, raw SQL for complex queries
- **Free tier generous** enough for Phase 1 (500MB DB, 5GB egress)
- **New API key format** (`sb_publishable_` / `sb_secret_`) — never use legacy `anon`/`service_role`

### Cloudflare R2 (vs. AWS S3)

**Zero egress fees — critical for a read-heavy public platform.**

S3 charges $0.09/GB egress. A platform serving civic data to the public at scale would face enormous S3 bills. R2's egress is free forever (S3-compatible API, integrated CDN).

Buckets: `civitics-documents` (PDFs, bills), `civitics-cache` (pre-generated files).

### Cloudflare Proxy (vs. bare Vercel)

Before Cloudflare proxy was enabled, PHP/WordPress scanner bots were burning Vercel Fluid CPU. Bot Fight Mode + orange cloud proxy eliminated this traffic entirely. Vercel CPU usage dropped dramatically. Free on all Cloudflare plans.

`next.config.mjs` adds additional protection at the Next.js layer:
```ts
redirects: [
  { source: "/:path*.php", destination: "/404" },
  { source: "/wp-:path*",  destination: "/404" },
  { source: "/.env:path*", destination: "/404" },
]
```

### Next.js App Router (vs. Pages Router)

- Server Components reduce client bundle size — civic data pages serve HTML from the server
- Streaming for graph data — graph can show partial results while connections load
- Built-in API routes — no separate Express server
- `generateStaticParams` with ISR — official pages pre-generated, fall back to on-demand if DB unavailable

### packages/ui (Shared Component Library)

Prevents design inconsistency across pages. Shared in future `apps/social`. Rules:
- Pure React only — no Next.js imports, no Supabase imports
- Props-driven — components never fetch data internally
- Could run in React Native with minimal changes

### Vote Connection Deduplication

Officials often vote on the same proposal multiple times (amendments, reconsiderations). The `entity_connections` upsert uses:
```sql
ON CONFLICT (from_id, to_id, connection_type) DO UPDATE SET ...
```

Multiple votes on the same proposal → single connection with latest `strength`. Correct for graph visualization (the connection exists); raw vote counts come from the `votes` table directly.

---

## Security Model

### Layered Defense

```
Layer 1: Cloudflare Bot Fight Mode — blocks scrapers, PHP probes at CDN edge
Layer 2: next.config.mjs redirects — sends .php/.env probes to /404 at Next.js edge
Layer 3: middleware.ts — silent session refresh, future rate limiting
Layer 4: Supabase RLS — policy-enforced at DB level
```

### RLS Pattern

```sql
-- All civic data: public read, no auth required
CREATE POLICY "public read" ON officials FOR SELECT USING (true);
CREATE POLICY "public read" ON proposals FOR SELECT USING (true);
-- ... votes, entity_connections, agencies, etc.

-- User data: auth required
CREATE POLICY "owner" ON civic_comments USING (auth.uid() = user_id);
CREATE POLICY "owner" ON user_preferences USING (auth.uid() = user_id);
```

### Environment Separation

```
NEXT_PUBLIC_*     → safe to expose in browser bundle
(no prefix)       → server-only, never in client code
SUPABASE_SECRET_KEY → server-only, never NEXT_PUBLIC_
CIVITICS_ANTHROPIC_API_KEY → server-only
```

The `CIVITICS_` prefix on the Anthropic key ensures the Claude Code CLI uses its own Pro subscription rather than billing against the platform key.

### Admin Access

The `/dashboard` admin controls (pipeline triggers, budget limits) are gated by `ADMIN_EMAIL` env var — must match the signed-in Supabase auth email. No separate admin role in DB yet.

---

## Infrastructure Costs

### Current Monthly (~Phase 1)

| Service | Plan | ~Cost | What it covers |
|---------|------|-------|---------------|
| Supabase | Free | $0 | DB, auth, storage, realtime |
| Vercel | Free | $0 | Hosting, CDN, serverless functions, cron |
| Anthropic | Pay-as-you-go | ~$0.60/mo | Claude Haiku for summaries + tagging |
| Cloudflare | Free | $0 | Proxy, WAF, R2 storage |
| Mapbox | Free | $0 | Map tiles, geocoding (50k loads/mo free) |
| **Total** | | **~$0.60/mo** | |

### Cost Tracking System

`platform_limits` + `platform_usage` tables (migration `0024`) replace static hardcoded budget numbers. `source` field tracks data accuracy:

| source | Meaning |
|--------|---------|
| `api` | Fetched live from service API (most accurate) |
| `webhook` | Pushed by the service |
| `estimated` | Calculated from our own logs (~±15%) |
| `manual` | Hand-entered from dashboard (needs re-verification) |

Limits are updatable via the admin dashboard without a code deploy.

---

## Phase Roadmap

See `docs/PHASE_GOALS.md` for task-level tracking. Summary:

| Phase | Status | Done When |
|-------|--------|----------|
| **Phase 0** — Scaffold | ✅ 100% | Monorepo, DB, first page live |
| **Phase 1** — MVP | 🔄 ~88% | Vote backfill, auth end-to-end, 500 users, grant apps |
| **Phase 2** — Growth | Planned | Self-sustaining revenue, first institutional API customer |
| **Phase 3** — Social App | Planned | COMMONS token sim, social feed, bipartisan mechanics |
| **Phase 4** — Blockchain | Planned | On-chain credits, warrant canary, smart contract audit |
| **Phase 5** — Global | Planned | UK/Canada deployment, multilingual support |

### Active Phase 1 Remaining Tasks

- Vote backfill completion — 51k/227k vote connections live, full 227k pending IO recovery
- `vote_category` full data population on all proposals
- Search ranking improvements (Elizabeth Warren and some senators not appearing)
- Community commenting UI (`civic_comments` table exists, no frontend yet)
- Position tracking on proposals
- Follow officials/agencies
- 500 beta users
- Grant applications submitted

### Phase 2.5 (Current Focus: Guardrails + Stability)

- Local dev environment ✅
- Resource tracking + kill switches ✅
- Official profile pages ✅
- Unified search ✅
- Mobile fixes (in progress)

---

## Global Deployment Architecture

The `jurisdictions` table hierarchy makes adding a new country a configuration change, not a code rebuild:

```
jurisdictions (hierarchical)
  global
    └── country (US, UK, Canada, ...)
          └── state / province
                └── county / district
                      └── city / ward
```

Every entity (`officials`, `proposals`, `agencies`) belongs to a `jurisdiction` node. Each country gets a config file specifying data sources, government structure, and terminology. Tier 1 targets: UK, Canada, Australia.

Censorship resistance for Tier 3 countries: Tor hidden service, ENS domain, IPFS, offline PWA mode.
