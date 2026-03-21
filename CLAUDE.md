# CLAUDE.md — Civitics Platform

Authoritative reference for the Civitics platform. Read before writing any code.
Update when architecture decisions change. Last updated: March 2026.

---

## Mission

Restore democratic power to its rightful owners — the people. Facilitate collaboration across all political, religious, language, and geographic barriers. Bring together data on all public institutions and officials, make it easy for anyone to explore, and provide powerful tools for citizens, researchers, journalists, and investigators. Make government promises permanent public record. Give average people a genuine seat at the table.

---

## The North Star

A world map, dark at first. District by district, it gets brighter as democratic accountability increases — as officials engage with constituents, as promises are kept, as donors and votes are connected in plain sight.

**Every feature we build should make that map brighter. If it doesn't, we don't build it.**

---

## What This Is

Two distinct products sharing one infrastructure:

1. **Civitics App** — The mission vehicle. "Wikipedia meets Bloomberg Terminal for democracy." Structured civic data, legislative tracking, public comment submission, connection graph, maps, AI accountability tools. Serious civic infrastructure — never social media.

2. **Social App** — The distribution vehicle. Censorship-resistant platform with COMMONS token economy. General civic discourse, bipartisan feed mechanics, creator economy, algorithm marketplace. Cat memes are welcome.

Social app reaches mainstream users → introduces them to civic tools. They share identity, wallet, and content infrastructure but are kept visually and tonally separate.

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

---

## Package Documentation

| Package | Topics |
|---------|--------|
| `packages/db/CLAUDE.md` | Supabase clients, schema conventions, entity_connections correction, RLS, storage, migrations |
| `packages/data/CLAUDE.md` | Pipelines, FEC bulk strategy, storage budget, per-source rules, update schedules |
| `packages/graph/CLAUDE.md` | D3 graph, node types, smart expansion, strength filter, share codes, presets |
| `packages/ai/CLAUDE.md` | Claude API, model routing, credit gating, caching, cost rules |
| `packages/maps/CLAUDE.md` | Mapbox, Deck.gl, PostGIS patterns, privacy rules, geographic data |
| `packages/blockchain/CLAUDE.md` | Chains, wallets, audit requirement, Two Economies, compute pool |
| `apps/civitics/CLAUDE.md` | Tone, data rules, user tiers, institutional API, candidate tools, build rules |

---

## Claude Code Permissions

Auto-approved: pnpm commands, file creation/editing, directory creation, git read ops, git commits and pushes

Always requires approval: any deletion (rm/rmdir), destructive git, .env changes, global installs, external network calls

Never without explicit confirmation: DROP/TRUNCATE/DELETE SQL, modifying existing migrations, changes to .gitignore, exposing credentials

---

## Package Manager

**pnpm — not npm, not yarn**

```
pnpm install    pnpm add X    pnpm dev    pnpm dlx X
```

Never commit `node_modules`. Never use npm or yarn.

---

## Environment Variables

Local development: .env.local
  Gitignored, never committed
  
Production: Vercel Dashboard
  Settings → Environment Variables
  Encrypted at rest
  Never in code files

These are equivalent but separate:
  .env.local = local secrets
  Vercel env vars = production secrets

Both must be kept in sync manually
When adding a new API key:
  1. Add to .env.local
  2. Add to Vercel immediately
  3. Add key name (no value)
     to .env.example
  4. Update CLAUDE.md if relevant

## Supabase API Keys

Use NEW format keys only:
```
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   (sb_publishable_xxx)  — client-side
SUPABASE_SECRET_KEY                    (sb_secret_xxx)       — server-only
```
Never use legacy `anon` / `service_role` keys. Never use `NEXT_PUBLIC_` on the secret key.

See `packages/db/CLAUDE.md` for full client documentation.

---

## Supabase Clients (Summary)

```
createBrowserClient()          → 'use client' components
createServerClient(cookies())  → Server Components, Route Handlers (respects RLS)
createAdminClient()            → Server only, pipelines only (bypasses RLS)
```

**Every route/page using `createAdminClient()` must have:**
```ts
export const dynamic = "force-dynamic";
```
Without this, Next.js calls it at build time → fails on Vercel (secret key unavailable).

**`generateStaticParams`:** use `createClient()` from `@supabase/supabase-js` with publishable key — never `createAdminClient()`.

Import from `@civitics/db`, not directly from `@supabase/supabase-js`.

---

## Active App Directory — CRITICAL

```
apps/civitics/app/       ← ACTIVE — always edit here
apps/civitics/src/app/   ← INACTIVE — silently ignored by Next.js
```

---

## Deployment

Run `pnpm build` locally before every push. Vercel uses strict TypeScript. Build must pass clean.

---

## Current Phase: Phase 1 (~65% complete)

See `docs/PHASE_GOALS.md` for detailed task tracking.

**Done when:** Search works, proposal pages live, auth working, 500 beta users, grant applications submitted.

Key remaining Phase 1 tasks:
- [ ] Proposals list + detail pages (`/proposals/`, `/proposals/[id]`)
- [ ] Search component + API route
- [ ] User auth (Supabase)
- [ ] AI narrative on graph ("Explain this graph")

---

## votes Table — Actual Column Names

```
vote      (not vote_cast)
  values: 'yes' | 'no' | 'present' | 'not voting'
voted_at  (not vote_date)
metadata->>'vote_question'   procedural type string (e.g. "On Passage", "On the Cloture Motion")
metadata->>'legis_num'       bill number
```

Do NOT use vote_cast or vote_date — those columns do not exist.

---

## generateStaticParams Rules

```
ALWAYS use try/catch — return [] on any error
ALWAYS wrap the query in Promise.race with a 5s timeout
ALWAYS limit to 50 rows max
ALWAYS use NEXT_PUBLIC keys only (never createAdminClient)
NEVER let a build fail due to DB unavailability

Timeout pattern:
  const { data } = await Promise.race([
    supabase.from("table").select("col").limit(50),
    new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error("timeout") }), 5000)
    ),
  ]);

If DB is unavailable: build succeeds with [] → pages render on-demand (ISR)
```

---

## What Not To Do

- Do not store precise user coordinates — always coarsen to district level
- Do not show blockchain addresses, tx hashes, or network names in UI
- Do not require credits for official comment submission
- Do not use client-side Supabase calls that bypass RLS
- Do not build AI features before the credit/revenue mechanism is live
- Do not use React Flow for the connection graph — D3 force simulation only
- Do not use AWS S3 — use Cloudflare R2 (no egress fees)
- Do not launch a speculative token — COMMONS is utility, earned not bought
- Do not make the governance app feel like social media
- Do not skip the smart contract audit before mainnet deployment
- Do not open-end AI API access without rate limits and credit gating
- Do not add gas fee prompts — Biconomy handles this silently
