-- 20260527000000_attribution_coverage_402_410_406.sql
-- FIX-402 + FIX-410 + FIX-406: lift attribution binding rate.
--
-- FIX-402 — governing_bodies gets its own primary_source* columns and a
-- dispatch path. The FIX-397 migration mis-dispatched both 'agency' and
-- 'governing_body' xsr rows to public.agencies, so the ~255 legistar gb
-- bindings never materialized anywhere readable and the harness reported
-- governing_bodies as a phantom 0%. Splitting the dispatch:
--   xsr 'governing_body' → public.governing_bodies
--   xsr 'agency'         → public.agencies
--
-- FIX-410 — agencies (100 rows, ~0% bound today) are seeded against
-- regulations_gov. Origin investigation (per the prompt's gate) found 91 of
-- 99 rows carry source_ids->>'regulations_gov_agency_id'; the regulations.gov
-- pipeline insert-on-miss is the de-facto provenance and seed migrations
-- 20260425000500/600/800 explicitly stamped this id. The remaining 8 (EOP +
-- ICE/TSA/FEMA + a couple of metadata-stripped legacy rows) lack any source
-- key and stay null — the prompt's "don't guess a source" rule.
--
-- FIX-406 — FEC dedup is structurally outside xsr (financial_entities.
-- fec_committee_id UNIQUE is the canonical key). Synthesize primary_source=
-- 'fec' at derivation time from the first-class column on financial_entities
-- (via fec_committee_id) and officials (via source_ids->>'fec_candidate_id').
-- Real xsr winners always win; synthesis only fills rows where primary_source
-- is still NULL after the xsr pass. fec is priority 2, so a candidate
-- official with a congress_gov xsr row stays bound to congress (correct).
--
-- This migration:
--   1. Adds the three primary_source columns + index to governing_bodies.
--   2. Recreates refresh_primary_source_for_entities to split the dispatch
--      and to fill the FEC synthetic branches.
--   3. Recreates rebuild_all_primary_sources with a governing_bodies block,
--      a narrowed agencies block, and the FEC synthetic branches.
--   4. Re-issues the ALTER FUNCTION ... SET statement_timeout clauses
--      (CREATE OR REPLACE drops them) and re-GRANTs EXECUTE.
--   5. Seeds external_source_refs for agencies that carry a
--      regulations_gov_agency_id. Env-portable INSERT … SELECT — no
--      hardcoded UUIDs, same statement applies local and prod.
--   6. Runs rebuild_all_primary_sources() once so the migration materializes
--      data on apply (sidesteps the "rerun against each env" hazard).
--
-- SQL URL templates here duplicate the TS SOURCE_URL_TEMPLATES in
-- packages/db/src/types/attribution.ts — keep them in hand-sync; FIX-407
-- will de-dupe.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

-- ── 1. governing_bodies primary_source columns (FIX-402) ──────────────────

ALTER TABLE public.governing_bodies
  ADD COLUMN IF NOT EXISTS primary_source              TEXT,
  ADD COLUMN IF NOT EXISTS primary_source_url          TEXT,
  ADD COLUMN IF NOT EXISTS primary_source_last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS governing_bodies_primary_source_idx
  ON public.governing_bodies (primary_source);

-- ── 2. Writer-side refresh helper — split dispatch + FEC synthesis ────────

CREATE OR REPLACE FUNCTION public.refresh_primary_source_for_entities(
  p_entity_type TEXT,
  p_entity_ids  UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_target_table TEXT;
  v_xsr_types    TEXT[];
  v_rows_updated INTEGER := 0;
  v_synth_rows   INTEGER := 0;
BEGIN
  IF p_entity_ids IS NULL OR array_length(p_entity_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  CASE p_entity_type
    WHEN 'official'         THEN v_target_table := 'officials';          v_xsr_types := ARRAY['official'];
    WHEN 'proposal'         THEN v_target_table := 'proposals';          v_xsr_types := ARRAY['proposal'];
    WHEN 'financial_entity' THEN v_target_table := 'financial_entities'; v_xsr_types := ARRAY['financial_entity'];
    WHEN 'agency'           THEN v_target_table := 'agencies';           v_xsr_types := ARRAY['agency'];
    WHEN 'governing_body'   THEN v_target_table := 'governing_bodies';   v_xsr_types := ARRAY['governing_body'];
    ELSE
      RAISE WARNING 'refresh_primary_source_for_entities: unsupported entity_type=%, skipping', p_entity_type;
      RETURN 0;
  END CASE;

  EXECUTE format($q$
    WITH winners AS (
      SELECT DISTINCT ON (entity_id)
             entity_id, source, source_url, last_seen_at
        FROM public.external_source_refs
       WHERE entity_type = ANY($1)
         AND entity_id   = ANY($2)
       ORDER BY entity_id, public.source_priority(source) ASC, last_seen_at DESC
    )
    UPDATE public.%I t
       SET primary_source              = w.source,
           primary_source_url          = w.source_url,
           primary_source_last_seen_at = w.last_seen_at
      FROM winners w
     WHERE t.id = w.entity_id
       AND (t.primary_source              IS DISTINCT FROM w.source
         OR t.primary_source_url          IS DISTINCT FROM w.source_url
         OR t.primary_source_last_seen_at IS DISTINCT FROM w.last_seen_at)
  $q$, v_target_table)
  USING v_xsr_types, p_entity_ids;
  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  -- ── Vote propagation: votes inherit from parent proposal ───────────────
  IF p_entity_type = 'proposal' THEN
    UPDATE public.votes v
       SET primary_source              = p.primary_source,
           primary_source_url          = p.primary_source_url,
           primary_source_last_seen_at = p.primary_source_last_seen_at
      FROM public.proposals p
     WHERE v.bill_proposal_id = p.id
       AND v.bill_proposal_id = ANY(p_entity_ids)
       AND (v.primary_source              IS DISTINCT FROM p.primary_source
         OR v.primary_source_url          IS DISTINCT FROM p.primary_source_url
         OR v.primary_source_last_seen_at IS DISTINCT FROM p.primary_source_last_seen_at);
  END IF;

  -- ── FIX-406: synthetic FEC fill for rows still NULL after xsr winners ──
  -- Real xsr bindings (including a future fec xsr row) win priority. fec is
  -- priority 2; congress_gov is 1. A candidate official with both keys stays
  -- bound to congress_gov.
  IF p_entity_type = 'financial_entity' THEN
    UPDATE public.financial_entities fe
       SET primary_source              = 'fec',
           primary_source_url          = 'https://www.fec.gov/data/committee/' || fe.fec_committee_id || '/',
           primary_source_last_seen_at = COALESCE(fe.updated_at, NOW())
     WHERE fe.id = ANY(p_entity_ids)
       AND fe.primary_source IS NULL
       AND fe.fec_committee_id IS NOT NULL;
    GET DIAGNOSTICS v_synth_rows = ROW_COUNT;
    v_rows_updated := v_rows_updated + v_synth_rows;
  ELSIF p_entity_type = 'official' THEN
    UPDATE public.officials o
       SET primary_source              = 'fec',
           primary_source_url          = 'https://www.fec.gov/data/candidate/' || (o.source_ids->>'fec_candidate_id') || '/',
           primary_source_last_seen_at = COALESCE(o.updated_at, NOW())
     WHERE o.id = ANY(p_entity_ids)
       AND o.primary_source IS NULL
       AND o.source_ids ? 'fec_candidate_id'
       AND (o.source_ids->>'fec_candidate_id') IS NOT NULL;
    GET DIAGNOSTICS v_synth_rows = ROW_COUNT;
    v_rows_updated := v_rows_updated + v_synth_rows;
  END IF;

  RETURN v_rows_updated;
END;
$fn$;

COMMENT ON FUNCTION public.refresh_primary_source_for_entities(TEXT, UUID[]) IS
  'FIX-397 + FIX-402 + FIX-406: writer-side primary_source refresh. Per-type dispatch (governing_body → governing_bodies; agency → agencies; etc.). After the xsr winners pass, fills synthetic primary_source=''fec'' for financial_entities with fec_committee_id and officials with source_ids->>''fec_candidate_id'' (rows still NULL only — real xsr bindings always win). When called for proposals, propagates to child votes.';

-- ── 3. Full rebuild — governing_bodies block + FEC synthesis ──────────────

CREATE OR REPLACE FUNCTION public.rebuild_all_primary_sources()
RETURNS TABLE(table_name TEXT, rows_updated INTEGER)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_rows INTEGER;
BEGIN
  -- officials (xsr)
  WITH winners AS (
    SELECT DISTINCT ON (entity_id)
           entity_id, source, source_url, last_seen_at
      FROM public.external_source_refs
     WHERE entity_type = 'official'
     ORDER BY entity_id, public.source_priority(source) ASC, last_seen_at DESC
  )
  UPDATE public.officials o
     SET primary_source              = w.source,
         primary_source_url          = w.source_url,
         primary_source_last_seen_at = w.last_seen_at
    FROM winners w
   WHERE o.id = w.entity_id
     AND (o.primary_source              IS DISTINCT FROM w.source
       OR o.primary_source_url          IS DISTINCT FROM w.source_url
       OR o.primary_source_last_seen_at IS DISTINCT FROM w.last_seen_at);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'officials'; rows_updated := v_rows; RETURN NEXT;

  -- officials — FIX-406 synthetic FEC fill (NULL-only)
  UPDATE public.officials o
     SET primary_source              = 'fec',
         primary_source_url          = 'https://www.fec.gov/data/candidate/' || (o.source_ids->>'fec_candidate_id') || '/',
         primary_source_last_seen_at = COALESCE(o.updated_at, NOW())
   WHERE o.primary_source IS NULL
     AND o.source_ids ? 'fec_candidate_id'
     AND (o.source_ids->>'fec_candidate_id') IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'officials_fec_synth'; rows_updated := v_rows; RETURN NEXT;

  -- proposals
  WITH winners AS (
    SELECT DISTINCT ON (entity_id)
           entity_id, source, source_url, last_seen_at
      FROM public.external_source_refs
     WHERE entity_type = 'proposal'
     ORDER BY entity_id, public.source_priority(source) ASC, last_seen_at DESC
  )
  UPDATE public.proposals p
     SET primary_source              = w.source,
         primary_source_url          = w.source_url,
         primary_source_last_seen_at = w.last_seen_at
    FROM winners w
   WHERE p.id = w.entity_id
     AND (p.primary_source              IS DISTINCT FROM w.source
       OR p.primary_source_url          IS DISTINCT FROM w.source_url
       OR p.primary_source_last_seen_at IS DISTINCT FROM w.last_seen_at);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'proposals'; rows_updated := v_rows; RETURN NEXT;

  -- agencies (only xsr type 'agency' now; 'governing_body' goes to its own table)
  WITH winners AS (
    SELECT DISTINCT ON (entity_id)
           entity_id, source, source_url, last_seen_at
      FROM public.external_source_refs
     WHERE entity_type = 'agency'
     ORDER BY entity_id, public.source_priority(source) ASC, last_seen_at DESC
  )
  UPDATE public.agencies a
     SET primary_source              = w.source,
         primary_source_url          = w.source_url,
         primary_source_last_seen_at = w.last_seen_at
    FROM winners w
   WHERE a.id = w.entity_id
     AND (a.primary_source              IS DISTINCT FROM w.source
       OR a.primary_source_url          IS DISTINCT FROM w.source_url
       OR a.primary_source_last_seen_at IS DISTINCT FROM w.last_seen_at);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'agencies'; rows_updated := v_rows; RETURN NEXT;

  -- governing_bodies (FIX-402)
  WITH winners AS (
    SELECT DISTINCT ON (entity_id)
           entity_id, source, source_url, last_seen_at
      FROM public.external_source_refs
     WHERE entity_type = 'governing_body'
     ORDER BY entity_id, public.source_priority(source) ASC, last_seen_at DESC
  )
  UPDATE public.governing_bodies gb
     SET primary_source              = w.source,
         primary_source_url          = w.source_url,
         primary_source_last_seen_at = w.last_seen_at
    FROM winners w
   WHERE gb.id = w.entity_id
     AND (gb.primary_source              IS DISTINCT FROM w.source
       OR gb.primary_source_url          IS DISTINCT FROM w.source_url
       OR gb.primary_source_last_seen_at IS DISTINCT FROM w.last_seen_at);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'governing_bodies'; rows_updated := v_rows; RETURN NEXT;

  -- financial_entities (xsr)
  WITH winners AS (
    SELECT DISTINCT ON (entity_id)
           entity_id, source, source_url, last_seen_at
      FROM public.external_source_refs
     WHERE entity_type = 'financial_entity'
     ORDER BY entity_id, public.source_priority(source) ASC, last_seen_at DESC
  )
  UPDATE public.financial_entities fe
     SET primary_source              = w.source,
         primary_source_url          = w.source_url,
         primary_source_last_seen_at = w.last_seen_at
    FROM winners w
   WHERE fe.id = w.entity_id
     AND (fe.primary_source              IS DISTINCT FROM w.source
       OR fe.primary_source_url          IS DISTINCT FROM w.source_url
       OR fe.primary_source_last_seen_at IS DISTINCT FROM w.last_seen_at);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'financial_entities'; rows_updated := v_rows; RETURN NEXT;

  -- financial_entities — FIX-406 synthetic FEC fill (NULL-only)
  UPDATE public.financial_entities fe
     SET primary_source              = 'fec',
         primary_source_url          = 'https://www.fec.gov/data/committee/' || fe.fec_committee_id || '/',
         primary_source_last_seen_at = COALESCE(fe.updated_at, NOW())
   WHERE fe.primary_source IS NULL
     AND fe.fec_committee_id IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'financial_entities_fec_synth'; rows_updated := v_rows; RETURN NEXT;

  -- votes — inherit from parent proposal (no xsr binding of their own)
  UPDATE public.votes v
     SET primary_source              = p.primary_source,
         primary_source_url          = p.primary_source_url,
         primary_source_last_seen_at = p.primary_source_last_seen_at
    FROM public.proposals p
   WHERE v.bill_proposal_id = p.id
     AND (v.primary_source              IS DISTINCT FROM p.primary_source
       OR v.primary_source_url          IS DISTINCT FROM p.primary_source_url
       OR v.primary_source_last_seen_at IS DISTINCT FROM p.primary_source_last_seen_at);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  table_name := 'votes'; rows_updated := v_rows; RETURN NEXT;

  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.rebuild_all_primary_sources() IS
  'FIX-397 + FIX-402 + FIX-406: nightly safety-net rebuild. Re-derives primary_source for officials, proposals, agencies, governing_bodies, financial_entities; fills synthetic primary_source=''fec'' on officials/financial_entities for rows still NULL; propagates votes from parent proposal. Returns per-pass rows-updated for observability — synthetic branches report as <table>_fec_synth.';

-- ── 4. Function-level statement_timeouts + grants (CREATE OR REPLACE drops these) ─

ALTER FUNCTION public.refresh_primary_source_for_entities(TEXT, UUID[])
  SET statement_timeout = '60s';

ALTER FUNCTION public.rebuild_all_primary_sources()
  SET statement_timeout = '5min';

GRANT EXECUTE ON FUNCTION public.refresh_primary_source_for_entities(TEXT, UUID[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_all_primary_sources()                     TO service_role;

-- ── 5. FIX-410 seed: agencies xsr from regulations_gov_agency_id ──────────
-- 91 of 99 agencies on prod (and analogous on local) carry
-- source_ids->>'regulations_gov_agency_id' — the regulations.gov
-- insert-on-miss path and the FIX-107 seed migrations (DOD, TREAS, DOS, DOL,
-- GSA, SSA + DHS sub-agencies) explicitly stamped this id. Other agencies
-- (EOP, ICE/TSA/FEMA) lack any source key; they stay null.
--
-- ON CONFLICT (source, external_id) DO NOTHING — env-portable; safe to re-run.
INSERT INTO public.external_source_refs
  (source, external_id, entity_type, entity_id, source_url, last_seen_at, metadata)
SELECT
  'regulations_gov',
  a.source_ids->>'regulations_gov_agency_id',
  'agency',
  a.id,
  'https://www.regulations.gov/agency/' || (a.source_ids->>'regulations_gov_agency_id'),
  COALESCE(a.updated_at, NOW()),
  '{}'::jsonb
FROM public.agencies a
WHERE a.source_ids ? 'regulations_gov_agency_id'
  AND (a.source_ids->>'regulations_gov_agency_id') IS NOT NULL
  AND (a.source_ids->>'regulations_gov_agency_id') <> ''
ON CONFLICT (source, external_id) DO NOTHING;

-- ── 6. Initial backfill — materialize on apply ────────────────────────────

DO $backfill$
DECLARE
  t0  timestamptz := clock_timestamp();
  r   RECORD;
BEGIN
  RAISE NOTICE '[FIX-402/410/406] coverage backfill start: %', t0;
  FOR r IN SELECT * FROM public.rebuild_all_primary_sources() LOOP
    RAISE NOTICE '[FIX-402/410/406]   %: % rows updated', r.table_name, r.rows_updated;
  END LOOP;
  RAISE NOTICE '[FIX-402/410/406] backfill complete. Wall time: % s',
               EXTRACT(EPOCH FROM clock_timestamp() - t0)::numeric(10,2);
END
$backfill$;
