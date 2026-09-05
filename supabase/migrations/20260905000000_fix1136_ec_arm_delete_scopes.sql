-- 20260905000000_fix1136_ec_arm_delete_scopes.sql
-- FIX-1136 — every entity_connections rebuild arm deletes only what its own
-- INSERT writes.
--
-- ── THE RULE ────────────────────────────────────────────────────────────────
-- An arm's DELETE must be scoped to the `evidence_source` literal that the same
-- arm's INSERT stamps. Anything else makes the arm a destructive neighbour: it
-- clears the whole connection_type and then repopulates only its own slice, so
-- any edge of that type written by a DIFFERENT producer is silently destroyed
-- on every rebuild. That is not hypothetical — it is FIX-808 (the appointment
-- arm nuked the agency-leadership / plum-book official→agency edges on every
-- run) and FIX-985 (gifts / holds / lobbying, same shape). This migration
-- finishes the sweep those two started.
--
-- ── THE CENSUS, re-derived on prod 2026-09-04 from pg_proc.prosrc ───────────
-- Thirteen arms. Eight were already safe, five were not:
--
--   arm               DELETE predicate                             class
--   ────────────────  ───────────────────────────────────────────  ───────────
--   appointments      ct='appointment' AND es='career_history'     scoped (808)
--   contracts         ct='contract_award'                          BARE
--   cosponsors        ct='co_sponsorship'                          BARE
--   donations         dirty-set join on (from_type, from_id)       dirty-set
--   donations_full    ct IN ('donation','opposition')              BARE
--   external          es='external_relationships'                  scoped
--   gifts             ct='gift_received'  AND es='financial_rel…'  scoped (985)
--   holds             ct='holds_position' AND es='financial_rel…'  scoped (985)
--   investigation     es='investigation'                           scoped
--   lobbying          ct='lobbying'       AND es='financial_rel…'  scoped (985)
--   oversight         ct='oversight'                               BARE
--   votes             dirty-set join on (official_id, proposal)    dirty-set
--   votes_full        ct IN ('vote_yes','vote_no','vote_abstain')  BARE
--
-- The five BARE ones are what this migration scopes. The two dirty-set arms are
-- already bounded by key and are left alone deliberately: narrowing them
-- further is a behaviour change to the incremental path, and FIX-1139 is the
-- only edit the votes arm gets in this batch.
--
-- The literal for each arm is read from that arm's OWN INSERT, never from a
-- bullet:
--
--   contracts       → 'financial_relationships'
--   cosponsors      → 'cosponsorship'
--   donations_full  → 'financial_relationships'
--   oversight       → 'agency_oversight'
--   votes_full      → 'votes'
--
-- ── WHAT THIS CHANGES TODAY: NOTHING, AND THAT IS THE POINT ────────────────
-- Every affected connection_type currently carries exactly ONE evidence_source
-- on prod (measured 2026-09-04):
--
--   contract_award  financial_relationships    189,949
--   donation        financial_relationships  9,239,692
--   opposition      financial_relationships      4,684
--   vote_yes        votes                      359,018
--   vote_no         votes                      150,820
--   co_sponsorship  —                                0   (proposal_cosponsors empty)
--   oversight       —                                0
--   vote_abstain    —                                0
--
-- So not one row changes hands. This is correct-by-construction hardening: the
-- next producer that writes a 'contract_award' edge from somewhere other than
-- financial_relationships does not get quietly deleted the way the plum-book
-- appointments did. Landing it while the blast radius is zero is the cheap
-- moment, not a reason to skip it.
--
-- ── NOT TOUCHED ────────────────────────────────────────────────────────────
-- The FIX-1117 arm-source fingerprint gate. It lives in the ORCHESTRATOR
-- (ec_arm_source_fingerprint(text), consulted per arm before the arm is
-- called), not in these bodies. Five arms — cosponsors, appointments, gifts,
-- holds, lobbying — currently fingerprint as `n=0;t=-` because their source
-- tables are empty. Nothing here changes WHEN an arm runs, only what it deletes
-- when it does.
--
-- Each function is re-created with its EXACT prior body plus one predicate, and
-- with its `SET statement_timeout` re-stated: CREATE OR REPLACE does not
-- preserve a SET clause the new definition omits, and dropping the per-arm
-- timeouts would hand a runaway arm the role's 6 h ceiling instead of its own
-- 5–30 min bound. EXECUTE is re-REVOKEd on the same principle (FIX-834) even
-- though REPLACE preserves the ACL — these are internal rebuild arms and must
-- never be reachable from anon/authenticated.
--
-- Cross-ref FIX-808, FIX-985, FIX-1117, FIX-747, FIX-1118b.
--
-- Fixes: FIX-1136
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. contracts ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_contracts()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '30min'
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

-- ── 2. cosponsors ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_cosponsors()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
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

-- ── 3. oversight ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_oversight()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '5min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  -- FIX-1136: scoped to this arm's own source (was a bare connection_type match).
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'oversight'
     AND entity_connections.evidence_source = 'agency_oversight';

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

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_oversight() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_oversight() TO service_role;

-- ── 4. donations_full ────────────────────────────────────────────────────────
--
-- Two derived classes in one arm (FIX-747), so two literals — except both are
-- 'financial_relationships', which is why one predicate covers the pair. The
-- watermark write at the tail already carries FIX-983's horizon and is
-- untouched here.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations_full()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count BIGINT;
  v_opp   BIGINT;
BEGIN
  -- FIX-747: clear both derived classes (was 'donation' only).
  -- FIX-1136: and only the rows this arm itself wrote.
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type IN ('donation', 'opposition')
     AND entity_connections.evidence_source = 'financial_relationships';

  -- donation + ie_support → 'donation'
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

  -- FIX-747: ie_oppose → 'opposition'
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

  -- Advance watermark so the next incremental run picks up from the horizon.
  -- FIX-983: NOT NOW() — a full pass reads the head under the same
  -- uncommitted-writer exposure as an incremental one.
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', public.fr_watermark_horizon()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'donation';   edges_upserted := v_count; RETURN NEXT;
  connection_type := 'opposition'; edges_upserted := v_opp;   RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_donations_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations_full() TO service_role;

-- ── 5. votes_full ────────────────────────────────────────────────────────────
--
-- Scoped here; its bare-NOW() watermark write is FIX-1139's edit, in the very
-- next migration. This body is therefore superseded within the same push — kept
-- as its own step so the census below reads true regardless of which of the two
-- an environment has applied.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes_full()
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
  -- FIX-1136: scoped to this arm's own source (was a bare connection_type match).
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')
     AND entity_connections.evidence_source = 'votes';

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

  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_votes',
    jsonb_build_object('last_indexed_at', NOW()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes_full() TO service_role;

-- ── 6. Guard — the census, enforced ──────────────────────────────────────────
--
-- The same regexp census FIX-1136 used to find the five, run as an assertion so
-- a future arm cannot regress to a bare DELETE without stopping the migration
-- that introduces it. "Scoped" = the body's DELETE text mentions
-- evidence_source, OR the arm deletes through a dirty-set join (USING).

DO $$
DECLARE
  v_bare text[];
BEGIN
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_bare
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname ~ '^rebuild_entity_connections_'
    AND p.prosrc ~* 'DELETE\s+FROM\s+public\.entity_connections'
    AND p.prosrc !~* 'DELETE\s+FROM\s+public\.entity_connections[^;]*evidence_source'
    AND p.prosrc !~* 'DELETE\s+FROM\s+public\.entity_connections[^;]*USING';

  IF v_bare IS NOT NULL THEN
    RAISE EXCEPTION '[fix1136] arm(s) still delete by bare connection_type: %', v_bare;
  END IF;

  RAISE NOTICE '[fix1136] census passed — every entity_connections arm DELETE is scoped or dirty-set joined';
END $$;
