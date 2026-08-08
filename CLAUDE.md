# CLAUDE.md — Civitics Platform

Operational reference for every Claude Code session. New to the project? Read
`docs/ONBOARDING.md` first; this file is the every-session loud-rail.

> **Cutover status (2026-04-22):** Production is live on Supabase Pro. The
> `shadow.*` schema has been promoted to `public.*` (migration
> `20260422000000`). Production branch is `main`. See
> `docs/archive/MIGRATION_RUNBOOK.md` for the runbook that executed this; the
> post-cutover reimplementation backlog (FIX-097–FIX-104) closed by 2026-04-25
> — see `docs/done.log`.

---

## Session Continuity — Read These First

Starting a new session? Read these files before touching any code:

| File | What it tells you |
|---|---|
| `docs/done.log` | Source of truth for what's actually shipped — per-FIX completion record (append-only). Start here for "what happened recently / what's done" |
| `docs/FIXES.md` | Bug and improvement backlog, each bullet has a stable `FIX-NNN` ID — what's unblocked / what's next |
| `docs/PHASE_GOALS.md` | Phase 1 completion picture |
| `docs/ENGINEERING_PLAYBOOK.md` | The operating rules with their receipts — read before touching pipelines, rollups, or scheduled work. Normative for new work |
| `docs/CLOUDFLARE.md` | Edge posture for civitics.com — which Cloudflare settings are load-bearing and why (Browser Cache TTL, Bot Fight Mode OFF, the WAF exploit-path rule) |
| `.env.local` (whichever was last copied) | **Which DB you're hitting** — `grep ^NEXT_PUBLIC_SUPABASE_URL .env.local` |

These are the fastest path to current project state. Git log and code exploration
are for verification, not orientation.

**First step of every session:** run `pnpm session:check` (read-only — fetches
and reports stranded branches/worktrees/PRs and runs `fixes:check`; see
"Parallel sessions" under Deployment), **then** `pnpm fixes:sync` to pick up any
new commit-trailer completions since last session, then read `docs/FIXES.md` for
the current queue. Then verify the active DB before any data work — see "Active
environment check" below.

> **Execution model (as of 2026-04-18):** Claude Code (VS Code extension on
> Windows) runs the full loop autonomously: migrate → build → commit → push →
> `pnpm fixes:sync` → commit → push. No cross-session hand-off doc required for
> local migrations. `docs/QWEN_PROMPTS.md` and `docs/archive/SESSION_LOG.md` are
> preserved as historical archives.

---

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

### Switching the active env

Two supported patterns. Pick by shell + workflow shape:

**Pattern A — `Copy-Item` (default, works in every shell):**

```powershell
Copy-Item .env.local.dev  .env.local    # → local Docker
Copy-Item .env.local.prod .env.local    # → production Pro
grep "^NEXT_PUBLIC_SUPABASE_URL" .env.local
```

Mutates the working-tree `.env.local`. Restore is the caller's responsibility —
if a session ends mid-loop on prod, the next session inherits prod-pointing
config until someone notices.

**Pattern B — in-shell `source` + `--env-file=` (bash / WSL / Git Bash):**

```bash
# One-off interactive prod query (psql, supabase CLI, ad-hoc tsx)
source .env.local.prod && supabase db push --linked

# TypeScript scripts that load env via dotenv-style flag
tsx --env-file=.env.local.prod scripts/whatever.ts

# Bracket the whole prod block in a subshell so the parent env stays clean
( source .env.local.prod && pnpm --filter @civitics/data data:foo )
```

`.env.local` is never touched. The next shell starts on dev. No "forgot to
restore" failure mode. PowerShell has no `source` equivalent, so this pattern
is bash-side only.

**When to use which:**

| Situation | Use |
|---|---|
| One-off prod query inside an otherwise local session | Pattern B (no restore step) |
| Long autonomous loop touching prod from many scripts | Pattern B (mechanically eliminates the "did I restore?" question) |
| PowerShell-native session, no bash available | Pattern A (only option) |
| Mixed-shell workflow (PowerShell + bash side-by-side) | Pattern A (consistent across both) |
| `pnpm dev` against prod for browser-side QA | Pattern A — Next dev reads `.env.local` at startup and caches it for the lifetime of the server, so `source .env.local.prod` followed by `pnpm dev` would silently still read the on-disk `.env.local` |

Pipelines run from `packages/data/` read `.env.local` from the repo root. The
shell that runs the pipeline inherits whichever env is active at invocation
time — there is no per-script override. With Pattern B, `--env-file=` is the
per-script override that wins regardless of `.env.local` state.

---

## votes Table — Actual Column Names

```
vote      (not vote_cast)
  Schema CHECK enum (see supabase/migrations/0001_initial_schema.sql):
  'yes' | 'no' | 'abstain' | 'present' | 'not_voting' | 'paired_yes' | 'paired_no'
  NOTE: 'not_voting' uses an underscore, NOT a space. Using 'not voting'
  in queries silently returns zero rows. This bit us in FIX-073.
voted_at  (not vote_date)
bill_proposal_id   THE proposal link (not proposal_id — that column was renamed
  at promotion and NO LONGER EXISTS). UUID NOT NULL, FK → bill_details(proposal_id).
  The VALUE equals proposals.id (bill_details.proposal_id == proposals.id), so a
  vote's bill_proposal_id is a proposals.id — only the column name moved.
  There is NO direct votes→proposals FK, so a PostgREST embed
  (`proposals!bill_proposal_id(...)` or `proposals!proposal_id(...)`) does NOT
  resolve — both error with PGRST200. Use the two-step manual fetch: select
  bill_proposal_id, then `.in("id", ids)` on proposals (embed bill_details for
  bill_number). Referencing the dead `proposal_id` via supabase-js is swallowed
  by `const { data } = …` → silent zero rows (this was FIX-426 and the FIX-438
  sweep that absorbed it).
vote_question   FIRST-CLASS COLUMN (text), NOT metadata->>'vote_question'.
  Procedural type string (e.g. "On Passage", "On the Cloture Motion"). Reading it
  off metadata returns undefined for every row → fail-open procedural filters.
metadata->>'legis_num'       bill number (NOTE: unpopulated today; bill_number
  lives in bill_details(proposal_id))
```

Do NOT use vote_cast, vote_date, or proposal_id — those columns do not exist.

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

## Active App Directory — CRITICAL

**Always edit `apps/civitics/app/` — see [apps/civitics/CLAUDE.md](apps/civitics/CLAUDE.md#active-app-directory--critical) for why.**

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
| Git commit trailer `Closes: FIX-NNN` | Claude (administrative closure, no code change) | Feeds done.log via `fixes:sync` (FIX-314) |
| Git commit trailer `Verified: …`    | Claude (when code lands a fix) | Records per-environment verification in done.log (FIX-159) |

**Additive changes — no permission needed.** Claude (whether running in
the autonomous loop or invoked via Cowork-generated prompts) may freely
append new FIX bullets to `docs/FIXES.md` at code-commit time without
asking. This is the default flow for follow-up FIXes surfaced during
implementation. Claude must NOT modify or delete existing bullets without
explicit user authorization — the append-only contract is the foundation
the `fixes:sync` machinery and concurrent-edit safety both depend on.

**Use `pnpm fix:add` to append.** Centralizes formatting + atomic
FIX-ID allocation. Both Craig and Claude call the same script so
bullet shape stays consistent. Example:

```
pnpm fix:add \
  --title "Short title" \
  --severity "🟠" \
  --size "S" \
  --section "INFRASTRUCTURE & PERFORMANCE" \
  --body "Long markdown body referencing [[FIX-NNN]] cross-refs..."
```

Prints the allocated FIX-ID to stdout. Use the printed ID in the
commit trailer immediately: `Fixes: FIX-<printed-id>`. The manual
`grep -oE 'FIX-[0-9]+' docs/FIXES.md | sort -u | tail -5` + hand-format
recipe still works (`fix:add` produces identical bullets), but all new
work should use the script.

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
   - Scans all `Fixes:`, `Closes:`, and `Verified:` trailers across git history
   - Appends new `(FIX-ID, sha, verified)` rows to `docs/done.log` (deduplicated)
   - Flips matching `[ ]` bullets in FIXES.md to `[x]` (only ever one direction)
4. Commit the resulting FIXES.md + done.log diff as its own status commit, e.g.
   `chore(fixes): sync status after FIX-027`. Keep status commits separate from
   code commits so reverts don't drag status with them.

**Closure type — `Fixes:` vs `Closes:` trailer (added 2026-05-18, FIX-314):**

Two trailers, mutually exclusive per commit-and-FIX-ID pair:

- `Fixes: FIX-NNN` — this commit's code change resolves the bug. Use when you
  actually wrote/changed/deleted code that fixed the issue.
- `Closes: FIX-NNN` — this commit administratively closes the FIX without a
  code-level resolution. Use when:
  - The bug was already resolved by prior work that didn't carry a trailer
    (e.g., FIX-272 closed because FIX-280 had already removed the suffix code).
  - The FIX was superseded by a different FIX with broader scope (e.g., FIX-213
    superseded by FIX-253).
  - The FIX was redirected — its original investigation ran and surfaced a
    different problem that became a new FIX (e.g., FIX-242 redirected to FIX-292).
  - Investigation found the bug doesn't actually exist (no-op closure).

When `Closes:` is used, pair it with a `Verified:` trailer using one of the
closure vocabulary values:

- `Verified: closes-as-recognized` — prior work resolved it (default if
  `Verified:` absent on a `Closes:` commit)
- `Verified: closes-as-superseded` — superseded by another FIX
- `Verified: closes-as-redirected` — redirected to a new FIX
- `Verified: closes-as-no-op` — investigation found no real bug

Example:

```
docs(littlesis): document [LS:<id>] suffix as already removed (FIX-272 closeout)

The suffix code was removed by FIX-280; FIX-272 was tracking the same
work without a closure trailer. No code change in this commit.

Verified: closes-as-recognized
Closes: FIX-272
```

If a single commit lists the same FIX-ID in both `Fixes:` and `Closes:`, the
sync script lets `Fixes:` win (code-level fix is the stronger signal) and logs
a warning. Use one or the other per FIX-ID, not both.

**Historical note:** done.log rows written before 2026-05-18 used `Fixes:` for
both code-fix and recognition closures, and a few one-off `verified: superseded`
/ `verified: redirected` values. These rows stay as-is per the append-only rule.
Audit queries spanning history should grep for both old and new value forms,
e.g. `grep -E "\| (superseded|closes-as-superseded) \|" docs/done.log`.

**Per-FIX verification (mixed-state commits, FIX-369):** When a single commit
needs different `Verified:` values for different FIX-IDs — typically because
the commit pairs a `Fixes:` and a `Closes:` whose vocabularies don't overlap —
use the bracketed-trailer syntax. The per-FIX value overrides the global
`Verified:` for that ID only:

```
Verified: local + prod                           # default for unbracketed FIX-IDs
Verified[FIX-365]: closes-as-redirected          # override for FIX-365 specifically
Fixes: FIX-364, FIX-366
Closes: FIX-365
```

This was added in FIX-369. Without it, `fixes:sync` applied the bare
`Verified:` value to every FIX-ID in the commit, which lost closure-vocabulary
info on mixed `Fixes:` + `Closes:` commits (FIX-365 was the surfacing case —
its `closes-as-redirected` collapsed to `local+prod` in done.log because the
commit only carried a single global `Verified: local + prod`).

A `Verified[FIX-NNN]:` line referencing a FIX-ID NOT in the commit's `Fixes:`
or `Closes:` trailers is ignored with a warning. Test the parser with
`pnpm fixes:test` after touching `scripts/fixes-sync.mjs`.

**Auditing per-environment state:**

```bash
grep "| prod-only |"  docs/done.log   # shipped without local repro
grep "| unverified |" docs/done.log   # trailer was forgotten
grep "| local-only |" docs/done.log   # local-tested but prod side never confirmed
grep "| closes-as-" docs/done.log     # administrative closures (FIX-314 onward)
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

## Claude ↔ Database Access

**Default (VS Code Claude Code extension on Windows):** Claude runs migrations,
builds, commits, and pushes directly from the integrated shell. Local Studio:
http://127.0.0.1:54323

Standard autonomous loop after a code change with DB impact:

```
supabase migration up --local                # apply migration against local Docker DB
pnpm db:push:prod                            # apply migration against Pro via --db-url (after local is green; see below)
pnpm --filter @civitics/app-civitics build
git add <files>
git commit -m "...Fixes: FIX-NNN"
git push origin main
pnpm fixes:sync
git add docs/done.log
git commit -m "chore(fixes): sync status after FIX-NNN"
git push origin main
```

### Applying migrations to Pro — use `--db-url`, not `--linked` (FIX-392)

`supabase db push --linked` is **unreliable on this CLI** (v2.78.1): it fails
with a `cli_login_postgres` role-alter error *before* it touches any user
migration. Confirmed recurring across FIX-375, FIX-379, FIX-385. The reliable
primary path is `--db-url` with the prod **direct-connection** string, which
sidesteps the linked-login flow entirely:

```bash
# Direct-connection string from the dashboard, password substituted in:
supabase db push --db-url "postgresql://postgres:[PASSWORD]@db.xsazcoxinpgttgquwvuf.supabase.co:5432/postgres"
```

Or use the wrapper, which reads `SUPABASE_DB_PASSWORD` from `.env.local.prod`,
injects it into the cached session-pooler URL, and redacts it on print:

```bash
pnpm db:push:prod                 # apply all pending migrations to Pro
pnpm db:push:prod -- --dry-run    # list pending migrations, apply nothing
```

**Where the direct-connection string lives:** Supabase dashboard → Project
Settings → Database → **Direct connection**. The session-pooler URL the CLI
cached in `supabase/.temp/pooler-url` works too (it is what `pnpm db:push:prod`
injects the password into).

**Root cause of the recurring `cli_login_postgres` error — it is NOT "the CLI
version is broken":** a bare `source .env.local.prod` assigns the vars as
*shell* variables that are **not exported** to the `supabase` child process, so
`SUPABASE_DB_PASSWORD` is absent when the CLI runs and it falls back to the
broken interactive role-alter login. Two fixes:

- **CLI commands that read the password from the env** (including `--linked`, if
  you must use it): auto-export the source —
  `set -a && source .env.local.prod && set +a` — so every var reaches child
  processes. PowerShell has no `source`; on Windows use `pnpm db:push:prod`,
  which reads the file directly.
- **`tsx` scripts:** pass `--env-file=.env.local.prod`. dotenv-style loading
  injects vars into `process.env` directly, so it is immune to the export trap.

`supabase db push --db-url …` is the canonical CLI path to Pro. Never run
ad-hoc SQL against Pro without explicit user confirmation.

**Fallback (Cowork or any sandboxed environment):** If the active shell can't
reach `127.0.0.1:54322` (Docker Supabase), Claude cannot run migrations, git,
or pnpm locally. In that case:

1. Write the migration file to `supabase/migrations/` and any code changes.
2. **Emit a ready-to-paste Claude Code prompt** at the end of the session —
   not a hand-off-doc bullet — that Craig can drop into the VS Code Claude
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
- Apply migrations with `supabase db push --db-url …` (or `pnpm db:push:prod`) — see the "Claude ↔ Database Access" section. `--linked` is unreliable on this CLI (FIX-392).
- **Never run ad-hoc destructive SQL against Pro** without explicit user confirmation. If the user asks for a data cleanup, confirm the exact query first.
- PITR retention is 7 days on Pro — mistakes are recoverable but costly. Still verify twice.
- App is live at `https://civitics-civitics.vercel.app` — any schema change affects real users.

**Supabase CLI version is pinned (FIX-530):** the active CLI is the standalone
`supabase.exe` at `C:\Users\Craig\bin` (manual install — it never
self-updates), and the project's expected version is committed at
`supabase/.cli-version`. `pnpm session:check` compares `supabase --version`
against that sentinel and WARNS on mismatch (never blocks). The root
`package.json` devDependency is pinned to the same version (was `"latest"`).
Why: CLI 2.78.1 once silently bundled a postgres:17 image while
`supabase/config.toml` still pinned `major_version = 15`, crash-looping local
on a PG15-volume/PG17-image mismatch (multi-hour prod-clone recovery,
2026-06-08). When intentionally upgrading the CLI: check the bundled postgres
image major against `config.toml` `major_version` FIRST, then update the exe,
the devDependency, and `.cli-version` together.

When a request-path query becomes slow as data grows, the durable fix is
materialization. See `packages/db/CLAUDE.md` — *Materialization pattern for
slow request-path aggregations* — for shape options (single-row MV,
per-entity MV, rolling-history snapshot table), refresh hook placement,
read-path conventions with live-compute fallback, and the table of existing
materializations to model off.

---

## Data-state changes vs schema changes

Schema and data are propagated to prod by **separate** mechanisms.

**Schema changes** (anything in `supabase/migrations/`):
- `supabase migration up --local` applies to local
- `supabase db push --db-url …` (or `pnpm db:push:prod`) applies to prod — see "Claude ↔ Database Access" (`--linked` is unreliable; FIX-392)
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

### Any script that bulk-rewrites a table ends by vacuuming what it rewrote (FIX-943)

**Standing convention. This is not optional and not belt-and-braces.**

If a script, migration, or RPC rewrites a large table in bulk — a merge, a
backfill, a full rollup rebuild, a mass `UPDATE`/`DELETE` — its **last step must
be `VACUUM (ANALYZE)` on every table it rewrote**:

```sql
VACUUM (ANALYZE) public.financial_relationships;
VACUUM (ANALYZE) public.entity_connections;
```

Autovacuum tuning (per-table `autovacuum_vacuum_scale_factor`, FIX-943) narrows
the window; it does not close it. The trigger is
`autovacuum_vacuum_threshold + scale_factor × reltuples`, so a table is *always*
permitted to accumulate a floor of dead tuples before anything happens — on
`financial_relationships` that floor is still ~164k after tuning. A bulk rewrite
lands its whole dead-tuple load inside that window at once, and the next reader
pays for it.

Why it matters more than the dead-tuple count suggests: a heap page loses its
all-visible mark if **any** tuple on it is dead, and these tables carry 4.6–60
tuples per page. So a few-percent dead ratio can un-mark most of the heap, and
every index-only scan silently degrades to a per-row heap fetch. That is FIX-884
(0.9% all-visible → 34,534 heap fetches, 20.5s of a 22.1s query) and it is
FIX-943 (the FIX-930 audit went from ~8 min to blowing a 600s
`statement_timeout` purely from the FIX-933 merge's ~260k dead tuples, and
completed again after a vacuum).

The precedent is load-bearing, not theoretical: the *only* reason the four-day
`donor-rollup-refresh` failure ([[FIX-944]]) cleared at all was that the FIX-933
merge script happened to carry this vacuum in its tail. Nothing scheduled it.

Rules:

- Vacuum runs **after** the rewrite commits, never inside the transaction
  (`VACUUM` cannot run in one).
- `VACUUM`, never `VACUUM FULL` — the latter takes ACCESS EXCLUSIVE and rewrites
  the whole table.
- Cost it: on prod a vacuum of `financial_relationships` is minutes, and on local
  Docker it measured >17 min. Schedule bulk-rewrite scripts off-peak
  (cf. the no-heavy-prod-ops-during-active-hours rule) and expect the vacuum tail
  to add to the runtime.
- Verify it ran — `pg_stat_user_tables.last_vacuum` — before treating a
  post-rewrite timing regression as a query problem. Do **not** "fix" a
  post-rewrite audit timeout by raising the timeout.

The daily canary reports the cause (`bloat_degraded`, report-only) and escalates
on the consequence (`vm_degraded`) via `check_rebuild_autovacuum_status()`. See
`packages/db/CLAUDE.md` — *Autovacuum: per-table settings and the bulk-rewrite
vacuum rule* — for the tuned-table list and how to size a new one.

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

## Supabase API Keys

Use NEW format keys only:
```
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   (sb_publishable_xxx)  — client-side
SUPABASE_SECRET_KEY                    (sb_secret_xxx)       — server-only
```
Never use legacy `anon` / `service_role` keys. Never use `NEXT_PUBLIC_` on the secret key.

See `packages/db/CLAUDE.md` for full client documentation.

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

**AI kill-switch env vars (FIX-311):** The original single `AI_SUMMARIES_ENABLED`
env var was split into three per-feature env-level hard kills, each mapping 1:1
to a DB-backed kill switch in `pipeline_state.kill_switches`:

| Env var | DB switch | Covers |
|---|---|---|
| `AI_SUMMARIES_ENABLED` | `ai_summaries` | Cached plain-language summaries |
| `AI_NARRATIVE_ENABLED` | `ai_narrative` | `/api/graph/narrative` and graph-side Anthropic calls |
| `AI_TAGGER_ENABLED`    | `ai_tagger`    | Enrichment-queue tag generation |

Set any of these to `"false"` to force-off that specific feature regardless of
the DB switch state. See `packages/db/src/kill-switches.ts` for the env →
DB-switch layering rules and `packages/data/src/feature-flags.ts` for the
`FLAGS.AI_*_ENABLED` accessors used by pipelines.

---

## Deployment

Run `pnpm build` locally before every push. Vercel uses strict TypeScript. Build must pass clean.

**Branch model (post-cutover):**
- `main` — production. Every push auto-deploys to Vercel (unless `[skip vercel]`).
- `feature/<fix-id>` or `feature/<name>` — work branches. Land via PR or fast-forward merge to `main`.

**Parallel sessions — collision guards (FIX-462+):** VSCode is always open on the
primary checkout, so an agent committing there contends with VSCode's git
extension on one `.git` (stale `index.lock`, corrupted `.git/config`, and the
stranded-PR class where `fixes:sync` records FIXes as shipped while the code sits
unmerged). Standing rules:

- The **primary VSCode checkout stays parked on `main`** as the human view —
  **agents never commit there.** It only ever runs `git pull --ff-only` to catch up.
- **Single small FIX:** serialize-by-default — fine to do it on a short branch.
  **Anything parallel or long:** give each FIX its **own worktree** via
  `pnpm session:worktree <fix-id>` (creates `feature/fix-<id>` in a sibling dir
  `../civitics-worktrees/fix-<id>`, outside the repo, both `.env.local` seeded to
  LOCAL Docker). The FIX id is the unique slot — two parallel sessions need zero
  coordination.
- `main` advances **only by fast-forward from a rebased branch**
  (`git push origin feature/fix-<id>:main`). That landing is the one serialized
  step; if two race, the second rebases and retries.
- **`fixes:sync` runs only AFTER** the fix commits are on `origin/main` — never
  from a worktree pre-merge (that is the stranded-PR failure mode).
- A **pre-push hook** (`.githooks/pre-push`, wired via `core.hooksPath` by the
  root `prepare` script — no husky) runs `pnpm fixes:check` and aborts the push
  on FIXES.md/done.log drift.
- Start each session with **`pnpm session:check`** (read-only reconciliation).
  Tear down a finished worktree with **`pnpm session:worktree:done <fix-id>`**
  (refuses to remove unmerged work without `--force`).

Full landing recipe is printed by `pnpm session:worktree <fix-id>`. (Assumes
`main` is push-able; if branch protection is later enabled, the `:main` push
becomes a PR-merge step.)

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

## What Not To Do

Operational guardrails (mission-tone and product-design "do nots" live in
`docs/ONBOARDING.md`):

- Do not use client-side Supabase calls that bypass RLS
- Do not build AI features before the credit/revenue mechanism is live
- Do not open-end AI API access without rate limits and credit gating
- Do not skip the smart contract audit before mainnet deployment
- Do not `--no-verify`, skip pre-commit hooks, or `--amend` published commits

---

## Onboarding — see [docs/ONBOARDING.md](docs/ONBOARDING.md)

Mission, North Star, two-product split, monorepo structure, core principles,
and mission-tone product rules live there. Read once on your way in.
