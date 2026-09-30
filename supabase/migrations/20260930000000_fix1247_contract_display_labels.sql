-- =============================================================================
-- FIX-1247 — the contract chord / treemap / both rollups carry display LABELS
-- =============================================================================
--
-- contract_agency_sector_rollup.sector and contract_recipient_rollup.industry
-- held the primary_industry_tag() KEY for a tagged recipient (defense,
-- real_estate) and a capitalised NAICS label for the rest (Construction): one
-- column, two vocabularies. The prod rollup of 2026-09-24 carries 12 keys and
-- 19 labels in `sector`. SpendingGraph prints the stored string and colours only
-- the labels, so every keyed sector drew in the default slate. The treemap had
-- no NAICS fallback, so an untagged recipient was 'Other' even with a code.
-- Ratified by Craig 2026-09-29 (cc-173 D3; cc-166 §5.7 found it).
--
-- ONE VOCABULARY: display labels.
--   * chord_contract_flows_full() and the agency×sector CTE of
--     refresh_contract_flow_rollups() take primary_industry_tag().display_label
--     (an INDUSTRY_LABELS value, packages/data/src/pipelines/tags/topics.ts —
--     prod 2026-09-30: all 86,498 industry tags carry one of the 16, 1:1 with
--     the key, none NULL) before the NAICS CASE.
--   * the NAICS CASE gains '53' → 'Real Estate' and '55' → 'Management', the
--     two buckets the Sankey's private copy had and this one lacked, so the
--     CASE is the union. apps/civitics/src/lib/naics-sector-label.ts is its TS
--     copy, pinned to the LAST CASE in this directory by a drift test.
--   * treemap_recipients_by_contracts_full() and the recipient CTE of
--     refresh_contract_flow_rollups() take COALESCE(display_label, the same
--     CASE, 'Other'). The CASE reads MIN(naics_code), the code the row already
--     reports, so a recipient stays ONE row (the FIX-873 invariant): a per-row
--     CASE would split a recipient with contracts in two sectors into two
--     treemap rows. MIN is the FIX-919 tagger's choice too; FIX-1252 is
--     whether both should take the dollar-dominant code instead.
--
-- No shape change. Both tables keep their columns and PKs, and the next rebuild
-- (jobid 28, Thu 14:00 UTC; its body is DELETE then INSERT, a full replace)
-- writes the new strings. Σ total_cents per rollup is unchanged to the cent
-- (rule 116). The agency×sector row count can fall where a key and a label of
-- the same word merge (manufacturing / Manufacturing): clone 2026-09-30, 1,274
-- rows → 1,207, Σ 258,620,004,306,863 both.
--
-- primary_industry_tag() is NOT changed here. cc-173 was to move provenance
-- ahead of confidence in the same file (FIX-1245) and stopped that item: it
-- would promote MIN(naics_code) NAICS tags over ai tags on 26 contractors
-- carrying $270.4B of contracts (Electric Boat to oil_gas on 213113). FIX-1245
-- lands after FIX-1252.
--
-- Every redefinition here is the PROD body (pg_get_functiondef, 2026-09-30,
-- byte-equal to 20260927020000's) with only the named lines changed, and each
-- re-states its own SET / SECURITY clauses (rule 34).
-- =============================================================================

SET statement_timeout = '10min';

-- ── The contract surfaces carry display labels ─────────────────────────────────

-- chord_contract_flows_full: display_label first; CASE + 53/55
CREATE OR REPLACE FUNCTION public.chord_contract_flows_full()
 RETURNS TABLE(agency_id uuid, agency_name text, agency_acronym text, sector text, total_cents bigint, award_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH recipient_industry AS (
    -- FIX-873: one industry tag per financial_entity, so a multi-tag recipient's
    -- awards are NOT counted into every sector. FIX-918: the ranked pick, from
    -- its one home. FIX-1247: its display label, not its key.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        -- FIX-109 industry tag takes priority (rule-based NAICS classifier),
        -- FIX-873: single deterministic tag per recipient.
        ri.display_label,
        -- Fallback: derive sector from NAICS 2-digit prefix in metadata
        CASE SUBSTRING(fr.metadata->>'naics_code' FROM 1 FOR 2)
          WHEN '11' THEN 'Agriculture'
          WHEN '21' THEN 'Mining'
          WHEN '22' THEN 'Utilities'
          WHEN '23' THEN 'Construction'
          WHEN '31' THEN 'Manufacturing'
          WHEN '32' THEN 'Manufacturing'
          WHEN '33' THEN 'Manufacturing'
          WHEN '42' THEN 'Wholesale Trade'
          WHEN '44' THEN 'Retail'
          WHEN '45' THEN 'Retail'
          WHEN '48' THEN 'Transportation'
          WHEN '49' THEN 'Transportation'
          WHEN '51' THEN 'Information Technology'
          WHEN '52' THEN 'Finance'
          WHEN '53' THEN 'Real Estate'
          WHEN '54' THEN 'Professional Services'
          WHEN '55' THEN 'Management'
          WHEN '56' THEN 'Administrative Services'
          WHEN '61' THEN 'Education'
          WHEN '62' THEN 'Healthcare'
          WHEN '71' THEN 'Arts & Entertainment'
          WHEN '72' THEN 'Hospitality'
          WHEN '81' THEN 'Other Services'
          WHEN '92' THEN 'Government'
          ELSE 'Other'
        END,
        'Other'
      )                                               AS sector,
      fr.amount_cents
    FROM public.financial_relationships fr
    JOIN public.agencies a
      ON a.id = fr.from_id AND fr.from_type = 'agency'
    LEFT JOIN public.financial_entities fe
      ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
    LEFT JOIN recipient_industry ri
      ON ri.entity_id = fe.id
    WHERE fr.relationship_type = 'contract'
      AND fr.amount_cents > 0
  )
  SELECT
    agency_id,
    agency_name,
    agency_acronym,
    sector,
    SUM(amount_cents)::BIGINT  AS total_cents,
    COUNT(*)::BIGINT           AS award_count
  FROM classified
  GROUP BY agency_id, agency_name, agency_acronym, sector
  ORDER BY total_cents DESC;
$function$;

-- treemap_recipients_by_contracts_full: display_label, then the NAICS CASE on MIN(naics_code)
CREATE OR REPLACE FUNCTION public.treemap_recipients_by_contracts_full(lim integer DEFAULT 100)
 RETURNS TABLE(entity_id uuid, entity_name text, industry text, naics_code text, total_cents bigint, award_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH recipient_industry AS (
    -- FIX-873: one industry tag per financial_entity, so a multi-tag recipient
    -- is NOT emitted as N duplicate rows. FIX-918: the ranked pick, from its
    -- one home. FIX-1247: its display label, not its key.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  )
  SELECT
    fe.id::UUID                              AS entity_id,
    fe.display_name                          AS entity_name,
    -- FIX-1247: the chord's NAICS fallback, on the code this row reports.
    COALESCE(
      ri.display_label,
      CASE SUBSTRING(MIN(fr.metadata->>'naics_code') FROM 1 FOR 2)
        WHEN '11' THEN 'Agriculture'
        WHEN '21' THEN 'Mining'
        WHEN '22' THEN 'Utilities'
        WHEN '23' THEN 'Construction'
        WHEN '31' THEN 'Manufacturing'
        WHEN '32' THEN 'Manufacturing'
        WHEN '33' THEN 'Manufacturing'
        WHEN '42' THEN 'Wholesale Trade'
        WHEN '44' THEN 'Retail'
        WHEN '45' THEN 'Retail'
        WHEN '48' THEN 'Transportation'
        WHEN '49' THEN 'Transportation'
        WHEN '51' THEN 'Information Technology'
        WHEN '52' THEN 'Finance'
        WHEN '53' THEN 'Real Estate'
        WHEN '54' THEN 'Professional Services'
        WHEN '55' THEN 'Management'
        WHEN '56' THEN 'Administrative Services'
        WHEN '61' THEN 'Education'
        WHEN '62' THEN 'Healthcare'
        WHEN '71' THEN 'Arts & Entertainment'
        WHEN '72' THEN 'Hospitality'
        WHEN '81' THEN 'Other Services'
        WHEN '92' THEN 'Government'
        ELSE 'Other'
      END,
      'Other'
    )                                        AS industry,
    MIN(fr.metadata->>'naics_code')          AS naics_code,
    SUM(fr.amount_cents)::BIGINT             AS total_cents,
    COUNT(*)::BIGINT                         AS award_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fe.id, fe.display_name, ri.display_label
  ORDER BY total_cents DESC
  LIMIT lim;
$function$;

-- refresh_contract_flow_rollups: both CTEs → display_label; the NAICS CASE (+53/55) in both
CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_recipients bigint;
  v_flows      bigint;
  -- FIX-979: real entry time. Single-transaction procedure, so now() would in
  -- fact be correct here — the variable is used anyway so all three writers
  -- carry one greppable pattern.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('contract_flow_rollups_rebuild')::bigint) THEN
    RAISE NOTICE '[contract-flow rollups] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('contract_flow_rollups_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[contract-flow rollups] prod session held — skipping (FIX-950)';
    -- xact-scoped lock: the RETURN ends the transaction, which releases it.
    RETURN;
  END IF;


  SET work_mem = '256MB';

  -- Recipient rollup: top-500 recipients — byte-identical to
  -- treemap_recipients_by_contracts_full(500). One deterministic industry per
  -- recipient (FIX-873) → 500 distinct entity_ids, no fan-out.
  DELETE FROM public.contract_recipient_rollup;
  INSERT INTO public.contract_recipient_rollup
    (entity_id, entity_name, industry, naics_code, total_cents, award_count)
  WITH recipient_industry AS (
    -- FIX-918: the ranked pick, from its one home. FIX-1247: its display label.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  )
  SELECT
    fe.id::UUID,
    fe.display_name,
    -- FIX-1247: the chord's NAICS fallback, on the code this row reports.
    COALESCE(
      ri.display_label,
      CASE SUBSTRING(MIN(fr.metadata->>'naics_code') FROM 1 FOR 2)
        WHEN '11' THEN 'Agriculture'
        WHEN '21' THEN 'Mining'
        WHEN '22' THEN 'Utilities'
        WHEN '23' THEN 'Construction'
        WHEN '31' THEN 'Manufacturing'
        WHEN '32' THEN 'Manufacturing'
        WHEN '33' THEN 'Manufacturing'
        WHEN '42' THEN 'Wholesale Trade'
        WHEN '44' THEN 'Retail'
        WHEN '45' THEN 'Retail'
        WHEN '48' THEN 'Transportation'
        WHEN '49' THEN 'Transportation'
        WHEN '51' THEN 'Information Technology'
        WHEN '52' THEN 'Finance'
        WHEN '53' THEN 'Real Estate'
        WHEN '54' THEN 'Professional Services'
        WHEN '55' THEN 'Management'
        WHEN '56' THEN 'Administrative Services'
        WHEN '61' THEN 'Education'
        WHEN '62' THEN 'Healthcare'
        WHEN '71' THEN 'Arts & Entertainment'
        WHEN '72' THEN 'Hospitality'
        WHEN '81' THEN 'Other Services'
        WHEN '92' THEN 'Government'
        ELSE 'Other'
      END,
      'Other'
    ),
    MIN(fr.metadata->>'naics_code'),
    SUM(fr.amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fe.id, fe.display_name, ri.display_label
  ORDER BY SUM(fr.amount_cents) DESC
  LIMIT 500;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  -- Agency × sector chord rollup: FULL dataset — byte-identical to
  -- chord_contract_flows_full(). Each award in exactly one sector (FIX-873).
  DELETE FROM public.contract_agency_sector_rollup;
  INSERT INTO public.contract_agency_sector_rollup
    (agency_id, agency_name, agency_acronym, sector, total_cents, award_count)
  WITH recipient_industry AS (
    -- FIX-918: the ranked pick, from its one home. FIX-1247: its display label.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        ri.display_label,
        CASE SUBSTRING(fr.metadata->>'naics_code' FROM 1 FOR 2)
          WHEN '11' THEN 'Agriculture'
          WHEN '21' THEN 'Mining'
          WHEN '22' THEN 'Utilities'
          WHEN '23' THEN 'Construction'
          WHEN '31' THEN 'Manufacturing'
          WHEN '32' THEN 'Manufacturing'
          WHEN '33' THEN 'Manufacturing'
          WHEN '42' THEN 'Wholesale Trade'
          WHEN '44' THEN 'Retail'
          WHEN '45' THEN 'Retail'
          WHEN '48' THEN 'Transportation'
          WHEN '49' THEN 'Transportation'
          WHEN '51' THEN 'Information Technology'
          WHEN '52' THEN 'Finance'
          WHEN '53' THEN 'Real Estate'
          WHEN '54' THEN 'Professional Services'
          WHEN '55' THEN 'Management'
          WHEN '56' THEN 'Administrative Services'
          WHEN '61' THEN 'Education'
          WHEN '62' THEN 'Healthcare'
          WHEN '71' THEN 'Arts & Entertainment'
          WHEN '72' THEN 'Hospitality'
          WHEN '81' THEN 'Other Services'
          WHEN '92' THEN 'Government'
          ELSE 'Other'
        END,
        'Other'
      )                                               AS sector,
      fr.amount_cents
    FROM public.financial_relationships fr
    JOIN public.agencies a
      ON a.id = fr.from_id AND fr.from_type = 'agency'
    LEFT JOIN public.financial_entities fe
      ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
    LEFT JOIN recipient_industry ri
      ON ri.entity_id = fe.id
    WHERE fr.relationship_type = 'contract'
      AND fr.amount_cents > 0
  )
  SELECT
    agency_id,
    agency_name,
    agency_acronym,
    sector,
    SUM(amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM classified
  GROUP BY agency_id, agency_name, agency_acronym, sector;
  GET DIAGNOSTICS v_flows = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the writes.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('contract_flow_rollups_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text,
                             'recipients', v_recipients, 'agency_sectors', v_flows))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  -- FIX-979: clock_timestamp(), not now(). runid 130 ran 7,125.6 s and reported
  -- 0.000000 because both columns were the same frozen transaction_timestamp().
  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('contract_flow_rollups_rebuild', 'complete', v_started, clock_timestamp(),
          v_recipients + v_flows,
          jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows));

  RAISE NOTICE '[contract-flow rollups] complete — % recipients, % agency×sector rows',
    v_recipients, v_flows;
END;
$procedure$;

RESET statement_timeout;
