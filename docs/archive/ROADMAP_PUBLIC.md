# Civitics — Public Roadmap

A short, public-facing view of where Civitics is heading. For the internal
phase-by-phase plan with architecture notes and sequencing, see
[ROADMAP.md](../ROADMAP.md). For granular task tracking,
see [PHASE_GOALS.md](../PHASE_GOALS.md).

Last updated: 2026-04-18.

---

## North Star

A world map, dark at first. District by district, it gets brighter as
democratic accountability increases — as officials engage with constituents,
as promises are kept, as donors and votes are connected in plain sight.

**Every feature we build should make that map brighter.**

---

## Where we are

**Phase 1 — MVP · ~88% complete**

Civitics today is a working civic data platform covering the United States
federal government and most state legislatures:

- **8,251 officials** tracked across Congress, state legislatures, and the
  federal judiciary
- **2,066 proposals** from Congress and Regulations.gov, with AI-generated
  plain-language summaries
- **227,153 votes** (51k of them live as typed graph connections; full
  backfill in progress)
- **143,077 connections** — donations, votes, oversight, appointments
- **$1.75B in tracked donations** across 19,647 donor-to-official relationships
- **Connection graph** — force-directed visualization of the whole network,
  with chord, treemap, and sunburst views layered on top
- **Civic initiatives** — community-authored proposals with arguments, a
  quality gate, signature collection, and a formal response window for
  officials
- **Universal search** — across officials, proposals, agencies, and donors
- **Public comment submission** to regulations.gov, always free
- **Privacy by default** — coordinates coarsened to district level before
  storage; no precise geolocation anywhere in the system

---

## What's next

### Shipping soon (Phase 1 completion)

- Full vote-connection backfill (227k total)
- Email notifications for followed officials and agencies
- Content moderation tooling — flag queue + admin review
- First 500 beta users onboarded
- Grant applications submitted (Knight, Mozilla, Democracy Fund)

### Phase 2 — Growth

> Done when: the platform is financially self-sustaining, first institutional
> API customer signed, first grant money received.

**Accountability tools**
- Promise tracker live
- Donor impact calculator
- Revolving door tracker
- Vote pattern analyzer

**Graph enhancements**
- Timeline scrubber — animate the graph through time
- Committee Power preset — who sits where, who funds them
- Industry Capture preset — which industries dominate each chamber
- Co-Sponsor Network preset — legislative alliances

**AI power features**
- Connection mapping queries ("who connects X to Y?")
- Comment drafting assistant
- "What does this mean for me?" — personalized to your district and the
  officials you follow

**Institutional API**
- Versioned public API (`/api/v1/`) — officials, proposals, votes, donations,
  connections, path-finding
- Tiered access: Researcher ($49), Nonprofit ($149), Professional ($499),
  Enterprise (custom)

**Infrastructure**
- Core Web Vitals budget enforcement
- Edge caching for read-heavy routes
- Multi-region database read replicas

### Phase 3 — Social App

> Reach mainstream users without ever letting the civic app feel like social media.

- Bipartisan social platform with the COMMONS token economy
- Civic bridge score — measures cross-partisan engagement
- Open, auditable algorithm with a marketplace of community variants
- Creator earnings dashboard
- Real-time collaborative editing on civic initiatives

### Phase 4 — Blockchain (invisible)

Blockchain is infrastructure. Users never see it.

- Embedded wallets via Privy (no seed phrases, ever)
- ERC-4337 account abstraction · zero gas UX via Biconomy sponsorship
- Civic credits on-chain (Optimism)
- Smart contract audit — always before mainnet deploy
- IPFS + Arweave for permanent public record
- Warrant canary on-chain — weekly automated attestation of non-compromise

### Phase 5 — Global

- UK and Canada deployment
- Spanish and Portuguese language support
- Official account verification (government email + cross-reference)
- Civic crowdfunding with escrow
- DAO governance + community treasury

---

## What we will never do

- **Paywall civic participation.** Reading public records and submitting
  positions on government proposals is free forever.
- **Paywall official comment submission.** It's a constitutional right —
  no fees, no credits, no tokens.
- **Expose blockchain internals.** No wallet addresses, transaction hashes,
  gas prompts, or network names in the UI. Ever.
- **Store precise location data.** Geography is coarsened to district/zip
  level before any insert.
- **Build engagement-bait features.** Civitics is closer to a court of
  record than Twitter. Dense information display is a feature, not a bug.
- **Launch a speculative token.** COMMONS is a utility credit — earned,
  not bought.

---

## How the platform sustains itself

Civitics has to be financially self-sustaining without extracting value from
the people it serves. The revenue model reflects that:

| Stream | Phase | Notes |
|---|---|---|
| Institutional API | 2 | Research orgs, newsrooms, campaigns |
| Open Collective / GitHub Sponsors | 2 | Community funding |
| Grants | Active | Knight, Mozilla, Democracy Fund |
| AI credit packs | 2 | For power users only — never required |
| COMMONS creator economy | 3 | Earned through platform contribution |
| Compute pool | 4 | On-chain coordination for shared infrastructure |

**Free tier covers 90% of citizen needs.** Full data access, unlimited
cached AI summaries, connection graph up to 3 hops, bill tracker for 20 bills,
unlimited official comment submission.

---

## Get involved

- **Use the platform** at [civitics.com](https://civitics.com).
  Report anything that's wrong, unclear, or missing.
- **Contribute code** — see [CONTRIBUTING.md](../../CONTRIBUTING.md).
- **Build on the data** — the institutional API is coming in Phase 2; open
  an issue if you have a use case we should design for.
- **Fund the work** — grant contacts and sponsorship options will appear on
  the homepage as Phase 2 opens.
