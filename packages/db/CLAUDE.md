# packages/db/CLAUDE.md

Supabase clients, generated types, query and storage helpers. Every table and
column is in `src/types/database.ts`, generated from prod; read it before naming
a column. The traps below are the ones that file does not warn you about.
Runbooks live in `docs/OPERATIONS.md`, measured lessons in
`docs/ENGINEERING_PLAYBOOK.md`. The pre-haircut file is
`docs/archive/claude-md-db-2026-10-24.md`.

---

## Three Clients

Import from `@civitics/db` — never directly from `@supabase/supabase-js`
(the `generateStaticParams` exception below is the only one).

- **`createBrowserClient()`** — `'use client'` components only. Publishable key
  (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`).
- **`createServerClient(cookies())`** — Server Components and Route Handlers.
  Publishable key, respects RLS. Every user-context read goes through it: never
  bypass RLS in app code. (`createPublicClient()` is the same key with no
  cookies, for genuinely public routes.)
- **`createAdminClient()`** — server-only, never client-side. Secret key
  (`SUPABASE_SECRET_KEY`, never `NEXT_PUBLIC_`), bypasses RLS.
  **Every route/page that calls this MUST add:**
  `export const dynamic = "force-dynamic";` (Next.js prerenders at build time by
  default; the secret key is not available then). From a `tsx` pipeline it
  refuses a non-local URL without `--allow-prod` (FIX-158).
- **`generateStaticParams`** — `createClient()` from `@supabase/supabase-js`
  with the publishable key. Never `createAdminClient()`: the secret key is not
  available at Vercel build time. Its other rules: root `CLAUDE.md` §App traps
  → `docs/OPERATIONS.md` §Build Failing on Vercel.

---

## Column traps

### entity_connections — a derived display cache

Columns: `from_id` / `from_type` / `to_id` / `to_type`, `connection_type`,
`strength` (0.0–1.0), `amount_cents`, `occurred_at`, `ended_at`,
`evidence_count`, `evidence_ids` (text[]), `evidence_source`, `derived_at`,
`metadata`. There is no `entity_a_id` / `entity_b_id`, no `is_verified` and no
`evidence` JSONB — all three appear in old specs and are wrong.

Money edges: `'donation'` (direct donations plus `ie_support` super-PAC spend FOR
a candidate) and `'opposition'` (FIX-747 — `ie_oppose` spend AGAINST a
candidate). Both derive from `financial_relationships` in the EC rebuild.

**EC lags its source; it is not truth.** Donation edges are rebuilt by a
scheduled unit (the `ec-crawl` registry row), so a pair from the current
weekend's FEC ingest legitimately has no edge until the next rebuild.
**"No EC edge" NEVER means "no donation."** Query `financial_relationships` for
presence and counts; the FR-derived aggregates on `financial_entities` are
recomputed from FR directly. Receipt: playbook E11 (FIX-735, FIX-736).

### financial_relationships and financial_entities — no `source_ids`

`financial_relationships` has **no** `source_ids`, `source_id` or `source`
column. It is polymorphic (`from_type`/`from_id` → `to_type`/`to_id`,
`relationship_type`, `amount_cents`, `cycle_year`) with typed id columns
(`fec_filing_id`, `disclosure_form_id`, `usaspending_award_id`) and `metadata`.
The writer's source tag is `metadata->>'source'` (`fec_bulk_pac`,
`fec_bulk_indiv`, `fec_bulk_indiv_to_committee`, `fec_bulk_ie`, …); the pas2
committee id is `metadata->>'fec_committee_id'`. The FEC writers' arbiter is
`(relationship_type, from_id, to_id, cycle_year)`.

`financial_entities.fec_committee_id` is a real COLUMN (UNIQUE — the PAC
arbiter) and `donor_fingerprint` is UNIQUE for individuals. No `source_ids`
here either: that JSONB pattern is `officials`'.

### officials — column names

```
role_title  (NOT role_type)
full_name   (NOT name)
is_active   (boolean)
source_ids  (JSONB — external IDs)
  source_ids->>'fec_candidate_id'
  source_ids->>'fec_id'
  source_ids->>'congress_gov'
metadata    (JSONB — flexible fields)
  metadata->>'state'
  metadata->>'district'
  metadata->>'level' (federal/state)
```

Common mistake: `role_type` does not exist — always use `role_title`.

### proposals.vote_category

| Value | Meaning |
|-------|---------|
| `substantive` | Real legislation — bills with proper titles (the column DEFAULT) |
| `procedural` | Parliamentary procedure — cloture, passage motions, etc. |
| `nomination` | Judicial/cabinet/ambassador confirmation votes → the graph's `nomination_vote_yes` / `nomination_vote_no` edges |
| `regulation` | Federal regulations from regulations.gov |

The values are set by title-pattern `UPDATE`s in `0019_proposal_vote_category.sql`
and `20260523015000_restore_proposals_vote_category.sql` (FIX-334 restored the
column the 2026-04-22 promotion dropped); no pipeline sets it on insert. The
graph snapshot route hides `procedural`; the connections route's procedural
filter keys on `votes.vote_question` instead (FIX-125). `?include_procedural=true`
shows everything.

---

## Materialization pattern for slow request-path aggregations

Materialize only when all three hold: the query aggregates over a table that
grows with data; its p95 has passed ~1 s; the data tolerates some staleness.
Otherwise leave it live — don't materialize preemptively.

| Shape | Naming | Use when |
|---|---|---|
| **Single-row MV** | `<surface>_stats_mv` | One row of summary stats, public read, daily cadence, no history |
| **Per-entity MV** (`REFRESH CONCURRENTLY`, unique index) | `<surface>_<axis>_mv` | Per-row keyed stats, public read, daily cadence |
| **Rolling snapshot table** (`INSERT` per tick + N-day prune) | `<surface>_snapshot` | Sub-daily cadence, debug history worth keeping, or a payload a SQL view can't express (an RPC, an HTTP call) |
| **Count cache** (one row per metric, overwritten) | `platform_counts` (FIX-1146) | The cost is *counting*, and a day-old exact count is fine (playbook E11) |

Don't retro-fit one shape onto another to unify them. Refresh functions are
`refresh_<name>_mv()`, retention `prune_<name>_snapshot()`. Keep the live
compute and the snapshot read/write side by side —
`compute<Surface>Payload` / `write<Surface>Snapshot` / `read<Surface>Snapshot`,
as in `src/platform-snapshot.ts` (FIX-281). The live list is `pg_matviews` plus
the job registry (`pnpm board`).

### Redefining a live MV — always swap, never DROP + CREATE (FIX-1032)

`DROP` + `CREATE … WITH DATA` holds ACCESS EXCLUSIVE for the whole populate —
FIX-1032's 442 s of request-path timeouts. Build a populated `_new` twin and
swap it in one `DO` block: `docs/OPERATIONS.md` §Redefining a live MV.

### Refresh hook placement

- **Daily or weekly:** add the refresh to the in-DB procedure
  `refresh_derived_mvs` (FIX-715), which runs from its job-registry rows —
  never to `runNightlySync()`, whose MV block was removed.
- **Sub-daily:** extend `apps/civitics/app/api/cron/platform-snapshot/route.ts`
  (Vercel `*/30`, FIX-1127), each write in its own `Promise.allSettled` slot.

A cadence neither fits gets a FIX and a registry row before it gets a new cron.

### Retiring or pausing a pg_cron job — declare it in the same migration (FIX-1059)

**Any `cron.unschedule(...)` or `cron.alter_job(..., active := false)` on a job
whose procedure writes `data_sync_log` MUST land a
`public.rollup_watch_overrides` row in the SAME migration.** Rows are
declarations, never measurements; a declared pipeline stays listed with both
thresholds NULL and is never dropped. `claimProdSession()` is a second writer
(FIX-1177): a human hold wins over a session hold. The table's COMMENT ("read
only by `list_scheduled_rollup_pipelines()`") is stale. The SQL and the rest:
`docs/OPERATIONS.md` §Retiring or pausing a pg_cron job.

### Read path convention

- Wrap snapshot reads in `withDbTimeout` (`apps/civitics/src/lib/supabase-check.ts`)
  and always keep a live-compute fallback for stale or missing rows.
- The staleness threshold follows the cron that writes the row:
  `SNAPSHOT_STALE_MS` / `SNAPSHOT_AGING_MS` in
  `apps/civitics/src/lib/snapshot-freshness.ts` (2 h / 75 min for the `*/30`
  tick). Re-tune the pair WITH the cron expression, never independently.
- **Never put a sub-daily tick on GHA**, and never drive one from pg_cron
  curling a route. Receipt: playbook D1 addendum (FIX-1127, FIX-1120).
- Single-row MV: `SELECT * FROM <mv> LIMIT 1`. Snapshot table:
  `ORDER BY fetched_at DESC LIMIT 1`. Per-entity MV: `.in(<entity_id>, ids)`
  plus a `Map<id, row>` lookup on the caller.

### Function-level `statement_timeout` — does NOT raise a PostgREST RPC's ceiling

`ALTER FUNCTION … SET statement_timeout` neither raises nor lowers the call that
entered the function. The timer arms from the session/role value at statement
start, so over PostgREST the `service_role` default (≈8 s on Pro) is the hard
ceiling. A request-path RPC gets under it by materializing (above). A long
pipeline operation runs over a **direct `pg.Client`** with a **session-level**
`SET statement_timeout` (`lib/heavy-rebuild.ts`). Receipts: playbook C2 and its
2026-10-23 addendum.

---

## Cross-source merge surface — `financial_entities` FK-rewrite template

When two `financial_entities` rows collapse into one, every polymorphic
`(entity_type='financial_entity', entity_id)` reference to the **loser** must be
rewritten to the **winner** before the loser is deleted, or downstream consumers
see orphans. The source of truth for the surface is
`pnpm --filter @civitics/data data:audit-fe-fk-surface`. Run it before
designing any merge migration. The canonical sequence and the copy-paste SQL:
`docs/OPERATIONS.md` §Merging `financial_entities` rows.

### When to extend this list

Re-run `data:audit-fe-fk-surface` whenever:
- A new table with an `entity_id` / `from_id` / `to_id` / `matched_entity_id`
  column lands in `public.*`.
- A discriminator constraint changes (CHECK added/removed, ENUM expanded).
- A merge migration completes — confirm 0 FE-loser orphans across all
  Pass C tables before declaring done.

If Pass C surfaces a non-zero orphan count post-merge, the loser-remap
missed a table — file a FIX, don't paper over with `WHERE entity_id IS
NOT NULL` guards downstream.

---

## Autovacuum: per-table settings and the bulk-rewrite vacuum rule

Root `CLAUDE.md` carries the rule: a bulk rewrite ends by vacuuming what it
rewrote. Tuning a table:

- Judge a table by `relallvisible / relpages`, not `n_dead_tup` or percent dead
  (playbook B1). The trigger is `threshold + scale_factor × reltuples`, so on a
  large table only the scale factor moves it (D7).
- Default to **0.05**. Go to 0.02 only for cheap tables (few indexes, small
  heap) or the very largest request-path tables. A pass costs index bytes ×
  index count, not rows. Don't tune self-maintaining rollups. Receipt: playbook
  D7 addendum (FIX-1152).
- `entity_connections` stays at 0.05 on purpose. Autovacuum keys on dead
  tuples, but what breaks its index-only reads is the visibility map, and the
  scheduled `ec-vacuum-analyze` is decay-keyed, so the scheduled job carries the
  load.
- Size an ad-hoc vacuum from `n_dead_tup` and the index footprint, never from
  the cron job's history. A cancelled VACUUM banks nothing. Receipt: playbook
  C5 addendum (FIX-1133).
- The per-table settings are `pg_class.reloptions`. Keep them in sync with the
  `watched` CTE in `check_rebuild_autovacuum_status()`: the detector and the
  tuning must not drift.

### Applying

`ALTER TABLE … SET (…)` is a catalog update — no rewrite, no data movement — but
it needs a brief ACCESS EXCLUSIVE lock, which queues behind long reads *and*
blocks new queries behind it. Set `lock_timeout` and prefer an off-peak window.
Note the Supabase CLI does **not** wrap a migration in a transaction, so use
`SET lock_timeout`, not `SET LOCAL` (which warns `25P01` and does nothing).

---

## Storage Rules

- Always use `uploadFile()` / `getFile()` / `getStorageUrl()` from `@civitics/db`
- **Never store full URLs in the database** — always store relative paths: `bills/s2847.txt`
- `STORAGE_PROVIDER` env variable controls routing (`supabase` default | `r2`)

---

## Migration Conventions

- Filename: `YYYYMMDDHHMMSS_description.sql` (14 digits). The `0001`–`0032`
  four-digit files are the March–April 2026 legacy series; never add to it.
- Append only — never modify an existing migration.
- Always reversible — include a DOWN migration or document manual rollback.
- Test locally before pushing: `supabase migration up --local`, then
  `pnpm db:push:prod` (root `CLAUDE.md` §Database). Destructive SQL: root
  §Database (Pro needs explicit confirmation; local Docker is free).
- New tables: amounts in **integer cents**, never floats; `TIMESTAMPTZ`; UUID
  ids with `DEFAULT gen_random_uuid()`; `metadata JSONB DEFAULT '{}'`;
  `created_at`, plus `updated_at` where mutable.

---

## Regenerating `src/types/database.ts` (`pnpm db:types`)

`pnpm db:types` generates from **prod**; the committed file is prod-faithful.
When a migration is on disk but not yet on Pro and the app must typecheck first,
generate from **local** with `--workdir` and splice the `public` schema onto the
committed header. Never overwrite the committed file with a local gen: it
differs by four artifacts, none of them schema, and a local clone carries
scratch tables prod does not. When the real change is small, patch the
committed file by hand instead. The commands, the four artifacts and the
scratch-table check: `docs/OPERATIONS.md` §Regenerating `database.ts`.
