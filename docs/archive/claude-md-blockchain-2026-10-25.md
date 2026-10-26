# Archived packages/blockchain/CLAUDE.md — pre-haircut copy (cc-249, FIX-1347)
Copied from commit ea608d16 (the file last changed in 314e1701). Byte-for-byte below these three lines: no relative link needed re-pointing for pnpm check:doc-links.
See docs/cc/reports/cc-246.md (read 9) for the per-section letters; cc-249 re-verified each kept line against the tree.
# packages/blockchain/CLAUDE.md

## Purpose
Wallet integration, smart contract ABIs, chain configuration, ERC-4337 account abstraction.

---

## Status: Phase 4 (Not Started)

Blockchain infrastructure is planned for Phase 4 (Weeks 41–56). The package structure exists
but contains no live contract deployments. Current credit system runs in Supabase as a simulation.

---

## Chain Selection

| Chain | Role | Why |
|-------|------|-----|
| **Optimism** | Primary | Mission-aligned — public goods funding via RetroPGF. Decentralized. |
| **Base** | Secondary | US user onboarding, Coinbase fiat onramp. Shares OP Stack. |
| **Polygon** | International | Cheapest transactions. Strong in emerging markets. |

Users never know which chain they're on. Platform routes to cheapest available.
Advanced users can choose their chain if they request it — disabled by default.

---

## Blockchain Roles (What It's For)

- Civic credit ledger (soulbound, non-transferable)
- Document hashing (official comments, promise records)
- Warrant canary (weekly automated attestation to Optimism)
- Treasury transparency
- COMMONS token on-chain mechanics (Phase 3+)
- Civic action records (public, permanent)

**NOT speculative tokens.** This is infrastructure, not a token launch.

---

## User-Facing Rules (Non-Negotiable)

- Never show wallet addresses in UI
- Never show transaction hashes in UI
- Never show network names in UI ("Optimism", "Base", etc.)
- Never show gas fees or gas fee prompts
- Never show seed phrases — ever
- No wallet pop-ups during normal flows
- Biconomy handles all gas sponsorship silently
- Privy handles all wallet creation invisibly (email/social login)

Advanced users may request to see wallet details — disabled by default, enabled on request.

---

## Auth & Wallet Stack

- **Privy** — Invisible wallet creation via email/social login. Users never see a seed phrase.
- **ERC-4337 (Account Abstraction)** — Smart contract wallets with session keys. Multiple actions without re-signing.
- **Biconomy** — Paymaster for gas sponsorship. Platform tops up gas tank; users pay $0.
- Social recovery replaces seed phrases entirely.
- Government email required for official account verification (Phase 5).

---

## Smart Contract Audit

**Never skip the audit. Never deploy to mainnet without it.**

- Budget: $15,000 – $40,000
- Required before any mainnet deployment
- Run on testnet first → fix all findings → re-audit if critical issues found → mainnet
- Audit firm: TBD (open question)
- Do not let timeline pressure compromise this

---

## The Two Economies

### Civic Credits
- **Non-transferable, non-speculative** — cannot be bought or sold
- Soulbound on-chain: permanent civic participation record
- Earned through civic activity: official comments, bridging, verified contributions
- Spent on AI features: extra queries, comment drafts, connection mapping
- Active civic users earn more than they spend — never need to pay
- Currently simulated in Supabase (Phase 1–3); moves on-chain in Phase 4

### COMMONS Token
- **Transferable, exchangeable for USDC** — creators can pay rent with this
- Earned through quality content creation (engagement depth × civic bridge multiplier × authenticity score)
- **Cannot be bought directly** — earned or received as tip (prevents wealth buying influence)
- Exchangeable for USDC (1:1 minus small fee), civic credits, or real-world value
- Platform cut: **10% fixed, published, immutable**
- Currently simulated in Supabase (Phase 3); moves on-chain in Phase 4

### The Bridge
Civic credits ↔ COMMONS. One identity, two economies, same mission.

---

## Compute Pool Contract (Designed, Not Yet Built)

A smart contract that:
- Accepts API compute donations from the community
- Funds AI queries for users who can't afford credits
- Provides transparency dashboard: who donated, how much was used, for what
- Donor attribution system
- Planned for Phase 1–2 implementation

---

## Open Questions

- [ ] COMMONS token: exact chain, supply, distribution schedule?
- [ ] Gas sponsorship daily limit per user?
- [ ] Warrant canary automation: cron job, Cloudflare Worker, or Supabase scheduled function?
- [ ] Arweave upload: direct from client or proxied through backend?
- [ ] Smart contract audit firm selection
- [ ] Agent routing logic: Pro → API switchover, priority queue, human oversight
