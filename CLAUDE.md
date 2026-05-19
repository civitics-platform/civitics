# CLAUDE.md — Civitics Platform

Authoritative reference for the Civitics platform. Read before writing any code.
Update when architecture decisions change. Last updated: 2026-04-22 (Supabase Pro cutover).

> **Cutover status (2026-04-22):** Production is live on Supabase Pro. The `shadow.*` schema has been promoted to `public.*` (migration `20260422000000`). Production branch is `main`. See `docs/archive/MIGRATION_RUNBOOK.md` for the runbook that executed this; the post-cutover reimplementation backlog (FIX-097–FIX-104) closed by 2026-04-25 — see `docs/done.log`.

---

## Session Continuity — Read These First

Starting a new session? Read these files before touching any code:

| File | What it tells you |
|---|---|
| `docs/SESSION_LOG.md` | What happened last session, what's unblocked, what's next |
| `docs/FIXES.md` | Bug and improvement backlog, each bullet has a stable `FIX-NNN` ID |
| `docs/done.log` | Source of truth for what's actually shipped (append-only) |
| `docs/PHASE_GOALS.md` | Phase 1 completion picture |
| `.env.local` (whichever was last copied) | **Which DB you're hitting** — `grep ^NEXT_PUBLIC_SUPABASE_URL .env.local` |

These are the fastest path to current project state. Git log and code exploration
are for verification, not orientation.

**First step of every session:** run `pnpm fixes:sync` to pick up any new
commit-trailer completions since last session, then read `docs/FIXES.md` for the
current queue. Then verify the active DB before any data work — see "Active
environment check" below.

> **Execution model (as of 2026-04-18):** Claude Code (VS Code extension on
> Windows) runs the full loop autonomously: migrate → build → commit → push →
> `pnpm fixes:sync` → commit → push. No SESSION_LOG ⚠️ hand-off required for
> local migrations. `docs/QWEN_PROMPTS.md` is preserved as historical archive.

---

## FIXES Workflow

Craig keeps `docs/FIXES.md` open in VSCode as a live backlog. Claude keeps a
separate source of truth in `docs/done.log` to avoid editor collisions, revert
drift, and duplicate-commit shuffles.

**The contract:**

| File | Owner | Direction |
|---|---|---|
| `docs/FIXES.md` | Craig (adds, edits, reprioritises) | Claude **only appends new items** or lets `fixes:sync` flip `[ ]` → `[x]` |
| `docs/done.log` | Claude / `fixes:sync` | **Append-only**, never rewritten |
| Git commit trailer `Fixes: FIX-NNN` | Claude (when code lands a fix) | Feeds done.log via `fixes:sync` |
| Git commit trailer `Verified: …`    | Claude (when code lands a fix) | Records per-environment verification in done.log (FIX-159) |

**When you (Claude) complete a FIX item:**

1. Find the item's ID in FIXES.md — the `<!--id:FIX-NNN-->` marker at the end of
   the bullet.
2. Include a `Fixes:` trailer and a `Verified:` trailer in the commit message.
   Multiple IDs allowed, comma-separated. The `Verified:` value is one of
   `local`, `prod`, or `local + prod` (normalized to `local-only` / `prod-only`
   / `local+prod` in `done.log`):
   ```
   feat(proposals): add sort-by dropdown
   
   Longer body if needed.
   
   Verified: local + prod
   Fixes: FIX-027
   ```
   ```
   Verified: local
   Fixes: FIX-020, FIX-021, FIX-024
   ```
   **When to use which:**
   - `local` — code-only or local-state change; you exercised it against the
     local Docker DB but haven't curl'd the deployed prod endpoint or re-run a
     pipeline on prod yet.
   - `prod` — runtime action you only ran against prod (rare, e.g. an emergency
     `rebuild_entity_connections()` on prod). Pair with a follow-up to also
     run/verify locally.
   - `local + prod` — both. For pure code changes, that means: local smoke
     test before push **and** a post-deploy curl against the live prod URL. For
     runtime data actions, both DBs were re-run separately (see "Data-state
     changes vs schema changes" below).
   - **Omit only if you genuinely have not verified anywhere.** A missing
     trailer is logged as `unverified` and is greppable, so future-you can
     audit which fixes were merged untested.
3. After committing, run `pnpm fixes:sync`. The script:
   - Scans all `Fixes:` and `Verified:` trailers across git history
   - Appends new `(FIX-ID, sha, verified)` rows to `docs/done.log` (deduplicated)
   - Flips matching `[ ]` bullets in FIXES.md to `[x]` (only ever one direction)
4. Commit the resulting FIXES.md + done.log diff as its own status commit, e.g.
   `chore(fixes): sync status after FIX-027`. Keep status commits separate from
   code commits so reverts don't drag status with them.

**Auditing per-environment state:**

```bash
grep "| prod-only |"  docs/done.log   # shipped without local repro
grep "| unverified |" docs/done.log   # trailer was forgotten
grep "| local-only |" docs/done.log   # local-tested but prod side never confirmed
```

**Do NOT:**

- Rewrite FIXES.md bullet text mid-session (causes the N-insertion / N-1 deletion
  churn pattern from editor collisions). Only the checkbox character changes.
- Remove, renumber, or reassign `FIX-NNN` IDs — they're permanent handles.
- Rewrite existing lines in `done.log`. If an item was reopened, **append** a new
  line with `sha: reopen` and hand-uncheck FIXES.md. The sync script treats
  `reopen` as "remove from completed set".
- Use `git filter-branch`, `git reset --hard`, or force-pushes on branches that
  touch FIXES.md — these caused the status-duplicate commits visible in the April
  reflog.

**Scripts:**

- `pnpm fixes:sync` — scan trailers, append to done.log, update FIXES.md checkboxes
- `pnpm fixes:sync:dry` — show what would change, write nothing
- `pnpm fixes:check` — CI-friendly; exits 1 if FIXES.md is out of sync with trailers

**Adding a new FIX item (Craig, typically):**

Append a bullet to the appropriate section of FIXES.md with the next free
sequential ID. Easy way to find the highest in-use ID:
```bash
grep -oE 'FIX-[0-9]+' docs/FIXES.md | sort -u | tail -5
```
If Craig adds a bullet without an ID, Claude should assign the next free one
before referencing it in a commit.

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
| `packages/db/CLAUDE.md` | Supabase clients, schema conventions, entity_connections correction, RLS, **materialization pattern for slow request-path aggregations**, storage, migrations |
| `packages/data/CLAUDE.md` | Pipelines, FEC bulk strategy, storage budget, per-source rules, update schedules |
| `packages/graph/CLAUDE.md` | D3 graph, node types, smart expansion, strength filter, share codes, presets |
| `packages/ai/CLAUDE.md` | Claude API, model routing, credit gating, caching, cost rules |
| `packages/maps/CLAUDE.md` | Mapbox, Deck.gl, PostGIS patterns, privacy rules, geographic data |
| `packages/blockchain/CLAUDE.md` | Chains, wallets, audit requirement, Two Economies, compute pool |
| `apps/civitics/CLAUDE.md` | Tone, data rules, user tiers, institutional API, candidate tools, build rules |

When a request-path query becomes slow as data grows, the durable fix is
materialization. See `packages/db/CLAUDE.md` — *Materialization pattern for
slow request-path aggregations* — for shape options (single-row MV,
per-entity MV, rolling-history snapshot table), refresh hook placement,
read-path conventions with live-compute fallback, and the table of existing
materializations to model off.

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

## Active environment check (CRITICAL)

`.env.local` is the active config. Two saved templates exist alongside it:

```
.env.local.dev     → points at local Docker     (NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321)
.env.local.prod    → points at Supabase Pro     (NEXT_PUBLIC_SUPABASE_URL=https://xsazcoxinpgttgquwvuf.supabase.co)
.env.local         → whichever was Copy-Item'd most recently
```

**Before running anything that reads or writes data — including pipelines, scripts,
RPC calls, or ad-hoc queries — verify which DB is active:**

```powershell
grep "^NEXT_PUBLIC_SUPABASE_URL" .env.local
```

If it points at prod (`xsazcoxinpgttgquwvuf.supabase.co`):
- App reads (`pnpm dev` → localhost:3000) will hit prod data
- `pnpm data:*` pipelines will write to prod
- Any seed/backfill/RPC invocation runs against prod

**Confirm with the user before running data-writing scripts (`pnpm data:*`,
`SELECT * FROM rebuild_*()`, etc.) when `.env.local` points at prod.** Never
assume the active env matches the user's intent — always check.

Switch with:
```powershell
Copy-Item .env.local.dev  .env.local    # → local Docker
Copy-Item .env.local.prod .env.local    # → production Pro
```

Pipelines run from `packages/data/` read `.env.local` from the repo root. The
shell that runs the pipeline inherits whichever env is active at invocation
time — there is no per-script override.

## Data-state changes vs schema changes

Schema and data are propagated to prod by **separate** mechanisms.

**Schema changes** (anything in `supabase/migrations/`):
- `supabase migration up --local` applies to local
- `supabase db push --linked` applies to prod
- The standard autonomous loop in "Claude ↔ Database Access" handles both

**Data-state changes** (any runtime DB action that writes data):
- `pnpm data:*` pipelines
- `SELECT * FROM rebuild_entity_connections();` and similar RPCs
- Seeds, backfills, `UPDATE`/`INSERT` scripts
- These ONLY hit the DB pointed at by the active `.env.local` at the moment of invocation

Schema migrations being applied to both DBs does NOT mean derived data exists in
both. A FIX item that requires a runtime action (rebuild, pipeline re-run, seed)
must be executed against **each** environment separately:

```
1. Run against local (.env.local → local Docker)
2. Verify locally
3. Switch:  Copy-Item .env.local.prod .env.local
4. Re-run the same action against prod
5. Verify against prod
6. Switch back: Copy-Item .env.local.dev .env.local
7. Commit trailer:  Verified: local + prod
```

**Never mark a runtime-action FIX as complete after only running it locally.** If
you cannot run against prod in this session, leave the FIX open and document
the prod step as pending.

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

**Branch model (post-cutover):**
- `main` — production. Every push auto-deploys to Vercel (unless `[skip vercel]`).
- `feature/<fix-id>` or `feature/<name>` — work branches. Land via PR or fast-forward merge to `main`.

**Environments:**
- **Local dev:** Docker Supabase at `127.0.0.1:54321–54324`. `supabase migration up --local` applies migrations here.
- **Prod:** Supabase Pro project `xsazcoxinpgttgquwvuf`. `supabase db push --linked` applies migrations. Never run destructive SQL against Pro without explicit confirmation.

**Git identity:** commits on this machine must use `civitics.platform@gmail.com` / `Civitics Platform`. The machine's default `craig.a.denny@gmail.com` routes GitHub attribution to a personal account. See `~/.claude/projects/.../memory/feedback_git_identity.md`.

---

## Current Phase: Post-cutover cleanup (April 2026)

Phase 1 cutover to Supabase Pro is complete (2026-04-22). FIX-097 through
FIX-104 (RPC restoration, derivation rules, deferred pipeline re-runs) all
closed by 2026-04-25. Current focus is the GRAPH_PLAN backlog and ongoing
post-cutover refinements tracked in `docs/FIXES.md`.

See `docs/FIXES.md` + `docs/PHASE_GOALS.md` for live task tracking. The
Stage 0 → Stage 2 rebuild spec is archived at
`docs/archive/REBUILD_STATUS.md` for historical reference.

---

## Enrichment Queue Drain — Runbook

The `enrichment_queue` holds ~120k pending tag + summary items (seeded 2026-04-23, FIX-101). Drains run in the VS Code Claude Code session using parallel Haiku subagents. No direct Anthropic API calls — Max-plan subagent capacity is the binding constraint.

**Scripts (all from `packages/data/`):**

```
pnpm data:drain:status                 snapshot counts + stale claims
pnpm data:drain:status --reclaim       flip stale 'processing' rows back to 'pending'
  (--stale-minutes N defaults to 10; use 0 to reclaim all)

pnpm data:drain:claim  --task tag|summary --size 60 --worker <id> --output FILE
pnpm data:drain:submit --input FILE
```

**Subagent type — always use `drain-worker`**, never `general-purpose`. Defined at `.claude/agents/drain-worker.md` with `tools: Read, Write` so the subagent physically cannot `pnpm add`, shell out, or spawn its own API calls. Belt-and-braces: `.claude/settings.local.json` denies `pnpm add` / `npm install` / `yarn add`.

**Standard prompt form** (triggers the full drain loop):

> *drain got interrupted. verify data and continue and pick up where the last job left off. Drain 30 batches of both tag and summary, batch size 60, parallel 6*

means: 5 waves × 12 subagents (6 tag + 6 summary in parallel per wave) = 30 tag + 30 summary batches of 60 each ≈ 3,600 items per session. Plan for the Haiku rate limit around the 1,400–1,800 tag-item mark; the summary queue drains further before rate-limiting because it's shorter per item.

**Wave loop (run from `packages/data/`):**

1. `pnpm data:drain:status --reclaim --stale-minutes 0` — reclaims anything the previous session orphaned in `processing`.
2. `mkdir -p .drain-tmp/wave<N>` inside `packages/data/`. The dir is gitignored-by-absence (add to `.gitignore` if committed). **Always `cd packages/data` first** — pnpm resolves `--output` paths from package cwd; running from repo root claims 12 batches then fails to write the files, leaking claims.
3. Claim 6 tag + 6 summary batches in parallel using unique worker ids (`w<N>-tag-1..6`, `w<N>-sum-1..6`).
4. Spawn 12 `drain-worker` subagents in parallel, one per batch. Each gets `BATCH_FILE`, `RESULTS_FILE`, `MODEL_NAME=claude-haiku-4-5-20251001`, and a pointer to `packages/data/src/drain/prompts/{tag,summary}.md`.
5. Wait for all 12 completions.
6. Submit all 12 results in parallel via `data:drain:submit --input`.
7. Repeat for next wave.

**Known hazards:**

- Subagent can short the count (reports "50/50 ok" on a 60-item batch). Submit accepts whatever lands; the missing queue rows stay `processing` until reclaimed. Not worth chasing per-batch — the next session's reclaim sweep handles it.
- Subagent can overshoot (reports "64/60 ok"). Apply rejects the phantom `queue_id`s; the real 60 land fine.
- Rate-limit hits land as `"You've hit your limit · resets <time>"` in the subagent's return string with no results file written. Those batches need `--reclaim --stale-minutes 0` to free.
- Do **not** run concurrent drain sessions against the same `claimed_by` prefix — the RPC uses `SELECT ... FOR UPDATE SKIP LOCKED` so it's race-safe, but identical worker ids confuse the stale-claim sweep.

**Ignore:** any `process_tags*.{py,mjs,js}` or `process-tag*.js` files that appear in the repo or `.drain-tmp/`. They're from the pre-`drain-worker` era when `general-purpose` subagents installed `@anthropic-ai/sdk` and wrote helper scripts. Delete and move on.

---

## votes Table — Actual Column Names

```
vote      (not vote_cast)
  Schema CHECK enum (see supabase/migrations/0001_initial_schema.sql):
  'yes' | 'no' | 'abstain' | 'present' | 'not_voting' | 'paired_yes' | 'paired_no'
  NOTE: 'not_voting' uses an underscore, NOT a space. Using 'not voting'
  in queries silently returns zero rows. This bit us in FIX-073.
voted_at  (not vote_date)
metadata->>'vote_question'   procedural type string (e.g. "On Passage", "On the Cloture Motion")
metadata->>'legis_num'       bill number
```

Do NOT use vote_cast or vote_date — those columns do not exist.

When asserting or filtering on an enum value, treat the schema CHECK
constraint as ground truth. Not CLAUDE.md, not a prior pipeline's
normalizer — the constraint. Quick check:

    \d+ votes          -- in psql
    -- or grep supabase/migrations/0001_initial_schema.sql for CHECK constraints

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

## Claude ↔ Database Access

**Default (VS Code Claude Code extension on Windows):** Claude runs migrations,
builds, commits, and pushes directly from the integrated shell. Local Studio:
http://127.0.0.1:54323

Standard autonomous loop after a code change with DB impact:

```
supabase migration up --local                # apply migration against local Docker DB
supabase db push --linked                    # apply migration against Pro (only after local is green)
pnpm --filter @civitics/app-civitics build
git add <files>
git commit -m "...Fixes: FIX-NNN"
git push origin main
pnpm fixes:sync
git add docs/done.log
git commit -m "chore(fixes): sync status after FIX-NNN"
git push origin main
```

`supabase db push --linked` is the only CLI path to Pro. Never run ad-hoc SQL against Pro without explicit user confirmation.

**Fallback (Cowork or any sandboxed environment):** If the active shell can't
reach `127.0.0.1:54322` (Docker Supabase), Claude cannot run migrations, git,
or pnpm locally. In that case:

1. Write the migration file to `supabase/migrations/` and any code changes.
2. **Emit a ready-to-paste Claude Code prompt** at the end of the session —
   not a SESSION_LOG ⚠️ bullet — that Craig can drop into the VS Code Claude
   Code extension to execute the loop above end-to-end. Example format:

   ```
   Run the standard autonomous loop for FIX-NNN:
   - supabase migration up --local
   - build, commit with "Fixes: FIX-NNN", push
   - pnpm fixes:sync, commit the done.log diff, push
   ```

   The prompt should be copy-pasteable, reference the specific FIX IDs, and
   name any files that need staging.

---

## Database Safety Rules

Two-tier environment: local Docker Supabase for development, Supabase **Pro** for production.

**Local (dev):**
- Studio URL: `http://127.0.0.1:54323`
- DB connection: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- Apply migrations with `supabase migration up --local`
- Free to run any SQL, including DROP/TRUNCATE/DELETE, for iteration.

**Production (Pro):**
- Studio URL: `https://supabase.com/dashboard/project/xsazcoxinpgttgquwvuf`
- Connection details in Vercel env vars (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`).
- Apply migrations with `supabase db push --linked` (requires prior `supabase link --project-ref xsazcoxinpgttgquwvuf`).
- **Never run ad-hoc destructive SQL against Pro** without explicit user confirmation. If the user asks for a data cleanup, confirm the exact query first.
- PITR retention is 7 days on Pro — mistakes are recoverable but costly. Still verify twice.
- App is live at `https://civitics-civitics.vercel.app` — any schema change affects real users.

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
