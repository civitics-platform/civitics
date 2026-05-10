# Pipeline Audit — Claude Code Execution Prompts

Ready-to-paste prompts for the VS Code Claude Code extension. Each block is self-contained — paste into Claude Code, let it run the full migrate→build→commit→push→`fixes:sync`→commit→push loop autonomously.

Stages map to the sequencing in `docs/PIPELINE_AUDIT.md` §6 follow-up. Audit doc: commit `daa6e5ed`.

---

## Stage 1 — Doc reconciliation + skeleton signal + orphan archive (FIX-225 + FIX-229 + FIX-231)

Pure hygiene. One commit. Low risk. May need one trivial migration depending on FIX-229 check.

```
Land FIX-225 + FIX-229 + FIX-231 as one commit on main.

Stage 1 of pipeline-audit follow-up. Pure hygiene; no schema impact unless FIX-229 needs to extend a CHECK constraint. Full context in docs/PIPELINE_AUDIT.md.

## FIX-225 — Reconcile packages/data/CLAUDE.md cadence drift

Update packages/data/CLAUDE.md "Update Schedules" / per-source cadence sections to match the actual orchestrator in packages/data/src/pipelines/index.ts:

- "Hourly: Regulations.gov" → daily-via-nightly (no hourly path exists in the orchestrator)
- "Daily (2am): spending data, court metadata" → both are Sunday-only weekly-block items
- "Weekly: AI summary regeneration" → daily incremental via data:ai-summaries with incremental=true
- Per-source notes ("[Regulations] hourly", "[CourtListener] daily at 2am") → correct similarly
- Remove the "data:fec retained for reference only" line entirely — confirm packages/data/src/pipelines/fec/ does not exist (`ls packages/data/src/pipelines/fec/` should error or return nothing).

Don't rewrite the section structure; just correct the facts.

## FIX-229 — Phase 2 skeletons return status='skipped' not 'complete'

Files:
- packages/data/src/pipelines/govtrack-cosponsors/index.ts
- packages/data/src/pipelines/federal-register/index.ts
- packages/data/src/pipelines/opensecrets-bulk/index.ts

Each calls `completeSync(logId, result)` with `inserted: 0`, indistinguishable from a real zero-row day. Replace with a skip path:

1. Open packages/data/src/pipelines/sync-log.ts. Check what statuses are supported. Look at the CHECK constraint on data_sync_log.status — search migrations for "data_sync_log" and grep for "CHECK" near it.
2. If 'skipped' is not already supported: write a migration `supabase/migrations/<next-date>_data_sync_log_skipped_status.sql` that ALTERs the CHECK constraint to add 'skipped'. Use the next free YYYYMMDDHHMMSS prefix (`ls supabase/migrations/ | tail`).
3. Add a `skipSync(logId, reason: string)` helper to sync-log.ts mirroring the shape of completeSync/failSync. It writes `status='skipped'`, `metadata = { skip_reason: reason, ...existingMetadata }`, sets `completed_at`.
4. In each of the three skeleton pipelines, replace `completeSync(logId, result)` with `skipSync(logId, 'not_implemented')`. Keep the log message indicating skeleton/Phase 2 placeholder.
5. If you added a migration: `supabase migration up --local`, verify clean, then `supabase db push --linked` after local is green.

## FIX-231 — Archive copy-pac-tags-to-prod.ts

One-shot post-FIX-179 cross-env migration. Spot-check before archiving:

1. Find the actual PAC industry tags table name — grep for `tag_category` and the file's own table references in `packages/data/src/scripts/copy-pac-tags-to-prod.ts` itself, since that's the source of truth.
2. Against PROD (Copy-Item .env.local.prod .env.local first; verify `grep ^NEXT_PUBLIC_SUPABASE_URL .env.local` shows xsazcoxinpgttgquwvuf), count PACs tagged with industry. Against LOCAL, count the same. If prod count ≥ local count, the migration completed (it was idempotent and one-directional local→prod). Reset env: Copy-Item .env.local.dev .env.local.
3. If the spot-check passes: `mkdir -p docs/archive/scripts && git mv packages/data/src/scripts/copy-pac-tags-to-prod.ts docs/archive/scripts/`.
4. If it fails (prod is missing tags): leave the file in place, document the gap in the commit, and uncheck FIX-231 — we'll re-run the script first.

## Loop

- pnpm build
- git add packages/data/CLAUDE.md packages/data/src/pipelines/{govtrack-cosponsors,federal-register,opensecrets-bulk}/index.ts packages/data/src/pipelines/sync-log.ts docs/archive/scripts/copy-pac-tags-to-prod.ts (+ migration file if added)
- Commit:
    chore(pipelines): doc reconcile + skeleton status + orphan archive

    - FIX-225: reconcile packages/data/CLAUDE.md cadence with orchestrator
    - FIX-229: skeleton pipelines write status='skipped' (not 'complete')
    - FIX-231: archive one-shot copy-pac-tags-to-prod.ts

    Verified: local + prod
    Fixes: FIX-225, FIX-229, FIX-231
- git push origin main
- pnpm fixes:sync
- Commit done.log + FIXES.md diff: chore(fixes): sync status after FIX-225/229/231
- git push
```

---

## Stage 1.5 — Silent-failure alarm for nightly sync (FIX-234)

**Approach corrected from the original audit assumption.** The audit's §1d "Vercel cron (canary)" row turned out to be inaccurate — `apps/civitics/vercel.json` still declares `/api/cron/nightly-sync` at 2 UTC, but `apps/civitics/app/api/cron/nightly-sync/route.ts` was deleted at some point. Vercel has been hitting a 404 daily. There is currently no canary anywhere.

New design: GHA workflow watches GHA workflow. Failure-mode tradeoff acknowledged — if all of GHA is in a multi-hour outage, both miss. But the common single-job failure modes (expired secret on nightly, OOM, FEC source 503, runner outage on a specific job) all hit the heavy nightly workflow and leave the lightweight check workflow unaffected. Same commit cleans up the dead Vercel entry.

```
Land FIX-234 — alert when nightly sync doesn't land.

Context: data_sync_log is written by packages/data/src/pipelines/index.ts via the GHA workflow .github/workflows/nightly.yml at 2 UTC daily. If GHA fails (auth expired, runner outage, OOM mid-pipeline, source-API 503), no row appears and nothing alerts.

The original audit (docs/PIPELINE_AUDIT.md §1d) claimed a Vercel canary cron writes a `triggered` row daily. That's wrong: the vercel.json cron entry exists, but the route file (apps/civitics/app/api/cron/nightly-sync/route.ts) was deleted. Vercel hits a 404 daily. We'll clean it up in this commit.

## Implementation

### 1. Confirm the nightly's pipeline-name string

Grep packages/data/src/pipelines/index.ts and packages/data/src/pipelines/sync-log.ts for the `pipeline` value runNightlySync() writes when it completes. Candidates: 'nightly_cron', 'nightly_sync', 'nightly'. Use what the orchestrator actually writes — don't assume.

### 2. New script: packages/data/src/scripts/canary-check.ts

Inputs (env): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY (required), ADMIN_EMAIL, RESEND_API_KEY (optional pair).

Behavior:
- createAdminClient() from @civitics/db.
- Build expected_dates: today minus 7 → today minus 1, inclusive (7 UTC dates).
- Query data_sync_log for rows in last 8 days with pipeline=<name from step 1> AND status='complete'.
- Build actual_dates = set of DATE(started_at) from result rows.
- missing = expected_dates − actual_dates.
- Print JSON to stdout: { checked_days: 7, missing_dates: [...], alert_sent: bool }. CI logs see this.
- Write a meta row to data_sync_log: pipeline='canary_check', status='complete', metadata={ missing_count, missing_dates }.
- If missing.length > 0 AND ADMIN_EMAIL && RESEND_API_KEY are both set, send via Resend:
  - Match the from-address used by any existing Resend usage in the codebase (grep first; if no prior usage, use 'alerts@civitics.platform' as default and note in commit body).
  - To: ADMIN_EMAIL
  - Subject: `[Civitics] Nightly sync missed ${missing.length} day(s)`
  - Body: plain text listing the missing dates + link to https://github.com/civitics-platform/civitics/actions/workflows/nightly.yml
- No-op-safe: if ADMIN_EMAIL or RESEND_API_KEY is unset, skip the send, still print JSON, still write the meta row, exit 0.
- Exit 1 only on actual error (DB unreachable, Resend API 5xx). Missing nightlies are not script errors.

Resend dep:
- Check existing usage first: `grep -r '"resend"' packages/*/package.json apps/*/package.json`. If Resend is already a dep anywhere (likely via notify-followers cron or transactional email), match its import pattern.
- If not present anywhere: `pnpm add resend --filter=@civitics/data`.

Script entry in packages/data/package.json: `"data:canary-check": "tsx src/scripts/canary-check.ts"`.

### 3. New GHA workflow: .github/workflows/sync-canary-check.yml

Mirror .github/workflows/nightly.yml's structure but smaller. Triggers:
- schedule: `0 5 * * *` (3h after nightly's 2 UTC)
- workflow_dispatch (manual trigger for testing)

Steps: checkout → pnpm setup (match nightly.yml's version) → node setup with cache → `pnpm install --frozen-lockfile` → `pnpm --filter @civitics/data data:canary-check`.

Env vars from GitHub secrets:
- NEXT_PUBLIC_SUPABASE_URL
- SUPABASE_SECRET_KEY
- ADMIN_EMAIL (optional)
- RESEND_API_KEY (optional)

The workflow itself should not fail if ADMIN_EMAIL or RESEND_API_KEY are unset in repo secrets — the script handles missing env gracefully. Craig will set them in repo Settings → Secrets after deploy; note that in the commit body.

### 4. Clean up dead Vercel cron entry

In apps/civitics/vercel.json, remove the entry for `/api/cron/nightly-sync` from the crons array. Keep the `/api/cron/notify-followers` entry untouched.

Defensive check first: `ls apps/civitics/app/api/cron/nightly-sync/` should error (no such file). If it doesn't (route file actually exists), pause and report rather than deleting blindly.

### 5. Smoke test

- pnpm build clean.
- Local run: `cd packages/data && pnpm data:canary-check`. Expect JSON output. If local Docker has a recent nightly_cron-equivalent row from your own testing, missing_count may be 7 or close to it — that's expected and harmless (the email path won't fire unless ADMIN_EMAIL + RESEND_API_KEY are set locally, which they probably aren't).

## Loop

- pnpm build
- git add packages/data/src/scripts/canary-check.ts packages/data/package.json pnpm-lock.yaml .github/workflows/sync-canary-check.yml apps/civitics/vercel.json
- Commit:
    feat(cron): silent-failure alarm for nightly sync

    New GHA workflow .github/workflows/sync-canary-check.yml runs daily
    at 5 UTC (3h after nightly's 2 UTC). Calls pnpm data:canary-check,
    which queries data_sync_log for missing nightly runs in the last 7
    days and emails ADMIN_EMAIL via Resend on gaps. No-op-safe if
    ADMIN_EMAIL or RESEND_API_KEY is unset.

    Also drops the dead /api/cron/nightly-sync entry from vercel.json —
    the route file was deleted but the cron declaration stayed, so
    Vercel has been hitting a 404 daily.

    Followups: set ADMIN_EMAIL + RESEND_API_KEY in repo Settings →
    Secrets after deploy. docs/PIPELINE_AUDIT.md §1d "Vercel cron
    (canary)" row is now outdated; correct in a follow-up doc PR.

    Verified: local
    Fixes: FIX-234
- git push origin main
- pnpm fixes:sync
- Commit + push the FIXES.md/done.log diff: chore(fixes): sync status after FIX-234

After the first scheduled run (next 5 UTC), check the Actions tab to confirm green.
```

---

## Stages 2–7

Stub headers — filled in when you're ready to queue them.

- **Stage 2** — FIX-227 + FIX-228 + FIX-232 (orchestrator scheduling adds)
- **Stage 3** — FIX-226 (audit weekly + `docs/audits/` publish)
- **Stage 4a** — FIX-224 step 1 (drop legacy usaspending script entry)
- **Stage 4b** — FIX-230 (`--confirm` gate on `data:ai-summaries`)
- **Stage 7** — FIX-233 (runtime stats MV + admin page)
- **Stage 4c** — FIX-224 step 2 (delete legacy usaspending directory, ~2026-07)
