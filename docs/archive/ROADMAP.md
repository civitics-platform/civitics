# Civitics Platform — Roadmap

Strategic direction, phase goals, and long-horizon initiatives.
Tactical bugs and near-term UX fixes live in `docs/FIXES.md`.
Granular task tracking lives in `docs/PHASE_GOALS.md`.

Last updated: 2026-04-12

---

## The North Star

A world map, dark at first. District by district, it gets brighter as democratic accountability increases — as officials engage with constituents, as promises are kept, as donors and votes are connected in plain sight.

**Every feature we build should make that map brighter. If it doesn't, we don't build it.**

---

## Current Phase: Phase 1 — MVP (~88% complete)

> **Done when:** Vote backfill complete, search ranking fixed, auth tested end-to-end, grant applications submitted, first 500 users.

**Remaining Phase 1 tasks (see PHASE_GOALS.md for full list):**
- Vote backfill — 51k/227k done, pending IO recovery
- Community commenting UI
- Position tracking on proposals
- Follow officials/agencies
- Grant applications submitted (Knight, Mozilla, Democracy Fund)
- 500 beta users

---

## Phase 2 — Growth `Weeks 11–22`

> **Done when:** Platform financially self-sustaining, first institutional API customer, first grant money received.

### Scalability & Infrastructure
- Connection pooling audit (Supabase PgBouncer + pooled connection strings)
- CDN edge caching for read-heavy API routes
- Multi-region database read replicas
- Pipeline retry logic and dead-letter queues
- Performance budget enforcement (LCP < 2.5s, CLS < 0.1)
- Custom storage domain (Cloudflare R2)

### Accountability Tools
- Official comment submission → regulations.gov API (constitutional feature — always free)
- Promise tracker live
- Donor impact calculator
- Vote pattern analyzer
- Revolving door tracker

### Graph Enhancements
- Timeline scrubber — animate graph state through time with a play button
- Committee Power preset — who sits on which committees, and who funds them
- Industry Capture preset — which industries dominate each chamber
- Co-Sponsor Network preset — legislative alliances
- Community presets — user-saved named presets (`graph_presets` table)

### AI Power Features
- Connection mapping queries ("who connects X to Y?")
- Comment drafting assistant
- Legislation drafting studio
- FOIA request builder
- "What does this mean for me?" — personalized query based on user's district and followed officials

### Candidate Tools
- Candidate profile verification system
- "Should I run?" explorer (5-step flow)
- 72-hour campaign launch system

### Revenue
- Institutional API v1 live
- First paying institutional customer
- Open Collective donations active
- First grant received

### Agents & Automation
- AI-assisted pipeline scheduling and anomaly detection
- Automated nightly data quality reports
- AI content moderation assist (flag queue + confidence scoring)
- Automated regulatory alert emails (new proposals in followed agencies)

---

## Phase 3 — Social App `Weeks 23–34`

> The distribution vehicle. Censorship-resistant platform with COMMONS token economy. Reaches mainstream users → introduces them to civic tools. Shares identity, wallet, and content infrastructure with the Civitics App but is kept visually and tonally separate.

### Core Social
- Social feed + follow system
- COMMONS token simulation in Supabase (pre-blockchain)
- Algorithm v1 (open source, auditable)
- Bipartisan feed mechanics (bridge score, viewpoint diversity signals)
- Creator earnings dashboard
- Algorithm marketplace seeded with 3 community-built variants

### Civic Bridge
- Civic bridge score — measures cross-partisan engagement
- Cross-platform identity (shared with Civitics App)
- Cat memes welcome

### Collaboration
- Real-time collaborative editing on Civic Initiatives
- Co-authorship on initiative proposals
- Structured moderation: community-elected moderators, transparent appeal process

### Redundancy & Global Readiness
- Multi-region failover architecture
- CDN node configuration for international traffic
- Internationalization (i18n) architecture in place — no translations yet, but string extraction done

---

## Phase 4 — Blockchain `Weeks 35–50`

> Blockchain is always invisible to users. No seed phrases, wallet addresses, gas fees, or network names in UI. All costs sponsored.

- Privy embedded wallets live (invisible onboarding)
- ERC-4337 account abstraction
- Biconomy gas sponsorship (zero gas UX)
- Civic credits on-chain (Optimism)
- Compute pool smart contract deployed
- **Smart contract audit completed** ← never skip
- IPFS + Arweave pipelines live (permanent public record)
- Warrant canary on-chain — weekly automated attestation of non-compromise

---

## Phase 5 — Global `Weeks 51–66`

- Civic crowdfunding with escrow
- Official account verification system (government email + cross-reference)
- UK + Canada deployment
- Spanish + Portuguese language support
- DAO governance activation
- Community treasury live

---

## Open Source Strategy

Civitics is designed to be forkable. Parts of the platform are specifically architected as spin-off candidates:

- `packages/graph` — D3 force graph with civic node types; usable independently
- `packages/maps` — Mapbox + Deck.gl civic mapping utilities
- `packages/ai` — Claude API service layer with cost gating
- `packages/blockchain` — ERC-4337 + Biconomy abstraction layer

**Standardization goals:**
- All API routes documented (OpenAPI spec)
- All packages have their own README
- Contributing guide in root
- Visual architecture overview in root README

---

## Revenue Model (Platform Earns Are Never Extractive)

| Stream | Status | Notes |
|--------|--------|-------|
| Institutional API | Phase 2 | Research orgs, newsrooms, campaigns |
| Open Collective / GitHub Sponsors | Phase 2 | Community funding |
| Grant funding | Active | Knight, Mozilla, Democracy Fund applications |
| AI credit packs (power users) | Phase 2 | Never required for civic participation |
| COMMONS creator economy | Phase 3 | Earned, not bought |
| Compute pool | Phase 4 | On-chain coordination |

**Non-negotiables:**
- Official comment submission is always free
- Reading and submitting positions on government proposals is free forever
- Free tier covers 90% of citizen needs
