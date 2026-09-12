# Contributing to Civitics

Thanks for considering a contribution. Civitics is civic accountability
infrastructure — we care as much about correctness and neutrality as we do
about features. This guide covers the setup, workflow, and conventions
needed to land a change.

> **Before anything else:** read [README.md](README.md) for what the project is,
> then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.
> [CLAUDE.md](CLAUDE.md) captures the working rules for any session — human
> or AI — touching this codebase.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | `>= 20` |
| pnpm | `>= 9` |
| Supabase CLI | latest |
| Docker Desktop | for local Supabase |
| Git | any recent |

This repo runs natively on Windows, macOS, and Linux. pnpm is the only
supported package manager — **do not use npm or yarn**.

---

## Local setup

```bash
# 1. Clone and install
git clone https://github.com/civitics-platform/civitics.git
cd civitics
pnpm install

# 2. Configure environment
cp .env.example .env.local
#   Fill in at minimum:
#     NEXT_PUBLIC_SUPABASE_URL
#     NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
#     SUPABASE_SECRET_KEY
#   For local development, `supabase start` prints values for the first three.

# 3. Start local Supabase (Postgres + Studio + Auth in Docker)
supabase start
#   Studio:   http://127.0.0.1:54323
#   Postgres: postgresql://postgres:postgres@127.0.0.1:54322/postgres

# 4. Apply all migrations to the local DB
supabase migration up --local

# 5. Run the dev server
pnpm dev
#   App: http://localhost:3000
```

> **Supabase key format:** use the new `sb_publishable_...` and `sb_secret_...`
> keys only. The legacy `anon` / `service_role` keys are deprecated and will
> trip runtime errors. `SUPABASE_SECRET_KEY` must never be prefixed with
> `NEXT_PUBLIC_` — it's server-side only.

### Optional pipelines and third-party services

Fill these in `.env.local` only when you need them:

| Variable | Needed for |
|---|---|
| `CIVITICS_ANTHROPIC_API_KEY` | AI summaries, graph narrative |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Map rendering |
| `CONGRESS_API_KEY` · `OPENSTATES_API_KEY` · `FEC_API_KEY` · `REGULATIONS_API_KEY` · `COURTLISTENER_API_KEY` | Nightly ingestion pipelines |
| `CRON_SECRET` | Local testing of the nightly cron route |
| `ADMIN_EMAIL` | Admin dashboard access (must match a Supabase auth user) |

### When adding a new env var

1. Add it to `.env.local` with your value
2. Add the key name (no value) to `.env.example`
3. Add it to Vercel (Settings → Environment Variables) before deploying code that uses it
4. If it changes architecture or security posture, update [CLAUDE.md](CLAUDE.md)

---

## Monorepo layout

```
/apps
  civitics        Next.js app (the primary product)
  social          Scaffold for the Phase 3 social/COMMONS app
/packages
  ui              Shared React components
  db              Supabase clients + types + storage
  data            Ingestion pipelines (Node scripts, not in the Next build)
  graph           D3 force simulation — the connection graph
  ai              Claude API service layer, cost gating, caching
  maps            Mapbox GL + Deck.gl utilities
  blockchain      ERC-4337 · Phase 4
  auth            Supabase Auth + Privy integration
  config          Shared ESLint / TypeScript / Tailwind configs
```

**Critical rule — active app directory:** always edit `apps/civitics/app/`.
The sibling `apps/civitics/src/app/` is a stale duplicate that Next.js
silently ignores. Changes there will never reach production.

Each package may ship its own `CLAUDE.md` with package-specific conventions —
read it before touching that package.

---

## Workflow

### The FIXES backlog

Active work items live in [docs/FIXES.md](docs/FIXES.md). Every bullet has
a stable ID (`<!--id:FIX-NNN-->`); commits reference those IDs via a
`Fixes:` trailer, which `fixes:sync` records as a row in
[docs/done.log](docs/done.log). FIXES.md is hand-edited only and carries no
status — status is *derived* from the log: an ID is OPEN if it has no row, or
if its last row says `reopen`; CLOSED otherwise. See
[CLAUDE.md · FIXES Workflow](CLAUDE.md#fixes-workflow) for the full contract.

- `pnpm fixes:status [FIX-NNN]` — is it open? (`--json` for a machine)
- `pnpm fix:add` — append a new bullet, allocating the next free ID
- `pnpm fix:reopen FIX-NNN --note "…"` — append a `reopen` row
- `pnpm fixes:sync` — apply commit trailers to done.log
- `pnpm fixes:sync:dry` — preview without writing
- `pnpm fixes:check` — CI-friendly; exits 1 if out of sync

### Branches

- `master` — production. Vercel auto-deploys from here.
- Feature branches: `feature/short-kebab-name` or `fix/short-kebab-name`
- Long-running experiments: `experiment/<name>`

Avoid `git rebase -i`, `git filter-branch`, and force-pushes on any branch
that touches `docs/FIXES.md` or `docs/done.log` — they create duplicate
status commits that muddle the audit trail.

### Commits

Use Conventional-Commit-ish prefixes — nothing strict, but keep them scannable:

```
feat(proposals): add sort-by dropdown
fix(graph): prune orphan nodes after edge removal
chore(fixes): sync status after FIX-027
docs(api): document initiative endpoints
refactor(db): consolidate Supabase client factories
```

**Trailers.** When a commit closes a FIX item, add the trailer:

```
feat(proposals): add sort-by dropdown

Longer body if warranted.

Fixes: FIX-027
```

Multiple IDs are comma-separated: `Fixes: FIX-020, FIX-021, FIX-024`.

After committing, run `pnpm fixes:sync` and commit the resulting
`FIXES.md` + `done.log` diff as a separate status commit.

**`[skip vercel]` prefix.** For work-in-progress or local-only commits that
shouldn't trigger a Vercel deploy:

```
[skip vercel] chore: wire up local tooling
```

**Never** use `--amend` on a pushed commit — create a new commit instead.
**Never** pass `--no-verify` or skip hooks without explicit sign-off. If a
hook fails, investigate and fix the root cause.

### Before you push

```bash
pnpm build
```

Vercel uses strict TypeScript. A passing local build = no failed deploy.
This is a hard gate — any non-`[skip vercel]` commit must build clean.

If your change touches a migration, also run:

```bash
supabase migration up --local
# Regenerate types after schema changes:
supabase gen types typescript --local > packages/db/src/types/database.ts
```

> **Windows PowerShell caveat:** PowerShell's `>` redirect writes UTF-16,
> which breaks TypeScript parsing. Use:
> ```powershell
> $t = supabase gen types typescript --local
> [System.IO.File]::WriteAllLines('packages\db\src\types\database.ts', $t)
> ```
> or run the command from Git Bash / WSL.

---

## Pull requests

- Open a PR against `master`.
- Keep PRs focused. "One thing, done well" beats "everything, half-done".
- Include screenshots or GIFs for UI changes.
- List the FIX IDs the PR closes in the description.
- Confirm `pnpm build` passes locally in the PR body.
- If the change touches security, privacy, or the data model, flag it at the
  top of the PR so reviewers can give it the right attention.

---

## Code style

- TypeScript strict mode. No `any` unless absolutely necessary and commented.
- Server Components by default; `"use client"` only where interactivity is
  needed.
- Every route that calls `createAdminClient()` must `export const dynamic = "force-dynamic"`.
- `generateStaticParams` uses `createClient()` with the publishable key — never
  `createAdminClient()` (the secret key isn't available at build time).
- `createAdminClient()` bypasses RLS — reserve it for route handlers, pipelines,
  and server-only metadata generators. Do not call it from Server Components in
  the page render path for RLS-scoped content; use `createServerClient(cookies())`
  instead so user sessions are honored.
- Follow the hydration-safety rules in [apps/civitics/CLAUDE.md](apps/civitics/CLAUDE.md#hydration-safety).

### What we don't accept

- Placeholder or fake data. Real data or an empty state — nothing in between.
- UI that exposes blockchain internals (addresses, hashes, gas prompts, network names).
- Code that stores precise user coordinates. Always coarsen to district level.
- React Flow or other graph libraries in place of our D3 force simulation.
- Paywalled civic participation. Reading and submitting positions on public proposals is free forever.
- npm or yarn lockfiles. pnpm only.
- Committed `node_modules`, `.env*` files, or secrets of any kind.

---

## Database safety

These rules exist because small mistakes against production data are very
hard to reverse:

- **Always `--local`** when running Supabase CLI commands during development.
- **Never** run `DROP`, `TRUNCATE`, or unguarded `DELETE` without explicit
  confirmation from a maintainer.
- **Never** modify an existing migration file. Add a new migration that
  supersedes it.
- Prod Supabase dashboard is read-only for contributors. If you need prod
  data, ask a maintainer to export a sanitized sample.

---

## Tests

The project is light on tests today — that's a known gap. Contributions that
add test coverage for existing behavior are very welcome. When adding tests:

- Integration tests hit a real local Supabase instance, not mocks.
- Keep unit tests alongside the code they cover.
- `pnpm test` (planned) will run the full suite; for now, run the relevant
  package's test script directly.

---

## Reporting bugs and suggesting features

- Bugs: open an issue with reproduction steps, expected vs actual behavior,
  and your environment (OS, Node version, browser).
- Features: open a discussion first if the scope is non-trivial. We
  aggressively filter against the [North Star](README.md#the-north-star) —
  if a feature doesn't make the map brighter, we probably won't build it,
  and we'd rather tell you that before you write the PR.

---

## Security

Please do **not** file public issues for security vulnerabilities. Email
the maintainer directly (`craig.a.denny@gmail.com`) and we'll work with you
on disclosure timing.

---

## Code of conduct

Be decent. Disagreements about technical direction are fine; personal
attacks, harassment, and bad-faith arguments are not. Maintainers may remove
comments, commits, or access at their discretion.

---

## License

See the repo root for licensing terms. Production reuse terms are being
finalized — if you want to build on top of Civitics for anything beyond
personal use or a contribution back to this repo, open an issue first.
