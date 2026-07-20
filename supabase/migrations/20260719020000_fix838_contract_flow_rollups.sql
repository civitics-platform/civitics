-- =============================================================================
-- FIX-838 — Materialize the contract-flow RPCs behind /api/graph/spending
-- (closes FIX-507's "contract-flow rollup" design item for the spending surface).
--
-- Both RPCs live-aggregate ALL ~3.24M contract-type financial_relationships rows
-- on the request path:
--   • treemap_recipients_by_contracts(lim) — top recipients by contract $. Measured
--     >45s on prod (hit statement_timeout under EXPLAIN ANALYZE; ~2M-group
--     HashAggregate over a 3.2M-row bitmap scan), far past the ~8s service_role
--     ceiling. On any real CDN cache-miss the RPC errors and the route cached an
--     empty [] for 1h — a latent CORRECTNESS bug, not just perf.
--   • chord_contract_flows() — the same 3.2M-row scan grouped agency × sector.
--     Measured 17.3s local / >2min prod (cache-cold Small).
-- See docs/audits/2026-07-16-fix780-internal-agg-rpc-audit.md follow-up #1.
--
-- ── Fix: two small full-rebuild rollup tables, refreshed weekly off-path ──────
-- public.contract_recipient_rollup       — top-500 recipients (route caps lim=200)
-- public.contract_agency_sector_rollup   — the FULL chord dataset (agencies × ~24
--                                          sectors → small)
-- Both are DELETE+INSERT full rebuilds by refresh_contract_flow_rollups(), CALLed
-- weekly by pg_cron (Thu 14:00 UTC, a few hours after the Thu 10:00 UTC USASpending
-- ingest lands contracts) and once per-env to bootstrap. The source aggregation is
-- ~1–2 min as the postgres role off the request path, so no watermark/incremental
-- machinery is justified (deliberate — decision 1). Mirrors [[FIX-837]] (the
-- vote-stats full-rebuild materialization) and [[FIX-836]] (the bootstrap-flag +
-- _full() break-glass read-path pattern).
--
-- ── Semantics: byte-identical to the LIVE fn bodies (decision 2) ──────────────
-- The rebuild INSERTs are byte-for-byte the migration-time live definitions of the
-- two RPCs (verified via pg_get_functiondef, both envs). NOTE the live treemap body
-- had DRIFTED from the FIX-110 migration: the 20260428 financial_entities.industry
-- column drop removed the `fe.industry` fallback, so the live body is
-- COALESCE(et.tag,'Other') / GROUP BY fe.id, fe.display_name, et.tag (NOT the
-- COALESCE(et.tag, fe.industry, 'Other') the April migration shows). We mirror the
-- LIVE body. chord_contract_flows() was unchanged from FIX-110; its FIX-110
-- anon/authenticated grant was already revoked (FIX-834), leaving service_role-only.
--
-- ── KNOWN FAN-OUT (decision 2: preserve, do NOT fix here) ─────────────────────
-- Both live bodies LEFT JOIN entity_tags WITHOUT a DISTINCT-ON. An entity carrying
-- >1 industry tag fans its contract rows out: in treemap it becomes N duplicate
-- entity_id rows (one per tag, EACH with the entity's FULL total_cents/award_count);
-- in chord a single award is counted into every one of the recipient's sectors
-- (per-sector totals inflated). This MANIFESTS today: 1058 (local) / 1654 (prod)
-- financial_entities carry >1 industry tag, and the treemap top-500 returns 7
-- duplicate entity_ids (500 rows / 493 distinct) in BOTH envs. Per byte-exact-swap
-- discipline this migration PRESERVES the fan-out exactly (the materialized route
-- must behave identically to today); the semantics bug is tracked as [[FIX-873]],
-- not fixed inside a materialization PR.
--
-- ONE DEVIATION FROM THE PROMPT'S TABLE SPEC, forced by the above: the recipient
-- rollup CANNOT key on `entity_id PRIMARY KEY` — the fan-out puts duplicate
-- entity_ids in the stored top-500 (7 collisions). It uses a surrogate identity PK
-- (`id`) + a non-unique entity_id so every fanned-out row is stored verbatim. The
-- chord table's (agency_id, sector) PK is unaffected (fan-out inflates a sector's
-- total but never duplicates an (agency_id, sector) key).
--
-- ── Bootstrap-flag gate, not an EXISTS gate ──────────────────────────────────
-- The read fns switch to the rollup only once pipeline_state
-- 'contract_flow_rollups_state' has {bootstrapped:true}, flipped by the rebuild in
-- the SAME txn as the writes. An EXISTS/non-empty gate would serve a partial set if
-- it raced a half-finished rebuild; the flag covers the whole pre-bootstrap window
-- with the _full() fallback (identical to today's behavior). See the FIX-836
-- migration §3 comment.
-- =============================================================================

-- ── 1. Rollup tables ─────────────────────────────────────────────────────────

-- Recipient rollup: top-500 recipients by total_cents (route caps lim at 200; 500
-- is headroom, and the live RPC returns only top-lim so top-N storage loses nothing
-- any consumer reads). Surrogate identity PK — entity_id is NOT unique here because
-- the live treemap body fans multi-tag entities into duplicate entity_id rows (see
-- the KNOWN FAN-OUT note above); a sole entity_id PK would collide on those rows.
CREATE TABLE IF NOT EXISTS public.contract_recipient_rollup (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id   uuid        NOT NULL,   -- financial_entities.id (NOT unique: fan-out)
  entity_name text,
  industry    text,
  naics_code  text,
  total_cents bigint      NOT NULL,
  award_count bigint      NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Read path is `ORDER BY total_cents DESC LIMIT lim` over ~500 rows; the index keeps
-- that a top-N index scan and documents the read shape.
CREATE INDEX IF NOT EXISTS contract_recipient_rollup_total_idx
  ON public.contract_recipient_rollup (total_cents DESC);

COMMENT ON TABLE public.contract_recipient_rollup IS
  'FIX-838 — top-500 contract recipients by total_cents, byte-identical to '
  'treemap_recipients_by_contracts_full(500) (INCLUDING the multi-industry-tag '
  'fan-out: an entity with N industry tags appears as N rows, each with the full '
  'total). Surrogate id PK because entity_id is NOT unique under that fan-out. '
  'Full-rebuilt weekly by refresh_contract_flow_rollups() (pg_cron '
  'contract-flow-rollups-refresh, Thu 14:00 UTC). Read behind pipeline_state '
  'contract_flow_rollups_state.bootstrapped by treemap_recipients_by_contracts().';

-- Agency × sector chord rollup: the FULL dataset (small). (agency_id, sector) is a
-- valid PK — the GROUP BY already collapses to one row per pair even under fan-out.
CREATE TABLE IF NOT EXISTS public.contract_agency_sector_rollup (
  agency_id      uuid        NOT NULL,
  agency_name    text,
  agency_acronym text,
  sector         text        NOT NULL,
  total_cents    bigint      NOT NULL,
  award_count    bigint      NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, sector)
);

COMMENT ON TABLE public.contract_agency_sector_rollup IS
  'FIX-838 — full agency × sector contract-flow chord, byte-identical to '
  'chord_contract_flows_full() (INCLUDING the multi-industry-tag fan-out: a single '
  'award is counted into every one of a recipient''s sectors). Full-rebuilt weekly '
  'by refresh_contract_flow_rollups() (pg_cron contract-flow-rollups-refresh, Thu '
  '14:00 UTC). Read behind pipeline_state contract_flow_rollups_state.bootstrapped '
  'by chord_contract_flows().';

-- Read only by the SECURITY DEFINER read fns (owner=postgres, bypass RLS); no
-- anon/authenticated surface (FIX-834/695 hygiene). RLS on with no policy = deny
-- direct non-owner access. service_role gets DML for the case where the rebuild is
-- invoked as service_role. Mirrors official_vote_stats / official_donor_totals.
ALTER TABLE public.contract_recipient_rollup     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contract_recipient_rollup     FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_recipient_rollup     TO service_role;

ALTER TABLE public.contract_agency_sector_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contract_agency_sector_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_agency_sector_rollup TO service_role;

-- ── 2. Break-glass: the pre-FIX-838 whole-table aggregations, preserved VERBATIM.
--     Also the live-compute fallback below. Bodies are byte-for-byte the
--     migration-time live definitions (the LIVE treemap body, post the 20260428
--     fe.industry drop — NOT the FIX-110 migration text).
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
  WITH classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        -- FIX-109 industry tag takes priority (rule-based NAICS classifier)
        et.tag,
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
    LEFT JOIN public.entity_tags et
      ON et.entity_id    = fe.id
     AND et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
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
  'FIX-838 — the pre-FIX-838 whole-table agency × sector contract chord (3.2M-row '
  'scan → GROUP BY agency × sector). ~17s local / >2min prod. Break-glass + the '
  'live-compute fallback for chord_contract_flows() before the rollup is bootstrapped.';

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
  SELECT
    fe.id::UUID                              AS entity_id,
    fe.display_name                          AS entity_name,
    COALESCE(et.tag, 'Other')                AS industry,
    MIN(fr.metadata->>'naics_code')          AS naics_code,
    SUM(fr.amount_cents)::BIGINT             AS total_cents,
    COUNT(*)::BIGINT                         AS award_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
  LEFT JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fe.id, fe.display_name, et.tag
  ORDER BY total_cents DESC
  LIMIT lim;
$$;

COMMENT ON FUNCTION public.treemap_recipients_by_contracts_full(INTEGER) IS
  'FIX-838 — the pre-FIX-838 whole-table top-recipients treemap (3.2M-row scan → '
  '~2M-group HashAggregate). >45s on prod. Break-glass + the live-compute fallback '
  'for treemap_recipients_by_contracts() before the rollup is bootstrapped. Body is '
  'the LIVE definition (post the 20260428 fe.industry drop), not the FIX-110 text.';

-- ── 3. Fast path: read the rollup once bootstrapped; else live-compute via _full().
--     Gate is the pipeline_state flag, NOT "table is non-empty" (partial-set hazard,
--     FIX-836 §3). Both public signatures unchanged so the route needs no change.
--     Rewritten to plpgsql (was sql) to branch on the flag; still SECURITY DEFINER
--     so it can read the RLS-locked rollup tables.
CREATE OR REPLACE FUNCTION public.chord_contract_flows()
RETURNS TABLE(
  agency_id      UUID,
  agency_name    TEXT,
  agency_acronym TEXT,
  sector         TEXT,
  total_cents    BIGINT,
  award_count    BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bootstrapped boolean;
BEGIN
  SELECT (value->>'bootstrapped')::boolean INTO v_bootstrapped
  FROM public.pipeline_state WHERE key = 'contract_flow_rollups_state';

  IF COALESCE(v_bootstrapped, false) THEN
    RETURN QUERY
      SELECT r.agency_id, r.agency_name, r.agency_acronym, r.sector,
             r.total_cents, r.award_count
      FROM public.contract_agency_sector_rollup r
      ORDER BY r.total_cents DESC;
    RETURN;
  END IF;
  -- Not yet bootstrapped → live-compute (identical to today's behavior).
  RETURN QUERY SELECT * FROM public.chord_contract_flows_full();
END;
$$;

COMMENT ON FUNCTION public.chord_contract_flows() IS
  'FIX-838 — reads the contract_agency_sector_rollup (was a 3.2M-row agency × sector '
  'scan). Live-compute fallback to chord_contract_flows_full() until the rollup is '
  'bootstrapped. Output shape unchanged (/api/graph/spending?type=chord needs no change).';

CREATE OR REPLACE FUNCTION public.treemap_recipients_by_contracts(
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
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bootstrapped boolean;
BEGIN
  SELECT (value->>'bootstrapped')::boolean INTO v_bootstrapped
  FROM public.pipeline_state WHERE key = 'contract_flow_rollups_state';

  IF COALESCE(v_bootstrapped, false) THEN
    RETURN QUERY
      SELECT r.entity_id, r.entity_name, r.industry, r.naics_code,
             r.total_cents, r.award_count
      FROM public.contract_recipient_rollup r
      ORDER BY r.total_cents DESC
      LIMIT lim;
    RETURN;
  END IF;
  -- Not yet bootstrapped → live-compute (identical to today's behavior).
  RETURN QUERY SELECT * FROM public.treemap_recipients_by_contracts_full(lim);
END;
$$;

COMMENT ON FUNCTION public.treemap_recipients_by_contracts(INTEGER) IS
  'FIX-838 — reads the top-500 contract_recipient_rollup (was a >45s 3.2M-row '
  'scan / ~2M-group HashAggregate). Live-compute fallback to '
  'treemap_recipients_by_contracts_full(lim) until the rollup is bootstrapped. '
  'Output shape unchanged (/api/graph/spending?type=treemap needs no change).';

-- ── 4. Rebuild proc: full atomic rebuild of BOTH rollups + flag + log in one txn.
--     Guarded by a transaction-scoped advisory lock (auto-released on commit/
--     rollback; no COMMIT in this proc, so no session-lock leak on error). The two
--     tables are rebuilt DELETE+INSERT in the single proc txn — readers are
--     snapshot-isolated, so a concurrent rebuild is never observed as empty/partial.
--     Aggregations are byte-identical to the two _full() fns. CALLed weekly by
--     pg_cron and once per-env to bootstrap.
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
  -- treemap_recipients_by_contracts_full(500), fan-out preserved.
  DELETE FROM public.contract_recipient_rollup;
  INSERT INTO public.contract_recipient_rollup
    (entity_id, entity_name, industry, naics_code, total_cents, award_count)
  SELECT
    fe.id::UUID,
    fe.display_name,
    COALESCE(et.tag, 'Other'),
    MIN(fr.metadata->>'naics_code'),
    SUM(fr.amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
  LEFT JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fe.id, fe.display_name, et.tag
  ORDER BY SUM(fr.amount_cents) DESC
  LIMIT 500;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  -- Agency × sector chord rollup: FULL dataset — byte-identical to
  -- chord_contract_flows_full(), fan-out preserved.
  DELETE FROM public.contract_agency_sector_rollup;
  INSERT INTO public.contract_agency_sector_rollup
    (agency_id, agency_name, agency_acronym, sector, total_cents, award_count)
  WITH classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        et.tag,
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
    LEFT JOIN public.entity_tags et
      ON et.entity_id    = fe.id
     AND et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
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

  -- Flip the bootstrap flag in the SAME txn as the writes, so the read fns only
  -- leave the _full() fallback once both complete sets are committed.
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
  'FIX-838 — full atomic rebuild of contract_recipient_rollup (top-500) + '
  'contract_agency_sector_rollup (full), byte-identical to the two _full() fns '
  '(fan-out preserved). Weekly via pg_cron contract-flow-rollups-refresh (Thu 14:00 '
  'UTC); also the one-shot per-env bootstrap. ~1–2 min as the postgres role. Run '
  'over direct-pg with a raised session statement_timeout when bootstrapping.';

-- ── 5. pg_cron: weekly full rebuild. Thu 14:00 UTC — a few hours after the Thu
--     10:00 UTC usaspending-bulk GHA ingest lands contracts, and clear of every
--     pg_cron job (Thursday has none; daily 03:30/06:00/06:30/09:00, Mon/Wed 08:00
--     EC, the Tue rollup block are all elsewhere). Idempotent (FIX-688): unschedule
--     by name, then schedule. Plain CALL — the cron role (postgres) has no
--     statement_timeout so the ~1–2-min rebuild completes.
SELECT cron.unschedule(jobname)
  FROM cron.job WHERE jobname = 'contract-flow-rollups-refresh';

SELECT cron.schedule(
  'contract-flow-rollups-refresh',
  '0 14 * * 4',
  $$CALL public.refresh_contract_flow_rollups();$$
);

-- ── 6. Function grants. Supabase default-grants EXECUTE to anon/authenticated on
--     every new function (FIX-695/834), so route-gated DEFINER RPCs need an explicit
--     REVOKE. End state for all four fns + the proc = service_role only (the route
--     calls via createAdminClient = service_role).
REVOKE ALL ON FUNCTION public.chord_contract_flows()                       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.chord_contract_flows()                       TO service_role;
REVOKE ALL ON FUNCTION public.chord_contract_flows_full()                  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.chord_contract_flows_full()                  TO service_role;
REVOKE ALL ON FUNCTION public.treemap_recipients_by_contracts(INTEGER)     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.treemap_recipients_by_contracts(INTEGER)     TO service_role;
REVOKE ALL ON FUNCTION public.treemap_recipients_by_contracts_full(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.treemap_recipients_by_contracts_full(INTEGER) TO service_role;
REVOKE ALL ON PROCEDURE public.refresh_contract_flow_rollups()             FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.refresh_contract_flow_rollups()             TO service_role;

-- PostgREST: new tables + changed function signatures → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
