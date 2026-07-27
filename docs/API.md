# Civitics API Reference

Public HTTP endpoints exposed by the Civitics app. All routes live under the
Next.js App Router in [apps/civitics/app/api/](../apps/civitics/app/api/) and
run as serverless functions on Vercel.

> **Status:** These are the current internal endpoints. The institutional API
> (Phase 2) will expose a versioned `/api/v1/` surface with stable contracts,
> `updated_after` filters, API keys, and tier-based quotas. The routes below
> are intended for the Civitics UI and may change.

Last updated: 2026-04-18.

---

## Conventions

- **Base URL:** `https://civitics.com` (prod) · `http://localhost:3000` (dev)
- **Format:** JSON request bodies and JSON responses
- **Auth:** Supabase session cookie (set via `/auth/*` flows). Endpoints that
  require auth return `401 { "error": "Sign in to ..." }` when the session is
  missing.
- **Error shape:** `{ "error": "human-readable message" }` with an appropriate
  HTTP status code. Successful responses never include an `error` field.
- **Dates:** ISO-8601 `TIMESTAMPTZ` strings (e.g. `"2026-04-18T14:30:00Z"`).
- **IDs:** UUID v4 unless noted.
- **Money:** integer cents, never floats. Convert to dollars in the UI.
- **Privacy:** coordinates are coarsened to ~1 km before any DB lookup; no precise geolocation is stored.

### Rate limiting

In-memory sliding window per IP, enforced in [apps/civitics/middleware.ts](../apps/civitics/middleware.ts):

| Bucket | Routes | Limit |
|---|---|---|
| `search` | `/api/search*` | 30 / min |
| `graph_ai` | `/api/graph/narrative` | 5 / min |
| `graph` | `/api/graph/*` (other) | 60 / min |
| `graph_entities` | `/api/graph/entities` | 20 / min (route-local) |
| `graph_snapshot` | `/api/graph/snapshot` diagnostic mode | 10 / min (route-local) |

Exceeding a limit returns `429` with a `Retry-After` header (seconds).

---

## Public data

### `GET /api/search`

Universal search across officials, proposals, agencies, and financial entities.
Uses Postgres trigram indexes + ILIKE; runs all four searches in parallel.

**Query params**

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | *required* | Minimum 2 characters; shorter queries return empty arrays |
| `type` | `all \| officials \| proposals \| agencies \| financial` | `all` | Limits which collections are searched |
| `limit` | int | `10` | Clamped to 50 |

**Response**

```json
{
  "query": "warren",
  "officials": [
    {
      "id": "uuid",
      "full_name": "Elizabeth Warren",
      "role_title": "Senator",
      "party": "democrat",
      "state": "MA",
      "photo_url": "https://...",
      "is_active": true,
      "relevance_score": 100
    }
  ],
  "proposals":        [{ "id": "...", "title": "...", "status": "open_comment", "type": "...", "comment_period_end": "...", "agency_acronym": "EPA", "ai_summary": "...", "relevance_score": 80 }],
  "agencies":         [{ "id": "...", "name": "...", "acronym": "EPA", "agency_type": "...", "description": "...", "relevance_score": 70 }],
  "financial_entities": [{ "id": "...", "name": "...", "entity_type": "pac", "industry": "...", "total_amount_cents": 1500000, "relevance_score": 60 }],
  "total": 23,
  "timing_ms": 147
}
```

Special query patterns detected automatically:
- Two-letter state abbreviation (e.g. `CA`) → filter officials by state
- Party keyword (`democrat`, `republican`, `gop`, `independent`) → exact party match
- Role keyword (`senator`, `representative`, `congresswoman`) → exact role match

### `GET /api/representatives`

Returns the officials whose district contains the given coordinates. Uses
PostGIS `find_representatives_by_location`.

**Query params:** `lat` (float), `lng` (float) — both required.

**Privacy:** coordinates are coarsened to ~1 km before lookup; precise
values are never logged or stored.

**Response:** `{ "representatives": [{ id, full_name, role_title, party, jurisdiction }] }`

Returns an empty array if district geometry hasn't been loaded.

---

## Proposals

### `GET /api/proposals/[id]/summary`

On-demand plain-language AI summary for a proposal. Cached in `ai_summary_cache`;
subsequent calls are free. Respects a monthly Anthropic spend cap ($4.00) — once
hit, returns `{ "summary": null }` without calling the API.

**Response:** `{ "summary": "..." | null }`

### `GET /api/proposals/[id]/comments`

List community comments for a proposal, newest first, limit 50.

**Response:** `{ "comments": [{ id, body, created_at, upvotes, user_id, is_deleted }] }`

### `POST /api/proposals/[id]/comments` · auth required

Create a community comment.

**Body:** `{ "text": string }` — max 2000 chars, trimmed.
**Response:** `{ "comment": { id, body, created_at, upvotes, user_id, is_deleted } }` (201)

### `GET /api/proposals/[id]/position`

Aggregate position counts for a proposal.

**Response:** `{ "support": N, "oppose": N, "neutral": N, "question": N, "total": N }`

### `POST /api/proposals/[id]/position` · auth required

Record or update the signed-in user's position on a proposal. Inserts a new
row or updates the user's existing row — positions are unique per user per
proposal.

**Body:** `{ "position": "support" | "oppose" | "neutral" | "question" }`
**Response:** `{ "recorded": { id, position, created_at, updated_at } }`

### `POST /api/proposals/[id]/comment`

Submit an official public comment to regulations.gov for a federal proposal.
Always free — this is a constitutional right and is never rate-limited or
gated behind credits.

**Body:**
```json
{ "comment_text": "...", "name": "optional", "org": "optional", "regulations_gov_id": "EPA-HQ-OAR-2024-XXXX" }
```

**Response (success):**
```json
{ "status": "submitted", "confirmation_number": "...", "fallback_url": "https://www.regulations.gov/commenton/..." }
```

**Response (no API key configured):**
```json
{ "status": "no_api_key", "fallback_url": "https://www.regulations.gov/commenton/..." }
```

---

## Officials

### `GET /api/officials/[id]/summary`

On-demand AI civic profile summary. Cached; respects monthly spend cap.

**Response:** `{ "summary": "..." | null }`

### `GET /api/officials/[id]/comments`

List community comments on an official's profile (separate from proposal comments).

**Response:** `{ "comments": [{ id, body, created_at, upvotes, user_id, is_deleted }] }`

### `POST /api/officials/[id]/comments` · auth required

Create a community comment on an official's profile.

**Body:** `{ "text": string }` (max 2000 chars)

### `GET /api/officials/[id]/responsiveness`

Window-by-window response record across the official's initiative response
windows. Counts and a ledger — **not** a score: the `response_rate` percentage
and the A-F `grade` were removed in FIX-905 (public scores with no
minimum-sample floor). Tiered responsiveness lives in `EngagementBadges`.

**Response:**
```json
{
  "responded": 4,
  "no_response": 2,
  "open": 1,
  "total_closed": 6,
  "recent": [{ "initiative_id": "...", "response_type": "...", "responded_at": "...", "..." }]
}
```

---

## Civic initiatives

Initiatives move through stages: `problem → draft → deliberate → mobilise → resolved`.
Each stage gates certain actions (see [docs/CIVIC_INITIATIVES.md](CIVIC_INITIATIVES.md)).

### `GET /api/initiatives`

Paginated list, filterable.

**Query params**

| Param | Values | Default |
|---|---|---|
| `stage` | `problem \| draft \| deliberate \| mobilise \| resolved` | all |
| `scope` | `federal \| state \| local` | all |
| `tag` | issue area tag (e.g. `climate`) | none |
| `page` | int ≥ 1 | `1` |
| `limit` | int ≤ 50 | `20` |

**Response:** `{ "initiatives": InitiativeRow[], "total": N, "page": N }`

### `POST /api/initiatives` · auth required

Create a new initiative or problem statement. Sets `stage` to `problem` when
`is_problem: true`, otherwise `draft`.

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | 10–120 chars |
| `scope` | `federal \| state \| local` | yes | |
| `body_md` | string | required unless `is_problem` | Markdown |
| `summary` | string | no | ≤500 chars |
| `issue_area_tags` | string[] | no | |
| `linked_proposal_id` | UUID | no | |
| `is_problem` | boolean | no | Shortcut for problem-stage creation |

**Response:** `{ "initiative": { id, title, stage } }` (201)

### `GET /api/initiatives/[id]`

Full detail: initiative row + signature counts + responses.

**Response:**
```json
{
  "initiative": { "...full row..." },
  "signature_counts": { "total": N, "constituent_verified": N },
  "upvote_count": N,
  "responses": [{ "id": "...", "official_id": "...", "response_type": "support", "..." }]
}
```

### `PATCH /api/initiatives/[id]` · auth required, author only

Update title / summary / body_md / scope / tags. Only allowed in `draft` or
`deliberate` stages — text is frozen once `mobilise` begins. Body and title
changes snapshot the prior version to `civic_initiative_versions` first.

### `GET /api/initiatives/[id]/versions`

Full version history, newest first.

**Response:** `{ "versions": [{ id, version_number, title, body_md, edited_by, created_at }] }`

### `GET /api/initiatives/[id]/signature-count`

Lightweight count endpoint for polling.

**Response:** `{ "total": N, "constituent_verified": N }`

### `POST /api/initiatives/[id]/sign` · auth required · mobilise stage only

Toggle a signature. If the user has already signed, removes it; otherwise adds
it. Triggers milestone checks after each new signature.

**Response:** `{ "signed": boolean }`

### `GET /api/initiatives/[id]/sign`

Returns whether the current user has signed. Unauthenticated → `{ "signed": false }`.

### `GET /api/initiatives/[id]/follow`

Returns follow status + total follower count. Safe for unauthenticated users.

**Response:** `{ "following": boolean, "count": N }`

### `POST /api/initiatives/[id]/follow` · auth required

Toggle follow state. `DELETE` has the same effect.

### `POST /api/initiatives/[id]/upvote` · auth required

Toggle upvote. Returns updated count.

**Response:** `{ "upvoted": boolean, "count": N }`

### `GET /api/initiatives/[id]/upvote`

Returns whether the current user has upvoted.

### `GET /api/initiatives/[id]/gate`

Compute the quality gate signals for the `deliberate → mobilise` transition
(argument count, side balance, supporter density, etc.). Available publicly,
but typically shown only to the author.

**Response:** `{ "can_advance": boolean, "signals": GateSignal[], "checked_at": "..." }`

### `POST /api/initiatives/[id]/advance` · auth required, author only

Advance to the next stage. Two valid transitions:
- `draft → deliberate` — no gate, author decision
- `deliberate → mobilise` — runs the quality gate; returns `422` with the gate payload if it fails

**Response (success):** `{ "stage": "...", "message": "...", "gate"?: {...}, "mobilise_started_at"?: "..." }`

### `POST /api/initiatives/[id]/link-proposal` · auth required, author only

Link or unlink a legislative proposal to the initiative.

**Body:** `{ "proposal_id": "uuid", "unlink"?: boolean }`

### `POST /api/initiatives/[id]/respond` · auth required

Record an official's response to an initiative with an open response window.
`is_verified_staff` is set automatically when the submitter's email ends in
`.gov`.

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `official_id` | UUID | yes | |
| `response_type` | `support \| oppose \| pledge \| refer` | yes | |
| `body_text` | string | no | ≤2000 chars |
| `committee_referred` | string | if `refer` | |

### `GET /api/initiatives/[id]/arguments`

All arguments for the initiative, assembled into a recursive reply tree,
sorted by vote count then creation time. Soft-deleted bodies are returned
as `"[deleted]"`.

**Response:** `{ "comments": CommentTree[], "total": N }`

### `POST /api/initiatives/[id]/arguments` · auth required · deliberate/mobilise/problem only

Submit a top-level argument or a reply. `comment_type` determines whether
`side` is required:

- Sided types (`for`, `against`, `support`, `oppose`) require `side`
- Unsided types (`concern`, `amendment`, `question`, `evidence`, `precedent`, `tradeoff`, `stakeholder_impact`, `experience`, `cause`, `solution`, `discussion`) don't
- During the `problem` stage, `side` is never required

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `body` | string | yes | 10–1000 chars |
| `comment_type` | enum | no | See above |
| `side` | `for \| against` | conditional | See above |
| `parent_id` | UUID | no | Reply target, must belong to same initiative |

### `POST /api/initiatives/[id]/arguments/[argId]/vote` · auth required

Toggle a vote on an argument.

**Response:** `{ "voted": boolean, "vote_count": N }`

### `POST /api/initiatives/[id]/arguments/[argId]/flag` · auth required

Flag an argument. Idempotent — one flag per user per argument. Can't flag
your own argument.

**Body:** `{ "flag_type": "off_topic" | "misleading" | "duplicate" | "other" }`

---

## Connection graph

The graph is the core product — it renders officials, donors, agencies,
proposals, and the typed edges between them. All graph routes are public
and return `Cache-Control: public, max-age=30, s-maxage=30` where noted.

See [docs/ARCHITECTURE.md](ARCHITECTURE.md#the-graph-package) for the
`GraphView` model and connection-type catalogue.

### `GET /api/graph/search`

Fast fuzzy entity search for graph seeding. Thin wrapper around the
`search_graph_entities` RPC with connection counts attached.

**Query params:** `q` (min 2 chars).

**Response:** `SearchRow[]` — `id`, `label`, `entity_type`, `subtitle`, `party`, `connection_count`.

### `GET /api/graph/entities`

Like `/api/graph/search` but with richer per-entity metadata (tags, state,
federal/state flag, `has_donations`, `has_votes`) and a `type` filter.

**Query params:** `q` (min 2 chars), `type` (`official | agency | financial | proposal`).
**Rate limit:** 20/min/IP (route-local).

### `GET /api/graph/connections`

Primary graph expansion endpoint. Returns nodes + edges for a focus set.

**Query params** (subset — see [apps/civitics/app/api/graph/connections/route.ts](../apps/civitics/app/api/graph/connections/route.ts)):

| Param | Notes |
|---|---|
| `entity_ids` | Comma-separated UUIDs (up to 5) |
| `depth` | `1 \| 2 \| 3` |
| `scope` | `all \| federal \| state \| senate \| house` |
| `include_procedural` | `true` to include procedural votes (hidden by default) |
| connection-type filters | Per type: `enabled`, `min_amount`, `date_start`, `date_end` |

**Response:** `{ "nodes": GraphNode[], "edges": GraphEdge[] }`

Nodes with ≥50 connections at depth 2 are returned **collapsed** (user clicks
to expand) to prevent freezing on high-fanout entities like "Individual Contributors".

### `GET /api/graph/chord`

Aggregated donor-industry × party flows for the chord visualization.

### `GET /api/graph/treemap` · `GET /api/graph/treemap-pac`

Donor breakdown by industry / PAC.

### `GET /api/graph/sunburst`

Radial drill-down from a focus node.

### `GET /api/graph/group`

Aggregate flows for a group of entities. Useful for "all Senate Democrats"
style queries.

**Query params:** `groupId`, `entity_type`, `chamber`, `party`, `state`, `industry`, `groupName`, `groupIcon`, `groupColor`, `limit`.

### `POST /api/graph/pathfinder`

Find a path between two entities via recursive CTE BFS.

**Body:** `{ "from_id": "uuid", "to_id": "uuid", "max_hops"?: 1-4 }`
**Response:** `{ "path": [...] | null }`

### `POST /api/graph/narrative` · rate-limited (5/min)

AI-generated 2–3 sentence factual narrative describing a graph view.
Uses Claude Haiku with a strict "no editorializing, no motive attribution"
system prompt.

**Body:** `{ "vizType": "...", "entityNames": string[], "activeFilters": string[] }`
**Response:** `{ "narrative": "..." }`

### `GET /api/graph/snapshot?code=...`

Fetch a shared graph snapshot by share code.

### `POST /api/graph/snapshot`

Create a share-code snapshot. Body: serialized `GraphView`.

### `GET /api/graph/snapshot?viz=...&entity_name=...`

Diagnostic mode. Verifies data availability for a viz without creating a
share code. No auth. Rate-limited to 10/min/IP.

---

## Internal / admin

These are not part of the public API surface. Many require specific env vars
or an admin session and may be restricted further in production.

| Route | Notes |
|---|---|
| `GET /api/cron/nightly-sync` | Vercel Cron trigger (02:00 UTC). Requires `Authorization: Bearer $CRON_SECRET`. Records into `data_sync_log`; the scheduler picks up and runs `runNightlySync()`. Set `CRON_DISABLED=true` to halt without a deploy. |
| `GET /api/dashboard/stats` | Platform-wide counts for the public dashboard. |
| `GET /api/dashboard/pipeline-ops` | Pipeline health snapshot. |
| `GET /api/dashboard/anthropic-cost` | Monthly Claude spend rollup. |
| `GET /api/claude/status` · `GET /api/claude/snapshot` | AI service health. |
| `GET /api/platform/usage` · `GET /api/platform/vercel` · `GET /api/platform/anthropic` | External service usage (admin). |
| `POST /api/admin/run-pipeline` · `GET/POST /api/admin/budget-config` | Admin-only operational controls. |
| `POST /api/track-view` · `POST /api/track-usage` | Client-side page-view and feature-usage telemetry. No-op in development. |

---

## Planned — institutional API (Phase 2)

The public-facing versioned API is [on the roadmap](ROADMAP.md). Expected
shape:

- `GET /api/v1/officials` · `GET /api/v1/officials/{id}` (with `updated_after`)
- `GET /api/v1/proposals` · `GET /api/v1/proposals/{id}`
- `GET /api/v1/votes` · `GET /api/v1/donations` · `GET /api/v1/agencies`
- `GET /api/v1/connections/path?from=&to=` — the investigation superpower
- API keys per organization, tier-based quotas (Researcher / Nonprofit / Professional / Enterprise)

Once `/api/v1/` launches, the routes on this page are considered internal and
may change without notice.
