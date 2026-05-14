-- =============================================================================
-- FIX-263 — Chunked rebuild_entity_connections() by connection_type
--
-- Background: as of 2026-05-13, financial_relationships holds ~4.1M donations
-- + 1.3M contracts + 88K grants + IE rows. The pre-existing monolithic
-- rebuild_entity_connections() TRUNCATEd entity_connections and re-derived
-- every connection_type in one PL/pgSQL function call. With the FIX-236
-- prod backfill on 2026-05-13 (Run #2 of the audit cycle), that call exceeded
-- the 20-min outer session statement_timeout twice in a row (regular daily
-- cron + audit wrapper). Result: entity_connections stuck at 1,914,433 rows
-- — the new ~2.6M FIX-236 donation rows did not materialize as graph edges.
--
-- Fix: split the monolith into one function per connection_type. Each chunk:
--   • DELETEs only its own connection_type rows (no global TRUNCATE)
--   • INSERTs the freshly-derived rows
--   • Sets its own per-function statement_timeout
--
-- The orchestrator (packages/data/src/pipelines/index.ts) calls each chunk
-- as a separate top-level statement, so each one gets a fresh session
-- statement_timeout budget (30–60 min) instead of sharing one 20-min cap
-- across all derivations.
--
-- Failure isolation: if e.g. the donations chunk times out but contracts
-- succeeds, the graph has fresh contracts and stale donations rather than
-- staying all-stale. The umbrella rebuild_entity_connections() preserves
-- single-call semantics for PostgREST (local dev) by looping through the
-- chunks itself; partial failures surface as one row per failed chunk in
-- the returned table.
--
-- Concurrency benefit: per-connection_type DELETEs hold row-level locks
-- for the duration of one chunk, instead of the ACCESS EXCLUSIVE lock that
-- TRUNCATE held for the entire rebuild. Live reads on /officials/[id] and
-- /donors/[id] are no longer blocked during the rebuild window.
--
-- External (block 10, FIX-251 LittleSis) MUST run last because it uses
-- ON CONFLICT DO NOTHING — the authoritative blocks (donation, appointment
-- from career_history, lobbying from FR.lobbying_spend) need to populate
-- their rows first so external's overlapping rows are skipped.
--
-- The donation chunk also handles ie_support (FIX-240 fold-in) and the
-- recipient_count UPDATE on financial_entities (FIX-194 block 1b), since
-- both depend on the freshly-derived donation edges.
-- =============================================================================

-- ── 1. donation (heaviest chunk — ~4M edges from 4.1M FR.donation + ~3.8K ie_support)
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_donations() SET statement_timeout = '60min';

-- ── 2. votes (vote_yes / vote_no / vote_abstain) — single INSERT, three counts
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_votes() SET statement_timeout = '15min';

-- ── 3. co_sponsorship
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_cosponsors()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_cosponsors() SET statement_timeout = '10min';

-- ── 4. appointment (career_history → governing_body)
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_appointments()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_appointments() SET statement_timeout = '15min';

-- ── 5. oversight (governing_body → agency, static lookup)
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_oversight()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_oversight() SET statement_timeout = '5min';

-- ── 6. holds_position (stock/bond/property, ongoing)
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_holds()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_holds() SET statement_timeout = '10min';

-- ── 7. gift_received (gift / honorarium)
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_gifts()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_gifts() SET statement_timeout = '10min';

-- ── 8. contract_award (contract / grant) — second-heaviest chunk (~1.3M rows)
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_contracts()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_contracts() SET statement_timeout = '30min';

-- ── 9. lobbying (lobbying_spend)
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_lobbying()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_lobbying() SET statement_timeout = '10min';

-- ── 10. external_relationships (LittleSis et al — FIX-251)
-- MUST run after the authoritative blocks above. Uses ON CONFLICT DO NOTHING
-- so any (from,to,ct) tuple already populated by FEC / votes / career_history
-- keeps its authoritative row. Deletes only rows tagged
-- evidence_source='external_relationships' so it doesn't wipe authoritative
-- overlaps from other chunks.
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_external()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_external() SET statement_timeout = '15min';

-- ── Umbrella function — preserves single-call PostgREST semantics ────────────
--
-- Loops through every chunk and aggregates results into one TABLE return.
-- Partial failures: if a chunk raises, the umbrella logs a warning and emits
-- a row with connection_type='<chunk>:failed' / edges_upserted=-1, then
-- continues to the next chunk. The orchestrator (TypeScript) uses each
-- chunk function directly when SUPABASE_DB_URL is set, so this umbrella is
-- primarily for local dev (PostgREST) where the rebuild completes in <1s
-- anyway and PostgREST's gateway timeout isn't a factor.
--
-- Order matters: external (block 10) MUST run last because its ON CONFLICT
-- DO NOTHING depends on the authoritative blocks having already written.
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
    'rebuild_entity_connections_external'
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
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections() SET statement_timeout = '60min';
