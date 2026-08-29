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
| Vercel plan | n/a | Hobby — crons limited to once/day |

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

# 2. Commit without [skip vercel] tag
git add packages/... apps/...
git commit -m "feat(scope): description"

# 3. Push — Vercel build triggers automatically
git push origin main

# 4. Monitor build
# Vercel dashboard: vercel.com/civitics-platform/civitics

# 5. Verify on production
# https://civitics-civitics.vercel.app
# (Invoke-WebRequest "https://civitics-civitics.vercel.app/api/claude/status" -UseBasicParsing).Content

# 6. Resume local dev commits with [skip vercel]
git commit -m "[skip vercel] chore: next change"
```

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

# 3. Test migration applies cleanly
supabase db reset
# Drops and recreates local DB from all migrations — confirms clean apply

# 4. Push migration to production
supabase db push
# Applies pending migrations to prod Supabase project
```

**Migration rules:**
- Append-only — never modify an existing migration file
- Always reversible — include a `-- DOWN:` section or document manual rollback
- Filename format: `NNNN_description.sql` (sequential number prefix)
- Never `DROP TABLE`, `TRUNCATE`, or `DELETE` without explicit confirmation

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

---

## Pipeline Operations

Pipelines run as Node.js scripts in `packages/data/`. They are NOT part of the Next.js build.

### Available Pipelines

| Script | What it does | Cost |
|--------|-------------|------|
| `data:congress` | Congress.gov → officials + votes | Free |
| `data:fec-bulk` | FEC bulk files → financial_relationships | Free |
| `data:usaspending` | USASpending.gov → financial_relationships (contract/grant) | Free |
| `data:regulations` | Regulations.gov → proposals | Free |
| `data:openstates` | OpenStates → state legislators | Free |
| `data:courtlistener` | CourtListener → judges | Free |
| `data:tag-rules` | Rule-based entity tagging (urgency, sector, etc.) | Free |
| `data:ai-summaries` | AI plain-language summaries via Claude Haiku | ~$0.035/run |
| `data:tag-ai` | AI-based topic/issue classification | ~$0.60/run |
| `data:nightly` | Full nightly sync (runs all, in order) | ~$0.60/run |

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

Source pipelines run first, then `rebuild_entity_connections()` derives edges. The nightly orchestrator handles this — only re-create the order manually for one-off ad-hoc runs:

```
1. data:congress           (heaviest — 227k vote records)
2. data:fec-bulk           (PAC contributions, ~200MB streamed)
3. data:usaspending        (spending records)
4. data:regulations        (proposals + comment periods)
5. rebuild_entity_connections()  (SQL function — see "Entity Connections Derivation" in packages/data/CLAUDE.md)
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
| Vercel | Hobby | $0 | `[skip vercel]` still useful; crons limited to once/day |
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

**Vercel Hobby:**
- Fluid Active CPU: 4 hours/month (14,400 seconds)
- Function invocations: 1M/month
- Fast Origin Transfer: 10 GB/month
- **Cron jobs: once per day maximum** (upgrade to Pro for sub-daily crons — currently `notify-followers` is at 03:00 UTC)

### Conserving Resources

**Supabase egress:**
- Pause the project when not actively developing: Supabase Dashboard → Settings → Pause
- Close dashboard browser tabs (each auto-refresh = DB queries)
- The delta connections pipeline (~25KB egress) vs full re-run (~114MB) — always prefer delta

**Vercel Fluid CPU:**
- Cloudflare's `Common Exploit Paths` WAF rule blocks the PHP/WordPress scanners that burned CPU before proxy was enabled (Bot Fight Mode is off by design — see `docs/CLOUDFLARE.md`)
- Use `[skip vercel]` on all non-release commits
- `[skip vercel]` commits: zero Vercel build cost

### Emergency Kill Switches

Set these in Vercel Dashboard → Settings → Environment Variables (no code deploy needed):

| Variable | Value | Effect |
|----------|-------|--------|
| `CRON_DISABLED` | `true` | Stops nightly cron from running |
| `SUPABASE_AVAILABLE` | `false` | Prevents 10-second timeout burns when Supabase is paused |
| `CONNECTIONS_PIPELINE_ENABLED` | `false` | Disables connections pipeline |
| `AI_SUMMARIES_ENABLED` | `false` | Disables AI summary generation (officials/proposals summaries, ai-tagger pipeline, ai-summaries pipeline, and `/api/graph/narrative` — the graph header ✨ Explain button hides) |
| `CHORD_DATA_ENABLED` | `false` | Disables chord diagram data queries |

**When pausing Supabase:** Always set `SUPABASE_AVAILABLE=false` in Vercel first to prevent functions from timing out on dead DB connections.

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

### Cost detection: what watches money, and what acts on its own (FIX-1044/1045/1046)

Added 2026-08-16 after the 2026-08-15 crawl burned ~$21/day for 16 hours without
anything paging. The alert system was healthy; it was watching the wrong things.
All of the below rides the existing `platform-snapshot` cron — no new workflow,
no new substrate. That cron is a **Vercel cron at `*/30`** since FIX-1127
(`apps/civitics/vercel.json`); it was a GHA `*/10` that actually fired about
every 6 hours before that, which is the number every "detects in" figure below
was really operating under.

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

**Applied on prod:** `max_worker_processes` raised **6 → 12**.

**Why:** pg_cron runs with `cron.use_background_workers = off`, opening a fresh
connection per firing inside a ~10 s window. At `mwp = 6`, three slots are
permanently held on an idle box (two `Extension` bgworkers plus
`LogicalLauncherMain`), and any parallel query takes two more — leaving pg_cron
**one**. The result was 29 lifetime firings that never reached their command,
all `return_message = 'job startup timeout'`, including **0-for-12 on the six
FIX-1003 arm vacuums**.

**How to apply a Supabase Postgres config override — the trick matters:**

```
supabase --experimental postgres-config update --no-restart   # stores, but NEVER renders
```

`--no-restart` writes the value and it does not take effect; a plain restart does
**not** pick it up either. **Delete the key, then set it** — the
delete-then-update forces the apply. Verify with
`SELECT name, setting, source FROM pg_settings WHERE name = 'max_worker_processes'`
(expect `source = configuration file`).

> ⚠ **Custom Postgres config persists across compute resizes and will NOT
> re-derive.** If the instance is ever resized, this override stays pinned at
> whatever was set — it will not scale up with the new tier, and it can pin a
> larger box to a small-box value. Re-check it after any resize.

**`cron.max_running_jobs` is NOT in Supabase's overridable set** — it stays at
the default 32, i.e. pg_cron still advertises far more concurrency than the
postmaster can supply. **Schedule deconfliction is therefore the standing
mitigation, not a nice-to-have** (FIX-969 / FIX-990).

**Honest limit on the evidence:** the arm vacuums went 6-for-6 at 11:05–11:18 on
2026-08-12, but jobids 2 and 16 were paused that day, and six of them already
succeeded at 08-11 14:05–14:18 *before* the restart and *before* `mwp=12` — once
the 6 h squatter died. The 0-for-12 was a contention record. The first real test
of `mwp=12` is the next Mon/Wed 11:00 with jobid 16 active.

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

**Fallback while waiting to reboot:** schema changes can still ship via `supabase db push --linked` against prod. The commit trailer becomes `Verified: prod` instead of `Verified: local + prod` — see [apps/civitics/CLAUDE.md](../apps/civitics/CLAUDE.md) FIXES Workflow for the trailer convention.
