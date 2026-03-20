# packages/db/CLAUDE.md

## Purpose
Supabase client wrappers, TypeScript types, query helpers, storage utilities.
Import from `@civitics/db` — never import directly from `@supabase/supabase-js`.

---

## API Keys (New Format Only)

```
Client side:  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY  (sb_publishable_xxx)
Server side:  SUPABASE_SECRET_KEY                   (sb_secret_xxx)
```

Never use legacy `anon` or `service_role` keys.
Never use `NEXT_PUBLIC_` prefix on the secret key.
Supabase project ID: `xsazcoxinpgttgquwvuf`

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
| `proposals` | Any legislative/regulatory proposal. `proposal_type` covers bill, regulation, executive_order, treaty, referendum |
| `entity_connections` | Connection graph table. See correction below. |
| `financial_relationships` | All money flows. `donor_type`, `industry`, `amount_cents` |
| `financial_entities` | FEC donor entities (PAC, individual, corporation) |
| `spending_records` | USASpending.gov contract/grant data |
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
not exist — always use role_title"

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
