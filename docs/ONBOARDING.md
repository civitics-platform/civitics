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

(This section is the tone's home. `apps/civitics/CLAUDE.md` carried a copy until cc-246; it is in [`archive/claude-md-apps-civitics-2026-10-24.md`](archive/claude-md-apps-civitics-2026-10-24.md).)

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
| `packages/db/CLAUDE.md` | The three clients and the force-dynamic rule, the column traps (EC, FR/FE, officials, vote_category), **materialization pattern for slow request-path aggregations**, the merge-surface rule, autovacuum tuning, storage, migration conventions, `db:types` |
| `packages/data/CLAUDE.md` | Update schedules (pointers to the job registry), EC derivation, the per-source writer contracts (FEC, IRS 990, USASpending, OpenStates, TIGER), the FEC indiv stage and the $200 aggregate floor |
| `packages/graph/CLAUDE.md` | Viz switching is style-only, D3, real-time wiring, the connection-type registry, interaction and screenshot contracts, the watermark, smart expansion, strength filter, the V2 field-name contract |
| `packages/ai/CLAUDE.md` | The cost rule, the pricing pointer (`ai-pricing.ts`), the cost gate every AI pipeline calls first, the API keys |
| `packages/maps/CLAUDE.md` | Privacy (coarsen coordinates), the GIST + `query_districts` rules, the TIGER boundary loads, visual principles |
| `packages/blockchain/CLAUDE.md` | Phase 4 status, the invisible-blockchain rule, the audit requirement |
| `apps/civitics/CLAUDE.md` | Data rules, the `withDbTimeout` rule, pointers for the build and hydration traps |

---

## What Not To Do — Mission and Product Rules

(The operational/runtime "do nots" root `CLAUDE.md` used to list are in its archive copy, [`archive/claude-md-root-2026-10-23.md`](archive/claude-md-root-2026-10-23.md#what-not-to-do).)

- Do not store precise user coordinates — always coarsen to district level
- Do not show blockchain addresses, tx hashes, or network names in UI
- Do not require credits for official comment submission
- Do not use React Flow for the connection graph — D3 force simulation only
- Do not use AWS S3 — use Cloudflare R2 (no egress fees)
- Do not launch a speculative token — COMMONS is utility, earned not bought
- Do not make the governance app feel like social media
- Do not add gas fee prompts — Biconomy handles this silently
