# QWEN.md — Civitics Platform Context

Compact context for Qwen Code. Read this before every task.
See CLAUDE.md and subdirectory CLAUDE.md files for full detail.

---

## Project in Brief

Next.js 14 App Router monorepo (Turborepo / pnpm). Two apps: `apps/civitics` (civic governance) and `apps/social`. Shared packages: `packages/db`, `packages/ui`, `packages/graph`, `packages/ai`, `packages/maps`, `packages/blockchain`, `packages/config`.

**Package manager: pnpm only. Never npm or yarn.**

---

## CRITICAL — Active App Directory

```
apps/civitics/app/       ← EDIT HERE — Next.js builds this
apps/civitics/src/app/   ← DO NOT TOUCH — silently ignored at build time
```

All edits go in `apps/civitics/app/`. Changes to `src/app/` are silently discarded.

---

## CRITICAL — Field Name Contracts

These mismatches have caused real bugs. Always use the correct name:

### Graph node/edge types (TypeScript / API responses)
```
nodes:  name       (NOT label)
edges:  fromId     (NOT source)
edges:  toId       (NOT target)
edges:  connectionType  (NOT type)
edges:  amountUsd  (NOT amountCents)
```

### entity_connections table (Supabase DB — snake_case)
```
from_id    from_type
to_id      to_type
connection_type
strength   (0.0 – 1.0 float)
amount_cents  (integer, nullable)
```
The DB uses snake_case; the API layer maps to camelCase. Never mix them.

### votes table
```
vote       (NOT vote_cast)   values: 'yes' | 'no' | 'present' | 'not voting'
voted_at   (NOT vote_date)
metadata->>'vote_question'   procedural type
metadata->>'legis_num'       bill number
```

---

## CRITICAL — Supabase Query Gotchas

### Large array queries — ALWAYS use RPC
```ts
// BROKEN: silently returns empty with 100+ IDs
await supabase.from('table').select('*').in('id', largeArray);

// CORRECT: always use RPC for large arrays
await supabase.rpc('your_rpc_function', { ids: largeArray });
```

### Party enum — use .filter() not .eq()
```ts
// BROKEN: silently fails on enum columns
.eq('party', 'democrat')

// CORRECT:
.filter('party::text', 'eq', 'democrat')
```

### useEffect deps — never pass objects directly
```ts
// BROKEN: causes infinite re-render loop
useEffect(() => { ... }, [primaryGroup]);

// CORRECT: use a primitive from the object
useEffect(() => { ... }, [primaryGroup?.id]);
```

---

## Supabase Clients

Import from `@civitics/db`, never directly from `@supabase/supabase-js`.

```ts
createBrowserClient()          // 'use client' components only
createServerClient(cookies())  // Server Components, Route Handlers (respects RLS)
createAdminClient()            // Server-only, pipelines only (bypasses RLS)
```

**Every route/page using `createAdminClient()` must have:**
```ts
export const dynamic = "force-dynamic";
```
Without this, Next.js prerenders at build time → fails on Vercel (secret key unavailable).

**`generateStaticParams`:** use `createClient()` from `@supabase/supabase-js` with publishable key only. Never `createAdminClient()`.

---

## API Keys

```
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   (sb_publishable_xxx)  — client-side
SUPABASE_SECRET_KEY                    (sb_secret_xxx)       — server-only
```
Never use legacy `anon` / `service_role` keys. Never use `NEXT_PUBLIC_` on the secret key.

---

## Build Rules

- `pnpm build` must pass clean before any push
- Vercel uses strict TypeScript — no build-time errors
- Never commit `node_modules`
- Never use `npm` or `yarn`

---

## Design Philosophy (apps/civitics)

- **Serious civic infrastructure — not social media.** Closer to Bloomberg Terminal than Twitter.
- Dense information display is a feature, not a bug.
- Never ship placeholder or fake data. Real data or empty state only.
- Loading skeletons always. Error boundaries always.

---

## What NOT to Do

- Do not store precise user coordinates — coarsen to district/zip level
- Do not show blockchain addresses, tx hashes, or network names in UI
- Do not use React Flow — D3 force simulation only for the connection graph
- Do not use AWS S3 — use Cloudflare R2
- Do not edit files in `apps/civitics/src/app/`
- Do not use `npm` or `yarn`
- Do not call `createAdminClient()` without `export const dynamic = "force-dynamic";`
- Do not use `.in('column', largeArray)` with 100+ IDs — use RPC instead

---

## CRITICAL — Mandatory Pre-Commit Self-Check

This check is required before every `git commit`. It takes 30 seconds and has caught a real bug on every single task so far.

```bash
# 1. Verify every edited file ends cleanly
tail -5 path/to/edited/file.ts
# Must end with a complete `}` — never mid-line, never mid-string

# 2. Verify no binary corruption
file path/to/edited/file.ts
# Must say "Unicode text" — if it says "data", the file has null bytes

# 3. If either check fails — fix before committing
```

**The three failure modes seen so far:**
- File ends with `cons` instead of `console.error(...)` + closing braces — build fails
- File ends mid-string literal — TypeScript parse error
- File padded with 339 null bytes — `grep` refuses to read it, `file` reports "data"

**Rule:** If you are unsure your write was applied completely, re-read the last 10 lines of the file from disk before committing. Never assume the write succeeded.

---

## Schema — Always Read the Migration First

Before writing any Supabase query, check the actual table schema in `supabase/migrations/`. Do not assume column names from task descriptions — the task description may be out of date. The migration file is authoritative.

Key schema facts that are easy to get wrong:
- `civic_comments.user_id` is `NOT NULL REFERENCES users(id)` — anonymous inserts will fail with a FK violation
- `civic_comments` uses `proposal_id` (not `entity_id`) and `body` (not `text`)
- All amounts are integer cents, never floats
- All IDs are UUIDs

---

## Workflow Notes

- All changes go on branch `qwen/phase1` (or current cycle branch) — never commit to master
- After finishing a task, commit with a descriptive message prefixed `[skip vercel]`
- Claude reviews diffs before merging — write clean, readable code
- See `docs/archive/QWEN_PROMPTS.md` for the current task queue
