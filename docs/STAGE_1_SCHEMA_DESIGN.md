# Stage 1 — Schema Design

Author: Cowork Claude session, 2026-04-19
Status: **Decisions L1–L7 resolved 2026-04-19. Ready to draft migrations.**
Inputs: `archive/STAGE_0_WRITER_CATALOG.md`, `archive/STAGE_1_SCRAPER_RESEARCH.md`, `archive/PLATFORM_REBUILD_SPEC.md`, `project_platform_rebuild_decisions.md`

**Resolved decisions (see Section L for full context):**
- L1: Initiatives → **I-B** (migrate civic_initiatives into proposals.type='initiative' + initiative_details)
- L2: external_source_refs polymorphic FK → **app-level + orphan cleanup job**
- L3: bill_details uniqueness → **denormalize jurisdiction_id + session onto bill_details**
- L4: votes.agenda_item_id → **nullable FK, yes**
- L5: entity_connections → **derivation-only for Phase 1** (no manual edges)
- L6: Cutover deadline → **30-day dual-write window**
- L7: financial_relationships → **keep name, make polymorphic with relationship_type enum**: `donation`, `owns_stock`, `contract`, `gift`, `honorarium`, `loan`, `lobbying_spend`, `other`
- **E.4: spending_records → migrate** (type=`contract`/`grant` in financial_relationships). Conditional on volume control: ingest recent cycles only (~2010+), pre-2016 aggregated by year/agency/recipient rather than line-item.

This doc proposes the Stage 1 schema for the Civitics rebuild. It does **not** rewrite the world — most of the existing schema (`0001_initial_schema.sql`) is good. The rebuild zone is contained: proposals split, votes re-keyed, financial layer rewrite, graph rebuild, plus new tables for meetings, ingestion plumbing, and the claim queue.

The goal of Stage 1 is a **shadow schema** that ingests in parallel with the live system. Cutover is Stage 2. None of this displaces production tables until Craig signs off.

---

## What stays (do not touch)

These tables work and stay as-is:

- `jurisdictions` (good hierarchical model with PostGIS, fits federal → state → county → city → district)
- `governing_bodies` (flexible enough for legislative / executive / judicial / municipal_council / school_board)
- `officials` (clean, source_ids JSONB pattern is fine)
- `agencies`
- `career_history`, `promises`, `spending_records`
- `users`, `civic_comments`, `official_comment_submissions`
- `civic_credit_transactions`, `warrant_canary`
- The PostGIS RPCs `find_representatives_by_location`, `find_jurisdictions_by_location`

## What changes (rebuild zone)

- `proposals` — split into a thin core table + 4 detail tables (the C + (i) pattern)
- `votes` — FK shifts to bill_details, unique key changes to support multiple roll calls per bill
- `financial_entities` + `financial_relationships` — clean-slate rewrite (one canonical donor identity, deterministic merge)
- `entity_connections` — rebuild as a derived table fed by deterministic rules, not the current pile of pipeline-specific writes

## What's new

- `external_source_refs` — multi-source binding for any civic artifact (Legistar + Socrata + OpenStates can co-claim a bill)
- `meetings` + `agenda_items` + `agenda_actions` — Legistar-shaped legislative meeting tracking (drives most sub-state data)
- `enrichment_queue` — formalized prioritized queue for AI summarization, tagging, and delta processing (decision #6)
- `claim_queue` — user-driven district-coverage requests; queued in Stage 1, processor in Phase 2 (decision #3)
- `jurisdictions.coverage_status` — enum for whether we've populated a jurisdiction yet
- `pipeline_state` formalization — single key/value table for all pipeline cursors / egress meters / recency guards
- `data_sync_log` formalization — fix the `pipeline` vs. `pipeline_name` column-name split (Stage 0 finding #11)

---

## Design principles

1. **One canonical key per entity.** No more "5 pipelines, 5 dedup strategies, all using JSON-path filters." Every entity has a real unique constraint backed by a real index. External source IDs go in `external_source_refs`, not as primary dedup keys.
2. **Detail tables for type-specific shape.** The proposals dumping ground in current schema is the source of half the bugs. Core columns shared, type-specific in 1:1 detail tables.
3. **Meetings are first-class.** Legistar (4 of 5 metros) is meeting-centric. Bills, agenda items, and votes hang off meetings, not the other way around.
4. **Ingest differently than display.** Pipelines write raw to `external_source_refs` + detail tables; derived views (`entity_connections`, `proposal_card_view`) are computed downstream. Keeps pipelines dumb.
5. **Schema-complete day one, data-sparse OK.** All jurisdiction levels exist in the schema. Empty jurisdictions get `coverage_status = 'none'` and don't render in citizen-facing UI by default.
6. **Backwards-incompatible cutover, not in-place migration.** Shadow tables in a `shadow` schema (or `_v2` suffix). When Craig signs off, swap. Avoids the in-place migration risk that bit prior phases.

---

## Section A — `external_source_refs`

The single biggest fix this enables: stop using `source_ids->>X` JSONB filters as primary dedup keys. Indexable, cross-table, multi-source, surfacable in admin UI.

```sql
CREATE TABLE external_source_refs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The "this entity comes from where" pointer
  source          TEXT NOT NULL,            -- 'congress_gov' | 'openstates' | 'courtlistener' | 'legistar:seattle' | 'legistar:sfgov' | 'dc_lims' | 'fec' | 'ballotpedia' | 'socrata:data.sfgov.org' | ...
  external_id     TEXT NOT NULL,            -- the source's primary key, exact string
  -- The local entity it points at
  entity_type     TEXT NOT NULL,            -- 'proposal' | 'official' | 'meeting' | 'agenda_item' | 'financial_entity' | 'donation' | 'court_case' | etc.
  entity_id       UUID NOT NULL,            -- FK is enforced by app + cascade triggers, not a real FK (polymorphic)
  -- Source-specific URL for human-readable backlinks
  source_url      TEXT,
  -- Last time this ref was confirmed by the pipeline (for stale-detection)
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Source-specific blob (e.g. legistar matter type, openstates session id)
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Hard uniqueness — one ref per (source, external_id) tuple
  UNIQUE(source, external_id)
);

CREATE INDEX external_source_refs_entity ON external_source_refs(entity_type, entity_id);
CREATE INDEX external_source_refs_source ON external_source_refs(source);
CREATE INDEX external_source_refs_last_seen_at ON external_source_refs(last_seen_at);
```

**Pipeline pattern:** every pipeline writes `external_source_refs` first, then either creates the entity (on insert) or no-ops (if ref exists). Replaces the current `findOrCreate` pattern's race-prone JSON-path lookup.

**Open question:** do we want a true polymorphic FK (PG doesn't support, requires per-type triggers to enforce delete cascade) or are we OK with app-level enforcement? My vote: app-level + a periodic orphan-cleanup job. Trigger-based cascades are tempting but expensive at write time.

---

## Section B — Proposals: core + detail tables

Per Decision #2: **Option C + (i)** — core `proposals` row for any civic artifact, type-specific detail in 1:1 tables.

### B.1 Core `proposals`

```sql
-- Reshape existing proposals table — keep id/timestamps for any data we migrate
CREATE TABLE proposals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                proposal_type NOT NULL,    -- enum extended below
  status              proposal_status NOT NULL,  -- enum extended below
  jurisdiction_id     UUID NOT NULL REFERENCES jurisdictions(id),
  governing_body_id   UUID REFERENCES governing_bodies(id),  -- nullable for citizen initiatives without an official body
  -- Shared display fields — every civic artifact has these
  title               TEXT NOT NULL,
  short_title         TEXT,
  summary_plain       TEXT,                      -- AI-generated summary
  summary_generated_at TIMESTAMPTZ,
  summary_model       TEXT,
  -- Lifecycle dates
  introduced_at       DATE,
  last_action_at      DATE,
  resolved_at         DATE,                      -- enacted | failed | withdrawn date
  -- Display affordances
  external_url        TEXT,                      -- canonical primary source URL
  full_text_url       TEXT,
  full_text_r2_key    TEXT,
  -- Search
  search_vector       TSVECTOR,
  -- Metadata catch-all (kept for soft fields; never primary dedup)
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX proposals_type ON proposals(type);
CREATE INDEX proposals_status ON proposals(status);
CREATE INDEX proposals_jurisdiction_id ON proposals(jurisdiction_id);
CREATE INDEX proposals_governing_body_id ON proposals(governing_body_id);
CREATE INDEX proposals_last_action_at ON proposals(last_action_at DESC);
CREATE INDEX proposals_search_vector ON proposals USING GIN(search_vector);
CREATE INDEX proposals_title_trgm ON proposals USING GIN(title gin_trgm_ops);
```

Note what's *gone* from the old proposals table: `bill_number`, `congress_number`, `session`, `comment_period_*`, `regulations_gov_id`, `congress_gov_url`, `fiscal_impact_cents`. These all move to detail tables where they belong.

### B.2 `bill_details` (legislative bills, federal + state + local)

```sql
CREATE TABLE bill_details (
  proposal_id         UUID PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  bill_number         TEXT NOT NULL,            -- "HR 1234", "SB 567", "Council File 24-1234"
  chamber             TEXT,                     -- 'house' | 'senate' | 'unicameral' | 'council' | 'committee'
  session             TEXT,                     -- "118th Congress", "2024 Regular Session"
  congress_number     INTEGER,                  -- federal-only; null for state/local
  primary_sponsor_id  UUID REFERENCES officials(id),
  fiscal_impact_cents BIGINT,
  congress_gov_url    TEXT,                     -- federal-specific
  legistar_matter_id  TEXT,                     -- local-specific (4 of 5 metros)
  -- Deduplicated against external_source_refs(source, external_id);
  -- secondary local check: (jurisdiction_id, bill_number, session) via proposals join
  UNIQUE(proposal_id)
);

CREATE INDEX bill_details_bill_number ON bill_details(bill_number);
CREATE INDEX bill_details_primary_sponsor ON bill_details(primary_sponsor_id);
CREATE INDEX bill_details_chamber ON bill_details(chamber);

-- Compound uniqueness across bill identifiers (anti-dup safety net)
CREATE UNIQUE INDEX bill_details_unique_per_jurisdiction
  ON bill_details (
    (SELECT jurisdiction_id FROM proposals WHERE proposals.id = bill_details.proposal_id),
    bill_number,
    session
  );
-- ^ may not work as written, will need a generated column or helper view; flagged as open
```

**Open issue:** the compound uniqueness index above as written is invalid PG syntax. Two ways to fix:
- (a) Denormalize `jurisdiction_id` + `session` onto `bill_details` (small dup, indexable)
- (b) Use a unique partial index via a stored function (more complex, brittle)
- My vote: (a) — duplicate the two columns; trigger keeps them in sync from `proposals`.

### B.3 `case_details` (court cases)

```sql
CREATE TABLE case_details (
  proposal_id          UUID PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  docket_number        TEXT NOT NULL,            -- "23-cv-12345"
  court_name           TEXT NOT NULL,            -- "U.S. District Court for the Southern District of New York"
  case_name            TEXT,                     -- "Doe v. Smith"
  filed_at             DATE,
  parties              JSONB NOT NULL DEFAULT '[]',  -- [{name, role, type}]
  outcome              TEXT,                     -- 'pending' | 'settled' | 'judgment_for_plaintiff' | etc.
  outcome_at           DATE,
  courtlistener_id     TEXT,
  pacer_id             TEXT
);

CREATE INDEX case_details_court ON case_details(court_name);
CREATE INDEX case_details_docket_number ON case_details(docket_number);
CREATE INDEX case_details_outcome ON case_details(outcome);
```

Important: removes the current "all federal judges have governing_body_id = senateId" hack flagged in Stage 0 finding #6. Court cases reference courts via `court_name` (and via `judges` link table — see B.6); judges are officials with their own governing_body of type `judicial`. No more proxy.

### B.4 `measure_details` (ballot measures)

```sql
CREATE TABLE measure_details (
  proposal_id        UUID PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  ballot_id          TEXT NOT NULL,             -- "Prop 22", "Measure 110", "Question 3"
  election_date      DATE NOT NULL,
  election_type      TEXT,                      -- 'general' | 'primary' | 'special' | 'runoff'
  measure_type       TEXT,                      -- 'initiative' | 'referendum' | 'bond' | 'constitutional_amendment' | 'recall'
  yes_votes          INTEGER,                   -- post-election
  no_votes           INTEGER,                   -- post-election
  percent_yes        NUMERIC(5,2),
  passed             BOOLEAN,
  text_summary       TEXT,                      -- official ballot text
  ballotpedia_url    TEXT,
  -- Link back to citizen initiative if this measure originated as one
  originating_initiative_id UUID REFERENCES civic_initiatives(id)
);

CREATE INDEX measure_details_election_date ON measure_details(election_date DESC);
CREATE INDEX measure_details_passed ON measure_details(passed);
```

### B.5 `initiative_details` (citizen initiatives — Option I-B, resolved)

Decision: merge existing `civic_initiatives` into the proposals core. New `initiative_details` holds the initiative-specific lifecycle fields; `civic_initiative_signatures` and `civic_initiative_responses` keep their current shape but their FK target is now `proposals.id` instead of `civic_initiatives.id`.

```sql
CREATE TABLE initiative_details (
  proposal_id           UUID PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  -- Lifecycle (parallel to proposal_status; kept as its own column because the stages
  -- map poorly onto proposal_status — an initiative is never "in_committee", for example)
  stage                 initiative_stage NOT NULL DEFAULT 'draft',  -- existing enum
  authorship_type       initiative_authorship NOT NULL DEFAULT 'individual',
  primary_author_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  scope                 initiative_scope NOT NULL DEFAULT 'federal',
  target_district       TEXT,
  -- The initiative body (moved from civic_initiatives.body_md)
  body_md               TEXT NOT NULL,
  issue_area_tags       TEXT[] NOT NULL DEFAULT '{}',
  -- Quality gate + moderation state
  quality_gate_score    JSONB NOT NULL DEFAULT '{}',
  -- Mobilise-phase tracking
  mobilise_started_at   TIMESTAMPTZ,
  signature_threshold   INTEGER,                 -- configurable per jurisdiction/scope
  -- Resolution
  resolution_type       initiative_resolution,    -- existing enum
  -- If graduated into a ballot measure or bill, point to the downstream proposal
  promoted_to_proposal_id UUID REFERENCES proposals(id)
);

CREATE INDEX initiative_details_stage ON initiative_details(stage);
CREATE INDEX initiative_details_author ON initiative_details(primary_author_id);
CREATE INDEX initiative_details_scope ON initiative_details(scope);
CREATE INDEX initiative_details_tags ON initiative_details USING GIN(issue_area_tags);
CREATE INDEX initiative_details_promoted_to ON initiative_details(promoted_to_proposal_id);
```

**What's removed from existing `civic_initiatives`:**
- `title`, `summary` — now on `proposals` core
- `linked_proposal_id` — replaced by the cleaner forward-link `promoted_to_proposal_id` (promotes ambiguity; a graduated initiative "becomes" a new proposal)
- `resolved_at` — moves to `proposals.resolved_at`
- `created_at`/`updated_at` — inherited from `proposals` core

**Migration plan for I-B:**
1. Backfill pass: for every row in `civic_initiatives`, insert a corresponding `proposals` row with `type='initiative'`, copy `title`, `summary`, `resolved_at`. Get back the new `proposal_id`.
2. Insert `initiative_details` with the `proposal_id` + remaining columns.
3. Rebuild `civic_initiative_signatures` and `civic_initiative_responses` with the FK pointed at `proposals.id` (dual-write during Stage 1; swap in Stage 2).
4. For every row where `civic_initiatives.linked_proposal_id IS NOT NULL`, set `initiative_details.promoted_to_proposal_id` to that same value.
5. Drop `civic_initiatives` at cutover.

**Stage status enum implication:** `proposal_status` enum should be extended with values mirroring the initiative lifecycle so a query like "show me active proposals" works uniformly. Proposed additions: `drafting`, `deliberating`, `mobilising`, `signatures_met`. Alternative: leave `proposal_status` narrow (bill-centric) and rely on `initiative_details.stage` for initiative-specific queries. I lean narrow — proposal_status stays bill/regulation-focused, initiative stage is separate. This matches how `measure_details.passed` is separate from `proposal_status`.

**Note on existing initiative UI/API:** anything referencing `civic_initiatives.id` needs a find/replace to `proposals.id`. Worth a quick audit pre-migration — will flag in a follow-up task.

### B.6 Supporting link tables

```sql
-- Cosponsorships (already exists in 20260420000000_cosponsorship.sql; keep, ensure FK to bill_details)
-- proposal_actions: timeline of "introduced", "passed committee", "voted on", etc.
CREATE TABLE proposal_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id     UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  action_type     TEXT NOT NULL,                -- 'introduced' | 'committee_referral' | 'committee_vote' | 'floor_vote' | 'passed_chamber' | 'enacted' | etc.
  action_at       TIMESTAMPTZ NOT NULL,
  description     TEXT,
  performed_by_id UUID REFERENCES officials(id),
  source          TEXT,                          -- which pipeline reported this
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(proposal_id, action_type, action_at)
);

CREATE INDEX proposal_actions_proposal_id ON proposal_actions(proposal_id);
CREATE INDEX proposal_actions_action_at ON proposal_actions(action_at DESC);
```

**Why this exists:** Stage 0 finding #1 was that `findOrCreateProposal` overwrites the proposal title with the most recent vote question. Replacing the contamination with a proper actions log means the current "On Passage", "On Cloture Motion" content goes into `proposal_actions.description`, not `proposals.title`.

---

## Section C — Votes (rekey + multi-roll-call)

```sql
CREATE TABLE votes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Vote belongs to a bill, not a generic proposal — FK enforces this
  bill_proposal_id UUID NOT NULL REFERENCES bill_details(proposal_id) ON DELETE CASCADE,
  official_id      UUID NOT NULL REFERENCES officials(id) ON DELETE CASCADE,
  -- The vote itself
  vote             TEXT NOT NULL CHECK (vote IN (
                     'yes', 'no', 'abstain', 'present', 'not_voting',
                     'paired_yes', 'paired_no'
                   )),
  voted_at         TIMESTAMPTZ NOT NULL,
  -- Roll call context — multiple roll calls per bill are now first-class
  roll_call_id     TEXT NOT NULL,             -- e.g. "h2024-123" or "s2024-45"
  vote_question    TEXT,                      -- "On Passage", "On the Cloture Motion", "On the Amendment"
  chamber          TEXT NOT NULL,             -- 'house' | 'senate' | 'council' | 'committee_X'
  session          TEXT,
  -- One vote record per official per roll call (fixes the 23505 swallowing in current pipelines)
  UNIQUE(roll_call_id, official_id),
  source_url       TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX votes_bill ON votes(bill_proposal_id);
CREATE INDEX votes_official ON votes(official_id);
CREATE INDEX votes_voted_at ON votes(voted_at DESC);
CREATE INDEX votes_roll_call ON votes(roll_call_id);
CREATE INDEX votes_vote ON votes(vote);
```

**What changed from current `votes`:**

- `proposal_id` → `bill_proposal_id` with FK to `bill_details.proposal_id` instead of `proposals.id`. Court cases and ballot measures don't get votes through this table — they have their own outcome-tracking shapes.
- Unique key changes from `(official_id, proposal_id)` to `(roll_call_id, official_id)` — directly fixes the "only first roll call per bill is stored" issue from Stage 0 finding #2 and the swallowed 23505 errors at congress/votes.ts:598/776.
- `roll_call_id` is required, not nullable.
- `vote_question` now has its own column (was being smuggled into `metadata->>vote_question` AND into the proposal title).
- `voted_at` becomes NOT NULL — votes without timestamps were always bugs.

---

## Section D — Meetings, agenda items, agenda actions

This is the new layer that makes Legistar-shaped local data work cleanly. Federal data also benefits — committee meetings + hearings have the same shape.

```sql
CREATE TABLE meetings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  governing_body_id UUID NOT NULL REFERENCES governing_bodies(id),
  meeting_type      TEXT NOT NULL,             -- 'regular' | 'special' | 'committee' | 'hearing' | 'executive_session'
  title             TEXT,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  location          TEXT,
  status            TEXT NOT NULL DEFAULT 'scheduled',  -- 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'postponed'
  agenda_url        TEXT,
  minutes_url       TEXT,
  video_url         TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX meetings_body ON meetings(governing_body_id);
CREATE INDEX meetings_scheduled_at ON meetings(scheduled_at DESC);
CREATE INDEX meetings_status ON meetings(status);

CREATE TABLE agenda_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  -- An agenda item often references a proposal (bill, resolution); not always
  proposal_id     UUID REFERENCES proposals(id),
  sequence        INTEGER NOT NULL,           -- order on agenda
  title           TEXT NOT NULL,
  item_type       TEXT,                       -- 'discussion' | 'vote' | 'public_comment' | 'consent' | 'reading'
  description     TEXT,
  outcome         TEXT,                       -- 'passed' | 'failed' | 'tabled' | 'continued' | etc.
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(meeting_id, sequence)
);

CREATE INDEX agenda_items_meeting ON agenda_items(meeting_id);
CREATE INDEX agenda_items_proposal ON agenda_items(proposal_id);

-- Optional: agenda_actions for fine-grained "this happened during this item"
-- (motions made, amendments proposed, etc.) — only if Phase 1 needs it
```

**Note:** votes can FK to `agenda_items` via the existing `roll_call_id` if useful, but the `bill_proposal_id` is the primary path. Worth deciding if `votes.agenda_item_id` should exist as a nullable FK for local data where votes are inherently agenda-bound.

---

## Section E — Financial entities + relationships (clean slate per Decision #4, polymorphic per L7)

The current state has 3 mutually-inconsistent dedup paths writing to `financial_entities` and a single-purpose `financial_relationships` table that only handles donations. New shape: one clean entity table + one polymorphic relationships table that handles every kind of money/ownership tie.

### E.1 `financial_entities`

```sql
CREATE TABLE financial_entities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical name (lowercased, normalized for matching)
  canonical_name      TEXT NOT NULL,
  -- Display name (preserves source casing)
  display_name        TEXT NOT NULL,
  entity_type         TEXT NOT NULL CHECK (entity_type IN (
                        'individual', 'pac', 'super_pac', 'corporation',
                        'union', 'party_committee', 'small_donor_aggregate',
                        'tribal', '527', 'other'
                      )),
  -- Single canonical FEC ID where one exists (other source IDs in external_source_refs)
  fec_committee_id    TEXT UNIQUE,
  industry            TEXT,                    -- OpenSecrets industry code
  parent_entity_id    UUID REFERENCES financial_entities(id),  -- subsidiary → parent corp
  -- Aggregates updated by triggers / nightly jobs (NOT live calculation)
  total_donated_cents BIGINT NOT NULL DEFAULT 0,
  total_received_cents BIGINT NOT NULL DEFAULT 0,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(canonical_name, entity_type)
);

CREATE INDEX financial_entities_canonical ON financial_entities(canonical_name);
CREATE INDEX financial_entities_display_trgm ON financial_entities USING GIN(display_name gin_trgm_ops);
CREATE INDEX financial_entities_parent ON financial_entities(parent_entity_id);
CREATE INDEX financial_entities_industry ON financial_entities(industry);
```

### E.2 `financial_relationships` (polymorphic, per L7)

```sql
CREATE TYPE financial_relationship_type AS ENUM (
  'donation',        -- campaign contribution, one-off money transfer
  'gift',            -- personal gift to an official (reportable under ethics rules)
  'honorarium',     -- speaking fees, book advances, paid appearances
  'loan',            -- loan to or from an entity / official
  'owns_stock',      -- equity holding (stateful — has start, may have end)
  'owns_bond',       -- debt holding
  'property',        -- real estate ownership (e.g. official owns property company)
  'contract',        -- government contract awarded to an entity
  'grant',           -- government grant
  'lobbying_spend',  -- lobbying expenditures for a quarter
  'other'
);

CREATE TABLE financial_relationships (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_type financial_relationship_type NOT NULL,
  -- Polymorphic FROM side (the "giver" or "holder" depending on type)
  from_type         TEXT NOT NULL CHECK (from_type IN (
                      'financial_entity', 'official', 'agency', 'governing_body'
                    )),
  from_id           UUID NOT NULL,
  -- Polymorphic TO side (the "recipient" or "subject")
  to_type           TEXT NOT NULL CHECK (to_type IN (
                      'financial_entity', 'official', 'agency', 'governing_body'
                    )),
  to_id             UUID NOT NULL,
  -- Amount. Semantics depend on type:
  --   donation/gift/honorarium/loan/contract/grant: transferred amount
  --   owns_stock/owns_bond/property: current market value (nullable if unknown)
  --   lobbying_spend: quarterly total
  amount_cents      BIGINT,
  -- Temporal — one-off events use occurred_at; stateful uses started_at/ended_at
  -- Exactly one of (occurred_at) OR (started_at) is required
  occurred_at       DATE,
  started_at        DATE,
  ended_at          DATE,                      -- null = ongoing (for stateful types)
  cycle_year        INTEGER,                   -- election cycle for donations
  -- Type-specific identifiers
  fec_filing_id     TEXT,                      -- FEC transactions
  usaspending_award_id TEXT,                   -- government contracts/grants
  disclosure_form_id TEXT,                     -- STOCK Act disclosures, ethics filings
  -- Flags
  is_in_kind        BOOLEAN NOT NULL DEFAULT false,
  is_bundled        BOOLEAN NOT NULL DEFAULT false,
  -- Source
  source_url        TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Temporal model constraint
  CHECK (
    (occurred_at IS NOT NULL AND started_at IS NULL)      -- one-off event
    OR (occurred_at IS NULL AND started_at IS NOT NULL)   -- stateful relationship
  ),
  -- Donations are uniquely keyed by FEC filing ID when present
  UNIQUE(fec_filing_id)
);

CREATE INDEX financial_relationships_type ON financial_relationships(relationship_type);
CREATE INDEX financial_relationships_from ON financial_relationships(from_type, from_id);
CREATE INDEX financial_relationships_to ON financial_relationships(to_type, to_id);
CREATE INDEX financial_relationships_occurred_at ON financial_relationships(occurred_at DESC)
  WHERE occurred_at IS NOT NULL;
CREATE INDEX financial_relationships_started_at ON financial_relationships(started_at DESC)
  WHERE started_at IS NOT NULL;
CREATE INDEX financial_relationships_cycle ON financial_relationships(cycle_year);
CREATE INDEX financial_relationships_amount ON financial_relationships(amount_cents DESC);
CREATE INDEX financial_relationships_usaspending ON financial_relationships(usaspending_award_id)
  WHERE usaspending_award_id IS NOT NULL;
CREATE INDEX financial_relationships_disclosure ON financial_relationships(disclosure_form_id)
  WHERE disclosure_form_id IS NOT NULL;
```

### E.3 Semantics by type

| type | from | to | amount | temporal | external id | notes |
|---|---|---|---|---|---|---|
| `donation` | financial_entity (donor) | financial_entity OR official (recipient) | transfer amount | `occurred_at` | `fec_filing_id` | One FEC row = one relationship |
| `gift` | financial_entity OR official (giver) | official (recipient) | gift value | `occurred_at` | `disclosure_form_id` | From ethics filings |
| `honorarium` | financial_entity (payer) | official (payee) | fee | `occurred_at` | `disclosure_form_id` | Speaking, book advance, etc. |
| `loan` | financial_entity OR official | financial_entity OR official | principal | `occurred_at` | `disclosure_form_id` | Direction by from/to |
| `owns_stock` | official OR financial_entity | financial_entity (company) | market value (nullable) | `started_at` / `ended_at` | `disclosure_form_id` | STOCK Act disclosures |
| `owns_bond` | official OR financial_entity | financial_entity (issuer) | face value | `started_at` / `ended_at` | `disclosure_form_id` | |
| `property` | official | financial_entity | market value | `started_at` / `ended_at` | `disclosure_form_id` | Real estate holdings |
| `contract` | agency (awarding) | financial_entity (recipient) | award amount | `started_at` / `ended_at` | `usaspending_award_id` | Performance period |
| `grant` | agency (awarding) | financial_entity (recipient) | grant amount | `started_at` / `ended_at` | `usaspending_award_id` | Performance period |
| `lobbying_spend` | financial_entity | agency OR governing_body | quarterly total | `started_at` / `ended_at` | LDA filing | One row per quarter |

### E.4 `spending_records` → migrated into `financial_relationships` (resolved)

Decision: **migrate**. `spending_records` deprecates at cutover. Contract/grant data lives in `financial_relationships` with `type='contract'` or `type='grant'`.

Migration mapping:
- `spending_records.awarding_agency` → `from_id` via lookup to `agencies.name`, `from_type='agency'`
- `spending_records.recipient_name` → `from_id` via upsert to `financial_entities`, `to_type='financial_entity'`
- `spending_records.amount_cents` → `amount_cents`
- `spending_records.period_of_performance_start/end` → `started_at` / `ended_at`
- `spending_records.usaspending_award_id` → `usaspending_award_id`
- `spending_records.recipient_location_jurisdiction_id` → `metadata->>'recipient_jurisdiction_id'`
- `spending_records.naics_code`, `cfda_number`, `awarding_subagency`, `award_type`, `description` → `metadata`
- `spending_records.total_amount_cents` → `metadata->>'total_amount_cents'` (for multi-year awards; `amount_cents` is cumulative obligated)

**Volume control (important).** USASpending is high-volume — ~10M rows per cycle. To stay within Pro tier 8GB budget:
- Ingest only recent cycles (2010+) as individual line items
- Pre-2010 aggregated by `(agency, recipient, year)` rather than line-item
- Nightly dedup pass against `usaspending_award_id` (we have a unique index)
- Revisit in 6 months if storage is healthy — can backfill deeper if budget allows

### E.5 Migration plan

1. Shadow `financial_entities` + `financial_relationships` + `spending_records` (if migrating) tables.
2. Rewrite FEC bulk pipeline to write donations into new shape with `fec_filing_id` uniqueness enforced.
3. Build new ingestors for:
   - STOCK Act disclosures → `owns_stock` / `owns_bond` / `property` rows
   - Ethics filings → `gift` / `honorarium` / `loan` rows
   - Lobbying Disclosure Act filings → `lobbying_spend` rows
   - USASpending → `contract` / `grant` rows (if migrating)
4. Derivation pass builds `entity_connections` from all types — donation-edges, ownership-edges, contract-edges all feed in with appropriate `connection_type` mapping.
5. Cutover swaps old tables out.

---

## Section F — Entity connections (rebuild per Decision #5)

Current `entity_connections` is written by 3+ pipelines with inconsistent evidence shapes. New approach: **derived table** populated by deterministic rules from the underlying source tables.

```sql
CREATE TABLE entity_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_type       TEXT NOT NULL,
  from_id         UUID NOT NULL,
  to_type         TEXT NOT NULL,
  to_id           UUID NOT NULL,
  connection_type connection_type NOT NULL,    -- existing enum stays
  strength        NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  amount_cents    BIGINT,                      -- for donation edges
  occurred_at     DATE,
  ended_at        DATE,
  -- Evidence is now structured: pointers to source rows + count
  evidence_count  INTEGER NOT NULL DEFAULT 1,
  evidence_source TEXT NOT NULL,               -- 'donations' | 'votes' | 'cosponsorship' | 'career_history' | 'manual'
  evidence_ids    UUID[] NOT NULL DEFAULT '{}',-- IDs in the evidence_source table
  derived_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB NOT NULL DEFAULT '{}',
  UNIQUE(from_type, from_id, to_type, to_id, connection_type)
);

CREATE INDEX entity_connections_from ON entity_connections(from_type, from_id);
CREATE INDEX entity_connections_to ON entity_connections(to_type, to_id);
CREATE INDEX entity_connections_type ON entity_connections(connection_type);
CREATE INDEX entity_connections_strength ON entity_connections(strength DESC);
CREATE INDEX entity_connections_evidence_source ON entity_connections(evidence_source);
```

**Derivation rules (run nightly + on-demand):**

| Connection type | Evidence source | Derivation |
|---|---|---|
| `donation` | `financial_relationships` where type=`donation` | One edge per (donor_entity → recipient_official), aggregated by cycle; strength = log-scaled aggregate amount |
| `vote_yes` / `vote_no` | `votes` | One edge per (official → bill_proposal) with vote outcome; strength = 1.0 |
| `co_sponsorship` | `cosponsorships` | One edge per (cosponsor → primary_sponsor) per bill |
| `appointment` | `career_history` (where `is_government=true`) | Detected by overlap of role periods + appointment authority |
| `revolving_door` | `career_history` (where `revolving_door_flag=true`) | Direct copy |
| `oversight` | `agencies` + `governing_bodies` | Static lookup table |
| `holds_position` (new) | `financial_relationships` where type IN (`owns_stock`, `owns_bond`, `property`) | One edge per (official OR entity → company) for active holdings (ended_at IS NULL); strength = log-scaled value |
| `gift_received` (new) | `financial_relationships` where type IN (`gift`, `honorarium`) | One edge per (giver → official) per cycle |
| `contract_award` | `financial_relationships` where type IN (`contract`, `grant`) | One edge per (agency → recipient_entity); strength = log-scaled total award value |
| `lobbying` | `financial_relationships` where type=`lobbying_spend` | One edge per (entity → governing_body OR agency) per year, strength = log-scaled annual spend |

The `connection_type` enum will need to be extended for `holds_position`, `gift_received`. `lobbying` and `contract_award` already exist.

A nightly job rebuilds the derived edges. Pipelines no longer write to `entity_connections` directly — they write to the source tables and the derivation pass takes over. This kills the dedup mess and makes `entity_connections` reproducible.

---

## Section G — Enrichment queue (Decision #6)

Formalize the prioritized AI-enrichment queue.

```sql
CREATE TABLE enrichment_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What needs enrichment
  entity_type     TEXT NOT NULL,                 -- 'proposal' | 'official' | 'meeting' | 'donation_burst'
  entity_id       UUID NOT NULL,
  enrichment_type TEXT NOT NULL,                 -- 'summarize' | 'tag' | 'embed' | 'detect_revolving_door'
  -- Priority: lower number = higher priority
  priority        INTEGER NOT NULL DEFAULT 100,
  -- Trigger reason for visibility
  reason          TEXT,                          -- 'new_proposal' | 'comment_period_opening' | 'high_traffic' | 'manual'
  -- State
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  -- Worker tracking
  worker_id       TEXT,                          -- which agent claimed it
  claimed_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failed_reason   TEXT,
  -- Cost / model accounting
  model_used      TEXT,
  cost_cents      INTEGER,
  -- Idempotency: don't queue same (entity, type) twice in pending
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(entity_type, entity_id, enrichment_type, status)
    DEFERRABLE INITIALLY DEFERRED  -- allows brief race during requeue
);

CREATE INDEX enrichment_queue_pending ON enrichment_queue(status, priority, created_at)
  WHERE status = 'pending';
CREATE INDEX enrichment_queue_worker ON enrichment_queue(worker_id, status)
  WHERE status = 'in_progress';
```

**Worker pattern:** parallel agents poll with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` ordered by `(priority, created_at)`. Agent claims by setting `status='in_progress'`, `worker_id`, `claimed_at`. On completion, sets `status='completed'`. On failure, increments `attempt_count` and sets `status='pending'` again (or `failed` after N attempts).

**Idempotency wrinkle:** the unique constraint on `(entity_type, entity_id, enrichment_type, status)` prevents queueing the same job twice while one is pending. The DEFERRABLE clause handles the brief window during requeue. Alternative: use a partial unique index `WHERE status IN ('pending', 'in_progress')`.

---

## Section H — Claim queue (Decision #3, schema-only)

Users can request coverage for a jurisdiction not yet populated. Phase 1 stores the request; Phase 2 wires up the processor.

```sql
ALTER TYPE jurisdiction_type ADD VALUE IF NOT EXISTS 'school_district';
ALTER TYPE jurisdiction_type ADD VALUE IF NOT EXISTS 'special_district';

ALTER TABLE jurisdictions ADD COLUMN coverage_status TEXT NOT NULL DEFAULT 'none'
  CHECK (coverage_status IN ('none', 'claimed', 'partial', 'full'));
ALTER TABLE jurisdictions ADD COLUMN coverage_started_at TIMESTAMPTZ;
ALTER TABLE jurisdictions ADD COLUMN coverage_completed_at TIMESTAMPTZ;

CREATE TABLE claim_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  requested_by    UUID NOT NULL REFERENCES users(id),
  reason          TEXT,                          -- free text from user
  -- Want/willingness signals
  upvote_count    INTEGER NOT NULL DEFAULT 1,    -- aggregate user votes
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'rejected')),
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE(jurisdiction_id, requested_by)
);

CREATE INDEX claim_queue_status_priority ON claim_queue(status, upvote_count DESC, created_at)
  WHERE status = 'pending';
```

**Stage 1 deliverable:** schema exists, seed jurisdictions for the 5 deep-pilot metros + all 50 states + federal with proper `coverage_status` values. **No worker** in Phase 1. Stub UI ("request coverage for your district") is fine but not required.

---

## Section I — Pipeline state + sync log (formalize)

Replace the current 2-name confusion (`pipeline` vs. `pipeline_name`) and consolidate.

```sql
-- pipeline_state stays as key/value, but with structured key parts
CREATE TABLE pipeline_state (
  pipeline        TEXT NOT NULL,                 -- 'congress.bills' | 'congress.votes' | 'fec.bulk' | 'legistar:seattle' | etc.
  key             TEXT NOT NULL,                 -- 'cursor' | 'last_run' | 'egress_cents_today' | 'rate_limit_remaining'
  value_text      TEXT,
  value_int       BIGINT,
  value_jsonb     JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pipeline, key)
);

-- data_sync_log: append-only audit trail
CREATE TABLE data_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline        TEXT NOT NULL,                 -- canonical column name (not pipeline_name)
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  records_failed  INTEGER NOT NULL DEFAULT 0,
  api_calls       INTEGER NOT NULL DEFAULT 0,
  bytes_egress    BIGINT NOT NULL DEFAULT 0,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  error_summary   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX data_sync_log_pipeline ON data_sync_log(pipeline, started_at DESC);
CREATE INDEX data_sync_log_status ON data_sync_log(status);
```

**Drop:** the existing `data_sync_log` after migration. Stage 0 finding #11 is fixed by the single canonical column name.

---

## Section J — RLS sketch

All new tables follow the existing pattern:

| Table | anon SELECT | authenticated INSERT/UPDATE | service_role |
|---|---|---|---|
| `external_source_refs` | no | no | yes |
| `bill_details`, `case_details`, `measure_details` | yes | no | yes |
| `proposal_actions` | yes | no | yes |
| `meetings`, `agenda_items` | yes | no | yes |
| `donations` | yes | no | yes |
| `financial_entities` | yes | no | yes |
| `entity_connections` | yes | no | yes |
| `enrichment_queue` | no | no | yes |
| `claim_queue` | own only | own only | yes |
| `pipeline_state`, `data_sync_log` | no | no | yes |

`external_source_refs` and pipeline plumbing stay private — they're operational, not civic data.

---

## Section K — Migration / cutover strategy

**Stage 1A — Shadow tables.** Create everything new in a `shadow` schema. Existing tables untouched. Pipelines refactored to write to both old AND shadow targets (dual-write) for the duration of Stage 1.

**Stage 1B — Backfill pass.** Run a one-time backfill from old tables → shadow tables. Spot-check counts and a few queries.

**Stage 1C — Read switchover.** Civitics app starts reading from shadow tables. Pipelines still dual-write so old tables stay current as a safety net.

**Stage 2 — Cutover.** Stop dual-writing. Drop old tables. Rename `shadow.*` → `public.*`.

**Why dual-write:** lets the rebuild ship without a maintenance window. Lets us bail to old tables if shadow has bugs we missed. Costs ~2x write volume during Stage 1B/C — well within Pro tier budget.

**Risk:** dual-write code is hard to remove cleanly. Set a hard deadline (~30 days from Stage 1A) before cutover.

---

## Section L — Decision history (all resolved 2026-04-19)

| # | Question | Decision | Notes |
|---|---|---|---|
| L1 | Initiatives shape (I-A vs I-B) | **I-B** | Migrate civic_initiatives into proposals.type=`initiative` + initiative_details. See Section B.5. |
| L2 | external_source_refs polymorphic FK | **App-level + orphan cleanup job** | Periodic job (weekly?) catches orphans. Triggers rejected on write-cost grounds. |
| L3 | bill_details compound uniqueness | **Denormalize jurisdiction_id + session** | Duplicated from proposals core; trigger keeps in sync. Defense in depth. |
| L4 | votes.agenda_item_id | **Yes, nullable FK** | Null for federal votes; populated for Legistar-sourced local votes. |
| L5 | entity_connections live vs derived | **Derivation only for Phase 1** | No manual edges. Pipelines write to source tables; nightly derivation rebuilds the graph. Manual flagging deferred to Phase 2. |
| L6 | Cutover deadline | **30-day dual-write window** | Hard stop to force cutover before dual-write code drifts. |
| L7 | donations vs financial_relationships naming | **Keep name, make polymorphic** | Added relationship_type enum: `donation`, `gift`, `honorarium`, `loan`, `owns_stock`, `owns_bond`, `property`, `contract`, `grant`, `lobbying_spend`, `other`. See Section E. |

---

## Section M — What this doc does NOT cover

Reserved for follow-up sessions:

- The **pipeline registry** schema — how each scraper/adapter is configured, scheduled, and monitored. Depends on scraper research outcome (per-metro Legistar adapter vs. generic).
- **Position taking** UX flow — needs product thinking before schema.
- **Embedding / vector search** schema if/when we add semantic search.
- The 50-state seed data for `jurisdictions` — operational, not schema.
- **Indexes for the institutional API** `?updated_after=` pattern — current pattern is good, just propagate to new tables.
- Per-jurisdiction RLS for citizen comments restricted to constituents — Phase 2 product question.

---

## Next steps

1. Craig reviews L (open questions). 30-min decision pass.
2. Once L is settled, I write the actual migration files in `supabase/migrations/` under a single sprint (e.g. `20260420_stage1_shadow.sql`).
3. Pipeline refactor planning starts in parallel (separate doc).
