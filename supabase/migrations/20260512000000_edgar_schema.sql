-- =============================================================================
-- FIX-253 · SEC EDGAR ingest schema — major shareholders + executive officers.
--
-- V1 universe: S&P 500 (packages/data/src/pipelines/edgar/data/sp500.csv).
-- V1 sources: DEF 14A (officer roster + compensation), 10-K fallback (officer
-- roster only), SC 13D / SC 13G / amendments (beneficial-ownership filings).
-- V1 does NOT cover: 13F institutional holdings, full S&P universe expansion,
-- donor-employer-driven universe.
--
-- Architectural pattern: this migration adds **only metadata tables**. EDGAR-
-- derived edges land in public.external_relationships with source='edgar' and
-- use existing connection_type enum values ('appointment' for execs, 'owns'
-- for major shareholders). Block 10 of rebuild_entity_connections() already
-- materializes these — no enum extension, no RPC change.
--
-- SEC fair-access policy requires real contact User-Agent + 10 req/sec
-- ceiling; both are enforced in packages/data/src/pipelines/edgar/client.ts.
-- =============================================================================

-- ── edgar_companies ────────────────────────────────────────────────────────
--
-- Tracked universe. CIK (Central Index Key, SEC's natural ID per filer) is the
-- dedup arbiter. financial_entity_id binds the EDGAR row to the corp-as-entity
-- row in public.financial_entities so edges can target the entity directly.

CREATE TABLE IF NOT EXISTS public.edgar_companies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  cik                 TEXT NOT NULL,                          -- 10-digit zero-padded
  ticker              TEXT,                                   -- primary exchange ticker; nullable for delisted
  name                TEXT NOT NULL,                          -- display name as filed
  canonical_name      TEXT NOT NULL,                          -- canonicalizeEntityName(name)
  sic_code            TEXT,                                   -- SEC industry code
  state_of_inc        TEXT,                                   -- state of incorporation
  sector              TEXT,                                   -- GICS sector (from sp500.csv)

  financial_entity_id UUID REFERENCES public.financial_entities(id),

  source_ids          JSONB NOT NULL DEFAULT '{}',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(cik)
);

CREATE INDEX IF NOT EXISTS edgar_companies_canonical_name_idx
  ON public.edgar_companies(canonical_name);
CREATE INDEX IF NOT EXISTS edgar_companies_ticker_idx
  ON public.edgar_companies(ticker) WHERE ticker IS NOT NULL;
CREATE INDEX IF NOT EXISTS edgar_companies_financial_entity_idx
  ON public.edgar_companies(financial_entity_id) WHERE financial_entity_id IS NOT NULL;

COMMENT ON TABLE public.edgar_companies IS
  'Tracked universe of public companies from SEC EDGAR. V1: S&P 500. Per-row financial_entity_id links the company to its financial_entities corporation row for entity_connections edges. Source: https://www.sec.gov/edgar/. FIX-253.';

-- ── edgar_executive_officers ───────────────────────────────────────────────
--
-- One row per (company, person, year, role_category) from a single filing.
-- canonical_name uses the same normalizeName transform that FEC indiv applies
-- to donor names (apostrophe/period→empty, FIX-244-hardened) so donor-side
-- matching joins on identical strings.
--
-- financial_entity_id is NULL until the matcher resolves a confident donor.
-- match_confidence='high' is the only auto-link state in V1. Weaker matches
-- route to external_relationships_review_queue, leaving this column NULL.

CREATE TABLE IF NOT EXISTS public.edgar_executive_officers (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID NOT NULL REFERENCES public.edgar_companies(id) ON DELETE CASCADE,

  full_name                TEXT NOT NULL,                     -- as filed
  canonical_name           TEXT NOT NULL,                     -- normalizeName(full_name)
  title                    TEXT NOT NULL,                     -- "Chief Executive Officer", as filed
  role_category            TEXT NOT NULL,                     -- ceo|cfo|coo|chairperson|director|officer|other

  source_filing_type       TEXT NOT NULL,                     -- 'DEF 14A' | 'DEF 14A/A' | '10-K'
  source_accession         TEXT NOT NULL,                     -- e.g. 0000320193-24-000123
  effective_year           INTEGER NOT NULL,                  -- proxy year / fiscal year

  total_compensation_cents BIGINT,                            -- from Summary Compensation Table

  financial_entity_id      UUID REFERENCES public.financial_entities(id),
  match_confidence         TEXT,                              -- 'high' | NULL (V1: only auto-link 'high')

  source_ids               JSONB NOT NULL DEFAULT '{}',
  metadata                 JSONB NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(company_id, canonical_name, effective_year, role_category)
);

CREATE INDEX IF NOT EXISTS edgar_officers_company_idx
  ON public.edgar_executive_officers(company_id);
CREATE INDEX IF NOT EXISTS edgar_officers_canonical_name_idx
  ON public.edgar_executive_officers(canonical_name);
CREATE INDEX IF NOT EXISTS edgar_officers_financial_entity_idx
  ON public.edgar_executive_officers(financial_entity_id) WHERE financial_entity_id IS NOT NULL;

COMMENT ON TABLE public.edgar_executive_officers IS
  'Officer / director roster per S&P 500 company, sourced from DEF 14A and 10-K filings. financial_entity_id resolves to the FEC donor row when an exec is also a personally-itemized donor (exact name + employer match). FIX-253.';

-- ── edgar_major_shareholders ───────────────────────────────────────────────
--
-- One row per (accession, holder). Schedule 13D, 13G, and their amendments
-- (/A) disclose >5% beneficial ownership; a single accession can name several
-- co-filers, hence the composite UNIQUE.

CREATE TABLE IF NOT EXISTS public.edgar_major_shareholders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES public.edgar_companies(id) ON DELETE CASCADE,

  holder_name           TEXT NOT NULL,                        -- as filed
  canonical_holder_name TEXT NOT NULL,                        -- normalizeName / canonicalizeEntityName

  filing_type           TEXT NOT NULL CHECK (filing_type IN ('SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A')),
  accession             TEXT NOT NULL,
  filed_at              DATE NOT NULL,
  event_date            DATE,                                 -- "date of event which requires filing"

  pct_of_class          NUMERIC(7,4),                         -- percent ownership disclosed
  shares_held           BIGINT,

  financial_entity_id   UUID REFERENCES public.financial_entities(id),
  match_confidence      TEXT,

  source_ids            JSONB NOT NULL DEFAULT '{}',
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(accession, canonical_holder_name)
);

CREATE INDEX IF NOT EXISTS edgar_shareholders_company_idx
  ON public.edgar_major_shareholders(company_id);
CREATE INDEX IF NOT EXISTS edgar_shareholders_canonical_idx
  ON public.edgar_major_shareholders(canonical_holder_name);
CREATE INDEX IF NOT EXISTS edgar_shareholders_financial_entity_idx
  ON public.edgar_major_shareholders(financial_entity_id) WHERE financial_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS edgar_shareholders_filed_at_idx
  ON public.edgar_major_shareholders(filed_at DESC);

COMMENT ON TABLE public.edgar_major_shareholders IS
  'Beneficial-owner disclosures (>5%) from SC 13D / SC 13G filings per S&P 500 company. financial_entity_id resolves when the holder name maps to an existing donor or corporation. FIX-253.';

-- ── RLS — SELECT public, writes via admin client ───────────────────────────

ALTER TABLE public.edgar_companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edgar_executive_officers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edgar_major_shareholders   ENABLE ROW LEVEL SECURITY;

CREATE POLICY edgar_companies_select_all
  ON public.edgar_companies          FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY edgar_officers_select_all
  ON public.edgar_executive_officers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY edgar_shareholders_select_all
  ON public.edgar_major_shareholders FOR SELECT TO anon, authenticated USING (true);
