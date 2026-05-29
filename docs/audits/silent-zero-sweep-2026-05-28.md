# Silent-Zero Query-Pattern Sweep — 2026-05-28

**Type:** static, read-only source audit (no live DB, no prod access). All schema/RLS
facts verified against `supabase/migrations/*.sql` (migrations are ground truth).

**Method:** multi-agent workflow — Phase 1 built two ground-truth artifacts (table→columns
+ metadata-keys map; role-aware RLS policy inventory) from migrations and swept the two
facts-independent patterns (3, 4); Phase 2 fanned the three facts-gated patterns (1, 2, 5)
across scope dirs (pattern 1 ×5, pattern 2 ×4, pattern 5 ×3); Phase 3 ran one
adversarial "refute-by-default" verifier per CONFIRMED finding, with *later migration wins*.
64 subagents total. The orchestrator (single writer) then reconciled the adversarial
verdicts against source + migrations before filing FIXes — the adversarial pass returned
**internally inconsistent verdicts on structurally identical code**, so every survivor was
re-checked by hand against the actual file and the cited migration.

**Confidence gating:** CONFIRMED = the schema/RLS fact (or, for patterns 3/4, the
source-level handling) is provably verified against a migration/source line. SUSPECTED =
pattern matches but needs human/runtime judgment (e.g. reachability). A grep hit alone is
never CONFIRMED.

---

## Count-by-pattern summary

| # | Pattern | Precedent | Sites scanned | CONFIRMED (filed) | SUSPECTED | Reviewed — not a bug |
|---|---------|-----------|---------------|-------------------|-----------|----------------------|
| 1 | JSONB-path-vs-top-level-column | FIX-303 | ~1,432 filter/select sites | **7** (FIX-425, FIX-426) | 2 | rest verified against real columns |
| 2 | PostgREST 1,000-row cap | FIX-422 | ~180 select sites | **12** (FIX-427, FIX-428, FIX-429, FIX-430) | 0 | — |
| 3 | withDbTimeout truthy/empty-on-timeout | FIX-327 | 18 call sites | **4** (FIX-431) | 10 | 2 (verified fallback-by-design) |
| 4 | vote enum literal | FIX-073 | 23 vote-filter sites | 0 | 0 | **CLEAN** |
| 5 | RLS silent-zero | FIX-398 | ~158 non-admin read sites | **1** (FIX-432) | 0 | rest hit public/auth-guarded tables or admin client |
| — | **Total** | — | **~1,811** | **24 sites / 8 FIXes** | **12** | — |

**Filed this run:** FIX-425, FIX-426, FIX-427, FIX-428, FIX-429, FIX-430, FIX-431, FIX-432
(all in `## BUGS — Fix These First`).

### Key reconciliations (why some adversarial verdicts were overturned)

- **Schema-drift refutation BUSTED.** One verifier marked the `comment_period_end` cluster
  FALSE_POSITIVE citing `.tmp-schema-compare/prod_schema_post_push.sql:1716` (which *does*
  list `comment_period_end` as a real column). That dump is dated **2026-04-19** (gitignored,
  untracked) — **3 days before** the 2026-04-22 cutover (`20260422000000_promote_shadow_to_public`)
  that dropped the old `proposals` table. It is a stale *pre-cutover* snapshot of the OLD
  schema, fully consistent with the migration history, not evidence of current prod state.
- **"PostgREST hard-400s, so it is loud not silent" REFUTED.** The repo's own FIX-303
  migration (`20260520000000:5-9`) states, post-cutover, that the `.gt('comment_period_end',
  now)` filter "was silently no-op-d by PostgREST because comment_period_end is a
  metadata->>... path, not a top-level column." The team observed the silent behavior in
  their own environment; the existence of FIX-303 proves the column is not a working
  top-level column on the live DB. Whether a bare missing column surfaces as a silent
  no-op (filter/order) or an unchecked error→empty (select), the user-facing result is the
  same broken outcome — in scope.
- **Dead-code reachability** demoted two genuine pattern-1 matches in
  `packages/db/src/queries/proposals.ts` to SUSPECTED: the schema fact is proven, but both
  functions are exported-but-never-called (only re-exported from the `@civitics/db` barrel).

---

## Pattern 1 — JSONB-path-vs-top-level-column mismatch (precedent FIX-303)

**Mechanism:** a PostgREST `.eq/.gt/.gte/.lt/.lte/.in/.filter/.order`/`.select()` referencing
a bare column that is not a real top-level column on the table. The filter/order silently
no-ops (returns unfiltered/unordered rows) or the projected column comes back null — no error.

### CONFIRMED → FIX-425 — `comment_period_end` (+`agency_id`) bare-column cluster on `proposals`

`comment_period_end` was a real column only in the old `proposals` table
(`0001_initial_schema.sql:248`), dropped at the cutover; `agency_id` is and always was
metadata-only. Post-cutover both live in `metadata` JSONB (confirmed by the expression
index `20260524100001_fix_b_proposals_metadata_expr_indexes.sql:61-62` on
`metadata->>'comment_period_end'`, and the GROUP BY `metadata->>'agency_id'` in
`20260520000000`).

| File:line | Snippet | Effect |
|---|---|---|
| `apps/civitics/app/api/search/route.ts:377` | `.select("…, comment_period_end, metadata, …")` | column returns null |
| `apps/civitics/app/api/search/route.ts:382` | `.gte("comment_period_end", filterDateFrom)` | date-from filter silently no-ops |
| `apps/civitics/app/api/search/route.ts:383` | `.lte("comment_period_end", filterDateTo)` | date-to filter silently no-ops |
| `apps/civitics/app/api/search/route.ts:389` | `.order("comment_period_end", …)` | ordering silently no-ops (insertion order) |
| `apps/civitics/app/api/search/entity/route.ts:94` | `.select("…, comment_period_end, …")` | "Comment deadline" detail field always null |
| `apps/civitics/app/api/proposals/[id]/summary/route.ts:76` | `.select("…, comment_period_end, agency_id")` | `isOpen` check + agency lookup both read null → **AI summary never generated** for any proposal; agency line always "Federal Agency" |

**Migration evidence:** `20260421000002_stage1_03_proposals.sql:19-49` (shadow.proposals has
no `comment_period_end`/`agency_id`); `20260422000000_promote_shadow_to_public.sql:265,295`
(old table dropped, shadow promoted); `20260520000000_get_proposal_counts_by_agency.sql:5-9`
(documents the silent no-op); `20260524100001:61-62` (metadata expression index).
**Action:** rewrite to `metadata->>'comment_period_end'` / `metadata->>'agency_id'`.
**Precedent:** FIX-303, FIX-359.

### CONFIRMED → FIX-426 — rule-tagger selects nonexistent `votes.proposal_id`

`packages/data/src/pipelines/tags/rules.ts:383` — `.from("votes").select("official_id,
proposal_id, vote")`. `votes` has no `proposal_id`; the real FK is `bill_proposal_id`
(`20260421000003_stage1_04_votes_meetings.sql`), used correctly at **line 795 of the same
file**. `v.proposal_id` is therefore `undefined`, so `votesByOfficial` and
`yesVotesByProposal` (lines 403-414) are keyed on `undefined` and the bipartisan /
cross-party vote-pattern tags are built from broken indexes → wrong/zero tags written to
`entity_tags` (surfaced on official profiles).
**Action:** project `bill_proposal_id` and update the map keys. **Precedent:** FIX-303.

### SUSPECTED — `packages/db/src/queries/proposals.ts` (dead-code helpers)

Schema fact proven, but both functions are exported-but-uncalled (only re-exported from the
`@civitics/db` barrel at `index.ts:41-42`), so no live read path today. Fix-or-delete:

- `:35` `listOpenForComment` — `.gt("comment_period_end", now).order("comment_period_end")`
  on the bare column. If wired up, returns *all* proposals (filter no-ops) or throws
  (`if (error) throw`). Same class as FIX-425.
- `:105` `getProposalByRegulationsGovId` — `.eq("regulations_gov_id", …).maybeSingle()`.
  `regulations_gov_id` was a real column in `0001_initial_schema.sql:249` but is absent from
  shadow.proposals. With a silent no-op + `.maybeSingle()` this could return an **arbitrary
  wrong proposal** (the first row) rather than the intended one — worth flagging even though
  dead.

### Reviewed — not a bug

The ~1,400 other pattern-1 filter/select sites resolve to real top-level columns (verified
against migrations) or correctly use `metadata->>'…'` syntax. `packages/data` (467 sites)
came back clean — all metadata keys (`agency_id`, `comment_period_end`, `state`, `level`,
`district`, `org_classification`, `district_jurisdiction_id`, `fec_office_state`) accessed
via correct `metadata->>` / `.metadata?.key` syntax.

---

## Pattern 2 — PostgREST 1,000-row default cap (precedent FIX-422)

**Mechanism:** an exhaustive `.select()` on a growable table with no `.range()` pagination
loop and no intentionally-small `.limit()`. **Foundation verified:** `supabase/config.toml:9`
→ `max_rows = 1000`. Past 1,000 rows the result silently truncates; downstream
Map/Set/array consumption treats the prefix as complete.

### CONFIRMED → FIX-427 — rule-tagger unbounded full-table loads (🔴)

`packages/data/src/pipelines/tags/rules.ts` loads whole tables, no pagination, consumed as
complete Maps:

| Line | Load | Consumed as | Table size risk |
|---|---|---|---|
| `:365` | `officials` (`select(id, full_name, party, …)`) | `officials.length` + per-row loop | growable (state legislators, city councils) |
| `:388` | `financial_relationships` donation→official | `donorIds` Set + `donationsByOfficial` map | **~1M rows on prod** (per packages/data/CLAUDE.md: 959,010 indiv donation rows) |
| `:778` | `proposals` (`select(id, title)`) | `proposalTitles` map; `.get() ?? "Unknown proposal"` at :795 | ~73k rows (`20260524100001:14`) |

At ~1M `financial_relationships` the tagger sees ~0.1% of donations → donor-pattern tags
(`pac_heavy`/`grassroots`/`large_donor_funded`), bipartisan and `pre_vote_timing` tags are
computed from a truncated prefix and written wrong to `entity_tags`.
**Action:** `.range()` pagination loops (or server-side aggregation) before building maps.
**Precedent:** FIX-422, FIX-219.

### CONFIRMED → FIX-428 — graph connections route, `entity_connections` (🟠)

`apps/civitics/app/api/graph/connections/route.ts` — unbounded `.select()` on
`entity_connections` (derived table, scales to ~1.9M edges) at lines **239, 240** (neighbor
connection counts → auto-expand decision at :254), **264, 265** and **339, 340** (auto-expand
+ top-10 edge hydration → `connMap` for rendering). High-degree nodes silently cap at 1,000:
neighbor counts undercount (wrong collapsed/expanded state) and edges past 1,000 vanish from
the graph with HTTP 200. **Migration:** `20260421000005_stage1_06_entity_connections.sql`.
**Action:** `.limit(1001)` overflow detection or `.range()` per entity. **Precedent:** FIX-422.

### CONFIRMED → FIX-429 — notify-followers cron, `user_follows` (🟡 latent)

`apps/civitics/app/api/cron/notify-followers/route.ts:51` and `:115` — `user_follows`
filtered only by `entity_type`, no pagination, deduped into Sets treated as the complete
follower set for notification fan-out (admin client → RLS bypassed, max_rows still applies).
Once any `entity_type` exceeds 1,000 follows, followers past the first 1,000 silently get no
notifications. Dormant at current scale; correctness landmine on growth.
**Migration:** `20260418200000_community_auth.sql:38-46`. **Action:** `.range()` loop.

### CONFIRMED → FIX-430 — ai-tagger active-officials count load (🟡 internal)

`packages/data/src/pipelines/tags/ai-tagger.ts:616` — `.select("id").eq("is_active", true)`
with no limit (sibling proposals load at :613 uses `.limit(2000)`); untagged count computed
from `(data ?? []).filter(...).length` at :623. Past 1,000 active officials the count is
wrong, skewing the cost-gate estimate (the non-`onlyNew` branch at :628 already uses
`head:true` count correctly). Internal estimate only. **Action:** use `{count:'exact',
head:true}` or paginate.

---

## Pattern 3 — withDbTimeout truthy/empty-on-timeout (precedent FIX-327)

**Mechanism:** `withDbTimeout` (`apps/civitics/src/lib/supabase-check.ts:56`) resolves
`{data:null, error}` on timeout (and passes structural errors through, logging but not
changing shape). Callers that destructure only `data`/`count` and ignore `error` render
empty/zero indistinguishably from real data. 18 call sites reviewed.

### CONFIRMED → FIX-431 — the genuinely-misleading subset (🟠)

- `apps/civitics/app/api/graph/connections/route.ts:206, 215` — line **224 throws only on
  `donationsRes.error`**, then lines 226-228 merge `votesRes.data` and `oversightRes.data`
  blind. On a votes/oversight timeout the graph silently drops those edge types and returns
  HTTP 200 — a **partial graph presented as complete**. (Verified directly: only
  `donationsRes.error` is checked.)
- `apps/civitics/app/api/graph/connections/route.ts:391` — chunked `financial_entities`
  loads, per-result `error` unchecked → a timed-out chunk silently drops those entities.
- `apps/civitics/app/page.tsx:354` — `liveDonorRes.count ?? 0` with no error check → homepage
  donor-records hero stat renders **0** on timeout.

**Action:** check `error`/timeout before consuming; surface stale/empty state, not silent
zero. **Precedent:** FIX-327.

### SUSPECTED (not filed — team to decide on tolerable degradation)

- `entities/route.ts:78,85,92,99` and `graph/search/route.ts:26,33,40,47` — search-autocomplete
  queries (4 entity types each) ignore `error` → **empty autocomplete** on timeout. Same
  pattern as the filed connections sites, but an empty autocomplete on a transient timeout is
  arguably honest degradation rather than misleading data. Flagged for a deliberate call.
- `page.tsx:311` (`homepage_stats_mv`) — primary path destructures `data` without checking
  `error`; a fallback exists at :352 but keys off `data` shape, not `error`.
- `page.tsx:569` (`official_homepage_stats_mv`) — `.in(...).data ?? []` with no error check;
  the MV is a fast indexed lookup unlikely to time out under normal load.

### Reviewed — not a bug

`page.tsx:523` (`homepage_agency_counts_mv`) and `:538` (`get_proposal_counts_by_agency` RPC)
— the null→`[]` path correctly triggers the documented MV→RPC→empty fallback cascade
(FIX-330); zeros render as visible zero-count cards via the live-compute fallback, not
silent data loss.

---

## Pattern 4 — vote enum literal (precedent FIX-073) — CLEAN

23 vote-filter sites examined across API routes, client components, query helpers, and
migrations. **Zero findings.** All read-path queries use valid enum literals
(`yes`/`no`/`abstain`/`present`/`not_voting`/`paired_yes`/`paired_no`); no spaced
`'not voting'` on any read path. The ingest normalizer at
`packages/data/src/pipelines/congress/members.ts:209` correctly maps the spaced source form
to `not_voting` on the WRITE path (not a bug). No out-of-enum vote values found.

---

## Pattern 5 — RLS silent-zero (precedent FIX-398)

**Mechanism:** a non-admin client (`createServerClient`/`createBrowserClient`/
`createPublicClient`) reading a table with RLS enabled but no applicable anon/public SELECT
policy gets `count:0`/empty rows with no error. `createAdminClient` bypasses RLS and is never
a pattern-5 bug.

### CONFIRMED → FIX-432 — institution page reads `pipeline_state` via non-admin client (🟡)

`apps/civitics/app/institutions/[id]/page.tsx:485` reads `pipeline_state` with the non-admin
`createServerClient` constructed at line 236. `pipeline_state` has RLS enabled with **zero
SELECT policies** (`0012_entity_tags.sql:107`, commented "No public read — internal pipeline
metadata only. Only service role (admin client) can read/write"). The anon/authenticated read
returns null with no error → `plumLastChange` (plum-book last-updated date) is always blank
regardless of DB state. **Action:** read this one field via `createAdminClient`. **Precedent:**
FIX-398.

### FIX-398 precedent confirmed RESOLVED

`external_source_refs` (the FIX-398 case: RLS-on, zero policies) **now has a public read
policy** via `20260526000002_xsr_public_read_rls.sql` (2026-05-26). The FIX-432 finding above
is a *new* instance of the same class, not a regression of FIX-398.

### Reviewed — not a bug

91 API routes: all reads of NO-READ-POLICY tables (`pipeline_state`, `enrichment_queue`,
`external_relationships`, `status_snapshot`, `connection_type_counts`, `kill_switch_events`,
`supabase_prometheus_state`) use `createAdminClient`. Reads of AUTH-ONLY tables
(`user_follows`, `notifications`, `entity_grants`, …) via non-admin clients are auth-guarded
and rely on row-level RLS filtering (correct). All other non-admin reads hit PUBLIC-READABLE
tables (`officials`, `proposals`, `agencies`, `votes`, `entity_connections`,
`financial_entities`, `financial_relationships`, etc. — all carry `anon, authenticated SELECT
USING (true)` or `USING (is_active = true)` policies).

---

## Constraints honored

Read-only audit — no source edits, no migrations, no `data:*` runs, no DB writes, no prod
access, no file deletions. Only writes: this report + 8 `fix:add` bullets (FIX-425…FIX-432),
all appended to `## BUGS — Fix These First`. No `Fixes:`/`Verified:` trailers and no
`fixes:sync` (net-new bullets + report, no code change).
