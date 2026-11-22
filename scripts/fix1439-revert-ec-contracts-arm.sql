-- scripts/fix1439-revert-ec-contracts-arm.sql
-- FIX-1439 ROLLBACK (cc-308) — puts back rebuild_entity_connections_contracts()
-- as it ran before 20261122001000_fix1439_ec_contracts_arm_merge.sql: the body
-- of 20260905000000_fix1136_ec_arm_delete_scopes.sql §1 VERBATIM (md5(prosrc)
-- 88990e414b485a8ac1148d7f9b1a1444, LOCAL at cc-308 read 0; prod's is read by
-- the push prompt), WITHOUT its header's SET statement_timeout TO '30min':
-- FIX-1128 (20260913000000) RESET it, so the live proconfig is NULL, and
-- check:proconfig holds it there. Grants as 20260905000000 states them.
--
-- It DROPS NOTHING. The edges are not reverted either: the next contracts arm
-- under this body is a delete-all + insert, as before. It refuses a live body
-- that is neither FIX-1439's nor this one.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1439-revert-ec-contracts-arm.sql
-- (prod: only under a supervised session, through the primary checkout).

DO $$
DECLARE
  v_d text;
BEGIN
  SELECT md5(prosrc) INTO v_d FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_contracts' AND pronamespace = 'public'::regnamespace;
  IF v_d IS DISTINCT FROM 'cfbbd4d1b38be4529947a5646111d55a' AND v_d IS DISTINCT FROM '88990e414b485a8ac1148d7f9b1a1444' THEN
    RAISE EXCEPTION '[fix1439 revert] rebuild_entity_connections_contracts md5 % is neither FIX-1439''s cfbbd4d1b38be4529947a5646111d55a nor FIX-1136''s 88990e414b485a8ac1148d7f9b1a1444',
      COALESCE(v_d, '(no function)');
  END IF;
END $$;

-- ── rebuild_entity_connections_contracts() — 20260905000000 §1 ────────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_contracts()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE v_count BIGINT;
BEGIN
  -- FIX-1136: scoped to this arm's own source (was a bare connection_type match).
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'contract_award'
     AND entity_connections.evidence_source = 'financial_relationships';

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

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_contracts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_contracts() TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_cfg text[];
BEGIN
  SELECT md5(prosrc), proconfig INTO v_md5, v_cfg FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_contracts' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM '88990e414b485a8ac1148d7f9b1a1444' OR v_cfg IS NOT NULL THEN
    RAISE EXCEPTION '[fix1439 revert] read-back failed: md5 % proconfig %, expected 88990e414b485a8ac1148d7f9b1a1444 / NULL', v_md5, v_cfg;
  END IF;
  RAISE NOTICE '[fix1439 revert] read-back ok: rebuild_entity_connections_contracts %', v_md5;
END $$;
