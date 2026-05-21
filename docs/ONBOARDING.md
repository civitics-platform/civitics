# Onboarding — Civitics Platform

Read this once on your way in. For every-session operational reference, see
[`/CLAUDE.md`](../CLAUDE.md).

---

## Mission

Restore democratic power to its rightful owners — the people. Facilitate
collaboration across all political, religious, language, and geographic
barriers. Bring together data on all public institutions and officials, make it
easy for anyone to explore, and provide powerful tools for citizens,
researchers, journalists, and investigators. Make government promises permanent
public record. Give average people a genuine seat at the table.

---

## The North Star

A world map, dark at first. District by district, it gets brighter as
democratic accountability increases — as officials engage with constituents, as
promises are kept, as donors and votes are connected in plain sight.

**Every feature we build should make that map brighter. If it doesn't, we don't
build it.**

---

## What This Is

Two distinct products sharing one infrastructure:

1. **Civitics App** — The mission vehicle. "Wikipedia meets Bloomberg Terminal
   for democracy." Structured civic data, legislative tracking, public comment
   submission, connection graph, maps, AI accountability tools. Serious civic
   infrastructure — never social media.

2. **Social App** — The distribution vehicle. Censorship-resistant platform
   with COMMONS token economy. General civic discourse, bipartisan feed
   mechanics, creator economy, algorithm marketplace. Cat memes are welcome.

Social app reaches mainstream users → introduces them to civic tools. They
share identity, wallet, and content infrastructure but are kept visually and
tonally separate.

---

## Tone and Design Philosophy

**Serious civic infrastructure — not social media.**

- Closer to a court of record than Twitter
- Dense information display is a feature, not a bug — users came here to learn
- Bloomberg Terminal feel: data-rich, fast, trustworthy
- Never feel like a "politics tab" — no engagement bait, no outrage optimization
- Must never be conflated with the social app in UX or tone

(App-specific tone notes live in [`apps/civitics/CLAUDE.md`](../apps/civitics/CLAUDE.md).)

---

## Core Principles (Non-Negotiable)

- **Official comment submission is always free** — No fees, tokens, or credits required. Constitutional right.
- **No paywalling civic participation** — Reading and submitting positions on government proposals is free forever.
- **Blockchain is invisible** — No seed phrases, wallet addresses, gas fees, or network names in UI.
- **No gas fees for users** — All costs sponsored via Biconomy, ERC-4337.
- **Geography is never stored precisely** — Coarsen to district/zip level before any INSERT.
- **Warrant canary on-chain weekly** — Signed attestation of non-compromise written to Optimism.
- **Platform earns are never extractive** — Revenue model aligned with civic mission.
- **Free tier is genuinely powerful** — Covers 90% of citizen needs.

---

## Monorepo Structure

**Tooling:** Turborepo / pnpm

```
/apps
  /civitics    # Next.js civic governance app  → see apps/civitics/CLAUDE.md
  /social      # Next.js social/COMMONS app
/packages
  /ui          # Shared Tailwind component library
  /db          # Supabase client, schema, migrations  → see packages/db/CLAUDE.md
  /blockchain  # Wallet, ABIs, chain config, ERC-4337 → see packages/blockchain/CLAUDE.md
  /maps        # Mapbox GL + Deck.gl utilities        → see packages/maps/CLAUDE.md
  /graph       # D3 force simulation (connection graph)→ see packages/graph/CLAUDE.md
  /ai          # Shared Claude API service layer      → see packages/ai/CLAUDE.md
  /auth        # Privy integration, session management
  /config      # Shared ESLint, TypeScript, Tailwind configs
```

### Package Documentation

| Package | Topics |
|---------|--------|
| `packages/db/CLAUDE.md` | Supabase clients, schema conventions, entity_connections correction, RLS, **materialization pattern for slow request-path aggregations**, storage, migrations |
| `packages/data/CLAUDE.md` | Pipelines, FEC bulk strategy, storage budget, per-source rules, update schedules |
| `packages/graph/CLAUDE.md` | D3 graph, node types, smart expansion, strength filter, share codes, presets |
| `packages/ai/CLAUDE.md` | Claude API, model routing, credit gating, caching, cost rules |
| `packages/maps/CLAUDE.md` | Mapbox, Deck.gl, PostGIS patterns, privacy rules, geographic data |
| `packages/blockchain/CLAUDE.md` | Chains, wallets, audit requirement, Two Economies, compute pool |
| `apps/civitics/CLAUDE.md` | Tone, data rules, user tiers, institutional API, candidate tools, build rules |

---

## What Not To Do — Mission and Product Rules

(Operational/runtime "do nots" live in [`/CLAUDE.md`](../CLAUDE.md#what-not-to-do).)

- Do not store precise user coordinates — always coarsen to district level
- Do not show blockchain addresses, tx hashes, or network names in UI
- Do not require credits for official comment submission
- Do not use React Flow for the connection graph — D3 force simulation only
- Do not use AWS S3 — use Cloudflare R2 (no egress fees)
- Do not launch a speculative token — COMMONS is utility, earned not bought
- Do not make the governance app feel like social media
- Do not add gas fee prompts — Biconomy handles this silently
