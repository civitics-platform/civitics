-- scripts/fix1456-revert-ec-cosponsors-arm.sql
-- FIX-1456 ROLLBACK (cc-328) — puts back rebuild_entity_connections_cosponsors()
-- as it ran before 20261126007000_fix1456_ec_cosponsors_arm_merge.sql: the body
-- of 20260905000000_fix1136_ec_arm_delete_scopes.sql §2 VERBATIM (md5(prosrc)
-- d534e1637a5b49d2e6ef852a34b3bbdd, LOCAL and prod at cc-328 read 1), WITHOUT
-- its header's SET statement_timeout TO '10min': FIX-1128 (20260913000000)
-- RESET it, so the live proconfig is NULL, and check:proconfig holds it there.
-- Grants as 20260905000000 states them.
--
-- It DROPS NOTHING. The edges are not reverted either: the next cosponsors arm
-- under this body is a delete-all + insert, as before. It refuses a live body
-- that is neither FIX-1456's nor this one.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1456-revert-ec-cosponsors-arm.sql
-- (prod: only under a supervised session, through the primary checkout and the
-- gate — db-query --prod --call --yes-i-mean-prod --timeout 30s --file …).

DO $$
DECLARE
  v_d text;
BEGIN
  SELECT md5(prosrc) INTO v_d FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_cosponsors' AND pronamespace = 'public'::regnamespace;
  IF v_d IS DISTINCT FROM '675d2a6836402c235107e0f8a1686ae8' AND v_d IS DISTINCT FROM 'd534e1637a5b49d2e6ef852a34b3bbdd' THEN
    RAISE EXCEPTION '[fix1456 revert] rebuild_entity_connections_cosponsors md5 % is neither FIX-1456''s 675d2a6836402c235107e0f8a1686ae8 nor FIX-1136''s d534e1637a5b49d2e6ef852a34b3bbdd',
      COALESCE(v_d, '(no function)');
  END IF;
END $$;

-- ── rebuild_entity_connections_cosponsors() — 20260905000000 §2 ───────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_cosponsors()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE v_count BIGINT;
BEGIN
  -- FIX-1136: scoped to this arm's own source (was a bare connection_type match).
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'co_sponsorship'
     AND entity_connections.evidence_source = 'cosponsorship';

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

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_cosponsors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_cosponsors() TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_cfg text[];
BEGIN
  SELECT md5(prosrc), proconfig INTO v_md5, v_cfg FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_cosponsors' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM 'd534e1637a5b49d2e6ef852a34b3bbdd' OR v_cfg IS NOT NULL THEN
    RAISE EXCEPTION '[fix1456 revert] read-back failed: md5 % proconfig %, expected d534e1637a5b49d2e6ef852a34b3bbdd / NULL', v_md5, v_cfg;
  END IF;
  RAISE NOTICE '[fix1456 revert] read-back ok: rebuild_entity_connections_cosponsors %', v_md5;
END $$;
