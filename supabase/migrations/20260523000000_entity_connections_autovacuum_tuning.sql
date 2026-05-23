-- FIX-331 — autovacuum tuning + per-chunk ANALYZE for entity_connections.
--
-- Background: FIX-263 (2026-05-13) replaced the TRUNCATE in
-- rebuild_entity_connections() with per-connection-type DELETE. TRUNCATE
-- generates no dead tuples; DELETE does. Default autovacuum
-- (vacuum_scale_factor=0.2) only kicks in at 20% dead tuples — by then the
-- visibility map is stale, the planner ditches the index-only scan that
-- get_connection_type_counts() (FIX-298) relies on, and falls back to a
-- parallel seq scan that runs ~140x slower than the original sub-200ms
-- benchmark (FIX-328 captured 28-31s).
--
-- Two fixes in this migration:
-- 1. Tighten autovacuum thresholds on entity_connections so it kicks in at
--    5% dead tuples and re-analyzes at 2%.
-- 2. ANALYZE entity_connections at the end of each chunk function so
--    planner stats reflect the freshly-derived row distribution
--    immediately (autovacuum's analyzer is reactive; this is proactive).
--
-- VACUUM cannot run inside a function (transaction restriction), so we
-- rely on the tightened autovacuum to reclaim dead-tuple space. The
-- tightened threshold means autovacuum will run within minutes of each
-- chunked rebuild, not days later.

ALTER TABLE public.entity_connections SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

-- ---------------------------------------------------------------------------
-- Donations chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '90min'
AS $function$
DECLARE
  v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'donation';

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

  -- Block 1b (FIX-194) — recipient_count update for individual donors.
  -- Lives in the donation chunk because it depends on freshly-written
  -- donation edges. NULL-resets first so donors whose last donation was
  -- removed from FR (rare) drop to 0 rather than retaining a stale count.
  UPDATE public.financial_entities fe
  SET recipient_count = sub.cnt
  FROM (
    SELECT
      ec.from_id,
      COUNT(DISTINCT ec.to_id)::SMALLINT AS cnt
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'donation'
      AND ec.from_type = 'financial_entity'
    GROUP BY ec.from_id
  ) sub
  WHERE fe.id = sub.from_id
    AND fe.entity_type = 'individual';

  connection_type := 'donation'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Votes chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '15min'
AS $function$
#variable_conflict use_column
DECLARE
  v_vote_yes     BIGINT;
  v_vote_no      BIGINT;
  v_vote_abstain BIGINT;
BEGIN
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain');

  WITH inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT DISTINCT ON (v.official_id, v.bill_proposal_id)
      'official', v.official_id, 'proposal', v.bill_proposal_id,
      (CASE v.vote
         WHEN 'yes'     THEN 'vote_yes'
         WHEN 'no'      THEN 'vote_no'
         WHEN 'abstain' THEN 'vote_abstain'
       END)::public.connection_type,
      0.500::numeric(4,3),
      v.voted_at::date,
      1, 'votes', ARRAY[v.id]
    FROM public.votes v
    WHERE v.bill_proposal_id IS NOT NULL
      AND v.official_id IS NOT NULL
      AND v.vote IN ('yes', 'no', 'abstain')
    ORDER BY v.official_id, v.bill_proposal_id, v.voted_at DESC NULLS LAST, v.id DESC
    RETURNING entity_connections.connection_type AS ct
  )
  SELECT
    COUNT(*) FILTER (WHERE ct = 'vote_yes'),
    COUNT(*) FILTER (WHERE ct = 'vote_no'),
    COUNT(*) FILTER (WHERE ct = 'vote_abstain')
  INTO v_vote_yes, v_vote_no, v_vote_abstain
  FROM inserted;

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Cosponsors chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_cosponsors()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'co_sponsorship';

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

-- ---------------------------------------------------------------------------
-- Appointments chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_appointments()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '15min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'appointment';

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

-- ---------------------------------------------------------------------------
-- Oversight chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_oversight()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '5min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'oversight';

  WITH inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      'governing_body', ag.governing_body_id, 'agency', ag.id,
      'oversight'::public.connection_type,
      0.700::numeric(4,3),
      1, 'agency_oversight', ARRAY[ag.id]
    FROM public.agencies ag
    WHERE ag.governing_body_id IS NOT NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'oversight'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Holds (holds_position) chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_holds()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'holds_position';

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.started_at)                AS first_at,
      (ARRAY_AGG(fr.id ORDER BY fr.started_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('owns_stock', 'owns_bond', 'property')
      AND fr.ended_at IS NULL
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'holds_position'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        0.4 + LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 16.0
      ))::numeric(4,3),
      NULLIF(a.total_cents, 0), a.first_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'holds_position'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Gifts (gift_received) chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_gifts()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'gift_received';

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.occurred_at)               AS first_at,
      MAX(fr.occurred_at)               AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('gift', 'honorarium')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'gift_received'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 6.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'gift_received'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Contracts (contract_award) chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_contracts()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '30min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'contract_award';

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

-- ---------------------------------------------------------------------------
-- Lobbying chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_lobbying()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections WHERE entity_connections.connection_type = 'lobbying';

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.started_at)                AS first_at,
      MAX(COALESCE(fr.ended_at, CURRENT_DATE)) AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.started_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'lobbying_spend'
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'lobbying'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'lobbying'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

-- ---------------------------------------------------------------------------
-- External (external_relationships) chunk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_external()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '15min'
AS $function$
#variable_conflict use_column
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections
   WHERE evidence_source = 'external_relationships';

  WITH agg AS (
    SELECT
      er.from_type, er.from_id, er.to_type, er.to_id,
      er.connection_type                         AS ct,
      COUNT(*)                                   AS evidence_count,
      SUM(COALESCE(er.amount_cents, 0))          AS total_cents,
      MIN(er.occurred_at)                        AS first_at,
      MAX(COALESCE(er.ended_at, er.occurred_at)) AS last_at,
      (ARRAY_AGG(er.id ORDER BY er.source_updated_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.external_relationships er
    GROUP BY er.from_type, er.from_id, er.to_type, er.to_id, er.connection_type
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, a.ct,
      CASE a.ct
        WHEN 'affiliated_with'  THEN 0.300
        WHEN 'member_of'        THEN 0.500
        WHEN 'parent_of'        THEN 0.600
        WHEN 'owns'             THEN 0.700
        WHEN 'business_partner' THEN
          CASE
            WHEN a.total_cents > 0 THEN LEAST(0.999, GREATEST(0.001,
              LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0))
            ELSE 0.400
          END
        WHEN 'lobbying' THEN LEAST(0.999, GREATEST(0.001,
          LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0))
        WHEN 'appointment' THEN 0.500
        ELSE 0.400
      END::numeric(4,3),
      NULLIF(a.total_cents, 0), a.first_at, a.last_at,
      a.evidence_count, 'external_relationships', a.evidence_ids
    FROM agg a
    ON CONFLICT (from_type, from_id, to_type, to_id, connection_type) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'external_relationships_total'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;
