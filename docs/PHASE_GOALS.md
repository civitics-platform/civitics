# Civitics Platform — Phase Goals

> This file tracks progress against the phased development plan defined in `CLAUDE.md`.
> Update checkboxes as tasks complete. Phases are sequential; each unlocks the next.

---

## Phase 0 — Scaffold ✓ `Weeks 1–2` `100% complete`

### Infrastructure
- [x] Turborepo monorepo scaffolded
- [x] Next.js apps: `civitics` + `social`
- [x] pnpm workspace configured
- [x] Shared packages structure (`ui`, `db`, `blockchain`, `maps`, `graph`, `ai`, `auth`, `config`)
- [x] Tailwind CSS configured

### Accounts & Services
- [x] civitics.com domain registered
- [x] GitHub repo live (`civitics-platform/civitics`)
- [x] Supabase project created
- [x] Anthropic, Vercel, Resend, Sentry accounts
- [x] New Supabase API keys (not legacy)
- [x] `.env.local` and `.env.example` created

### Database
- [x] Phase 1 schema migrated (9 tables)
- [x] PostGIS, uuid-ossp, pgcrypto, pg_trgm enabled
- [x] RLS enabled on all tables
- [x] Supabase client connected (3 clients)

### First Visual
- [x] Homepage running at `localhost:3000`
- [x] Connection graph at `/graph` with D3
- [x] `CLAUDE.md` written and committed

---

## Phase 1 — MVP `Weeks 3–10` `25% complete` ← **current**

> **Done when:** 500 beta users, real government data loading, at least one complete user journey (search → official → vote record → donor → connection graph), grant applications submitted.

### Data Ingestion Pipelines
- [x] Congress.gov API → officials + votes
- [x] FEC API → financial_relationships (pipeline live, running)
- [x] USASpending.gov → spending_records (2,000 records, FY2024 contracts)
- [x] Regulations.gov → proposals + comment periods (1,000 proposed rules)
- [x] OpenStates → state legislators (1,445 state legislators, all 50 states)
- [x] CourtListener → judges + rulings (365 judges, 280 opinions)
- [x] Master orchestrator + scheduler (daily/weekly cron)

### Core Pages
- [x] Official profile page with real data (list + /officials/[id] standalone)
- [x] Agency profile page (/agencies list + /agencies/[id] profile)
- [ ] Proposal detail page
- [ ] Search across all entities
- [x] Homepage wired to real data

### AI Features
- [ ] Plain language bill summaries (cached)
- [ ] Basic credit system in Supabase
- [ ] "What does this mean for me" query

### Community
- [x] Public accountability dashboard (`/dashboard`) live
- [ ] User auth via Supabase
- [ ] Community commenting on entities
- [ ] Position tracking on proposals
- [ ] Follow officials and agencies

### Maps
- [ ] Mapbox account + API key
- [ ] District finder from address
- [ ] "Find your representatives" map

---

## Phase 2 — Growth `Weeks 11–22` `Planned`

> **Done when:** Platform financially self-sustaining, official comment submission working, first institutional API customer, first grant money received.

### Accountability Tools
- [ ] Official comment submission → regulations.gov API
- [ ] Promise tracker live
- [ ] Donor impact calculator
- [ ] Vote pattern analyzer
- [ ] Revolving door tracker

### AI Power Features
- [ ] Connection mapping queries
- [ ] Comment drafting assistant
- [ ] Legislation drafting studio
- [ ] FOIA request builder

### Candidate Tools
- [ ] Candidate profile verification system
- [ ] "Should I run?" explorer (5-step flow)
- [ ] 72-hour campaign launch system

### Revenue
- [ ] Institutional API v1 live
- [ ] First paying institutional customer
- [ ] Open Collective donations active
- [ ] First grant received

---

## Phase 3 — Social App `Weeks 23–34` `Planned`

- [ ] Social feed + follow system
- [ ] COMMONS token simulation in Supabase
- [ ] Algorithm v1 (open source)
- [ ] Civic bridge score
- [ ] Creator earnings dashboard
- [ ] Algorithm marketplace seeded
- [ ] Bipartisan design mechanics
- [ ] Social app name decided

---

## Phase 4 — Blockchain `Weeks 35–50` `Planned`

- [ ] Privy embedded wallets live
- [ ] ERC-4337 account abstraction
- [ ] Biconomy gas sponsorship
- [ ] Civic credits on-chain (Optimism)
- [ ] Compute pool smart contract deployed
- [ ] Smart contract audit completed ← **never skip**
- [ ] IPFS + Arweave pipelines live
- [ ] Warrant canary on-chain (weekly automated attestation)

---

## Phase 5 — Global `Weeks 51–66` `Planned`

- [ ] Civic crowdfunding with escrow
- [ ] Official account verification system (government email + cross-reference)
- [ ] UK + Canada deployment
- [ ] Spanish + Portuguese language support
- [ ] DAO governance activation
- [ ] Community treasury live
