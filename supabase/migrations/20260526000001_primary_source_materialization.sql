-- 20260526000001_primary_source_materialization.sql
-- FIX-397: materialize primary_source on entity tables.
--
-- Adds three columns — primary_source / primary_source_url /
-- primary_source_last_seen_at — to officials, proposals, agencies,
-- financial_entities, and votes. Derived from external_source_refs via a
-- priority enum + last_seen_at tiebreak. Votes inherit from their parent
-- proposal (no xsr binding for votes per the canonical entity_type list in
-- 20260421000001_stage1_02_external_source_refs.sql).
--
-- Refresh strategy: writer-side helper called after each pipeline's xsr
-- batch upsert, plus a nightly full rebuild as a safety net. NO triggers —
-- the xsr schema migration explicitly rejected triggers on write-cost grounds
-- (see 20260421000001_stage1_02_external_source_refs.sql:L8).
--
-- Closes (as superseded) FIX-393 — legistar metadata->>'source' stamping is
-- no longer needed because attribution now flows through xsr.
--
-- xsr.entity_type heterogeneity note: agencies are bound under BOTH 'agency'
-- AND 'governing_body' depending on which pipeline wrote the row
-- (agency-leadership writes 'agency', legistar writes 'governing_body').
-- Both dispatch to public.agencies here. The normalization itself is a
-- separate cleanup (filed as a follow-up FIX).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

-- ── 1. source_priority enum (lower is better) ─────────────────────────────

CREATE OR REPLACE FUNCTION public.source_priority(src TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN src = 'congress_gov'          THEN 1
    WHEN src = 'fec'                   THEN 2
    WHEN src = 'openstates'            THEN 3
    WHEN src LIKE 'legistar:%'         THEN 4
    WHEN src = 'regulations_gov'       THEN 5
    WHEN src = 'courtlistener'         THEN 6
    WHEN src = 'littlesis'             THEN 7
    WHEN src = 'usaspending_recipient' THEN 8
    WHEN src = 'irs_990'               THEN 9
    WHEN src = 'sec_edgar'             THEN 10
    WHEN src = 'edgar'                 THEN 11
    ELSE 9999
  END;
$$;

COMMENT ON FUNCTION public.source_priority(TEXT) IS
  'FIX-397: lower-is-better source ranking for primary_source picker. Ties on this column are broken by external_source_refs.last_seen_at DESC. Unknown sources default to 9999.';

-- ── 2. Add primary_source columns + indexes to each of the 5 entity tables ─

DO $alter$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['officials','proposals','agencies','financial_entities','votes']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS primary_source TEXT', tbl);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS primary_source_url TEXT', tbl);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS primary_source_last_seen_at TIMESTAMPTZ', tbl);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (primary_source)',
                   tbl || '_primary_source_idx', tbl);
  END LOOP;
END
$alter$;

-- ── 3. Writer-side refresh helper ─────────────────────────────────────────

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
BEGIN
  IF p_entity_ids IS NULL OR array_length(p_entity_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  CASE p_entity_type
    WHEN 'official'         THEN v_target_table := 'officials';          v_xsr_types := ARRAY['official'];
    WHEN 'proposal'         THEN v_target_table := 'proposals';          v_xsr_types := ARRAY['proposal'];
    WHEN 'financial_entity' THEN v_target_table := 'financial_entities'; v_xsr_types := ARRAY['financial_entity'];
    -- Agencies are bound under both vocabularies; either inbound dispatches
    -- to the agencies table over the union set of xsr types.
    WHEN 'agency'           THEN v_target_table := 'agencies';           v_xsr_types := ARRAY['agency','governing_body'];
    WHEN 'governing_body'   THEN v_target_table := 'agencies';           v_xsr_types := ARRAY['agency','governing_body'];
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

  -- When proposals primary_source changes, propagate to child votes. Votes
  -- carry no xsr binding themselves — their source IS the source that
  -- ingested the parent proposal.
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

  RETURN v_rows_updated;
END;
$fn$;

COMMENT ON FUNCTION public.refresh_primary_source_for_entities(TEXT, UUID[]) IS
  'FIX-397: writer-side primary_source refresh. Call after a batched xsr upsert with the affected entity_ids. Both ''agency'' and ''governing_body'' dispatch to public.agencies. When called for proposals, also propagates to child votes.';

-- ── 4. Full rebuild — nightly safety net + initial backfill ───────────────

CREATE OR REPLACE FUNCTION public.rebuild_all_primary_sources()
RETURNS TABLE(table_name TEXT, rows_updated INTEGER)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_rows INTEGER;
BEGIN
  -- officials
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

  -- agencies (both 'agency' AND 'governing_body' xsr rows)
  WITH winners AS (
    SELECT DISTINCT ON (entity_id)
           entity_id, source, source_url, last_seen_at
      FROM public.external_source_refs
     WHERE entity_type IN ('agency','governing_body')
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

  -- financial_entities
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

  -- votes — inherit from parent proposal (votes have no xsr binding)
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
  'FIX-397: nightly safety-net rebuild. Re-derives primary_source for all 4 xsr-bound tables, then propagates to votes from parent proposal. Returns per-table rows-updated for observability. Called from runNightlySync MV-refresh block.';

-- ── 5. Function-level statement_timeouts ──────────────────────────────────

ALTER FUNCTION public.refresh_primary_source_for_entities(TEXT, UUID[])
  SET statement_timeout = '60s';

ALTER FUNCTION public.rebuild_all_primary_sources()
  SET statement_timeout = '5min';

GRANT EXECUTE ON FUNCTION public.source_priority(TEXT)                              TO service_role, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.refresh_primary_source_for_entities(TEXT, UUID[])  TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_all_primary_sources()                      TO service_role;

-- ── 6. Initial backfill ───────────────────────────────────────────────────

DO $backfill$
DECLARE
  t0  timestamptz := clock_timestamp();
  r   RECORD;
BEGIN
  RAISE NOTICE '[FIX-397] primary_source initial backfill start: %', t0;
  FOR r IN SELECT * FROM public.rebuild_all_primary_sources() LOOP
    RAISE NOTICE '[FIX-397]   %: % rows updated', r.table_name, r.rows_updated;
  END LOOP;
  RAISE NOTICE '[FIX-397] backfill complete. Wall time: % s',
               EXTRACT(EPOCH FROM clock_timestamp() - t0)::numeric(10,2);
END
$backfill$;
