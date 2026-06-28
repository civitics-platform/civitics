# Phase 0 — page-consolidating RPC statement-timeout audit (FIX-680 / FIX-681)

Read-only measurement against **prod** (pg_stat_statements + cold EXPLAIN ANALYZE),
2026-06-27. Goal: decide cache-vs-shed per entity type for the recurring 8s
`canceling statement due to statement timeout` log lines on the `get_*_page` RPCs.

## page_views is the wrong instrument — it is bot-blind

`page_views` holds **1,133 rows total since 2026-04-22, with ZERO `is_bot=true`
rows** (it is a client-side JS beacon — crawlers/SSR never fire it). Human page
loads in the last 30d: jurisdiction 45 views / 14 entities, official 20/16,
governing_body 19/12, agency 1/1.

Meanwhile `pg_stat_statements` shows the *real* RPC load (PostgREST path):

| RPC | calls | mean | max | window |
|---|---|---|---|---|
| get_jurisdiction_page | 3,685 | 377ms | **7,947ms** | 6d |
| get_official_page | 780 | 205ms | **7,953ms** | 5d |
| get_gb_page | 90 | 1,407ms | 7,193ms | 5d |
| get_agency_page | 29 | 3,133ms | 7,765ms | 5d |

3,685 jurisdiction RPC calls in 6d vs 45 human views in 30d ⇒ the RPC load is
**~120× the human page loads** — i.e. dominated by crawler / SSR traffic that
`page_views` cannot see. entity_type labels confirmed:
`jurisdiction / official / agency / governing_body` (not "gb").

## Root cause: cold-buffer reads on the IOWait-bound Pro Small (256MB shared_buffers)

Every section is **trivial warm** — the cost is first-touch disk latency.

- **jurisdiction**: the FIX-663 cache holds **62 rows, and the broad content
  predicate matches EXACTLY 62 of 10,509 active jurisdictions** (re-counted on
  prod). The cache is *already complete for content-bearing jurisdictions* — the
  FIX-680 premise ("refresh scoped to a tiny allowlist, expand it") is **false**;
  the other 10,447 are empty district/county leaf shells. An empty-shell **county**
  `get_jurisdiction_page_live` measured **14.9s cold → 76ms warm** (Stark County);
  empty **districts** are ~90ms. Boundary geometry totals **492MB across ~10.4k
  leaves** (district 367MB, county 125MB) — far over 256MB shared_buffers, so a
  crawler walking the full leaf set cold-reads geometry that cannot stay resident.
- **agency** (121 active): cold 3.2s / 0.9s / 0.2s. Per-section decomposition
  (total_rules 1.5ms via `idx_proposals_metadata_agency_id`, etc.) shows **no
  dominant section** — a scatter of cold index/heap touches. FIX-664 already fixed
  the spend section; the residual is the scatter.
- **gb** (418 active): cold 7.1s / 0.6s / 0.15s. No PostGIS; scatter across
  proposals/officials/votes (each section <12ms warm).
- **official** (26,915 active): cold 33ms / 551ms / 33ms — fast even cold; the
  7.95s tail is a handful of heavy officials hit by crawlers.

## Decision gate (per type)

| Type | Cardinality | Cache size if full | Stays resident? | Decision |
|---|---|---|---|---|
| **agency** | 121 | ~few MB | **yes** | **CACHE** (FIX-681) |
| **gb** | 418 | ~few MB | **yes** | **CACHE** (FIX-681) |
| jurisdiction | 10,509 (62 content) | ~1GB (SVG payloads) | **no** | content set already cached; **no expansion** — bot-shed |
| official | 26,915 | large | no | mostly fast; **no cache** — bot-shed |

The asymmetry is **cache residency**, not request concentration: a 121/418-row
cache is small enough to stay warm in shared_buffers and so a single PK read
genuinely replaces the cold scatter. A 10k/27k-row payload cache (~1GB) would not
stay resident — it would only *shift* the cold read, not remove it — and its
nightly refresh would re-read ~492MB of static geometry for zero content change
(the "no heavy prod ops" hazard). For one-shot crawler hits on unique leaf
entities, the durable fix is **bot protection** (robots noindex on empty leaf
jurisdiction/district/county + official pages, Upstash request caps) — filed as a
separate 🟠 FIX per the decision gate.

### Key reframing for FIX-680 (🔴)

The recurring jurisdiction `canceling statement` log lines are **crawler-induced
on empty-shell geometry, not user-facing degradation**: real users hit the 62
content-bearing jurisdictions, which are all cached and fast. FIX-680's cache is
already complete; the residual is a crawler problem routed to the bot-shed FIX.

## What ships now (FIX-681)

`agency_page_cache` + `gb_page_cache`, mirroring FIX-663 exactly: rename body →
`get_<type>_page_live(uuid)` UNCAPPED; `get_<type>_page(uuid)` thin plpgsql
wrapper (cap = withDbTimeout: agency 3s, gb 3s) reads cache by PK with explicit-IF
`_live` fallback; `refresh_<type>_page_cache()` UPSERTs all active rows; hooked
into the nightly tail (rebuild-entity-connections.ts) after the jurisdiction
refresh, with an explicit session `statement_timeout` on the direct-pg path
(proconfig is not honored through the session pooler — FIX-500/663). Covers
`institutions/[id]` too (it branches to get_agency_page / get_gb_page; there is no
get_institution_page).
