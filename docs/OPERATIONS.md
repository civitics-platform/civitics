# Civitics Platform — Operations Guide

Daily operations reference for running, developing, and deploying the Civitics platform.
Last updated: 2026-04-22.

> **Note (2026-04-22):** Supabase Pro cutover complete. Production is now on the `main` branch and the `shadow` schema has been promoted to `public` (migrations `20260422000000` + `20260422000001`). 11 RPCs were dropped during promotion — see `docs/FIXES.md` §POST-CUTOVER for the reimplementation backlog (FIX-097 through FIX-104).

---

## Environment Setup

### Two Environments

| | LOCAL (dev) | PROD |
|---|---|---|
| App | `pnpm dev` on `localhost:3000` | `https://civitics-civitics.vercel.app` (auto-deploy from `main`) |
| Database | Local Supabase (`supabase start`) | Supabase **Pro** project `xsazcoxinpgttgquwvuf` |
| Studio | `http://127.0.0.1:54323` | `supabase.com/dashboard/project/xsazcoxinpgttgquwvuf` |
| DB URL | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | From Supabase dashboard → Project Settings → Database |
| API | `http://127.0.0.1:54321` | `https://xsazcoxinpgttgquwvuf.supabase.co` |
| Vercel plan | n/a | **Pro** since the April cutover — sub-daily crons allowed (five live, down to `*/2`) |

### Required Tools

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Node.js | 20.0.0 | nvm-windows: `nvm install 20` |
| pnpm | 9.0.0 | `npm install -g pnpm@9` |
| Docker Desktop | Latest | Required by Supabase CLI for local DB |
| Supabase CLI | Latest | `pnpm dlx supabase` or `npm install -g supabase` |
| psql | Any | Bundled with PostgreSQL install |
| ngrok | Latest | `ngrok.com/download` |

**Package manager: pnpm only. Never npm or yarn.**

### Environment Files

The monorepo uses a single `.env.local` at the **repo root** (`c:\Users\Craig\Documents\Civitics\App\.env.local`). `next.config.mjs` loads this file manually before Next.js initializes, so it covers both dev and build.

```
.env.local          ← ACTIVE file, gitignored, never committed
.env.local.dev      ← Saved config pointing at local Supabase (copy to .env.local to use)
.env.local.prod     ← Saved config pointing at production Supabase (copy to .env.local to use)
.env.example        ← Key names only, no values, committed to git
```

**Switching environments:**

```powershell
# Switch to local Supabase
Copy-Item .env.local.dev .env.local

# Switch to production Supabase
Copy-Item .env.local.prod .env.local
```

**What goes in each file:**

`.env.local.dev` (local Supabase):
```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx   # from: supabase status
SUPABASE_SECRET_KEY=sb_secret_xxx                         # from: supabase status
CIVITICS_ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_ADMIN_API_KEY=...
ANTHROPIC_ORG_ID=...
NEXT_PUBLIC_MAPBOX_TOKEN=pk...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_BUCKET_DOCUMENTS=civitics-documents
CLOUDFLARE_R2_BUCKET_CACHE=civitics-cache
CLOUDFLARE_R2_PUBLIC_URL_DOCUMENTS=...
CONGRESS_API_KEY=...
REGULATIONS_API_KEY=...
FEC_API_KEY=...
CRON_SECRET=...
ADMIN_EMAIL=...
STORAGE_PROVIDER=r2
```

`.env.local.prod` (production Supabase):
```
NEXT_PUBLIC_SUPABASE_URL=https://xsazcoxinpgttgquwvuf.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx   # from Supabase dashboard
SUPABASE_SECRET_KEY=sb_secret_xxx                         # from Supabase dashboard
# ... same other keys as above
```

**When adding a new API key:**
1. Add value to `.env.local`
2. Add to Vercel immediately: Settings → Environment Variables
3. Add key name only (no value) to `.env.example`
4. Update `CLAUDE.md` if architecturally relevant

**The local clone's migration history (FIX-1351, cc-249).** `node scripts/db-query.mjs --local --file <migration>` applies a file but records no version, so the clone's `supabase_migrations.schema_migrations` drifted 16 files behind its live state and `migration up --local` died re-applying them. Rehearse each new migration ×2 with `db-query --local --file` (rule 241's idempotency check), THEN record it with `supabase --workdir <worktree> migration up --local` — the third, recording apply of an idempotent file. Never `supabase db reset` to fix a drifted history: insert the missing `(version, name)` rows instead.

---

## Daily Dev Workflow

### Morning Startup

```powershell
# 1. Start Docker Desktop first (required by Supabase CLI)
# Wait for Docker to finish starting

# 2. Start local Supabase
cd C:\Users\Craig\Documents\Civitics\App
supabase start

# 3. Verify local Supabase is running
supabase status
# Shows API URL, DB URL, Studio URL, and keys

# 4. Switch to local env (if not already)
Copy-Item .env.local.dev .env.local

# 5. Start Next.js dev server
pnpm dev
# App available at http://localhost:3000
# Turbo runs all packages in watch mode
```

**Verify local Studio is accessible:** Open `http://127.0.0.1:54323` — you should see the Supabase dashboard for the local database.

### Verify Local App Is Working

```powershell
# Test the status API — should return JSON with 6 self-test results
(Invoke-WebRequest "http://localhost:3000/api/claude/status" -UseBasicParsing).Content
```

All 6 checks should pass. `nightly_ran_today` will fail if cron is disabled — expected during local dev.

### ngrok for Remote Verification

When you need to test from mobile or share with someone else:

```powershell
# Start ngrok with the skip-browser-warning header (required for local tunnel)
ngrok http 3000 --request-header-add "ngrok-skip-browser-warning: true"
```

Or use an ngrok policy file (`ngrok-policy.yml` in repo root) to set the header automatically:
```powershell
ngrok http 3000 --traffic-policy-file ngrok-policy.yml
```

### Evening Shutdown

```powershell
# Stop local Supabase (prevents unnecessary Docker resource usage overnight)
supabase stop

# Or stop and keep data:
supabase stop --no-backup
```

---

## Git + Deployment Workflow

### Branch Strategy

```
main            → production (civitics-civitics.vercel.app) — auto-deploys to Vercel on every push
feature/*       → local only, never pushed directly (merge to main when ready)
```

*(Pre-cutover the production branch was `master`; that was renamed to `main` on 2026-04-22 and `qwen/phase1` was deleted. Local + remote converged to a single `main`.)*

### Commit Conventions

```
[skip vercel] type(scope): description    ← local dev commit, no Vercel deploy
type(scope): description                  ← triggers Vercel build + deploy
```

**What actually skips (FIX-1359).** Vercel has no commit-message skip of its
own, so until 2026-10-28 the tag did nothing and every push built production.
`apps/civitics/vercel.json` now carries `"ignoreCommand": "bash
scripts/vercel-ignore-build.sh"`, which Vercel runs in the project's root
directory before each git deployment (exit 0 = skip, 1 = build). It
**overrides** the dashboard's Ignored Build Step, which had skipped every
Preview and no Production build, so the script restates that first: anything
but `VERCEL_ENV=production` skips (feature-branch pushes never build). For
Production it compares `VERCEL_GIT_PREVIOUS_SHA` (the last deployment that
SUCCEEDED) with `HEAD`, because Vercel builds only a push's tip:
- **skip** when every commit in that range is `[skip vercel]`-headed, or when
  nothing under `apps/civitics`, `packages/` or the root `package.json` /
  `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `turbo.json` / `.npmrc` changed
  (docs, receipts, the bots, `supabase/`, `scripts/`);
- **build** otherwise, and on any doubt (no previous sha, one the shallow clone
  cannot reach, a redeploy).
So the tag is per RANGE: one untagged commit in a push builds everything
undeployed under it. A commit is tagged only when `[skip vercel]` heads its
subject (FIX-1364): a record whose subject quotes a skip line mid-subject is
untagged. Tagged app changes ship with the next untagged push — at
the latest the 00:09Z receipts bot. A skipped deployment reads **Canceled** in
the Vercel list.

**Types:** `feat`, `fix`, `perf`, `chore`, `docs`, `refactor`

**When to use `[skip vercel]`:**
- All local dev and WIP commits
- Documentation-only changes
- Config changes not yet ready for production
- Any commit you're not confident has a passing build

**When to deploy (push without `[skip vercel]`):**
- You've run `pnpm build` locally and it passes clean
- You've batched multiple improvements into a coherent release
- You've tested locally against production data (`.env.local.prod`)
- One deploy per "release" — don't push 10 small commits; batch them

### Deploy Sequence

```powershell
# 1. Test locally
pnpm build          # MUST pass clean — Vercel uses strict TypeScript
pnpm dev            # Smoke test at localhost:3000

# 2. Commit without [skip vercel] tag, on the FIX's worktree branch (never on the
#    primary checkout — root CLAUDE.md §Deployment; `pnpm session:worktree <id>`)
git add packages/... apps/...
git commit -m "feat(scope): description"

# 3. Land by fast-forward from the rebased branch — Vercel builds on the push
git fetch origin && git rebase origin/main
git push origin feature/fix-<id>:main     # rejected if main moved: rebase, retry

# 4. Monitor build
# Vercel dashboard: vercel.com/civitics-platform/civitics

# 5. Verify on production
# https://civitics-civitics.vercel.app
# (Invoke-WebRequest "https://civitics-civitics.vercel.app/api/claude/status" -UseBasicParsing).Content

# 6. Resume local dev commits with [skip vercel]
git commit -m "[skip vercel] chore: next change"
```

### FIXES workflow — mechanics

The rules are in root `CLAUDE.md` §FIXES Workflow, the trailer vocabulary in
`docs/cc/PROMPT_TEMPLATE.md` §FIX bookkeeping; this is the how. The FIX-1016
history is in `docs/archive/claude-md-root-2026-10-23.md`.

| command | does |
|---|---|
| `pnpm fixes:status [FIX-NNN …] [--open\|--closed] [--since D] [--json]` | the derived status, e.g. `FIX-914 closed 2026-09-09 42b36de3 prod-only …` |
| `pnpm fix:add --title "…" --severity "🟠" --size S --section "…" --lane ops --body "…"` | appends a bullet with the next free id and its `<!--lane:…-->` marker; prints the id |
| `pnpm fix:reopen FIX-NNN --note "…"` | appends a `reopen` row; refuses an id with no bullet marker, or one already OPEN |
| `pnpm fixes:sync` (`fixes:sync:dry`) | scans trunk-ancestor trailers and appends `(id, sha, verified)` rows to `done.log`, dated by the committer instant in UTC (FIX-1319); never touches FIXES.md |
| `pnpm fixes:check` | exits 1 on drift, an off-trunk completion, or a checkbox that contradicts the log |
| `pnpm fixes:test` | the parser, derivation, trunk-guard, `fixes:clean` and `session:check` suites — run after touching `scripts/fixes-sync.mjs` |
| `pnpm fixes:clean [--older-than N]` / `fixes:archive` / `fixes:housekeep` | the only in-place FIXES.md edits: run **deliberately** — by hand or the weekly bot, never by a session's sync — behind the trunk guard |

**The weekly bot** (FIX-1345): `.github/workflows/fixes-housekeep.yml`, Mondays 10:00Z, runs `fixes:clean --older-than 7` → `fixes:archive` → `fixes:check:trunk` (the hook's checker) + `fixes:test` and commits the move as `github-actions[bot]`; a red check pushes nothing.
The 7-day grace keeps a bullet closed this week in its live section, where this week's worktrees append, so the move never conflicts with one; `fixes:status` still sees an archived id.
Run `pnpm fixes:clean` / `fixes:archive` by hand only when you want it sooner, and commit immediately.

**`pnpm check:job-registry`** (FIX-1307, tests.yml) has two modes. By default (FIX-1325) it also compares the seed fences with the live `job_registry` in the newest `docs/receipts/<day>.json` that carries one: `RETURNED:` and `UPDATED: … (<migration>)` lines are informational, and a live value no migration UPDATEs is red. `--fences-only` is the pre-FIX-1325 check: fences against the receipts' `cron_jobs[]` and the scheduled workflows.

**Status:** OPEN if an id has no `done.log` row, or its LAST row has `reopen` in
the sha column; CLOSED otherwise. It keys on column 3 and row order only, never
column 4 (`verified`), which is informational. One implementation:
`scripts/lib/fix-status.mjs`.

**`Verified:` values**, as normalized in `done.log`: `local` → `local-only`
(exercised against local Docker only); `prod` → `prod-only` (a runtime action run
only on prod — pair it with a local follow-up); `local + prod` → `local+prod`
(a local smoke test AND a post-deploy prod check, or a runtime action re-run on
each DB). No trailer → `unverified`. A `Closes:` commit takes
`closes-as-recognized` (the default), `-superseded`, `-redirected` or `-no-op`.
On a mixed commit, `Verified[FIX-NNN]: …` overrides the global value for that id
(FIX-369). An id under both `Fixes:` and `Closes:` in one commit: `Fixes:` wins.

**Audit greps** on `docs/done.log`: `"| prod-only |"` (no local repro),
`"| local-only |"` (prod side never confirmed), `"| unverified |"` (trailer
forgotten), `"| closes-as-"` (administrative closures). Rows before 2026-05-18
used `Fixes:` for both kinds, plus a few one-off `superseded` / `redirected` values.

---

## Database Operations

### Local Supabase

```
Connection string:  postgresql://postgres:postgres@127.0.0.1:54322/postgres
Studio UI:          http://127.0.0.1:54323
API endpoint:       http://127.0.0.1:54321
Keys:               run `supabase status` to get local publishable/secret keys
```

### Schema Changes — Always Via Migrations

**Never modify the database schema directly. Always use migration files.**

```powershell
# 1. Make schema change locally (e.g., in Supabase Studio or via SQL)

# 2. Generate migration file from the diff
supabase db diff --local -f migration_name
# Creates: supabase/migrations/YYYYMMDDHHMMSS_migration_name.sql

# 3. Rehearse it twice on the clone, then record it (FIX-1351; never `supabase db reset` —
#    the clone cannot replay from zero, see §Environment Files)
node scripts/db-query.mjs --local --file supabase/migrations/<file>.sql   # x2: the second run must change nothing
supabase --workdir <worktree> migration up --local                       # the third, recording apply

# 4. Push migration to production — the gated, dry-run-first path (root CLAUDE.md §Database)
pnpm db:push:prod -- --dry-run
pnpm db:push:prod
```

**Migration rules:**
- Append-only — never modify an existing migration file
- Always reversible — include a `-- DOWN:` section or document manual rollback
- Filename format: `YYYYMMDDHHMMSS_description.sql` — the 14-digit timestamp the CLI orders by; this repo names the FIX (`20261026000000_fix1349_move_ec_fe_vacuums.sql`)
- Never `DROP TABLE`, `TRUNCATE`, or `DELETE` without explicit confirmation

**A held migration on main rides every later push (rule 411, cc-259).**
`supabase db push` has no exclude flag. `--include-all` only widens the set,
and `scripts/db-push-prod.mjs --workdir` applies EVERY pending file in the
folder. So once a file is on `main` but its push is held, either it holds
every push behind it, or the next push carries it deliberately. In that case
the push's dry run lists it, and its STOP table names what it fires on
landing. The worked case: `20261102000000_fix1374_…` was held on 11-02 (the
box was IO-throttled). Its five sweeps are `by … 1 * *` with the 1st already
past, so they would RETURN and arm the moment it landed. cc-259's six files
therefore landed on `main` with no push, and cc-263 (Sat 11-07) pushes all
seven in one gated class-P push.

### Current Migration State

All migrations live in `supabase/migrations/`. As of 2026-04-22 the chain spans three eras:

1. `0001`–`0024` — legacy public-schema era (pre-shadow).
2. `20260417*`–`20260421000007` — Stage 1 shadow schema build-out (17 tables in `shadow.*`).
3. `20260422000000` — **promote shadow → public**: renames `shadow.*` into `public.*`, drops pre-shadow `public.proposals`/`votes`/`financial_*`, drops 11 dependent RPCs, drops `proposal_trending_24h` mat view.
4. `20260422000001` — fixes the `bill_details_sync_denorm()` trigger body (the promotion moved the function via `ALTER FUNCTION … SET SCHEMA`, which does NOT rewrite body text).

**Known issue:** Migration `0008` was duplicated during early development and renumbered to `0021` to resolve the conflict. Run `supabase migration list --local` to verify your local state matches production.

**After pulling post-cutover:** if your local DB was on shadow, the simplest reset is `supabase db reset --local`, which rebuilds from the full chain.

### Checking Migration Status

```powershell
# List local migration state
supabase migration list --local

# List production migration state
supabase migration list
```

### Refreshing the Local Prod-Clone — `pnpm db:clone:prod` (FIX-912)

One command. Do **not** hand-roll a `supabase db dump` + `psql` restore — that
recipe silently skips the pg_cron, materialized-view, and stamp steps below and
leaves the clone in a state nobody can reason about afterwards.

```powershell
pnpm db:clone:prod -- --dry-run    # sizes, table counts, resolved command — writes nothing
pnpm db:clone:prod                 # the real thing
```

Useful flags: `--jobs N` (parallel restore workers, default 4), `--skip-dump`
(retry a failed restore against the dump already on disk), `--keep-dump`,
`--dump-file PATH`, `--env-file PATH`, `--restore-url URL`.

From a **git worktree**, `.env.local.prod` is a local stub with no password, so
point at the primary checkout:

```powershell
pnpm db:clone:prod -- --env-file C:/Users/Craig/Documents/Civitics/App/.env.local.prod
```

What it does, and why each step is there:

| Step | Why |
|---|---|
| Refuse to run unless `.env.local` is `http://127.0.0.1:54321` | The script TRUNCATEs every public table on its target. Restoring prod data *onto prod* is the catastrophic failure mode, so the guard is structural, not advisory. |
| Warn if prod pipelines are mid-run | `pg_dump` is MVCC-consistent, but a dump pulled mid-nightly is "prod halfway through rewriting itself". Recorded in the stamp; re-run outside the nightly window for a quiescent clone. |
| Preflight privileges **before** truncating | A permissions failure then leaves the DB intact instead of stranded between TRUNCATE and restore. |
| Park `pg_cron`, restore, un-park | pg_cron is live locally. A nightly rebuild firing partway through a multi-GB load corrupts the result silently. Parking uses `cron.alter_job(active := false)` — `cron.job` is owned by `supabase_admin` and grants `postgres` SELECT but *not* UPDATE. Only jobs that were active before are re-activated. |
| Restore as `supabase_admin`, not `postgres` | `pg_restore --disable-triggers` must disable internal RI constraint triggers, which needs SUPERUSER. Local `postgres` owns the tables (enough for TRUNCATE) but is **not** superuser. `entity_comments` has circular FKs, so `--disable-triggers` is genuinely required. |
| Refresh the 13 materialized views | `pg_dump --data-only` does **not** carry matview contents. `CALL refresh_derived_mvs('daily')` + `('weekly')` covers exactly those 13. |
| `VACUUM (ANALYZE)` every public table | A bulk load leaves zero planner stats; local `EXPLAIN` output is worthless without them, and index-only scans need the visibility map set. |
| Write the `pipeline_state` stamp **last** | `pipeline_state` arrives in the dump carrying *prod's* rows, so a stamp written any earlier is clobbered by the restore. |

Everything not in `public` is untouched — in particular `auth.*` survives, so
the local auth-testing harness (FIX-659/660) does not need re-minting. The
database is never dropped and `supabase db reset` is never run.

#### Reading the staleness stamp

```powershell
node scripts/db-query.mjs --local "SELECT value, updated_at FROM pipeline_state WHERE key='local_clone_restore';"
```

```json
{
  "restored_at": "2026-07-27T06:31:00.000Z",
  "prod_project_ref": "xsazcoxinpgttgquwvuf",
  "dump_bytes": 2402000000,
  "tables_restored": 114,
  "cli_version": "pg_dump (PostgreSQL) 18.3",
  "restore_jobs": 4,
  "elapsed": "21m03s",
  "pipelines_running_at_dump": ""
}
```

`restored_at` is the answer to "how stale is local?". `pipelines_running_at_dump`
empty means prod was quiescent; non-empty names the pipelines that were mid-run,
so their tables are a part-way snapshot. **No row at all means the clone predates
FIX-912 and its age is unknown** — refresh before trusting it.

#### Local clone staleness — the trap this exists to prevent

`pg_cron` runs **locally**, on the same schedule as prod. Derived data therefore
keeps rebuilding itself on a stale clone: `data_sync_log` shows recent runs,
matviews show recent refreshes, and the whole database *looks* current while its
source tables are months old. The clone answers confidently and wrongly, and
nothing on the surface says so.

Three separate workstreams paid for this before the stamp existed — the SLD
choropleth could not be developed locally, and a `money_vote_influence` screening
pass had to mark every number it produced "prod-verify before authoring". Check
`local_clone_restore` before trusting local numbers; recency in `data_sync_log`
proves nothing about the sources.

### Data facts worth not rediscovering

- **`officials.party` is a Postgres ENUM named `party`,** and its labels are
  lowercase by definition: `democrat, republican, independent, libertarian,
  green, other, nonpartisan`. Identical on local and prod, and unaffected by a
  clone refresh — lowercase values are not clone drift or a casing bug. Query
  the live list with:

  ```sql
  SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'party' ORDER BY e.enumsortorder;
  ```

### Redefining a live MV — swap, never DROP + CREATE (FIX-1032)

*Moved from `packages/db/CLAUDE.md` by cc-246 (FIX-1346); the rule stays there
as one line.*

Changing the defining query of an MV that a request path reads has exactly one
safe shape. `DROP` + `CREATE … WITH DATA` holds ACCESS EXCLUSIVE for the whole
populate — that is FIX-1032's incident, **442 s of request-path timeouts on
2026-08-13**. `DROP` + `CREATE … WITH NO DATA` avoids the lock but leaves the MV
empty, and `REFRESH … CONCURRENTLY` *refuses* to refresh an unpopulated MV, so
the surface reads empty until the next scheduled refresh. Build a populated twin
and swap it in:

```sql
CREATE MATERIALIZED VIEW public.<name>_new AS <new query> WITH NO DATA;
CREATE UNIQUE INDEX <name>_new_pk ON public.<name>_new (<pk col>);
GRANT SELECT ON public.<name>_new TO anon, authenticated, service_role;
REFRESH MATERIALIZED VIEW public.<name>_new;            -- long; no lock on the live MV
-- then, atomically:
DROP MATERIALIZED VIEW public.<name>;
ALTER MATERIALIZED VIEW public.<name>_new RENAME TO <name>;
ALTER INDEX public.<name>_new_pk RENAME TO <name>_pk;
```

Rules that make it safe:

- **Wrap the cutover in a `DO $$ … $$` block, not `BEGIN; … COMMIT;`.** A `DO`
  block is one statement and so is atomic whether or not the migration file is
  applied inside an implicit transaction; an explicit `BEGIN` inside an already
  open block is a warning, and its `COMMIT` ends the *outer* block.
- **Guard for idempotency** on `to_regclass('public.<name>_new')` and on a
  substring of the outgoing definition, so a re-run is a no-op.
- **Read `pg_depend` first.** A VIEW or RULE on the MV blocks the `DROP` and
  needs its own step. Check `obj_description` and `reloptions` too — a `RENAME`
  carries neither, so re-apply anything the old object had.
- **The ACL comes back on its own.** Supabase's schema-`public` default
  privileges give the new object the same `anon`/`authenticated`/`service_role`
  grants; the explicit `GRANT SELECT` is belt-and-braces.
- **Prove equivalence on a clone, not on prod.** Evaluate both defining queries
  in one snapshot and require `(old EXCEPT new) UNION ALL (new EXCEPT old)` to
  be 0 rows. On prod the two sides were populated at different times, so a delta
  there is staleness — assert only a loose bound before the cutover.
- **Swap against a warm box, in a window clear of the scheduled jobs.** The
  populate is a normal long statement; `pnpm db:push:prod` carries them fine
  (FIX-1030's ran 442 s).

First instance: `20260902120000_fix1134_1032_official_homepage_stats_single_fr_scan.sql`,
swapping `official_homepage_stats_mv` (37,294 rows) on prod 2026-09-02 22:47 UTC.
What it actually cost, so the next one can be planned rather than guessed:

- **44 s end-to-end** through `pnpm db:push:prod` — ~41 s of populate (a Parallel
  Seq Scan of the 4,932 MB `financial_relationships` heap) and a sub-second
  cutover.
- **Zero lock waiters at every sample.** A 15 s poll of `pg_stat_activity`
  across the whole window showed `wait_event_type='Lock'` = 0 and no ungranted
  relation locks — the live MV kept serving reads throughout. That is the whole
  point of the pattern, and it is the measured contrast with FIX-1032's 442 s.
- **The census came back identical**: same ACL
  (`{postgres,anon,authenticated,service_role}=arwdDxtm`, restored by default
  privileges without any explicit grant being load-bearing), same `_pk` index
  name, `reloptions`/`COMMENT` still null, `pg_depend` still just the index, no
  leftover `_new`.
- **PostgREST needed no schema reload** — an anon read of the swapped MV
  returned 200 with the right columns immediately. Same name + same column set
  means the schema cache never notices the new OID.
- **The pre-cutover delta was explainable to the row.** 431 of 37,294 officials
  differed; `votes` had gained 3,017 rows across exactly 431 distinct officials
  since the old MV's 06:00 build, and `financial_relationships` had zero writes
  to officials in that window. Staleness, not disagreement — which is what the
  loose bound is there to let through.
- Side benefit worth knowing: a fresh populate compacts. The MV went 770 -> 385
  pages (8,608 kB -> 4,272 kB), because the old heap carried refresh bloat.

### Retiring or pausing a pg_cron job (FIX-1059)

*Moved from `packages/db/CLAUDE.md` by cc-246; the rule stays there as one
paragraph.* Any `cron.unschedule(...)` or `cron.alter_job(..., active := false)`
on a job whose procedure writes `data_sync_log` lands a
`public.rollup_watch_overrides` row in the SAME migration.

`list_scheduled_rollup_pipelines()` derives its watch list from
`data_sync_log`, so a retired job's pipeline stays in the census for the whole
90-day lookback with nothing recording *why*. `recipient_count_reconcile` is the
worked example: FIX-736 unscheduled `ec-recipient-count-reconcile` on 2026-07-05
and the retirement was written down nowhere, so the registry carried it as live
at a fabricated 168h `default` cadence for six weeks. It only escaped paging
because FIX-977b had separately NULLed the `default` escalate threshold.

```sql
INSERT INTO public.rollup_watch_overrides (pipeline, retired_at, note)
VALUES ('<pipeline_name>', now(), 'Why it was retired, and what replaced it.');

-- or, for a deliberate pause you intend to undo:
INSERT INTO public.rollup_watch_overrides (pipeline, held_since, hold_reason, note)
VALUES ('<pipeline_name>', now(), 'short reason', 'longer context + the FIX id');
```

Rows in that table are **declarations, never measurements** — they say what a
human decided. A declared pipeline stays LISTED in the registry with
`retired`/`held` set and both thresholds NULL; it is never dropped, because
dropping it would narrow the watch list, which is the FIX-977 defect wearing a
different hat (`detector-coverage.test.ts` pins registry ⊇ census). The table
also carries an optional `cadence_hours` for asserting a cadence the schedule
cannot express.

Anything the canary finds that is NOT declared — pg_cron rows, no active job,
no override row — appears in the registry's top-level `orphans` array and in the
nightly canary email as report-only. That list is the backlog of retirements
nobody wrote down.

**The table has a second writer as of FIX-1177/1172 (cc-133): `claimProdSession()`.**
A supervised prod session holds every GUARDED pipeline for its duration
(`held_since` + `hold_reason` prefixed `prod session held: `) and clears its own
holds on release, so a long landing no longer reports
`stale rollup: financial_entity_totals_refresh` at the operator causing it. Two
consequences for anyone writing a row by hand:

- **A human hold wins.** The session's upsert skips a row that already has
  `held_since` set, and its release clears only rows whose `hold_reason`
  carries the session prefix. Your hold and your reason survive a session.
- **A leftover session hold is a canary finding**, `prod_session_hold_stale`
  (report tier) — because a hold suppresses both thresholds, so one nobody is
  behind has blinded the instrument. The next claim sweeps it. See
  `docs/ops/prod-holds.md`.

The table's own COMMENT still says "Read only by
`list_scheduled_rollup_pipelines()`", which was true when FIX-1059 wrote it and
is now stale in two ways: `canary-prod-session.ts` reads it, and
`claimProdSession()` writes it. The comment is migration text and is left as it
is rather than rewritten in place; this paragraph is the correction.

### The canary's rate line (FIX-978, FIX-1315, FIX-1338) and converting a cutover hold

`check_pipeline_rate_regression()` rates each pipeline's `complete` runs in
seconds per 1k rows of work, and judges the last 3 against its own 90-day
P90 × 2. `sustained_regression` means even the best recent run is above the
line; it escalates only with ≥ 5 baseline runs.

- **The denominator follows the body's write mode (FIX-1338, from
  `20261104000000`).** Work is `metadata.desired_rows` when the body stamps
  it (digits only, > 0), else `rows_inserted + rows_updated`. A merge-mode
  body writes only its delta, and its cost is the scan over the desired set.
  Each element names its recent window's `denominator`: `desired_rows`,
  `rows_written` or `mixed`. A new merge-mode body should stamp
  `desired_rows`. Then it rates correctly with no change to the check.
- **Membership.** A row is rated when it stamps `source = 'pg_cron'`, OR it
  stamps no source and its pipeline has a `job_registry` row. Any other stamp
  stays out, registry or not. `agency_staffing_rollup_refresh` stamps
  `pg_cron/backfill`, so the check never rates it. It sits outside D3 until
  FIX-1317 decides membership (Craig 11-03 #2 (a)).
- **A hold demotes, it does not hide (FIX-1315).** `canary-rate.ts` reports a
  held or retired pipeline's regression at `report`. When the hold converts,
  the same key escalates again on its next run.
- **Converting a cutover hold.** A FIX-1311 cutover hold converts to a
  cadence row (`held_since` / `hold_reason` NULL, `cadence_hours` N, never
  deleted) on two conditions. Its first dispatched slot must land a complete
  terminal row (the receipt), and the rate verdict must not be
  `sustained_regression`. The conversion file reads the verdict IN SQL, from
  the body the same push installs first, and quotes it in the note.
  `cadence_hours` mirrors the registry rule (24 for a daily, 168 for a
  weekly, 744 for a monthly) until the canary reads `job_registry.deadline_rule`
  (FIX-1317). The shape is `20261027001000_fix1355_…`, then
  `20261104001000`–`20261104004000` (FIX-1378). The conversion is gated on
  the row, not the wall: a `complete` row above its band still converts and
  gets its own FIX (FIX-1384, FIX-1385). The revert,
  `scripts/fix1378-revert-convert-cutover-holds.sql`, restores FIX-1311's
  text byte-for-byte.
  - Converted so far:
    - refresh-derived-mvs-daily 24 (FIX-1355, on prod).
    - run_rule_taggers 24, and donor-party / treemap / agency-staffing 168 (FIX-1378).
    - group-donor 168 (`20261104006000`, FIX-1380, cc-255). Its revert is
      `scripts/fix1380-revert-convert-group-donor-hold.sql`.
    - contract-flow 168 (`20261106000000`, FIX-1382, cc-263). Its revert is
      `scripts/fix1382-revert-convert-contract-flow-hold.sql`.
    - The five monthly sweeps 744 (`20261107000000`, FIX-1383, cc-263). Its
      revert is `scripts/fix1383-revert-convert-five-sweeps-holds.sql`.
    - All eleven of those are on prod since 11-07.
  - Left of the FIX-1311 holds: officials and the MV vacuum series, which MOVE
    rather than convert.
  - **A rate step is not always a slowdown.** group-donor's s/1k rose ~10× on
    10-07 because rows written fell 542k → 47,208 at the same ~100 s wall. Read
    the rows beside the verdict before you call one a regression.

### Merging `financial_entities` rows — the FK-rewrite sequence (FIX-271, FIX-381)

*Moved from `packages/db/CLAUDE.md` by cc-246; the rule and "When to extend
this list" stay there.* Run `pnpm --filter @civitics/data data:audit-fe-fk-surface`
first: it is the source of truth for which tables reference an FE row, and its
reports land at `docs/audits/<date>-fe-fk-surface-audit-{local,prod}.md`.

[supabase/migrations/20260514000001_cross_source_backfill.sql](../supabase/migrations/20260514000001_cross_source_backfill.sql)
is the canonical end-to-end FK-rewrite migration (FIX-271). Mirror its
execution sequence:

1. `_loser_remap` temp table flat `(loser_id → winner_id)`.
2. `financial_relationships` — **set-based DELETE+INSERT** aggregating by
   `(type, new_from_id, to_type, new_to_id, cycle_year)` to dedupe the
   `_relcycle_unique` UNIQUE before insert. Straight UPDATE collides.
3. `external_relationships` — straight UPDATE (UNIQUE is `(source, source_id)`).
4. `external_source_refs.entity_id` — straight UPDATE (UNIQUE is `(source, external_id)`).
5. Hard-FK rewrites — straight UPDATE: `edgar_companies`,
   `edgar_executive_officers`, `edgar_major_shareholders`,
   `irs990_filings`, `irs990_officers`, `irs990_grants_out.matched_entity_id`,
   `financial_entities.parent_entity_id` (self-ref).
6. `entity_tags` + `enrichment_queue` (added per FIX-381) — see below.
7. Winner row merge — sum totals, longest `display_name`, best metadata jsonb.
8. DELETE losers.
9. TRUNCATE `entity_connections`; downstream rebuild repopulates.

`page_views` also carries free-TEXT discriminators but holds 0 FE rows
(analytics, stale-OK; skip). `notifications` + `user_follows` discriminate on
the ENUM `follow_entity_type(official, agency)` — FE is forbidden at the type
system; skip. The 2026-05-25 twelve-table surface table is in
`docs/archive/claude-md-db-2026-10-24.md`; re-run the audit rather than trust it.

Step 6, after step 5 (hard-FK rewrites) and before the winner-merge step:

```sql
  -- ── 6a. entity_tags rewrite (FIX-381) ──────────────────────────────────
  -- UNIQUE (entity_type, entity_id, tag, tag_category) → low collision risk.
  -- A loser row tagged 'pharma' and a winner row also tagged 'pharma' would
  -- collide. Pre-delete colliding loser rows; the winner's tag survives.
  WITH dupes AS (
    SELECT et_loser.id
      FROM public.entity_tags et_loser
      JOIN _loser_remap lr ON lr.loser_id = et_loser.entity_id
      JOIN public.entity_tags et_winner
        ON et_winner.entity_id   = lr.winner_id
       AND et_winner.entity_type = et_loser.entity_type
       AND et_winner.tag         = et_loser.tag
       AND et_winner.tag_category = et_loser.tag_category
     WHERE et_loser.entity_type = 'financial_entity'
  )
  DELETE FROM public.entity_tags WHERE id IN (SELECT id FROM dupes);

  UPDATE public.entity_tags et
     SET entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE et.entity_type = 'financial_entity'
     AND et.entity_id   = lr.loser_id;

  -- ── 6b. enrichment_queue rewrite (FIX-381) ─────────────────────────────
  -- UNIQUE (entity_id, entity_type, task_type). entity_id is TEXT — cast
  -- the UUIDs from _loser_remap. A loser + winner both having a pending
  -- 'tag' row for the same task_type would collide; drop the loser's
  -- (the winner's row stays in the queue).
  WITH dupes AS (
    SELECT eq_loser.id
      FROM public.enrichment_queue eq_loser
      JOIN _loser_remap lr ON lr.loser_id::text = eq_loser.entity_id
      JOIN public.enrichment_queue eq_winner
        ON eq_winner.entity_id   = lr.winner_id::text
       AND eq_winner.entity_type = eq_loser.entity_type
       AND eq_winner.task_type   = eq_loser.task_type
     WHERE eq_loser.entity_type = 'financial_entity'
  )
  DELETE FROM public.enrichment_queue WHERE id IN (SELECT id FROM dupes);

  UPDATE public.enrichment_queue eq
     SET entity_id = lr.winner_id::text
    FROM _loser_remap lr
   WHERE eq.entity_type = 'financial_entity'
     AND eq.entity_id   = lr.loser_id::text;
```

### Regenerating `database.ts` (`pnpm db:types`)

*Moved from `packages/db/CLAUDE.md` by cc-246; the rule stays there.*

`pnpm db:types` is `supabase gen types typescript --project-id …` — it generates
from **prod**. That is the right default and the committed file is prod-faithful.

Generate from **local** instead when a migration is on disk but not yet applied
to Pro and the app must typecheck first (`supabase.rpc("new_fn")` fails
typecheck until the `Database` type knows the function):

```bash
# --workdir is REQUIRED from a worktree: the CLI locates the running stack by
# the project id derived from the workdir, and a worktree is not where the local
# stack was started. Without it: "supabase start is not running".
supabase --workdir /path/to/primary/checkout gen types typescript \
  --db-url "postgresql://postgres:postgres@127.0.0.1:54322/postgres" > /abs/path/local.ts
```

Write the temp file to an **absolute** path — Node on Windows resolves `/tmp/x`
to `C:\tmp\x`.

**The local gen differs from the prod gen by four artifacts, none of them
schema.** Do **not** overwrite the committed file with the local gen. Measured
2026-09-19 (CLI 2.78.1), a local gen against a clean clone is 50 insertions / 14
deletions against the committed file, and every one of them is an artifact:

| # | artifact | lines | fix |
|---|---|---|---|
| 1 | local gen OMITS the `__InternalSupabase` `PostgrestVersion` header | −4 | splice the committed header back on |
| 2 | local gen ADDS a `graphql_public` schema block to `Database` | +24 | the same splice drops it |
| 3 | local gen ADDS `graphql_public` to the `Constants` export | +4 | strip it — see below |
| 4 | generic-constraint parentheses differ by CLI version (`TableName extends (X extends … : never) = never` vs the same unparenthesised) | 10 pairs | leave alone; a prod-side `db:types` flips it straight back |

Splice the committed header onto the local `public` schema:

```js
const marker = "\n  public: {";   // unique — "graphql_public" is followed by "graphql_public:"
merged = committed.slice(0, committed.indexOf(marker)) + local.slice(local.indexOf(marker));
```

**The `Constants` `graphql_public` entry is MULTI-LINE as of CLI 2.78.1:**

```
  graphql_public: {
    Enums: {},
  },
```

not the single-line `graphql_public: { Enums: {} },` an older regex was written
for. A regex for the single-line shape matches **nothing** and the churn lands in
the commit silently. **Assert after stripping** rather than trusting the replace:

```js
if (/graphql_public/.test(merged)) throw new Error("graphql_public survived the strip");
```

**The local clone carries objects prod does not.** Proof/audit sessions leave
scratch tables on the local Docker clone. A wholesale splice pulls them into
`database.ts`, where they are indistinguishable from real schema. Before
generating, check:

```bash
node scripts/db-query.mjs --local "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND relname LIKE '\_%' ORDER BY 1;"
```

and confirm each hit against prod by name before deciding it is scratch — some
underscore-prefixed tables are real (`_drb_chunk_fe`, `_drb_donor`, `_drb_fe`,
`_drb_targets` exist on prod and belong in the generated types). 2026-09-19
dropped ten local-only scratch tables (`_eq_a`, `_eq_b`, `_eq_c`, `_eq_before`,
`_proof_ref_br`, `_proof_ref_odrmv`, `_proof_ref_odt`, `_proof_ref_sa`,
`_proof_ref_sd`, `_proof_ref_tm` — 916 MB), which took the local-gen diff from
392/10 to 50/14. `_proof_recips` is still there and still local-only.

**When the real change is small, patch the committed file surgically instead of
splicing.** Then the diff is only what you added, which is also what the future
prod-side gen produces.

---

## Pipeline Operations

Pipelines run as Node.js scripts in `packages/data/`. They are NOT part of the Next.js build.

### Available Pipelines

| Script | What it does | Cost |
|--------|-------------|------|
| `data:congress` | Congress.gov → officials + votes | Free |
| `data:fec-bulk` | FEC bulk files → financial_relationships | Free |
| `data:usaspending-bulk` | USASpending.gov bulk archives → financial_relationships (contract/grant), both categories; `-assistance` for grants only; `:prod` for a supervised prod run (claims the session; see `packages/data/CLAUDE.md` → USASpending) | Free |
| `data:regulations` | Regulations.gov → proposals | Free |
| `data:openstates` | OpenStates → state legislators | Free |
| `data:courtlistener` | CourtListener → judges | Free |
| `data:tag-rules` | Rule-based entity tagging (urgency, sector, etc.) | Free |
| `data:ai-summaries` | AI plain-language summaries via Claude Haiku | ~$0.035/run |
| `data:tag-ai` | AI-based topic/issue classification | ~$0.60/run |
| `data:nightly` | Full nightly sync (runs all, in order) | ~$0.60/run |

The pipelines' own cost-gated runs are the only AI drain path. The hand-run `enrichment_queue` drain (the `drain-worker` subagent and `data:drain:claim`) was retired by cc-249 (context-haircut s4c); its runbook is history in `docs/archive/claude-md-root-2026-10-23.md`.

### Running Pipelines

```powershell
# Run a single pipeline
pnpm --filter @civitics/data data:fec-bulk

# Dry run (estimate cost, no writes)
pnpm --filter @civitics/data data:ai-summaries -- --dry-run

# Full nightly (orchestrator handles ordering + derives entity_connections)
pnpm --filter @civitics/data data:nightly
```

### Safe Run Order

Source pipelines run first, then the `ec-crawl` registry unit derives edges (`docs/cc/projects/dispatcher.md`; it replaced the nightly's `rebuild_entity_connections()` call). The nightly orchestrator and the dispatcher handle this — only re-create the order manually for one-off ad-hoc runs:

```
1. data:congress           (heaviest — 227k vote records)
2. data:fec-bulk           (PAC contributions, ~200MB streamed)
3. data:usaspending-bulk   (contract/grant awards; on prod it is dispatch-only / a supervised :prod run — FIX-1291)
4. data:regulations        (proposals + comment periods)
5. the ec-crawl unit             (dispatched; see "Entity Connections Derivation" in packages/data/CLAUDE.md)
6. data:tag-rules          (lightweight, no API cost)
7. data:ai-summaries       (costs money — run after other pipelines complete)
8. data:tag-ai             (costs money — run last)
```

### Recency Guards

Pipelines check when they last ran and refuse to re-run too soon:

| Pipeline | Minimum gap | Override |
|----------|------------|---------|
| `data:ai-summaries` | 2 hours | `-- --force` |
| `data:tag-ai` | 2 hours | `-- --force` |

### After Running Pipelines

```sql
-- Check recent runs and their status
SELECT pipeline, started_at, completed_at, rows_inserted, rows_updated, status
FROM data_sync_log
ORDER BY started_at DESC
LIMIT 20;

-- Check estimated egress
SELECT * FROM platform_usage WHERE service = 'supabase' ORDER BY recorded_at DESC LIMIT 5;
```

Monitor Supabase dashboard if egress is near limits: `supabase.com/dashboard/project/xsazcoxinpgttgquwvuf`

### The Senate roll walk (FIX-1324, FIX-1372, FIX-1407)

`data:congress`'s votes step (Step 4 of `packages/data/src/pipelines/congress/votes.ts`,
in the nightly's fec phase) fetches Senate LIS XML one roll per GET from
`www.senate.gov`. senate.gov serves a few dozen GETs a night and then answers
403 (Akamai; FIX-1372, open). The walk is built around that:

- **New rolls first.** The current session is walked first. Per session, pass A
  starts above the frontier (the highest roll stored or known) and stops 3
  non-roll bodies past the end; pass B then fills the gaps below the frontier,
  where a non-roll body is a hole, not the end.
- **403 / 429 is "blocked", not "no such roll".** Wait 30 s and retry the same
  roll, then 120 s and retry. If it is still blocked it counts as `blocked`.
  Three blocked rolls end the session with `blocked ×3`. A block never counts as
  a miss and never closes a tail. The House walk still counts a 403 as a miss.
- **Paced.** 1.5 s plus 0–0.5 s jitter between Senate GETs. The User-Agent is
  Node's default on purpose: FIX-1407 measures volume and order alone, and
  identity headers are the next lever.
- **The seen-unstored record:** `pipeline_state` key
  `congress_votes:senate_rolls:<congress>`. It holds, per session, every roll
  that was fetched, parsed, and skipped before its insert, with `reason` and
  `seen_at`, plus `tail_closed`.
  - `no_proposal_reference` and `no_voted_at` stay skipped while the record's `v`
    equals `SENATE_UNSTORED_VERSION` (`senate-unstored.ts`).
  - Every other reason (guard-absent, `bill_unresolved`, `no_matchable_records`)
    is fetched again 7 days after `seen_at`.
  - `tail_closed` marks a past year's session whose end was found cleanly; its
    tail is never walked again.
  - Insert failures, blocked rolls, transient errors and past-end answers are
    never recorded.
- **Clearing it.** Bump `SENATE_UNSTORED_VERSION` when the parser learns to store
  a roll it skips today (a new document type, the nomination stage). A record
  of another version is dropped whole, `tail_closed` flags included.
  Deleting the row is also harmless: the next nightly fetches every unstored
  roll once, as before FIX-1407. The row is world-readable (`pipeline_state`'s
  public SELECT policy), so it holds roll ids, reasons, dates and flags only.

Reading a night: each Senate session logs one line, e.g.
`Senate session 2: tail after roll 258: 2 new, past end at roll 263 (3 consecutive misses) — fetched 5 in 5 GETs: …, 0 blocked (0 retries), 0 transient; 196 already stored, 60 seen-unstored skipped`.
The record logs `Senate unstored record: N known (…), +A added, −R retried`.
A blocked night adds `first HTTP 403 at GET n on roll r`.

```bash
node scripts/db-query.mjs --prod "SELECT value, updated_at FROM pipeline_state WHERE key = 'congress_votes:senate_rolls:119'"
```

### Windows-Specific: Exit Code Fix

On Windows, Node.js pipelines may crash with **exit code 3221226505** (Windows/Node libuv issue). This is fixed in the codebase by appending:

```ts
main().then(() => setTimeout(() => process.exit(0), 500));
```

If a new pipeline crashes with this exit code, apply the same pattern.

---

## Resource Management

### Current Monthly Costs (post-cutover, April 2026)

| Service | Plan | Cost | Notes |
|---------|------|------|-------|
| Supabase | **Pro** | $25/mo | Cutover 2026-04-22; 250 GB egress, 8 GB DB |
| Vercel | **Pro** | see note | `[skip vercel]` still useful. Plan corrected FIX-1194 (was recorded as Hobby); the **cost cell is unverified** — read it from the billing API, `reference_vercel_billing_charges_window` |
| Anthropic | Pay-as-you-go | ~$0.60/mo | Self-imposed $3.50 budget cap |
| Cloudflare R2 | Free | $0 | 10GB free tier |
| Mapbox | Free | $0 | 50k map loads/mo free |
| **Total** | | **~$25.60/mo** | |

### Plan Limits

**Supabase Pro:**
- Egress: 250 GB/month (overage metered, not hard-capped)
- DB size: 8 GB included, auto-scales
- Storage: 100 GB
- PITR retention: 7 days

**Vercel Pro:**
- Fluid Active CPU / invocations / Fast Origin Transfer: Pro allowances, metered
- **Cron jobs: sub-daily allowed.** The "once per day maximum" recorded here
  until FIX-1194 was a Hobby limit that stopped applying at the April cutover —
  `platform-snapshot/route.ts:10-11` says so, and four sub-daily entries have
  been live in `vercel.json` since FIX-1127/FIX-1130 (Hobby rejects those
  expressions outright, so their existence is the proof).

### Vercel crons (`apps/civitics/vercel.json`)

| Path | Schedule (UTC) | What it does | `CRON_DISABLED` |
|---|---|---|---|
| `/api/cron/nightly-sync` | `0 2 * * *` | Canary marker + grant-expiry sweep; the real nightly is GHA | yes |
| `/api/cron/notify-followers` | `0 3 * * *` | Follower notification fan-out | yes |
| `/api/cron/platform-snapshot` | `*/30 * * * *` | Platform counts snapshot (FIX-1127, off GHA). FIX-1292 R7 split it for a day (2026-10-10 → 10-11, cc-213 → cc-216); the `/usage` and `/status` half routes remain but no cron fires them | no |
| `/api/cron/front-door-watch` | `*/15 * * * *` | Front-door wedge detector (FIX-1130) | no |
| `/api/cron/cron-watchdog` | `*/2 * * * *` | Fires **both** budget watchdogs (FIX-1194) | yes |

**The two firing paths, and how to tell them apart.** `cron-watchdog` does not
replace pg_cron's `cron-job-budget-watchdog` and `derived-mvs-unit-watchdog` —
both still run every two minutes and are unchanged. It is a second, independent
path that needs no pg_cron background worker, because the failure the watchdogs
exist to catch (fork starvation under a large landing) is the same one that
stops pg_cron firing them: on 2026-08-31 06:06–12:05 UTC every watchdog firing
failed `job startup timeout` and nothing was bounded for six hours (FIX-1123).

Both paths are idempotent by construction — the ledger is keyed on `runid`
(PRIMARY KEY) and the unit watchdog guards on `metadata ? 'watchdog_canceled_at'`
— so racing them cancels a target at most once. **`cron_job_budget_action.acted_via`
records which path acted**: `pg_cron` (the default the inner INSERT stamps) or
`vercel` (re-stamped by `run_cron_watchdogs()` for the runids of its own call).
A `vercel` row inside a window where pg_cron's own firings show `job startup
timeout` is the receipt that the second path did the work the first could not.
Read it with:

```sql
SELECT acted_at, jobname, age_seconds, budget_seconds, acted_via
FROM public.cron_job_budget_action ORDER BY acted_at DESC LIMIT 20;
```

It also renders in the daily receipts, §9 "The forker".

### Conserving Resources

**Supabase egress:**
- Pause the project when not actively developing: Supabase Dashboard → Settings → Pause
- Close dashboard browser tabs (each auto-refresh = DB queries)
- The delta connections pipeline (~25KB egress) vs full re-run (~114MB) — always prefer delta

**Vercel Fluid CPU:**
- Cloudflare's `Common Exploit Paths` WAF rule blocks the PHP/WordPress scanners that burned CPU before proxy was enabled (Bot Fight Mode is off by design — see `docs/CLOUDFLARE.md`)
- Use `[skip vercel]` on all non-release commits
- `[skip vercel]`-only and docs-only pushes: zero Vercel build cost — since
  FIX-1359's `ignoreCommand` (2026-10-28); before it every push built

### Emergency Kill Switches

Set these in Vercel Dashboard → Settings → Environment Variables (no code deploy needed):

| Variable | Value | Effect |
|----------|-------|--------|
| `CRON_DISABLED` | `true` | Stops the three **Vercel** cron routes that honour it (`/api/cron/nightly-sync`, `/api/cron/notify-followers`, `/api/cron/cron-watchdog`). It does **not** stop `platform-snapshot` or `front-door-watch` (neither reads the flag — both are watchdogs, on purpose), **not** the GitHub-Actions nightly, and **not** any of the 38 pg_cron jobs — see `docs/ops/prod-holds.md` for what does (FIX-1173). Note it DOES silence the Vercel half of budget enforcement while leaving pg_cron's half running (FIX-1194) |
| `SUPABASE_AVAILABLE` | `false` | Prevents 10-second timeout burns when Supabase is paused |
| `CONNECTIONS_PIPELINE_ENABLED` | `false` | Disables connections pipeline |
| `AI_SUMMARIES_ENABLED` | `false` | Disables AI summary generation (officials/proposals summaries, the ai-summaries pipeline). Since FIX-311 it no longer covers the tagger or the narrative — each AI feature has its own switch below, and `"false"` forces it off whatever the DB switch says (`packages/db/src/kill-switches.ts`) |
| `AI_NARRATIVE_ENABLED` | `false` | Disables `/api/graph/narrative` (the graph header ✨ Explain button) |
| `AI_TAGGER_ENABLED` | `false` | Disables the AI tagger (enrichment-queue tag work) |
| `CHORD_DATA_ENABLED` | `false` | Disables chord diagram data queries |

**When pausing Supabase:** Always set `SUPABASE_AVAILABLE=false` in Vercel first to prevent functions from timing out on dead DB connections.

### The dispatcher's memory dials (FIX-1354)

Two rows of `public.platform_dials` decide when the dispatcher stops arming
work because the box is short of memory. Both read the on-box mirror
`pipeline_state.box_health_mem`, which `/api/cron/box-health` (Vercel, every
2 min) writes:

| dial | default | what it excludes |
|---|---|---|
| `swap_ceiling_mb` | 1018 | **every pick.** When swap in use is ≥ this, `box_is_saturated()` reads `saturated / reason memory`, and the tick logs `skipped` / `box: memory`. The GitHub-Actions nightly is included: its `by 0 21 * * *` window lapses to the GHA `schedule:` fallback. The `box_backoff_gate` START gates and the per-chunk backoffs of the four heavy rollups back off on it too |
| `headroom_target_mb` | 150 | **one due row.** When MemAvailable − the row's `cap_mb` (default 64) is < this, the row waits as `headroom: <avail> MB avail − <cap> MB cap < 150 MB` in `dispatch_log.excluded`. Since FIX-1357 (2026-10-28) a 64-cap crawl needs ≥ 214 MB and the 128-cap `refresh-derived-mvs-daily` ≥ 278 MB (at the old 128 / 256 caps: 278 / 406) |

- **A stale mirror fails open.** If the route has not written for longer than
  the probe's freshness (180 s), neither dial excludes anything. The tick's
  `box.thresholds.memory.mem_stale` reads `true`, and
  `get_dispatcher_status().mem_stale_ticks_24h` counts it. The on-box clauses
  (`stale`, `fork_failures`) still fail closed.
- **Moving a dial is one UPDATE.** For example `UPDATE public.platform_dials
  SET swap_ceiling_mb = 1024;` (any value above SwapTotal turns the ceiling
  off) or `SET headroom_target_mb = 0` (turns the per-row test off).
  `pause = true` stops everything. `scripts/fix1354-revert-box-gate-memory-rules.sql`
  is the full revert.
- **A planned restart is the lever for the creep until the tier changes.**
  The 2026-10-26 census (`docs/audits/2026-10-26-box-memory-census.md` §M1)
  shows swap back at ~420 MB within 2 h of the 10-25 reboot. On the previous
  uptime it read 912–926 MB on day 8 and P50 981 MB on day 13; on day 17 the
  box wedged. MemAvailable does not show the creep (median ~387 MB on day 1 and
  on the creep days alike), so watch swap: a quiet-window restart around day 10
  of uptime resets it.

### The login roles' memory GUCs (FIX-1356) and the caps rule (FIX-1357)

Since 2026-10-28 01:22:53Z, `pg_db_role_setting` in database `postgres` reads:

| role | setconfig |
|---|---|
| `postgres` | `{statement_timeout=3h, work_mem=64MB, max_parallel_workers_per_gather=0, hash_mem_multiplier=1}` |
| `authenticator` | `{max_parallel_workers_per_gather=0, hash_mem_multiplier=1}` (its global row — `safeupdate`, 8 s / 8 s — is separate and untouched) |

The server itself stays at `max_parallel_workers_per_gather 1` and
`hash_mem_multiplier 2`.

- **Why these two roles.** `postgres` is every pg_cron unit (each firing is a
  fresh login), every gated push, every ad-hoc read and the GHA direct
  connections. `authenticator` is PostgREST's login, so it covers every
  request. Role settings apply at LOGIN; `anon` / `authenticated` rows would be
  inert for these.
- **What they buy.** Parallel 0 removes the DSM-segment class (cc-182/188, the
  10-07 swap storm). At 1 the request path's heavy-entity FR reads planned
  `Gather Merge`. Multiplier 1 halves every hash node's peak (64MB → 64 MB per
  node for jobs, 128MB bodies → 128 MB); a hash that no longer fits spills to
  batches — IO, not swap.
- **How to read them.** Read the catalog row, plus `pg_settings.reset_val` from
  a session whose `pg_stat_activity.backend_start` postdates the change.
  Supavisor hands back warm backends, so a plain `db-query --prod` can show the
  old value (playbook C12). `db-query --prod`'s prelude sets the parallel GUC
  to 0 itself; `RESET` it first to see the role value.
- **Mechanism.** `ALTER ROLE … IN DATABASE postgres SET` works for USERSET
  parameters on roles `postgres` administers. `has_parameter_privilege` cannot
  tell you so — it reads f even for `work_mem`.
- **Reverts.** `scripts/fix1356-revert-parallel-hash.sql` RESETs all four (no
  prior entry existed). Revert FIX-1357 with it:
  `scripts/fix1357-revert-cap-mb.sql`. Both run with
  `node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file …`.
- **The caps rule.** `job_registry.cap_mb = work_mem × hash_mem_multiplier`
  for a row whose body (or its one callee) sets `work_mem`, or inherits the
  `postgres` role's 64MB. VACUUM rows are `maintenance_work_mem` (64) and do not
  scale. GHA rows stay 128. Re-derive every cap when the multiplier, the role's
  `work_mem` or a body's `SET work_mem` moves — the headroom dial reads them
  (the table is in `20261028001000`'s header; `fix1357-caps.test.ts` pins it).

### Disk IO budget (FIX-1375)

The Micro instance bursts disk IO from a daily budget. Its baseline is 87 Mbps
(~10.9 MB/s) and its burst 2,085 Mbps. Supabase → Reports → Database → **Disk
IO consumed** shows the UTC day's percentage. Quiet days read **1 %**. The
drop-night Sunday read **17 %** (11-01). The Monday after read **88 %** by
05:40Z and stayed 88 % (11-02). The post-landing tail costs ~5× the landing.
The 11-02 figure never reached 100 % although the box throttled for 4 h, so
read the dashboard as a lagging, aggregated number, not a live gauge.

**The throttle signature:** pg_cron `job startup timeout`s in bursts, with
clean 15-minute gaps between them. load1 ≫ 2 vCPUs (16–31), ring samples go
missing, and units run 6–28× their walls (rule-taggers-daily 5,180 s against
p50 186 s). Memory stays FLAT: MemAvailable 212–447 MB, swap ≤ 620 MB. That
flat memory is what tells it apart from the swap wedge (playbook C13). The
disk series in the box-health sample (FIX-1375, since 11-03) reads it
directly. `pnpm --filter @civitics/data data:box-health:series` shows
`rd_MB/s`, `wr_MB/s` and `io%` per 2-min sample, and receipts §9 has the
day's IO line. An IO-bound unit at full burst reads ~28 MB/s at io_time
~100 % and ~3,000 reads/s (the gp3 volume's IOPS ceiling). Idle is < 0.1 MB/s
at < 1 %. A throttle is the same ~100 % at a fraction of the MB/s and IOPS.
The on-box mirror (`pipeline_state.box_health_mem`) carries the eight rate keys
and the nine raw counters since `20261104005000` (FIX-1375's mirror half)
reached prod on 11-07. The first stamped sample is 01:06:23Z (`io_time_pct` 1).

**The `shared_buffers` halving's IO curve (FIX-1379; cc-255's before, cc-263's
after; the verdict is the census's M4′).** The halving trades RAM
for `/data` reads: root reads (swap and file faults) may fall while `/data`
reads rise. Measures are p50 / p95 / max:

| window | /data read MB/s | all-disk read MB/s | io_time % | min ≥ 90 % | reads/s | rated |
|---|---|---|---|---|---|---|
| 11-03 02:58Z → 11-04 01:06Z (cc-259, the first 24 h) | 0.04 / 18.95 / 133.65 | 0.88 / 30.83 / 151.53 (all-disk total) | 0.2 / 28.5 / 100 | 10 | — | 663 of 664 |
| 11-04 00:14Z → 11-05 00:12Z (cc-255 read 3(k)) | 0.04 / 1.57 / 102.33 | 0.63 / 9.17 / 117.53 | 0.1 / 3.7 / 87.8 | 0 | 1.7 / 72.9 / 2,566.1 | 718 of 719 |
| 11-05 01:00Z → 01:58Z (the last hour before the restart) | 0.01 / 0.25 / 0.52 | 0.43 / 6.48 / 12.86 | 0.1 / 0.7 / 1.9 | 0 | 0.9 / 9.2 / 35.4 | 30 of 30 |
| **after:** 11-05 02:00Z → 02:46Z (the first 47 min at 128 MB) | 0.1 / 2.5 / 23 | 1.33 / 13.97 / 28.29 | 0.2 / 8.4 / 17.3 | 0 | 2.3 / 149.2 / 185.6 | 24 of 24 |
| **after:** 11-05 18:56Z → 11-07 00:58Z (30 h, all the ring holds; cc-263) | 0.08 / 1.7 / 97.53 | 0.71 / 9.8 / 103.16 | 0.2 / 3 / 100 | 2 | 2 / 74.42 / 3,057.5 | 899 of 899 |
| **after:** 11-06 00:58Z → 11-07 00:58Z (24 h; cc-263) | 0.08 / 1.69 / 97.53 | 0.71 / 9.48 / 103.16 | 0.2 / 2.81 / 100 | 2 | 2.1 / 73.7 / 3,057.5 | 720 of 720 |

The first sample after the boot (02:00:22Z) is the pool refilling: /data 23
MB/s, all-disk 28.29, io_time 17.3 %, 185.6 reads/s. By 02:06Z it was back at
idle. **Swap refilled in minutes, not hours:** 298 MB at 02:00:22Z, 484 at
02:02Z, 518 at 02:04Z, then 365–495 through 02:46Z. Before the restart it was
493. At 02:46Z resident Shmem was 64.3 MiB, so ≥ 63.7 MiB of the 128 MB pool
already sat in swap (≥ 171 MiB of 256 before). One hour says nothing about
the floor or the creep. The verdict is M4′'s.

**What the two days read (cc-263).** Quiet-day /data reads did not rise, so the
page cache took the load the pool gave up. The two minutes ≥ 90 % in the 30 h
row are one sample, 11-06 21:14Z, the nightly's start. The 11-06 line's 12
minutes cannot be placed: its window closed 20:58Z on 11-05 and the ring holds
only 30 h, so they fell out of it before the read. contract-flow's sorts remain
the likely cause by inference only. Daily rates since the host's boot:

| read per day | before (11-03 → 11-05) | after (11-05 02:46Z → 11-07 00:58Z) |
|---|---|---|
| root | ~183 GB | **~176 GB** |
| /data | ~156 GB | **~108 GB** |
| swap-in | ~36.9 GB | **~32.4 GB** |

Root and /data stand at 2.599 / 2.404 TB. The two windows are not like for
like: the before window held Tuesday's weeklies and the after window held
contract-flow. Swap-in is only ~18 % of root's reads, so the swap read is not
the whole of root's budget.

**Root's mean read size is the attribution instrument** (FIX-1397, cc-267).
Bytes and fault counts cannot say what the rest of root's reads are
(pgmajfault × 4 KiB is a floor). The sampler counts reads completed on every
whole disk from 2026-11-11 01:11Z, and the receipts' §9 Root budget line prints
`root mean read N KiB (M reads)`: ~4–8 KiB is page-sized (faults and swap: the
memory ceiling spending the IO budget), 64 KiB and up is file-backed
sequential. The first calibration, idle at 00:20Z 11-11: root 212 reads/s at
7.9 MB/s, mean **36.4 KiB**, neither shape; /data 3.6 reads/s at 15.0 KiB.

| receipts file | root GB | swap-in GB (share) | reads | hours | root mean read |
|---|---:|---:|---:|---:|---:|
| 2026-11-12 (cc-271, FIX-1397) | 176.6 | 31.4 (17.8 %) | 6,402,477 | 19.8 of 24 | **21.7 KiB** |
| 2026-11-13 | 195.1 | 34.7 (17.8 %) | 8,969,268 | 24 | **21.2 KiB** |

The whole-day mean is between the two shapes too, and the mean alone cannot
split them. If each swap-in read is one 4 KiB page, swap-in is 94 % of the
reads, and the other 6 % carry ~315 KiB each. If each is a 32 KiB cluster,
swap-in is 12 % of the reads.

**A sweep chain's IO shape (11-07, cc-263).** Two sweeps at once reach the gp3
3,000-IOPS ceiling at full burst: five samples, 01:14 → 01:22Z, read io_time
96–100 %, 2,207–3,061 reads/s, /data 26–45 MB/s, queue 20–49. That is ten
minutes ≥ 90 % with load1 ≤ 2.41, MemAvailable ≥ 219, swap ≤ 445 and 0 startup
timeouts in 86 cron runs, so no throttle. The Dec 1 slots are 30 minutes apart
and should not overlap.

- **Since the host's boot**, read 01:58:22Z: root has read **2.253 TB** and
  /data 2.193 TB, with swap-in 453.1 GB. cc-262 read 1.89 / 1.88 TB at
  11-02. **The planned restart did not reboot the host.** The raw counters
  ran on across it (/data read bytes 2,193,289,869,312 at 01:58:22Z →
  2,195,620,628,480 at 02:00:22Z), so the sampler rated straight through
  with no counter-reset gap.
- **The receipts' §9 IO lines:**
  - 11-04: 0.04 / 22.66 / 133.65; io_time 47.8 / 100 %; 10 min ≥ 90 %.
  - 11-05: 0.04 / 1.57 / 102.33; io_time 3.7 / 74.4 %; 0 min ≥ 90 %.
  - 11-06: 0.09 / 14.18 / 134.01; io_time 31.2 / 93.4 %; 12 min ≥ 90 %.
  - 11-07: 0.07 / 1.72 / 97.53; io_time 3 / 78.8 %; 0 min ≥ 90 %.
- **The dashboard's daily Disk IO consumed (Craig, 11-05):** 11-02 88 %,
  11-03 9 %, 11-04 1 %, 11-05 1 %. 11-06 and 11-07 were not read.

**The `io:` rung (FIX-1375, cc-264).** `box_is_saturated()` reads two reasons
from the on-box mirror, checked after `memory` and before `watchdog_wall`:

- **`io_throttled`:** `io_throttle_until` is in the future.
- **`io_saturated`:** `io_busy_streak` ≥ `io_samples`.

The tick's skip row reads `box: io_throttled` / `box: io_saturated`. **A
recorded hold reads at ANY mirror age** (FIX-1392 H1, cc-267, landed
2026-11-11 01:10:43Z): the throttle starves the route that freshens the mirror,
so a hold must outlive the mirror going dark, and it expires on its own instant
(≤ `io_throttle_hold_min` after the last throttle sample). A stale mirror's
**streak** and swap stay fail-open (FIX-1354 D1), and an absent mirror reads
nothing. The route needs no code: `record_box_health_mem()` derives both keys
from its previous row, and a caller cannot set either. A sample with no
`io_time_pct` carries the streak.

| dial (`platform_dials`) | default | meaning |
|---|---|---|
| `io_time_pct_ceiling` | 90 | a rated sample at or over this counts. The IOPS ceiling reads 97–100 %, idle < 1 %. |
| `io_samples` | 3 (prod **2** since 2026-11-11 01:10:43Z, FIX-1399) | consecutive samples. At 2 (~4 min) the rung holds on the second throttle sample: cc-266's replay of 11-09 set five holds, all at ≤ 12 MB/s, where 3 set two; saturated minutes 16 → 40 per 30 h. Revert: `scripts/fix1399-revert-io-samples-3.sql`. |
| `io_mbps_floor` | 12 | all-disk MB/s at or under this, with the streak standing, is the throttle signature. The baseline is ~10.9 MB/s. |
| `io_throttle_hold_min` | 60 | how long the hold outlasts the last such sample. A throttle ends when the bucket refills. |

**The brake:** `UPDATE public.platform_dials SET io_time_pct_ceiling = 101;`. The
sampler clamps at 100, so the streak stays 0 from the next sample. A hold already
set stands until it expires. Full revert, in this order:
`scripts/fix1392-revert-io-hold-stale.sql`, `scripts/fix1398-revert-status-readings-io.sql`,
`scripts/fix1399-revert-io-samples-3.sql`, `scripts/fix1377-revert-prod-op-gate-d.sql`,
then `scripts/fix1375-revert-io-rung.sql` (each guard names the body the one before
it restores).

**Who it reaches.** It excludes every arm at the tick's step 4, and no cancel path
reads it. But it is a `box_is_saturated()` reason, so every reader inherits it, as
they do `memory` and `stale`: `box_backoff_gate()` at the start of the donor,
agency, contract-flow and weekly-tagger units, and the chunk loops of
`donor_rollup_rebuild_bulk` (partial; `stale_after 12 hours` makes the rest wait
12 h) and `refresh_agency_staffing_rollup` (no cursor; the next firing redoes the
dirty set). A running chunked unit backs off at its next chunk boundary. Its own IO
can trip that.

**The status call shows it** (FIX-1398, cc-267). `get_dispatcher_status()->'box'`
carries, from the newest tick row with box readings: `io` (`{io_time_pct,
all_mbps, reads_ps, busy_streak, throttle_until}`), `thresholds_io` (`{ceiling,
samples, mbps_floor, hold_min}` as that tick read them; the dials now for a row
stamped before the rung), `mirror_age_seconds` and `mem_stale` beside `memory`
and `thresholds_memory`. A blind rung reads `mem_stale true` with a large
`mirror_age_seconds`. `->'dials'` lists the four io columns. The tick row's own
`dispatch_log.box` is the same object; note the path is `box->'io'`, not
`box->'readings'->'io'`: the tick stores `box_is_saturated()->'readings'` as `box`.

**What the replay says.** Fri 11-07 01:14–01:22Z's sweep chain read 95.9–100 % at
31–51 MB/s. The streak reaches 3 at 01:18Z and clears at 01:24Z, and `io_throttled`
never fires. donor-party's 01:17:11Z arm is admitted; fe-crawl's 01:21:11Z and the
ecs sweep's 01:23:00Z wait for the first tick after 01:24Z. On 11-02 the census reads
it as refusing the 04:47–04:57Z, 06:01Z and 06:37Z arms and leaving 03:51Z alone.
That one is inferred from the walls: the sampler started 11-03.

**The first receipt (Mon 11-09, cc-266).** It fires and refuses on a fresh mirror: 4 `box: io_saturated`
and 37 `box: io_throttled` skips, under holds set at 08:32Z and 14:23Z (ecs window 4 at 4.8–7 MB/s). The
second hold refused every tick to 15:23Z. It was **silent through the two stalls**, 05:00–07:34Z and 10:20–11:06Z (306 startup
timeouts; 11-02 had 270). The ring gapped 24–38 min, `mem_stale` failed open, and `fork_failures` did the
refusing. donor-rollup-refresh armed into a standing throttle at 08:39:49Z on a 404 s mirror. The 64–89 %
throttle samples reset the 90 % streak (FIX-1392). The match was the donor bulk's `_drb_fe` staging (FIX-1393).

**The staging bound has not run yet** (cc-271, 11-13). The bound is FIX-1393's
2,400 s `transaction_timeout`. donor-rollup-refresh armed four times from the
11-11 landing to 11-12 22:03Z. All four were caught-up exits before the `SET`:
the horizon equals the watermark (11-08 22:57:25Z), each took 0.1 s, and each
had 0 targets. No `cron.job_run_details` row carries a transaction timeout or
a lost connection. The first non-resumed staging comes after the Sun 11-15
drop night's `financial_relationships` writes.

**The gate.** `prod_op_gate` (d) reads the same keys for both classes:
`d:io_throttled` to the hold's instant, `d:io_saturated` for 10 min. Class B remembers
startup timeouts 3 h (`d:startup_timeout`, latest + 3 h). Class P remembers 10 min and
reads the live box (`d:box_<reason>`, 10 min). Over 14 d, the 10-25 wedge day out,
(d)'s startup-timeout hours read 7.1 at 60 min, 13.1 at 3 h and 4.0 at 10 min.

**The no-push rule is LIFTED** (Craig, Mon 11-09 20:39 PST, "3b"; written down
by cc-267). It was a calendar rule: no class-P push and no class-B op from the
drop night's 21:00Z until the ec-crawl's first post-landing
`entity_connection_stats_windows` pass completed (in practice Sunday 21:00Z →
Tuesday ~06:00Z). It existed because nothing in code read the disk when 11-02's
throttle armed heavy units into it. What guards a push now is code, and it does
not change: `prod_op_gate` (d) (class B remembers startup timeouts 3 h, class P
10 min plus the live box, both read the io keys), the `io:` rung (a hold honoured
at any mirror age since FIX-1392 H1), and the template's (d′) STOP row: a `job
startup timeout` or a ring sample with load1 > 8 in the last 3 h
(`docs/cc/PROMPT_TEMPLATE.md`, FIX-1377). → `docs/audits/2026-11-02-io-budget-census.md`.

### A registry row that shares its pipeline (FIX-1361) and the weekly's nets (FIX-1363)

A `by` / `stale_after` row's clock is its pipeline's newest complete|partial
`data_sync_log` row. Two dispatched rows that share a pipeline would satisfy
each other's slots, and a lapsed `by` slot writes no row. So since 2026-10-29
00:18:16Z, `job_registry.anchor_cadence` (`daily` | `weekly` | `monthly`, NULL
by default) keys the read on `metadata->>'cadence'`:

| pipeline | row | anchor_cadence |
|---|---|---|
| `refresh_derived_mvs` | `refresh-derived-mvs-daily` (`by 0 6 * * *`) | daily |
| `refresh_derived_mvs` | `refresh-derived-mvs-weekly` (`by 47 0 * * 2`) | weekly |
| `run_rule_taggers` | `rule-taggers-daily` (`by 30 6 * * *`) | daily |
| `run_rule_taggers` | `rule-taggers-weekly` (`by 0 16 * * 2`) | weekly |

- **The rule.** A row that shares its pipeline with another dispatched row
  MUST carry `anchor_cadence`, and its procedure must stamp `cadence` on the
  running row (both procedures here do). `dispatcher-r5`'s clone test fails on
  a shared dispatched row without it. The crawls share their pipelines with
  parked `at` rows only (ec-crawl / `rebuild-ec-incremental*`, fe-crawl /
  `financial-entity-totals-incremental`). Their rows stamp no cadence, so
  RETURNing one of those `at` rows needs the stamp first.
- **The rung order.** Since the same body (FIX-1362), a due row reads the
  cooldown, then `live`, then `headroom: …`. A running unit is never counted as
  a headroom exclusion.
- **refresh-derived-mvs-weekly's nets** (RETURNed `by 47 0 * * 2`, cap 128, the
  first of the five parked weeklies): the swap ceiling 1018 and headroom 150
  (it arms at MemAvailable ≥ 278); the 5400 s one-shot budget row and the */2
  watchdog; the procedure's 4200 s predictive budget (→ `partial`) and 900 s
  per-unit budget; `max_concurrent_units 2`; the I6 cooldown;
  `platform_dials.pause`.
- **Reverts.** `scripts/fix1363-revert-return-refresh-derived-mvs-weekly.sql`
  (the rule back to `at`; the hold row is the daily's cadence row and is not
  touched). `scripts/fix1361-revert-dispatcher-anchor-rung.sql` restores
  `64c8271e…`, then drops the column (pause first; WORKING ORDER in its
  header). A lighter net for one row is `UPDATE public.job_registry SET
  anchor_cadence = NULL WHERE job = '<row>'`.
- **A migration asserting a `rollup_watch_overrides` row** sees the gated push's
  own `prod session held: …` hold (`setGuardedHolds`). Accept it; cc-253's
  first push of the weekly's file refused on it and rolled back.

### A parked resumable comes back through its crawl (FIX-1365) and dpr's MOVE (FIX-1366)

A `resumable` row under `by` gets **one CALL per slot**: a `partial` is an
advancing row (the pick reads complete|partial), so the next CALL is the next
slot's. A procedure with two paths, a cursorless crawl and a windowed rebuild
whose cursor expires, must come back through the crawl.

- **donor-party-rollup-refresh** (`by 0 15 * * 2` since 2026-10-30 01:10:51Z).
  The body picks the windowed FULL rebuild when `LEAST(max(FR.updated_at),
  fr_watermark_horizon()) − donor_party_rollup_watermark` exceeds
  `pipeline_state.donor_party_crawl.full_rebuild_lag_days`. That is **30 on
  prod** (FIX-1249, set 2026-09-30); with the key absent the body uses 14. The
  windowed cycle's cursor is discarded at `c_cycle_max_age` 22 days, which at
  one CALL per Tuesday is three CALLs of ≤ 1500 s each. A cycle that needs more
  never completes. The crawl has no cursor: every slice COMMITs its rows and
  its watermark, and a capped `partial` resumes from the watermark next slot.
- **The lag is measured from the newest FR write, not from now.** A 16-day park
  read 14 d 22:53 at the RETURN, because FR's last write was 10-25 22:51Z.
- **Before a RETURN, read on prod** the dial, the watermark, FR max, the
  horizon, the mode at the dial, and any `donor_party_full_rebuild` cursor.
  FIX-1365's file asserts the dial (30) and the absent cursor and RAISEs
  otherwise. A lag past the dial is a design question: size the cycle or run
  it supervised. Do not raise the dial to dodge it.
- **The hold row stays a hold** (FIX-1311's takeover text) until the catch-up's
  receipt. A 168 h cadence row would read a multi-Tuesday catch-up as stale.
- **dpr-vacuum-analyze** (`dead_tuples > 60% of trigger + floor 7 days`,
  gates `{prod_session}`, no phase_lock; cron jobid 31 parked at the move) rides
  the RETURN. `donor_party_rollup_mv` has scale_factor 0.02 and no threshold
  reloption, so on 2.98 M rows the trigger is 59,553 and the 60 % line 35,732.
  It shares group `rollups` with the crawl, so it never runs beside it. Its
  floor anchors on the cron's last VACUUM (10-28 02:00Z), so it is due Wed
  11-04 02:00Z unless the pct term fires first.
- **Reverts.** `scripts/fix1365-revert-return-donor-party-rollup.sql` (the rule
  back to `at`; no dial was written; the cron stays parked);
  `scripts/fix1366-revert-move-dpr-vacuum.sql` (the rule back to `at`, gates
  `{}`, and the cron RE-ACTIVATED by name; pause first, as its header says).

### Every VACUUM row is dispatched (FIX-1396, cc-267)

The last eight cron vacuums MOVEd at 2026-11-11 01:10:43Z (20261111000000),
fix1366's shape ×8. Every row gates `{prod_session}`, no phase_lock, cap 64,
budget NULL, priority 4; each cron is parked by name, never unscheduled.

| row | rule | group | table · 60 % line at the move |
|---|---|---|---|
| officials-vacuum-analyze (cron 39) | `dead_tuples > 60% of trigger + floor 7 days` | officials | `officials` · 600 (threshold-only trigger 1,000) |
| odr-mv-vacuum-analyze (32) | `… + floor 24 hours` | rollups | `official_donor_rollup_mv` · 19,970 |
| treemap-individuals-vacuum-analyze (33) | `… + floor 24 hours` | rollups | `treemap_individuals_rollup` · 37,529 |
| odt-vacuum-analyze (34) | `… + floor 24 hours` | rollups | `official_donor_totals` · 256 |
| osdr-vacuum-analyze (35) | `… + floor 24 hours` | rollups | `official_small_dollar_rollup` · 256 |
| osar-vacuum-analyze (36) | `… + floor 24 hours` | rollups | `official_sector_affinity_rollup` · 802 |
| odbt-vacuum-analyze (37) | `… + floor 24 hours` | rollups | `official_donor_bracket_totals` · 646 |
| ecs-vacuum-analyze (47) | `… + floor 24 hours` | ec | `entity_connection_stats_mv` · 147,870 |

- **The MV series ran on a clock** twice a day (11:xx / 17:xx), 0.14–1.63 s p50,
  whether or not a refresh had dirtied the table. Now a table under its line is
  not due, and the 24-hour floor keeps the old cadence's bound. Their floors
  first fell due 11-11 17:05–17:20Z.
- **officials autovacuums on its own** (51 runs from the 11-05 restart to 11-11,
  ~8.6 / day). The floor anchors on its newest vacuum of any kind, so autovacuum
  keeps resetting it, and the 600-tuple line is what will usually arm the row.
- **What they wait on.** The six rollups rows queue behind the group's live unit
  and the FIX-1322 one-VACUUM-at-a-time io cap; ecs behind ec-crawl and
  ec-vacuum-analyze; officials is alone in its group. Nothing waits on them.
- **The first two days (cc-271, 11-11 and 11-12).** All eight armed and reaped
  `succeeded: VACUUM` on both days.
  - The seven daily rows ran 17:07 → 17:43Z, one at a time on the io cap: 0.16
    to 4.70 s, ecs the longest at 4.07 / 4.70 s.
  - **officials armed once a day, inside the nightly** (11-11 21:09Z, 11-12
    21:07Z). It armed on the 600-dead line, not the floor, and ran 1.23 / 1.12 s.
    `autovacuum_count` rose 51 → 56; on 11-12 an autovacuum ran 26 s before the
    dispatched VACUUM.
  - fr (03:23Z), ec (11:05Z) and entity-tags (21:25Z) each armed on its own
    tick both days. None was held by one of the eight.
- **The unguarded pg_cron set is now non-VACUUM only:** the probes, the
  watchdogs, the dispatcher tick, the two retentions and platform-counts-daily.
  R1b (FIX-1309, `cron_job_budget` → VIEW and `cron.unschedule`) is the
  cutover's one remaining step.
- **Revert:** `scripts/fix1396-revert-move-officials-mv-vacuums.sql` (the eight
  rows back to their `at` text, gates `{}`, the crons re-activated by name; pause
  first).

### A multi-row RETURN in one exclusion group runs as a chain (FIX-1368 / 1369 / 1370)

Rows that share an `exclusion_group` never run together, so one push can
return several of them. The tick arms them one at a time, by `(priority, ttd,
job)`, and each waits for the previous one's reap. cc-256 returned three
`rollups` rows in one class-P push at 2026-10-31 00:18:50Z. All three were
DUE, and all three were terminal 30 min later:

| row | rule | armed | ran | terminal |
|---|---|---|---|---|
| agency-staffing-rollup-refresh | `by 5 0 * * 2` | 00:19:00Z (ttd −4 d 00:14) | 00:21:00–00:22:10Z | complete, mode full, 136 agencies, 71 s |
| treemap-individuals-global-refresh | `by 0 14 * * 2` | 00:23:01Z, 1 s after agency's reap | 00:25:00–00:41:26Z | complete, 64 chunks, 986 s, 3,071 rows |
| group-donor-rollup-refresh | `by 10 3 * * 3` | 00:45:00Z, after fe-crawl (priority 2) took 00:43Z | 00:47:00–00:48:42Z | complete, 581 cohorts, 103 s |

- **The `excluded` rows are the serialization receipt.** At the first arm
  the other two read `queued (<job>)`. While a link runs, every tick reads
  `live (<running>)` plus `group busy: rollups (<waiting>)` for each row still
  waiting. Quote one per row.
- **A unit that writes no running row is still live.** Neither
  `refresh_agency_staffing_rollup` nor `run_group_donor_rollup_refresh`
  writes a `running` row (they write only their terminal row). Step 5's
  census reads the dispatcher's own state: every `armed` `dispatch_log` row
  with no `reaped` / `missed` row is a unit (`20261029000000` :541-548,
  :562-563), and so is a client backend whose query CALLs the row's routine
  (:570-577). The group of every live unit is busy (:603-606). So "no running
  row" is not "not live", and a `data_sync_log` read cannot tell you a unit
  is idle: read `cron.job_run_details` for the `disp-<job>-<epoch>` one-shot,
  or the tick's own `live (…)` entry.
- **A higher-priority row in another group can cut in.** At 00:43Z the
  treemap reap freed `rollups`, but fe-crawl (priority 2, group `fe-totals`)
  was due and won the pick. group-donor read `queued` and armed on the next
  tick beside it (1 live of `max_concurrent_units` 2).
- **Box over the chain** (`box_health_mem`, 60 s samples): MemAvailable low
  292 MB (00:32:47Z, mid-sweep), swap peak 493 MB. The 128-cap agency row needs
  ≥ 278 MB at its arm; the 64-cap rows need ≥ 214.
- **Reverts**, one per row, each the rule back to `at` and nothing else (the
  hold note stays, the cron stays parked): `scripts/fix1368-revert-return-treemap-individuals-global-refresh.sql`,
  `scripts/fix1369-revert-return-agency-staffing-rollup-refresh.sql`,
  `scripts/fix1370-revert-return-group-donor-rollup-refresh.sql`. Pause first if
  that row's one-shot is armed, as each header says.

### An atomic unit under a `by` row: what a budget cancel does, and the ladder (FIX-1371)

cc-257 returned the last parked weekly, `contract-flow-rollups-refresh`, as
`by 0 14 * * 4` (group `mvs`, cap 64, budget 9000). Its body,
`refresh_contract_flow_rollups()` (`c699dc7d…`, FIX-1295 M3), is ATOMIC: a
`running` row COMMITted first, then ONE sub-block that rebuilds
`contract_recipient_rollup` and `contract_agency_sector_rollup` and flips
`contract_flow_rollups_state`. The first dispatched run armed 2026-11-01
00:19:00Z (ttd −2 d 10:19), ran 00:21:00–01:07:32Z and closed `complete`,
500 / 1,201 rows, in 2,791.6 s. That is 1.47× the 256MB era's 1,904 s, and
fe-crawl co-ran 00:43–00:49Z. MemAvailable low was 242 MB, swap peak 547 MB.
It reaped `succeeded: CALL`, 2,791,654 ms.

- **A budget cancel loses the run, never the data.** The one-shot's
  `cron_job_budget` row (9000 s) and the `*/2` watchdog cancel the backend;
  the sub-block's `EXCEPTION WHEN query_canceled` rolls both tables back as
  they were and closes the running row `failed`, with `canceled true`,
  `stage_in_flight` and `elapsed_seconds`.
- **The body swallows the cancel, so the outcome is the `data_sync_log` row.**
  After the cancel the procedure RETURNs normally: `cron.job_run_details` reads
  `succeeded` and so does the reap (`succeeded: CALL unit_ms …`). Only an
  ERROR re-RAISEs and reaps `failed: …`. Read the terminal `data_sync_log` row,
  not the reap text, to know how the run ended.
- **The I6 ladder re-arms it anyway.** For a row with a pipeline, every
  `reaped` row armed after the pipeline's last `complete|partial` counts,
  whatever its text. A DUE, unwindowed `by` row that did not complete re-arms
  at reap + `rearm_cooldown_seconds` (1800 s), then + 3600 s, + 7200 s … capped
  at 24 h. Each attempt is a full scan of the contract FR rows. The tick reads
  `cooldown: <job> (n non-advancing reap(s), last '<reap text>' at …; re-arm
  at …)`. `dispatcher-r10` seeds this on the clone.
- **In a supervised session the operator is the brake.** A `failed` row means
  STOP: run `scripts/fix1371-revert-return-contract-flow-rollups-refresh.sql`
  through `db-query --prod --call --yes-i-mean-prod --file` (pause first if
  the one-shot is armed, as its header says). There is no second attempt that
  night. Unattended, the ladder is the net. `job_registry.by_window_minutes`
  is the one-UPDATE dial that bounds the retries to a window after the slot.
  It is NOT written: it is a decision for after a Thursday that misbehaves,
  and a window lapses the slot when the box is busy all through it (rule 391).
- **The in-body START gate is redundant under the tick.**
  `box_backoff_gate('contract-flow-rollups-refresh', 1800)` runs before the
  advisory lock. Under a dispatched one-shot the tick has already admitted the
  box (`box_is_saturated` plus the memory rungs), so the gate returns `clear`
  at once and the running row carries no `gate` key (none on the first
dispatched run). A wait would sit
  inside the budget (1,800 + the 5,891 s max = 7,691 < 9,000). Removing it is
  a body change, for the s7 chunking prompt (`docs/cc/projects/forker.md` s7,
  dispatcher.md s14).
- **Progress has no cursor.** The stage is a plpgsql variable, so the only
  live view is `pg_stat_activity` for the CALL (`IO/DataFileRead` /
  `DataFilePrefetch` on the FR scan) and `box_health_mem`.

### The monthly sweeps under `by` rows: a swallowed cancel closes `partial`, an ADVANCING row (FIX-1374)

`20261102000000_fix1374_return_five_monthly_sweeps.sql` (cc-258) returns the
five monthly orphan sweeps as `by <their cron slot>`:
`donation-edge-orphan-sweep` `30 11 1 * *` and
`entity-connection-stats-orphan-sweep` `30 13 1 * *` (group `ec`),
`financial-entity-totals-reconcile` `0 12 1 * *` (`fe-totals`),
`donor-rollup-orphan-sweep` `30 12 1 * *` and `donor-party-rollup-orphan-sweep`
`0 13 1 * *` (`rollups`). Priority 5, cap 64, **`budget_seconds` NULL**. The
prod push was held on 2026-11-02 (below) and landed on 2026-11-07 at
01:05:51Z (cc-263). The first dispatched chain closed five `complete` in 20
minutes (first arm 01:07:00Z, last reap 01:27:01Z):

| sweep | wall s (10-01, 256MB) | band | deleted / zeroed |
|---|---|---|---|
| donation-edge | 99.6 (135.5) | 0–204 | 0 |
| fe-totals | **583.5** (155.3) | 0–234, **above: 3.76×**, FIX-1385 | 0 |
| donor-rollup | 146.0 (103.4) | 0–156 | 0 |
| donor-party | 200.6 (290.4) | 0–436 | 0 |
| ecs | 67.4 (92.8) | 0–140 | 0 |

fe-totals co-ran the other three on the chain, which the 30-minute cron slots
never allowed, so its ratio is confounded. Its Dec 1 12:00Z slot runs alone.

- **The cancel path is the opposite of contract-flow's.** Each body (FIX-1295
  M3: 64MB + parallel 0 in-body, no START gate) COMMITs a `running` row, then
  runs ONE sub-block (fe-totals: three, A/B/C, each its own COMMIT). `WHEN
  query_canceled` rolls the statement back (nothing half-deleted) and closes
  the row **`partial`**, `canceled true`, `cancel_detail`, `elapsed_seconds`;
  the procedure RETURNs, so the cron run and the reap read `succeeded`.
  `partial` is ADVANCING: it is the pick's anchor and it ends the I6 ladder,
  so **a cancelled sweep satisfies its slot until the next 1st** — no re-arm,
  no `cooldown:` row. (contract-flow's cancel closes `failed`, non-advancing,
  and the ladder re-arms it.) `WHEN OTHERS` closes the row `failed`, and the
  procedure still RETURNs; `failed` is non-advancing, so an error re-arms at
  reap + 1800 s. `dispatcher-r11` seeds both side by side on the clone.
- **So never cancel a slow sweep to retry it.** The cancel ends the month's
  attempt. A NULL budget arms NO `cron_job_budget` row (`dispatch_one_unit`:
  `IF v_pick_budget IS NOT NULL`), so the only cancel is the `postgres` role's
  3 h `statement_timeout`, per statement. If a sweep ever needs a bound,
  `budget_seconds` is the one-UPDATE dial; it is not written.
- **The chain the tick builds** (`dispatcher-r11`, the clone at prod's dials,
  MemAvailable 450): tick 1 arms donation-edge (the most negative ttd) with
  the other four `queued (…)`; tick 2 arms fe-totals beside it (`live
  (donation-edge…)`, `group busy: ec (entity-connection-stats…)`); tick 3
  reads `units: 2 live of 2` for the two rollups rows and **`group busy: ec`
  for ecs — `group busy` outranks `units` (first reason wins)**; after
  donation-edge's reap the next tick arms donor-rollup ahead of ecs (ttd
  order). The crawls (priority 2) cut in whenever due.
- **Reading the walls.** The bands (bands.json, n=1, the 10-01 256MB walls ×
  1.5: 204 / 234 / 156 / 436 / 140 s) are R5's bar for the M3 step; the first
  dispatched walls are FIX-1295's sweep receipts. Every pre-M3 body set 256MB
  in-body. On the clone the five run in seconds; that is not prod's cost.
- **Why the 11-02 push was held, until 11-07.** Prod stalled twice before it: 03:54–04:27Z
  and again from 05:01Z. pg_cron logged `job startup timeout` every minute,
  load1 reached 19–31, and the front door's 5xx count rose to 118 in the
  04:00Z bucket, while MemAvailable stayed 245–570 MB and swap ≤ 620 MB. So it
  was an IO stall, not the swap-ceiling wedge (playbook C1: sustained IO
  drains Pro Micro's burst credits). Each began minutes after a modest unit
  started (`platform-counts-daily` + an ec-crawl unit; then
  `donor-rollup-refresh`). The dispatcher skipped correctly (`box: stale` /
  `box: fork_failures`), but it cannot stop a sweep already running. Push the
  file on a box that has stayed clear for hours, not minutes.
- **A backgrounded gate loop outlives the agent's task stop.** On Windows,
  stopping the harness task that ran `session:wait-for-gate:prod … --then
  "node ../../scripts/db-push-prod.mjs …"` left the node tree alive, and it
  kept polling, ready to push at its first `ok=true`. Find the
  `wait-for-gate` node process by its command line and `taskkill /T /F` its
  pnpm root, then confirm the next poll line never appears.
- **Revert**: `scripts/fix1374-revert-return-five-monthly-sweeps.sql` through
  `db-query --prod --call --yes-i-mean-prod --file` (pause first if a `disp-`
  one-shot of any of the five is armed). The five rules back to `at`, nothing
  else.
- **Bands for dispatched rows** come from the census in
  `docs/receipts/README.md` §"Dispatched jobs: the bands census (FIX-1373)":
  ≥ 3 reaped `succeeded` walls since 10-14 → `[0, ceil(1.5 × max)]`.

### Upgrade Path

| Trigger | Upgrade | Cost |
|---------|---------|------|
| DB > 400MB OR egress consistently > 4GB/mo | Supabase Pro | $25/mo (250GB egress, 8GB DB) |
| Fluid CPU > 3h/mo consistently (with Cloudflare bots blocked) | Vercel Pro | $20/mo (1000h CPU) |

After upgrading:
```sql
UPDATE platform_limits
SET plan = 'pro', included_limit = [new_value]
WHERE service = 'supabase' AND metric = 'egress_bytes';
```
No code deploy needed — the dashboard reads from this table.

---

## Monitoring

### Status Checks

```powershell
# Local
(Invoke-WebRequest "http://localhost:3000/api/claude/status" -UseBasicParsing).Content

# Production
(Invoke-WebRequest "https://civitics-civitics.vercel.app/api/claude/status" -UseBasicParsing).Content
```

The status API runs 6 self-tests:
1. Supabase connectivity
2. Officials table has data
3. Proposals table has data
4. Votes table has data
5. Entity connections table has data
6. `nightly_ran_today` — will fail if cron is disabled (expected during dev)

### External request-path probe (FIX-1026)

`.github/workflows/platform-snapshot.yml` carries the **`request-path-probe`**
job. Since FIX-1127 it is the workflow's *only* job — the snapshot trigger that
gave the file its name moved to a Vercel cron (see below) — so anything red here
means the probe, and the probe means the site. It curls `/`, `/officials` and
`/api/officials/<id>/responsiveness` (3 attempts × 20 s, `--max-time 25`) and
exits non-zero if any endpoint never returns 200.

The third path is `/responsiveness` and **not** `/summary`, deliberately:
`/summary` fails open (it answers 200 with `summary: null` when the database is
unreachable), which makes it blind to exactly the outage this job exists to
catch. This doc said `/summary` until FIX-1127; the workflow has always used
`/responsiveness`.

**Detection latency is ~1 hour, not minutes.** GHA cron does not honour its own
schedule: configured `*/10`, the observed gaps on 2026-08-11..12 were 38, 50,
56, 63, 87, 107 and 153 minutes. Read the *observed* run history, never the cron
expression. For minutes-scale detection, add an external uptime service
(UptimeRobot's free tier does 5-minute checks) — zero repo code, configured
entirely in that service's dashboard.

**Three properties are load-bearing — do not "tidy" them away:**

1. There is **no** workflow-level `concurrency` block. A workflow-level
   `cancel-in-progress` makes the whole run's conclusion `cancelled`. (This
   property used to read "concurrency lives on the `trigger` job, not at
   workflow level"; FIX-1127 removed that job, so the rule is now simply that
   neither level gets one.)
2. The probe job has **no** concurrency group, so a later run cannot cancel it.
3. Its worst case (~3.5 min) sits far inside `timeout-minutes: 10`, so it always
   concludes `success` or `failure`.

**Why:** during the 2026-08-11 outage the five snapshot runs at 08:28, 09:31,
10:27, 11:17 and 12:00 UTC all hung and were cut off by `timeout-minutes: 5`.
**GitHub reports a timeout-expired job as `cancelled`, not `failed`, and sends no
notification for a cancelled run.** The signal spanned the outage exactly and
could not page anyone. Verified on run `31478090511` (09:31:46 → 09:36:49,
conclusion `cancelled`).

**Where the page goes:** GitHub emails scheduled-workflow failures to whoever
last committed the workflow file — currently
`Civitics Platform <civitics.platform@gmail.com>`. If that inbox is unwatched,
this alert is decorative.

**Which host it tests (FIX-1057, 2026-09-04):** `https://civitics.com` — through
Cloudflare, the path a real user takes. It curled the `vercel.app` origin until
then and was blind to every edge-layer failure; on 2026-08-12 civitics.com served
Cloudflare 526 all day while this job stayed green. The flip was blocked by
`security_level=under_attack` challenging every non-browser client, and was
unblocked by a narrow WAF rule (`Probe skip (FIX-1057)`) that matches a secret
header and skips **only** the security level. The zone posture did not change, so
an external uptime service is still blocked. The secret lives in the
`PROBE_HEADER_SECRET` GHA secret and the WAF rule expression — rotate both
together, or the probe goes permanently red. See `docs/CLOUDFLARE.md` §"The one
custom rule that does exist is security, not caching".

### Front-door watchdog (FIX-1130)

`/api/cron/front-door-watch`, every 15 minutes from a Vercel cron entry in
`apps/civitics/vercel.json`. Emails `ADMIN_EMAIL` on the Resend rails with
subjects `[Civitics][FRONT DOOR DOWN]` / `[Civitics][FRONT DOOR RECOVERED]`.

**What it watches that nothing else could.** The Supabase front door (Cloudflare
→ Kong → PostgREST/pooler) can wedge on its own and stay wedged after Postgres
underneath has recovered. On 2026-08-31 it did exactly that: `edge_logs` shows
**sixteen consecutive hours at 100.0% Cloudflare-class 52x**, and
`pg_postmaster_start_time()` still reads `2026-08-31T23:01:12Z` — the project
restart that cleared it. Cloudflare's analytics for civitics.com showed **zero
5xx across the same 24 hours**, because the wedge was on the *data* front door,
not the website's edge. The sync canary rides Postgres and was blind. The
request-path probe did go red three times (11:49, 18:11, 22:52 UTC) but its
first red was five hours after onset, and a red GHA run is not a page.

**RUNBOOK — the watchdog restarts the project itself on the 4th consecutive
Logs-arm DOWN tick, about 77 min after the front door went total (FIX-1285 /
FIX-1286, `FRONT_DOOR_AUTO_RESTART`); the hand restart is the fallback**
(dashboard → Project Settings → General → Restart project). Prod is armed
(`mode: "arm"` on every tick since 2026-10-07 04:00Z) — see "Auto-restart" below. **Postgres is usually healthy during this failure;
do not go hunting for a slow query first.** Confirm the restart landed with
`pg_postmaster_start_time()` afterwards.

**Two instruments, both Postgres-free by design** (FIX-1130 puts that in scope
explicitly — the detector must not need a Postgres connection to report that the
thing in front of Postgres is broken):

1. A direct `GET /rest/v1/` liveness probe, 3 attempts × 5 s. **A 401 means
   healthy** — PostgREST rejects on key class before touching the database, which
   is exactly why that endpoint is the right target. The predicate is "any status
   < 500", not "200".
2. The Supabase Logs API over `edge_logs`, four closed 15-minute buckets.

**It reads 52x, not 5xx, and that is the whole design.** Across 550 healthy
15-minute buckets (six days), `n_52x` is p50/p90/p95/p99 = 0 and 544 of 550 are
exactly zero. A bucket is RED at `n_52x >= 3 AND n_52x/requests >= 0.5`; measured
wedge buckets run 95.8–100%, every non-outage bucket runs ≤ 7.1%. A 5xx-ratio arm
was designed in and **removed**: on 2026-09-01 the front door served up to 67.7%
5xx in a bucket while healthy (statement timeouts under I/O load — see
`docs/audits/front-door-degradation-2026-09-01.md`), so that arm would have paged
with the restart runbook attached, which was both wrong and harmful advice.

**Dedup is stateless** — the verdict keeps no state, so DOWN pages on the
transition tick and thereafter at most once an hour (the probe arm marks every
tick a transition, so a dead probe pages every 15 min), and RECOVERED fires on
an exact bucket-shape edge. Replayed against 2026-08-31 it declares DOWN at
06:47 (32 min after the wedge went total) and sends 19 emails across the
17-hour outage. Replayed against six healthy days it sends three, all on
2026-08-29 — which is the FIX-1125 outage, a true positive. (This section once
said there is no Postgres-independent state store. There is one now: the
Upstash database the FIX-1125 memory ring writes. The restart decision below
keeps its state there; the verdict still does not need any.)

The logic is pure and unit-tested against both real series in
`packages/db/src/front-door-verdict.test.ts`; the route only does the I/O.

**Auto-restart (FIX-1285, FIX-1286).** The detector was right three times —
08-31 (~17 h), 09-22 (~8 h), 10-06 (8 h 40 m) — and each wedge waited for a
person. `POST /v1/projects/{ref}/restart` is the same restart the dashboard
button issues, so the watchdog decides it itself, in
`packages/db/src/front-door-restart.ts`, built on the verdict's **Logs arm**. In
order:

1. The tick must be a **Logs-arm DOWN**: the two newest closed buckets both RED.
   Any other tick, including a DOWN the direct probe declares on its own, clears
   the count.
2. It must be the **4th consecutive** such tick. Ticks 1–3 are `none`, and the
   reason counts them: `DOWN tick N of 4`.
3. No restart in the last **60 minutes**, and fewer than **2 in 24 h** — a
   restart loop is worse than an outage. Every attempt counts, whatever it
   answered, so a dead token is not retried every 15 minutes.
4. Then the mode: `off` → nothing; `report` → `would_restart`; `arm` with the
   token → `restart`; `arm` without it → `would_restart` and a warning.

**Why the Logs arm carries it and the probe does not.** FIX-1285 shipped a rule
that skipped whenever the direct probe answered. Every 10-06 `[FRONT DOOR
DOWN]` subject was the Logs arm's ("the two newest closed buckets are both >=
50% …"), none the probe's, and every prod row since reads `probe_answered`
true. The keyless `GET /rest/v1/` is answered in front of the wedge, so that
rule made the armed restart inert for the wedge it exists for (FIX-1286). The
probe is now reported in every reason (`probe answered|dark`) and gates
nothing. It is otherwise **unchanged**: a keyed probe would put Postgres on the
detector's hot path, which FIX-1130 rules out. That is a future design option,
not a fix. The Logs arm can carry the restart alone because of FIX-1130's
calibration: healthy buckets run `n_52x` p99 = 0, wedged ones ≥ 95.8 %.

**Why ticks, not minutes.** A 30-minute hold sits exactly on the 15-minute tick
lattice. The ticks fire at :28.4–:28.6, so at the third DOWN tick "held ≥ 30
min" is decided by a few hundred ms of cron jitter (cc-207 §3.2). A counter
cannot see the clock: `front-door-restart.test.ts` replays the same series with
ticks at :28.400, :28.600 and one tick 2 s late, and gets the same restart
ticks.

**Why 4, not 3.** A Logs-arm DOWN already means two closed RED buckets — at
least 30 min of total 52x before the first counted tick. A short outage that
clears by itself is then DOWN for exactly three ticks. The 08-29 FIX-1125 event
(RED buckets starting 06:15, 06:30, 06:45, 07:00) counts 06:47, 07:02 and 07:17,
and is not DOWN at 07:32, so a 3-tick hold would restart a front door that had
just recovered. With 4, onset → restart is about 77 min: 45 min after the
Logs-arm DOWN edge.

The project health endpoint (`GET /v1/projects/{ref}/health?services=db,pooler,rest`,
read token) is read once three DOWN ticks are counted and is **reported in the
reason, never gated on**. What the control plane says about itself during a
wedge has never been measured. On a healthy box it answers 200 with all three
`ACTIVE_HEALTHY` (read 2026-10-07 02:33Z).

| env var (Vercel, Production) | meaning |
|---|---|
| `FRONT_DOOR_AUTO_RESTART` | `off` · `report` (default when unset; any unknown value also reads as `report`) · `arm` |
| `SUPABASE_MANAGEMENT_RESTART_KEY` | A **separate** fine-grained token. The restart endpoint needs `project_admin_write` (OAuth scope `projects:write`; 200 `{}`, 401/403/429), which the token dialog calls **Project Settings → Read and write**. That level also allows pausing, restoring, updating and **deleting** the project — there is no restart-only scope — so keep the token in Vercel Production only. `SUPABASE_MANAGEMENT_API_KEY` stays the read token for the Logs and health reads. |

**State, in Upstash** (`UPSTASH_REDIS_REST_URL` / `_TOKEN`, the ring's
credentials). One `MGET` of five keys per tick (~2,900 commands a month) and
nothing written on a healthy tick:

| key | written | expiry |
|---|---|---|
| `civitics:front_door:down_ticks` | `INCR` on every counted tick (`EXPIRE` on the first); deleted on the first tick that does not count | 24 h |
| `civitics:front_door:down_since` | the first counted tick (`SET … NX`), for the reason's "since"; deleted with `down_ticks` | 24 h |
| `civitics:front_door:last_restart_at` | each restart attempt | 24 h |
| `civitics:front_door:restarts` | each attempt; a JSON list of ISO instants, trimmed to 24 h on write | 24 h |
| `civitics:front_door:would_restart_sent` | a WOULD FIRE email; deleted with `down_ticks` | 6 h |

If Upstash does not answer, the decision is `none` ("state store unreachable")
and the DOWN email says so: it fails **safe**, never open.

**The three emails.** Each one rides the DOWN/RECOVERED rails above, which are
unchanged:

- `[Civitics][FRONT DOOR RESTART ISSUED] HTTP 200 — Supabase project restart at
  DOWN tick 4, … min` is sent when the restart was requested. It carries the
  reason, the health read and the status code. `… FAILED — HTTP 401` means the
  token was refused, and the attempt still counts toward the cap. After a
  restart, expect RECOVERED once two clean 15-minute buckets have closed.
- `[Civitics][FRONT DOOR RESTART WOULD FIRE] report mode — …` means the armed
  watchdog would have restarted at this tick. It is sent once per outage, and
  sent again after 6 h inside a longer one.
- The DOWN email gains one line: `Auto-restart (FIX-1285, …): <action> —
  <reason>`. A `skip` shows up only there.

The route's JSON and its `data_sync_log` row carry
`restart: {action, reason, mode, downForMs, down_ticks, state_store, health,
issued, state_write, emailed}`. The row lands on DB-reachable ticks only.

**The gap is accepted, and the next row says what it swallowed (FIX-1348,
option b).** A wedge that hides Postgres swallows the breadcrumb: on 10-25 the
rows stop at 11:15:28 and resume at 13:45:28, nine ticks, the seven DOWN ticks
among them. Upstash was at its request cap the same hours (`state_store:
unreachable: … max requests limit exceeded`), so no record of those ticks
existed anywhere. Since cc-260 each tick reads the newest `front_door_watch`
row's `started_at` before its INSERT. The first tick that can write then
carries `metadata.backfill = {missed_ticks, from, to, buckets, state, reason,
mode, state_store}`. `from`/`to` bound the gap. `buckets` are the four closed
buckets that tick already holds (the 10-25 13:45 row held 12:45, 13:00 and 13:15
RED), so a gap longer than an hour is covered for its last hour only. The key is
`null` on a tick with no gap, and `{error}` when the newest-row read failed, in
which case the INSERT still runs. During the outage the alert emails are the
live record. Nothing off-box survives an Upstash cap. **FIX-1348 (a)**, an
off-box breadcrumb outside that cap, stays filed and is not built.

```sql
SELECT started_at, metadata->'backfill' FROM data_sync_log
WHERE pipeline = 'front_door_watch' AND metadata->'backfill' <> 'null'::jsonb
ORDER BY started_at DESC LIMIT 20;
```

**Known risks, stated and accepted:**

- A restart cannot read the FIX-950 interlock (`prod_session_state()`), because
  the database is unreachable by definition. A supervised landing that is under
  a 77-minute total wedge is already dead.
- A wedge that the Logs API cannot see (the API itself dark or unavailable for
  the duration) never counts a tick, so it never restarts. The probe still pages
  DOWN every tick; the hand restart is the fallback.

Replays (`front-door-restart.test.ts`; both probe models agree): 08-31 restarts
at 07:32 and 08:32, 77 min after the wedge went total, then the cap holds. 10-06
restarts at 17:47 and 18:47; the hand restart came at 00:46. 08-29 restarts
nothing. The five other healthy days and the 09-01 statement-timeout window
count no tick at all.

### Cost detection: what watches money, and what acts on its own (FIX-1044/1045/1046)

Added 2026-08-16 after the 2026-08-15 crawl burned ~$21/day for 16 hours without
anything paging. The alert system was healthy; it was watching the wrong things.
All of the below rides the existing `platform-snapshot` cron — no new workflow,
no new substrate. That cron is a **Vercel cron at `*/30`** since FIX-1127
(`apps/civitics/vercel.json`); it was a GHA `*/10` that actually fired about
every 6 hours before that, which is the number every "detects in" figure below
was really operating under.

**R7 split (2026-10-10 → 10-11, FIX-1292), now reverted.** For one day the
route's two halves fired on separate crons, so the off-box ring could show
which half carries the half-hour swap-in burst: `/api/cron/platform-snapshot/usage`
at `7,37` (the usage write and every alert pass below) and
`/api/cron/platform-snapshot/status` at `22,52` (the status write alone).
cc-216 read verdict **(B), the status half**, and restored the single `*/30`
parent entry. The half routes and the shared runner,
`platform-snapshot/_lib/run-platform-snapshot.ts`, stay in the tree with no
cron. Detection latency was the same throughout.

**Four layers, fastest first:**

| Layer | Signal | Detects in | Where |
|---|---|---|---|
| Cloudflare edge volume | origin-reaching req/hr | ~1–2 h | `cloudflare.origin_requests_hourly` |
| Closed-loop mitigation | 2 breached hours | ~2–3 h, then **acts** | `pipeline_state.cf_mitigation_loop` |
| Burn rate | day-over-day $ vs trailing median | ~1 day | `burn.vercel.daily_usage_usd` |
| Monthly bands (pre-existing) | MTD % of limit | days | `platform_alert_state` |

**Why the Cloudflare layer exists at all:** it is the only near-real-time,
script-readable counter in the stack. Vercel's billing data is cumulative and
steps once per day, so the 30-minute cron buys *zero* extra resolution on any
Vercel metric — consecutive snapshots are byte-identical. Supabase's feed watches
the database, not the request path. Upstash exposes no usage API.

**The trigger is origin-reaching requests, not total edge requests** — those are
the ones that cost money (~$1.23e-4 each, measured), and it makes every layer
self-limiting: while a mitigation absorbs a crawl, the metric collapses and the
alarms correctly go quiet instead of paging about free traffic.

#### The loop can change production edge config

On a sustained spike the cron raises Cloudflare's `security_level` to
`under_attack` **by itself**, then emails what it did. It reverts after 6h.
**Full behaviour, safety rails, and how to tell an automatic change from a manual
one: `docs/CLOUDFLARE.md` → "The platform now WRITES to this zone".**

**The loop proves its own write scope** (FIX-1047) rather than discovering it
mid-incident: twice a day it issues an idempotent `PATCH` of the security level
the zone already has. 200 = Edit, 9109 = Read-only; nothing changes at the edge.
The card reads `armed ✓ verified` / `ALERT-ONLY` / `armed (unverified)` /
`disarmed`. Token scope history and the audit-log rationale are in
`docs/CLOUDFLARE.md`.

**To force a real trip in a verify run:** set `CF_TRIP_ORIGIN_REQ_THRESHOLD=50`
in the Vercel env. Two breached hours will trip for real, email, hold 6h, and
auto-revert. The card flags `threshold OVERRIDDEN` in amber until you remove it.

**To disable the loop** (any one; all leave detection and alerting fully live):

```
# 1. Kill switch — Operations tab, or:
UPDATE pipeline_state
   SET value = jsonb_set(value, '{cf_auto_mitigation,enabled}', 'false')
 WHERE key = 'kill_switches';

# 2. Env hard-kill (works even if the DB read fails) — Vercel project env:
CF_AUTO_MITIGATION_ENABLED=false

# 3. Revoke Zone Settings:Edit from CLOUDFLARE_API_TOKEN.
```

#### Reading the state

```bash
# What the loop is doing and why
node scripts/db-query.mjs --prod "SELECT value FROM pipeline_state WHERE key='cf_mitigation_loop'"

# The edge counter, straight from Cloudflare (bypasses the snapshot entirely)
node scripts/cf-analytics.mjs --hours 24

# Latest snapshot's view of all four layers
node scripts/db-query.mjs --prod "SELECT payload->'cloudflare_edge'->'latest', payload->'cf_mitigation'->>'action', payload->'burn_rate'->>'reason', payload->'vercel_billing' FROM platform_usage_snapshot ORDER BY fetched_at DESC LIMIT 1"
```

The route's ack body echoes `cf_origin_requests_hourly`, `cf_security_level`,
`cf_mitigation_action`, `burn_rate_elevated` and `vercel_billable_overage_usd`
on every tick — the cheapest liveness check. Until FIX-1127 that body was
`cat`-ed into the GHA run log; now the tick is a Vercel cron, so read it from
the function invocation log (Vercel dashboard → Logs, filter on
`/api/cron/platform-snapshot`) or curl the route yourself with the `CRON_SECRET`
bearer.

#### The dollar figures changed meaning (FIX-1046)

**Vercel Pro is $20/month and that $20 buys $20 of included usage.** The
dashboard used to display the gross list value of all consumption — including
the subscription line and every within-allotment dollar — as money owed. On
2026-08-16 it read **$31.38/mo** when the true billable overage was **$0.00**
with **$8.62 of credit unspent**.

- `vercel.monthly_spend_usd` — **gross list value.** Unchanged, still the leading
  indicator, reconciles against the Vercel dashboard. Not money owed.
- `vercel.included_usage_usd` — consumption vs the $20 credit. **This is the %
  bar that means something.** Warns at 80%.
- `vercel.billable_overage_usd` — **the headline.** `max(0, usage − $20)`.

The $20 lives in `platform_limits` (`vercel.included_usage_usd.included_limit`),
so retuning the credit — or the page-me ceiling on `billable_overage_usd` — is an
`UPDATE`, not a deploy.

*Cycle-basis caveat:* the charges API is queried from the first of the calendar
month and the `Pro` line prorates over 31 days, so the projection is
calendar-month. The Vercel usage page separately describes an Aug 14 – Sep 14
cycle and nothing in the API discriminates between the two.

### pg_cron background-worker capacity (FIX-1022)

**`job startup timeout` is a failed CONNECTION, not a missing worker slot.** With
`cron.use_background_workers = off`, pg_cron never requests a background worker:
it opens a libpq connection per firing inside a ~10 s window, and under I/O
pressure the postmaster cannot fork and finish the handshake in time (playbook D1).
FIX-1022 raised `max_worker_processes` 6 → 12 on the slot theory; FIX-1072's census
refuted it (non-client backends peaked at 8 of 12, no pool competing). Raising
`max_worker_processes` is a non-remedy — `docs/audits/2026-08-20-fix1069-ec-incremental-windowing.md` §6.

**Applying a Supabase Postgres config override:** `supabase --experimental
postgres-config update --no-restart` stores the value but never renders it, and a
plain restart does not pick it up — delete the key, then set it. Verify with
`SELECT name, setting, source FROM pg_settings WHERE name = '…'` (expect
`source = configuration file`). An override persists across compute resizes and
does not re-derive: re-check it after any resize.

- **`delete` restarts too** unless it carries `--no-restart` (CLI 2.78.1
  `postgres-config delete --help`). When the key is not an override yet, pass
  `--no-restart` on the delete so the update is the one restart.
- **`shared_buffers` (FIX-1379, cc-255):** 256 MB → **128 MB**, set at Craig's
  planned restart on Wed 11-04 evening PT (11-05 UTC), so §Prod restarts holds
  the instant. Before that, 256 MB came from Supabase's generated
  `generated-optimizations.conf`, not an override, and the override list was
  `max_worker_processes = 12` alone. The revert is
  `scripts/fix1379-revert-shared-buffers-256.md`. The 11-05 result:
  `pg_settings` reads 16384 × 8 kB from
  `/etc/postgresql-custom/custom-overrides.conf`, and `postgres-config get`
  lists `max_worker_processes 12` and `shared_buffers 128MB`.

### Prod restarts

`pg_postmaster_start_time()` is the record. A restart is CLEAN when
`pg_stat_statements_info.stats_reset` does not move across it, and UNCLEAN
(crash recovery) when it does. Playbook D13 has what each kind keeps.

| instant (UTC) | kind | cause | downtime |
|---|---|---|---|
| 2026-08-31 23:01:12Z | project restart | cleared the front-door wedge (FIX-1130) | — |
| 2026-10-08 23:42Z | — | not recorded here (the memory census names the instant, §M1) | — |
| 2026-10-25 13:25:53Z | **unclean**, crash recovery | the swap-ceiling wedge | cc-250 §2 has the timeline |
| **2026-11-05 01:59:17Z** | **clean, planned** | lever 7: `postgres-config update --config shared_buffers=128MB` (FIX-1379, cc-255) | **≤ 9.2 s**: the update call ran 01:59:11.8 → 01:59:15.7Z; the new postmaster started 01:59:17.4Z; the first 15 s poll (01:59:21Z) answered with the new start and `128MB`, so no refused connection was ever observed |

**The planned-restart recipe** (cc-255; `scripts/fix1379-revert-shared-buffers-256.md`
is the same steps):
1. The (d′) 3 h STOP row must be clear (PROMPT_TEMPLATE, FIX-1377).
2. `platform_dials.pause = true`, then wait for `live` `[]` and no running row.
3. The before-reads.
4. The config change. The CLI call returns before the restart completes.
5. Poll `pg_postmaster_start_time()`.
6. The after-reads.
7. If `prod session held:` rows remain, a `--hold-seconds 5` claim sweeps them.
8. `pause = false`.

On 11-05, pause → unpause took 2 min 48 s (01:57:46 → 02:00:34Z). The
FIX-950 claim does NOT survive the restart: its backend gets `57P01`, and that
day the process exited with its six guarded holds still set. `pause` is what
holds the dispatcher across it.

Since FIX-1387 (cc-265) a `57P01` releases. The lock client's `error` event
clears that claim's holds and label on a fresh connection, retrying for up to
60 s, and the process exits 1 with one line naming the SQLSTATE. A claim whose
hold the ticker finds gone takes the same path. The proof so far is local: a
real `pg_terminate_backend` on the lock's backend. The next planned restart is
the prod receipt, and step 7's sweep stays the manual net.

M4′ read at 46.6 h (cc-263): all five census numbers better, the floor ~50 MB
lower and re-formed within the hour, MemAvailable flat, the creep still open
(census §M4′).

The 7-day curve (cc-271, FIX-1379) is a least-squares fit over the daily swap
values in `dispatch_log.box`. The daily **min** rose **+0.29 MB/day** over
11-06 → 11-12 (n 7), against +3.42 over 10-26 → 11-04 (n 10). The **p50** rose
+2.57 against +3.75, and at that rate it reaches 1,018 MB at uptime day ~231.
The daily max fell (−0.82). 11-08 (a drop night) and 11-09 (the stall) are
over-sampled, and the rows are arms and box skips, not a uniform clock.

`pg_buffercache` is installed (FIX-1389, cc-264), so an M4-class pool read is a
plain `SELECT` from `extensions.pg_buffercache`. Rule 429's rolled-back
`CREATE EXTENSION` is retired.

| read | uptime | usagecount 0 / 1 / 2 / 3 / 4 / 5 (% of 16,384) | dirty | top relation |
|---|---|---|---|---|
| 11-07 06:29:03Z (cc-264, post-install) | 52.5 h | 26.1 / 7.0 / 10.1 / 6.8 / 6.1 / 43.9 | — | — |
| 11-10 01:32:54Z (cc-266) | 119.6 h | 20.3 / 35.8 / 6.8 / 2.1 / 1.2 / 33.7 | 77 | financial_entities 5,204 (99.9 % at ≤ 1, just vacuumed) |

### Dashboards

| Service | URL |
|---------|-----|
| Supabase project (Pro) | `supabase.com/dashboard/project/xsazcoxinpgttgquwvuf` |
| Vercel deployments | `vercel.com/civitics-platform/civitics` |
| Platform dashboard | `civitics-civitics.vercel.app/dashboard` (admin controls gated by `ADMIN_EMAIL`) |
| Claude diagnostic snapshot | `civitics-civitics.vercel.app/api/claude/snapshot` |

---

## Troubleshooting

### Site Down / Timeouts

1. **Check if Supabase is paused** — Supabase Dashboard → project may show "Paused"
2. **Check Supabase over limits** — egress tab in dashboard
3. **Check active DB connections:**
   ```sql
   SELECT count(*) FROM pg_stat_activity;
   -- Should be < 10 at idle
   ```
4. **Restart DB if stuck:** Supabase Dashboard → Settings → Restart Database
5. **Set kill switch while investigating:** Set `SUPABASE_AVAILABLE=false` in Vercel to stop burn

### Build Failing on Vercel

- Always run `pnpm build` locally first — a local passing build = no Vercel failure
- TypeScript errors are the most common cause — Vercel uses strict mode
- `generateStaticParams` rules (from `CLAUDE.md`):
  - Must use `try/catch` and return `[]` on any error
  - Must use `Promise.race` with 5s timeout
  - Must limit to 50 rows max
  - Must use publishable key only (never `createAdminClient`)
- Check for `export const dynamic = "force-dynamic"` on any route using `createAdminClient()`

### Hydration Errors

Always caused by `new Date()` or browser APIs rendering in Server Component context.

**Fix:** Move to `useEffect` or add `suppressHydrationWarning` to the element.

```tsx
// Wrong — causes hydration mismatch
<span>{new Date().toLocaleDateString()}</span>

// Right — suppress or use useEffect
const [date, setDate] = useState('');
useEffect(() => setDate(new Date().toLocaleDateString()), []);
```

### Pipeline Crashes (Windows)

**Symptom:** Exit code `3221226505`

**Cause:** Windows/Node libuv teardown issue

**Fix:** Ensure the pipeline's entry point calls:
```ts
main().then(() => setTimeout(() => process.exit(0), 500));
```

### Egress Spike

1. Check `data_sync_log` for recent pipeline runs (look for large `estimated_mb` values)
2. Check `platform_usage` table for current egress estimate
3. Kill any running pipelines
4. Close Supabase Studio browser tabs (each tab auto-refreshes and runs queries)
5. If near limit: pause Supabase project and set `SUPABASE_AVAILABLE=false` in Vercel

### `supabase db reset` Fails

Run `supabase migration list --local` to check for gaps or duplicates in migration numbers.

Known history: migration `0008` was duplicated and renumbered `0021`. If you see state errors, this is the likely cause.

### `supabase start` Fails — Port 54322 Blocked (Windows / Hyper-V)

**Symptom:** `supabase start` fails with:

```
failed to start docker container: Error response from daemon:
  ports are not available: exposing port TCP 0.0.0.0:54322 -> 127.0.0.1:0:
  listen tcp 0.0.0.0:54322: bind: An attempt was made to access a socket
  in a way forbidden by its access permissions.
```

**Cause:** Windows reserves dynamic port ranges for Hyper-V; the reservation pool sometimes includes port 54322 (Supabase's local Postgres port).

**Diagnostic** (PowerShell):

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

If 54322 falls inside one of the listed ranges (e.g. `54255-54354`), Docker cannot bind it.

**Durable fix** (run once as administrator; persists across reboots):

```powershell
netsh int ipv4 set dynamicport tcp start=10000 num=1000
```

Shifts the OS dynamic-port range to 10000–10999 so future boots won't generate 54xxx exclusions.

**Important:** the dynamicport change does NOT release exclusions that HNS / Docker Desktop have already allocated in the old range. `net stop winnat / net start winnat`, `net stop hns / net start hns`, and Docker Desktop restarts all fail to flush them. **A full Windows reboot is the only reliable way to clear stale exclusions.** The dynamicport change makes the fix permanent post-reboot.

**Fallback while waiting to reboot:** schema changes can still ship via `pnpm db:push:prod` against prod (never `--linked`, FIX-392). The commit trailer becomes `Verified: prod` instead of `Verified: local + prod` — see root [CLAUDE.md](../CLAUDE.md) §FIXES Workflow for the trailer convention.
