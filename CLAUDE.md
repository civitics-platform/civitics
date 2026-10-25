# CLAUDE.md — Civitics Platform

The rules a session cannot derive about THIS repo — each one a trap a fresh
session has fallen into. Everything else lives elsewhere: `docs/ONBOARDING.md`
(orientation), `docs/OPERATIONS.md` (runbooks), `docs/ENGINEERING_PLAYBOOK.md`
(lessons with receipts), `docs/cc/PROMPT_TEMPLATE.md` (the `/cc` contract), the
package `CLAUDE.md` files (loaded when a file under them is read),
`docs/cc/projects/` + `pnpm board` (what is in flight). The pre-haircut file is
`docs/archive/claude-md-root-2026-10-23.md`.

## Session start — ask the tools

- `pnpm session:check` first: stranded branches/worktrees/PRs, `fixes:check`,
  the FIX status summary; it pulls the primary when it is clean and behind.
- Any status claim: `pnpm fixes:status [FIX-NNN]`. **Never read
  `docs/FIXES.md` (~800 KB) or `docs/done.log` (~240 KB) whole** — grep by id.
- Then check the active DB, below, before any data work.

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

- **Switching:** `Copy-Item .env.local.dev` (or `.prod`) `.env.local`, then
  restart `pnpm dev` — Next dev caches `.env.local` at startup. Switch back when
  done. A one-off prod script: `tsx --env-file=.env.local.prod`, which leaves
  `.env.local` alone. → `docs/OPERATIONS.md` §Environment Files.
- **`cron.job` is a prod-only read (FIX-946).** The clone restores `public`
  only, so local `cron.job` is local history. Read cron state from prod and diff
  by jobname, never jobid. → `docs/ENGINEERING_PLAYBOOK.md` §D3.
- **AI kill switches (FIX-311)** are three env vars — `AI_SUMMARIES_ENABLED`,
  `AI_NARRATIVE_ENABLED`, `AI_TAGGER_ENABLED`; `"false"` forces that feature off
  whatever the DB switch says (`packages/db/src/kill-switches.ts`).

---

## Database

Migrations land like code (§Deployment): `supabase migration up --local`, then
`pnpm db:push:prod` once local is green.

- **Pro pushes use `pnpm db:push:prod`** (wraps `--db-url`; `-- --dry-run` lists
  pending), **never `--linked`** (FIX-392). A CLI command that reads the password
  from the env needs `set -a && source .env.local.prod && set +a`.
- **Never destructive SQL against Pro without explicit confirmation** of the
  exact query; local Docker is free for any SQL, DROP/TRUNCATE/DELETE included,
  for iteration. The CLI is pinned in `supabase/.cli-version` (FIX-530): before
  upgrading, check its bundled postgres major against `supabase/config.toml`.
- **A routine-level `SET statement_timeout` bounds nothing** — bound the
  caller's statement. A COMMITting pg_cron procedure cannot carry a `SET` in its
  command, so it gets a `cron_job_budget` row. The `postgres` role ceiling is
  3 h; roll back with `SET statement_timeout = '6h'`, never `RESET` (FIX-1128,
  FIX-1185). → `docs/ENGINEERING_PLAYBOOK.md` §C2.

### Ad-hoc queries and CALLs — `scripts/db-query.mjs` (FIX-791)

```bash
node scripts/db-query.mjs --local "SELECT ..."
node scripts/db-query.mjs --prod  "SELECT ..."          # READ-ONLY, enforced
node scripts/db-query.mjs --local --call "CALL public.some_proc();"
```

`--prod` wraps the SQL in one transaction with `SET TRANSACTION READ ONLY`, so
any write fails closed. It also runs `SET LOCAL max_parallel_workers_per_gather
= 0` first (cc-188): ad-hoc reads log in as `postgres`, each parallel worker
maps a DSM segment, and cc-182's census reads hit the 128 MB DSM refusal and
were 8 of the 15 worst swap-in minutes. A read that needs a parallel plan sets
it back explicitly. `--call` drops `--single-transaction` so a PROCEDURE
that COMMITs internally (the FIX-703/704/715/717/718 pg_cron family) can run,
and prepends `SET statement_timeout` (`--timeout <interval>`, default `60min`)
as a runaway backstop. **`--call` is local by default:** `--prod --call` is a
write path, refuses without `--yes-i-mean-prod`, and even then prints the target
host and statement and waits 5s. It supersedes the untracked
`scratchpad/prod_call.mjs` wrappers.

---

## Data-state changes vs schema changes

Schema and data are propagated to prod by **separate** mechanisms.

**Schema changes** (anything in `supabase/migrations/`):
- `supabase migration up --local` applies to local
- `supabase db push --db-url …` (or `pnpm db:push:prod`) applies to prod — see §Database (`--linked` is unreliable; FIX-392)
- The landing order in §Database handles both

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

- **A bulk rewrite ends by vacuuming what it rewrote:** `VACUUM (ANALYZE)` on
  each table, after the commit, never `FULL`. Never "fix" a post-rewrite timeout
  by raising the timeout (FIX-943). → `docs/ENGINEERING_PLAYBOOK.md` §A4, §C5.
- **Every `updated_at` watermark clamps to `public.watermark_horizon()`.** A
  landing that holds one transaction longer than `civitics.watermark_lag_seconds`
  rewinds the FR-keyed watermarks or pauses the consumers (FIX-983, FIX-1074).
  → §C11.
- **Each remediation tail step scales with the manifest or has a scheduled
  owner**, checked by name in `cron.job.command`, `pg_proc.prosrc` and the GHA
  workflows; `--defer-tails` covers the rest (FIX-1165). → §C10.

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

## App traps

- A route or page that calls `createAdminClient()` needs
  `export const dynamic = "force-dynamic";`, or the Vercel build fails.
  → `packages/db/CLAUDE.md` §Three Clients.
- `generateStaticParams`: try/catch → `[]`, `Promise.race` with a 5 s timeout,
  ≤ 50 rows, publishable key only — DB unavailability never fails a build.
  → `docs/OPERATIONS.md` §Build Failing on Vercel.

---

## FIXES Workflow

- **Status is derived from `docs/done.log`, never stored** (FIX-1016): OPEN if
  an id has no row or its last row is `reopen`. Ask `pnpm fixes:status`;
  `docs/FIXES.md` has no checkbox — never add one.
- **Both files are append-only.** File with `pnpm fix:add --lane <lane>` and use
  the printed id. Never edit, renumber or delete a bullet, id or log row (the
  Monday 10:00Z bot moves bullets closed ≥ 7 days to
  `docs/archive/fixes-archive.md`; `fixes:status` still sees them); reopen with
  `pnpm fix:reopen` or a `Reopens:` trailer. Never force-push them.
- **Trailers:** every `Fixes:`/`Closes:`/`Reopens:` line is read (FIX-874), but
  only the FIRST bare `Verified:` — per-id values use `Verified[FIX-NNN]:`. Vocabulary:
  `docs/cc/PROMPT_TEMPLATE.md` §FIX bookkeeping; `Verified:` values and the
  scripts: `docs/OPERATIONS.md` §FIXES workflow — mechanics.
- **`pnpm fixes:sync` only after the commits are on `origin/main`**; its
  `done.log` diff is its own status commit.

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
  **agents never commit there.** It only ever runs `git pull --ff-only` to catch
  up — `session:check` does it when the tree is clean.
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
  root `prepare` script — no husky) reads `session:held` (FIX-1250), typechecks
  `@civitics/data`, then runs `pnpm fixes:check:trunk`. That aborts the push on
  a trunk-ancestry violation, a hand-reintroduced checkbox, a duplicate FIX id
  marker or a trailer its commit subject does not name (FIX-1271). Drift is not
  gated here; `fixes-integrity.yml` checks it on PRs.
- Start each session with **`pnpm session:check`** (read-only + the primary's
  `pull --ff-only`). Tear down a finished worktree with
  **`pnpm session:worktree:done <fix-id>`** (refuses to remove unmerged work
  without `--force`). Run it from the primary checkout. A `/cc` run does this in
  Step 4 without asking.

Full landing recipe is printed by `pnpm session:worktree <fix-id>`. (Assumes
`main` is push-able; if branch protection is later enabled, the `:main` push
becomes a PR-merge step.)

**Environments:**
- **Local dev:** Docker Supabase at `127.0.0.1:54321–54324`. `supabase migration up --local` applies migrations here.
- **Prod:** Supabase Pro project `xsazcoxinpgttgquwvuf`. Migrations reach it via `pnpm db:push:prod` (§Database). Never run destructive SQL against Pro without explicit confirmation.

**Git identity:** commits on this machine must use `civitics.platform@gmail.com` / `Civitics Platform`. The machine's default `craig.a.denny@gmail.com` routes GitHub attribution to a personal account. See `~/.claude/projects/.../memory/feedback_git_identity.md`.

---

## Onboarding — see [docs/ONBOARDING.md](docs/ONBOARDING.md)

Mission, North Star, two-product split, monorepo structure, core principles,
and mission-tone product rules live there. Read once on your way in.

Runbooks: `docs/OPERATIONS.md`. Lessons with receipts, normative for pipelines,
rollups and scheduled work: `docs/ENGINEERING_PLAYBOOK.md`. `packages/db/CLAUDE.md`
holds the clients, the materialization pattern for slow request-path reads, and
the autovacuum settings; the other package files load when a file under them is
read.
