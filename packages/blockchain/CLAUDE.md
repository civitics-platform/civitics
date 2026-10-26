# packages/blockchain/CLAUDE.md

Wallets, contract ABIs, chain config, ERC-4337 — **Phase 4, not started.** No
contract is deployed; the civic-credit system is simulated in Supabase, and
identity is Supabase Auth. The design (chains, the Two Economies, the compute
pool, open questions) is `docs/archive/claude-md-blockchain-2026-10-25.md`.

## User-facing rules

Blockchain is invisible: no seed phrases, wallet addresses, transaction
hashes, gas fees or network names in the UI — `docs/ONBOARDING.md` §Core
Principles.

## Smart contract audit

**Never deploy to mainnet without an audit.** Testnet first, fix every
finding, re-audit on a critical one, then mainnet. Timeline pressure never
skips it.
