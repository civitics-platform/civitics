# Civitics Platform — Operations Guide

Daily operations reference for running, developing, and deploying the Civitics platform.
Last updated: 2026-03-26.

---

## Environment Setup

### Two Environments

| | LOCAL | PROD |
|---|---|---|
| App | `pnpm dev` on `localhost:3000` | Vercel (auto-deploy from `master`) |
| Database | Local Supabase (`supabase start`) | Supabase project `xsazcoxinpgttgquwvuf` |
| Studio | `http://127.0.0.1:54323` | `supabase.com/dashboard/project/xsazcoxinpgttgquwvuf` |
| DB URL | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | From Supabase dashboard |
| API | `http://127.0.0.1:54321` | `https://xsazcoxinpgttgquwvuf.supabase.co` |

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
master          → production (civitics.com) — auto-deploys to Vercel on every push
feature/*       → local only, never pushed directly (merge to master when ready)
```

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
git push origin master

# 4. Monitor build
# Vercel dashboard: vercel.com/civitics-platform/civitics

# 5. Verify on production
# https://civitics.com
# (Invoke-WebRequest "https://civitics.com/api/claude/status" -UseBasicParsing).Content

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

All migrations live in `supabase/migrations/`. Current sequence: `0001` through `0024`.

**Known issue:** Migration `0008` was duplicated during early development and renumbered to `0021` to resolve the conflict. Run `supabase migration list --local` to verify your local state matches production.

### Checking Migration Status

```powershell
# List local migration state
supabase migration list --local

# List production migration state
supabase migration list
```

### Restoring Production Data Locally

```powershell
# Dump data only (no schema) from production
supabase db dump --data-only -f data.sql

# Load into local DB
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f data.sql
```

---

## Pipeline Operations

Pipelines run as Node.js scripts in `packages/data/`. They are NOT part of the Next.js build.

### Available Pipelines

| Script | What it does | Cost |
|--------|-------------|------|
| `data:congress` | Congress.gov → officials + votes | Free |
| `data:fec-bulk` | FEC bulk files → financial_relationships | Free |
| `data:usaspending` | USASpending.gov → spending_records | Free |
| `data:regulations` | Regulations.gov → proposals | Free |
| `data:openstates` | OpenStates → state legislators | Free |
| `data:courtlistener` | CourtListener → judges | Free |
| `data:connections` | Derive entity_connections from ingested data | Free |
| `data:tag-rules` | Rule-based entity tagging (urgency, sector, etc.) | Free |
| `data:ai-summaries` | AI plain-language summaries via Claude Haiku | ~$0.035/run |
| `data:tag-ai` | AI-based topic/issue classification | ~$0.60/run |
| `data:nightly` | Full nightly sync (runs all, in order) | ~$0.60/run |

### Running Pipelines

```powershell
# Run a single pipeline
pnpm --filter @civitics/data data:connections

# Run with force override (skip recency guard)
pnpm --filter @civitics/data data:connections -- --force

# Dry run (estimate cost, no writes)
pnpm --filter @civitics/data data:ai-summaries -- --dry-run
```

### Safe Run Order

Run source pipelines before the connections pipeline:

```
1. data:congress          (heaviest — 227k vote records)
2. data:fec-bulk          (PAC contributions, ~200MB streamed)
3. data:usaspending       (spending records)
4. data:regulations       (proposals + comment periods)
5. data:connections       (derives entity_connections — must run AFTER sources)
6. data:tag-rules         (lightweight, no API cost)
7. data:ai-summaries      (costs money — run after other pipelines complete)
8. data:tag-ai            (costs money — run last)
```

### Recency Guards

Pipelines check when they last ran and refuse to re-run too soon:

| Pipeline | Minimum gap | Override |
|----------|------------|---------|
| `data:connections` | 4 hours | `-- --force` |
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

### Current Monthly Costs (~Phase 1)

| Service | Plan | Cost | Notes |
|---------|------|------|-------|
| Supabase | Free | $0 | Pause when not developing |
| Vercel | Free | $0 | Use `[skip vercel]` to avoid unnecessary builds |
| Anthropic | Pay-as-you-go | ~$0.60/mo | Self-imposed $3.50 budget cap |
| Cloudflare R2 | Free | $0 | 10GB free tier |
| Mapbox | Free | $0 | 50k map loads/mo free |
| **Total** | | **~$0.60/mo** | |

### Free Tier Limits

**Supabase (free):**
- Egress: 5 GB/month (hard limit — project pauses if exceeded)
- DB size: 500 MB
- Storage: 1 GB

**Vercel (free):**
- Fluid Active CPU: 4 hours/month (14,400 seconds)
- Function invocations: 1M/month
- Fast Origin Transfer: 10 GB/month

### Conserving Resources

**Supabase egress:**
- Pause the project when not actively developing: Supabase Dashboard → Settings → Pause
- Close dashboard browser tabs (each auto-refresh = DB queries)
- The delta connections pipeline (~25KB egress) vs full re-run (~114MB) — always prefer delta

**Vercel Fluid CPU:**
- Cloudflare Bot Fight Mode blocks PHP/WordPress scanners that burned CPU before proxy was enabled
- Use `[skip vercel]` on all non-release commits
- `[skip vercel]` commits: zero Vercel build cost

### Emergency Kill Switches

Set these in Vercel Dashboard → Settings → Environment Variables (no code deploy needed):

| Variable | Value | Effect |
|----------|-------|--------|
| `CRON_DISABLED` | `true` | Stops nightly cron from running |
| `SUPABASE_AVAILABLE` | `false` | Prevents 10-second timeout burns when Supabase is paused |
| `CONNECTIONS_PIPELINE_ENABLED` | `false` | Disables connections pipeline |
| `AI_SUMMARIES_ENABLED` | `false` | Disables AI summary generation |
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
(Invoke-WebRequest "https://civitics.com/api/claude/status" -UseBasicParsing).Content
```

The status API runs 6 self-tests:
1. Supabase connectivity
2. Officials table has data
3. Proposals table has data
4. Votes table has data
5. Entity connections table has data
6. `nightly_ran_today` — will fail if cron is disabled (expected during dev)

### Dashboards

| Service | URL |
|---------|-----|
| Supabase project | `supabase.com/dashboard/project/xsazcoxinpgttgquwvuf` |
| Vercel deployments | `vercel.com/civitics-platform/civitics` |
| Platform dashboard | `civitics.com/dashboard` (admin controls gated by `ADMIN_EMAIL`) |
| Claude diagnostic snapshot | `civitics.com/api/claude/snapshot` |

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
