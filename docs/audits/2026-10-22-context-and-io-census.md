# Context-load + I/O-budget census — 2026-10-22 (cc-242, read-only)

Run: cc-242, 2026-10-23 00:44Z → 01:15Z (prod reads 00:47Z → 01:06Z), worktree `fix-cc-242`, head `2ba45100`.
Prod: read-only `db-query.mjs --prod` reads (one transaction each, `max_parallel_workers_per_gather = 0`).
Each read took under 60 s, and every one ran while `session:held` printed `held=false`.
Nothing was written to Pro, and no instruction file was edited. Plan: [`docs/cc/projects/context-haircut.md`](../cc/projects/context-haircut.md).

**Token figures are estimates: characters ÷ 3.6.** That divisor is for English markdown with code. No tokenizer was run.

---

## §0 The two questions

**Q1 — what does a session pay in tokens, and is it buying anything?** A `/cc` run starts at **≈ 36.8k est. tokens before its first read**. About 20.0k of that is loaded by the harness every session. Root `CLAUDE.md` alone is 15.0k (75 % of the 20.0k). The other 16.9k is loaded per run.

Of root's 54.5 KB, **44.1 KB (81 %) is in sections classified K+R, D, H or G**. Only 10.4 KB is plain K. The 17 one-line rules in A3 add up to ≈ 2.6 KB.

`docs/FIXES.md` is 809 KB. **85 % of it (690 KB) is closed bullets.**

**Q2 — are the timing windows still buying anything?** Box distress stopped with the cutover:

| | pre (22 days) | since 10-14 (8 days) |
|---|---|---|
| stall-minutes | 818, on 10 days | 0 |
| startup timeouts | 716 | 0 |

Of the gates that held a run, three paid for themselves by receipt (decision C): the nightly window, `held`, and the census/io gates. Two did not:

- **The 05:45–09:00Z blackout:** median hold ~160 min, guarded condition present 0 of 5 times.
- **Vacuum spacing:** median hold ~44 min, guarded condition present 0 of 3 times.

**Migration pushes:** 14 gated migration pushes held the claim for **4–26 s** (12 state a release), and none overlapped measurable activity. The blackout plus vacuum spacing cost one push (cc-210) 5 h 20 m of waiting for a 12 s claim.

---

## §Phase 0 — reads

1. **Head and open count.** `origin/main` = `2ba45100 docs(receipts): 2026-10-23`, and `fixes-status --json` gives `open_count` **41**. That is the prompt's "41 if cc-241 closed FIX-1293", and it did. `44dc0ed0` is an ancestor of `origin/main`. `pnpm cc:verify 240`: 28 pass · 0 fail · 2 unchecked.
2. **`pnpm fixes:archive` does not select closed bullets.** It moves whatever already sits under `## COMPLETED` into `docs/archive/fixes-archive.md` as a new `## Archived YYYY-MM-DD` block on top. It keeps the COMPLETED header and intro, runs the trunk guard (`captureTrunkState`/`abortOnTrunkMove`), and supports `--dry-run`.
   - Its selection rule is position, not age or status. **The dry run prints `fixes:archive — nothing to do: COMPLETED section is already empty` — 0 bullets, 0 bytes.**
   - The selector is `fixes:clean`. It moves every bullet that done.log derives CLOSED out of the live sections and into COMPLETED, grouped by origin section. It never moves from STRATEGIC PILLARS, and it runs the trunk guard. `pnpm fixes:clean:dry`: **179 bullets moved, 11 subsections, 0 without an id marker.**
   - `fixes:housekeep` only assigns ids to unnumbered bullets and warns on drift. It moves nothing.
   - The human recipe is therefore **`fixes:clean` then `fixes:archive`** (A2).
3. **What a session loads, by mechanism.** See the A1 "mechanism" column.
   - The harness loads root `CLAUDE.md`, `~/.claude/CLAUDE.md` and the auto-memory `MEMORY.md` index every session. It loads a package `CLAUDE.md` when a file under that package is read.
   - `/cc` adds its own body (`.claude/commands/cc.md`) and Step 2's "read `docs/cc/PROMPT_TEMPLATE.md`", plus the prompt itself.
   - `/cc` does **not** tell the session to read FIXES.md, done.log, the plan file or the last report. A prompt's Phase 0 often reads 1–3 prior reports.
   - `scripts/cc-prompt.mjs` and `scripts/session-check.mjs` read files internally and only *print*. Their output is the context cost: session:check 4,290 B, cc:prompt 746 B, fixes:sync:dry 1,072 B — ≈ 1.7k tokens together.
   - Root CLAUDE.md's "Session Continuity — Read These First" table names five files: FIXES.md, done.log, PHASE_GOALS, ENGINEERING_PLAYBOOK and CLOUDFLARE. Read literally, that is **≈ 323k est. tokens**. No session can obey it, so it is in effect ignored.
4. **How far back each prod series goes:**

   | series | from | to | rows | note |
   |---|---|---|---|---|
   | `cron.job_run_details` | 2026-09-10 01:52Z | now | 114,983 | covers 09-21 |
   | `public.dispatch_log` | 2026-10-15 03:13Z | now | 6,084 | starts when the tick went live; post-only by construction |
   | `public.data_sync_log` | 2026-04-22 | now | 11,732 | |
   | `public.cron_job_budget_action` | 2026-08-24 | 2026-10-11 | 20 | **no row since 10-11** |

   No series starts after 09-21, so the pre window is the full 09-21 → 10-12.
5. **No stored disk-I/O or IOwait series exists.**
   - The grep hits are `packages/data/src/scripts/iowait-diagnosis.ts` and comments. That script is a one-shot FIX-352 diagnostic that writes a JSON audit.
   - On prod, no table or function names iowait, disk or IOPS. `supabase_prometheus_state` holds four last-value counters (`cpu_busy_seconds_total`, `cpu_total_seconds_total`, `disk_size_bytes`, `node_network_transmit_bytes_total`). That is state, not a series, and there is no disk-I/O counter.
   - `dispatch_log.box` has 401 rows since 10-16 03:23Z with load1, memory and swap, post-cutover only. The box-health memory ring is off-box (Upstash, 24 h).
   - **So the job-wall proxy is primary.** I added an in-DB distress instrument beside it: **stall-minutes** = runs of `box-health-probe`, the two `*/2` watchdogs or `dispatcher-tick` (normally < 1 s each) that took **> 10 s**.
   - I also added the front door's edge 5xx per 15-min bucket, from `data_sync_log` `front_door_watch`.

---

## §A — context load (local)

### A1. Size table

| file | lines | bytes | est. tokens | load mechanism |
|---|---|---|---|---|
| `CLAUDE.md` (root) | 1,081 | 54,494 | 15,031 | every session (harness) |
| `~/.claude/CLAUDE.md` (user) | 65 | 2,770 | 764 | every session (harness) |
| auto-memory `MEMORY.md` index | 132 | 15,048 | 4,177 | every session (harness) — *not in the prompt's list; 2nd-largest fixed load* |
| `.claude/commands/cc.md` | 280 | 12,944 | 3,569 | per /cc run (the command body) |
| `docs/cc/PROMPT_TEMPLATE.md` | 353 | 21,150 | 5,825 | per /cc run (cc.md Step 2) |
| prompts cc-230..241 (12) | — | 9,118 – 60,999 (median 27,210) | median 7,462 | per /cc run (one) |
| reports cc-230..241 (12) | — | 10,547 – 57,532 | median 8,787 | on demand (a Phase 0 read) |
| `apps/civitics/CLAUDE.md` | 283 | 11,403 | 3,140 | on demand (harness, file under it read) |
| `packages/db/CLAUDE.md` | 945 | 48,231 | 13,267 | on demand |
| `packages/graph/CLAUDE.md` | 1,365 | 44,623 | 12,142 | on demand |
| `packages/data/CLAUDE.md` | 417 | 38,250 | 10,539 | on demand |
| `packages/ai/CLAUDE.md` | 294 | 10,347 | 2,857 | on demand |
| `packages/maps/CLAUDE.md` | 167 | 6,541 | 1,806 | on demand |
| `packages/ui/CLAUDE.md` | 135 | 5,431 | 1,497 | on demand |
| `packages/blockchain/CLAUDE.md` | 119 | 4,402 | 1,211 | on demand |
| `.claude/commands/civitics-commit-push.md` | 229 | 8,086 | 2,217 | on demand (slash command) |
| `docs/FIXES.md` | 349 | 809,287 | 223,708 | "Read These First" (by instruction; unobeyable) |
| `docs/done.log` | 1,705 | 242,149 | 66,936 | "Read These First" (by instruction) |
| `docs/PHASE_GOALS.md` | 364 | 25,210 | 6,896 | "Read These First" (by instruction) |
| `docs/ENGINEERING_PLAYBOOK.md` | 1,010 | 63,043 | 17,359 | "Read These First" (by instruction) |
| `docs/CLOUDFLARE.md` | 512 | 28,730 | 7,924 | "Read These First" (by instruction) |
| `docs/ONBOARDING.md` | 120 | 5,379 | 1,478 | on demand |
| `docs/OPERATIONS.md` | 1,063 | 50,343 | 13,889 | on demand |

The nine `CLAUDE.md` files total 4,806 lines and 223,722 bytes. Root cites 55 distinct FIX ids. All three figures match the prompt.

**Totals (est. tokens):**

- **Every-session fixed cost:** root 15,031 + user 764 + MEMORY.md 4,177 = **19,972**. The harness system prompt (tools, skills) is extra and was not measured.
- **Per-/cc-run cost:** cc.md 3,569 + PROMPT_TEMPLATE 5,825 + median prompt 7,462 = **16,856**. Command output adds ≈ 1.4k more.
- **On demand:** the 8 package `CLAUDE.md` files 46,459; playbook 17,359; OPERATIONS 13,889; one prior report ≈ 8.8k each.
- **Nominal "Read These First" set:** 322,823. It is never actually paid.

**A `/cc` run starts at ≈ 36.8k est. tokens (≈ 38.2k with command output) before its first read.** Root `CLAUDE.md` is 41 % of that.

### A2. FIXES.md

- **Size:** 809,287 B in 349 lines, holding **220** bullets (one `<!--id:…-->` line each). Non-bullet text is 3,215 B.
- **Per bullet:** p50 **2,188 B**, p90 **8,810 B**, max **28,730 B**.

| | bullets | bytes | share |
|---|---|---|---|
| OPEN | 41 | 115,951 | 14.3 % |
| CLOSED | 179 | 690,121 | 85.3 % |
| ↳ closed before 2026-09-22 (> 30 days) | 39 | 179,429 | 22.2 % |
| ↳ closed in the last 30 days | 140 | 510,692 | 63.1 % |

The ten largest bullets, nine of them closed:

| id | bytes | status | closed | section |
|---|---|---|---|---|
| FIX-1194 | 28,730 | closed | 2026-10-10 | INFRASTRUCTURE |
| FIX-1125 | 20,980 | **open** | — | INFRASTRUCTURE |
| FIX-1178 | 20,302 | closed | 2026-09-29 | INFRASTRUCTURE |
| FIX-1212 | 15,357 | closed | 2026-09-24 | INFRASTRUCTURE |
| FIX-1106 | 15,220 | closed | 2026-09-22 | BUGS |
| FIX-1189 | 14,433 | closed | 2026-10-10 | INFRASTRUCTURE |
| FIX-1297 | 13,418 | closed | 2026-10-18 | DB PERFORMANCE |
| FIX-969 | 13,406 | closed | 2026-09-29 | INFRASTRUCTURE |
| FIX-1128 | 12,832 | closed | 2026-09-19 | INFRASTRUCTURE |
| FIX-1185 | 12,496 | closed | 2026-09-19 | INFRASTRUCTURE |

**Dry runs:** `fixes:archive:dry` would move **0** (COMPLETED is empty). `fixes:clean:dry` would move **179**.

**What FIXES.md would weigh:**

- After `fixes:clean` then `fixes:archive`: **≈ 119 KB** (≈ 33k est. tokens).
- After a hypothetical "closed more than 30 days" rule instead: ≈ 630 KB. 78 % of the closed weight is younger than 30 days, so an age rule is not the lever.

### A3. Root `CLAUDE.md` — section census (the haircut's input)

Letters (PROPOSED only):

- **K** — keep as a rule
- **R** — receipt; move to the playbook or audits
- **D** — derivable from the code or schema
- **H** — history or stale
- **G** — generic coaching

Close dates come from `fixes-status`. Est. tok = own bytes ÷ 3.6. "dup" means the same rule appears there. `PROMPT_TEMPLATE#…` duplicates matter most, because a `/cc` run reads both files.

| § | section | bytes (own) | est. tok | FIX ids (n) | oldest → newest close | dup | letter | one-line rule (K / K+R) |
|---|---|---|---|---|---|---|---|---|
| — | (preamble: cutover banner) | 567 | 158 | 097–104 (in text) | 04-22 → 04-25 | OPERATIONS (intro) | **H** | — (drop; the env section already says prod = Pro) |
| ## | Session Continuity — Read These First | 2,086 | 579 | — | — | cc.md#Step 4; PROMPT_TEMPLATE#FIX bookkeeping | **K+H** | Start with `pnpm session:check`. Ask `pnpm fixes:status`; never read FIXES.md or done.log whole. |
| ## | Active environment check (CRITICAL) | 1,058 | 294 | 946, 944 | 08-09 → 09-05 | **PROMPT_TEMPLATE#Database** | K | Before any data op: `grep ^NEXT_PUBLIC_SUPABASE_URL .env.local`. Confirm before writing when it points at prod. |
| ### | Switching the active env | 1,845 | 512 | — | — | OPERATIONS#Switch to local Supabase | K+D | `pnpm dev` caches `.env.local` at startup: switch with Copy-Item and restart. Use `tsx --env-file=.env.local.prod` for one-off prod scripts. |
| ### | `cron.job` is a prod-only read (FIX-946) | 1,370 | 381 | 946, 944 | 08-09 → 09-05 | OPERATIONS#Refreshing the Local Prod-Clone | K+R | The clone's `cron.job` is local history. Read cron state from prod and diff by jobname, never jobid. |
| ## | votes Table — Actual Column Names | 1,945 | 540 | 073, 426, 438 | 04-19 → 05-29 | — | K | votes: `vote` (`not_voting` with an underscore), `voted_at`, `bill_proposal_id` (no `proposal_id`; no embed, so use a two-step fetch). `vote_question` is a column. |
| ## | generateStaticParams Rules | 627 | 174 | — | — | app/CLAUDE#Page Conventions; OPERATIONS#Build Failing on Vercel | K (dup) | (lives in apps/civitics/CLAUDE.md — root needs no copy) |
| ## | Active App Directory — CRITICAL | 179 | 50 | — | — | app/CLAUDE#Active App Directory | **H** | — (`ls apps/civitics/src/app` → *No such file or directory*: the trap is gone) |
| ## | FIXES Workflow | 213 | 59 | (21 in ↳) | 04-18 → 10-16 | **PROMPT_TEMPLATE#FIX bookkeeping** | K+R | (header) |
| ### | ↳ Status is DERIVED, not stored (FIX-1016) | 12,616 | 3,504 | 1016, 914, 314, 159, 1243, 027, 020, 021, 024, 461, 1319, 272, 280, 213, 253, 242, 292, 369, 365, 364, 366 | 04-18 → 10-16 | **PROMPT_TEMPLATE#FIX bookkeeping**; cc.md#Step 3 | K+R | Status derives from done.log (`pnpm fixes:status`). FIXES.md is append-only via `pnpm fix:add --lane`. Put each trailer (`Fixes:`/`Closes:`/`Reopens:`/`Verified:`) on ONE line. Run `fixes:sync` only after landing. |
| ## | Claude ↔ Database Access | 721 | 200 | (6 in ↳) | 05-25 → 09-05 | — | **H+K** | Land via the worktree recipe in Deployment. The "standard autonomous loop" (`git push origin main`) and the Cowork fallback predate the worktree model and `/cc`. |
| ### | Applying migrations to Pro — `--db-url`, not `--linked` (FIX-392) | 2,169 | 603 | 392, 375, 379, 385 | 05-25 → 05-31 | **PROMPT_TEMPLATE#Database**; db/CLAUDE | K+R | Push to Pro with `pnpm db:push:prod` (wraps `--db-url`), never `--linked`. Use `set -a` when sourcing the env for the CLI. |
| ### | Ad-hoc queries and CALLs — `db-query.mjs` (FIX-791) | 1,962 | 545 | 791, 703 | 07-01 → 09-05 | **PROMPT_TEMPLATE#Database**; db/CLAUDE; OPERATIONS | K | `node scripts/db-query.mjs --local\|--prod`: prod is read-only and the SQL is positional. `--prod --call` needs `--yes-i-mean-prod`. |
| ## | Database Safety Rules | 2,350 | 653 | 392, 530, 1128, 1063, 1185 | 05-31 → 09-19 | **PROMPT_TEMPLATE#Database**; OPERATIONS#Plan Limits (PITR) | K+R | Never run destructive SQL on Pro without confirmation. The CLI is pinned (`supabase/.cli-version`); compare the bundled PG major with `config.toml` before upgrading. |
| ### | SQL convention — routine-level `statement_timeout` bounds nothing (FIX-1128) | 4,053 | 1,126 | 1128, 1063, 1185 | 08-18 → 09-19 | PLAYBOOK#C2; db/CLAUDE#Function-level statement_timeout; PROMPT_TEMPLATE#Verification (check:proconfig) | K+R | A routine `SET statement_timeout` bounds nothing. A COMMITting pg_cron proc cannot be bounded in its command string, so give it a `cron_job_budget` row. The role ceiling is 3 h; roll it back with `SET '6h'`, never `RESET`. |
| ## | Data-state changes vs schema changes | 1,425 | 396 | (14 in ↳) | 05-31 → 09-22 | — | K | Migrations reach both DBs. Runtime data actions do not: run them per environment, and a runtime FIX is done only when both have run. |
| ### | Bulk rewrite ends by vacuuming what it rewrote (FIX-943) | 2,733 | 759 | 943, 884, 930, 933, 944 | 07-24 → 09-04 | **PLAYBOOK#A4 (5/5 ids)**; db/CLAUDE#Autovacuum; **PROMPT_TEMPLATE#Database** | K+R | A bulk rewrite ends with `VACUUM (ANALYZE)` on each table it rewrote: after the commit, never FULL. |
| ### | Long landing transaction rewinds the watermarks (FIX-983/1074) | 3,246 | 902 | 983, 1074, 1140, 1139, 933, 1101 | 07-31 → 09-22 | PLAYBOOK#C1 (1/6 ids) | K+R | Every `updated_at` watermark clamps to `watermark_horizon()`. A landing transaction longer than `watermark_lag_seconds` must rewind the FR watermarks or pause the consumers. |
| ### | Manifest-scoped remediation must not carry a platform-scoped tail (FIX-1165) | 2,463 | 684 | 1165, 954, 688 | 06-28 → 09-07 | — (the receipt lives only here) | K+R | Each tail step either scales with the manifest or has a scheduled owner (check `cron.job.command`, `pg_proc.prosrc` and the GHA files by name). `--defer-tails` covers the rest. |
| ## | Supabase Clients (Summary) | 667 | 185 | — | — | db/CLAUDE#Three Clients; app/CLAUDE; OPERATIONS | D+K | A route that uses `createAdminClient()` needs `export const dynamic = "force-dynamic"`. |
| ## | Supabase API Keys | 366 | 102 | — | — | db/CLAUDE#API Keys | D | — |
| ## | Claude Code Permissions | 528 | 147 | — | — | `.claude/settings.local.json`; user CLAUDE.md | D | — |
| ## | Package Manager | 171 | 48 | — | — | — | G | — |
| ## | Environment Variables | 1,316 | 366 | 311 | 05-20 → 05-20 | OPERATIONS#Emergency Kill Switches | G | — |
| ## | Deployment | 3,125 | 868 | 462, 1250, 1271 | 06-09 → 10-03 | **PROMPT_TEMPLATE#Git and landing (4/4 phrases)**; cc.md#Step 2 | K | Agents never commit on the primary checkout. Use one worktree per FIX (`pnpm session:worktree`), land by ff `git push origin feature/fix-<id>:main`, then run `fixes:sync`. The pre-push held gate is never bypassed. *(It also carries a stale "`supabase db push --linked` applies migrations" line that contradicts FIX-392.)* |
| ## | Current Phase: Post-cutover cleanup (April 2026) | 514 | 143 | 097, 104 | 04-22 → 04-22 | OPERATIONS (intro) | **H** | — |
| ## | Enrichment Queue Drain — Runbook | 3,479 | 966 | 101 | 04-22 → 04-22 | — | **H** | (pointer, if kept) Enrichment drains use only the `drain-worker` agent; the runbook moves to OPERATIONS. |
| ## | What Not To Do | 462 | 128 | — | — | PROMPT_TEMPLATE#Git and landing (`--no-verify`); ONBOARDING | G | — |
| ## | Onboarding — see docs/ONBOARDING.md | 210 | 58 | — | — | — | K (pointer) | (pointer) |

**Bytes by letter:**

| letter | sections | bytes |
|---|---|---|
| K | 7 | 10,352 |
| K+R | 9 | 31,213 |
| H (incl. K+H, H+K) | 6 | 7,546 |
| D (incl. K+D, D+K) | 4 | 3,406 |
| G | 3 | 1,949 |
| **total** | 29 | 54,466 |

**Duplicates of PROMPT_TEMPLATE.** 11 sections (≈ 32.8 KB) state a rule that PROMPT_TEMPLATE's checklist also states. The duplication is at the level of the rule, not the bytes: root carries the receipt, PROMPT_TEMPLATE carries one line.

The 17 one-line rules above add up to ≈ 2.6 KB. Keeping the 7 K sections verbatim, plus the K+R one-liners and pointers, gives **≈ 12–13 KB (~250 lines** at the file's 50 B/line). Reducing the K sections to their one-liners as well gives **≈ 4–5 KB (~90 lines)**.

**H verification (each is the command that shows the state no longer holds):**

- **Cutover banner (preamble) — H confirmed.** `fixes-status FIX-097 FIX-101 FIX-104` → all closed 2026-04-22. The promotion migration `20260422000000` is history. No decision in the file depends on the banner.
- **"Execution model (as of 2026-04-18)" block (inside Session Continuity) — H confirmed.** It points at `docs/archive/QWEN_PROMPTS.md` and `docs/archive/SESSION_LOG.md`, which are archived. The loop it describes is now `/cc` plus the worktree recipe.
- **"Current Phase: Post-cutover cleanup (April 2026)" — H confirmed.** FIX-097/104 closed 04-22. `git log -1 --format=%cs -- docs/GRAPH_PLAN.md` → **2026-04-25**, so "current focus is the GRAPH_PLAN backlog" does not hold. Current work is tracked in `docs/cc/projects/` and the board.
- **"Enrichment Queue Drain — Runbook" — H confirmed.**
  - Prod `SELECT status, count(*) FROM enrichment_queue GROUP BY 1` → `skipped_no_source_text` 135,718 · `skipped_feature_retired` 8,867 · `done` 8,806 · **`pending` 8,539** · `failed` 148 · `processing` 44. There is no ~120k pending queue.
  - `git grep -l drain-worker` → root CLAUDE.md, `.claude/agents/drain-worker.md`, `docs/archive/SESSION_LOG.md` and one test (`drain-prompt-version.test.ts`). Nothing current runs it.
  - `git log --since=2026-07-01 -i --grep="drain wave\|drain:claim\|drain-worker"` → no drain session.
- **Qwen mentions — history, all three.** `grep -rn -i qwen CLAUDE.md apps packages/*/CLAUDE.md docs/*.md .claude`:
  - `CLAUDE.md:44` — the archive pointer;
  - `docs/FIXES.md:3` — the preamble says bullets can be handed "to Qwen or Claude Code";
  - `docs/OPERATIONS.md:170` — the old `qwen/phase1` branch note.
- **`CIVITICS_HANDOFF.md` pointer — premise refuted.** Root `CLAUDE.md` has no such pointer: `git grep -n CIVITICS_HANDOFF` hits only `docs/cc/reports/cc-172.md`. The root file `CIVITICS_HANDOFF.md` exists (20,885 B, last commit 2026-05-01) and nothing current references it.
- **Active App Directory — reclassified K → H by this census.** `ls apps/civitics/src/app` → *No such file or directory*. The "silently ignored stale duplicate" it warns about no longer exists, in root and in apps/civitics alike.

### A4. Package `CLAUDE.md` section census

Columns as A3, without the H verification or the one-line rule. The letters come from a classification pass that read each file in full and spot-checked the tree. I re-verified three of its H claims:

- `apps/civitics/src/app` is gone;
- `packages/data/src/migrations` is gone;
- `rebuild-entity-connections.yml` is `workflow_dispatch`-only (FIX-688).

**V** = product-vision prose (pricing tiers, Phase-5 plans, mission). It fits none of K/R/D/H/G and is kept visible for Craig to bin as G or H.

**Bytes by letter:**

| file | total | H | D | K | K+R | other |
|---|---|---|---|---|---|---|
| `packages/graph/CLAUDE.md` | 44,536 | 15,011 | 17,362 | 5,806 | — | D+K 3,058 · G 2,263 · V 1,036 |
| `packages/db/CLAUDE.md` | 48,158 | 1,501 | 13,675 | 5,505 | 21,060 | D+R 2,451 · R 1,822 · G 2,144 |
| `packages/data/CLAUDE.md` | 38,205 | 5,300 | 1,356 | 987 | 14,582 | K+D 14,104 · G 1,876 |
| `apps/civitics/CLAUDE.md` | 11,358 | 330 | 846 | 385 | 1,906 | V 4,067 · G 3,824 |

What the totals say:

- **graph:** 32.4 KB is H+D. It documents the pre-build SettingsPanel/GraphSidebar architecture and a "Stage 1 (Build Now)" plan from April.
- **db:** half is K+R, and the D share (13.7 KB) is client factories, table lists and the merge SQL.
- **data:** 28.7 KB is K+D or K+R, and 5.3 KB is H. The H includes a **misleading** schedule: the EC rebuild is described as a GHA Sun+Wed TRUNCATE, but it is pg_cron, and the workflow is `workflow_dispatch`-only.
- **apps:** 7.9 KB is V+G (tiers, pricing, generic hydration advice).

Other stale lines the pass flagged: db `#Migration Conventions` prescribes `YYYYMMDD_description.sql`, but every migration uses a 14-digit timestamp. db `#Refresh hook placement` cites `refresh_homepage_stats_mv` at `pipelines/index.ts:908`, which a grep does not find. graph `#Connection Type Registry` omits `opposition` (FIX-747).

#### `apps/civitics/CLAUDE.md` — 19 sections

| line | section | bytes | FIX ids | oldest → newest close | dup | letter |
|---|---|---|---|---|---|---|
| 3 | Purpose | 236 | — | — | ONBOARDING#Mission | D |
| 10 | Tone and Design Philosophy | 415 | — | — | ONBOARDING | V |
| 22 | Active App Directory — CRITICAL | 330 | — | — | root#Active App Directory | H |
| 34 | Data Rules | 385 | — | — | — | K |
| 44 | Page Conventions | 409 | — | — | root#Supabase Clients, root#generateStaticParams | D |
| 54 | Request-path queries MUST use withDbTimeout | 1,906 | — | — | PROMPT_TEMPLATE#Verification | K+R |
| 91 | Hydration Safety | 205 | FIX-1086 | 2026-08-22 → 2026-08-22 | OPERATIONS#Hydration Errors | G |
| 96 | ↳ The three common traps | 3,283 | FIX-1086 | 2026-08-22 → 2026-08-22 | OPERATIONS#Hydration Errors | G |
| 183 | ↳ Quick checklist before shipping a new component | 336 | — | — | — | G |
| 191 | Build Rule | 201 | — | — | root#Deployment | D |
| 199 | User Access Tiers | 21 | — | — | — | V |
| 201 | ↳ Free (ad-supported, genuinely powerful — covers 90% of citizen n | 457 | — | — | — | V |
| 209 | ↳ Contributing Member ($5/mo or 500 credits) | 248 | — | — | — | V |
| 214 | ↳ Investigator ($20/mo) | 146 | — | — | — | V |
| 218 | ↳ Organization ($99/mo) | 130 | — | — | — | V |
| 224 | Institutional API | 831 | — | — | — | V |
| 244 | Candidate Empowerment (Phase 5) | 740 | — | — | — | V |
| 261 | Contribution Portal (Community Development, Phase 2–3) | 508 | — | — | — | V |
| 273 | Global Deployment Architecture | 571 | — | — | — | V |

Bytes by letter: V 4,067 · G 3,824 · K+R 1,906 · D 846 · K 385 · H 330

#### `packages/db/CLAUDE.md` — 49 sections

| line | section | bytes | FIX ids | oldest → newest close | dup | letter |
|---|---|---|---|---|---|---|
| 3 | Purpose | 177 | — | — | root#Supabase Clients | D |
| 9 | API Keys (New Format Only) | 396 | — | — | root#Supabase API Keys | D |
| 21 | Management API | 665 | — | — | — | D |
| 36 | Three Clients | 17 | — | — | root#Supabase Clients | D |
| 38 | ↳ createBrowserClient() | 82 | — | — | root#Supabase Clients | D |
| 42 | ↳ createServerClient(cookieStore) | 151 | — | — | root#Supabase Clients | D |
| 47 | ↳ createAdminClient() | 294 | — | — | root#Supabase Clients | D |
| 54 | ↳ generateStaticParams exception | 207 | — | — | root#generateStaticParams | D |
| 60 | Database Schema Conventions | 325 | — | — | — | D |
| 70 | Core Tables | 1,523 | FIX-747, FIX-735, FIX-703 +2 | 2026-07-01 → 2026-07-05 | — | D |
| 87 | ↳ ⚠️ IMPORTANT CORRECTION — entity_connections | 1,895 | FIX-747, FIX-735, FIX-703 +2 | 2026-07-01 → 2026-07-05 | PLAYBOOK#E11 | K+R |
| 125 | users table — design notes | 1,481 | — | — | — | D |
| 158 | proposals table — vote_category column | 973 | — | — | — | K |
| 180 | officials table — column names | 452 | — | — | — | K |
| 198 | financial_relationships table — column names | 418 | — | — | — | K |
| 213 | RLS Patterns | 532 | — | — | — | D |
| 230 | Materialization pattern for slow request-path aggregations | 415 | FIX-207, FIX-222, FIX-223 +22 | 2026-05-05 → 2026-10-03 | — | R |
| 238 | ↳ When to reach for it | 330 | — | — | — | G |
| 249 | ↳ Shape options — pick by cadence + audience + history value | 1,818 | FIX-223, FIX-207, FIX-222 +3 | 2026-05-05 → 2026-05-18 | — | K+R |
| 273 | ↳ Redefining a live MV — always swap, never DROP + CREATE (FIX-103 | 4,211 | FIX-1032, FIX-1030 | 2026-08-12 → 2026-09-02 | — | K+R |
| 343 | ↳ Naming conventions | 290 | — | — | — | D |
| 351 | ↳ Refresh hook placement | 996 | FIX-1127 | 2026-08-29 → 2026-08-29 | — | H |
| 372 | ↳ Retiring or pausing a pg_cron job — declare it in the same migra | 3,175 | FIX-1059, FIX-736, FIX-977, FIX-1177 | 2026-07-05 → 2026-10-03 | PLAYBOOK#D9 | K+R |
| 429 | ↳ Read path convention | 1,927 | FIX-1127, FIX-327, FIX-1120 | 2026-05-22 → 2026-08-29 | PLAYBOOK#D1 | K+R |
| 461 | ↳ Compute + read + write helper convention | 1,002 | FIX-281, FIX-297 | 2026-05-16 → 2026-05-18 | — | D |
| 482 | ↳ Function-level `statement_timeout` — does NOT raise a PostgREST  | 1,657 | FIX-512, FIX-505, FIX-506, FIX-291 | 2026-05-17 → 2026-06-06 | root#SQL convention, PLAYBOOK#C2 | K+R |
| 511 | ↳ When NOT to materialize | 624 | FIX-206 | 2026-05-05 → 2026-05-05 | — | G |
| 524 | ↳ Cost note | 437 | FIX-297 | 2026-05-18 → 2026-05-18 | — | G |
| 534 | ↳ Per-enum-value loops — the FIX-298 shape | 753 | FIX-298, FIX-301 | 2026-05-18 → 2026-05-18 | — | G |
| 552 | ↳ Existing materializations — quick-lookup table | 2,451 | FIX-1146, FIX-090, FIX-1095 | 2026-08-22 → 2026-09-04 | — | D+R |
| 590 | Cross-source merge surface — `financial_entities` FK-rewrite tem | 707 | FIX-271, FIX-381 | 2026-05-14 → 2026-05-25 | — | K |
| 603 | ↳ Canonical merge template | 1,197 | FIX-271, FIX-381 | 2026-05-14 → 2026-05-25 | — | D |
| 624 | ↳ Full FE-bearing surface (2026-05-25 audit) | 1,860 | FIX-381, FIX-271 | 2026-05-14 → 2026-05-25 | — | D |
| 647 | ↳ Copy-paste rewrite SQL — entity_tags + enrichment_queue | 2,324 | FIX-381 | 2026-05-25 → 2026-05-25 | — | D |
| 700 | ↳ When to extend this list | 547 | — | — | — | K |
| 715 | Autovacuum: per-table settings and the bulk-rewrite vacuum rule | 275 | FIX-884, FIX-1133, FIX-943, FIX-1152 | 2026-07-24 → 2026-09-07 | root#bulk-rewrite vacuum | K |
| 721 | ↳ Why percent-dead is the wrong number | 810 | FIX-884 | 2026-07-24 → 2026-07-24 | root#bulk-rewrite vacuum, PLAYBOOK#D7 | R |
| 740 | ↳ Currently tuned (prod + local, verified 2026-08-01) | 1,152 | FIX-1133 | 2026-09-04 → 2026-09-04 | — | D |
| 757 | ↳ Sizing an *ad-hoc* vacuum — never from the cron job's history (F | 1,881 | FIX-1133 | 2026-09-04 → 2026-09-04 | PLAYBOOK#C5 | K+R |
| 789 | ↳ Bulk-rewrite tails on `financial_relationships` are an outage ri | 597 | FIX-1133, FIX-943 | 2026-07-31 → 2026-09-04 | root#bulk-rewrite vacuum, PLAYBOOK#C5 | R |
| 799 | ↳ Sizing a new one | 1,696 | FIX-1152 | 2026-09-07 → 2026-09-07 | PLAYBOOK#D7 | K+R |
| 824 | ↳ Applying | 418 | — | — | — | K |
| 834 | Storage Strategy | 243 | — | — | — | H |
| 840 | ↳ Migration path (when Cloudflare account available) | 262 | — | — | — | H |
| 846 | ↳ Rules | 352 | — | — | — | K |
| 854 | Migration Conventions | 433 | — | — | root#Database Safety Rules | K |
| 869 | Regenerating `src/types/database.ts` (`pnpm db:types`) | 930 | — | — | — | K |
| 889 | ↳ The local gen differs from the prod gen by four artifacts, none  | 1,626 | — | — | — | K+R |
| 925 | ↳ The local clone carries objects prod does not | 1,174 | — | — | — | K+R |

Bytes by letter: K+R 21,060 · D 13,675 · K 5,505 · D+R 2,451 · G 2,144 · R 1,822 · H 1,501

#### `packages/data/CLAUDE.md` — 19 sections

| line | section | bytes | FIX ids | oldest → newest close | dup | letter |
|---|---|---|---|---|---|---|
| 3 | Purpose | 577 | — | — | db/CLAUDE#Materialization pattern | D |
| 16 | Pipeline Conventions | 627 | — | — | PLAYBOOK#D9 | G |
| 26 | Storage Budget | 918 | FIX-182, FIX-1068 | 2026-05-02 → 2026-08-24 | — | H |
| 41 | Per-Source Strategy | 23 | FIX-181, FIX-240, FIX-246 +23 | 2026-04-28 → 2026-10-11 | — | D |
| 43 | ↳ Congress.gov | 244 | — | — | — | D |
| 49 | ↳ FEC Campaign Finance | 9,928 | FIX-181, FIX-240, FIX-246 +6 | 2026-05-02 → 2026-08-24 | — | K+D |
| 113 | ↳ IRS Form 990 (FIX-250) | 4,176 | FIX-250 | 2026-05-11 → 2026-05-11 | — | K+D |
| 153 | ↳ USASpending.gov | 4,348 | FIX-114, FIX-1274, FIX-766 +8 | 2026-04-28 → 2026-10-11 | PLAYBOOK (FIX-1274) | K+R |
| 169 | ↳ Regulations.gov | 262 | — | — | — | D |
| 176 | ↳ CourtListener | 250 | — | — | — | D |
| 182 | ↳ OpenStates | 2,024 | FIX-160, FIX-915 | 2026-04-28 → 2026-07-27 | — | K+R |
| 205 | ↳ Census TIGER districts (FIX-160 maps integration, FIX-217 congre | 2,303 | FIX-160, FIX-217, FIX-913, FIX-914 | 2026-04-28 → 2026-09-09 | — | K+R |
| 225 | Update Schedules | 2,163 | FIX-291, FIX-263, FIX-226 +3 | 2026-05-10 → 2026-10-11 | — | H |
| 240 | Entity Connections Derivation | 1,394 | FIX-291, FIX-234 | 2026-05-10 → 2026-05-17 | db/CLAUDE (pg_cron) | H |
| 254 | Bulk vs API for Data Sources | 1,249 | — | — | — | G |
| 283 | Full 2 GB FEC Individual File (FIX-181 — landed) | 825 | FIX-181, FIX-236, FIX-192 +3 | 2026-05-02 → 2026-08-24 | — | H |
| 300 | ↳ Indiv-stage memory — external sort, not a heap ceiling (FIX-961) | 4,232 | FIX-961, FIX-1068 | 2026-08-18 → 2026-08-24 | — | K+R |
| 368 | ↳ The $200 floor is an AGGREGATE floor, applied at emit (PR 3b / F | 1,675 | FIX-1068 | 2026-08-24 → 2026-08-24 | — | K+R |
| 402 | ↳ `small_dollar_bracket_rollup` — the residual substrate (FIX-1068 | 987 | FIX-1068, FIX-776 | 2026-07-15 → 2026-08-24 | — | K |

Bytes by letter: K+R 14,582 · K+D 14,104 · H 5,300 · G 1,876 · D 1,356 · K 987

#### `packages/graph/CLAUDE.md` — 60 sections

| line | section | bytes | FIX ids | oldest → newest close | dup | letter |
|---|---|---|---|---|---|---|
| 3 | Purpose | 653 | — | — | db/CLAUDE#Materialization pattern | V |
| 16 | The One Rule | 158 | — | — | — | V |
| 22 | Active Refinement Plan (April 2026) | 2,403 | FIX-120, FIX-150, FIX-144 +7 | 2026-04-25 → 2026-05-20 | GRAPH_PLAN.md | H |
| 66 | The Three-Layer Model | 1,820 | FIX-816, FIX-144, FIX-148 +3 | 2026-04-26 → 2026-07-12 | — | D |
| 134 | ↳ FocusEntity Interface | 520 | — | — | — | D |
| 161 | ↳ Focus Operations (useGraphView) | 595 | — | — | — | D |
| 190 | ↳ The Critical Rule: Viz Switching Is Style-Only | 367 | — | — | — | K |
| 202 | Technology | 386 | — | — | — | K |
| 215 | File Structure (Target Architecture) | 2,001 | — | — | — | H |
| 277 | Current State & Migration | 29 | — | — | — | H |
| 279 | ↳ Existing Files in `packages/graph/src/` | 3,998 | — | — | — | H |
| 301 | ↳ Stage 1 (Build Now) — COMPLETE ✓ | 1,683 | — | — | — | H |
| 338 | ↳ Stage 2 (After Launch) | 388 | — | — | — | H |
| 354 | ↳ Chord Diagram Fix Required | 1,396 | — | — | — | H |
| 392 | ↳ Settings Panel UX | 499 | — | — | — | H |
| 408 | The Viz Registry | 1,779 | — | — | — | D |
| 466 | The Settings Panel | 185 | — | — | — | H |
| 472 | ↳ Section 1 — FOCUS | 220 | — | — | — | H |
| 481 | ↳ Section 2 — CONNECTIONS | 407 | — | — | — | H |
| 494 | ↳ Section 3 — STYLE | 351 | — | — | — | H |
| 504 | ↳ Panel Footer | 164 | — | — | — | H |
| 515 | Panel Layout | 594 | — | — | — | D |
| 530 | ↳ Left Panel — Data Explorer | 410 | — | — | — | D |
| 548 | ↳ Right Panel — Graph Config | 309 | — | — | — | D |
| 561 | ↳ Canvas | 115 | — | — | — | D |
| 566 | ↳ Collapse Behavior | 222 | — | — | — | D |
| 574 | ↳ Real-Time Wiring (CRITICAL) | 995 | — | — | — | K |
| 615 | TreeNode — The Core UI Primitive | 1,064 | — | — | — | D |
| 663 | ↳ Visual Rules | 396 | — | — | — | D |
| 676 | ↳ Never build custom panel rows. | 128 | — | — | — | K |
| 683 | The Viz Dropdown | 1,287 | FIX-144, FIX-148, FIX-145 +2 | 2026-04-26 → 2026-04-26 | — | H |
| 716 | Connection Type Registry | 3,058 | FIX-141, FIX-142, FIX-143 +2 | 2026-04-25 → 2026-04-26 | — | D+K |
| 823 | Interaction Contracts | 93 | — | — | — | K |
| 827 | ↳ Tooltip (hover) | 336 | — | — | — | D |
| 842 | ↳ Click Popup | 511 | — | — | — | D |
| 862 | Screenshot Contract | 496 | — | — | — | K |
| 882 | ↳ Watermark (always included, non-removable) | 339 | — | — | — | K |
| 895 | Presets | 464 | FIX-216, FIX-146, FIX-218, FIX-217 | 2026-04-26 → 2026-05-09 | — | D |
| 909 | ↳ Built-in Presets (never remove these) | 3,322 | FIX-216, FIX-146, FIX-218, FIX-217 | 2026-04-26 → 2026-05-09 | — | D |
| 954 | Node Visual Language | 24 | — | — | — | D |
| 956 | ↳ Shapes (never change — visual consistency matters) | 342 | — | — | — | D |
| 967 | ↳ Node Size (default: connection count) | 332 | — | — | — | D |
| 982 | ↳ Node Color (default: entity type) | 261 | — | — | — | D |
| 997 | Edge Visual Language | 24 | — | — | — | D |
| 999 | ↳ Thickness | 107 | — | — | — | D |
| 1003 | ↳ Opacity | 85 | — | — | — | D |
| 1008 | Multi-Entity Focus Behavior | 1,335 | — | — | — | D |
| 1064 | Smart Graph Expansion Rules | 932 | — | — | — | K |
| 1089 | Strength Filter | 390 | — | — | — | K |
| 1105 | Force Simulation Parameters | 380 | — | — | — | D |
| 1122 | Performance Rules | 398 | — | — | — | G |
| 1138 | Graph State Serialization (Share Codes) | 315 | — | — | — | D |
| 1157 | Database Tables | 954 | — | — | — | D |
| 1199 | AI Narrative | 249 | — | — | — | D |
| 1208 | Path Finder | 212 | — | — | — | D |
| 1216 | Embed Mode | 90 | — | — | — | D |
| 1222 | Default View (No Entity Selected) | 195 | — | — | — | D |
| 1229 | What Not To Do | 1,865 | — | — | — | G |
| 1299 | API Field Name Contract | 1,680 | — | — | — | K |
| 1358 | The North Star | 225 | — | — | — | V |

Bytes by letter: D 17,362 · H 15,011 · K 5,806 · D+K 3,058 · G 2,263 · V 1,036

### A5. Top-level `docs/` census

There are 13 `docs/*.md` files. Inbound references were counted with `git grep -l -F <name> -- docs CLAUDE.md apps packages scripts`, excluding the file itself.

| doc | bytes | last commit | inbound refs | archive dry run |
|---|---|---|---|---|
| FIXES.md | 809,287 | 2026-10-20 | 78 | — (live) |
| ENGINEERING_PLAYBOOK.md | 63,043 | 2026-10-14 | 6 | — (live) |
| CROSS_SOURCE_RESOLUTION_INVESTIGATION.md | 56,077 | 2026-09-28¹ | 7 | **REFUSED** — cited by `supabase/migrations/20260514000000_cross_source_resolution.sql:4` and `…000001_cross_source_backfill.sql:4` |
| OPERATIONS.md | 50,343 | 2026-10-11 | 25 | — (live) |
| STAGE_1_SCHEMA_DESIGN.md | 46,733 | 2026-09-28¹ | 6 | **REFUSED** — cited by `20260421000000_stage1_01_shadow_init.sql:9,16` |
| FIX_239_INVESTIGATION.md | 32,722 | 2026-09-28¹ | 6 | **REFUSED** — cited by `packages/data/src/pipelines/fec-bulk/indiv.ts:464` and `20260510000005_canonical_donor_fingerprint_function.sql:4` |
| CLOUDFLARE.md | 28,730 | 2026-10-13 | 21 | — (live) |
| ARCHITECTURE.md | 25,996 | 2026-10-10 | 6 | — (recent) |
| PHASE_GOALS.md | 25,210 | 2026-10-10 | 27 | **not a candidate** — `scripts/board.mjs:517` pins it (`phaseGoalsPath`) |
| GRAPH_PLAN.md | 21,941 | 2026-04-25 | 11 | **REFUSED** — `packages/graph/src/connections.ts:247` ("see GRAPH_PLAN.md §3.1") plus 4 fixture strings in `scripts/test-check-doc-links.mjs` |
| API.md | 18,099 | 2026-09-28¹ | 6 | **REFUSED, falsely** — the only hits are fixture strings in `scripts/test-check-doc-links.mjs:30,41` |
| ROADMAP.md | 6,288 | 2026-04-12 | 7 | **movable** — 1 move, 5 line rewrites in 5 files, 3 history hits left |
| ONBOARDING.md | 5,379 | 2026-05-20 | 4 | keep — root CLAUDE.md links it |

¹ `db9696ad` (FIX-1243, 09-28) rewrote links in these files during the ten-document archive. The date is a sweep, not authorship; the last real edit is older.

---

## §B — I/O budget (prod reads)

The window is 2026-09-21 → 2026-10-21 UTC. The pre/post split is at **2026-10-13 00:00Z**, when the derived layer was parked (FIX-1311 landed 10-13 23:32Z). The tick went live at **2026-10-15 03:13Z**.

### B1. The daily series

Column sources:

- **Wall columns:** `cron.job_run_details` (status `succeeded`/`failed`). Wall = `end_time − start_time`.
- **work:** excludes the four monitors.
- **top-3:** logical jobs. Dispatcher one-shots are deleted from `cron.job` after they run, so they are folded back to their job name via `dispatch_log.armed_jobid`.
- **stall-min:** monitor runs > 10 s.
- **nightly:** `data_sync_log` `nightly_cron` phase-wall sum for the run that *starts* that UTC day; `fec` is the weekend FEC bulk phase inside it.
- **edge 5xx:** `front_door_watch` buckets, de-duplicated by bucket.
- **57014:** no `cron.job_run_details` failure in the window carries 57014 or "canceling statement" text. The cron-side 57014 source is `cron_job_budget_action` (B3).
- **other fail:** all 4 are `server restarted`, on 10-08, 10-12 ×2 and 10-13.

| day | | Σ wall s | work s | max single s | >600 s | top-3 by Σ wall (s) | startup TO | 57014 | PGRST002 | other fail | stall-min | nightly min | usaspending | edge 5xx |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 09-21 | pre | 9,699 | 9,497 | 1,151 | 2 | ec-crawl 5668 / donor-rollup-refresh 1152 / rule-taggers-daily 994 | 0 | 0 | 0 | 0 | 0 | 16 | — | 71 |
| 09-22 | pre | 60,712 | 42,206 | 11,335 | 20 | donor-party-rollup-refresh 11335 / derived-mvs-unit-watchdog 9956 / cron-job-budget-watchdog 8549 | 172 | 0 | 0 | 0 | 157 | 17 | — | 173 |
| 09-23 | pre | 907 | 879 | 351 | 0 | refresh-derived-mvs-daily 351 / rule-taggers-daily 205 / ec-crawl 116 | 0 | 0 | 0 | 0 | 0 | 10 | — | 40 |
| 09-24 | pre | 3,647 | 3,494 | 1,889 | 1 | contract-flow-rollups-refresh 1889 / ec-crawl 905 / refresh-derived-mvs-daily 382 | 0 | 0 | 0 | 0 | 0 | 10 | — | 33 |
| 09-25 | pre | 2,358 | 2,227 | 355 | 0 | ec-crawl 1533 / refresh-derived-mvs-daily 355 / rule-taggers-daily 225 | 0 | 0 | 0 | 0 | 0 | 10 | — | 40 |
| 09-26 | pre | 922 | 805 | 359 | 0 | refresh-derived-mvs-daily 359 / rule-taggers-daily 226 / ec-crawl 121 | 0 | 0 | 0 | 0 | 0 | 79 (fec 6) | — | 27 |
| 09-27 | pre | 5,021 | 4,586 | 1,044 | 2 | ec-crawl 2278 / fe-crawl 1162 / donor-rollup-refresh 472 | 1 | 0 | 0 | 0 | 9 | 113 (fec 96) | — | 46 |
| 09-28 | pre | 10,233 | 9,912 | 1,446 | 1 | ec-crawl 6941 / donor-rollup-refresh 1446 / refresh-derived-mvs-daily 377 | 0 | 0 | 0 | 0 | 0 | 12 | — | 88 |
| 09-29 | pre | 8,913 | 8,589 | 5,063 | 3 | rule-taggers-weekly 5063 / refresh-derived-mvs-weekly 1593 / treemap-individuals-global-refresh 907 | 0 | 0 | 0 | 0 | 4 | 10 | — | 36 |
| 09-30 | pre | 1,784 | 1,574 | 340 | 0 | ec-crawl 814 / refresh-derived-mvs-daily 340 / rule-taggers-daily 203 | 0 | 0 | 0 | 0 | 0 | 15 | — | 14 |
| 10-01 | pre | 5,059 | 4,838 | 1,904 | 1 | contract-flow-rollups-refresh 1904 / ec-crawl 1469 / refresh-derived-mvs-daily 361 | 0 | 0 | 0 | 0 | 0 | 11 | — | 21 |
| 10-02 | pre | 2,407 | 2,193 | 361 | 0 | ec-crawl 1490 / refresh-derived-mvs-daily 361 / rule-taggers-daily 210 | 0 | 0 | 0 | 0 | 0 | 13 | — | 8 |
| 10-03 | pre | 1,787 | 1,468 | 339 | 0 | ec-crawl 801 / refresh-derived-mvs-daily 339 / box-health-probe 211 | 0 | 0 | 0 | 0 | 5 | 92 (fec 5) | — | 18 |
| 10-04 | pre | 8,255 | 7,629 | 2,498 | 3 | ec-crawl 3962 / donor-rollup-refresh 2498 / fe-crawl 548 | 6 | 0 | 0 | 0 | 13 | 113 (fec 102) | — | 27 |
| 10-05 | pre | 8,628 | 8,201 | 880 | 1 | ec-crawl 6125 / donor-rollup-refresh 880 / refresh-derived-mvs-daily 322 | 0 | 0 | 0 | 0 | 2 | 21 | — | 44 |
| 10-06 | pre | 118,038 | 69,524 | 19,044 | 29 | rule-taggers-weekly 19044 / box-health-probe 16710 / derived-mvs-unit-watchdog 16703 | 177 | 0 | 0 | 0 | 166 | 13 | — | 39 |
| 10-07 | pre | 943 | 710 | 199 | 0 | rule-taggers-daily 199 / refresh-derived-mvs-daily 199 / box-health-probe 155 | 0 | 0 | 0 | 0 | 0 | 9 | — | 259 |
| 10-08 | pre | 22,855 | 11,503 | 2,109 | 5 | ec-crawl 6520 / box-health-probe 6370 / cron-job-budget-watchdog 3811 | 251 | 0 | 0 | 1 | 327 | 17 | usaspending-bulk 17:10–23:50Z (5 h 52 m, reaped) | 1,168 |
| 10-09 | pre | 8,732 | 8,402 | 397 | 0 | ec-crawl 5152 / fe-crawl 1580 / donor-rollup-refresh 733 | 0 | 0 | 0 | 0 | 0 | 17 | — | 102 |
| 10-10 | pre | 2,689 | 2,523 | 399 | 0 | ec-crawl 1167 / donor-rollup-refresh 762 / refresh-derived-mvs-daily 226 | 0 | 0 | 0 | 0 | 0 | 93 (fec 4) | cc-215: contracts 22:37–23:59Z (82 m), assistance from 23:59Z | 92 |
| 10-11 | pre | 14,494 | 12,191 | 1,953 | 6 | ec-crawl 7246 / fe-crawl 3258 / box-health-probe 1465 | 94 | 0 | 0 | 0 | 106 | 111 (fec 97) | cc-215 assistance killed 01:21:59Z; cc-217 assistance 09:30–09:39Z | 320 |
| 10-12 | pre | 12,112 | 10,981 | 1,288 | 2 | ec-crawl 7653 / donor-rollup-refresh 1288 | 15 | 0 | 0 | 2 | 29 | 13 | — | 9,483 |
| 10-13 | **post** | 6,448 | 4,174 | 932 | 2 | box-health-probe 1025 / treemap-individuals-global-refresh 932 | 12 | 0 | 0 | 1 | 10 | 11 | — | 153 |
| 10-14 | **post** | 205 | 86 | 25 | 0 | box-health-probe 85 / cron-job-budget-watchdog 27 / platform-counts-daily 25 | 0 | 0 | 0 | 0 | 0 | 12 | — | 1 |
| 10-15 | **post** | 225 | 66 | 29 | 0 | box-health-probe 93 / cron-job-budget-watchdog 34 / platform-counts-daily 29 | 0 | 0 | 0 | 0 | 0 | 10 | — | 3 |
| 10-16 | **post** | 230 | 69 | 32 | 0 | box-health-probe 91 / cron-job-budget-watchdog 32 / platform-counts-daily 32 | 0 | 0 | 0 | 0 | 0 | 11 | — | 2 |
| 10-17 | **post** | 280 | 98 | 24 | 0 | box-health-probe 100 / dispatcher-tick 43 / vote-stats-refresh 33 | 0 | 0 | 0 | 0 | 0 | 97 (fec 5) | — | 9 |
| 10-18 | **post** | 4,417 | 4,070 | 1,298 | 2 | ec-crawl 2287 / donor-rollup-refresh 1298 / fe-crawl 380 | 0 | 0 | 0 | 0 | 0 | 104 (fec 91) | — | 25 |
| 10-19 | **post** | 5,393 | 5,037 | 1,149 | 1 | ec-crawl 3451 / donor-rollup-refresh 1149 / dispatcher-tick 156 | 0 | 0 | 0 | 0 | 0 | 14 | — | 75 |
| 10-20 | **post** | 2,106 | 1,780 | 493 | 0 | ec-crawl 637 / rule-taggers-weekly 493 / rule-taggers-daily 422 | 0 | 0 | 0 | 0 | 0 | 10 | — | 16 |
| 10-21 | **post** | 651 | 393 | 214 | 0 | rule-taggers-daily 214 / dispatcher-tick 119 / box-health-probe 101 | 0 | 0 | 0 | 0 | 0 | 12 | — | 16 |

### B2. The burst days (Craig's chart dates ±1, matched to the DB)

The DB proxy ranks the days differently from the chart. **Where they disagree, the DB wins.**

| chart day | DB day(s) | what consumed it | class |
|---|---|---|---|
| ≈ 09-27 | 09-27 / 09-28 | 09-27: cc-166's FIX-918 migration + MV swap under a claim, 09:30–10:45Z (deferred ec ×2, fe ×1). 7 stall-min in the 09Z hour, max 16 s; donor-rollup-refresh also ran 09:00 for 472 s. The Sunday drop nightly ran 21:00–22:55Z (113 min, fec 96) with 2 stall-min. 09-28: ec-crawl steady at 6,941 s, 0 stall-min. | **(iii)** supervised op + **(ii)** nightly — both small |
| ≈ 10-05 | **10-06** (and 10-04) | 10-06 (Tue): rule-taggers-weekly from 16:00Z, 5 h 17 m (19,044 s), plus an ec-crawl unit of 6,952 s and the 11:0x MV vacuums at 1.4–2.1 h each. Result: **the box crash** (`docs/audits/2026-10-06-box-crash-triage.md`), 166 stall-min 16–22Z, 177 startup TO. 10-04: donor-rollup 09:00 for 2,498 s plus an ec backoff trip, 13 stall-min. The Sunday drop nightly that day had 0 stall-min. | **(i)** scheduled weekly job, in a non-steady state |
| ≈ 10-07 | 10-06 or 10-08 | 10-07 itself is the **quietest DB day of the month** (943 s Σ wall, 0 stall-min). Its only signal is 252 edge 52x, a front-door event invisible to cron. | → 10-06 / 10-08 |
| ≈ 10-09 | **10-08** | usaspending-bulk (GHA dispatch) ran 17:10–23:50Z, 5 h 52 m, to its cap (FIX-1291; `docs/audits/2026-10-09-work-mem-allowance-census.md` W2). That gave 327 stall-min 19–23Z, 251 startup TO and 1,168 edge 5xx. 10-09 itself: ec-crawl 5,152 s and 0 stall-min; cc-210's push took 12 s at 09:09Z. | **(iii)** one-off op |
| *(not on the chart)* | **09-22** | Tue: donor-party-rollup-refresh from 15:00Z, 3 h 9 m (11,335 s), plus the 11:0x MV vacuums at ~1 h each. That gave 157 stall-min 15–22Z and 172 startup TO. **The second-worst DB day of the window**, and missing from the chart's four. | **(i)** scheduled weekly job |
| *(not on the chart)* | 10-11 01–02Z | cc-215's usaspending-bulk assistance part, killed at 01:21:59Z: 106 stall-min, 94 startup TO. | **(iii)** supervised op |
| Sunday drop nights 09-27 · 10-04 · 10-11 · 10-18 | — | fec_bulk ran 96 / 102 / 97 / 91 min. Stall-minutes inside 21–23Z: **2 / 0 / 0 / 0**. | **(ii) — not a budget consumer by the DB proxy** |

**The split:** the four heaviest distress days were two scheduled **weekly** jobs (09-22, 10-06) and two **one-off/supervised** USASpending runs (10-08, 10-11). **The nightly did not cause one of them.**

### B3. Pre vs post 10-13

| metric | pre 09-21..10-12 (22 d) | post 10-13..10-21 (9 d) | post, dispatched only 10-18..10-21 (4 d) |
|---|---|---|---|
| daily Σ wall, mean / median / max (s) | 14,100 / **6,657** / 118,038 | 2,217 / 651 / 6,448 | 3,142 / **3,262** / 5,393 |
| daily work wall, mean / median (s) | 10,179 / 6,234 | 1,753 / 393 | 2,820 / 2,925 |
| max single wall (s) | 19,044 (rule-taggers-weekly 10-06) | 1,298 (donor-rollup 10-18) | 1,298 |
| walls > 600 s per day | 3.45 (76 total) | 0.56 (5) | 0.75 (3) |
| days with Σ wall > 10,000 s | 6 | 0 | 0 |
| `job startup timeout` | 716 on 7 days | 12, all on 10-13 (the 01:24:52Z restart) | **0** |
| stall-minutes (monitor > 10 s) | 818 on 10 days | 10, all on 10-13 | **0** |
| 57014, cron side (`cron_job_budget_action`) | 6 (10-04: 1 · 10-08: 3 · 10-11: 2 — all ec/fe-crawl units) | 0 | 0 |
| 57014, front door (cc-241's census) | — | 0 renders / 0 events in both 60-min windows around its push (baseline 23:32–00:32Z, post 00:32–01:32Z 10-22). cc-240: 0 / 0. cc-239: 2 / 2, ratio 1.01, PASS. | |
| edge 5xx per day, mean / median | 552 / 42 (10-12: 9,483) | 33 / 16 | 33 / 21 |
| crawl backoff trips (`backoff_tripped = true`) | 5 (ec 09-21, 10-04, 10-11; fe 10-08, 10-11) | 1 (ec 10-18 03:01:31Z) | 1 |
| nightly wall (weekday / weekend), min | 9–21 / 79–113 | 10–14 / 97–104 | unchanged |

Cumulative `pipeline_state` skip counters:

- **ec_crawl:** backoff 198 · blackout **527** · cycle_cooldown **2,345** · peer_due 28 · peer_running 25.
- **fe_crawl:** backoff 109 · peer_backoff 74 · peer_running 21 · peer_due 9.

**`dispatch_log` reason tally per day.** Rows are bucketed first-match in this order: armed, reaped, prod_session, blackout, cooldown, group busy, io, missed, error, nothing_due.

| day | total | armed | reaped | nothing_due | cooldown | gated: blackout | gated: prod_session | group busy | io: | missed | error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10-15 | 624 | 0 | 0 | 624 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 10-16 | 718 | 2 | 2 | 714 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 10-17 | 726 | 6 | 6 | 714 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 10-18 | 807 | 87 | 87 | 251 | 317 | 65 | 0 | 0 | 0 | 0 | 0 |
| 10-19 | 825 | 105 | 105 | 306 | 228 | 80 | 0 | 1 | 0 | 0 | 0 |
| 10-20 | 792 | 72 | 72 | 63 | 585 | 0 | 0 | 0 | 0 | 0 | 0 |
| 10-21 | 783 | 63 | 63 | 25 | 539 | 93 | 0 | 0 | 0 | 0 | 0 |

The log has **zero** `gated: prod_session`, `io:`, `missed` and `error` rows, ever. The ~6-min nightly "group busy" that cc-239..241 describe is mostly folded into `cooldown`/`nothing_due` text by the first-match order.

**Part of the flat stretch is parked work, not paced work.**

- 10-14..10-17 average ~235 s/day because both crawls were parked until FIX-1327 returned them (10-18 00:33Z).
- Six derived jobs have **not returned**: `refresh-derived-mvs-daily`, `-weekly`, `contract-flow-rollups-refresh`, `donor-party-rollup-refresh`, `treemap-individuals-global-refresh` and `group-donor-rollup-refresh`. Together they were 32,194 s of pre wall, ≈ 1,463 s/day.
- The MV vacuum series fell from 54,408 s pre to ~120 s post, because the MVs it vacuums are no longer refreshed.
- **So the fair comparison is the dispatched-only column.**

**Did the dispatcher flatten the curve? Partly.** The distress signature is gone: **stall-minutes went from 818 (on 10 of 22 pre days) to 0 (on 8 of 8 days since 10-14), and startup timeouts from 716 to 0.** The workload is lower but not equivalent: **median daily Σ wall went from 6,657 s to 3,262 s in the dispatched window**, and ≈ 1.5 k s/day of the pre figure belongs to derived jobs still parked. The verdict on load waits for the derived layer's RETURN (dispatcher s12b).

### B4. Which timing gates earned their keep (decision C)

**Coverage.** The prompt names "the last 30 days of reports (cc-212 → cc-241)", but cc-212 started 2026-10-10. I read **cc-210 → cc-241** (the `cc-2{1..4}*` glob), which covers **2026-10-09 → 2026-10-22, 13 days**. A true 30-day window starts near cc-158 and was not read. The "present?" column comes from the B1/B3 series at the instant of each hold, not from the report's opinion.

| gate | holds / stops (run, date, minutes) | median wait | guarded condition present during the hold | verdict |
|---|---|---|---|---|
| **05:45–09:00Z blackout** (prod_op_gate (c); ec_crawl config) | 5: cc-210 run hold, 10-09 05:45→09:09:52Z (~205; ~320 incl. spacing, for a 12 s push) · cc-218 deferral of ec window 16, 10-11 · dispatcher `gated: blackout` 10-18 fe (65 rows, ~130) · 10-19 ec (80, ~160) · 10-21 ec (93, ~186) | ~160 | **0 of 5.** Across 31 days: **0** `nightly_cron`/`fec_bulk` phases started inside 05:45–09:00Z (the nightly dispatches at 21:00Z, FIX-1218), and **0** stall-minutes fell inside the window. The only work there was refresh-derived-mvs-daily 06:00 (FIX-1124's receipt; 22 runs pre, 1 post, parked) and rule-taggers-daily 06:30 (3 post runs, max 223 s). | **idle** → FIX-1341 |
| **nightly window** (prod_op_gate (g); writers wait) | 2 run holds: cc-215, 10-10 22:01→22:37Z (36) · cc-221, 10-12 00:00→00:09Z (9). Plus 1 dispatcher hold, 10-18 21:04→22:35Z (~91; the nightly's own claim). | 36 | **3 of 3:** `live_writers = nightly_cron:enrichment-light` (cc-215); the schedule fallback created at 00:07:26Z would have checked out new code (cc-221); fec_bulk was writing (10-18) | **earned** |
| **vacuum spacing** (gate (g), rule 155) | 3: cc-210 fr spacing, 10-09 03:49→04:33Z (~44) · ec spacing →06:01Z (~88) · cc-227 `b:fr-vacuum-analyze`, 10-15 03:06:49→03:11:50Z (~5) | 44 | **0 of 3.** Each hold began after the vacuum had **ended**: fr 10-09 ran 03:00 for 235 s; fr 10-15 ran 03:00:00–03:00:09. There were 0 stall-minutes on 10-09 and 10-15. | **idle** → §C list |
| **renders census** (`--census stop`, gate (f)) | 1 stop: cc-215, 10-11 01:21:34Z (6 renders vs floor 3, ratio 12.12). The census at every one of the 15 push gates passed. | stop | **1 of 1:** 10-11 01Z had 71 stall-min and 63 startup TO | **earned** |
| **held / `session:held`** (incl. unreadable) | 3: cc-219, 10-13 00:55→01:25Z (~31; held=unknown, prod unreachable) · cc-225, 10-13 00:59→01:25Z (~26) · cc-215, 10-11 ~01:37→02:15Z (~38; pooler ECHECKOUTTIMEOUT). cc-216 waited 0. | 31 | **3 of 3:** 10-13 00–01Z had 10 stall-min, 12 startup TO and the 01:24:52Z restart; 10-11 02Z had 35 stall-min and 31 startup TO | **earned** |
| **io / `box_is_saturated`** | 3: cc-215, 10-11 01:18Z (3.7; stale probe, `startup_timeouts_10m` 4) · cc-219, 10-13 01:25→02:22Z (~57; startup timeouts after the restart) · cc-234, 10-16 03:25Z STOP by the letter, overruled | 3.7 | **2 of 3.** cc-234's trigger was a 1.58 s watchdog run, which the dispatcher's own read excludes by design. `dispatch_log` `io:` rows = 0, ever. | **earned** |
| **prompt `when:` windows** | 9: cc-212 (floor not honoured) · cc-216 48 · cc-217 ~120 · cc-228 ~6 · cc-234 ~13 · cc-237 (unstated) · cc-239 ~0.2 · cc-215 / cc-220 (cutoffs sized the run) | 13 | Only 1 was a box guard with its condition present: cc-217, where donor-rollup was live 09:04–09:11Z, before the 09:30Z floor. 3 were measurement windows (a 24 h ring, after-change reads); the rest are unstated. | **unknown** (mostly not box guards) |
| **dispatcher cooldown / backoff / group busy** (observed, cc-237..241) | backoff rungs of 30 / 60 / 120 min · cycle_cooldown 125.6 min · group busy ~6 min nightly at 02:13Z | 60 | **Every observed case.** The ec backoff tripped 03:01:31Z 10-18; cycle_cooldown = `min_cycle_interval` 360 min; fe-crawl was live during the group-busy hold. | **earned** (by construction) |

**Two idle gates with ≥ 3 holds:**

- **Blackout → FIX-1341.** Dispatcher s11 (N2, cc-243) already owns retiring the crawl config. But `prod_op_gate()` (`20260920150000`, lines 455–456 and 665–670) falls back to the constants `c_blackout_from 05:45` / `c_blackout_to 09:00` when `pipeline_state.ec_crawl.blackout` is absent. **Removing the config therefore leaves the supervised-op blackout in place**, so the filing is not a duplicate of s11.
  - **Superseded on trunk at 2026-10-23 ~01:15Z, after this census.** cc-243 landed N2 (`4e70e2fa`, FIX-1336, migration `20261023000000_fix1336_n2_nightly_start_blackout_retired_yield_next_due.sql`). Its hunk (d) rewrites `prod_op_gate()` so that "an empty or absent ec_crawl.blackout is NO window" and removes `c_blackout_from` / `c_blackout_to`. FIX-1341's premise therefore no longer holds on trunk. Its Pro side is whatever cc-243's report states. FIX-1341 should close as `closes-as-superseded` by FIX-1336. cc-242 carries no `Closes:` trailer (prompt §7), so that closure is left to the next prompt. The B4 measurement (idle, 0 of 5) stands as the receipt for retiring the window.
- **Vacuum spacing → §C (7).** The three-filing cap was reached.

### B5. Migrations and pushes

There are 15 gated ops in cc-210..cc-241: 14 migration pushes and 1 `CREATE INDEX CONCURRENTLY`. Each ran under its own FIX-950 claim through `session:wait-for-gate:prod … --then`.

| run | date | what | claim → release | wall | gate wait before it |
|---|---|---|---|---|---|
| cc-210 | 10-09 | fix1294/1295/1287 work_mem m1 | 09:09:52 → 09:10:04Z | ~12 s | **~5 h 20 m** (fr + ec spacing, then the blackout) |
| cc-211 | 10-10 | fix1295 m2+m3 + fix1293 | 05:06:57 → ≤ 05:07:23Z | < 26 s | first poll |
| cc-214 | 10-10 | fix1291 | 20:32:52 → 20:32:57Z | ~5 s | first poll |
| cc-219 | 10-13 | fix1296 + fix1299 | gate open 02:22:56Z → (unstated) | — | ~57 min (startup timeouts after the restart; real) |
| cc-220 | 10-14 | CIC `fr_donation_updated_at` | 00:42:15 → ~00:44:00Z | ~105 s | — |
| cc-220 | 10-14 | fix1297/1293 index twin | gate open 01:06:17Z → (unstated) | — | — |
| cc-232 | 10-13 | fix1311 park | 23:32:37 → 23:32:45Z | ~8 s | — |
| cc-226 | 10-15 | fix1312 + fix1307 | 02:10:46 → ≤ 02:11:08Z | < 22 s | — |
| cc-227 | 10-15 | fix1308 dispatcher | 03:12:06.75 → 03:12:11Z | ~5 s | ~5 min (vacuum spacing; idle) |
| cc-234 | 10-16 | fix1316 | 03:22:07 → 03:22:11Z | ~4 s | — |
| cc-235 | 10-17 | fix1320 + fix1321 | 02:12:28 → 02:12:32Z | ~4 s | first poll |
| cc-237 | 10-18 | fix1327 + fix1328 | 00:33:05.9 → 00:33:11Z | ~5 s | target-window wait (unstated) |
| cc-239 | 10-20 | fix1329 + fix1334 | 00:29:19.2 → ~00:29:25.7Z | ~6.5 s | ~0.2 min |
| cc-240 | 10-21 | fix1335 | 00:33:29.0 → ~00:33:33.9Z | ~4.9 s | 3.1 min (gate census latency) |
| cc-241 | 10-22 | fix1293 | 00:32:00.6 → 00:32:07Z | ~6.4 s | 1.7 min (gate census latency) |

- **The longest push claim was ≤ 26 s** (cc-211, three files). The median of the 12 with a stated release was ~5.7 s. The longest op was 105 s, an index build, not a migration.
- **No push overlapped measurable activity.** Three checks:
  - On 10-09..10-22 no scheduled writer wrote a `prod session held` skip row, so no claim held back anything that was due.
  - Stall-minutes at every push instant were 0.
  - Every gate census passed (0–3 renders in 60 min).
- `data_sync_log` has **no claim rows**. Claims are a `pg_locks` advisory lock plus a `pipeline_state.prod_session` label (FIX-950 D1). The only DB trace a claim leaves is a deferred writer's `skipped` row. That contradicts the prompt's premise.
- **The one push-day in the 30-day DB window with coincident activity is 09-27**, before the report range: cc-166's FIX-918 migration and MV swap. Its claim deferred ec ×2 and fe ×1 at 09:30–10:45Z, and the 09Z hour had 7 stall-min (max 16 s). donor-rollup-refresh ran 09:00 for 472 s in the same hour. That was an MV swap, not a DDL push.
- **Pushes are cheap; the window rules were sized for bulk ops.** Only one push in 13 days (cc-210) paid for them: 5 h 20 m of waiting for a 12 s claim.

---

## §C — recommendations

Each recommendation names the table cell that supports it.

1. **Run `pnpm fixes:clean`, then `pnpm fixes:archive`.** `fixes:archive` alone moves nothing. The result is 179 closed bullets / 690 KB out and FIXES.md at ≈ 119 KB (A2; Phase 0 read 2). An age rule is not the lever: it would move only 39 bullets / 179 KB. Filed as **FIX-1340**. *next: Craig (human-run).*
2. **Cut root `CLAUDE.md` down to its K rules plus pointers: ≈ 12–13 KB (~250 lines) with the K sections verbatim, ≈ 4–5 KB (~90 lines) if they too become one-liners.**
   - Keep the 7 K sections (10.4 KB) and the one-line rules from the 9 K+R sections (31.2 KB).
   - Move the FIX-1165 / FIX-983 / FIX-1128 / FIX-1016 receipts to the playbook.
   - Drop the 6 H units (7.5 KB) and the 3 G sections (1.9 KB).
   - Fix the two self-contradictions:
     - Deployment's "`supabase db push --linked` applies migrations" vs FIX-392;
     - the Claude↔DB loop's `git push origin main` vs the worktree landing.

   Source: A3. Filed as **FIX-1339**. *next: cc-245.*
3. **Give each rule one home where root and PROMPT_TEMPLATE overlap.** 11 sections (≈ 32.8 KB) restate a rule that PROMPT_TEMPLATE also states (A3 dup column). Root is the only file a non-`/cc` session loads, so the one-line rule should live in root and PROMPT_TEMPLATE should keep only the `/cc`-specific items. Which file wins is a design call. *next: Cowork, then cc-245.*
4. **Package haircuts, most misleading first** (A4):
   - data `#Update Schedules` and `#Entity Connections Derivation`: they say the EC rebuild is a GHA Sun+Wed job; it is pg_cron, and the workflow is dispatch-only.
   - The `Active App Directory` sections in root and apps: the directory they warn about is gone.
   - graph's 15.0 KB of H and 17.4 KB of D.
   - db's 13.7 KB of D.
   - apps' 7.9 KB of V+G.

   *next: cc-246+.*
5. **The docs archive is mostly refuted** (A5):
   - 4 of the 5 expected candidates are refused because migration or code comments cite them.
   - API.md's refusal is false: it comes from fixture strings in `scripts/test-check-doc-links.mjs`. Fix the checker or the fixture, then archive.
   - Only `ROADMAP.md` moves cleanly.
   - `CIVITICS_HANDOFF.md` (repo root, 20.9 KB, untouched since 05-01, referenced by nothing current) is a candidate the prompt did not list.

   *next: cc-246+.*
6. **Re-derive two gates from the post-cutover series, and release migration pushes from the bulk-op windows** (B4, B5):
   - **Blackout:** idle 0 of 5, median ~160 min. `prod_op_gate`'s constant fallback outlived N2's config retirement (**FIX-1341**). cc-243's N2 migration then removed it, so FIX-1341 is superseded (see B4).
   - **Vacuum spacing:** idle 0 of 3, median 44 min.
   - **Pushes:** 14 migration pushes, ≤ 26 s, 0 overlaps.

   *next: Cowork design, then cc-247.*
7. **Things the series showed that the prompt did not anticipate:**
   - (a) **The "flattest stretch" is partly parked work** (B3). 10-14..10-17 is four days of the crawls parked. Six derived jobs (≈ 1.46 k s/day pre) have not returned. The load verdict waits for s12b's RETURN. *next: Cowork.*
   - (b) **09-22 is the second-worst DB day and is absent from the chart's four** (B2). That was a weekly scheduled job (donor-party-rollup, 3 h 9 m). The distress drivers were **weekly jobs and USASpending one-offs, never the nightly**. *next: Cowork (tier input).*
   - (c) **The front door's worst day, 10-12, was a request flood, not a disk day**: 9,483 edge 5xx (7,277 of them 52x) on 366,502 requests, ≈ 13× normal, while cron showed 12.1 k s and 29 stall-min. 10-07's 252 52x landed on the quietest DB day. The Disk-IO chart cannot see either. *next: Cowork.*
   - (d) **The auto-memory `MEMORY.md` index (15 KB, ≈ 4.2k est. tokens) is the second-largest every-session load** and is outside the haircut's scope. *next: Craig/Cowork (memory).*
   - (e) **Vacuum spacing: re-derive gate (g)'s proportional spacing** (B4 idle row). Not filed because of the three-filing cap. *next: Cowork, at prompt time.*
   - (f) **The "Read These First" list in root is ≈ 323k est. tokens** (A1). Replace it with "ask the tools" (`fixes:status`, `session:check`, the board). This is part of 2. *next: cc-245.*
