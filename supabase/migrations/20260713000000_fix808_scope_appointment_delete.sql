-- FIX-808: scope the appointment-rebuild DELETE to its own evidence_source.
--
-- ROOT CAUSE. connection_type='appointment' is co-owned by two writers:
--   1. The agency-leadership + plum-book pipelines, which write the canonical
--      official → agency appointment edges (FIX-211 direction) directly, with
--      metadata.is_current + ended_at, evidence_source in
--      ('wikidata','plum_book','congress_nominations').
--   2. rebuild_entity_connections_appointments() (this function), a rebuild
--      chunk run twice-weekly via pg_cron (FIX-687). It DELETEs *every*
--      appointment edge and re-derives official → governing_body from
--      career_history (evidence_source='career_history').
--
-- The unscoped DELETE meant every rebuild permanently destroyed the pipelines'
-- official → agency edges. career_history is empty (0 rows local + prod), so the
-- re-derivation inserts nothing — leaving the table with ZERO official → agency
-- appointment edges. /api/graph/leadership-tenure (FIX-808) and the FIX-733
-- Tenure Gantt then render their empty state for every agency. The LittleSis
-- fe↔fe / official↔fe appointment edges survive only because a *different*
-- chunk (external, ON CONFLICT DO NOTHING) re-derives them from the
-- external_relationships source table each run.
--
-- FIX. Scope the DELETE to evidence_source='career_history' so this chunk owns
-- only the edges it produces. Pipeline-written official → agency edges (and the
-- LittleSis external edges, managed by their own chunk) now survive rebuilds.
-- The career_history derivation is otherwise unchanged and still functions if
-- that table is ever populated.
--
-- Base is the live function definition (pg_get_functiondef); only the DELETE
-- predicate changed. Re-populating the official → agency edges is a separate
-- data action (re-run agency-leadership + plum-book per environment) — a schema
-- change alone does not restore derived data.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_appointments()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '15min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  -- FIX-808: scope to this chunk's own source. Was an unscoped
  -- `WHERE connection_type = 'appointment'`, which nuked the agency-leadership /
  -- plum-book official → agency edges on every rebuild.
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'appointment'
     AND entity_connections.evidence_source = 'career_history';

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

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;
