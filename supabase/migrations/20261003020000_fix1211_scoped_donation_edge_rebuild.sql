-- FIX-1211 — a donor-scoped donation/opposition edge rebuild.
--
-- entity_connections money edges are fully derived from financial_relationships,
-- and every writer is DELETE-then-INSERT keyed on a dirty set of DONORS taken
-- from `fr.updated_at` (rebuild_ec_donations_incr_window, 20260819030000_fix1069,
-- clamped by the FIX-983 horizon). A DELETED FR row has no updated_at, so it
-- never dirties its donor: an edge that lost SOME of its evidence keeps the
-- deleted row's dollars until something else about that donor changes. The
-- FIX-1074 drain deletes an edge only when EVERY evidence id was deleted
-- (FIX-1210's `<@`), and the monthly reconcile_donation_edge_orphans() only
-- when no donation/ie_support row survives for the pair, so neither can repair
-- a partial. No donation writer took ids (the rebuild_entity_connections_*
-- family is zero-argument; _incr_window / _full_window take from_id RANGES).
--
-- The one instance (cc-144, prod census re-run by cc-182 2026-10-03 04:07 UTC
-- over all 9,179,144 money edges / 10,551,031 evidence ids): edge db99c5ef
-- (donor 6d1b3de4 -> official d798e047) reads 215399 / 2 / 0.417. It aggregated
-- a fec_bulk_pac donation of 65400 (DELETED by the FIX-1106 pac apply) and a
-- fec_bulk_ie ie_support of 149999 (alive). Donation edges include ie_support
-- rows BY DESIGN, so the correct edge is 149999 / 1 / 0.397.
--
-- rebuild_ec_donation_edges_for_donors(p_from_ids uuid[]):
--   * takes the EC rebuild's own advisory key, transaction-scoped. The crawl
--     (jobid 45, */15) holds hashtext('entity_connections_rebuild')::bigint as a
--     SESSION lock for its unit; session and xact locks on one key conflict, so
--     this function and a crawl unit never interleave their DELETE+INSERT on the
--     same donor. Held -> SQLSTATE 55P03 (lock_not_available); the caller retries.
--   * DELETEs the donors' donation + opposition edges whose evidence is
--     financial_relationships, then re-derives both from the donors' FULL FR
--     history with the aggregation copied from the prod body of
--     rebuild_ec_donations_incr_window — same relationship_type lists, same
--     strength expression, same [1:100] evidence cap, same column list
--     (derived_at takes its now() default, as there). Only the predicate
--     differs: `fr.from_type = 'financial_entity' AND fr.from_id = ANY(...)`
--     instead of the windowed dirty-set join. A drift test asserts the copy.
--   * the edge ids CHANGE (DELETE + INSERT, as every EC writer does).
--   * leaves pipeline_state alone: this is a repair of named donors, not a
--     window of the incremental crawl, so no watermark moves.
--
-- Blind spot, stated: evidence_ids is capped at 100, so an edge with more than
-- 100 FR rows cannot show a deletion outside its first 100. Prod population
-- 2026-10-03: zero money edges with evidence_count > 100.

CREATE OR REPLACE FUNCTION public.rebuild_ec_donation_edges_for_donors(p_from_ids uuid[])
RETURNS TABLE (connection_type text, edges_deleted bigint, edges_inserted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_del_don bigint := 0;
  v_del_opp bigint := 0;
  v_count   bigint := 0;
  v_opp     bigint := 0;
BEGIN
  IF p_from_ids IS NULL OR cardinality(p_from_ids) = 0 THEN
    RETURN QUERY VALUES ('donation'::text, 0::bigint, 0::bigint),
                        ('opposition'::text, 0::bigint, 0::bigint);
    RETURN;
  END IF;

  -- The crawl's key, as a transaction lock: released at our commit/rollback.
  IF NOT pg_try_advisory_xact_lock(hashtext('entity_connections_rebuild')::bigint) THEN
    RAISE EXCEPTION 'rebuild_ec_donation_edges_for_donors: the entity_connections_rebuild lock is held (EC crawl or rebuild in flight) — retry'
      USING ERRCODE = '55P03';
  END IF;

  WITH del AS (
    DELETE FROM public.entity_connections ec
     WHERE ec.from_type = 'financial_entity'
       AND ec.from_id = ANY (p_from_ids)
       AND ec.connection_type IN ('donation', 'opposition')
       AND ec.evidence_source = 'financial_relationships'
    RETURNING ec.connection_type
  )
  SELECT count(*) FILTER (WHERE d.connection_type = 'donation'),
         count(*) FILTER (WHERE d.connection_type = 'opposition')
    INTO v_del_don, v_del_opp
    FROM del d;

  -- ── donation + ie_support -> 'donation' ────────────────────────────────────
  -- Copied from rebuild_ec_donations_incr_window; only the WHERE differs.
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
      AND fr.from_type = 'financial_entity'
      AND fr.from_id = ANY (p_from_ids)
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

  -- ── ie_oppose -> 'opposition' ──────────────────────────────────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'ie_oppose'
      AND fr.from_type = 'financial_entity'
      AND fr.from_id = ANY (p_from_ids)
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'opposition'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_opp FROM inserted;

  RETURN QUERY VALUES ('donation'::text,   v_del_don, v_count),
                      ('opposition'::text, v_del_opp, v_opp);
END;
$function$;

COMMENT ON FUNCTION public.rebuild_ec_donation_edges_for_donors(uuid[]) IS
  'FIX-1211 — re-derive the donation + opposition entity_connections edges of the '
  'given financial_entity donors from their full financial_relationships history '
  '(the rebuild_ec_donations_incr_window aggregation, same strength). Repairs an '
  'edge that lost some but not all of its evidence, which no updated_at-keyed '
  'writer can see. Takes the entity_connections_rebuild advisory key as an xact '
  'lock; 55P03 when held — retry. Edge ids change.';

REVOKE ALL ON FUNCTION public.rebuild_ec_donation_edges_for_donors(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donation_edges_for_donors(uuid[]) TO service_role;
