# packages/db/CLAUDE.md

## Purpose
Supabase client wrappers, TypeScript types, query helpers, storage utilities.
Import from `@civitics/db` — never import directly from `@supabase/supabase-js`.

---

## API Keys (New Format Only)

```
Client side:  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  (sb_publishable_xxx)
Server side:  SUPABASE_SECRET_KEY                   (sb_secret_xxx)
Management:   SUPABASE_MANAGEMENT_API_KEY           (sbp_xxx, optional)
```

Never use legacy `anon` or `service_role` keys.
Never use `NEXT_PUBLIC_` prefix on the secret key.
Supabase project ID: `xsazcoxinpgttgquwvuf`

## Management API

`SUPABASE_MANAGEMENT_API_KEY` is a Personal Access Token created at
`https://supabase.com/dashboard/account/tokens`. Used by `getSupabaseManagementMetrics()`
in [supabase-usage.ts](src/supabase-usage.ts) to pull live API request counts,
function invocations, and disk utilization from `https://api.supabase.com/v1/projects/{ref}/...`
for the Platform Costs card on the dashboard.

Optional: if unset, the SQL-derived self-metrics (`db_size_bytes`, `storage_bytes`)
still update on every dashboard load via the public `get_supabase_self_metrics()`
RPC; only the three Management API rows fall back to whatever is already in
`platform_usage`.

---

## Three Clients

### createBrowserClient()
- `'use client'` components only
- Uses publishable key

### createServerClient(cookieStore)
- Server Components and Route Handlers
- Pass `cookies()` from `next/headers`
- Uses publishable key, respects RLS

### createAdminClient()
- Server-only, never client-side
- Uses secret key, bypasses RLS
- Data ingestion pipelines only
- **Every route/page that calls this MUST add:** `export const dynamic = "force-dynamic";`
  (Next.js prerenders at build time by default; secret key is not available then)

### generateStaticParams exception
Use `createClient()` directly from `@supabase/supabase-js` with the publishable key.
Never `createAdminClient()` — secret key is not available at Vercel build time.

---

## Database Schema Conventions

All amounts: **integer cents** — never floats
All timestamps: **TIMESTAMPTZ**
All IDs: **UUID** with `DEFAULT gen_random_uuid()`
All tables: **`metadata JSONB DEFAULT '{}'`** for country-specific fields
All tables: **`created_at TIMESTAMPTZ DEFAULT now()`**, `updated_at` where mutable

---

## Core Tables

| Table | Purpose |
|-------|---------|
| `jurisdictions` | Hierarchical: global → country → state → county → city. Every entity belongs here. Global deployment is a config change, not a rebuild. |
| `governing_bodies` | Any government entity anywhere — committee, legislature, court, agency |
| `officials` | Any public official, any country, any level. `source_ids JSONB` holds IDs across source systems. |
| `proposals` | Any legislative/regulatory proposal. `proposal_type` covers bill, regulation, executive_order, treaty, referendum. `vote_category` controls graph visibility (see below). |
| `entity_connections` | Connection graph table. See correction below. |
| `financial_relationships` | All money flows — polymorphic on `relationship_type` (donation, gift, honorarium, loan, owns_stock, owns_bond, property, contract, grant, lobbying_spend). Holds both FEC donations and USASpending contract/grant data (the former `spending_records` table was merged here at 2026-04-22 cutover). `from_type`/`to_type` polymorphic FKs. `amount_cents`. |
| `financial_entities` | Donor / recipient entities — PACs, individuals, corporations, etc. |
| `votes` | Vote records — official × proposal × vote_value |
| `promises` | Promise tracker — officials → commitments with status lifecycle |
| `career_history` | Revolving door tracker |
| `graph_snapshots` | Share codes for connection graph — `code`, `state JSONB`, `view_count` |
| `data_sync_log` | Every pipeline run recorded here |

### ⚠️ IMPORTANT CORRECTION — entity_connections

The **actual** column names are:

```
from_id       from_type
to_id         to_type
connection_type
strength      (0.0 – 1.0)
amount_cents  (nullable)
occurred_at   (nullable TIMESTAMPTZ)
is_verified   (boolean)
evidence      (JSONB array of source URLs)
```

The original CLAUDE.md spec used `entity_a_id` / `entity_b_id` — **those names are wrong**.
All API routes, queries, and pipelines must use `from_id` / `from_type` / `to_id` / `to_type`.

## users table — design notes

`id` is the Supabase Auth UUID — same UUID shared between `auth.users` and `public.users`.
Supabase Auth manages identity; this table stores profile data only.

```
id                    UUID  → auth.users(id) ON DELETE CASCADE
email                 TEXT  — cached from auth for easier queries
display_name          TEXT  — optional, from OAuth or user-set
avatar_url            TEXT  — from OAuth provider or upload
auth_provider         TEXT  — 'email' | 'google' | 'github'
civic_credits_balance INT   — Phase 4 will migrate on-chain; keep here for now
is_active             BOOL
last_seen             TIMESTAMPTZ
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ  — managed by trigger
metadata              JSONB — Phase 4 wallet data goes here:
                               metadata->>'wallet_address'
                               metadata->>'wallet_chain'
```

**Columns intentionally NOT here:**
- `wallet_address` / `wallet_chain` → `metadata` JSONB when Phase 4 starts
- `district_jurisdiction_id` / `zip_code` → `user_preferences` table (Phase 2)
- `privy_user_id` → removed; Supabase Auth handles identity

**Do not add blockchain columns directly to `users`.** Use `metadata` JSONB until Phase 4 design is finalized.

**Phase 2 `user_preferences` table** (not yet created) will hold:
- `district_jurisdiction_id`, `zip_code`, notification settings, followed officials, saved positions

---

## proposals table — vote_category column

Added in migration 0019. Controls how proposals appear in the graph and proposals page.

| Value | Meaning | Graph behavior | Proposals page |
|-------|---------|----------------|----------------|
| `substantive` | Real legislation — bills with proper titles | Shown | Shown (if not a vote type) |
| `procedural` | Parliamentary procedure — cloture, passage motions, etc. | **Hidden by default** | Never shown |
| `nomination` | Judicial/cabinet/ambassador confirmation votes | Shown as `nomination_vote_yes` / `nomination_vote_no` edges | Never shown |
| `regulation` | Federal regulations from regulations.gov | Shown | Shown |

Default graph filter:
  WHERE vote_category != 'procedural'
  (unless ?include_procedural=true is passed)

Auto-categorized on insert by Congress.gov pipeline:
  - title IN (procedural list) → procedural
  - title ILIKE 'On the Nomination%' etc. → nomination
  - else → substantive

---

## officials table — column names
  role_title  (NOT role_type)
  full_name   (NOT name)
  is_active   (boolean)
  source_ids  (JSONB — stores external IDs)
    source_ids->>'fec_id'
    source_ids->>'bioguide_id'
    source_ids->>'congress_id'
  metadata    (JSONB — flexible fields)
    metadata->>'state'
    metadata->>'district'
    metadata->>'level' (federal/state)

Common mistake: role_type does
not exist — always use role_title

---

## financial_relationships table — column names
  source_ids  (JSONB — NOT source_id)
    source_ids->>'fec_committee_id'
    source_ids->>'fec_candidate_id'

Common mistake: source_id (singular, wrong)
Always use: source_ids (plural, with s)

Same JSONB pattern as officials:
  officials.source_ids->>'congress_gov'
  officials.source_ids->>'fec_id'
  financial_relationships.source_ids->>'fec_committee_id'

---

## RLS Patterns

```sql
-- All civic data: public read, no auth required
-- (officials, proposals, agencies, votes, entity_connections, etc.)
CREATE POLICY "public read" ON table_name FOR SELECT USING (true);

-- User data: authenticated only
-- (civic_comments, follows, positions, user preferences)
CREATE POLICY "owner" ON table_name USING (auth.uid() = user_id);
```

- Never bypass RLS in app code — use `createServerClient()` for user-context reads
- `createAdminClient()` bypasses RLS by design — only for pipelines

---

## Materialization pattern for slow request-path aggregations

When a request-path query that aggregates over a table that grows with data
exceeds p95 ~1 s, the durable fix is to move the aggregation off the request
path. This pattern has shipped five+ times across the codebase
(FIX-207, FIX-222, FIX-223, FIX-233, FIX-281, FIX-297) — codified here so the
next surface follows the recipe instead of re-deciding.

### When to reach for it

All three must hold:

1. The query aggregates over a table that grows with data.
2. p95 request time has exceeded ~1 s for that query.
3. The data tolerates some staleness — minutes to days, depending on cadence.

If any one of these doesn't hold, leave the query live. Don't materialize
preemptively.

### Shape options — pick by cadence + audience + history value

| Shape | Naming | Use when | Examples |
|---|---|---|---|
| **Single-row MV** | `<surface>_stats_mv` | One row of summary stats, public anon read, nightly cadence acceptable, no history needed | `homepage_stats_mv` (FIX-223) |
| **Per-entity MV** (`REFRESH CONCURRENTLY` w/ unique index) | `<surface>_<axis>_mv` | Per-row keyed stats, public read, nightly cadence | `official_homepage_stats_mv` (FIX-223); `chord_industry_flows_mv`, `chord_donor_type_party_flows_mv`, `chord_donor_state_party_flows_mv`, `chord_subject_party_flows_mv` (FIX-207, FIX-222); `pipeline_runtime_stats_mv` (FIX-233) |
| **Rolling-history snapshot table** (`INSERT`-per-tick + N-day prune) | `<surface>_snapshot` | Sub-daily cadence, debug history valuable, computation needs language SQL views can't express (RPC + external HTTP), admin/internal read | `platform_usage_snapshot` (FIX-281) — 30 d prune; `status_snapshot` (FIX-297) — 24 h prune |

Three shapes — all valid for the right job. **Do not retro-fit existing
materializations to one shape** to unify; cadence + audience + history value
determine the right pick, and "homepage hero stats" (single-row MV) and
"platform usage every 10 min" (rolling snapshot) are correctly different.

#### Snapshot table vs MV — when each wins

- **MV** when the computation is expressible in pure SQL and refreshes once
  a day. `REFRESH MATERIALIZED VIEW CONCURRENTLY` needs a unique index;
  single-row MVs use non-CONCURRENT refresh (millisecond-scale lock, fine
  for the nightly window).
- **Snapshot table** when the payload includes an RPC call, an external
  HTTP request, or anything else a SQL view can't express; or when sub-daily
  cadence + debug history matter (the prune retention IS the rolling
  history).

### Naming conventions

- `_mv` suffix → materialized view
- `_snapshot` suffix → plain table populated by cron
- `refresh_<name>_mv()` for refresh functions on MVs
- `prune_<name>_snapshot()` for retention on rolling snapshot tables
- Migration filename: `<ts>_<descriptive_name>.sql`

### Refresh hook placement

Pick one based on cadence:

- **Nightly:** append the refresh function name to
  `runNightlySync()`'s MV refresh block at
  `packages/data/src/pipelines/index.ts:908` (search for
  `refresh_homepage_stats_mv`). One line per new MV. No new GHA workflow.
- **Sub-daily (10 min default):** extend
  `apps/civitics/app/api/cron/platform-snapshot/route.ts` to call the new
  `write<Surface>Snapshot(db)` helper alongside the existing writes (each
  in its own `Promise.allSettled` slot so one failure doesn't block
  another). Schedule lives in `.github/workflows/platform-snapshot.yml`
  (Vercel Hobby blocks sub-daily cron) — don't add a new GHA workflow if
  the existing 10-min cron's cadence fits.

If neither fits, file a FIX bullet documenting the new cadence and the
reason an existing hook didn't work before adding a new cron — they multiply
fast.

### Read path convention

- Wrap snapshot reads in `withDbTimeout<{...}>(2000)` (from
  `apps/civitics/src/lib/supabase-check.ts`).
- Always have a live-compute fallback for staleness/missing. Threshold
  proportional to refresh cadence:
  - **10-min cron** → 30 min staleness threshold (three cycles of slack).
  - **Nightly** → 4 h threshold (catches a missed run window before page
    rendering shows yesterday's data).
- **Single-row MV reads** use `SELECT * FROM <mv> LIMIT 1`.
- **Snapshot table reads** use `ORDER BY fetched_at DESC LIMIT 1`.
- **Per-entity MV reads** use `.in(<entity_id>, ids)` and a `Map<id, row>`
  lookup on the caller — see `apps/civitics/app/page.tsx`'s Wave 3 for the
  pattern.

### Compute + read + write helper convention

Keep the live compute and the snapshot read/write side-by-side so the cron
path and the live-fallback path stay in sync:

- `compute<Surface>Payload(db)` — runs the live aggregation. The function
  that would have lived inside the request handler.
- `write<Surface>Snapshot(db)` — calls `compute<Surface>Payload(db)` and
  persists the result. Returns the same payload (so the cron route response
  can echo summary fields without re-reading).
- `read<Surface>Snapshot(db)` — returns the latest snapshot row, or `null`
  if missing. Caller is responsible for the staleness check and the
  fallback to `compute<Surface>Payload`.

Two reference implementations in the codebase:
- `packages/db/src/platform-snapshot.ts` (FIX-281) — when the helpers live
  in a shared package.
- `apps/civitics/app/api/claude/status/_lib/status-snapshot.ts` (FIX-297) —
  when the helpers must compose route-local imports (`packages/db` can't
  import from `apps`).

### Function-level `statement_timeout`

Any new aggregation RPC over a table > 1 M rows should set its own
`statement_timeout`. The service_role default (8 s on Pro) times out
cold-cache GROUP BYs on `entity_connections` / `financial_relationships`.

```sql
ALTER FUNCTION public.<name>(...) SET statement_timeout = '<budget>';
```

Sizing guidance:
- Aggregation over 5 M rows (cold) → **120 s** (precedent:
  `get_connection_type_counts`, FIX-298 follow-up).
- Per-chunk rebuild functions → **90 min** (precedent:
  `rebuild_entity_connections_donations`, FIX-291).

Set the timeout via `ALTER FUNCTION`, not by rewriting the body — cleaner
diff and the GUC is what changes.

### When NOT to materialize

- Data changes too fast for any acceptable staleness window — real-time
  surfaces stay live.
- Compute is already fast (<200 ms request budget). Materializing
  cheap-but-frequent queries adds cron load without latency benefit.
- Surface is admin-only and not under user-facing latency pressure — may
  be cheaper to leave live.
- A simple mode change suffices: `count:'exact'` → `count:'estimated'` on
  an unfiltered big-table count reads `pg_class.reltuples` (no scan,
  sub-200 ms) and is accurate-enough for hero stats. FIX-206 made this
  the default for `sections.ts:getDatabase`.

### Cost note

- Cron compute time is off the request path but still real database load
  every N minutes. Profile the *compute*, not just the read.
- **Prefer "superset payload + multiple consumers" over per-route
  snapshots.** `status_snapshot` (FIX-297) serves /core, /quality, AND
  the dashboard SSR with one 11-section payload — three surfaces, one
  snapshot. Per-route snapshots fragment the surface and multiply cron
  cost.

### Per-enum-value loops — the FIX-298 shape

A recurring trap: an array of N enum values mapped over to fire N count
queries on the same table. Solution is the same every time — single GROUP
BY RPC + `Map<key, total>` lookup with a zero-fill fallback:

```ts
const { data } = await db.rpc("get_<table>_counts_by_<axis>");
const byKey = new Map<string, number>();
for (const r of data ?? []) byKey.set(r.<axis>, Number(r.total));
const results = ENUM_VALUES.map((k) => ({ key: k, count: byKey.get(k) ?? 0 }));
```

Precedents: `get_connection_type_counts` (FIX-298),
`checkDerivedDrift` (FIX-301). When you see a `for (const x of ENUM)` or
`ENUM.map(x => db.from(...).select(...).count)` doing N count queries on
the same table, this is the recipe.

### Existing materializations — quick-lookup table

| Name | Shape | Cadence | Refresh trigger | Read audience |
|---|---|---|---|---|
| `homepage_stats_mv` | Single-row MV | Nightly | `runNightlySync` MV block | Public (anon) |
| `official_homepage_stats_mv` | Per-entity MV | Nightly | `runNightlySync` MV block | Public |
| `chord_industry_flows_mv` | Per-row MV | Nightly | `runNightlySync` | Public |
| `chord_donor_type_party_flows_mv` | Per-row MV | Nightly | `runNightlySync` | Public |
| `chord_donor_state_party_flows_mv` | Per-row MV | Nightly | `runNightlySync` | Public |
| `chord_subject_party_flows_mv` | Per-row MV | Nightly | `runNightlySync` | Public |
| `pipeline_runtime_stats_mv` | Per-pipeline MV | Nightly | `runNightlySync` | Admin |
| `platform_usage_snapshot` | Rolling table (30 d prune) | 10 min | `platform-snapshot` cron | Public-readable, admin-displayed |
| `status_snapshot` | Rolling table (24 h prune) | 10 min | `platform-snapshot` cron | Admin |

Audit history of which long poles each one replaced lives in `docs/FIXES.md`
under the cited FIX ID; full conventions audit at
`docs/audits/request-path-aggregations.md`.

---

## Storage Strategy

Current: **Supabase Storage** (warm tier substitute until Cloudflare account set up)
Future: **Cloudflare R2** (no egress fees — critical for a read-heavy public platform)
Never: **AWS S3** (egress fees are prohibitive)

### Migration path (when Cloudflare account available)
1. Set `STORAGE_PROVIDER=r2` in `.env.local`
2. Add `R2_PUBLIC_URL=https://your-bucket.r2.dev`
3. Run `packages/data/src/migrations/supabase-to-r2.ts`
4. Paths in DB stay the same — no DB migration needed

### Rules
- Always use `uploadFile()` / `getFile()` / `getStorageUrl()` from `@civitics/db`
- **Never store full URLs in the database** — always store relative paths: `bills/s2847.txt`
- `STORAGE_PROVIDER` env variable controls routing (supabase | r2)
- Arweave: official comments + promise records at ingestion (~$4–8/GB one-time, permanent)

---

## Migration Conventions

- Append only — never modify an existing migration
- Always reversible — include a DOWN migration or document manual rollback
- Test locally before pushing
- Never `DROP TABLE`, `TRUNCATE`, or `DELETE` without explicit user confirmation
- Filename format: `YYYYMMDD_description.sql`
  
  "NEVER run supabase migration up
   without --local flag.
   NEVER connect to prod DB during
   development."
