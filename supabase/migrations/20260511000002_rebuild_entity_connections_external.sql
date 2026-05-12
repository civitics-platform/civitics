-- =============================================================================
-- FIX-251 · Extend rebuild_entity_connections() to materialize edges from
-- public.external_relationships (LittleSis et al).
--
-- Layered on top of the 9 existing blocks finalized in
-- 20260422000005_rebuild_entity_connections_finalize.sql. The TRUNCATE at the
-- top of the function still wipes entity_connections first, so block ordering
-- matters: blocks 1-9 (authoritative FEC / votes / career_history / FR data)
-- run first, then block 10 layers in external edges with ON CONFLICT DO NOTHING
-- so the authoritative sources stay authoritative for any (from,to,ct) tuple
-- where they overlap (e.g. case 4 appointment vs LittleSis Position, case 9
-- lobbying vs LittleSis cat-7 Lobbying).
--
-- LittleSis attribution: edges with evidence_source='external_relationships'
-- contain data derived from LittleSis (https://littlesis.org), licensed
-- CC-BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_count        BIGINT;
  v_vote_yes     BIGINT;
  v_vote_no      BIGINT;
  v_vote_abstain BIGINT;
BEGIN
  -- #variable_conflict use_column above tells pl/pgsql to resolve a bare
  -- `connection_type` reference to the entity_connections column rather than
  -- this function's OUT parameter of the same name. Required by block 10
  -- (external_relationships) which has bare references inside the ON CONFLICT
  -- column list; the other blocks all qualify or cast and would parse without
  -- it, but the directive is per-function and harmless for them.
  TRUNCATE TABLE public.entity_connections;

  -- ── 1. donation ──────────────────────────────────────────────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
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
  connection_type := 'donation'; edges_upserted := v_count; RETURN NEXT;

  -- ── 2. vote_yes / vote_no / vote_abstain (single INSERT, RETURNING counts) ─
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

  -- ── 3. co_sponsorship ────────────────────────────────────────────────────
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

  -- ── 4. appointment (career_history → governing_body) ─────────────────────
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

  -- ── 5. oversight (governing_body → agency, static lookup) ────────────────
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

  -- ── 6. holds_position (stock/bond/property, ongoing) ─────────────────────
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

  -- ── 7. gift_received (gift / honorarium) ─────────────────────────────────
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

  -- ── 8. contract_award (contract / grant) ─────────────────────────────────
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

  -- ── 9. lobbying (lobbying_spend) ─────────────────────────────────────────
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

  -- ── 10. external_relationships (LittleSis et al — FIX-251) ───────────────
  -- Aggregates per (from, to, connection_type) across all external sources.
  -- The pipeline pre-mapped LittleSis category → connection_type at ingest, so
  -- the RPC just sums amounts and counts evidence. Uses ON CONFLICT DO NOTHING
  -- so authoritative blocks above (appointment from career_history, lobbying
  -- from FR.lobbying_spend) keep their rows for any (from,to,ct) overlap.
  --
  -- The CTE aliases the connection_type column to `ct` because the function's
  -- RETURNS TABLE declaration introduces an OUT parameter named connection_type
  -- — leaving the column unaliased makes every bare reference inside the CTE
  -- body ambiguous (pl/pgsql resolves the bare name as the OUT param).
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

  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections() SET statement_timeout = '120s';
