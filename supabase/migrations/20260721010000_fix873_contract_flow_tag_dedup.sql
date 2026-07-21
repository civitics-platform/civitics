-- =============================================================================
-- FIX-873 — Dedupe multi-industry-tag recipients in the contract-flow surfaces.
--
-- The two contract-flow RPCs (chord_contract_flows_full / treemap_recipients_by_
-- contracts_full) and the FIX-838 rebuild that mirrors them (refresh_contract_
-- flow_rollups) LEFT JOIN entity_tags on the recipient WITHOUT a DISTINCT-ON. A
-- financial_entity carrying >1 industry tag (1,058 local / 1,654 prod at filing)
-- fans out:
--   • treemap  — the entity becomes N duplicate entity_id rows, EACH carrying the
--     entity's FULL total (top-500 = 500 rows / 493 distinct in both envs → 7 dups).
--   • chord    — a single award is counted into EVERY one of the recipient's
--     sectors, inflating per-sector totals AND the agency cross-sector sum
--     (a pure double-count).
-- FIX-838 deliberately PRESERVED this fan-out (byte-exact materialization swap) and
-- filed the semantics fix here.
--
-- ── Fix (decision 1): one deterministic industry per recipient ────────────────
-- A `DISTINCT ON (entity_id) ORDER BY entity_id, tag` CTE — the smallest-tag pick,
-- byte-identical to the FIX-836 `ind` / FIX-777 `donor_tag` / sector_affinity_
-- rebuild_officials shape — applied in BOTH _full bodies AND the rebuild proc.
-- Each award now lands in exactly ONE sector; each entity appears ONCE in the
-- treemap. The NAICS-2-digit fallback and 'Other' default are UNTOUCHED for
-- untagged recipients (COALESCE structure unchanged; only `et.tag` → the picked
-- `ri.tag`).
--
-- ── Base bodies = the LIVE definitions (decision 2) ──────────────────────────
-- All three CREATE OR REPLACE are the LIVE pg_get_functiondef bodies (captured on
-- local 2026-07-21, confirmed identical to the FIX-838 migration text — no drift
-- since 20260719020000), with ONLY the tag join swapped for the DISTINCT-ON pick.
-- Rebuilding from an older body silently reverts intervening changes (the
-- FIX-610/625 stale-body-revert class); we do not.
--
-- ── Rollup PK revert + no empty window (decision 3) ──────────────────────────
-- contract_recipient_rollup reverts to a plain `entity_id PRIMARY KEY` — the
-- surrogate `id` existed ONLY to hold the fan-out dups. Ordering that leaves NO
-- empty-read window for the flag-gated fast path (bootstrapped stays true
-- throughout; the table is never truncated):
--   (a) in-place dedupe the existing top-500 rows — keep the row matching the
--       deterministic pick, delete the rest (per-row totals are already correct:
--       the fan-out duplicated the FULL total, it did not split it),
--   (b) swap the PK (drop `id`, add entity_id PK),
--   (c) redefine the three fn/proc bodies.
-- The chord rollup (contract_agency_sector_rollup) is NOT re-aggregated here — its
-- (agency_id, sector) PK is fan-out-stable (row COUNT unchanged; only per-sector
-- totals are inflated). It keeps serving today's (inflated) totals for the brief
-- window until refresh_contract_flow_rollups() runs, exactly as it does today. The
-- supervised post-apply refresh rebuilds BOTH rollups with the corrected bodies.
-- =============================================================================

-- ── (a) In-place dedupe of the existing recipient rollup ─────────────────────
-- Keep exactly ONE row per entity_id: the row whose industry equals the
-- deterministic smallest-tag pick when present, else the smallest stored industry
-- (robust to a boundary-straddled fan-out that dropped the pick row at INSERT —
-- guarantees no entity ever vanishes from the top-500 pre-refresh). Untagged
-- entities (industry defaulted to 'Other', absent from the pick CTE) never fanned
-- out — they have exactly one row and are left untouched.
DO $$
DECLARE
  v_removed bigint;
BEGIN
  WITH pick AS (
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  ),
  ranked AS (
    SELECT r.id,
           row_number() OVER (
             PARTITION BY r.entity_id
             ORDER BY (r.industry = p.tag) DESC NULLS LAST,  -- prefer the deterministic pick
                      r.industry ASC                          -- else smallest stored industry
           ) AS rn
    FROM public.contract_recipient_rollup r
    LEFT JOIN pick p ON p.entity_id = r.entity_id
  )
  DELETE FROM public.contract_recipient_rollup r
  USING ranked
  WHERE ranked.id = r.id
    AND ranked.rn > 1;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RAISE NOTICE '[FIX-873] in-place recipient dedupe removed % fan-out row(s)', v_removed;
END $$;

-- ── (b) PK swap: drop the surrogate `id`, make entity_id the PRIMARY KEY ──────
-- After (a) entity_id is unique, so the plain PK the prompt spec'd is now valid.
-- Guarded so a re-apply is a no-op. Dropping `id` also drops its owned identity
-- sequence and the old id-based pkey constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'contract_recipient_rollup'
      AND column_name  = 'id'
  ) THEN
    ALTER TABLE public.contract_recipient_rollup DROP COLUMN id;
    ALTER TABLE public.contract_recipient_rollup
      ADD CONSTRAINT contract_recipient_rollup_pkey PRIMARY KEY (entity_id);
    RAISE NOTICE '[FIX-873] contract_recipient_rollup PK swapped id → entity_id';
  END IF;
END $$;

COMMENT ON TABLE public.contract_recipient_rollup IS
  'FIX-838/FIX-873 — top-500 contract recipients by total_cents, byte-identical to '
  'treemap_recipients_by_contracts_full(500). One deterministic industry per '
  'recipient (smallest-tag DISTINCT ON pick, FIX-873) → entity_id is UNIQUE and is '
  'the PRIMARY KEY (the FIX-838 surrogate id existed only to hold the now-removed '
  'multi-tag fan-out). Full-rebuilt weekly by refresh_contract_flow_rollups() '
  '(pg_cron contract-flow-rollups-refresh, Thu 14:00 UTC). Read behind pipeline_'
  'state contract_flow_rollups_state.bootstrapped by treemap_recipients_by_contracts().';

COMMENT ON TABLE public.contract_agency_sector_rollup IS
  'FIX-838/FIX-873 — full agency × sector contract-flow chord, byte-identical to '
  'chord_contract_flows_full(). Each award lands in exactly one sector (single '
  'deterministic industry per recipient, FIX-873 — the pre-873 fan-out double-'
  'counted a multi-tag recipient''s awards into every sector). Full-rebuilt weekly '
  'by refresh_contract_flow_rollups() (pg_cron contract-flow-rollups-refresh, Thu '
  '14:00 UTC). Read behind pipeline_state contract_flow_rollups_state.bootstrapped '
  'by chord_contract_flows().';

-- ── (c) Corrected break-glass / live-compute bodies + rebuild proc ───────────

-- chord_contract_flows_full(): each contract award classified into ONE sector via
-- the deterministic per-recipient industry pick (recipient_industry CTE), with the
-- untouched NAICS-2-digit fallback + 'Other' default for untagged recipients.
CREATE OR REPLACE FUNCTION public.chord_contract_flows_full()
RETURNS TABLE(
  agency_id      UUID,
  agency_name    TEXT,
  agency_acronym TEXT,
  sector         TEXT,
  total_cents    BIGINT,
  award_count    BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '300s'
AS $$
  WITH recipient_industry AS (
    -- FIX-873: one deterministic (smallest) industry tag per financial_entity, so
    -- a multi-tag recipient's awards are NOT counted into every sector.
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        -- FIX-109 industry tag takes priority (rule-based NAICS classifier),
        -- FIX-873: single deterministic tag per recipient.
        ri.tag,
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
          WHEN '54' THEN 'Professional Services'
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
$$;

COMMENT ON FUNCTION public.chord_contract_flows_full() IS
  'FIX-838/FIX-873 — whole-table agency × sector contract chord (3.2M-row scan → '
  'GROUP BY agency × sector), one deterministic industry per recipient so each '
  'award lands in exactly one sector. Break-glass + live-compute fallback for '
  'chord_contract_flows() before the rollup is bootstrapped.';

-- treemap_recipients_by_contracts_full(lim): one row per recipient (single
-- deterministic industry), so the top-lim has no duplicate entity_ids.
CREATE OR REPLACE FUNCTION public.treemap_recipients_by_contracts_full(
  lim INTEGER DEFAULT 100
)
RETURNS TABLE(
  entity_id   UUID,
  entity_name TEXT,
  industry    TEXT,
  naics_code  TEXT,
  total_cents BIGINT,
  award_count BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '300s'
AS $$
  WITH recipient_industry AS (
    -- FIX-873: one deterministic (smallest) industry tag per financial_entity, so
    -- a multi-tag recipient is NOT emitted as N duplicate rows.
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  )
  SELECT
    fe.id::UUID                              AS entity_id,
    fe.display_name                          AS entity_name,
    COALESCE(ri.tag, 'Other')                AS industry,
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
  GROUP BY fe.id, fe.display_name, ri.tag
  ORDER BY total_cents DESC
  LIMIT lim;
$$;

COMMENT ON FUNCTION public.treemap_recipients_by_contracts_full(INTEGER) IS
  'FIX-838/FIX-873 — whole-table top-recipients treemap (3.2M-row scan → HashAgg), '
  'one row per recipient (single deterministic industry, no multi-tag fan-out). '
  'Break-glass + live-compute fallback for treemap_recipients_by_contracts() '
  'before the rollup is bootstrapped.';

-- Rebuild proc: both rollups rebuilt DELETE+INSERT in one txn, now with the
-- corrected (deduped) aggregations — byte-identical to the two _full() fns above.
CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_recipients bigint;
  v_flows      bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('contract_flow_rollups_rebuild')::bigint) THEN
    RAISE NOTICE '[contract-flow rollups] advisory lock held — skipping';
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
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  )
  SELECT
    fe.id::UUID,
    fe.display_name,
    COALESCE(ri.tag, 'Other'),
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
  GROUP BY fe.id, fe.display_name, ri.tag
  ORDER BY SUM(fr.amount_cents) DESC
  LIMIT 500;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  -- Agency × sector chord rollup: FULL dataset — byte-identical to
  -- chord_contract_flows_full(). Each award in exactly one sector (FIX-873).
  DELETE FROM public.contract_agency_sector_rollup;
  INSERT INTO public.contract_agency_sector_rollup
    (agency_id, agency_name, agency_acronym, sector, total_cents, award_count)
  WITH recipient_industry AS (
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        ri.tag,
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
          WHEN '54' THEN 'Professional Services'
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

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('contract_flow_rollups_rebuild', 'complete', now(), now(),
          v_recipients + v_flows,
          jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows));

  RAISE NOTICE '[contract-flow rollups] complete — % recipients, % agency×sector rows',
    v_recipients, v_flows;
END;
$$;

COMMENT ON PROCEDURE public.refresh_contract_flow_rollups() IS
  'FIX-838/FIX-873 — full atomic rebuild of contract_recipient_rollup (top-500) + '
  'contract_agency_sector_rollup (full), byte-identical to the two _full() fns '
  '(one deterministic industry per recipient — no multi-tag fan-out). Weekly via '
  'pg_cron contract-flow-rollups-refresh (Thu 14:00 UTC); also the per-env '
  'bootstrap / break-glass. Run over direct-pg with a raised session '
  'statement_timeout when bootstrapping.';

-- ── Grants (belt-and-braces, FIX-695/834 lineage): the three redefined objects.
--     CREATE OR REPLACE preserves ACLs; re-assert the route-gated (service_role-
--     only) posture anyway. Read fns (chord_contract_flows / treemap_recipients_
--     by_contracts) are UNCHANGED here, so their grants are untouched.
REVOKE ALL ON FUNCTION public.chord_contract_flows_full()                  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.chord_contract_flows_full()                  TO service_role;
REVOKE ALL ON FUNCTION public.treemap_recipients_by_contracts_full(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.treemap_recipients_by_contracts_full(INTEGER) TO service_role;
REVOKE ALL ON PROCEDURE public.refresh_contract_flow_rollups()             FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.refresh_contract_flow_rollups()             TO service_role;

-- PostgREST: table column dropped + function bodies changed → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
