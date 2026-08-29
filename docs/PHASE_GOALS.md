# Civitics Platform — Phase Goals

> This file tracks progress against the phased development plan defined in `CLAUDE.md`.
> Update checkboxes as tasks complete. Phases are sequential; each unlocks the next.
> Last audited: 2026-08-22 (verified against actual files, tables, and live prod counts — not guessed).
> Last updated: 2026-08-22 — Phase 1 exits on beta users + grants; everything else in it is shipped.
> Community layer (comments / positions / follows), vote backfill, and the final
> three graph presets all landed since the March audit. The four unimplemented
> Phase 2 pipelines were re-verified and are still skeletons — see the annotations.
>
> **Percentages** are a simple checkbox ratio over the phase's own `- [ ]` / `- [x]`
> bullets (sub-bullets and notes don't count). `/api/phases` parses these header
> lines at runtime — see `apps/civitics/app/api/phases/route.ts` (FIX-1078). Keep the
> `` `~NN% complete` `` / `` `Planned` `` token shape intact or the public
> Development Progress section on `/dashboard` drops to its static fallback.

---

## Phase 0 — Scaffold ✓ `Weeks 1–2` `100% complete`

### Infrastructure
- [x] Turborepo monorepo scaffolded
- [x] Next.js apps: `civitics` + `social`
- [x] pnpm workspace configured
- [x] Shared packages structure (`ui`, `db`, `blockchain`, `maps`, `graph`, `ai`, `auth`, `config`)
- [x] Tailwind CSS configured

### Accounts & Services
- [x] civitics.com domain registered
- [x] GitHub repo live (`civitics-platform/civitics`)
- [x] Supabase project created
- [x] Anthropic, Vercel, Resend, Sentry accounts
- [x] New Supabase API keys (not legacy)
- [x] `.env.local` and `.env.example` created

### Database
- [x] Phase 1 schema migrated (9 tables)
- [x] PostGIS, uuid-ossp, pgcrypto, pg_trgm enabled
- [x] RLS enabled on all tables
- [x] Supabase client connected (3 clients)

### First Visual
- [x] Homepage running at `localhost:3000`
- [x] Connection graph at `/graph` with D3
- [x] `CLAUDE.md` written and committed

---

## Phase 1 — MVP `Weeks 3–10` `~96% complete` ← **current**

> **Done when:** Vote backfill complete, search ranking fixed, auth tested end-to-end, grant applications submitted, first 500 users.
> As of the 2026-08-22 audit the only open exit criteria are **500 beta users** and
> **grant applications** — both non-engineering. The remaining unchecked engineering
> bullets (credit system, personalized "what does this mean for me", custom storage
> domain) are real but do not gate the phase.

### Data Ingestion Pipelines
- [x] Congress.gov API → officials + votes (`packages/data/src/pipelines/congress/`)
- [x] FEC bulk pipeline → `weball24.zip` + `pas224.zip` → financial_relationships + entity_connections (`packages/data/src/pipelines/fec-bulk/`)
  - Note: FEC API-based pipeline (`fec/`) retained for reference only — do not use (hits rate limits)
  - Note: Full 2GB individual-level FEC file (`indiv24.zip`) pending Cloudflare R2 account
- [x] Financial entities pipeline — `financial_entities` rows from FEC donor categories (`packages/data/src/pipelines/financial-entities/`)
  - 19,647 donation connections live
- [x] USASpending.gov → financial_relationships (contract/grant) (`packages/data/src/pipelines/usaspending/`)
- [x] Regulations.gov → proposals + comment periods (`packages/data/src/pipelines/regulations/`)
- [x] OpenStates → state legislators (`packages/data/src/pipelines/openstates/`) — 6,268 inserted, 1,031 updated (2026-03-17)
- [x] CourtListener → judges + rulings (`packages/data/src/pipelines/courtlistener/`)
- [x] Entity connections pipeline — derives donation/vote/oversight/appointment from ingested data (`packages/data/src/pipelines/connections/`)
  - 9.84M edges live on prod (2026-08-22). The March "51k of 227k pending IO recovery" note is retired — the backlog cleared long ago.
  - Rebuild moved out of the nightly to its own twice-weekly GHA workflow (Sun + Wed 08:00 UTC), then to in-DB `pg_cron` (FIX-291 → FIX-717/718)
- [x] Delta connections runner — only re-derives changed officials since last run (`packages/data/src/pipelines/connections/delta.ts`)
- [x] Master orchestrator + scheduler (`packages/data/src/pipelines/index.ts`)
- [x] Nightly sync pipeline — `runNightlySync()` export, full sequence: data → connections delta → rule tags → AI tags
- [x] Sync log tracking — `data_sync_log` table, per-pipeline run records

### Core Pages
- [x] Homepage wired to real data — officials, proposals, agencies, spending counts pulled live from Supabase
  - Proposals nav and all CTA links wired to `/proposals` and `/proposals?status=open`
  - Hero search bar (GlobalSearch variant="hero") + nav search bar (Cmd/Ctrl+K)
  - Officials section shows federal-only (congress_gov source), ordered by vote count desc
- [x] Officials list page (`/officials`) — full list, party filter, real data
- [x] Official detail page (`/officials/[id]`) — votes, donor data, real data
- [x] Agency list page (`/agencies`) — real data
- [x] Agency detail page (`/agencies/[slug]`) — real data
- [x] Proposals list page (`/proposals`) — status/type/agency/search filters, open-now featured section, clickable cards, full agency names, pagination with filter preservation
- [x] Proposal detail page (`/proposals/[id]`) — "What This Means" AI summary section, comment period banner, 3-step comment draft tool, vote record, related proposals, generateStaticParams for top 50
  - `vote_category` fully populated — 0 NULL across all 2,215 prod proposals that carry votes (verified 2026-08-22)
- [x] Public accountability dashboard (`/dashboard`) — platform stats, pipeline health, data counts
- [x] Search — universal search across officials, proposals, agencies
  - `GET /api/search?q=&type=` — parallel queries, special cases (state abbr, party, role), trigram+ILIKE
  - `GlobalSearch` component — nav (Cmd/Ctrl+K, dropdown) + hero (full-width) variants
  - `/search` full results page — tabs (All/Officials/Proposals/Agencies), grouped results
  - GIN trigram indexes — migration `0008_search_indexes.sql` applied

### Graph Features
- [x] Connection graph with D3 force simulation (`packages/graph/src/ForceGraph.tsx`)
- [x] Graph page at `/graph` — dark theme, wired to `entity_connections` table via `/api/graph/connections`
- [x] Share code system — `CIV-XXXX-XXXX` codes, `/graph/[code]` URLs, `graph_snapshots` table, `/api/graph/snapshot` route
- [x] Screenshot export — PNG 1×/2×/4× with non-removable watermark (URL + data sources + date)
- [x] 5 preset views built — Follow the Money, Votes & Bills, Revolving Door, Full Picture, Clean View
  - Nominations preset ("Who did this senator confirm?") + Full Record preset (all including procedural) also added
  - All three remaining presets — Committee Power, Industry Capture, Co-Sponsor Network — now built and registered in `packages/graph/src/presets.ts` (see Phase 2)
- [x] Proposal vote categorization — `vote_category` column on `proposals` (substantive/procedural/nomination/regulation)
  - Migration `0019_proposal_vote_category.sql` applied; all existing proposals categorized
  - Procedural votes (cloture, passage motions) hidden from graph by default; archived, not deleted
- [x] Nomination votes as separate connection type — `nomination_vote_yes` / `nomination_vote_no` edges
  - Connections pipeline derives these from proposals with `vote_category = 'nomination'`
  - Shown as distinct visual element (violet/pink) vs. legislation votes (blue/red)
- [x] Graph API supports `?include_procedural=true` for researchers and journalists
- [x] Ghost node empty state animation — shown when `entity_connections` table is empty
- [x] Entity selector — search-as-you-type for officials, agencies, proposals; centers graph on selection
- [x] Depth control — 1–5 hop selector; client-side BFS filter
- [x] Filter pills — per-connection-type toggles with live counts; syncs with presets; "Custom" badge
- [x] Customize panel — node size/color encoding, edge thickness/opacity, layout, theme
- [x] Strength slider — filter weak connections by minimum strength threshold
- [x] Smart expansion — click node to expand neighbors; keyboard shortcut support
- [x] Node types rendered: official (circle), proposal (document rect), corporation/financial (diamond, green), pac (triangle, orange), individual (dashed circle, blue), governing_body (rounded rect, purple)
  - Note: `entity_connections` schema uses `from_id`/`from_type`/`to_id`/`to_type` — different from original CLAUDE.md spec which showed `entity_a_id`/`entity_b_id`
- [x] Embed code export — shareable iframe snippet from graph state
- [x] Visualization registry pattern — pluggable viz registry, all views registered uniformly

### Graph Visualizations (Phase 1+)
- [x] Treemap visualization — hierarchical breakdown of connection types / donor industries
- [x] Chord diagram — 13 industry groups, $1.75B flow visualized as arc ribbons
- [x] Sunburst / radial visualization — radial hierarchy drill-down from selected node
- [x] Comparison mode — split-screen two entities side by side
- [x] Path finder — shortest path between two entities (PostgreSQL recursive CTE, `packages/db/src/queries/entity-connections.ts`)
- [x] AI narrative — "Explain this graph" (cached per state hash)
- [x] Graph snapshot API — `/api/graph/snapshot` (save + retrieve named snapshots)
- [x] Entity search API — `/api/graph/entities` (search-as-you-type for graph entity selector)

### Maps
- [x] Mapbox account + API key — `NEXT_PUBLIC_MAPBOX_TOKEN` configured
- [x] District finder from address — `DistrictMap` component geocoded via Mapbox, called `/api/representatives` (component removed from the homepage by FIX-554, deleted as an orphan by FIX-1119; the API route remains)
- [x] "Find your representatives" map — was live on the homepage; superseded by the FIX-554 homepage rebuild
- [x] Lazy loading + geolocation — user-activated map (4-state machine), browser geolocation with privacy coarsening, fade transition

### AI Features
- [x] `ai_summary_cache` table — entity-based cache, UNIQUE on (entity_type, entity_id, summary_type)
- [x] `generateSummary()` function — `packages/ai/src/client.ts`, Haiku model, $4.00/month cost guard, logs to `api_usage_logs`
- [x] Anthropic API connected
- [x] Plain language bill summaries (cached) — pipeline + on-demand generation wired to UI
  - `packages/data/src/pipelines/ai-summaries/index.ts` — batch: 100 open proposals + 50 officials, ~$0.035/run (180 cached, ~$0.035 total spend)
  - `pnpm --filter @civitics/data data:ai-summaries` (full) / `data:ai-summaries-new` (incremental)
  - Route handlers: `GET /api/proposals/[id]/summary` + `GET /api/officials/[id]/summary` (on-demand, cached)
  - Proposal detail page: "What This Means" section — cached AI summary → on-demand (open only) → official summary
  - Official profile page: "About" section — cached AI profile → on-demand (if votes/donor data)
- [x] Entity tagging system — 5,978 tags applied across officials, proposals, financial entities
- [x] Topic / issue classification — AI-based proposal topic + official issue area tags via Haiku
- [x] Donor industry tagging — rule-based industry name-matching on financial entities
- [x] AI cost gate system — hard monthly budget cap enforced before any API call
- [x] Pre-run cost estimation — real API sampling before batch runs, dry-run mode
- [x] Post-run verification — actual vs. estimated cost logged and surfaced in dashboard
- [x] Autonomous cron mode — budget-gated auto-approval for nightly AI runs
- [ ] Basic credit system in Supabase
- [ ] "What does this mean for me" personalized query

### Cost Management System
- [x] Pre-run cost estimation with real API sampling
- [x] Autonomous cron approval — budget-gated auto-approval for scheduled runs
- [x] Post-run verification — actual vs. estimated cost diff logged
- [x] Pipeline cost history table — per-run cost records in `data_sync_log`
- [x] Budget alerts system — threshold alerts surfaced in admin dashboard
- [x] Configurable thresholds — admin-adjustable budget limits via dashboard UI
- [x] Admin dashboard controls — manual pipeline triggers, alert history, limit config

### Diagnostic Tools
- [x] Graph snapshot API — `/api/graph/snapshot`
- [x] Platform status API — `/api/claude/status`
- [x] Claude diagnostic snapshot — `/api/claude/snapshot`
- [x] Entity search API — `/api/graph/entities`

### Data Quality
- [x] Entity tagging — 5,978 tags applied (rule-based + AI)
- [x] Industry classification — FEC donor industries mapped to 13 standard groups
- [x] Voting pattern analysis — partisan/bipartisan tags, pre-vote timing flags
- [x] Donor pattern tags — donation timing relative to votes flagged on financial entities
- [x] Proposal vote categorization — substantive/procedural/nomination/regulation (migration applied)

### Infrastructure
- [x] Supabase storage buckets created
- [x] Storage utility (`packages/db/src/storage.ts`) — `uploadFile()` / `getFile()` / `getStorageUrl()`, path-based (migration-ready for R2)
- [x] Cloudflare R2 configured — buckets (`civitics-documents`, `civitics-cache`), `@aws-sdk/client-s3`, `STORAGE_PROVIDER=r2` active
- [x] `data_sync_log` table tracking all pipeline runs
- [x] `api_usage_logs` table
- [x] `ai_summary_cache` table — migration 0005
- [x] `service_usage` table — tracks Mapbox loads, R2 ops, Vercel deploys — migration 0006
- [x] `financial_entities` table (types not yet regenerated — `any` casts in place)
- [x] `graph_snapshots` table (types not yet regenerated)
  - TODO: run `pnpm --filter @civitics/db gen:types` to regenerate `database.ts` and remove `any` casts
- [x] Vercel Analytics + Speed Insights — installed, wired into root layout
- [x] Self-hosted page view analytics — `page_views` table, `/api/track-view` route, `PageViewTracker` component, bot detection, country tracking, no cookies, 90-day retention
- [x] All services monitored — dashboard at `/dashboard` shows live pipeline health + data counts
- [x] Entity tagging system — `entity_tags` table (migration 0012), three-tier display (primary/secondary/internal), rule-based + AI taggers
  - Rule-based: urgency (closing_soon/urgent/new), agency→sector, proposal scope, tenure, bipartisan/partisan, donor patterns, industry name-matching — zero cost, confidence 1.0
  - AI-based: proposal topic classification + official issue area classification via Haiku (~$0.60 full batch), dry-run cost estimate before running
  - Pre-vote timing flags: donation + vote within 90 days → internal tag on financial entity
- [x] Tag UI — `EntityTags` component with 3-tier expand: primary always shown, +N more, ⚙ research tags with warning blurb, localStorage dismiss
- [x] Tag filtering — topic filter pills on `/proposals`, issue area + donor pattern pills on `/officials`, industry donor filter on `/graph`
- [x] Vercel cron — `vercel.json` schedule (2am UTC), `/api/cron/nightly-sync` secured with CRON_SECRET
- [x] `pipeline_state` table — tracks last connections run timestamp for delta detection
- [x] Nightly auto-sync pipeline — full sequence scheduled and running
- [x] Connections auto-scheduler — delta runner triggered nightly
- [x] Pipeline operations dashboard — manual triggers, run history, status per pipeline
- [x] Cron run status tracking — per-run records with duration, rows affected, cost
- [x] AI cost trend chart — historical cost per run visualized in admin dashboard
- [x] Alert history — past threshold breaches logged and viewable
- [x] Admin-only dashboard controls — gated by `ADMIN_EMAIL` env var
- [ ] Custom storage domain — still the R2-issued `pub-*.r2.dev` subdomain (`CLOUDFLARE_R2_PUBLIC_URL_DOCUMENTS`); no custom hostname bound yet

### Database (live prod counts, audited 2026-08-22)

Read-only counts against Supabase Pro (`xsazcoxinpgttgquwvuf`). These move
constantly — treat them as an order-of-magnitude snapshot, not a target.

| Table | Rows |
|---|---:|
| `officials` | 37,148 |
| `proposals` | 89,482 |
| `votes` | 969,302 |
| `financial_relationships` | 13,817,499 |
| `entity_connections` | 9,839,089 |
| `financial_entities` | 4,842,219 |
| `entity_tags` | 2,851,445 |
| `ai_summary_cache` | 6,888 |

- `officials` growth is mostly FEC candidate rows (`tier='candidate'`, FIX-246) plus state legislators and judges — not 37k elected officials.
- `financial_entities` is dominated by individual FEC donors deduped on `donor_fingerprint`.
- `graph_snapshots` — table exists, rows created on share.
- `entity_comments` / `entity_positions` / `user_follows` — live and receiving real writes (see Community & Auth below). `civic_comments` is the older table; the shipped UI writes `entity_comments`.

### Community & Auth
- [x] User auth via Supabase (magic link + Google OAuth + GitHub OAuth)
  - `/auth/sign-in` page — magic link primary, OAuth secondary
  - `/auth/callback` route — PKCE code exchange, user upsert on first sign-in
  - `/auth/confirm` route — token_hash email confirmation (email change etc.)
  - `AuthButton` — smart nav component (Sign in → modal, signed in → avatar + UserMenu)
  - `AuthModal` — in-page modal, no navigation away, contextual trigger text
  - `UserMenu` — signed-in dropdown (Phase 2 items shown as coming soon)
  - `SignInForm` — shared form component (used by page + modal)
  - `middleware.ts` — silent session refresh on all routes, no protected routes yet
  - Migration `0009_users_table.sql` — run `pnpm db:migrate` in packages/db to apply
- [x] Community commenting on entities — `EntityComments` mounted on officials, proposals, initiatives, institutions, investigations, and jurisdictions detail pages; writes `entity_comments` (55 rows on prod)
  - Ratings via `comment_ratings`, per-proposal aggregates in `proposal_comment_stats`
- [x] Position tracking on proposals — `PositionSection` on proposal + initiative detail pages; writes `entity_positions` (21 rows on prod), history in `position_events`
- [x] Follow officials and agencies — `FollowButton` on officials, institutions, jurisdictions, and initiatives; `user_follows` (9 rows on prod) surfaced in `/desk` via `WatchingModule`
  - `notifications` table exists and is wired, but has not fired yet (0 rows) — worth a look before calling the loop closed

### Shipped since 2026-03 (not in the original plan)

Work that landed after the March audit and has no bullet above. Listed so the
phase percentage isn't read as the whole story — the plan understated Phase 1 in
both directions.

- Homepage rebuilt as "Public Record × Terminal"
- `/search` rebuilt as a browse explorer — zero-query landing, scope rails, saved-views rail, Cmd-K typeahead
- `/graph` five-wave overhaul + polish — token-native theming, canonical node ids, panel rework, preset URL deep links
- Investigations MVP (`/investigations`)
- Commons (`/commons`) and Desk (`/desk`)
- Q&A v2 on entity pages
- Bot-protection gate + Cloudflare edge posture (`docs/CLOUDFLARE.md`)
- Donor industry-tag program — per-tag `tag_category`, write-boundary vocab guard, sector affinity
- FEC attribution arc — external-sort indiv stage (PR 3a) and the aggregate-$200-floor correction with `small_dollar_bracket_rollup` (PR 3b)
- Platform monitoring + cost-detection loop — daily canary, data-health dashboard, request-path `withDbTimeout` enforcement in CI
- `pg_cron` migration + cron resilience for the entity-connections and donor-rollup rebuilds
- Synthetic-content quarantine + moderation harness (SF-P1 through SF-P5)
- Request-path materializations — vote stats, contract flow rollups, connection-count MV, donor totals

### Remaining Phase 1
- [x] Vote backfill complete — 969,302 vote rows on prod (the 227k figure was the March ceiling)
- [x] Proposal vote_category migration — 0 NULL across 2,215 prod proposals with votes
- [x] Elizabeth Warren (and other senators) appearing in search results — `search_graph_entities('warren')` returns the elected `MA · Senator` row; the status route's self-test resolves it past the two FEC candidate duplicates (FIX-339)
- [x] Community commenting
- [x] Position tracking
- [x] Follow officials/agencies
- [ ] 500 beta users
- [ ] Grant applications submitted — **(Craig: status?)**

---

## Phase 2 — Growth `Weeks 11–22` `~8% complete`

> **Done when:** Platform financially self-sustaining, first institutional API customer, first grant money received.

### Accountability Tools
- [ ] Official comment submission → regulations.gov API
- [ ] Promise tracker live
- [ ] Donor impact calculator
- [ ] Vote pattern analyzer
- [ ] Revolving door tracker

### Graph Enhancements (Phase 2)
- [ ] Timeline scrubber — animate graph through time with play button
- [x] Remaining 3 preset views — Committee Power, Industry Capture, Co-Sponsor Network
  - All three defined and exported from `packages/graph/src/presets.ts` (`committee-power`, `industry-capture`, `co-sponsor-network`)
  - Caveat: Co-Sponsor Network leans on `vote_yes` for signal — `proposal_cosponsors` is still empty (0 rows on prod) because the cosponsorship pipeline is a skeleton, so the `co_sponsorship` edge type contributes nothing yet
- [x] Community presets — user-saved named views
  - Shipped as **localStorage**-backed saved views (`civitics_presets`, `packages/graph/src/saved-views.ts`, FIX-817), not the originally-specced `graph_presets` table — that table was never created
  - The Browse explorer's `SavedViewsRail` reads the same contract; a DB-backed store (FIX-763) remains the longer-term merge target

### AI Power Features
- [ ] Connection mapping queries
- [ ] Comment drafting assistant
- [ ] Legislation drafting studio
- [ ] FOIA request builder

### Candidate Tools
- [ ] Candidate profile verification system
- [ ] "Should I run?" explorer (5-step flow)
- [ ] 72-hour campaign launch system

### Revenue
- [ ] Institutional API v1 live
- [ ] First paying institutional customer
- [ ] Open Collective donations active
- [ ] First grant received

### Data Coverage Expansion (carried forward from rebuild spec)

These items were scoped in `docs/archive/REBUILD_STATUS.md` but explicitly deferred — none blocked the Stage 2 cutover. Tracked here so they don't slip through the cracks.

- [ ] **NYC Legistar pipeline** — blocked: requires API token (Knight / Mozilla / Democracy Fund grant pre-req per Decision D, 2026-04-20). Other 4 metros (Seattle, Austin, SF, DC) are live.
- [ ] **FEC bulk 2022 + 2020 cycles** — **in flight.** The 2024-cycle re-stream under the corrected aggregate-$200 floor (PR 3b / FIX-1068) ships first; 2022 and 2020 follow on the same rollout recipe. Backfills historical donor pattern analysis.
- [ ] **Cosponsorship pipeline** — re-verified 2026-08-22: still a skeleton. `packages/data/src/pipelines/govtrack-cosponsors/index.ts` calls `skipSync(logId, "not_implemented")` and returns without touching the network. `proposal_cosponsors` = 0 rows and `co_sponsorship` edges = 0 on prod. It **is** registered as a writer on the data-health dashboard — that registration is the skeleton logging its own skip, not evidence of a run.
- [ ] **Federal Register pipeline** — re-verified 2026-08-22: still a skeleton, same `skipSync(logId, "not_implemented")` shape in `packages/data/src/pipelines/federal-register/index.ts`. The `federal_register` sync-log alias exists for that reason only.
- [ ] **Lobbying pipeline** — re-verified 2026-08-22: no LDA writer exists (no lobbying pipeline directory), and `financial_relationships.relationship_type = 'lobbying_spend'` has 0 rows on prod. The ~10.4k `lobbying` edges in `entity_connections` are **not** from Senate LDA — they carry `evidence_source = 'external_relationships'` (LittleSis). Senate LDA disclosures + lobbying spend → `financial_relationships` is still the open work.
- [ ] **Stage 3 — Local data rollout** — broaden Legistar coverage and per-metro civic data beyond the initial 5-metro pilot.

---

## Phase 3 — Social App `Weeks 23–34` `Planned`

- [ ] Social feed + follow system
- [ ] COMMONS token simulation in Supabase
- [ ] Algorithm v1 (open source)
- [ ] Civic bridge score
- [ ] Creator earnings dashboard
- [ ] Algorithm marketplace seeded
- [ ] Bipartisan design mechanics
- [ ] Social app name decided

---

## Phase 4 — Blockchain `Weeks 35–50` `Planned`

- [ ] Privy embedded wallets live
- [ ] ERC-4337 account abstraction
- [ ] Biconomy gas sponsorship
- [ ] Civic credits on-chain (Optimism)
- [ ] Compute pool smart contract deployed
- [ ] Smart contract audit completed ← **never skip**
- [ ] IPFS + Arweave pipelines live
- [ ] Warrant canary on-chain (weekly automated attestation)

---

## Phase 5 — Global `Weeks 51–66` `Planned`

- [ ] Civic crowdfunding with escrow
- [ ] Official account verification system (government email + cross-reference)
- [ ] UK + Canada deployment
- [ ] Spanish + Portuguese language support
- [ ] DAO governance activation
- [ ] Community treasury live
