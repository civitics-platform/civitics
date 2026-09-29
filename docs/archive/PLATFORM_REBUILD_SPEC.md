# Platform Rebuild Spec

**Status:** Draft, authored 2026-04-19 at the end of an audit/triage session.
Intended as the starting context for a fresh Cowork session.

**Owner decisions required** (marked inline below). Everything else is open for
the next session to investigate.

---

## Why we're doing this

Phase 1 was declared ~88–90% complete in March 2026. Integrity-audit work in
mid-April surfaced deeper issues than a checklist can fix:

- 827 contaminated rows in `proposals` (court cases + vote-questions shoved into
  a legislation table)
- 216,551 votes anchored to pseudo-proposals via `votes.proposal_id`, not to
  the bills they actually voted on
- `officials.metadata->>'state'` duplicates `jurisdiction_id` FK data and
  disagrees with it
- Three separate pipelines asserted enum values that disagreed with the schema
  CHECK constraint

These aren't data bugs — they're schema and ingestion design bugs. Bandaiding
them fix-by-fix is spinning in the weeds. With no users, no production traffic,
and ~270MB of re-ingestible data, the cost of a clean rebuild is lower than
the cost of continuing to bandaid.

This is the platform Phase 2 launches from. We want it to still be the right
shape in 2028.

## Goals

- Audit-green on first run after rebuild, not after N retries.
- Schema constraints that reject the bug classes we've been chasing (no `title`
  that looks like `On Passage`, no enum drift, no duplicate state-of-record).
- Local-data story (city councils, mayors, school boards) as a first-class
  citizen, not a Phase 2 afterthought.
- New data-source surface that materially enhances the connection graph — more
  edges, not just more rows.
- Foundation sturdy enough that grant applications (Knight, Mozilla, Democracy
  Fund) read "recently rebuilt on clean foundations" rather than "Phase 1
  cleanup ongoing."

## Non-goals for this rebuild

- Touching user-facing features. UI follows schema, not the other way around.
- `/apps/social` or COMMONS/blockchain work.
- Rewriting FEC donations ingestion unless investigation shows it's also broken.
- Phase 2 feature work (maps, accountability tools) — those sit on top of the
  new foundation, not inside this rebuild.

---

## Known architectural issues (confirmed)

### Proposals table is a dumping ground

- `packages/data/src/pipelines/congress/votes.ts:886` inserts vote-question
  strings as proposals (435 rows; 216k votes depend on them)
- `packages/data/src/pipelines/courtlistener/index.ts:259` inserts court cases
  as proposals (393 rows; 0 vote refs, safe to remove)
- No type discrimination, no CHECK on title, no FK back to a source system
- Fix options: (a) unified `proposals` with strict `source_type` enum +
  polymorphic source FK, or (b) separate tables: `bills`, `resolutions`,
  `regulations`, `court_cases`. **Decision needed.**

### Votes don't attach to bills — they attach to vote-questions

- `metadata->>'legis_num'` is available at ingest time but not used for linking
- Consequence: user sees "Vote on 'On Passage'" with no bill context — broken
  even at the UX level
- Fix: at ingest, resolve `legis_num` → bill row; if the bill isn't in yet,
  queue the vote for retry rather than synthesizing a fake proposal

### Officials/jurisdictions has duplicate state sources

- `officials.metadata->>'state'` and `metadata->>'state_abbr'` are ad-hoc JSON
  fields set by ingestion
- `officials.jurisdiction_id` is a proper FK to `jurisdictions.short_name`
- They disagree — the audit read the JSON and got null for all 100 senators
  (FIX-071 symptom); FK path returns correct values
- Fix: FK is canonical, drop or derive the JSON mirror. Same pattern likely
  lurks on other entities — grep for `metadata->>` in queries to find them.

### Enum values asserted in multiple places instead of one

- Schema CHECK constraint is ground truth; TS pipelines + CLAUDE.md disagreed
  (FIX-073 surfaced `not_voting` vs `not voting`)
- Likely pattern elsewhere — anywhere a TS string literal matches a schema enum
- Fix: codegen a single enum module from migration CHECK constraints; pipelines
  import from it; CLAUDE.md references the generated file, not its own copy

## Known architectural issues (suspected — confirm in Stage 0)

- `proposals.metadata` JSON blob: what app code reads it? Which fields should
  be first-class columns? JSON metadata is a bug factory.
- `entity_connections` schema consistency with `/packages/graph` expectations
- `entity_tags` and `ai_summary_cache` linkage — FK or string-match on
  `entity_id`? String-match means no referential integrity.
- OpenStates pipeline: does state legislators ingestion have the same
  "dump JSON into metadata" issue as federal officials?
- FEC donations: do donations link to officials/committees via FK or via
  string match on names?
- Regulations.gov pipeline: are regulations `proposals` with a different type,
  or do they have their own table? (Architecture unclear.)

Next session should run:

```bash
grep -rn '\.from("[^"]*")\.\(insert\|upsert\)' packages/data/src/pipelines/
```

…and catalog every writer: what table, what columns, any JSON blobs, any FK
lookups attempted, any retry/queue logic. That table is the foundation for
Stage 0 design.

---

## New data sources to research

The goal here is "enhance the connection graph," not "pile on rows." Each
source should earn its place by the edges it adds.

### Federal legislative (verify whether we already have)

- Cosponsorships — rich edges (official ↔ bill), probably already via
  congress.gov API, verify ingestion
- Committee memberships and committee reports
- Bill actions history (status over time — committee referrals, floor action,
  veto, etc.)
- Congressional Record / floor speeches (linkage to votes)

### Executive branch

- Executive orders
- Presidential appointments + Senate confirmations (edges: president ↔
  appointee ↔ confirming senators)
- Agency rulemakings via regulations.gov (confirm current coverage)
- Federal Register

### Judicial

- Court decisions (courtlistener — needs its own table, not `proposals`)
- Judicial appointments (ties to executive + Senate)
- SCOTUS oral arguments (Oyez API)

### Money in politics

- FEC donations (have it — audit-check whether it links cleanly)
- State campaign finance — 50 different systems; **FollowTheMoney.org**
  aggregates most of them (check API terms)
- Senate LDA lobbying disclosures
- House LD-203 filings
- State lobbying registrations (highly variable)
- OpenSecrets aggregations

### Spending and contracts

- USAspending.gov — federal spending awards (edges: agency ↔ contractor ↔
  district affected)
- SAM.gov — federal contracts

### Local government — first-class Phase 2 requirement

No unified national API exists. Candidates:

- **Ballotpedia** — best single source, but licensing and scraping terms TBD
- **Google Civic Info API** — deprecated but partially functional; may not
  last
- **OpenStates** — has some local jurisdictions (varies)
- **Vote.gov** — limited
- Individual state/municipal sites — scraping infrastructure, 50 flavors
- **OpenElections** — historical election results
- **Who's On The Ballot** — candidate data

Scope decision needed (see Decisions below).

### Accountability context

- News article ingestion (NewsAPI, GDELT) — link officials + proposals to
  coverage
- Fact-check databases (PolitiFact, FactCheck.org) — edges to claims

### Geographic

- Census demographic data (ties to districts, enables "who does this affect"
  analysis)
- District shapefiles (have via `/packages/maps`, verify)

---

## Design principles for the rebuild

1. **Source → transform → load.** Pipelines transform raw API responses into
   clean relational rows before insert. No "dump the JSON blob and hope."
2. **Strict types everywhere.** CHECK constraints, FKs, NOT NULLs. DB rejects
   bad writes before they happen.
3. **Single source of truth per field.** If a field lives in a FK, it doesn't
   also live in JSON.
4. **Enum values come from the migration, not from TS.** Generated constants
   imported everywhere the enum is asserted.
5. **Linkable at ingest.** If source data has a foreign key candidate
   (`legis_num` → bill), use it or queue for retry. No synthesizing placeholders.
6. **Graph-first.** Every entity has obvious connection edges expressible as
   FKs, not through JSON joins. "What connects to what" should be answerable
   by schema inspection alone.
7. **Re-runnable.** Any pipeline runs from scratch without duplicating rows
   (idempotent on source-id keys).
8. **Audit-as-contract.** For every new pipeline, write the audit expectations
   alongside the pipeline. Audit green on first post-rebuild run is the bar.

---

## Proposed staging

### Stage 0 — Investigation + design (next 1–3 Cowork sessions)

- Grep all pipeline writers, catalog current vs. intended schema
- Map full connection-graph edge inventory (what edges exist, what should exist)
- Research local-data sources, pick pilot scope
- Decide unified-vs-split proposals structure
- Draft new migrations (not applied), ingestion transform contracts, audit
  expectations
- Output: a PR with migration files + doc-only changes. Nothing touches prod.

### Stage 1 — Shadow rebuild (Claude Code locally + new Supabase project)

- Fresh Supabase project, upgraded tier
- New schema applied
- All pipelines rewritten to new contracts, re-run against shadow project
- Audit green
- Row-count sanity check vs. old project

### Stage 2 — Cutover

- Point prod env (Vercel) at shadow project (swap URL + keys)
- Archive old project read-only
- Rerun AI enrichment via the queue pipeline that's already built
- Feature work resumes on clean foundation

### Stage 3 — Local data rollout

- Pilot N cities with best data availability
- Build per-jurisdiction ingestion infrastructure
- Expand incrementally by metro size or state

### Stage 4 — New data-source rollout

- Each new source gets its own migration + pipeline + audit expectations
- Added to a rolling integration in priority order: cosponsorships, lobbying,
  USAspending, etc.

---

## Decisions required from Craig

1. **Supabase tier target.** Pro ($25/mo, ~8GB ceiling) is probably fine for
   current + 2–3x growth. Team ($599/mo) unlocks PITR, compliance features,
   higher limits. If local data is ambitious, Team may justify itself. Pick
   based on grant-funding timeline.

2. **Proposals structure.** Unified `proposals` with `source_type` enum and
   polymorphic FK, or separate tables per source (`bills`, `resolutions`,
   `regulations`, `court_cases`)? Both work; split is cleaner, unified is
   fewer joins.

3. **Local data pilot scope.** Options:
   - Top 5 cities where data is easy (NYC, LA, Chicago, SF, Seattle-ish)
   - Every state capital (50 cities, broad geographic coverage)
   - Top 50 metros by population (meaningful national coverage)
   - Full buildout (thousands of municipalities — probably Stage 3b)

4. **Keep vs. rewrite FEC donations.** Default keep; flip only if Stage 0
   investigation finds it's structurally broken.

5. **Connection graph backing store.** Keep `entity_connections` as-is, or
   rebuild alongside the rest? Depends on what Stage 0 investigation reveals.

6. **AI enrichment replay strategy.** Replay the whole queue, or selectively
   enrich high-priority entities first?

---

## Reference pointers

| What | Where |
|---|---|
| Current schema | `supabase/migrations/0001_initial_schema.sql` + timestamped April migrations |
| Pipeline writers | `packages/data/src/pipelines/` |
| Audit code | `packages/data/src/pipelines/integrity-audit/` |
| Latest audit report | `docs/audits/2026-04-19.md` |
| FIX tracking | `docs/FIXES.md`, `docs/done.log` |
| App-level architecture | `docs/ARCHITECTURE.md` |
| Phase tracking | `docs/PHASE_GOALS.md` |
| Daily workflow | `docs/OPERATIONS.md` |

### Unresolved FIXes superseded by this rebuild

The following audit-triggered FIXes are likely dissolved by the rebuild and
should be re-filed against the new schema rather than fixed in place:

- **FIX-068**: Seed POTUS official — becomes part of Stage 1 officials ingestion
- **FIX-069**: Seed VPOTUS official — same
- **FIX-070**: Seed 3 missing territory delegates — same
- **FIX-071**: Audit JOIN jurisdictions — audit gets rewritten in Stage 0 anyway
- **FIX-072a**: Stop courtlistener dumping to proposals — superseded by
  `court_cases` table in Stage 0
- **FIX-072b**: Re-anchor 216k votes to real bills — becomes the central
  design question of Stage 1

---

## Kick-off prompt for the next Cowork session

> This is the first session on the platform rebuild. Read
> `docs/archive/PLATFORM_REBUILD_SPEC.md` end-to-end. Then start Stage 0 by grepping
> `\.from\("[^"]*"\)\.(insert|upsert)` across `packages/data/src/pipelines/`
> and producing a writer-catalog table: for each call site, the table written,
> the columns inserted, any JSON blob usage, any FK lookups attempted, and
> any retry/queue logic. That catalog is the input to the schema design work.
>
> Do not touch code or DB yet. Output: one markdown table + a short list of
> "things I wasn't expecting" observations.
