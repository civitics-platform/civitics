# QWEN_PROMPTS.md — Civitics Task Queue (ARCHIVED)

> ⚠️ **PAUSED as of 2026-04-15.** Qwen Code is no longer free, so this workflow is on hold.
> Claude now handles all implementation directly. This file is preserved as a historical
> task archive. **Do not queue new tasks here. Do not write Qwen input prompts.**
> Work through `docs/FIXES.md` items directly in each session.

**Last updated: 2026-04-15**

---

## How This Works

1. **Before starting any task**, Qwen should:
   - Read `QWEN.md` (project root) in full — critical gotchas, field name contracts, file integrity rules
   - Read every file path listed in the task before writing any code
   - Confirm current branch: `git branch` — must be on `qwen/<cycle>`, never `master`

2. **Mandatory pre-commit self-check** (do this before every `git commit`):
   - Run `tail -5 <every file you edited>` — confirm each ends with a complete `}`
   - Run `file <every file you edited>` — output must say "Unicode text", never "data"
   - If either check fails, re-read the file from disk and fix the ending before committing
   - This has caught real truncation bugs on every task so far

3. **After completing each task**:
   - Commit with `[skip vercel]` prefix: `git commit -m "[skip vercel] <type>: <description>"`
   - One task per commit — keep them atomic and reviewable

4. **When uncertain about intent**, leave a `// TODO(review): ...` comment and move on. Do not guess.

5. **Output format Claude expects**: clean TypeScript, no stray `console.log` in production paths, no placeholder text, no hardcoded fake data.

6. **New components and functions**: add a one-line `// QWEN-ADDED: <purpose>` comment directly above them so Claude can spot additions quickly during review.

---

## Active Queue

---

### TASK-01 — Fix sunburst ring2: all sort modes produce identical output

**Status:** `COMPLETE — merged 2026-04-07`
**Risk:** Low — isolated to one function in one route
**Files to read first:**
- `apps/civitics/app/api/graph/sunburst/route.ts` (full file)

**Problem:**
The sunburst API accepts a `ring2` param with three values: `'top_entities'`, `'by_amount'`, `'by_count'`. The param is read and routed through a switch statement, but all three cases do identical sorting:

```ts
// All three cases currently do this — identical behavior:
return [...items].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
```

Changing ring2 in the UI has no visible effect.

**Fix:**
Implement distinct behavior for each mode. The `value` field on each child item is set to `amount_cents ?? Math.round(strength * 1_000_000)` in `buildChildren()`.

- `'by_amount'`: sort by `value` descending (amount_cents based) — this is the current behavior, keep it
- `'top_entities'`: sort by `strength` descending. You'll need to pass `strength` through `buildChildren()` so it's available in the sort. Currently `strength` is used to compute `value` but not stored separately.
- `'by_count'`: sort by count of connections per ring1 group (i.e. `children.length` within each group, not individual item sorting). Actually implement this as: within each group, sort children by how many entity_connections they appear in. Since that data isn't in the current payload, implement as: sort by `value` but add a `// TODO: needs connection count field from DB` comment. Don't fake it.

**Acceptance criteria:**
- Changing ring2 from `'top_entities'` to `'by_amount'` produces a visually different ordering for an entity with mixed connection types
- TypeScript compiles clean (`pnpm build` passes)
- No new console.log statements

---

### TASK-02 — Fix search ranking: connection count query hits .in() large array bug

**Status:** `COMPLETE — merged 2026-04-07`
**Risk:** Medium — touches the search API route, test manually after
**Files to read first:**
- `apps/civitics/app/api/search/route.ts` (full file)
- `QWEN.md` section "CRITICAL — Supabase Query Gotchas"

**Problem:**
In the officials search function, connection counts are fetched to help rank results:

```ts
const ids = officials.map((o) => o.id);
const [fromRes, toRes] = await Promise.all([
  db.from("entity_connections").select("from_id").in("from_id", ids),
  db.from("entity_connections").select("to_id").in("to_id", ids),
]);
```

**Per the project's known gotcha**: `.in('column', largeArray)` with 100+ IDs silently returns an empty result set. When the search returns many officials, `ids` easily exceeds 100. This means `countMap` is always empty, `connCount` is always 0 for everyone, and the ranking degrades to just `isFederal` priority. High-profile senators with many connections rank no higher than obscure local officials.

**Fix:**
Replace both `.in()` calls with an RPC that accepts an array of IDs and returns connection counts. Create a new Supabase RPC migration (local only — use `supabase migration new search_connection_counts --local`).

The RPC should:
```sql
-- Returns one row per id with total connection count (from OR to)
create or replace function get_connection_counts(entity_ids uuid[])
returns table(entity_id uuid, connection_count bigint)
language sql stable as $$
  select id as entity_id, count(*) as connection_count
  from (
    select from_id as id from entity_connections where from_id = any(entity_ids)
    union all
    select to_id   as id from entity_connections where to_id   = any(entity_ids)
  ) sub
  group by id;
$$;
```

Call it as:
```ts
const { data: countData } = await db.rpc('get_connection_counts', { entity_ids: ids });
const countMap = new Map<string, number>();
for (const r of countData ?? []) {
  countMap.set(r.entity_id, Number(r.connection_count));
}
```

Remove the old `fromRes`/`toRes` parallel fetch.

**Important**: Use `supabase migration new <name> --local` to create the migration. NEVER run against production (`--local` flag is mandatory).

**Acceptance criteria:**
- Searching "warren" returns Elizabeth Warren near the top (she has many connections)
- `pnpm build` passes
- Migration file created in `supabase/migrations/` with correct timestamp

---

### TASK-03 — Community commenting UI on proposal detail pages

**Status:** `COMPLETE — merged 2026-04-07`
**Risk:** Low — new component, no existing code to break
**Files to read first:**
- `apps/civitics/app/proposals/[id]/page.tsx` (understand page structure)
- `packages/db/CLAUDE.md` (schema conventions)

**Background:**
The `civic_comments` table exists in the database (confirmed in PHASE_GOALS.md). There is currently no UI for it. Community commenting is a Phase 1 remaining feature.

**What to build:**

1. A `CivicComments` client component at:
   `apps/civitics/app/proposals/[id]/components/CivicComments.tsx`

2. An API route for fetching and posting comments at:
   `apps/civitics/app/api/proposals/[id]/comments/route.ts`

**Component requirements:**
- `'use client'` — needs interactivity
- Shows existing comments (fetch from API on mount)
- Shows a text area + "Add comment" button for posting
- Empty state: "Be the first to comment on this proposal."
- Loading state: skeleton rows (consistent with rest of app)
- Error state: "Unable to load comments." with retry button
- Display format per comment: display_name (or "Anonymous"), timestamp (relative: "2 days ago"), comment text
- No upvoting, no nested replies — keep it simple for Phase 1
- Max comment length: 2000 characters (show counter when within 200 chars)

**API route requirements:**
- `GET /api/proposals/[id]/comments` — returns comments for a proposal, ordered by `created_at DESC`, limit 50
- `POST /api/proposals/[id]/comments` — creates a comment. Body: `{ text: string }`. For Phase 1, does not require auth (anonymous posting is fine — auth can be added later).
- Use `createServerClient(cookies())` for GET (respects RLS), `createAdminClient()` for POST (needs to insert)
- Remember: `export const dynamic = "force-dynamic";` on any route using `createAdminClient()`

**civic_comments table schema (from DB):**
```
id            UUID DEFAULT gen_random_uuid()
entity_type   TEXT  (use 'proposal')
entity_id     UUID  (the proposal id)
user_id       UUID  (nullable — anonymous if null)
display_name  TEXT  (nullable)
text          TEXT
created_at    TIMESTAMPTZ DEFAULT now()
```

**Integration:**
Add `<CivicComments proposalId={proposal.id} />` near the bottom of the proposal detail page (`apps/civitics/app/proposals/[id]/page.tsx`), above the related proposals section if one exists.

**Acceptance criteria:**
- Component renders without errors on `/proposals/[any-id]`
- Can post a comment and see it appear without page refresh
- Handles network errors gracefully
- `pnpm build` passes clean

---

---

### TASK-04 — TypeScript audit: add generic types to all remaining bare `withDbTimeout` calls

**Status:** `COMPLETE — merged 2026-04-13 (reviewed in commit e14cf061)`
**Risk:** Very low — TypeScript types only, zero logic changes
**Files to edit:**
- `apps/civitics/app/api/graph/chord/route.ts`
- `apps/civitics/app/api/graph/connections/route.ts`
- `apps/civitics/app/api/graph/entities/route.ts`
- `apps/civitics/app/api/graph/group/route.ts`
- `apps/civitics/app/api/graph/search/route.ts`
- `apps/civitics/app/api/graph/sunburst/route.ts`
- `apps/civitics/app/api/graph/treemap/route.ts`
- `apps/civitics/app/api/graph/treemap-pac/route.ts`

**Problem:**
`withDbTimeout` without a generic type parameter returns `unknown`, causing TypeScript to fail on destructuring `{ data, error }`. All other routes already have the fix applied — these are the remaining ones.

**Pattern to apply** (consistent with what's already fixed elsewhere in the codebase):
```ts
// Before (TypeScript error):
const { data, error } = await withDbTimeout(supabase.from("table").select("..."));

// After:
const { data, error } = await withDbTimeout<{
  data: RowType[] | null;
  error: { message: string } | null;
}>(supabase.from("table").select("..."));
```

For `.rpc()` calls, look at how `data` is immediately cast after the call (e.g. `as FlowRow[]`) — use that cast type as the generic:
```ts
const { data, error } = await withDbTimeout<{
  data: FlowRow[] | null;
  error: { message: string } | null;
}>(supabase.rpc("my_rpc"));
```

For count-only queries (`{ count: "exact", head: true }`), the pattern is:
```ts
const { count, error } = await withDbTimeout<{
  count: number | null;
  error: { message: string } | null;
}>(supabase.from("table").select("*", { count: "exact", head: true }));
```

For calls that also return `data` alongside `count`:
```ts
const { count, data } = await withDbTimeout<{
  count: number | null;
  data: RowType[] | null;
  error: { message: string } | null;
}>(query);
```

**Instructions:**
1. Read each file completely before editing
2. Find every `await withDbTimeout(` that does NOT have `<{` immediately after it
3. Look at how `data` is used in the lines immediately following to infer the correct row type
4. Add the appropriate generic type — if the row type is complex or unclear, use `// eslint-disable-next-line @typescript-eslint/no-explicit-any` and `any` as a fallback rather than guessing
5. Do not change any logic, only add the type parameter

**Acceptance criteria:**
- Zero bare `await withDbTimeout(` calls remain in any of the listed files (every call has `<{`)
- `pnpm build` passes
- No logic changes — diffs should show only type additions

---

### TASK-05 — Career history section on official detail pages

**Status:** `COMPLETE — merged 2026-04-13 (reviewed in commit e14cf061; CareerHistory.tsx in officials/components/)`
**Risk:** Low — new component added to existing page, no existing code modified except one import + JSX line
**Files to read first:**
- `apps/civitics/app/officials/[id]/page.tsx` (full file — understand layout and existing data fetching pattern)
- `supabase/migrations/0001_initial_schema.sql` (search for `career_history` — read the table definition)

**Background:**
The `career_history` table tracks an official's employment history with a `revolving_door_flag` for when they worked at an organization they previously regulated (or vice versa). This data exists in the DB but has no UI.

**career_history table schema:**
```sql
id              UUID
official_id     UUID NOT NULL REFERENCES officials(id)
organization    TEXT NOT NULL
role_title      TEXT
started_at      DATE
ended_at        DATE
is_government   BOOLEAN NOT NULL DEFAULT false
governing_body_id UUID REFERENCES governing_bodies(id)
revolving_door_flag BOOLEAN NOT NULL DEFAULT false
revolving_door_explanation TEXT
metadata        JSONB
created_at      TIMESTAMPTZ
```

**What to build:**

1. Fetch career history in `apps/civitics/app/officials/[id]/page.tsx` alongside existing data.
   Add to the existing parallel `Promise.all` data fetch (look at how votes, donors etc. are fetched — follow that pattern exactly):
   ```ts
   supabase
     .from("career_history")
     .select("id, organization, role_title, started_at, ended_at, is_government, revolving_door_flag, revolving_door_explanation")
     .eq("official_id", id)
     .order("started_at", { ascending: false })
     .limit(20)
   ```

2. Create a new component: `apps/civitics/app/officials/[id]/components/CareerHistory.tsx`
   - Server component (no `"use client"`) — data is passed in as props
   - Props: `items: CareerHistoryRow[]`
   - Show nothing (return null) if `items.length === 0`
   - Layout: a timeline list, one row per entry
   - Each row shows: `role_title` (or "Employee" if null) at `organization`, date range (`started_at` — `ended_at` or "Present" if null)
   - If `is_government`, show a small `GOV` badge in gray
   - If `revolving_door_flag`, show a `⚠ Revolving Door` badge in amber and display `revolving_door_explanation` below if it exists
   - Format dates as "Jan 2019" (month + year only), use `—` for missing dates

3. Add `<CareerHistory items={careerHistory} />` to the page in a logical position — after the AI profile section, before or after votes, wherever similar data sections are grouped.

**Type for the component:**
```ts
type CareerHistoryRow = {
  id: string;
  organization: string;
  role_title: string | null;
  started_at: string | null;
  ended_at: string | null;
  is_government: boolean;
  revolving_door_flag: boolean;
  revolving_door_explanation: string | null;
};
```

**Acceptance criteria:**
- Component renders on `/officials/[any-id]` without errors even when no career data exists
- Revolving door flag entries are visually distinct (amber)
- `pnpm build` passes clean

---

### TASK-06 — Promises section on official detail pages

**Status:** `COMPLETE — merged 2026-04-13 (reviewed in commit e14cf061; PromisesSection.tsx in officials/components/)`
**Risk:** Low — new component, no existing code modified except one import + JSX line
**Files to read first:**
- `apps/civitics/app/officials/[id]/page.tsx` (understand data fetch pattern — follow it exactly)
- `supabase/migrations/0001_initial_schema.sql` (search for `promise_status` and `promises`)

**Background:**
One of the platform's core features is holding officials accountable for their promises. The `promises` table exists and is populated by the pipeline. This section makes that data visible on official pages for the first time.

**promises table schema:**
```sql
id              UUID
official_id     UUID NOT NULL REFERENCES officials(id)
title           TEXT NOT NULL
description     TEXT
status          promise_status  -- 'made' | 'kept' | 'broken' | 'stalled' | 'partial'
made_at         DATE
deadline        DATE
resolved_at     DATE
source_url      TEXT
source_quote    TEXT
related_proposal_id UUID REFERENCES proposals(id)
metadata        JSONB
```

**What to build:**

1. Fetch promises in `apps/civitics/app/officials/[id]/page.tsx` alongside existing data:
   ```ts
   supabase
     .from("promises")
     .select("id, title, description, status, made_at, deadline, resolved_at, source_url, source_quote")
     .eq("official_id", id)
     .order("made_at", { ascending: false })
     .limit(10)
   ```

2. Create: `apps/civitics/app/officials/[id]/components/PromisesSection.tsx`
   - Server component — data passed as props
   - Props: `promises: PromiseRow[]`
   - Return null if `promises.length === 0`
   - Show a section heading "Promises" with a count badge
   - Each promise shows:
     - Title (bold)
     - Status badge with distinct colors:
       - `made` → gray ("Made")
       - `kept` → green ("Kept ✓")
       - `broken` → red ("Broken")
       - `stalled` → amber ("Stalled")
       - `partial` → orange ("Partial")
     - `made_at` date if present ("Made Jan 2022")
     - `deadline` date if present and status is `made` or `stalled` ("Due Mar 2024")
     - `source_quote` in a blockquote if present (truncate at 200 chars with "…")
     - A link to `source_url` labeled "Source →" if present
   - Summary row at the bottom: "X kept, Y broken, Z stalled" (only show counts > 0)

3. Add `<PromisesSection promises={promises} />` near the top of the main content, just below the basic info section — this is a flagship feature.

**Type:**
```ts
type PromiseRow = {
  id: string;
  title: string;
  description: string | null;
  status: 'made' | 'kept' | 'broken' | 'stalled' | 'partial';
  made_at: string | null;
  deadline: string | null;
  resolved_at: string | null;
  source_url: string | null;
  source_quote: string | null;
};
```

**Acceptance criteria:**
- Renders correctly when no promises exist (returns null, no empty state visible)
- All 5 status badges display correctly
- `pnpm build` passes clean

---

### TASK-07 — Position tracking widget on proposal detail pages

**Status:** `COMPLETE — merged 2026-04-13 (reviewed in commit e14cf061; PositionWidget.tsx in proposals/[id]/components/)`
**Risk:** Low-medium — new component + small API route; existing civic_comments table already has `position` column
**Files to read first:**
- `apps/civitics/app/proposals/[id]/page.tsx` (understand layout)
- `apps/civitics/app/proposals/[id]/components/CivicComments.tsx` (pattern reference for client component + fetch)
- `apps/civitics/app/api/proposals/[id]/comments/route.ts` (pattern reference for API route)
- `supabase/migrations/0001_initial_schema.sql` (search for `civic_comments` — read the full table definition)

**Background:**
`civic_comments` has a `position` column (`TEXT CHECK (position IN ('support', 'oppose', 'neutral', 'question'))`). Position tracking shows citizens' stance on proposals without requiring a full comment. It's separate from the comment text — you can set a position without writing anything.

**What to build:**

1. API route: `apps/civitics/app/api/proposals/[id]/position/route.ts`
   - `GET`: returns aggregated position counts for a proposal:
     ```ts
     // Response shape:
     { support: number; oppose: number; neutral: number; question: number; total: number }
     ```
     Query: `civic_comments` grouped by `position` where `proposal_id = params.id` AND `position IS NOT NULL` AND `is_deleted = false`
     Use `createServerClient(cookies())` for GET.
   - `POST`: `{ position: 'support' | 'oppose' | 'neutral' | 'question' }`
     Requires auth (same pattern as comments/route.ts POST — call `supabase.auth.getUser()`, return 401 if no user).
     If user already has a row with a position for this proposal, UPDATE it. Otherwise INSERT.
     Use `createAdminClient()`. Remember: `export const dynamic = "force-dynamic";` on the file.

2. Component: `apps/civitics/app/proposals/[id]/components/PositionWidget.tsx`
   - `"use client"`
   - Props: `proposalId: string`
   - Fetches counts from GET on mount
   - Shows 4 buttons: Support / Oppose / Neutral / Question
   - Each button shows its count and a visual indicator (color):
     - Support → green (`bg-green-50 border-green-200 text-green-700`)
     - Oppose → red (`bg-red-50 border-red-200 text-red-700`)
     - Neutral → gray
     - Question → amber
   - Clicking a button calls POST with that position, then re-fetches counts
   - If POST returns 401, show "Sign in to record your position" message (same pattern as CivicComments)
   - Loading state: disabled buttons during fetch/post
   - Layout: horizontal row of 4 buttons, compact — this sits above the main comment form

3. Add `<PositionWidget proposalId={p.id} />` to `apps/civitics/app/proposals/[id]/page.tsx` just above `<CivicComments proposalId={p.id} />`.

**Grouping query for GET** (do this in JS after fetching, not a raw SQL GROUP BY — simpler for a Supabase client):
```ts
const { data } = await supabase
  .from("civic_comments")
  .select("position")
  .eq("proposal_id", params.id)
  .eq("is_deleted", false)
  .not("position", "is", null);

const counts = { support: 0, oppose: 0, neutral: 0, question: 0, total: 0 };
for (const row of data ?? []) {
  if (row.position in counts) counts[row.position as keyof typeof counts]++;
  counts.total++;
}
```

**Acceptance criteria:**
- 4 position buttons render on every proposal page
- Clicking one updates counts without page refresh
- 401 case handled gracefully
- `pnpm build` passes

---

### TASK-08 — Fix agency page: proposal counts use placeholder filter, not real agency ID

**Status:** `COMPLETE — merged 2026-04-13 (reviewed in commit e14cf061)`
**Risk:** Medium — changes existing data query logic; read the file carefully before editing
**Files to read first:**
- `apps/civitics/app/agencies/[slug]/page.tsx` (read the FULL file — especially the data fetch section)
- `supabase/migrations/0001_initial_schema.sql` (search for `agencies` table definition to understand `id`, `slug`, `acronym` columns)

**Problem:**
In `apps/civitics/app/agencies/[slug]/page.tsx`, the proposal queries filter on `metadata->>agency_id` matching the URL slug string. This is labeled `// placeholder` in two places. The correct approach is to use the agency's actual `id` (UUID) for the join.

Looking at the file, the agency row is fetched first (`.eq("slug", slug)`) and stored in `agency`. Its `id` is available. The proposal and count queries should filter using `metadata->>agency_id` matching `agency.id` (the UUID string), not the slug.

**Fix:**
After the agency row is fetched, replace the slug-based proposal queries with `agency.id`-based ones. The `metadata->>agency_id` column stores the agency UUID as a string in JSONB.

Change both placeholder queries:
```ts
// Before:
.filter("metadata->>agency_id", "eq", slug)

// After (use the actual agency UUID):
.filter("metadata->>agency_id", "eq", agency.id)
```

There are 4 occurrences: the active rulemaking query, the recent closed rules query, the total proposal count query, and the open comment count query. Fix all 4.

**Important:** The fetch is currently structured as a `Promise.all` where agency is fetched alongside proposals. You'll need to restructure so the agency fetch happens first, and then the proposal queries use `agency.id`. If `notFound()` is called when agency is missing, the proposal queries should never run with a bad ID.

Look at the existing structure in the file to understand exactly how to refactor the two-step fetch. Don't over-engineer it — a simple sequential fetch (agency first, then proposals) is fine.

**Acceptance criteria:**
- No `// placeholder` comments remain in the file related to agency_id filtering
- The proposal counts on `/agencies/[slug]` reflect real data for that agency's UUID
- If the agency does not exist, `notFound()` is still called correctly
- `pnpm build` passes

---

### TASK-09 — Official detail page: add spending records section

**Status:** `COMPLETE — merged 2026-04-13 (reviewed in commit e14cf061; SpendingSection.tsx in officials/components/)`
**Risk:** Low — new component, data already fetched on the page
**Files to read first:**
- `apps/civitics/app/officials/[id]/page.tsx` (check if `spending_records` is already fetched — search for "spending" in the file)
- `supabase/migrations/0001_initial_schema.sql` (search for `spending_records`)

**Background:**
`spending_records` contains USASpending.gov contract/grant data. Showing it on official pages connects officials to the government money they control or award. This is high-value accountability data.

**spending_records schema:**
```sql
id                UUID
jurisdiction_id   UUID NOT NULL REFERENCES jurisdictions(id)
awarding_agency   TEXT NOT NULL
recipient_name    TEXT NOT NULL
award_type        TEXT   -- 'contract' | 'grant' | 'loan' | 'other'
amount_cents      BIGINT NOT NULL
award_date        DATE
description       TEXT
metadata          JSONB
```

**What to build:**

First check: does `apps/civitics/app/officials/[id]/page.tsx` already fetch spending records? Search the file for "spending". If it does, just add the display component. If it doesn't, add the fetch.

Fetch (add to the page's data fetch if not already present):
```ts
supabase
  .from("spending_records")
  .select("id, recipient_name, award_type, amount_cents, award_date, description, awarding_agency")
  .eq("jurisdiction_id", official.jurisdiction_id)  // spending tied to official's jurisdiction
  .order("amount_cents", { ascending: false })
  .limit(10)
```

Note: spending records are jurisdiction-level, not directly tied to an official's ID. Use `official.jurisdiction_id` as the filter. If `official.jurisdiction_id` is null, skip the query and return an empty array.

Create: `apps/civitics/app/officials/[id]/components/SpendingSection.tsx`
- Server component (no `"use client"`)
- Props: `items: SpendingRow[]`
- Return null if `items.length === 0`
- Section heading: "Government Spending" with total amount displayed
- Table with columns: Recipient | Type | Amount | Date
- Format amounts using the existing `formatMoney` helper (import from the parent page, or re-implement it inline if the import is awkward)
- Award type badge: contract = gray, grant = green, loan = amber, other = gray
- Link to `awarding_agency` is not needed — just display the text

**Type:**
```ts
type SpendingRow = {
  id: string;
  recipient_name: string;
  award_type: string | null;
  amount_cents: number;
  award_date: string | null;
  description: string | null;
  awarding_agency: string;
};
```

Add `<SpendingSection items={spendingRecords} />` near the bottom of the official detail page.

**Acceptance criteria:**
- Section is invisible when no spending data exists for the jurisdiction
- Money formatting matches the rest of the page (uses same `formatMoney` logic)
- `pnpm build` passes

---

### TASK-11 — Civic Initiatives: DB migration (Sprint 1)

**Status:** `COMPLETE — merged 2026-04-11 (migration in supabase/migrations/20260411010026_civic_initiatives.sql)`
**Risk:** Low — new tables only, nothing existing is modified or dropped
**Files to read first:**
- `supabase/migrations/0009_users_table.sql` (users table schema — FK target)
- `supabase/migrations/0001_initial_schema.sql` (search for `civic_comments` — use as RLS pattern reference)
- `docs/archive/CIVIC_INITIATIVES.md` (feature overview and data model spec)

**Background:**
Civic Initiatives is a new Phase 2 feature: a lifecycle-based community platform where citizens draft proposals, gather signatures, and hold officials publicly accountable. This task creates the three core tables that underpin the entire feature. All subsequent Civic Initiatives tasks depend on this migration being applied first.

**What to build:**
Create `supabase/migrations/0033_civic_initiatives.sql` with the following three tables, indexes, and RLS policies.

**Table 1 — `civic_initiatives`:**
```sql
CREATE TYPE initiative_stage AS ENUM ('draft', 'deliberate', 'mobilise', 'resolved');
CREATE TYPE initiative_authorship AS ENUM ('individual', 'community');
CREATE TYPE initiative_scope AS ENUM ('federal', 'state', 'local');
CREATE TYPE initiative_resolution AS ENUM ('sponsored', 'declined', 'withdrawn', 'expired');

CREATE TABLE IF NOT EXISTS civic_initiatives (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 TEXT NOT NULL CHECK (char_length(title) BETWEEN 10 AND 120),
  summary               TEXT CHECK (char_length(summary) <= 500),
  body_md               TEXT NOT NULL,
  stage                 initiative_stage NOT NULL DEFAULT 'draft',
  authorship_type       initiative_authorship NOT NULL DEFAULT 'individual',
  primary_author_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_proposal_id    UUID REFERENCES proposals(id) ON DELETE SET NULL,
  scope                 initiative_scope NOT NULL DEFAULT 'federal',
  target_district       TEXT,            -- coarsened to district level, never precise geo
  issue_area_tags       TEXT[] NOT NULL DEFAULT '{}',
  quality_gate_score    JSONB NOT NULL DEFAULT '{}',
  mobilise_started_at   TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  resolution_type       initiative_resolution,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS civic_initiatives_stage ON civic_initiatives(stage);
CREATE INDEX IF NOT EXISTS civic_initiatives_author ON civic_initiatives(primary_author_id);
CREATE INDEX IF NOT EXISTS civic_initiatives_proposal ON civic_initiatives(linked_proposal_id);
CREATE INDEX IF NOT EXISTS civic_initiatives_scope ON civic_initiatives(scope);
CREATE INDEX IF NOT EXISTS civic_initiatives_tags ON civic_initiatives USING GIN(issue_area_tags);
```

**Table 2 — `civic_initiative_signatures`:**
```sql
CREATE TYPE signature_verification AS ENUM ('unverified', 'email', 'district');

CREATE TABLE IF NOT EXISTS civic_initiative_signatures (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id     UUID NOT NULL REFERENCES civic_initiatives(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verification_tier signature_verification NOT NULL DEFAULT 'unverified',
  district          TEXT,   -- coarsened, never precise coordinates
  signed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(initiative_id, user_id)  -- one signature per user per initiative
);

CREATE INDEX IF NOT EXISTS civic_sigs_initiative ON civic_initiative_signatures(initiative_id);
CREATE INDEX IF NOT EXISTS civic_sigs_user ON civic_initiative_signatures(user_id);
CREATE INDEX IF NOT EXISTS civic_sigs_district ON civic_initiative_signatures(initiative_id, district);
```

**Table 3 — `civic_initiative_responses`:**
```sql
CREATE TYPE official_response_type AS ENUM ('support', 'oppose', 'pledge', 'refer', 'no_response');

CREATE TABLE IF NOT EXISTS civic_initiative_responses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id         UUID NOT NULL REFERENCES civic_initiatives(id) ON DELETE CASCADE,
  official_id           UUID NOT NULL REFERENCES officials(id) ON DELETE CASCADE,
  response_type         official_response_type NOT NULL DEFAULT 'no_response',
  body_text             TEXT,
  committee_referred    TEXT,
  window_opened_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_closes_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  responded_at          TIMESTAMPTZ,
  is_verified_staff     BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(initiative_id, official_id)  -- one response record per official per initiative
);

CREATE INDEX IF NOT EXISTS civic_responses_initiative ON civic_initiative_responses(initiative_id);
CREATE INDEX IF NOT EXISTS civic_responses_official ON civic_initiative_responses(official_id);
CREATE INDEX IF NOT EXISTS civic_responses_type ON civic_initiative_responses(response_type);
```

**RLS Policies:**
Follow the same pattern as `civic_comments` in `0001_initial_schema.sql`. Apply:
- `civic_initiatives`: SELECT open to all (anon + authenticated). INSERT/UPDATE restricted to authenticated users where `primary_author_id = auth.uid()`. DELETE not permitted.
- `civic_initiative_signatures`: SELECT open to all. INSERT restricted to authenticated users where `user_id = auth.uid()`. DELETE allowed for own rows only (`user_id = auth.uid()`).
- `civic_initiative_responses`: SELECT open to all. INSERT/UPDATE restricted to authenticated users (staff verification handled at API layer, not RLS). DELETE not permitted.

Enable RLS on all three tables: `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`

**Trigger for `updated_at`:**
Add a trigger on `civic_initiatives` to auto-update `updated_at` on row modification. Use the same trigger function pattern already used in the codebase (search for `set_updated_at` or similar in `0001_initial_schema.sql` — reuse it, don't redefine it).

**Important:**
- Use `supabase migration new civic_initiatives --local` to create the file — this generates the correct timestamp prefix automatically. Then populate the generated file with the SQL above rather than manually creating `0033_`.
- Apply with `supabase migration up --local` — never against production.
- Do NOT run `DROP` or `TRUNCATE` on anything.

**Acceptance criteria:**
- `supabase migration up --local` applies cleanly with no errors
- All three tables visible in local Studio at `http://127.0.0.1:54323`
- RLS enabled on all three tables
- `pnpm build` still passes (migration doesn't touch TypeScript)

---

### TASK-12 — Civic Initiatives: core API routes (Sprint 1)

**Status:** `COMPLETE — merged 2026-04-13 (was already implemented in earlier sprint work; verified route files exist)`
**Risk:** Low-Medium — new routes only, no existing files modified
**Files to read first:**
- `apps/civitics/app/api/proposals/[id]/comments/route.ts` (auth + admin client pattern)
- `apps/civitics/app/api/proposals/route.ts` (list pagination pattern)
- `supabase/migrations/0033_civic_initiatives.sql` (exact column names — authoritative)
- `docs/archive/CIVIC_INITIATIVES.md` (feature overview)

**Background:**
Sprint 1 API layer for Civic Initiatives. Five routes covering list, detail, create, sign, and signature count. No UI yet — these routes are the foundation that the list and detail pages (Sprint 3) will consume.

**What to build:**

Create the following route files. Read the comments/route.ts and proposals/route.ts patterns first — match the error handling, dynamic export, and client usage exactly.

---

**Route 1 — `apps/civitics/app/api/initiatives/route.ts`**

`GET /api/initiatives` — paginated list of initiatives.

Query params: `stage` (filter by stage enum), `scope` (federal/state/local), `tag` (filter by issue_area_tags contains), `page` (default 1), `limit` (default 20, max 50).

```ts
export const dynamic = "force-dynamic";
// Use createServerClient(cookies()) — respects RLS, anon can read
// Response: { initiatives: InitiativeRow[], total: number, page: number }
// Order by: mobilise_started_at DESC NULLS LAST, created_at DESC
// Columns to return: id, title, summary, stage, scope, authorship_type, issue_area_tags,
//                    target_district, mobilise_started_at, created_at, resolved_at
// For tag filter: .contains('issue_area_tags', [tag])
```

`POST /api/initiatives` — create a new initiative.

Requires auth: call `supabase.auth.getUser()`, return 401 if no user.
Body: `{ title: string; summary?: string; body_md: string; scope: string; issue_area_tags?: string[]; linked_proposal_id?: string }`
Insert with `primary_author_id = user.id`, `stage = 'draft'`, `authorship_type = 'individual'`.
Use `createAdminClient()` for the insert.

```ts
// Response on success: { initiative: { id, title, stage } } with status 201
// Validate: title 10–120 chars, body_md non-empty, scope is valid enum value
// Return 400 with { error: string } for validation failures
```

---

**Route 2 — `apps/civitics/app/api/initiatives/[id]/route.ts`**

`GET /api/initiatives/[id]` — full initiative detail.

```ts
export const dynamic = "force-dynamic";
// Use createServerClient(cookies())
// Select all columns from civic_initiatives where id = params.id
// Also fetch signature counts in parallel:
//   total_signatures: count(*) from civic_initiative_signatures where initiative_id = id
//   constituent_verified: count(*) where initiative_id = id AND verification_tier = 'district'
// Also fetch official responses: select * from civic_initiative_responses where initiative_id = id
// Return 404 if initiative not found
// Response: { initiative: InitiativeDetail, signature_counts: { total, constituent_verified }, responses: ResponseRow[] }
```

---

**Route 3 — `apps/civitics/app/api/initiatives/[id]/sign/route.ts`**

`POST /api/initiatives/[id]/sign` — add or remove a signature.

```ts
export const dynamic = "force-dynamic";
// Requires auth — return 401 if no user
// Check if user already signed (SELECT from civic_initiative_signatures where initiative_id = id AND user_id = user.id)
// If already signed: DELETE the row (unsign). Return { signed: false }
// If not signed: INSERT. verification_tier defaults to 'unverified' (district verification Phase 2).
// Return { signed: true }
// Use createAdminClient() for read + write (need to bypass RLS for the upsert pattern)
// Return 404 if initiative not found or stage is 'draft' (can only sign mobilise-stage initiatives)
// Return 400 if initiative is 'resolved'
```

---

**Route 4 — `apps/civitics/app/api/initiatives/[id]/signature-count/route.ts`**

`GET /api/initiatives/[id]/signature-count` — lightweight count endpoint for client-side polling.

```ts
export const dynamic = "force-dynamic";
// Use createServerClient(cookies())
// Returns: { total: number, constituent_verified: number }
// Uses count queries with head: true for efficiency — do NOT select all rows
```

---

**TypeScript types** (define at top of each file that needs them, no shared types file yet):

```ts
type InitiativeRow = {
  id: string;
  title: string;
  summary: string | null;
  stage: 'draft' | 'deliberate' | 'mobilise' | 'resolved';
  scope: 'federal' | 'state' | 'local';
  authorship_type: 'individual' | 'community';
  issue_area_tags: string[];
  target_district: string | null;
  mobilise_started_at: string | null;
  created_at: string;
  resolved_at: string | null;
};

type ResponseRow = {
  id: string;
  official_id: string;
  response_type: 'support' | 'oppose' | 'pledge' | 'refer' | 'no_response';
  body_text: string | null;
  committee_referred: string | null;
  window_opens_at: string;
  window_closes_at: string;
  responded_at: string | null;
};
```

**Important:**
- Every route file must have `export const dynamic = "force-dynamic";` — all use `createAdminClient()` or `cookies()`
- For the sign route: the initiative must be in `mobilise` stage to accept signatures. Return a clear 400 error otherwise — "This initiative is not currently accepting signatures."
- Do NOT use `.in()` for any array queries — not applicable here but mentioned for completeness
- The `[id]` in route paths is the `params.id` — destructure from the second argument: `({ params }: { params: { id: string } })`

**Acceptance criteria:**
- `GET /api/initiatives` returns 200 with `{ initiatives: [], total: 0, page: 1 }` when no initiatives exist
- `POST /api/initiatives` returns 401 without auth, 400 with invalid body, 201 with valid body
- `GET /api/initiatives/[id]` returns 404 for unknown ID, 200 with full detail for valid ID
- `POST /api/initiatives/[id]/sign` toggles signature correctly (sign → unsign → sign)
- `GET /api/initiatives/[id]/signature-count` returns `{ total: N, constituent_verified: N }`
- `pnpm build` passes clean
- No stray `console.log` in production paths

---

### TASK-10 — Sunburst re-render bug: shape and showLabels settings don't apply without refetch

**Status:** `COMPLETE — merged 2026-04-13 (reviewed in commit e14cf061)`
**Risk:** Medium — touches SunburstGraph component logic; read carefully
**Files to read first:**
- `packages/graph/src/SunburstGraph.tsx` (full file — understand data flow and render cycle)
- `packages/graph/src/components/GraphConfigPanel.tsx` (find the shape and showLabels settings)

**Background:**
`shape` (arc vs. pie) and `showLabels` are viz options stored in `vizOptions`. When these are changed in the settings panel, they should cause an immediate visual re-render of the existing data — they do not require a new API fetch. The bug is that changing these settings does NOT re-render the sunburst.

The likely cause: the D3 rendering code inside `SunburstGraph.tsx` runs in a `useEffect` that either (a) doesn't list `shape` and `showLabels` in its dependency array, or (b) lists them correctly but also has data-fetch logic that only runs when entity/group IDs change, and the two concerns are entangled in one effect.

**Fix:**
1. Read the file and identify where `shape` and `showLabels` are read from `vizOptions`.
2. Find the `useEffect` (or effects) responsible for D3 rendering.
3. If `shape` and `showLabels` are not in the render effect's dependency array, add them.
4. If the render effect is entangled with the data fetch (i.e., the same effect both fetches data AND renders D3), split it into two effects:
   - Effect 1: fetches data when `entityId`, `primaryGroup?.id`, `ring1`, `ring2`, etc. change
   - Effect 2: renders/re-renders D3 when `data` OR `shape` OR `showLabels` change
5. Do NOT add object dependencies to useEffect — use primitives (`primaryGroup?.id` not `primaryGroup`).

**Key check before splitting effects:** look at whether the D3 render reads directly from `data` state, or whether it re-fetches data. If it re-fetches, splitting effects is the fix. If it already reads from state and the re-render just doesn't fire, adding `shape` and `showLabels` to deps is the fix.

Leave a `// TODO(review): split confirmed — was one entangled effect` or similar comment so Claude knows which path was taken.

**Acceptance criteria:**
- Changing `shape` setting re-renders the sunburst immediately without a new API call
- Changing `showLabels` toggles labels immediately
- No infinite re-render loops (check browser console)
- `pnpm build` passes

---

---

### TASK-22 — Share button on proposal detail page and cards

**Status:** `COMPLETE — merged 2026-04-15 (commit 410f08c9; implemented by Claude)`
**Risk:** Low — new component, two JSX additions, no existing logic changed
**Files to read first:**
- `apps/civitics/app/officials/components/ShareButton.tsx` (copy this pattern exactly — it's the existing share button for officials; adapt for proposals)
- `apps/civitics/app/proposals/[id]/page.tsx` (understand header layout — share button goes in the meta row section, roughly line 272–300)
- `apps/civitics/app/proposals/components/ProposalCard.tsx` (understand card footer — share button goes at the bottom of the card actions row)

**Background:**
Officials profile pages already have a `ShareButton` component (copy-to-clipboard / Web Share API). The same affordance is missing from proposal detail pages and proposal cards. These are high-value sharing points — users discover a bill they care about and want to forward it.

**What to build:**

1. Create `apps/civitics/app/proposals/components/ProposalShareButton.tsx`
   - `"use client"` — uses clipboard/navigator.share
   - Props: `title: string; id: string`
   - Shares URL `/proposals/${id}`
   - Copy the officials `ShareButton.tsx` pattern exactly, adapting the text:
     - `navigator.share` call: `title: "${title} | Civitics"`, `text: "Read about this proposal on Civitics"`, `url: fullUrl`
     - Button label: `"↗ Share"` / `"✓ Copied"` (same as officials)
   - Keep the same Tailwind classes as the officials `ShareButton.tsx`

2. Add `<ProposalShareButton title={p.title} id={p.id} />` to `apps/civitics/app/proposals/[id]/page.tsx`.
   - Import it at the top of the file.
   - Place it inside the header block, in the meta row div (the `flex flex-wrap items-center gap-4` div around line 273), after the existing external links but before the closing `</div>`.

3. Add an inline `ShareButton` to `apps/civitics/app/proposals/components/ProposalCard.tsx`.
   - Read the card file to find the footer/action area (where `SubmitCommentButton` appears).
   - Add a small share button next to the existing action elements. Implement it inline as a small client-side button rather than importing a separate component (the card is already a server component — do NOT add `"use client"` to the card itself).
   - Instead: add a `<ProposalShareButton />` import and render it in the card footer. Since `ProposalCard.tsx` is a server component, adding a client child is fine — Next.js handles this.
   - If `ProposalCard.tsx` has a footer actions row with `SubmitCommentButton`, place `ProposalShareButton` on the same row.

**Important:**
- Do NOT add `"use client"` to `ProposalCard.tsx` or `proposals/[id]/page.tsx` — they are server components
- `ProposalShareButton` is already a client component, so it can be imported into server components safely
- The button should be small and unobtrusive — use the same style as the officials `ShareButton.tsx`

**Acceptance criteria:**
- Share button appears on `/proposals/[id]` in the header area
- Share button appears on each proposal card in `/proposals` list
- Clicking copies the proposal URL or opens native share sheet (mobile)
- `pnpm build` passes clean

---

### TASK-23 — Community commenting on Official detail pages

**Status:** `COMPLETE — merged 2026-04-15 (commit 410f08c9; implemented by Claude; requires migration 20260415223406 applied locally)`
**Risk:** Low-Medium — new component + new API route, adapting existing pattern; does not modify `CivicComments.tsx` or any existing route
**Files to read first:**
- `apps/civitics/app/proposals/[id]/components/CivicComments.tsx` (copy this pattern — adapt entity type)
- `apps/civitics/app/api/proposals/[id]/comments/route.ts` (copy this pattern — adapt for officials)
- `apps/civitics/app/officials/[id]/page.tsx` (understand page structure; `SpendingSection` is at the bottom around line 929 — add comments below it)
- `supabase/migrations/0001_initial_schema.sql` (search for `civic_comments` — read the full table definition to get exact column names)

**Background:**
`civic_comments` is an entity-agnostic table with `entity_type TEXT` and `entity_id UUID` columns. Proposal pages already have a `CivicComments` component. Officials lack an equivalent. Adding community discussion to official pages completes the Phase 1 civic engagement layer.

**civic_comments relevant columns (verified from migration):**
```
entity_type   TEXT   — use 'official'
entity_id     UUID   — the official's id
user_id       UUID   (nullable)
display_name  TEXT   (nullable)
text          TEXT
created_at    TIMESTAMPTZ
is_deleted    BOOLEAN DEFAULT false
```

**What to build:**

1. New API route: `apps/civitics/app/api/officials/[id]/comments/route.ts`
   - Copy `apps/civitics/app/api/proposals/[id]/comments/route.ts` exactly.
   - Change `entity_type` from `'proposal'` to `'official'`.
   - Change `proposal_id` references to `official_id` (or simply use `entity_id = params.id` — check how the proposals route uses it and match).
   - `export const dynamic = "force-dynamic";`
   - GET: return comments for `entity_type = 'official'` and `entity_id = params.id`, ordered by `created_at DESC`, limit 50.
   - POST: insert with `entity_type = 'official'`, `entity_id = params.id`.

2. New component: `apps/civitics/app/officials/[id]/components/OfficialComments.tsx`
   - Copy `apps/civitics/app/proposals/[id]/components/CivicComments.tsx` exactly.
   - Change the fetch URL from `/api/proposals/${proposalId}/comments` to `/api/officials/${officialId}/comments`.
   - Change the prop from `proposalId: string` to `officialId: string`.
   - Change the empty state text: `"Be the first to comment on this official."` (instead of "proposal").
   - Change the placeholder text in the textarea: `"Share a thought about this official's record…"`.
   - Keep all other logic identical.

3. Add `<OfficialComments officialId={official.id} />` to `apps/civitics/app/officials/[id]/page.tsx`.
   - Import the component at the top of the file.
   - Place it after `<SpendingSection items={spendingRecords} />` (around line 929) — at the very bottom of the main content area, before the closing `</div>` wrappers.

**Important:**
- Do NOT modify `CivicComments.tsx` or the proposals comments route — create new files only
- The route file for officials: the `params` destructure should be `({ params }: { params: { id: string } })` — same as proposals route
- Check the proposals comments route for the exact `is_deleted` filter and `order` clause — match them exactly

**Acceptance criteria:**
- Comment section renders on `/officials/[any-id]` without errors
- Can post a comment and see it appear without page refresh
- GET/POST API routes return correct data for `entity_type = 'official'`
- No changes to any existing file (proposals route, CivicComments.tsx) — only additions
- `pnpm build` passes clean

---

### TASK-24 — Custom 404 and error pages

**Status:** `COMPLETE — merged 2026-04-15 (commit 410f08c9; implemented by Claude)`
**Risk:** Low — new files only, no existing code touched
**Files to read first:**
- `apps/civitics/app/layout.tsx` (read the root layout to understand the wrapping HTML/body structure and any fonts/globals used — not-found.tsx and error.tsx inherit from it)
- `apps/civitics/app/loading.tsx` or any existing loading.tsx (use as style reference for how these root-level files are structured)

**Background:**
Next.js App Router uses `not-found.tsx` (for `notFound()` calls and 404s) and `error.tsx` (for runtime errors) as special file conventions. Neither exists yet. Users hitting dead links or server errors currently see the default Next.js error screen. Both should be branded, helpful pages.

**What to build:**

1. `apps/civitics/app/not-found.tsx` — 404 page
   - Static server component (no `"use client"`)
   - Headline: "Page not found"
   - Subtext: "The page you're looking for doesn't exist or has been moved."
   - Four quick-link cards (simple bordered links): Officials (`/officials`), Proposals (`/proposals`), Agencies (`/agencies`), Civic Initiatives (`/initiatives`)
   - A link to go back: `<a href="/">← Back to Civitics</a>`
   - Style: centered, clean white card on gray-50 background, consistent with the rest of the app (use Tailwind only)
   - Include a large "404" number in light gray as a visual element
   - No imports from packages that might fail at build time — plain HTML + Tailwind classes only

2. `apps/civitics/app/error.tsx` — runtime error boundary
   - **Must be `"use client"`** — Next.js requires error boundaries to be client components
   - Props: `{ error: Error & { digest?: string }; reset: () => void }`
   - Headline: "Something went wrong"
   - Subtext: "An unexpected error occurred. Try refreshing the page."
   - Two buttons:
     - "Try again" — calls `reset()` (the prop provided by Next.js)
     - "Go home" — `<a href="/">Go home</a>`
   - Show `error.digest` in a small gray monospace span if it exists: "Error code: {error.digest}"
   - Same visual style as the 404 page (centered, white card on gray-50)
   - Do NOT show `error.message` — it may expose stack traces in production

**Styling reference** (match the app's existing aesthetic):
```tsx
// Both pages: outer wrapper
<div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
  <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
    {/* content */}
  </div>
</div>
```

**Important:**
- `error.tsx` MUST have `"use client"` at the top — this is a Next.js hard requirement for error boundaries
- `not-found.tsx` must NOT have `"use client"` — it's a server component
- Do NOT import `NavBar` or any component that fetches data — these pages render when the rest of the app may be broken
- The quick-link cards in `not-found.tsx` should be plain `<a>` tags (not `<Link>` from next/link), to minimize dependency surface

**Acceptance criteria:**
- Navigating to a non-existent URL (e.g. `/does-not-exist`) renders the custom 404 page with the four quick-link cards
- `not-found.tsx` has no `"use client"` directive
- `error.tsx` has `"use client"` as its first line
- `pnpm build` passes clean

---

## Completed

*(Move tasks here after Claude reviews and merges)*

---

## Template — Adding New Tasks

```markdown
### TASK-13 — Fix graph config dropdowns: selected option not shown (blank select)

**Status:** `COMPLETE — reviewed 2026-04-12`
**Risk:** Low — single-line CSS addition to one helper component
**Files to read first:**
- `packages/graph/src/components/GraphConfigPanel.tsx` (read `LabeledSelect` function, ~lines 62–79)

**Background:**
The graph config panel has a `LabeledSelect` helper component used for Layout, Node Size, Color By, Labels, and all equivalent settings across Force/Chord/Treemap/Sunburst panels. The selected option is never visible — the select appears blank while inactive and shows no label after selection.

**Problem:**
`LabeledSelect` renders a native `<select>` with `bg-white` background but no explicit text color. The config panel ancestors set `text-gray-500` on labels, which the native `<select>` inherits via CSS `color` cascading. Gray-500 text on a white background is nearly invisible, making the selected option unreadable.

**Fix:**
In the `LabeledSelect` function (around line 73), add `text-gray-900` to the `<select>` className so it always renders with explicit dark text regardless of parent color inheritance:

```tsx
// Before:
className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-indigo-400"

// After:
className="flex-1 text-xs text-gray-900 border border-gray-200 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:border-indigo-400"
```

That's the only change. One class, one file.

**Acceptance criteria:**
- Layout, Node Size, Color By, Labels, Ring 1, Ring 2, and all other LabeledSelect dropdowns show their currently selected option text when collapsed
- `pnpm build` passes clean

---

### TASK-14 — Fix InlineEditor layout collision on initiative detail page

**Status:** `COMPLETE — reviewed 2026-04-12 (truncation fixed by Claude)`
**Risk:** Low-Medium — layout change in one page and one component
**Files to read first:**
- `apps/civitics/app/initiatives/[id]/page.tsx` (read the title section, ~lines 230–248)
- `apps/civitics/app/initiatives/[id]/components/InlineEditor.tsx` (read the full file — it's ~210 lines)

**Background:**
Initiative detail pages show an "Edit" button in the top-right of the title row for authors. When clicked, the InlineEditor expands into a full editing form (title, summary, body, scope, tags). The expanded form collides with the title and "Support" / "Details" sidebar boxes because it renders inside a `flex-shrink-0` div within the `justify-between` title row.

**Problem:**
In `page.tsx` the structure is:
```tsx
<div className="flex items-start justify-between gap-3">
  <h1 className="text-2xl font-bold ...">{initiative.title}</h1>
  <div className="flex-shrink-0 pt-0.5">     {/* ← edit button lives here */}
    <InlineEditor ... />
  </div>
</div>
```
When `editing = true`, InlineEditor renders a tall form (`space-y-5 p-5`) inside the `flex-shrink-0` column. This overlaps the `<h1>` and bleeds into the sidebar.

**Fix:**
Change InlineEditor to render the expanded form as an absolutely-positioned overlay that escapes the flex container:

1. In `page.tsx`, add `relative` to the `flex-shrink-0` wrapper div:
```tsx
<div className="relative flex-shrink-0 pt-0.5">
  <InlineEditor ... />
</div>
```

2. In `InlineEditor.tsx`, when `editing = true`, change the form's outer `className` from:
```tsx
className="mt-4 space-y-5 rounded-xl border border-indigo-200 bg-indigo-50 p-5"
```
to:
```tsx
className="absolute right-0 top-8 z-20 w-[min(560px,calc(100vw-2rem))] space-y-5 rounded-xl border border-indigo-200 bg-white shadow-xl p-5"
```
Key changes: `absolute right-0 top-8` (anchor below the Edit button), `z-20` (float above sidebar), `w-[min(560px,...)]` (bounded width), `bg-white shadow-xl` (card appearance instead of nested feel), remove `mt-4` (no longer needed with absolute positioning).

3. Remove the `mt-4` class from the original since the form is now absolutely positioned.

Do NOT lift editing state into the page or split InlineEditor into multiple components — the absolute positioning approach requires the fewest changes and keeps the component self-contained.

**Acceptance criteria:**
- Clicking "Edit" on a draft or deliberating initiative opens the edit form as a floating card anchored below the Edit button, not colliding with the title text or the sidebar
- The form is scrollable if the viewport is short (existing form height is fine — no changes to form internals)
- "Cancel" still closes the form correctly
- `pnpm build` passes clean

---

### TASK-15 — Fix ForceGraph: nodes render UUID labels instead of entity names

**Status:** `COMPLETE — reviewed 2026-04-12`
**Risk:** Medium — modifies D3 rendering in the core ForceGraph component
**Files to read first:**
- `packages/graph/src/ForceGraph.tsx` (read the full file — focus on the D3 `useEffect` starting around line 107)
- `packages/graph/src/types.ts` (search for `GraphNode` and `OldGraphNode` type definitions)

**Background:**
The graph node label displayed below each shape should be the entity's name (e.g. "Elizabeth Warren", "EXELON CORP"). Instead it shows raw UUIDs. The V2 field contract specifies that graph nodes use a `name` field — not `label`. `ForceGraph.tsx` was never updated to match this contract.

**Problem:**
Throughout the D3 rendering code in `ForceGraph.tsx`, nodes are cast to `{ label: string }` and accessed as `.label`. When `.label` is undefined (because the actual field is `.name`), the code falls back to `d.id` — which is a UUID. Examples from the current code:

```ts
// line 73:
name: (d as unknown as { label: string }).label ?? d.id,

// lines 261, 277, 298, 312, 326, 342, 357 — all look like this:
.text(initials((d as unknown as { label: string }).label ?? d.id));
.text(truncate((d as unknown as { label: string }).label ?? "", 11));
```

**Fix:**
Do a targeted find-and-replace of the type cast and field access throughout the D3 `useEffect` in `ForceGraph.tsx`. Every occurrence of `(d as unknown as { label: string }).label` should become `(d as unknown as { name: string }).name`. Update the type annotation from `{ label: string }` to `{ name: string }` in every cast.

Specific line-by-line changes:
- Line 73: `name: (d as unknown as { label: string }).label ?? d.id` → `name: (d as unknown as { name: string }).name ?? d.id`
- Every `.text(initials(...label...))` → `.text(initials(...name...))`
- Every `.text(truncate(...label...))` → `.text(truncate(...name...))`
- The node label text line (~line 357): `.text(truncate((d as unknown as { label: string }).label ?? "", 22))` → `.text(truncate((d as unknown as { name: string }).name ?? "", 22))`

**IMPORTANT:** Do NOT change any local variable named `label` that is used for positioning (e.g. `const labelY` on ~line 346) or SVG class names (e.g. `.attr("class", "node-label")`). Only change the `(d as unknown as { label })` field access casts.

Do NOT change the `initials()` function parameter name (line 50) — that function takes any string, the variable is just named `label` internally. Only change the places where it's called with `d.label` data.

After the changes, do a final search: `grep -n '\.label' packages/graph/src/ForceGraph.tsx` and confirm no remaining `.label` field accesses on node data remain (only CSS class names and local variable names are OK to keep).

**Acceptance criteria:**
- Graph nodes display the entity's name (e.g. "Elizabeth Warren", "EXELON CORP") below each shape, not a UUID string
- Initials inside node shapes also show correct letters from the name, not UUID characters
- Edge hover labels still appear correctly
- `pnpm build` passes clean

---

### TASK-16 — Fix orphan nodes: removing a focus entity leaves disconnected neighbor nodes

**Status:** `COMPLETE — reviewed 2026-04-12 (truncation fixed by Claude)`
**Risk:** Medium — modifies core data management hook; requires careful state update logic
**Files to read first:**
- `packages/graph/src/hooks/useGraphData.ts` (read lines 74–121 — the entity removal logic in the `useEffect`)

**Background:**
The graph allows multiple focus entities. When you add entity A, its neighbors (B, C) are fetched and added as nodes. When you then remove entity A from focus, entity A's node is removed and all edges from/to A are removed — but nodes B and C remain as orphans with no connections. They linger in the graph as floating, unclickable ghost nodes.

**Problem:**
The removal logic in `useGraphData.ts` (lines 91–103) correctly prunes edges but only removes the focus entity node itself, not neighbor nodes that have become disconnected:

```ts
setNodes(prev =>
  prev.filter(n =>
    !removedIds.includes(n.id) && !groupConnectedToRemove.has(n.id)
    // ← no check that remaining nodes are still referenced by any edge
  )
);

setEdges(prev =>
  prev.filter(e => {
    const fromRemoved = removedIds.includes(e.fromId) || ...;
    const toRemoved   = removedIds.includes(e.toId)   || ...;
    return !fromRemoved && !toRemoved;
  })
);
```

**Fix:**
Compute the surviving edge set first, then use it to prune nodes. The node pruner should keep a node only if: (a) it's still a focus entity, OR (b) it's referenced by at least one surviving edge.

Replace the current `setNodes` + `setEdges` block (lines 91–103) with:

```ts
// Step 1: compute the surviving edges as a plain array
const survivingEdges = edges.filter(e => {
  const fromRemoved = removedIds.includes(e.fromId) || groupConnectedToRemove.has(e.fromId);
  const toRemoved   = removedIds.includes(e.toId)   || groupConnectedToRemove.has(e.toId);
  return !fromRemoved && !toRemoved;
});

// Step 2: build a set of node IDs still referenced by a surviving edge
const referencedNodeIds = new Set<string>([
  ...survivingEdges.map(e => e.fromId),
  ...survivingEdges.map(e => e.toId),
]);

// Step 3: keep a node if it's a current focus entity OR still has at least one edge
setNodes(prev =>
  prev.filter(n =>
    !removedIds.includes(n.id) &&
    !groupConnectedToRemove.has(n.id) &&
    (currentIds.has(n.id) || referencedNodeIds.has(n.id))
  )
);

// Step 4: apply the pre-computed edge filter
setEdges(() => survivingEdges);
```

`currentIds` is already a `Set<string>` defined earlier in the same `useEffect` (line 52: `const currentIds = new Set(focus.entities.map(e => e.id))`). Use it directly — don't recompute.

**Important:** The `edges` variable used in Step 1 is the `edges` state value from the hook's `useState`. It's in scope within the `useEffect` but NOT listed in the dependency array (intentionally — the effect only re-runs when focus changes, not on every edge update). This is the correct pattern here; do not add `edges` to the dependency array.

Do NOT use React's functional update form (`setEdges(prev => ...)`) for the edges setter — since we need the edges value to compute the node set, we compute them outside the setter and use `setEdges(() => survivingEdges)` to apply the result.

**Acceptance criteria:**
- Remove entity A from focus → A's node disappears AND any nodes that were exclusively connected to A (with no other connections in the graph) also disappear
- Nodes that are still connected to remaining focus entities stay in the graph
- Adding entity A back re-fetches and re-renders its subgraph correctly
- `pnpm build` passes clean

---

### TASK-17 — Add Initiatives to header nav
**Status:** `COMPLETE — merged 2026-04-13`
**Risk:** Very Low
Added `{ label: "Initiatives", href: "/initiatives" }` between Proposals and Agencies in the `NavBar` array in `apps/civitics/app/page.tsx`. Clean.

---

### TASK-18 — Federal/State badge on official cards
**Status:** `COMPLETE — merged 2026-04-13`
**Risk:** Low
Added `source_ids` field to `OfficialRow` type and Supabase select in `officials/page.tsx`. Added `isFederal` derivation and badge JSX in `OfficialCard.tsx` using `source_ids?.["congress_gov"]` pattern. Clean.

---

### TASK-19 — SEO/OG generateMetadata on Officials, Proposals, and Initiatives detail pages
**Status:** `COMPLETE — merged 2026-04-13`
**Risk:** Low
Added `generateMetadata` async functions to `officials/[id]/page.tsx` (uses `createAdminClient`), `proposals/[id]/page.tsx` (uses `createServerClient`), and `initiatives/[id]/page.tsx` (uses `createServerClient`). All return `openGraph.title` + `openGraph.description`. Officials also returns `openGraph.images` when `photo_url` is set. Clean.

---

### TASK-20 — Consistent empty states across list pages
**Status:** `COMPLETE — merged 2026-04-13`
**Risk:** Low
Updated empty states in `officials/components/OfficialsList.tsx`, `proposals/page.tsx`, and `agencies/components/AgenciesList.tsx`. All now use dashed-border card pattern with icon, primary text, secondary helper text. Agencies got an improved empty state (already had one, now visually consistent). Clean.

---

### TASK-21 — Skeleton loading states via Next.js loading.tsx files
**Status:** `COMPLETE — merged 2026-04-13`
**Risk:** Low-Medium
Created `loading.tsx` in `officials/`, `proposals/`, `agencies/`, `initiatives/`. Qwen created the files correctly but did not commit — left in working tree after going in circles on preexisting type errors unrelated to this task. Claude committed cleanly. All files: no imports, static JSX, `animate-pulse` skeletons. Clean.

---

### TASK-XX — [Short descriptive title]

**Status:** `READY` | `BLOCKED: <reason>` | `IN PROGRESS` | `NEEDS REVIEW`
**Risk:** Low | Medium | High
**Files to read first:**
- path/to/file.tsx

**Problem:**
[What is broken or missing]

**Fix:**
[Exact instructions. Include code snippets. Be explicit about file paths.]

**Acceptance criteria:**
- [ ] Specific testable outcome
- [ ] pnpm build passes
```

---

## Notes on Workflow

**Claude review checklist (before merging):**
- [ ] Field names match contract (fromId/toId, not source/target, etc.)
- [ ] No `.in()` with large arrays
- [ ] No `createAdminClient()` without `export const dynamic = "force-dynamic";`
- [ ] No edits to `apps/civitics/src/app/`
- [ ] `pnpm build` passes
- [ ] No hardcoded fake data
- [ ] No stray `console.log` in production paths
- [ ] **File endings intact** — check ALL edited files end with closing `}` and no truncation (Qwen has truncated endings in every task so far — sunburst, pathfinder, snapshot, search all had issues)
- [ ] **No null byte corruption** — `file path/to/file.ts` should say "Unicode text", not "data". Binary = corrupted.
