-- =============================================================================
-- FIX-250 — IRS Form 990 bulk ingest (officers + grants-out, NOT donors)
--
-- 990s do NOT disclose donors. Schedule B is redacted in the public e-file
-- distribution. This pipeline ingests three signals from each filing:
--   1. Officers / directors / key employees (Part VII Section A)
--   2. Grants out (Schedule I)
--   3. Financial summary (revenue / assets / expenses)
--
-- All three feed network-structure analysis: who sits on which boards, where
-- politically-active nonprofits route money between each other. None of it is
-- donor identification.
--
-- Schema additions:
--   - financial_entities.entity_type gains 'nonprofit'
--   - irs990_filings        — one row per (EIN, tax_year, filing) — UNIQUE on object_id (IRS DLN)
--   - irs990_officers       — one row per (filing, person, role)
--   - irs990_grants_out     — one row per (filing, recipient, amount cluster)
--
-- rebuild_entity_connections() block 6 (holds_position) gains a UNION:
-- officer rows whose matched_entity_id resolved to an `officials` row become
-- 'holds_position' edges (from='official', to='financial_entity'=nonprofit).
-- =============================================================================

-- ── 1. Extend financial_entities.entity_type to include 'nonprofit' ─────────
-- The CHECK constraint was created with the auto-generated name when the
-- shadow schema was promoted in 20260422000000. Belt-and-braces: drop both
-- likely names, then add the new one with the full list including 'nonprofit'.

ALTER TABLE public.financial_entities
  DROP CONSTRAINT IF EXISTS financial_entities_entity_type_check;
ALTER TABLE public.financial_entities
  DROP CONSTRAINT IF EXISTS shadow_financial_entities_entity_type_check;

ALTER TABLE public.financial_entities
  ADD CONSTRAINT financial_entities_entity_type_check
  CHECK (entity_type IN (
    'individual', 'pac', 'super_pac', 'corporation',
    'union', 'party_committee', 'small_donor_aggregate',
    'tribal', '527', 'nonprofit', 'other'
  ));

-- ── 2. irs990_filings ───────────────────────────────────────────────────────
-- One row per filing. object_id is the IRS-assigned DLN per filing — globally
-- unique and stable, so it's the only idempotency key we need. EIN + tax_year
-- alone is NOT unique because an org can file an amended return or a different
-- form type (990 vs 990EZ) for the same tax year.

CREATE TABLE IF NOT EXISTS public.irs990_filings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_entity_id      UUID NOT NULL REFERENCES public.financial_entities(id),
  ein                      TEXT NOT NULL,
  tax_year                 INTEGER NOT NULL,
  filing_type              TEXT NOT NULL,
  object_id                TEXT NOT NULL UNIQUE,
  subsection_code          SMALLINT,
  ntee_code                TEXT,
  total_revenue_cents      BIGINT,
  total_assets_eoy_cents   BIGINT,
  total_expenses_cents     BIGINT,
  address_state            TEXT,
  source_url               TEXT NOT NULL,
  schema_version           TEXT,
  fetched_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS irs990_filings_ein_year
  ON public.irs990_filings(ein, tax_year);
CREATE INDEX IF NOT EXISTS irs990_filings_entity
  ON public.irs990_filings(financial_entity_id);

COMMENT ON TABLE public.irs990_filings IS
  'FIX-250 — One row per IRS 990 e-file filing. object_id is the IRS DLN (globally unique). 990 data does NOT include donors.';

-- ── 3. irs990_officers ──────────────────────────────────────────────────────
-- Part VII Section A. Officer rows whose canonical name matches an existing
-- `officials` row get matched_entity_id set; otherwise matched_entity_id stays
-- NULL and the raw row remains as the audit trail. Phase 1 only matches against
-- officials (high-precision IDs). Donor-side matching is a separate FIX.

CREATE TABLE IF NOT EXISTS public.irs990_officers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id             UUID NOT NULL REFERENCES public.irs990_filings(id) ON DELETE CASCADE,
  person_name           TEXT NOT NULL,
  name_canonical        TEXT NOT NULL,
  role_title            TEXT NOT NULL,
  compensation_cents    BIGINT,
  hours_per_week        NUMERIC(5,2),
  matched_entity_type   TEXT CHECK (matched_entity_type IN ('official', 'financial_entity')),
  matched_entity_id     UUID,
  match_confidence      NUMERIC(3,2),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(filing_id, name_canonical, role_title)
);

CREATE INDEX IF NOT EXISTS irs990_officers_matched
  ON public.irs990_officers(matched_entity_type, matched_entity_id)
  WHERE matched_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS irs990_officers_name_canonical
  ON public.irs990_officers(name_canonical);

COMMENT ON TABLE public.irs990_officers IS
  'FIX-250 — Officers / directors / key employees from Form 990 Part VII Section A. matched_entity_id resolves to officials.id when canonical name matches; donor-side matching deferred to Phase 2.';

-- ── 4. irs990_grants_out ────────────────────────────────────────────────────
-- Schedule I grants from this nonprofit TO another org / individual.
-- recipient_ein is the precise match key when present (often blank in older
-- filings). matched_entity_id resolves to financial_entities when we can
-- find the recipient in our data (other ingested nonprofits, PACs, etc.).
-- When resolved, the orchestrator also writes a financial_relationships row
-- with relationship_type='grant' so the graph derivation picks it up.

CREATE TABLE IF NOT EXISTS public.irs990_grants_out (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id                   UUID NOT NULL REFERENCES public.irs990_filings(id) ON DELETE CASCADE,
  recipient_name              TEXT NOT NULL,
  recipient_name_canonical    TEXT NOT NULL,
  recipient_ein               TEXT,
  amount_cents                BIGINT NOT NULL,
  purpose                     TEXT,
  matched_entity_type         TEXT CHECK (matched_entity_type IN ('financial_entity', 'agency', 'official')),
  matched_entity_id           UUID,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(filing_id, recipient_name_canonical, amount_cents)
);

CREATE INDEX IF NOT EXISTS irs990_grants_out_recipient_ein
  ON public.irs990_grants_out(recipient_ein)
  WHERE recipient_ein IS NOT NULL;
CREATE INDEX IF NOT EXISTS irs990_grants_out_recipient_name
  ON public.irs990_grants_out(recipient_name_canonical);

COMMENT ON TABLE public.irs990_grants_out IS
  'FIX-250 — Schedule I grants OUT (from this nonprofit to another org/individual). When a recipient resolves to a financial_entities row, the orchestrator also writes a financial_relationships row of type=grant so rebuild_entity_connections() picks up the edge.';

-- ── 5. Extend rebuild_entity_connections() ──────────────────────────────────
-- Block 6 (holds_position) currently only sources from financial_relationships
-- where relationship_type IN ('owns_stock','owns_bond','property'). Extend it
-- via UNION to also include irs990_officers rows whose matched_entity_id
-- resolved to an official.
--
-- Edge shape for officer rows:
--   from_type = 'official',
--   from_id   = irs990_officers.matched_entity_id,
--   to_type   = 'financial_entity',
--   to_id     = irs990_filings.financial_entity_id (the nonprofit),
--   amount_cents = officer's compensation (nullable),
--   occurred_at  = NULL (filings carry tax_year not an exact date),
--   evidence_source = 'irs990_officers'.
--
-- Strength: fixed 0.700 — board membership is a strong relationship
-- regardless of compensation; we don't have a log-scaled signal here.
--
-- Rest of the function body is identical to 20260510000004 byte-for-byte.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count        BIGINT;
  v_vote_yes     BIGINT;
  v_vote_no      BIGINT;
  v_vote_abstain BIGINT;
BEGIN
  TRUNCATE TABLE public.entity_connections;

  -- ── 1. donation (includes ie_support — FIX-240) ──────────────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'donation'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'donation'; edges_upserted := v_count; RETURN NEXT;

  -- ── 1b. recipient_count — update individual donor cross-official count ────
  UPDATE public.financial_entities fe
  SET recipient_count = sub.cnt
  FROM (
    SELECT
      ec.from_id,
      COUNT(DISTINCT ec.to_id)::SMALLINT AS cnt
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'donation'
      AND ec.from_type = 'financial_entity'
    GROUP BY ec.from_id
  ) sub
  WHERE fe.id = sub.from_id
    AND fe.entity_type = 'individual';

  -- ── 2. vote_yes / vote_no / vote_abstain ────────────────────────────────
  WITH inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT DISTINCT ON (v.official_id, v.bill_proposal_id)
      'official', v.official_id, 'proposal', v.bill_proposal_id,
      (CASE v.vote
         WHEN 'yes'     THEN 'vote_yes'
         WHEN 'no'      THEN 'vote_no'
         WHEN 'abstain' THEN 'vote_abstain'
       END)::public.connection_type,
      0.500::numeric(4,3),
      v.voted_at::date,
      1, 'votes', ARRAY[v.id]
    FROM public.votes v
    WHERE v.bill_proposal_id IS NOT NULL
      AND v.official_id IS NOT NULL
      AND v.vote IN ('yes', 'no', 'abstain')
    ORDER BY v.official_id, v.bill_proposal_id, v.voted_at DESC NULLS LAST, v.id DESC
    RETURNING entity_connections.connection_type AS ct
  )
  SELECT
    COUNT(*) FILTER (WHERE ct = 'vote_yes'),
    COUNT(*) FILTER (WHERE ct = 'vote_no'),
    COUNT(*) FILTER (WHERE ct = 'vote_abstain')
  INTO v_vote_yes, v_vote_no, v_vote_abstain
  FROM inserted;

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;

  -- ── 3. co_sponsorship ────────────────────────────────────────────────────
  WITH inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      'official', pc.official_id, 'proposal', pc.proposal_id,
      'co_sponsorship'::public.connection_type,
      CASE WHEN pc.is_original_cosponsor THEN 0.700 ELSE 0.600 END::numeric(4,3),
      pc.date_added,
      1, 'cosponsorship', ARRAY[pc.id]
    FROM public.proposal_cosponsors pc
    WHERE pc.date_withdrawn IS NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'co_sponsorship'; edges_upserted := v_count; RETURN NEXT;

  -- ── 4. appointment (career_history → governing_body) ─────────────────────
  WITH agg AS (
    SELECT
      ch.official_id,
      ch.governing_body_id,
      MIN(ch.started_at)         AS first_started_at,
      MAX(COALESCE(ch.ended_at, CURRENT_DATE)) FILTER (WHERE ch.ended_at IS NOT NULL) AS last_ended_at,
      BOOL_OR(ch.ended_at IS NULL) AS still_active,
      COUNT(*)                   AS evidence_count,
      (ARRAY_AGG(ch.id ORDER BY ch.started_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.career_history ch
    WHERE ch.is_government = true
      AND ch.governing_body_id IS NOT NULL
    GROUP BY ch.official_id, ch.governing_body_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      'official', a.official_id, 'governing_body', a.governing_body_id,
      'appointment'::public.connection_type,
      CASE WHEN a.still_active THEN 0.700 ELSE 0.500 END::numeric(4,3),
      a.first_started_at,
      CASE WHEN a.still_active THEN NULL ELSE a.last_ended_at END,
      a.evidence_count, 'career_history', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'appointment'; edges_upserted := v_count; RETURN NEXT;

  -- ── 5. oversight (governing_body → agency, static lookup) ────────────────
  WITH inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      'governing_body', ag.governing_body_id, 'agency', ag.id,
      'oversight'::public.connection_type,
      0.700::numeric(4,3),
      1, 'agency_oversight', ARRAY[ag.id]
    FROM public.agencies ag
    WHERE ag.governing_body_id IS NOT NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'oversight'; edges_upserted := v_count; RETURN NEXT;

  -- ── 6. holds_position — financial_relationships + irs990_officers ────────
  -- (FIX-250) Two sources, UNIONed before aggregation. Source A is the
  -- pre-existing stock/bond/property derivation. Source B is officers/board
  -- members from 990s whose matched_entity_id resolved to an `officials` row.
  WITH src AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      fr.id,
      fr.amount_cents,
      fr.started_at AS occurred_at
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('owns_stock', 'owns_bond', 'property')
      AND fr.ended_at IS NULL

    UNION ALL

    SELECT
      'official'::text         AS from_type,
      o.matched_entity_id      AS from_id,
      'financial_entity'::text AS to_type,
      f.financial_entity_id    AS to_id,
      o.id,
      o.compensation_cents     AS amount_cents,
      NULL::date               AS occurred_at
    FROM public.irs990_officers o
    JOIN public.irs990_filings  f ON f.id = o.filing_id
    WHERE o.matched_entity_id   IS NOT NULL
      AND o.matched_entity_type = 'official'
  ), agg AS (
    SELECT
      from_type, from_id, to_type, to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(amount_cents, 0))    AS total_cents,
      MIN(occurred_at)                  AS first_at,
      (ARRAY_AGG(id ORDER BY occurred_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM src
    GROUP BY from_type, from_id, to_type, to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'holds_position'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        0.4 + LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 16.0
      ))::numeric(4,3),
      NULLIF(a.total_cents, 0), a.first_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'holds_position'; edges_upserted := v_count; RETURN NEXT;

  -- ── 7. gift_received (gift / honorarium) ─────────────────────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.occurred_at)               AS first_at,
      MAX(fr.occurred_at)               AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('gift', 'honorarium')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'gift_received'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 6.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'gift_received'; edges_upserted := v_count; RETURN NEXT;

  -- ── 8. contract_award (contract / grant) ─────────────────────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.occurred_at)               AS first_at,
      MAX(fr.occurred_at)               AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('contract', 'grant')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'contract_award'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 9.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'contract_award'; edges_upserted := v_count; RETURN NEXT;

  -- ── 9. lobbying (lobbying_spend) ─────────────────────────────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.started_at)                AS first_at,
      MAX(COALESCE(fr.ended_at, CURRENT_DATE)) AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.started_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'lobbying_spend'
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'lobbying'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;
  connection_type := 'lobbying'; edges_upserted := v_count; RETURN NEXT;

  RETURN;
END;
$$;

-- Preserve the 15-min timeout override (set in 20260430000000).
ALTER FUNCTION public.rebuild_entity_connections() SET statement_timeout = '15min';

COMMENT ON FUNCTION public.rebuild_entity_connections() IS
  'FIX-250 — Block 6 (holds_position) now UNIONs financial_relationships(owns_stock/bond/property) with irs990_officers(matched_entity_id IS NOT NULL). All other blocks unchanged from 20260510000004.';
