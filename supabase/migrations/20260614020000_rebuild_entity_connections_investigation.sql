-- FIX-584 (Investigations MVP PR3 of 3): investigation rebuild pass.
--
-- A full chunked rebuild deletes each connection_type's rows and re-derives them
-- from source tables — so a promoted edge inserted directly by promote_evidence_edge
-- (FIX-583) would be wiped by the next rebuild unless something re-projects it.
-- This chunk is that something: it re-derives every status='promoted' edge card as
-- an entity_connections row tagged evidence_source='investigation', so promoted
-- edges survive the periodic TRUNCATE+rebuild.
--
-- Mirror of rebuild_entity_connections_external() (20260513000000, the LittleSis
-- pass): MUST run LAST with ON CONFLICT DO NOTHING so authoritative edges (FEC /
-- votes / career_history / LittleSis) populate their (from,to,connection_type)
-- tuples first and a community assertion never overrides them (design §5
-- decision 5). DELETEs only its own evidence_source='investigation' rows.
--
-- connection_type = relationship_kind (the 16 assertable kinds are all valid
-- connection_type enum values — verified; no enum change, decision 5).
-- strength = 0.400 fixed modest constant.
--
-- Running this chunk standalone post-promote is a safe pure-insert (DELETE own +
-- INSERT ... ON CONFLICT DO NOTHING), so the data-state run on each env (local,
-- prod) is idempotent.

-- ── investigation (promoted evidence_cards → entity_connections) ─────────────
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_investigation()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections
   WHERE evidence_source = 'investigation';

  WITH agg AS (
    SELECT
      ec.from_type,
      ec.from_id,
      ec.to_type,
      ec.to_id,
      ec.relationship_kind                                       AS rk,
      COUNT(*)                                                   AS evidence_count,
      (ARRAY_AGG(ec.id ORDER BY ec.updated_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.evidence_cards ec
    WHERE ec.status     = 'promoted'
      AND ec.claim_type = 'edge'
    GROUP BY ec.from_type, ec.from_id, ec.to_type, ec.to_id, ec.relationship_kind
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id,
      a.rk::public.connection_type,
      0.400::numeric(4,3),
      a.evidence_count, 'investigation', a.evidence_ids
    FROM agg a
    ON CONFLICT (from_type, from_id, to_type, to_id, connection_type) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'investigation_total'; edges_upserted := v_count; RETURN NEXT;
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_investigation() SET statement_timeout = '5min';

-- ── Umbrella — append the investigation chunk LAST ───────────────────────────
-- CREATE OR REPLACE of the current umbrella (20260523040002, FIX-338). Identical
-- body with 'rebuild_entity_connections_investigation' appended to chunk_names
-- AFTER 'rebuild_entity_connections_external' so both ON-CONFLICT-DO-NOTHING
-- passes run after every authoritative pass. The refresh_connection_type_counts()
-- tail is preserved.
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  chunk_fn TEXT;
  chunk_names TEXT[] := ARRAY[
    'rebuild_entity_connections_donations',
    'rebuild_entity_connections_votes',
    'rebuild_entity_connections_cosponsors',
    'rebuild_entity_connections_appointments',
    'rebuild_entity_connections_oversight',
    'rebuild_entity_connections_holds',
    'rebuild_entity_connections_gifts',
    'rebuild_entity_connections_contracts',
    'rebuild_entity_connections_lobbying',
    'rebuild_entity_connections_external',
    'rebuild_entity_connections_investigation'
  ];
BEGIN
  FOREACH chunk_fn IN ARRAY chunk_names LOOP
    BEGIN
      FOR r IN EXECUTE format('SELECT * FROM public.%I()', chunk_fn) LOOP
        connection_type := r.connection_type;
        edges_upserted  := r.edges_upserted;
        RETURN NEXT;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'rebuild chunk % failed: %', chunk_fn, SQLERRM;
      connection_type := chunk_fn || ':failed';
      edges_upserted  := -1;
      RETURN NEXT;
    END;
  END LOOP;

  -- FIX-338 — materialize the connection_type GROUP BY once per rebuild.
  BEGIN
    PERFORM public.refresh_connection_type_counts();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'refresh_connection_type_counts failed: %', SQLERRM;
  END;

  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections() SET statement_timeout = '60min';
