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

## Stage 4a — Delete legacy `data:usaspending` pipeline (FIX-224, collapsed)

**Plan shift from audit recommendation.** Audit §5a proposed a two-step deprecation — drop script entry, wait 60 days for quiet, then delete the directory. New evidence justifies a single-step deletion now:

1. **Bitrot:** `packages/data/src/pipelines/usaspending/writer.ts(245)` references a `source_ids` column that no longer exists on `financial_entities` per generated DB types. The legacy pipeline cannot run successfully against current schema — tsc errors on it.
2. **The 4 prod invocations** in the last 180 days (latest 2026-04-25) cannot have produced output — they'd have hit the column-missing error.
3. The audit's 60-day cooling-off was a "be cautious, observe quiet" stance. Bitrot means the file is already de facto dead, and the cooling-off observation is moot.

```
Land FIX-224 — delete legacy data:usaspending pipeline (collapsed from 2-step plan).

Justification for collapsing: legacy file packages/data/src/pipelines/usaspending/writer.ts(245) references a nonexistent `source_ids` column on financial_entities. The pipeline cannot run successfully against current schema. Whatever ran it in the last 180 days (4 invocations, latest 2026-04-25 per prod data_sync_log) failed at the column read. No reason to wait 60 days for "quiet observation" — it's already dead.

## Changes

### 1. Verify canonicalizeEntityName lives in fec-bulk, not usaspending

Per audit §1b, `canonicalizeEntityName` is exported from `packages/data/src/pipelines/fec-bulk/writer.ts` and still imported by `usaspending-bulk`. Verify:
    grep -rn "export function canonicalizeEntityName" packages/data/src/pipelines/
Expected: only fec-bulk/writer.ts.

If it ALSO appears in usaspending/writer.ts and is imported by usaspending-bulk or others, MOVE the canonical definition to fec-bulk/writer.ts (or keep it where it is — wherever produces no broken imports after the delete) BEFORE deleting.

### 2. Delete the directory

    git rm packages/data/src/pipelines/usaspending/index.ts
    git rm packages/data/src/pipelines/usaspending/writer.ts
    rmdir packages/data/src/pipelines/usaspending  # if empty; otherwise leave for git to handle

### 3. Drop the script entry from packages/data/package.json

Remove the `"data:usaspending": "..."` line from the scripts block. Leave `"data:usaspending-bulk"` and `"data:usaspending-bulk-assistance"` untouched.

### 4. Sweep references

    grep -rn "pipelines/usaspending/" packages/data/src/ apps/civitics/ docs/
    grep -rn "data:usaspending[^-]" packages/ apps/ docs/  # match exactly, not the bulk variant

Expected acceptable refs after the delete:
- Audit/docs that reference the legacy path historically (docs/PIPELINE_AUDIT.md, docs/GRAPH_PLAN.md, docs/STAGE_0_WRITER_CATALOG.md) — leave as historical context.
- packages/data/CLAUDE.md line ~86 has "Legacy API script (data:usaspending) retained for reference — superseded by bulk approach (FIX-118)" — DELETE that line; the pipeline no longer exists.

### 5. Typecheck and build

    pnpm --filter @civitics/data exec tsc --noEmit
Expected: the writer.ts(245) error from the FIX-234 typecheck output is gone. (The supabase-usage cache error from packages/db is FIX-235, separate.)
    pnpm build
Expected: clean.

### 6. Verify orchestrator unaffected

    grep -n "runUsaSpendingPipeline\|runUsaSpendingBulkPipeline" packages/data/src/pipelines/index.ts
Expected: only `runUsaSpendingBulkPipeline` import and call. If `runUsaSpendingPipeline` still appears, the orchestrator has a dead reference — remove it.

## Loop

- pnpm build
- git add -A packages/data/src/pipelines/usaspending packages/data/package.json packages/data/CLAUDE.md
- Commit:
    chore(pipelines): delete legacy data:usaspending (collapsed from 2-step plan)

    Audit §5a recommended two-step deprecation (drop script entry, wait
    60 days, delete dir). New evidence justifies single-step deletion:
    writer.ts(245) references a nonexistent source_ids column on
    financial_entities — the pipeline cannot run against current schema.
    4 prod invocations in last 180 days (latest 2026-04-25) all would
    have failed at the column read.

    canonicalizeEntityName confirmed exported from fec-bulk/writer.ts,
    not deleted with this commit.

    Verified: local + prod
    Fixes: FIX-224
- git push origin main
- pnpm fixes:sync
- chore(fixes): sync status after FIX-224
- git push
```

---

## Stage 6 — Fix tsc error on supabase-usage.ts cache property (FIX-235)

Pre-existing tsc error surfaced during FIX-234 typecheck. Tiny, localized fix.

```
Land FIX-235 — fix tsc error TS2353 on packages/db/src/supabase-usage.ts:119.

Error from `pnpm -r exec tsc --noEmit`:
    packages/db/src/supabase-usage.ts(119,5): error TS2353: Object literal may
    only specify known properties, and 'cache' does not exist in type 'RequestInit'.

Context: line 119 is part of `mgmtGet()` which fetches from the Supabase Management API with `cache: "no-store"` to opt out of Next.js fetch caching. The `cache` field is a legitimate fetch option, but packages/db's tsconfig correctly excludes the DOM lib (server-only package), so the Node-native RequestInit type stub in scope here doesn't declare `cache`.

## Fix

Inline cast at the call site. Smallest blast radius, no tsconfig changes, no module augmentation.

Open packages/db/src/supabase-usage.ts. Around line 113-120, the fetch call is:

    const res = await fetch(`${MGMT_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Avoid Next.js fetch caching the response — we run our own 5-min cache.
      cache: "no-store",
    });

Change to:

    const res = await fetch(`${MGMT_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Avoid Next.js fetch caching the response — we run our own 5-min cache.
      cache: "no-store",
    } as RequestInit & { cache?: RequestCache });

If RequestCache itself is unresolved (depends on @types/node version), use:

    } as RequestInit & { cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload" });

Do NOT add `"dom"` to packages/db/tsconfig.json lib. This is a server-only package and DOM globals would pollute downstream consumers.

## Smoke test

    pnpm -r exec tsc --noEmit
Expected: zero errors. (Assumes FIX-224 already landed clearing the usaspending error. If FIX-224 hasn't shipped yet, the usaspending error remains but the supabase-usage one should be gone.)

    pnpm build
Expected: clean.

## Loop

- pnpm build
- git add packages/db/src/supabase-usage.ts
- Commit:
    fix(db): satisfy tsc on supabase-usage cache fetch option

    `cache: "no-store"` is a legitimate fetch option but @civitics/db's
    tsconfig correctly omits DOM lib (server-only package), so Node's
    RequestInit type stub doesn't declare `cache`. Localized cast at
    the call site — no global type pollution.

    Verified: local
    Fixes: FIX-235
- git push origin main
- pnpm fixes:sync
- chore(fixes): sync status after FIX-235
- git push
```

---

## Stage 2 — Orchestrator scheduling adds (FIX-227 + FIX-228 + FIX-232)

Three additions to `runNightlySync()` in `packages/data/src/pipelines/index.ts`. One commit, one observation cycle next Sunday.

```
Land FIX-227 + FIX-228 + FIX-232 as one commit — three orchestrator scheduling additions.

All three add to runNightlySync()'s weekly block in packages/data/src/pipelines/index.ts. Read that file first to identify the exact location of the current Sunday block (`new Date().getDay() === 0` guard) and the order of existing weekly steps.

## FIX-227 — Schedule data:agency-leadership weekly

Verify the pipeline runner export name by reading packages/data/src/pipelines/agency-leadership/index.ts. Likely `runAgencyLeadershipPipeline`.

Add to the Sunday-only weekly block. Placement: after the existing weekly bulk pipelines (FEC, USASpending, CourtListener, OpenStates API, agencies-hierarchy, opm-fte, plum-book, elections, committees) but BEFORE any MV refresh or tag/summary chain — leadership data writes to entity_connections which downstream MVs depend on.

## FIX-228 — Schedule data:agency-enrichment first Sunday of month

Verify runner export from packages/data/src/pipelines/agency-enrichment/index.ts. Likely `runAgencyEnrichmentPipeline`.

Inside the existing Sunday block, gate behind a first-Sunday-of-month check:

    const isFirstSundayOfMonth = new Date(Date.now()).getUTCDate() <= 7;
    if (isFirstSundayOfMonth) {
      await runAgencyEnrichmentPipeline(...);
    }

Place AFTER FIX-227's agency-leadership step. Enrichment writes to agencies.metadata (social handles, descriptions) — independent of leadership but logically grouped.

## FIX-232 — Schedule data:tag-industry in Sunday block

Verify runner export from packages/data/src/pipelines/tags/ai-classifier.ts. May be `runTagIndustryPipeline` or `runIndustryClassifier` — read the file.

The existing CLI script entry has a `--confirm` gate that the orchestrator needs to bypass. Cleanest approach: refactor the pipeline function to accept a typed option `{ confirmed?: boolean }` and have the CLI entrypoint parse argv into that option. Orchestrator passes `confirmed: true` directly.

If the function signature refactor is invasive (e.g. the gate is buried deep), fallback: have the orchestrator set `process.env.ORCHESTRATOR_CONFIRMED = "true"` before calling and check both flags in the gate. Note the choice in the commit body.

Placement: AFTER the Sunday FEC-bulk step (tag-industry runs against newly-arrived PACs from this Sunday's bulk). Place before the AI summary refresh.

## Doc update

Update packages/data/CLAUDE.md cadence section to add:
- "Sunday weekly: ... agency-leadership, tag-industry" (append to existing weekly list)
- "First Sunday of month: agency-enrichment"

## Smoke test

- pnpm --filter @civitics/data exec tsc --noEmit (must be clean — FIX-224 and FIX-235 cleared the pre-existing errors)
- pnpm build clean
- Hard to fully test the Sunday/first-Sunday gates without time-mocking. Acceptable: log-trace the orchestrator on a manual `pnpm data:nightly:ci` to verify the gate evaluation under today's date. The day-check logic is small enough that a code-read review covers correctness.

## Loop

- pnpm build
- git add packages/data/src/pipelines/index.ts packages/data/src/pipelines/tags/ai-classifier.ts packages/data/CLAUDE.md (+ any other file you refactored for the --confirm signature)
- Commit:
    feat(orchestrator): schedule agency-leadership, agency-enrichment, tag-industry

    - FIX-227: agency-leadership runs every Sunday after weekly bulks
    - FIX-228: agency-enrichment runs first Sunday of each month
    - FIX-232: tag-industry runs every Sunday after FEC bulk, picking
      up newly-arrived PACs. Pipeline accepts a typed `{ confirmed }`
      option so the orchestrator can bypass the CLI --confirm gate.

    Verified: local
    Fixes: FIX-227, FIX-228, FIX-232
- git push origin main
- pnpm fixes:sync
- chore(fixes): sync status after FIX-227/228/232
- git push

After next Sunday's nightly, check data_sync_log for new `agency-leadership` and `tag-industry` rows. `agency-enrichment` will only fire on the first Sunday of the next month.
```

---

## Stage 3 — Weekly integrity audit + commit-back (FIX-226)

New GHA workflow runs `pnpm data:audit` every Monday 4 UTC (after Sunday nightly's weekly block) and commits the report to `docs/audits/{YYYY-MM-DD}.md`.

```
Land FIX-226 — schedule data:audit weekly + auto-commit report to docs/audits/.

Context: data:audit (packages/data/src/pipelines/integrity-audit/) is a read-only SQL check suite that catches invariant violations after schema/pipeline changes. Today it's manual-only — no signal when invariants regress. Weekly GHA workflow + commit-back to main converts "audit when I remember" → "regressions surface as diffs in git log".

## Implementation

### 1. Confirm reporter output target

Read packages/data/src/pipelines/integrity-audit/reporter.ts. Note:
- Whether it currently accepts a CLI flag for output path.
- The output format (markdown? JSON? both?).

If reporter doesn't accept `--output`, add a minimal CLI flag pass:
- Default: write to `audit-report.md` in cwd (preserve current behavior).
- With `--output <path>`: write to the specified path; mkdirSync({ recursive: true }) on the parent dir first.
- Markdown is the deliverable for the docs/audits/ artifact. If reporter also writes JSON, leave that path alone — only the markdown gets committed.

### 2. New GHA workflow: .github/workflows/audit.yml

Mirror .github/workflows/nightly.yml's checkout/pnpm/node setup. Key differences:

    name: Weekly Integrity Audit
    on:
      schedule:
        - cron: '0 4 * * 1'    # Mondays 4 UTC (after Sunday nightly's weekly block)
      workflow_dispatch:
    permissions:
      contents: write          # required for commit-back to main
    jobs:
      audit:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - uses: pnpm/action-setup@v2          # match nightly.yml version
            with: { version: <same as nightly> }
          - uses: actions/setup-node@v4
            with: { node-version: <same as nightly>, cache: 'pnpm' }
          - run: pnpm install --frozen-lockfile
          - name: Run audit and write dated report
            run: |
              DATE=$(date -u +%Y-%m-%d)
              mkdir -p docs/audits
              pnpm --filter @civitics/data data:audit -- --output docs/audits/${DATE}.md
            env:
              NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
              SUPABASE_SECRET_KEY: ${{ secrets.SUPABASE_SECRET_KEY }}
          - name: Commit report
            run: |
              DATE=$(date -u +%Y-%m-%d)
              git config user.name "github-actions[bot]"
              git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
              git add docs/audits/
              if ! git diff --cached --quiet; then
                git commit -m "chore(audit): weekly integrity report ${DATE}"
                git push
              else
                echo "No changes — audit report identical to previous week."
              fi

### 3. Doc update

Update packages/data/CLAUDE.md cadence section. Add:
- "Mondays 4 UTC: integrity audit, report committed to docs/audits/{YYYY-MM-DD}.md by GHA workflow audit.yml"

## Smoke test

- pnpm build clean.
- Locally:
      cd packages/data
      pnpm data:audit -- --output ../../docs/audits/test-$(date -u +%Y-%m-%d).md
  Confirm the file exists, is markdown, and contains the check results. Delete the test file (don't commit it): `git checkout docs/audits/`.

## Loop

- pnpm build
- git add .github/workflows/audit.yml packages/data/src/pipelines/integrity-audit/reporter.ts packages/data/CLAUDE.md
- Commit:
    feat(audit): weekly integrity audit with auto-commit to docs/audits/

    New GHA workflow runs `data:audit` every Monday 4 UTC (3h after the
    Sunday nightly's weekly block completes) and commits the report to
    docs/audits/{YYYY-MM-DD}.md on main. Regressions surface as diffs
    in git log docs/audits/.

    Reporter now accepts --output for arbitrary destination paths;
    default behavior preserved.

    Verified: local
    Fixes: FIX-226
- git push origin main
- pnpm fixes:sync
- chore(fixes): sync status after FIX-226
- git push

After next Monday 4 UTC, check Actions tab + verify a new `docs/audits/{date}.md` commit lands on main.
```

---

## Stage 4b — `--confirm` gate on `data:ai-summaries` (FIX-230)

Tiny. Matches the cost-discipline pattern in `data:tag-ai` and `data:tag-industry`.

```
Land FIX-230 — add --confirm gate to data:ai-summaries non-incremental path.

Context: `pnpm data:ai-summaries` (no flags) runs against ALL entities with no cost cap. Orchestrator invokes it with incremental=true so production is safe, but a manual operator could overspend silently. data:tag-ai and data:tag-industry already gate on --confirm — match that pattern.

## Implementation

1. Read packages/data/src/pipelines/ai-summaries/index.ts entrypoint. Identify:
   - How argv is parsed today.
   - How `incremental=true` is detected (likely a flag or env var).
   - The function the orchestrator calls (it bypasses argv parsing).

2. Read packages/data/src/pipelines/tags/ai-tagger.ts (or wherever data:tag-ai's --confirm gate lives). Copy the message format and exit semantics so the two gates look consistent.

3. Add the gate in ai-summaries/index.ts:
   - Parse `confirm` from argv.
   - If invoked WITHOUT --incremental AND WITHOUT --confirm:
       Print: "[ai-summaries] Non-incremental run against ALL entities will spend uncapped Claude credits."
       Print: "[ai-summaries] Re-run with --confirm to proceed, or --incremental for the daily safe path."
       Exit 0 (this is a gate, not an error).
   - If invoked WITH --incremental: existing incremental-path behavior, no gate.
   - If invoked WITH --confirm (and no --incremental): full path.
   - Orchestrator entrypoint (the exported function) is untouched — gate is CLI-layer only.

## Smoke test

- pnpm build clean.
- `pnpm --filter @civitics/data data:ai-summaries` → prints gate message + exit 0, no API calls.
- `pnpm --filter @civitics/data data:ai-summaries -- --incremental` → runs incremental path.
- Do NOT actually run `-- --confirm` unless you intend a real spend.
- Orchestrator path: verify runNightlySync() still hits the function entrypoint directly (not via CLI/argv).

## Loop

- pnpm build
- git add packages/data/src/pipelines/ai-summaries/index.ts
- Commit:
    feat(ai-summaries): gate non-incremental CLI path behind --confirm

    Matches the cost-discipline pattern in data:tag-ai and data:tag-industry.
    Orchestrator's function-call entrypoint is unaffected — gate only
    triggers on manual `pnpm data:ai-summaries` without --incremental.

    Verified: local
    Fixes: FIX-230
- git push origin main
- pnpm fixes:sync
- chore(fixes): sync status after FIX-230
- git push
```

---

## Stage 7a — Pipeline runtime stats MV + admin page (FIX-233 part 1)

Materialized view aggregating `data_sync_log` percentiles, plus an admin page rendering it. Uses existing duration data — independent of Stage 7b.

```
Land FIX-233 part 1 — pipeline_runtime_stats_mv + /admin/pipeline-health page.

Context: data_sync_log captures started_at/completed_at/status per pipeline run but nothing surfaces the trends. p95 duration per pipeline is the only way to spot creep toward the 60-min GHA job cap before pipelines start timing out. This commit adds the MV and a read-only admin page rendering it. Memory metrics come in part 2 (Stage 7b) — schema below already includes the columns so part 2 just fills them.

## Implementation

### 1. Migration: pipeline_runtime_stats_mv

Write supabase/migrations/<next-date>_pipeline_runtime_stats_mv.sql. Get the next free YYYYMMDDHHMMSS prefix from `ls supabase/migrations/ | tail`.

    CREATE MATERIALIZED VIEW pipeline_runtime_stats_mv AS
    SELECT
      pipeline,
      COUNT(*)::INT AS runs_30d,
      COUNT(*) FILTER (WHERE status = 'complete')::INT AS successful_runs_30d,
      ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'complete') / NULLIF(COUNT(*), 0), 1) AS success_rate_pct,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::INT AS p50_duration_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::INT AS p95_duration_ms,
      MAX(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::INT AS max_duration_ms,
      MAX(started_at) AS last_run_at,
      -- Memory cols populated by Stage 7b. NULL today; MV refresh picks them up automatically once the data is there.
      MAX((metadata->>'peak_rss_mb')::INT) AS max_peak_rss_mb,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (metadata->>'peak_rss_mb')::NUMERIC)::INT AS p95_peak_rss_mb
    FROM data_sync_log
    WHERE started_at > NOW() - INTERVAL '30 days'
      AND completed_at IS NOT NULL
    GROUP BY pipeline
    WITH NO DATA;

    CREATE UNIQUE INDEX pipeline_runtime_stats_mv_pkey ON pipeline_runtime_stats_mv (pipeline);

    CREATE OR REPLACE FUNCTION refresh_pipeline_runtime_stats_mv()
    RETURNS void
    LANGUAGE sql
    AS $$
      REFRESH MATERIALIZED VIEW CONCURRENTLY pipeline_runtime_stats_mv;
    $$;

### 2. Orchestrator refresh

In packages/data/src/pipelines/index.ts, find the MV refresh chain (step 7-ish, alongside the chord MVs from FIX-222). Add a call to `refresh_pipeline_runtime_stats_mv()`. Match the existing chord-MV refresh invocation pattern (likely `supabase.rpc('refresh_pipeline_runtime_stats_mv')`).

### 3. Admin page: /admin/pipeline-health

New file apps/civitics/app/admin/pipeline-health/page.tsx.
- `export const dynamic = "force-dynamic";`
- Server component. Use createServerClient(cookies()). Admin gate: match the auth pattern used by other /admin/* pages (e.g. apps/civitics/app/api/admin/run-pipeline/route.ts uses ADMIN_EMAIL check).
- Read `await supabase.from('pipeline_runtime_stats_mv').select('*').order('p95_duration_ms', { ascending: false })`.
- Render a table:

    | Pipeline | Last run | 30d runs | Success % | p50 | p95 | Max | p95 RSS |

    Format durations as `mm:ss` (helper: `(ms) => Math.floor(ms/60000) + ':' + String(Math.floor(ms%60000/1000)).padStart(2,'0')`).
    
    Color the p95 cell:
    - Red (text-red-600 or whatever Tailwind class the project uses for danger) if p95 > 3000000 ms (50 min) — creeping toward GHA 60-min cap
    - Amber if p95 > 1800000 ms (30 min)
    - Green / default otherwise

    Show "—" in the RSS column when null (no Stage 7b data yet).

- Use the project's existing table/card components. Search for table usage in other /admin/* pages and match the convention.

- Add a link to the page from the admin dashboard nav (find where other /admin/* links live and add adjacent).

### 4. Apply migration + first refresh

    supabase migration up --local
    # Verify the MV exists:
    psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "\dm"
    # First refresh (otherwise the page renders empty):
    psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "SELECT refresh_pipeline_runtime_stats_mv();"

After local is clean and the page renders:
    supabase db push --linked
    # Then trigger one prod refresh — either by waiting for next nightly OR by hitting it from Studio:
    # psql against prod DSN — SELECT refresh_pipeline_runtime_stats_mv();

## Smoke test

- pnpm build clean.
- Locally hit /admin/pipeline-health signed in as ADMIN_EMAIL. Verify the table renders with at least one row per active pipeline (assumes you have ≥1 successful row in local data_sync_log; if not, the page will be empty until the MV has data — that's fine, the gating logic is what matters).
- TypeScript check on the new types — the from('pipeline_runtime_stats_mv') call will fail at runtime if Supabase types haven't been regenerated. Either regenerate via the project's normal type-gen step or cast to `as any` and add a TODO to regenerate types after migration.

## Loop

- pnpm build
- supabase migration up --local
- supabase db push --linked (after local is green)
- git add supabase/migrations/<new file> packages/data/src/pipelines/index.ts apps/civitics/app/admin/pipeline-health/page.tsx (+ nav file if updated)
- Commit:
    feat(observability): pipeline_runtime_stats_mv + /admin/pipeline-health

    Aggregates last 30 days of data_sync_log into p50/p95/max duration,
    success rate, and last-run-at per pipeline. New admin page renders
    the table with red/amber/green tiering against the 60-min GHA cap.

    Memory columns (max_peak_rss_mb, p95_peak_rss_mb) are present but
    populated by Stage 7b instrumentation; today they read NULL.

    Refreshed nightly alongside the chord MVs from FIX-222.

    Verified: local + prod
    Fixes: FIX-233
- git push origin main
- pnpm fixes:sync
- chore(fixes): sync status after FIX-233 (part 1)
- git push

NOTE: FIX-233 isn't fully complete until Stage 7b lands. The fixes:sync after this commit will check FIX-233 in FIXES.md — that's fine, the trailer maps 1:1 to the sha. Stage 7b will add a second `Verified: local` for the same FIX-NNN trailer which fixes:sync deduplicates.
```

---

## Stage 7b — Memory metrics instrumentation (FIX-233 part 2)

Adds `peak_rss_mb` to every pipeline's `data_sync_log.metadata` via a one-point change in sync-log helpers. The MV from Stage 7a picks it up automatically on next refresh.

```
Land FIX-233 part 2 — peak_rss_mb in data_sync_log.metadata.

Context: Stage 7a's pipeline_runtime_stats_mv has `max_peak_rss_mb` and `p95_peak_rss_mb` columns sourced from data_sync_log.metadata->>'peak_rss_mb'. Today they're all NULL because no pipeline writes that field. This commit instruments every pipeline with a single-point change in sync-log helpers.

## Implementation

### 1. Update sync-log helpers

Open packages/data/src/pipelines/sync-log.ts. Find completeSync() and failSync() (and skipSync() from FIX-229 if it exists).

Each helper writes a metadata field. Modify each to capture RSS at completion:

    function captureRssMb(): number {
      // Node 18+ exposes process.memoryUsage as a function returning a memberMap.
      // process.memoryUsage.rss() is the lighter-weight per-call form.
      const rssBytes = typeof process.memoryUsage.rss === 'function'
        ? process.memoryUsage.rss()
        : process.memoryUsage().rss;
      return Math.round(rssBytes / 1024 / 1024);
    }

In the metadata-write line of each helper:

    metadata: {
      ...(existingMetadata ?? {}),
      peak_rss_mb: captureRssMb(),
    }

This is RSS at completion time, not peak across the run. For most pipelines that's an acceptable proxy — RSS doesn't shrink much during a single-script process lifetime, especially for our bulk-streaming pipelines. True-peak instrumentation (setInterval sampler returning max) is a Phase 2 refinement; not worth doing now.

### 2. Audit for pipelines that bypass sync-log helpers

Some pipelines might write data_sync_log rows directly without using completeSync/failSync:

    grep -rn "from('data_sync_log').insert\|from(\"data_sync_log\").insert\|.from('data_sync_log').update" packages/data/src/

Any direct writes outside sync-log.ts need their own peak_rss_mb addition. Audit § 1a's active pipeline list is your checklist — verify each uses the helpers. If any pipeline writes directly, add the captureRssMb() call inline.

### 3. Initial backfill (not needed)

Don't backfill past data_sync_log rows. peak_rss_mb is forward-only — the MV will start showing real numbers after the first nightly cycle following deploy.

## Smoke test

- pnpm build clean.
- pnpm --filter @civitics/data exec tsc --noEmit clean.
- Run one pipeline locally:
      cd packages/data
      pnpm data:officials   # or any cheap pipeline
  Then:
      psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
        "SELECT pipeline, metadata->>'peak_rss_mb' AS rss_mb FROM data_sync_log ORDER BY started_at DESC LIMIT 5;"
  Expect: the most recent row has a non-null peak_rss_mb.
- Refresh the MV and check the admin page renders RSS:
      psql ... -c "SELECT refresh_pipeline_runtime_stats_mv();"
  /admin/pipeline-health should show the RSS column populated for at least the pipeline you just ran.

## Loop

- pnpm build
- git add packages/data/src/pipelines/sync-log.ts (+ any individual pipelines you patched for direct data_sync_log writes)
- Commit:
    chore(observability): peak_rss_mb in data_sync_log.metadata

    sync-log helpers now write peak_rss_mb (RSS at completion) into
    every pipeline's data_sync_log row. Picked up automatically by
    pipeline_runtime_stats_mv (Stage 7a) on next refresh.

    RSS-at-completion is an acceptable proxy for peak in bulk-streaming
    pipelines; true-peak (setInterval sampler) deferred as Phase 2.

    Verified: local
    Fixes: FIX-233
- git push origin main
- pnpm fixes:sync
- chore(fixes): sync status after FIX-233 (part 2)
- git push

After next nightly, /admin/pipeline-health should show RSS for every successful pipeline.
```
