# CLAUDE.md — Civitics Platform

This file is the authoritative reference for the Civitics platform. Read it before writing any code. Update it when architecture decisions change. Last updated from design session: March 2026.

---

## Mission

Restore democratic power to its rightful owners — the people. Facilitate, foster and encourage collaboration between all political, religous, language and geographic barriers. Bring together data on all public institutions and officials, make it easy for anyone to explore, and provide powerful tools for citizens, researchers, journalists, and investigators. Make government promises permanent public record. Give average people a genuine seat at the table.

---

## The North Star

A world map, dark at first. District by district, jurisdiction by jurisdiction, it gets brighter as democratic accountability increases — as officials engage with constituents, as promises are kept, as donors and votes are connected in plain sight, as ordinary people find their voice and use it.

Every feature we build should make that map brighter. If it doesn't, we don't build it.

---

## What This Is

Two distinct products sharing one infrastructure:

1. **Civitics App** — The mission vehicle. "Wikipedia meets Bloomberg Terminal for democracy." Structured civic data, legislative tracking, public comment submission, connection graph visualization, maps, and AI-powered accountability tools. Feels like serious civic infrastructure — closer to a court of record than Twitter. Must never feel like a "politics tab." Also known as the governance app.

2. **Social App** — The distribution and funding vehicle. A censorship-resistant social platform with the COMMONS token economy. General civic discourse, bipartisan feed mechanics, creator economy, algorithm marketplace, and crowdfunding. Cat memes are welcome. Funds and seeds the governance app's user base.

**The relationship:** Social app reaches mainstream users → introduces them to civic tools. Governance app provides credibility, data, and serious content the social app couldn't have alone. They share identity, wallet, and content infrastructure but are kept visually and tonally separate.

---

## Core Principles (Non-Negotiable)

Every implementation decision must be checked against these:

- **Official comment submission is always free** — No fees, tokens, or credits required. This is a constitutional right.
- **No paywalling civic participation** — Reading, commenting on, and submitting positions on government proposals is free forever.
- **Blockchain is invisible** — No seed phrases, no wallet addresses in UI, no gas fee prompts, no network switching. Web3 is plumbing.  Options for Advanced users to use these, as requested, disabled by default, enabled by request.
- **No gas fees for users** — All transaction costs sponsored or included in total via Biconomy, dynamic pricing (ERC-4337).
- **Geography is never stored precisely** — Coarsen to district/zip level before any INSERT. Exact coordinates are never persisted.
- **Warrant canary published on-chain weekly** — Signed attestation of non-compromise written to Optimism on schedule.
- **Platform earns are never extractive** — Revenue model aligned with civic mission, not against it.
- **Free tier is genuinely powerful** — Covers 90% of citizen needs. Paid tiers scale volume, not capability.

---

## Monorepo Structure

**Tooling:** Turborepo

```
/apps
  /civitics         # Next.js civic governance app
  /social           # Next.js social/COMMONS app
/packages
  /ui               # Shared Tailwind component library
  /db               # Supabase client, schema, migrations
  /blockchain       # Wallet, contract ABIs, chain config, ERC-4337
  /maps             # Mapbox GL + Deck.gl utilities
  /graph            # D3 force simulation (connection graph)
  /ai               # Shared Claude API service layer
  /auth             # Privy integration, session management
  /config           # Shared ESLint, TypeScript, Tailwind configs
```

Both apps are separate Next.js App Router projects. One account works across both; civic identity and wallet are shared.

---
## Claude Code Permissions

Auto-approved operations:
  pnpm commands
  File creation and editing in project
  Directory creation (mkdir)
  Directory listing (ls)
  Git read operations (status, diff, log, branch, show)
  Git commits and pushes

Always requires approval:
  Any deletion (rm, rmdir)
  Destructive git (push --force, reset --hard, checkout --)
  .env file changes
  Global installs
  External network calls

Never without explicit confirmation:
  DROP/TRUNCATE/DELETE SQL
  Modifying existing migrations
  Changes to .gitignore
  Exposing any credentials

## Package Manager
pnpm — not npm, not yarn
  pnpm install (not npm install)
  pnpm add X (not npm install X)
  pnpm dev (not npm run dev)
  pnpm dlx X (not npx X)
  
Never commit node_modules
Never use npm or yarn commands
Always use pnpm

## Supabase API Keys
Use NEW API keys only — not legacy:
  Client side: sb_publishable_xxx
    stored as NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  Server side: sb_secret_xxx
    stored as SUPABASE_SECRET_KEY
    
Never use legacy anon or
service_role keys
Never use NEXT_PUBLIC_ prefix
for secret key

## Supabase Clients

Three clients in packages/db/src/client.ts:

createBrowserClient()
  → 'use client' components only
  → uses publishable key

createServerClient(cookieStore)
  → Server Components, Route Handlers
  → pass cookies() from next/headers
  → uses publishable key
  → respects RLS

createAdminClient()
  → server-only, never client-side
  → uses secret key
  → bypasses RLS
  → data ingestion pipelines only

Import from '@civitics/db' not directly
from @supabase/supabase-js


## Tech Stack

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **Maps:** Mapbox GL JS (main maps) + Deck.gl (data overlays)
- **Graph visualization:** D3 force simulation — use D3 from day one, not React Flow. The graph IS the product; D3's organic clustering is analysis, not decoration.
- **Component library:** Shared via `/packages/ui`

### Backend & Database
- **Platform:** Supabase
- **Database:** PostgreSQL with PostGIS extension
  - PostGIS stores boundary files (congressional districts, state lines, counties, precincts) and performs spatial queries
  - PostGIS recursive CTEs power the connection graph engine (no separate graph DB needed until Phase 4+)
  - Precise user coordinates are coarsened before any INSERT
- **Real-time:** Supabase Realtime for live updates (petition milestones, vote alerts)
- **Search:** Supabase full-text search (Phase 1–2), self-hosted Typesense on $6/mo VPS (Phase 3+)

### Auth & Wallet
- **Privy** — Invisible wallet creation via email/social login. Users never see a seed phrase.
- **ERC-4337 (Account Abstraction)** — Smart contract wallets. Session keys allow multiple actions without re-signing.
- **Biconomy** — Paymaster for gas sponsorship. Platform tops up gas tank; users pay nothing.
- Social recovery replaces seed phrases. Government email required for official account verification.

### Blockchain
- **Primary:** Optimism (OP Mainnet) — mission-aligned, public goods funding via RetroPGF, decentralized
- **Secondary:** Base — US user onboarding, Coinbase fiat onramp, shares OP Stack
- **International:** Polygon — cheapest transactions, strong in emerging markets
- Users never know which chain they're on. Platform routes to cheapest available chain.  Advanced users can choose if requested
- Blockchain roles: identity, content hashing, credit ledger, civic action records, treasury transparency, warrant canary. NOT speculative tokens.

### Storage (tiered)
| Tier | Technology | What lives here | Cost |
|------|-----------|-----------------|------|
| Hot | Supabase PostgreSQL | Structured data, user data, credits, social graph | $0–$25/mo |
| Warm | Cloudflare R2 | Documents, full bill text, media, AI output cache | ~$0.015/GB/mo, no egress fees |
| Cold | Arweave | Official comments, promise records, government docs at ingestion | ~$4–8/GB one-time |
| On-chain | Optimism | Document hashes, civic action proofs, treasury movements | Fractions of a cent per tx |

**Never use AWS S3** — egress fees are prohibitive for a read-heavy public platform. R2 has no egress fees.

### AI
- **Claude API** — All AI features (summaries, drafting, connection mapping, legislation writing)
- Model routing: Haiku for simple/cached tasks, Sonnet for standard features, Opus for premium complex tasks
- Cache everything possible: plain language summaries generated once on ingestion, stored in Supabase, served to unlimited users
- AI features are always credit-gated for per-user calls. Never open-ended free API access.
- Cost rule: **Never turn on an AI feature until the credit/revenue mechanism that pays for it is also live.**

### Other Services
- **Typesense** — Full-text search (Phase 3+)
- **Cloudflare CDN** — Cache public data at edge, DDoS protection
- **Stripe** — Fiat payments (credit card → USDC → credits)

---

## The Two Economies

### Civitics App: Civic Credits
- **Non-transferable, non-speculative** — cannot be bought or sold
- Tracked on-chain (soulbound) as a permanent civic participation record
- Earned through civic activity: submitting official comments , bridging comments , verified contributions 
- Spent on AI features: extra queries , comment draft , connection mapping , legislation draft 
- Active civic users earn more than they spend — never need to pay
- Earnings determined by supply , demand , value , voting results
- Rewards funded by donation or as a percentage of revenue from ads , specific donations
- Voting through "staking" on specific causes - direct effect on reward distribution allocation

### Social App: COMMONS Token
- **Transferable, exchangeable for USDC** — creators can pay rent with this
- Earned through quality content creation (weighted by engagement depth, civic bridge multiplier, authenticity score)
- Earned through genuine engagement: saves/shares weighted higher than likes, depth over breadth
- **Cannot be bought directly** — must be earned or received as tip (prevents wealth buying influence)
- Exchangeable for USDC (1:1 minus small fee), governance credits, or real-world value
- Platform cut on creator subscriptions and ad facilitation: **10% fixed, published, immutable**

### The Bridge
Civic credits convertible to COMMONS. COMMONS convertible to civic credits. One identity, two economies, same mission.

---

## Government Data Sources

### Federal (US)
| Source | Data | API |
|--------|------|-----|
| USASpending.gov | Agency spending, contracts, grants | Free |
| Congress.gov | Bills, votes, legislative history | Free (key required) |
| FEC | Campaign finance, donations | Free (key required) |
| regulations.gov | Proposed rules, comment periods | Free (key required) |
| CourtListener | Federal judges, opinions, dockets | Free (registration) |
| OpenSecrets | Donor-official relationships | Paid |
| Federal Register | Executive orders, rulemaking | Free |
| OpenStates | All 50 state legislatures | Free |

### Key Update Schedules
- **Hourly:** Active proposal status, comment period deadlines
- **Daily (2am):** Spending data, campaign finance, voting records, new bills
- **Weekly:** Full reconciliation, AI summary regeneration, search index rebuild

### Smart Update Detection
Use ETag/Last-Modified headers and hash comparison to skip unchanged records. Target 60–80% reduction in redundant API calls.

---

## Connection Graph (Signature Feature)

The connection graph is not a feature — it IS the reason journalists and researchers use the platform. The D3 force simulation's organic clustering is information: dense clusters mean deep entanglement, bridge nodes reveal hidden connections.

### Technology: D3 Force Simulation
Use D3 from day one. React Flow cannot cluster organically or handle the time dimension or custom edge thickness. The organic force layout IS the analysis.

### Node Types & Visual Language
| Entity | Shape | Color |
|--------|-------|-------|
| Official | Circle (photo) | Border: blue=D, red=R, purple=I |
| Agency | Rounded rectangle | Gray border |
| Proposal | Document rect | Amber border |
| Financial entity | Diamond | Green border |

### Edge Types
| Connection | Color | Width |
|-----------|-------|-------|
| Donation | Green | Proportional to dollar amount |
| Vote yes | Blue | Fixed |
| Vote no | Red | Fixed |
| Appointment | Purple | Dashed |
| Revolving door | Orange | Fixed |
| Oversight | Gray | Fixed |

### Core Capabilities
- **Expand on click** — click any node to load its connections; new nodes fly in from clicked position
- **Hover highlighting** — fade unconnected nodes, show edge labels
- **Shortest path query** — "How is Senator X connected to Company Y?" (PostgreSQL recursive CTE)
- **Time scrubber** — drag to see how the network evolved over years; animate with play button
- **AI narrative** — "Explain what I'm seeing" generates plain-language summary of the visible graph
- **Shareable snapshots** — permanent link, high-res image, embeddable iframe, on-chain hash for journalists

### Graph Query Engine
Powered by PostgreSQL recursive CTEs against the `entity_connections` table. No separate graph database needed until Phase 4+ (when queries routinely exceed 5–6 hops at scale).

---

## Maps

Maps add value when geography explains something a table cannot. Use them selectively.

### High-Value Map Use Cases
1. **District Intelligence Map** — User enters address once; map shows every official who represents them at every level, active proposals affecting their district, open comment periods
2. **Spending Map** — Federal spending by district (choropleth); click district to see breakdown; reveals geographic hypocrisy (officials who vote against spending but receive above-average federal dollars)
3. **Campaign Finance Map** — Where donations come from vs. where constituent support is; out-of-state donor concentration is immediately visible
4. **Legislative Impact Map** — Any proposal's geographic effect: which counties benefit, which face economic impact, what the user's specific area receives
5. **Civic Engagement Map** — Live heat map of platform activity, comment submissions, crowdfunds, candidate activity
6. **Candidate Campaign Map** — District intelligence, precinct-level results, voter registration, supporter density, volunteer deployment
7. **Civic Health Map** — Global map of democratic health by jurisdiction; gets brighter as platform grows

### Map Stack
- **Mapbox GL JS** — Main maps (50k loads/mo free, then $0.50/1k)
- **Deck.gl** — Data overlays for spending flows, donation geography (free, WebGL-powered)
- **PostGIS** — Stores all boundary files locally; spatial queries at no per-query cost

### Geographic Data (all free)
- Congressional districts: Census TIGER files
- State legislative districts: OpenStates GeoJSON
- County/municipal: Census TIGER
- Precincts: OpenPrecincts.org
- Census tracts: Census Bureau

### Privacy
Never store exact user address. Geocode once, store coarsened coordinates (~1km accuracy), store district IDs. Update only if address changes.

### PostGIS District Lookup Pattern

This is the canonical spatial query used throughout the app. Given a user's (coarsened) coordinates, return every jurisdiction that contains that point:

```sql
-- Find all officials representing a specific location
-- Used on: homepage district map, "my representatives" panel,
--          proposal impact filtering, candidate district display

SELECT
  o.id,
  o.full_name,
  o.role_title,
  o.party,
  gb.name AS governing_body,
  j.name AS jurisdiction
FROM officials o
JOIN governing_bodies gb ON o.governing_body_id = gb.id
JOIN jurisdictions j ON o.jurisdiction_id = j.id
WHERE
  o.is_active = true
  AND ST_Contains(
    j.boundary_geometry,                     -- stored as PostGIS geometry
    ST_SetSRID(
      ST_Point($user_lng, $user_lat),        -- coarsened coordinates
      4326
    )
  )
ORDER BY j.type, o.role_title;
```

**Boundary geometry storage:** Import Census TIGER GeoJSON files into the `jurisdictions` table as PostGIS geometry columns. Run once per census cycle. All spatial queries then run against your own database — no per-query API cost, no external dependency.

```sql
-- Add geometry column to jurisdictions (run once during schema setup)
SELECT AddGeometryColumn('jurisdictions', 'boundary_geometry', 4326, 'MULTIPOLYGON', 2);
CREATE INDEX jurisdictions_boundary_gist ON jurisdictions USING GIST(boundary_geometry);
```

**Performance note:** The GIST index makes `ST_Contains` fast even across thousands of boundary polygons. Test with `EXPLAIN ANALYZE` to confirm index is being used.

### Map Integration Points (Where Maps Appear)

Maps appear only where geography changes the meaning of the data. The test: *does seeing WHERE something happens change how you understand it?* If no, use a table.

| Location in app | Map used | Why it earns its place |
|----------------|----------|----------------------|
| Homepage | Small district context map | Instantly answers "who represents me?" |
| Proposal pages | Impact choropleth | Makes abstract policy concrete to the user's county |
| Official profiles | District boundary + donor geography | Shows who they represent vs. who funds them |
| Agency pages | Spending geography + office locations | Where does the money actually go? |
| Campaign pages | Supporter density + volunteer coverage | Proves grassroots geographic spread |
| Connection graph | Optional geographic overlay | Lobbying corridors become literal |
| Spending data | Default view is a map, not a table | Geography IS the story for spending |
| Civic crowdfunding | Supporter origin map | "This campaign has support in every county" |
| Global governance | Civic Health Map (see below) | The platform's visual north star |

### The Civic Health Map

The single most important map in the platform. A world map, updated in real time, showing democratic health by jurisdiction.

**What it measures (combined score):**
- Official engagement and constituent response rates
- Promise fulfillment scores
- Donor capture index (vote/donor correlation)
- Civic participation rate (comment submissions per capita)
- Platform transparency score

**Visual language:** Dark (low civic health) → bright (high civic health). Never red vs. blue. Zoom from world → country → state → district. Every level shows its specific score with explanation.

**Why it matters:** As the platform grows, as officials engage, as candidates win on transparency, as accountability increases — the map gets brighter. That image is the platform's most powerful statement. The darkest spots show exactly where the work needs to happen next. It is the mission made visible in real time.

**Interaction:** Click any jurisdiction → "Here's why this score / here's what's improving / here's how to help." The map is also an action surface, not just a display.

### Visual Principles
- Neutral base style — no red vs. blue for political data
- Data drives color: spending=green scale, engagement=blue scale
- Progressive disclosure: simple view first, expert layers optional
- Mobile-first

---

## AI Features

### Free (cached, shared across all users)
- Plain language summaries — generated once on document ingestion, stored, served free
- "What does this mean?" basic Q&A on cached data

### Credit-gated (per-user AI calls)
- Personalized impact analysis ("what does this mean for ME as a small business owner"), answers are shareable
- Comment drafting assistant (3 questions → structured official comment)
- Direct submission to regulations.gov via API
- Connection mapping queries
- Legislation drafting studio
- FOIA request builder

### Premium (Opus model, higher credit cost)
- Full legislation drafting with legal citations
- Complex multi-hop connection analysis
- Comparative analysis across jurisdictions

### Cost Control Rules
1. Cache hit rate target: 80%+
2. Model routing: Haiku for simple tasks (12x cheaper than Sonnet), Sonnet for standard, Opus for premium
3. Hard rate limits per user per day
4. Never open-ended free API access
5. Seek Anthropic nonprofit/partnership rate; apply for startup credits early
6. Costs are always transparent, and less than revenue

---

## Database Schema (Core Tables)

Key design decisions:
- `jurisdictions` table — hierarchical (global → country → state → county → city). Every entity belongs to a jurisdiction. This is what makes global deployment a configuration change, not a rebuild.
- `governing_bodies` — abstract representation of any government entity anywhere (body_type enum handles presidential, parliamentary, etc.)
- `officials` — any public official, any country, any level. `source_ids` JSONB holds IDs in multiple source systems.
- `proposals` — any legislative/regulatory proposal. `proposal_type` enum covers bill, regulation, executive_order, treaty, referendum, etc.
- `entity_connections` — the connection graph table. `connection_type`, `strength` (0–1), `evidence` JSONB array of source URLs.
- `financial_relationships` — all money flows. `donor_type`, `industry`, `amount_cents` (always cents, never floats).
- `promises` — promise tracker. Links officials to specific commitments with status lifecycle.
- `career_history` — revolving door tracker. Flags when org was regulated by official's prior/subsequent government role.
- `spending_records` — government contract/grant data from USASpending.

All amounts stored as integer cents. All timestamps as TIMESTAMPTZ. All IDs as UUID. `metadata JSONB` on every table for country-specific fields.

---

## Institutional API

The same data that powers the public platform is available via versioned REST API to institutional customers. This is the primary path to financial sustainability.

### Tiers
| Tier | Price | Calls/mo | Target |
|------|-------|----------|--------|
| Researcher | $49/mo | 10k | Academics, independent journalists |
| Nonprofit | $149/mo | 50k | Watchdog orgs, journalism nonprofits |
| Professional | $499/mo | 250k | Law firms, policy organizations |
| Enterprise | Custom | Unlimited | Major media, research institutions |

### API Design Rules
- Versioned from day one: `/api/v1/` never breaks
- Consistent pagination, error format, auth, rate-limit headers across all endpoints
- `updated_after` filter on every collection endpoint (critical for keeping downstream systems fresh)
- Webhook support for real-time events
- `GET /v1/connections/path` — shortest path between any two entities (the investigation superpower)
- `GET /v1/financial/influence_map` — pre-computed donor→vote correlation patterns
- Bulk export endpoints with async job pattern
- Change log endpoint: every data change queryable by entity type + timestamp

### Revenue Projection (modest scale)
10 Researcher + 5 Nonprofit + 3 Professional + 1 Enterprise = ~$4,700/mo. Covers all infrastructure costs. Everything else is mission surplus.

---

## User Access Tiers

### Free (ad-supported, genuinely powerful)
- Full data access: all agencies, legislators, courts, proposals, voting records, spending, campaign finance
- Cached AI summaries (unlimited)
- 3 personalized AI queries/day, 1 comment draft/day
- Community features, official comment submission (always unlimited), position tracking, follows
- Connection graph (up to 3 hops), Vote pattern analyzer, Donor impact calculator, Bill tracker (20 bills), Timeline builder

### Contributing Member ($5/mo or 500 credits)
- Unlimited AI queries (50/day fair use), unlimited comment drafts, unlimited connection graph
- Ad-free, API access (1k calls/mo), data export, advanced visualization, unlimited saved searches

### Investigator ($20/mo)
- Everything in Contributing plus: multi-hop connection graph, bulk downloads, webhooks, custom feeds, collaborative workspaces, full document archives

### Organization ($99/mo)
- Everything in Investigator plus: 10 team accounts, API (50k calls/mo), white-label reports, coalition tools, petition management

---

## Candidate Empowerment

The platform lowers the barrier to entry for genuine public service.

### Candidate Discovery
Platform passively identifies potential candidates from behavior: civic talent score (knowledge depth, community trust, bipartisan appeal, engagement quality). Invitation is private, not public. Never pressuring. Users can opt out permanently.

### Candidate Profile (Verified)
- Real-time donor transparency (from FEC data, not quarterly delays)
- Every policy position documented with source, date, specificity rating
- Promise tracker active from announcement
- Constituent Q&A with public response rate
- Connection graph of campaign network
- Community-verified engagement score

### "Should I Run?" Explorer (5-Step Flow)

Before any commitment, potential candidates walk through an honest, private exploration tool. The goal is informed decision-making, not recruitment pressure. Most people who complete it decide *not* to run — and find other high-impact paths. That is an explicitly valid outcome.

**Step 1 — Honest Reality Check**
Not a pep talk. Time commitment (18–24 months near-full-time), financial reality (what platform candidates have actually raised), personal impact (opposition research, family exposure), statistical odds — unvarnished. Many people exit here and that's correct.

**Step 2 — Viability Assessment**
Pulls platform data for the user's specific race:
- District analysis: current holder's vulnerability score, next election date
- User's demonstrated appeal: platform engagement broken down by political identity and geography
- Estimated initial supporter pool based on years of platform contributions
- Realistic fundraising path without corporate money (with comparable examples)

**Step 3 — Authentic Platform Generation**
AI reviews the user's years of platform contributions and drafts their policy platform from what they've actually argued for publicly. Not consultant-crafted positions — documented, authentic positions with community support scores already attached. Can't be attacked as manufactured.

**Step 4 — Private Support Snapshot**
Without any public announcement, shows the user what the data suggests is already there: estimated early supporters in their state, platform users who have engaged with their contributions, aligned civic organizations, platform users with campaign experience willing to advise first-time candidates. Entirely private. Shows what's possible before any commitment.

**Step 5 — The Decision**
Three explicitly equal paths presented:
1. **Run for office** → proceeds to candidate onboarding
2. **Support a candidate** → connects to platform candidates who share their values
3. **Lead differently** → civic organizations, policy roles, community organizing tools

No path is presented as superior. The platform serves all three equally.

### From Decision to Campaign: 72 Hours
1. Hours 1–4: AI generates FEC filing docs, state requirements checklist, compliance calendar
2. Hours 4–24: Profile auto-populated from years of platform contributions (authentic platform, not consultant-crafted)
3. Hours 24–48: Announcement notifies followers, issue communities, geographic community
4. Hours 48–72: Fundraising, volunteer coordination, town hall scheduling — all live

### Platform vs Traditional Campaign Budget
Traditional Senate race: ~$10M. Platform candidate: ~$730k. Savings come from: volunteer professional network (lawyers, advisors), earned media from transparency story, platform community as organic reach, real-time constituent polling replacing paid polls, AI replacing consultants.

### Candidate Verification Levels
1. **Identity Verified** — Government ID + FEC registration + campaign email
2. **Transparency Pledge** — Signed commitment: 72hr response time, real-time donor visibility, specific positions, no deletions
3. **Community Verified** — Response rate >60%, 3+ town halls, specific policy positions
4. **Platform Champion** — Advocates for platform, introduces transparency legislation, governs on platform if elected

---

## Contribution Portal (Community Development)

The platform enables community members to contribute to its own development using AI assistance.

### Task Types
- **Type A (Data tasks, ~20 min):** Configuration files, translations, data mappings, algorithm parameters. Contributor copies pre-written prompt → pastes into Claude.ai → pastes JSON output back → auto-validated → live within hours. Zero code, zero Git, near-zero security risk.
- **Type B (Feature tasks, ~60–90 min):** New data source integrations, UI components. Sandboxed Claude session, auto-tested, human spot-check, staged then production.
- **Type C (Complex tasks):** Core infrastructure, smart contracts. Vetted contributors only, full review.

### Payment Options
1. Contributor's own Anthropic API key (stored client-side only, never server-side)
2. Civic credits (earned through platform engagement, spent on contribution API costs)
3. Financial contribution (fund the task so someone else can do it)
4. Community credit pool (donated credits any contributor can use)

### Economics
- Type A contribution costs platform: ~$0.20 API cost
- Type A contribution is worth: $200–500 in equivalent development
- Contributors earn 50 civic credits per completed task
- Contributors net-positive economically while building civic infrastructure

---

## Global Deployment

### Architecture
The jurisdiction framework makes global deployment a configuration change, not a rebuild:
- `jurisdictions` table is hierarchical: global → country → state → county → city
- Every entity belongs to a jurisdiction node
- Each country gets a configuration file defining its data sources, government structure, terminology mappings
- UI strings are localized per country (MP not Representative, Bill not Gesetzentwurf)

### Country Priority
- **Tier 1 (launch after US):** UK, Canada, Australia, New Zealand — English, strong open data
- **Tier 2:** Germany, France, Japan, South Korea, India
- **Tier 3 (highest impact, most resistance):** Brazil, South Africa, Mexico, Ukraine

### Censorship Resistance Hardening (for Tier 3)
- Tor hidden service (.onion address)
- ENS-based domain (ungovernable.eth) alongside .com
- IPFS accessible through multiple gateways
- I2P network as secondary anonymity layer
- Offline-capable PWA
- VPN partnership and access guides published for at-risk users
- ZK proof of personhood for identity (Worldcoin/Proof of Humanity)

### The Participation Paradox
Governments that participate: demonstrate democratic confidence. Governments that refuse: absence is documented data. Governments that attack the platform: confirm its necessity and generate international support. There is no good move for a bad actor.

---

## Funding Model

**No speculative token launch.** The platform is built on a nonprofit/cooperative hybrid structure:
- 501(c)(3) nonprofit holds the mission and core infrastructure
- Platform cooperative handles operations and member relationships
- Open source foundation governs shared technical infrastructure

### Revenue Stack
1. **Ad revenue** (transparent, civic-focused political ads with full on-chain disclosure) — target 60–70% of infrastructure costs
2. **Member contributions** (voluntary, "it costs $2.40/month to serve you — contribute what you can") — target 20–30%
3. **Institutional API access** — target 10–20%, primary path to financial independence
4. **Civic tech grants** (Knight Foundation, Mozilla, Democracy Fund, EU Horizon) — growth and development
5. **International deployment partnerships** — co-deployment with local NGOs, revenue sharing

### What We Avoid
No speculative token launch. No VC with 5-year exit expectations. No surveillance advertising. No behavioral targeting.

---

## Development Phases

### Phase 0 — Shared Infrastructure (Weeks 1–6)
Build once, use everywhere: monorepo scaffold, shared auth/wallet simulation, full database schema, shared UI components.

### Phase 1 — Governance App MVP (Weeks 7–16)
Data ingestion pipelines (USASpending, Congress.gov, FEC, CourtListener, regulations.gov, OpenStates), core entity pages (agencies, legislators, courts, proposals), community commenting, basic cached AI summaries, credit simulation in Supabase.

**Ship:** Public beta. Target 500 users. Apply for Knight Foundation/Mozilla grants.

### Phase 2 — Governance App Growth (Weeks 17–28)
Direct comment submission to regulations.gov API. AI power features (connection mapping, legislation drafting). Promise tracker. Official account invitation system (not yet verified). Apply for and receive first grants ($25k–$75k target).

**Ship:** V1 public launch. Headline feature: "Submit official government comments in 2 minutes."

### Phase 3 — Social App MVP (Weeks 29–40)
Launch to governance app users first (civic-minded early adopters). Feed, follow system, algorithm V1 (open source), civic bridge score, COMMONS simulation in Supabase. Algorithm marketplace seeded with 5 platform-built algorithms. Creator earnings dashboard.

### Phase 4 — Blockchain Integration (Weeks 41–56)
Replace Supabase credit simulation with real on-chain infrastructure. Privy embedded wallets, ERC-4337, Biconomy gas, session keys, social recovery. Migrate credit ledger to smart contract on Optimism. Deploy to testnet → audit (mandatory, $15k–$40k) → mainnet. Document hashing to Optimism. IPFS/Arweave pipelines.

**Never skip the smart contract audit.**

### Phase 5 — Crowdfunding & Official Engagement (Weeks 57–72)
Civic crowdfunding with milestone-based escrow (smart contract). Quadratic funding mechanism. Official account verification system (government email + cross-reference). UK/Canada deployment. Spanish and Portuguese language support.

### Phase 6 — Scale (Month 19+)
DAO governance activation. Community treasury. Open API. Institutional access tier. Additional country deployments. Revenue covers all costs; platform is self-sustaining.

---

## Cost Reference

| Item | Phase 1 | Phase 3 | Phase 5 |
|------|---------|---------|---------|
| Supabase | Free | $25/mo | $25/mo |
| Cloudflare R2 | $2/mo | $15/mo | $50/mo |
| Arweave | $5 one-time | $20/mo | $30/mo |
| Typesense | $0 | $6/mo | $25/mo |
| Claude Code | $20–100/mo | $100/mo | $200/mo |
| Claude API (AI features) | $0 | $50–100/mo | $200–500/mo |
| **Total** | **~$30/mo** | **~$200/mo** | **~$500/mo** |

**Break-even:** 10 institutional API customers at $49–$499/mo covers all infrastructure. Everything else is mission funding.

---

## Development Environment (Windows)

This project is developed on Windows 10. Use **WSL2** (Windows Subsystem for Linux) for all development work — not PowerShell or CMD directly.

**Why WSL2:**
- Node.js, npm scripts, and Turborepo behave correctly in a Linux environment
- Avoids line-ending and symlink issues that break monorepo tooling on native Windows
- Docker (required for local Supabase and Typesense) requires WSL2 on Windows
- Claude Code runs properly in WSL2 bash

**Setup checklist:**
```bash
# In WSL2 Ubuntu terminal:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
npm install -g @anthropic-ai/claude-code
npm install -g turbo
```

**File location:** Keep the project inside the WSL2 filesystem (`~/projects/civitics`), not on the Windows-mounted `/mnt/c/` drive. I/O performance on `/mnt/c/` is significantly slower and causes watch mode issues with Next.js and Turborepo.

---

## Open Questions

- [ ] Are governance app and social app separate Next.js apps or a single app with route groups?
- [ ] COMMONS token: which chain, what supply, what distribution schedule?
- [ ] Gas sponsorship daily limit per user
- [ ] Warrant canary automation: cron job, Cloudflare Worker, or scheduled Supabase function?
- [ ] Arweave upload: direct from client or proxied through backend?
- [ ] Supabase RLS strategy — document when finalized
- [ ] Algorithm marketplace governance: how are new algorithms approved/rejected?
- [ ] Smart contract audit firm selection
- [ ] Legal entity formation: Delaware LLC now, convert to nonprofit/cooperative at what milestone?
- [ ] Anthropic nonprofit/partnership rate: approach them at what stage?
- [ ] Civic talent score: opt-in or opt-out by default?
- [ ] Contributor onboarding agent(Phase 2-3, when first outside contributors arrive) 
- [ ] Candidate onboarding agent(Phase 5, candidate tools)  
- [ ] Civic action agent(Phase 2, core feature)
- [ ] Compute donation system Smart contract for
      API funding pool
      Transparency dashboard
      Donor attribution system
      Built Phase 1-2     
- [ ] Agent routing logic
      Pro → API switchover
      Priority queue design
      Human oversight system
      Built Phase 0-1
- [ ] Contributor onboarding agent
      (Phase 2-3, when first
       outside contributors arrive)     
- [ ] Candidate onboarding agent
      (Phase 5, candidate tools)    
- [ ] Civic action agent
      (Phase 2, core feature)

---

## What Not To Do

- Do not store precise user coordinates anywhere in the database
- Do not show blockchain addresses, transaction hashes, or network names in user-facing UI, except at advanced users request
- Do not require tokens or credits for any official comment submission
- Do not use client-side Supabase calls that bypass RLS
- Do not add gas fee prompts or wallet pop-ups — Biconomy handles this silently
- Do not build AI features before the credit/revenue mechanism to pay for them is live
- Do not use React Flow for the connection graph — use D3 force simulation from day one
- Do not use AWS S3 — use Cloudflare R2 (no egress fees)
- Do not launch a speculative token — the COMMONS token is utility only, earned not bought
- Do not make the governance app feel like social media — it must feel like serious civic infrastructure
- Do not conflate the two products in the UX — keep governance app and social app tonally separate
- Do not skip the smart contract audit before mainnet deployment
- Do not open-end AI API access without rate limits and credit gating
- Do not store full resolution user location — always coarsen to district level
