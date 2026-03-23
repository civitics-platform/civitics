-- =============================================================================
-- Civitics Platform — Initial Schema
-- Phase 0: Core tables, PostGIS, and global jurisdiction framework
--
-- Design rules enforced throughout:
--   - All IDs: UUID (gen_random_uuid())
--   - All timestamps: TIMESTAMPTZ
--   - All monetary amounts: INTEGER CENTS (never float)
--   - All tables have: metadata JSONB for country-specific fields
--   - User coordinates: never stored at full precision (coarsen before INSERT)
--   - PostGIS: boundary geometry stored locally (no per-query API cost)
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- trigram index for full-text search

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE jurisdiction_type AS ENUM (
  'global',
  'supranational',  -- EU, ASEAN, etc.
  'country',
  'state',          -- US states, UK nations, etc.
  'county',
  'city',
  'district',       -- congressional, legislative, school, etc.
  'precinct',
  'other'
);

CREATE TYPE governing_body_type AS ENUM (
  'legislature_upper',       -- Senate, Lords, Bundesrat
  'legislature_lower',       -- House, Commons, Bundestag
  'legislature_unicameral',  -- Nebraska, many countries
  'executive',               -- President, Prime Minister, Governor, Mayor
  'judicial',                -- Supreme Court, Court of Appeals
  'regulatory_agency',       -- FTC, EPA, SEC, etc.
  'municipal_council',
  'school_board',
  'special_district',
  'international_body',      -- UN, ICC, etc.
  'other'
);

CREATE TYPE proposal_type AS ENUM (
  'bill',
  'resolution',
  'amendment',
  'regulation',             -- Federal Register rulemaking
  'executive_order',
  'treaty',
  'referendum',
  'initiative',
  'budget',
  'appointment',            -- judicial/cabinet
  'ordinance',              -- local
  'other'
);

CREATE TYPE proposal_status AS ENUM (
  'introduced',
  'in_committee',
  'passed_committee',
  'floor_vote',
  'passed_chamber',
  'passed_both_chambers',
  'signed',
  'vetoed',
  'veto_overridden',
  'enacted',
  'open_comment',           -- regulations.gov comment period open
  'comment_closed',
  'final_rule',
  'failed',
  'withdrawn',
  'tabled'
);

CREATE TYPE connection_type AS ENUM (
  'donation',
  'vote_yes',
  'vote_no',
  'vote_abstain',
  'appointment',
  'revolving_door',         -- employment before/after government role
  'oversight',              -- official oversees entity
  'lobbying',
  'co_sponsorship',
  'family',
  'business_partner',
  'legal_representation',
  'endorsement',
  'contract_award'
);

CREATE TYPE party AS ENUM (
  'democrat',
  'republican',
  'independent',
  'libertarian',
  'green',
  'other',
  'nonpartisan'
);

CREATE TYPE promise_status AS ENUM (
  'made',
  'in_progress',
  'kept',
  'broken',
  'partially_kept',
  'expired',
  'modified'
);

CREATE TYPE donor_type AS ENUM (
  'individual',
  'pac',
  'super_pac',
  'corporate',
  'union',
  'party_committee',
  'small_donor_aggregate',
  'other'
);

-- =============================================================================
-- JURISDICTIONS
-- Hierarchical: global → country → state → county → city → district
-- Every entity (official, agency, proposal) belongs to a jurisdiction node.
-- Global deployment is a configuration change, not a rebuild.
-- =============================================================================

CREATE TABLE IF NOT EXISTS jurisdictions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id           UUID REFERENCES jurisdictions(id),
  type                jurisdiction_type NOT NULL,
  name                TEXT NOT NULL,
  short_name          TEXT,                    -- "CA", "TX", "NY"
  country_code        CHAR(2),                 -- ISO 3166-1 alpha-2
  fips_code           TEXT,                    -- US FIPS code
  census_geoid        TEXT,                    -- Census TIGER GEOID
  boundary_geometry   GEOMETRY(MULTIPOLYGON, 4326),  -- PostGIS; loaded from Census TIGER / OpenStates GeoJSON
  centroid            GEOMETRY(POINT, 4326),         -- computed centroid for map labels
  population          INTEGER,
  timezone            TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Spatial index for ST_Contains queries (district lookup by coordinates)
CREATE INDEX IF NOT EXISTS jurisdictions_boundary_gist ON jurisdictions USING GIST(boundary_geometry);
CREATE INDEX IF NOT EXISTS jurisdictions_centroid_gist ON jurisdictions USING GIST(centroid);
CREATE INDEX IF NOT EXISTS jurisdictions_parent_id ON jurisdictions(parent_id);
CREATE INDEX IF NOT EXISTS jurisdictions_country_code ON jurisdictions(country_code);
CREATE INDEX IF NOT EXISTS jurisdictions_type ON jurisdictions(type);

-- =============================================================================
-- GOVERNING BODIES
-- Abstract representation of any government entity anywhere.
-- body_type handles presidential, parliamentary, municipal, etc.
-- =============================================================================

CREATE TABLE IF NOT EXISTS governing_bodies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  type            governing_body_type NOT NULL,
  name            TEXT NOT NULL,
  short_name      TEXT,
  website_url     TEXT,
  contact_email   TEXT,
  seat_count      INTEGER,
  term_length_years INTEGER,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS governing_bodies_jurisdiction_id ON governing_bodies(jurisdiction_id);
CREATE INDEX IF NOT EXISTS governing_bodies_type ON governing_bodies(type);

-- =============================================================================
-- OFFICIALS
-- Any public official, any country, any level.
-- source_ids JSONB holds IDs in multiple source systems.
-- =============================================================================

CREATE TABLE IF NOT EXISTS officials (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  governing_body_id   UUID NOT NULL REFERENCES governing_bodies(id),
  jurisdiction_id     UUID NOT NULL REFERENCES jurisdictions(id),
  full_name           TEXT NOT NULL,
  first_name          TEXT,
  last_name           TEXT,
  role_title          TEXT NOT NULL,           -- "Senator", "Representative", "Secretary"
  party               party,
  photo_url           TEXT,
  email               TEXT,
  website_url         TEXT,
  office_address      TEXT,
  phone               TEXT,
  district_name       TEXT,                    -- "District 12", "At-Large"
  term_start          DATE,
  term_end            DATE,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  is_verified         BOOLEAN NOT NULL DEFAULT false,  -- government email verified
  -- source_ids holds external IDs: {"bioguide": "A000001", "fec": "H0CA00001", etc.}
  source_ids          JSONB NOT NULL DEFAULT '{}',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS officials_governing_body_id ON officials(governing_body_id);
CREATE INDEX IF NOT EXISTS officials_jurisdiction_id ON officials(jurisdiction_id);
CREATE INDEX IF NOT EXISTS officials_party ON officials(party);
CREATE INDEX IF NOT EXISTS officials_is_active ON officials(is_active);
CREATE INDEX IF NOT EXISTS officials_full_name_trgm ON officials USING GIN(full_name gin_trgm_ops);

-- =============================================================================
-- PROPOSALS
-- Any legislative or regulatory proposal.
-- Covers: bill, regulation, executive_order, treaty, referendum, etc.
-- =============================================================================

CREATE TABLE IF NOT EXISTS proposals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  governing_body_id   UUID REFERENCES governing_bodies(id),
  jurisdiction_id     UUID NOT NULL REFERENCES jurisdictions(id),
  type                proposal_type NOT NULL,
  status              proposal_status NOT NULL DEFAULT 'introduced',
  title               TEXT NOT NULL,
  short_title         TEXT,
  bill_number         TEXT,                    -- "HR 1234", "S 567"
  congress_number     INTEGER,                 -- 118, 119, etc.
  session             TEXT,
  introduced_at       DATE,
  last_action_at      DATE,
  enacted_at          DATE,
  comment_period_start TIMESTAMPTZ,
  comment_period_end  TIMESTAMPTZ,
  regulations_gov_id  TEXT,                    -- for direct submission
  congress_gov_url    TEXT,
  full_text_url       TEXT,
  full_text_r2_key    TEXT,                    -- Cloudflare R2 storage key
  full_text_arweave   TEXT,                    -- Arweave transaction ID
  -- AI-generated plain language summary (generated once on ingestion, served free to all)
  summary_plain       TEXT,
  summary_generated_at TIMESTAMPTZ,
  summary_model       TEXT,                    -- which Claude model generated it
  fiscal_impact_cents BIGINT,                  -- estimated fiscal impact in cents
  -- Full-text search vector
  search_vector       TSVECTOR,
  source_ids          JSONB NOT NULL DEFAULT '{}',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS proposals_governing_body_id ON proposals(governing_body_id);
CREATE INDEX IF NOT EXISTS proposals_jurisdiction_id ON proposals(jurisdiction_id);
CREATE INDEX IF NOT EXISTS proposals_type ON proposals(type);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS proposals_comment_period_end ON proposals(comment_period_end)
  WHERE comment_period_end IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposals_search_vector ON proposals USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS proposals_title_trgm ON proposals USING GIN(title gin_trgm_ops);

-- Auto-update search vector
CREATE FUNCTION proposals_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.short_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.summary_plain, '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposals_search_vector_trigger
  BEFORE INSERT OR UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION proposals_search_vector_update();

-- =============================================================================
-- ENTITY CONNECTIONS
-- The connection graph table.
-- Powers D3 force simulation + PostgreSQL recursive CTE shortest path queries.
-- No separate graph DB needed until Phase 4+.
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic: entity_type + entity_id reference any entity (official, agency, proposal, etc.)
  from_type       TEXT NOT NULL,   -- 'official' | 'governing_body' | 'proposal' | 'organization'
  from_id         UUID NOT NULL,
  to_type         TEXT NOT NULL,
  to_id           UUID NOT NULL,
  connection_type connection_type NOT NULL,
  strength        NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
  -- Amount in cents for financial connections (proportional edge width in graph)
  amount_cents    BIGINT,
  occurred_at     DATE,
  ended_at        DATE,
  -- evidence is an array of source URLs/descriptions
  evidence        JSONB NOT NULL DEFAULT '[]',
  is_verified     BOOLEAN NOT NULL DEFAULT false,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS entity_connections_from ON entity_connections(from_type, from_id);
CREATE INDEX IF NOT EXISTS entity_connections_to ON entity_connections(to_type, to_id);
CREATE INDEX IF NOT EXISTS entity_connections_type ON entity_connections(connection_type);
CREATE INDEX IF NOT EXISTS entity_connections_occurred_at ON entity_connections(occurred_at);

-- =============================================================================
-- FINANCIAL RELATIONSHIPS
-- All money flows: campaign donations, PAC contributions, lobbying spend, etc.
-- amount_cents: always integer, never float.
-- =============================================================================

CREATE TABLE IF NOT EXISTS financial_relationships (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id       UUID REFERENCES officials(id),
  governing_body_id UUID REFERENCES governing_bodies(id),
  donor_name        TEXT NOT NULL,
  donor_type        donor_type NOT NULL,
  industry          TEXT,                      -- OpenSecrets industry code
  amount_cents      BIGINT NOT NULL,           -- never float
  contribution_date DATE,
  cycle_year        INTEGER,                   -- election cycle: 2024, 2026, etc.
  fec_committee_id  TEXT,
  fec_filing_id     TEXT,
  is_bundled        BOOLEAN NOT NULL DEFAULT false,
  source_url        TEXT,
  source_ids        JSONB NOT NULL DEFAULT '{}',
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS financial_relationships_official_id ON financial_relationships(official_id);
CREATE INDEX IF NOT EXISTS financial_relationships_donor_name_trgm ON financial_relationships USING GIN(donor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS financial_relationships_industry ON financial_relationships(industry);
CREATE INDEX IF NOT EXISTS financial_relationships_cycle_year ON financial_relationships(cycle_year);
CREATE INDEX IF NOT EXISTS financial_relationships_amount ON financial_relationships(amount_cents DESC);

-- =============================================================================
-- PROMISES
-- Promise tracker: links officials to specific public commitments.
-- Status lifecycle: made → in_progress → kept | broken | partially_kept | expired
-- =============================================================================

CREATE TABLE IF NOT EXISTS promises (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id     UUID NOT NULL REFERENCES officials(id),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  title           TEXT NOT NULL,
  description     TEXT,
  status          promise_status NOT NULL DEFAULT 'made',
  made_at         DATE,
  deadline        DATE,
  resolved_at     DATE,
  -- Link to source (speech, tweet, press release, debate)
  source_url      TEXT,
  source_quote    TEXT,
  -- Link to related proposal if promise is about specific legislation
  related_proposal_id UUID REFERENCES proposals(id),
  -- On-chain hash once promise is recorded (Phase 4)
  onchain_tx_hash TEXT,
  arweave_tx      TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS promises_official_id ON promises(official_id);
CREATE INDEX IF NOT EXISTS promises_status ON promises(status);
CREATE INDEX IF NOT EXISTS promises_jurisdiction_id ON promises(jurisdiction_id);

-- =============================================================================
-- CAREER HISTORY
-- Revolving door tracker.
-- Flags when an org was regulated by the official's prior/subsequent government role.
-- =============================================================================

CREATE TABLE IF NOT EXISTS career_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id     UUID NOT NULL REFERENCES officials(id),
  organization    TEXT NOT NULL,
  role_title      TEXT,
  started_at      DATE,
  ended_at        DATE,
  is_government   BOOLEAN NOT NULL DEFAULT false,
  governing_body_id UUID REFERENCES governing_bodies(id),
  -- revolving_door_flag: true if org was regulated by concurrent/adjacent govt role
  revolving_door_flag BOOLEAN NOT NULL DEFAULT false,
  revolving_door_explanation TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS career_history_official_id ON career_history(official_id);
CREATE INDEX IF NOT EXISTS career_history_revolving_door ON career_history(revolving_door_flag)
  WHERE revolving_door_flag = true;

-- =============================================================================
-- SPENDING RECORDS
-- Government contract/grant data from USASpending.gov.
-- amount_cents: always integer, never float.
-- =============================================================================

CREATE TABLE IF NOT EXISTS spending_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id   UUID NOT NULL REFERENCES jurisdictions(id),
  awarding_agency   TEXT NOT NULL,
  recipient_name    TEXT NOT NULL,
  recipient_location_jurisdiction_id UUID REFERENCES jurisdictions(id),
  award_type        TEXT,                      -- 'contract' | 'grant' | 'loan' | 'other'
  amount_cents      BIGINT NOT NULL,
  total_amount_cents BIGINT,
  award_date        DATE,
  period_of_performance_start DATE,
  period_of_performance_end   DATE,
  usaspending_award_id TEXT,
  naics_code        TEXT,
  cfda_number       TEXT,                      -- for grants
  description       TEXT,
  source_ids        JSONB NOT NULL DEFAULT '{}',
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS spending_records_jurisdiction_id ON spending_records(jurisdiction_id);
CREATE INDEX IF NOT EXISTS spending_records_recipient_location ON spending_records(recipient_location_jurisdiction_id);
CREATE INDEX IF NOT EXISTS spending_records_award_date ON spending_records(award_date);
CREATE INDEX IF NOT EXISTS spending_records_amount ON spending_records(amount_cents DESC);
CREATE INDEX IF NOT EXISTS spending_records_awarding_agency ON spending_records(awarding_agency);

-- =============================================================================
-- USERS
-- Civic identity. Never stores precise coordinates.
-- Wallet and blockchain fields are nullable — populated in Phase 4.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id         TEXT UNIQUE,               -- Privy auth ID (Phase 4)
  email                 TEXT UNIQUE,
  display_name          TEXT,
  avatar_url            TEXT,
  -- Geography: coarsened to district/zip — NEVER full coordinates
  -- Exact address is geocoded once, coarsened, then discarded
  district_jurisdiction_id UUID REFERENCES jurisdictions(id),
  zip_code              TEXT,
  -- Civic credits (on-chain in Phase 4; Supabase simulation in Phase 0–3)
  civic_credits_balance INTEGER NOT NULL DEFAULT 0 CHECK (civic_credits_balance >= 0),
  -- Blockchain (Phase 4)
  wallet_address        TEXT,                      -- ERC-4337 smart wallet
  wallet_chain          TEXT,                      -- 'optimism' | 'base' | 'polygon'
  -- Verification
  is_email_verified     BOOLEAN NOT NULL DEFAULT false,
  is_government_verified BOOLEAN NOT NULL DEFAULT false,  -- .gov email
  -- Usage limits
  ai_queries_today      INTEGER NOT NULL DEFAULT 0,
  ai_queries_reset_at   TIMESTAMPTZ,
  -- Account state
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_privy_user_id ON users(privy_user_id);
CREATE INDEX IF NOT EXISTS users_district_jurisdiction_id ON users(district_jurisdiction_id);

-- =============================================================================
-- CIVIC COMMENTS
-- Platform comments on proposals (not official submissions).
-- Official comment submissions go to regulations.gov via API (Phase 2).
-- =============================================================================

CREATE TABLE IF NOT EXISTS civic_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id     UUID NOT NULL REFERENCES proposals(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  parent_id       UUID REFERENCES civic_comments(id),  -- threading
  body            TEXT NOT NULL,
  position        TEXT CHECK (position IN ('support', 'oppose', 'neutral', 'question')),
  upvotes         INTEGER NOT NULL DEFAULT 0,
  is_deleted      BOOLEAN NOT NULL DEFAULT false,
  -- On-chain hash (Phase 4): permanent record of community positions
  onchain_tx_hash TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS civic_comments_proposal_id ON civic_comments(proposal_id);
CREATE INDEX IF NOT EXISTS civic_comments_user_id ON civic_comments(user_id);
CREATE INDEX IF NOT EXISTS civic_comments_parent_id ON civic_comments(parent_id);

-- =============================================================================
-- OFFICIAL COMMENT SUBMISSIONS
-- Tracks submissions made via regulations.gov API.
-- Submission is ALWAYS FREE — no credits, no fees, no exceptions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS official_comment_submissions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id),
  proposal_id           UUID NOT NULL REFERENCES proposals(id),
  regulations_gov_id    TEXT,                    -- returned by regulations.gov API
  comment_text          TEXT NOT NULL,
  submitted_at          TIMESTAMPTZ,
  submission_status     TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'submitted' | 'failed'
  confirmation_number   TEXT,
  -- AI-assisted drafting: track which model helped (for cost accounting, not for limiting free submission)
  ai_assisted           BOOLEAN NOT NULL DEFAULT false,
  -- Arweave permanent record (Phase 4)
  arweave_tx            TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS official_comment_submissions_user_id ON official_comment_submissions(user_id);
CREATE INDEX IF NOT EXISTS official_comment_submissions_proposal_id ON official_comment_submissions(proposal_id);

-- =============================================================================
-- CIVIC CREDIT LEDGER (Phase 0–3 simulation; replaced by smart contract in Phase 4)
-- =============================================================================

CREATE TABLE IF NOT EXISTS civic_credit_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  amount          INTEGER NOT NULL,             -- positive = earn, negative = spend
  balance_after   INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,              -- 'earn_comment' | 'earn_contribution' | 'spend_ai_query' | etc.
  description     TEXT,
  related_entity_type TEXT,                    -- 'proposal' | 'official' | etc.
  related_entity_id   UUID,
  -- On-chain record (Phase 4)
  onchain_tx_hash TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS civic_credit_transactions_user_id ON civic_credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS civic_credit_transactions_created_at ON civic_credit_transactions(created_at);

-- =============================================================================
-- WARRANT CANARY
-- Published on-chain weekly (Optimism). Signed attestation of non-compromise.
-- =============================================================================

CREATE TABLE IF NOT EXISTS warrant_canary (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  published_at    TIMESTAMPTZ NOT NULL,
  statement_text  TEXT NOT NULL,
  signature       TEXT,                        -- cryptographic signature
  onchain_tx_hash TEXT,                        -- Optimism transaction hash
  chain           TEXT NOT NULL DEFAULT 'optimism',
  block_number    BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- UPDATED_AT TRIGGERS
-- =============================================================================

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jurisdictions_updated_at BEFORE UPDATE ON jurisdictions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER governing_bodies_updated_at BEFORE UPDATE ON governing_bodies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER officials_updated_at BEFORE UPDATE ON officials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER proposals_updated_at BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER entity_connections_updated_at BEFORE UPDATE ON entity_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER financial_relationships_updated_at BEFORE UPDATE ON financial_relationships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER promises_updated_at BEFORE UPDATE ON promises FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER career_history_updated_at BEFORE UPDATE ON career_history FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER spending_records_updated_at BEFORE UPDATE ON spending_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER civic_comments_updated_at BEFORE UPDATE ON civic_comments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER official_comment_submissions_updated_at BEFORE UPDATE ON official_comment_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- AGENCIES
-- Government agencies and regulatory bodies, distinct from governing bodies.
-- An agency executes law; a governing body makes or interprets it.
-- Examples: EPA, FTC, SEC, state DMV, city planning department.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agencies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id       UUID NOT NULL REFERENCES jurisdictions(id),
  parent_agency_id      UUID REFERENCES agencies(id),        -- hierarchical: EPA > region offices
  governing_body_id     UUID REFERENCES governing_bodies(id), -- oversight body (e.g. Senate committee)
  name                  TEXT NOT NULL,
  short_name            TEXT,
  acronym               TEXT,                                 -- "EPA", "FTC", "SEC", "FDA"
  agency_type           TEXT NOT NULL DEFAULT 'federal'
                          CHECK (agency_type IN ('federal', 'state', 'local', 'independent', 'international', 'other')),
  website_url           TEXT,
  contact_email         TEXT,
  description           TEXT,
  -- USASpending IDs for spending record joins
  usaspending_agency_id TEXT,
  usaspending_subtier_id TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  source_ids            JSONB NOT NULL DEFAULT '{}',
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agencies_jurisdiction_id    ON agencies(jurisdiction_id);
CREATE INDEX IF NOT EXISTS agencies_parent_agency_id   ON agencies(parent_agency_id);
CREATE INDEX IF NOT EXISTS agencies_governing_body_id  ON agencies(governing_body_id);
CREATE INDEX IF NOT EXISTS agencies_is_active          ON agencies(is_active);
CREATE INDEX IF NOT EXISTS agencies_updated_at         ON agencies(updated_at);
CREATE INDEX IF NOT EXISTS agencies_name_trgm          ON agencies USING GIN(name gin_trgm_ops);

CREATE TRIGGER agencies_updated_at
  BEFORE UPDATE ON agencies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- VOTES
-- Individual vote records: which official voted how on which proposal.
-- Separate from entity_connections (which models graph relationships);
-- this table is the authoritative structured vote record used for analytics,
-- the vote-pattern analyzer, and donor-vote correlation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS votes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id      UUID NOT NULL REFERENCES officials(id),
  proposal_id      UUID NOT NULL REFERENCES proposals(id),
  vote             TEXT NOT NULL
                     CHECK (vote IN ('yes', 'no', 'abstain', 'present', 'not_voting', 'paired_yes', 'paired_no')),
  voted_at         TIMESTAMPTZ,
  roll_call_number TEXT,                                     -- "RC-123", "Vote 45"
  chamber          TEXT,                                     -- 'senate' | 'house' | 'full'
  session          TEXT,
  source_url       TEXT,
  source_ids       JSONB NOT NULL DEFAULT '{}',
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One definitive vote per official per proposal (UPDATE if amended)
  UNIQUE (official_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS votes_official_id  ON votes(official_id);
CREATE INDEX IF NOT EXISTS votes_proposal_id  ON votes(proposal_id);
CREATE INDEX IF NOT EXISTS votes_vote         ON votes(vote);
CREATE INDEX IF NOT EXISTS votes_voted_at     ON votes(voted_at);
CREATE INDEX IF NOT EXISTS votes_updated_at   ON votes(updated_at);

CREATE TRIGGER votes_updated_at
  BEFORE UPDATE ON votes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- UPDATED_AT INDEXES
-- Critical for the institutional API: every collection endpoint supports
-- ?updated_after=<timestamp> so downstream systems only fetch changed records.
-- =============================================================================

CREATE INDEX IF NOT EXISTS jurisdictions_updated_at          ON jurisdictions(updated_at);
CREATE INDEX IF NOT EXISTS governing_bodies_updated_at       ON governing_bodies(updated_at);
CREATE INDEX IF NOT EXISTS officials_updated_at              ON officials(updated_at);
CREATE INDEX IF NOT EXISTS proposals_updated_at              ON proposals(updated_at);
CREATE INDEX IF NOT EXISTS entity_connections_updated_at     ON entity_connections(updated_at);
CREATE INDEX IF NOT EXISTS financial_relationships_updated_at ON financial_relationships(updated_at);
CREATE INDEX IF NOT EXISTS promises_updated_at               ON promises(updated_at);
CREATE INDEX IF NOT EXISTS career_history_updated_at         ON career_history(updated_at);
CREATE INDEX IF NOT EXISTS spending_records_updated_at       ON spending_records(updated_at);
CREATE INDEX IF NOT EXISTS users_updated_at                  ON users(updated_at);
CREATE INDEX IF NOT EXISTS civic_comments_updated_at         ON civic_comments(updated_at);
CREATE INDEX IF NOT EXISTS official_comment_submissions_updated_at ON official_comment_submissions(updated_at);

-- =============================================================================
-- ROW LEVEL SECURITY
-- Public civic data: anyone can read.
-- User data: only the authenticated owner can read/write.
-- Everything else: authenticated users can read; writes go through service role.
-- =============================================================================

-- Enable RLS on every table
ALTER TABLE jurisdictions                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE governing_bodies               ENABLE ROW LEVEL SECURITY;
ALTER TABLE officials                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agencies                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_relationships        ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_connections             ENABLE ROW LEVEL SECURITY;
ALTER TABLE promises                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_history                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE spending_records               ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE civic_comments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE official_comment_submissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE civic_credit_transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE warrant_canary                 ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Public civic data — anon + authenticated SELECT
-- Core mission: all civic data is publicly readable, always.
-- ---------------------------------------------------------------------------

CREATE POLICY "public_jurisdictions_select"
  ON jurisdictions FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_governing_bodies_select"
  ON governing_bodies FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "public_officials_select"
  ON officials FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "public_agencies_select"
  ON agencies FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "public_proposals_select"
  ON proposals FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_votes_select"
  ON votes FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_financial_relationships_select"
  ON financial_relationships FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_entity_connections_select"
  ON entity_connections FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_promises_select"
  ON promises FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_career_history_select"
  ON career_history FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_spending_records_select"
  ON spending_records FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "public_warrant_canary_select"
  ON warrant_canary FOR SELECT
  TO anon, authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- Public civic comments — readable by all, writable by owner
-- ---------------------------------------------------------------------------

CREATE POLICY "public_civic_comments_select"
  ON civic_comments FOR SELECT
  TO anon, authenticated
  USING (is_deleted = false);

CREATE POLICY "civic_comments_insert"
  ON civic_comments FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid()::text = user_id::text);

CREATE POLICY "civic_comments_update"
  ON civic_comments FOR UPDATE
  TO authenticated
  USING (auth.uid()::text = user_id::text);

-- ---------------------------------------------------------------------------
-- Users — private, owner-only
-- ---------------------------------------------------------------------------

CREATE POLICY "users_select_own"
  ON users FOR SELECT
  TO authenticated
  USING (auth.uid()::text = id::text);

CREATE POLICY "users_update_own"
  ON users FOR UPDATE
  TO authenticated
  USING (auth.uid()::text = id::text);

-- ---------------------------------------------------------------------------
-- Official comment submissions — owner-only
-- Submission is always free; privacy of drafts belongs to the user.
-- ---------------------------------------------------------------------------

CREATE POLICY "official_comment_submissions_select_own"
  ON official_comment_submissions FOR SELECT
  TO authenticated
  USING (auth.uid()::text = user_id::text);

CREATE POLICY "official_comment_submissions_insert"
  ON official_comment_submissions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid()::text = user_id::text);

CREATE POLICY "official_comment_submissions_update_own"
  ON official_comment_submissions FOR UPDATE
  TO authenticated
  USING (auth.uid()::text = user_id::text);

-- ---------------------------------------------------------------------------
-- Civic credit transactions — owner-only read, service-role write
-- ---------------------------------------------------------------------------

CREATE POLICY "civic_credit_transactions_select_own"
  ON civic_credit_transactions FOR SELECT
  TO authenticated
  USING (auth.uid()::text = user_id::text);

-- =============================================================================
-- POSTGIS STORED FUNCTIONS
-- Called via supabase.rpc() from the application layer.
-- =============================================================================

-- Find every official who represents a given (coarsened) coordinate.
-- Mirrors the canonical query in CLAUDE.md.
CREATE OR REPLACE FUNCTION find_representatives_by_location(user_lat FLOAT, user_lng FLOAT)
RETURNS TABLE (
  id             UUID,
  full_name      TEXT,
  role_title     TEXT,
  party          party,
  governing_body TEXT,
  jurisdiction   TEXT
) AS $$
  SELECT
    o.id,
    o.full_name,
    o.role_title,
    o.party,
    gb.name  AS governing_body,
    j.name   AS jurisdiction
  FROM officials o
  JOIN governing_bodies gb ON o.governing_body_id = gb.id
  JOIN jurisdictions    j  ON o.jurisdiction_id   = j.id
  WHERE
    o.is_active = true
    AND ST_Contains(
      j.boundary_geometry,
      ST_SetSRID(ST_Point(user_lng, user_lat), 4326)
    )
  ORDER BY j.type, o.role_title;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Find all jurisdiction nodes that contain a point, from most to least specific.
CREATE OR REPLACE FUNCTION find_jurisdictions_by_location(user_lat FLOAT, user_lng FLOAT)
RETURNS TABLE (
  id         UUID,
  name       TEXT,
  type       jurisdiction_type,
  short_name TEXT
) AS $$
  SELECT
    j.id,
    j.name,
    j.type,
    j.short_name
  FROM jurisdictions j
  WHERE
    j.is_active = true
    AND ST_Contains(
      j.boundary_geometry,
      ST_SetSRID(ST_Point(user_lng, user_lat), 4326)
    )
  ORDER BY
    CASE j.type
      WHEN 'precinct'       THEN 1
      WHEN 'district'       THEN 2
      WHEN 'city'           THEN 3
      WHEN 'county'         THEN 4
      WHEN 'state'          THEN 5
      WHEN 'country'        THEN 6
      WHEN 'supranational'  THEN 7
      WHEN 'global'         THEN 8
      ELSE                       9
    END;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
