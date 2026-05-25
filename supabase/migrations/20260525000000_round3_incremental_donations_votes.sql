-- =============================================================================
-- Round 3 — Incremental rebuild_entity_connections for donations + votes
--
--   FIX-372 (donations) — single biggest IO lever per the IOWait audit:
--     17.7% of all prod DB time, 29M shared_blks_read / 25M dirtied per call.
--   FIX-373 (votes)     — same shape, 3.5% of all prod DB time.
--
-- See docs/audits/2026-05-24-iowait-diagnosis.md Section I Finding #1.
-- Investigation: docs/audits/2026-05-25-round3-incremental-feasibility.md
--
-- Shape:
--   public.rebuild_entity_connections_donations_full()  ← Sunday safety net
--   public.rebuild_entity_connections_donations()       ← Wednesday incremental
--   public.rebuild_entity_connections_votes_full()      ← Sunday safety net
--   public.rebuild_entity_connections_votes()           ← Wednesday incremental
--
--   Both _full() and incremental advance the watermark on completion. First
--   incremental run after deploy sees NULL watermark and bootstraps as full.
--
-- Watermark store: public.pipeline_state (existing (key) PK + value JSONB
-- shape, matches kill_switches/platform_plan convention).
--   key='entity_connections_donations', value={"last_indexed_at":"<iso>"}
--   key='entity_connections_votes',     value={"last_indexed_at":"<iso>"}
--
-- Substrate this migration adds (lost during 2026-04-22 shadow→public cutover):
--   * set_updated_at BEFORE UPDATE trigger on financial_relationships + votes
--   * btree(updated_at) on financial_relationships + votes
--
-- Out of scope: the other 8 chunks (cosponsors, appointments, oversight, holds,
-- gifts, contracts, lobbying, external) keep their full-rebuild shape. Together
-- they're <10% of DB time; not worth the diff size for PR 1. File a follow-up
-- FIX once 372/373 prove out.
-- =============================================================================

-- ── 0. Substrate ─────────────────────────────────────────────────────────────
--
-- The 0001 initial schema had these triggers and indexes; they were lost when
-- the shadow→public cutover (20260422000000) DROPped the old public.{FR,votes}
-- and promoted the shadow versions from stage1_04/05 which never recreated
-- them. The set_updated_at() function itself survived the cutover.
--
-- Trigger: BEFORE UPDATE on every row, sets NEW.updated_at = NOW(). Pipeline
-- UPSERTs (ON CONFLICT DO UPDATE) fire it normally; no writer in packages/data
-- explicitly writes updated_at to a literal, verified by grep 2026-05-25.
--
-- Index: small (~70 MB on prod's 5GB FR, ~6 MB on votes), seeks the dirty set
-- in milliseconds for typical Wed run sizes (~10k–100k rows/day per audit §H).
-- Created without CONCURRENTLY — brief ACCESS EXCLUSIVE lock during apply is
-- acceptable for a one-time migration. Standing convention in this repo.

DROP TRIGGER IF EXISTS financial_relationships_updated_at
  ON public.financial_relationships;
CREATE TRIGGER financial_relationships_updated_at
  BEFORE UPDATE ON public.financial_relationships
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS financial_relationships_updated_at
  ON public.financial_relationships(updated_at);

DROP TRIGGER IF EXISTS votes_updated_at
  ON public.votes;
CREATE TRIGGER votes_updated_at
  BEFORE UPDATE ON public.votes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS votes_updated_at
  ON public.votes(updated_at);

-- ── 1. _donations_full() — rename of current body ────────────────────────────
--
-- Body byte-identical to the pre-Round-3 rebuild_entity_connections_donations()
-- at 20260513000000_chunked_rebuild_entity_connections.sql:46-105, with two
-- additions:
--   * advances pipeline_state.entity_connections_donations.last_indexed_at to
--     NOW() on completion so subsequent incremental runs after a Sunday full
--     don't re-process the entire churn since the previous watermark.
--   * 90-min statement_timeout matches the FIX-291 raise on the pre-Round-3
--     monolith.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations_full()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'donation';

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

  -- Block 1b (FIX-194) — recipient_count for individual donors. Full path
  -- rewrites every individual donor's count because every donation edge was
  -- just rebuilt.
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

  -- Advance watermark so the next incremental run picks up from NOW(), not
  -- from the pre-full watermark.
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', NOW()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'donation'; edges_upserted := v_count; RETURN NEXT;
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_donations_full()
  SET statement_timeout = '90min';

GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations_full()
  TO service_role;

-- ── 2. _donations() — incremental on FR.updated_at ───────────────────────────
--
-- NULL watermark → bootstrap path: delegate to _full(), which advances the
-- watermark itself. Otherwise:
--   1. Capture v_new_max BEFORE the rebuild so concurrent writes during the
--      rebuild are caught by the next run, not silently consumed.
--   2. Compute dirty set (from_type, from_id) of FR rows changed since
--      watermark.
--   3. DELETE only entity_connections rows whose from-side is in the dirty set.
--   4. INSERT freshly-aggregated edges for the dirty set (aggregation pulls
--      ALL FR rows for each dirty from_id, not just the changed ones — the
--      derived edge is a sum over the full donor's history).
--   5. UPDATE recipient_count scoped to dirty from_ids only.
--   6. Advance watermark to v_new_max (transactional with everything above —
--      this is one PL/pgSQL function = one implicit txn, so a failure rolls
--      back the watermark advance and the next run reprocesses).

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count                BIGINT;
  v_last_indexed_at      TIMESTAMPTZ;
  v_new_max_updated_at   TIMESTAMPTZ;
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz
    INTO v_last_indexed_at
  FROM public.pipeline_state
  WHERE key = 'entity_connections_donations';

  IF v_last_indexed_at IS NULL THEN
    -- Bootstrap: delegate to _full(), which sets the watermark itself.
    RETURN QUERY SELECT * FROM public.rebuild_entity_connections_donations_full();
    RETURN;
  END IF;

  CREATE TEMP TABLE _dirty_from_ids ON COMMIT DROP AS
  SELECT DISTINCT fr.from_type, fr.from_id
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support')
    AND fr.updated_at > v_last_indexed_at;

  SELECT MAX(fr.updated_at) INTO v_new_max_updated_at
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support');

  -- No-op short-circuit when nothing changed.
  IF NOT EXISTS (SELECT 1 FROM _dirty_from_ids) THEN
    -- Still advance the watermark — the table may have had non-donation churn
    -- since the last run, and v_new_max_updated_at is the floor for the next
    -- incremental.
    INSERT INTO public.pipeline_state (key, value)
    VALUES (
      'entity_connections_donations',
      jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, NOW())::text)
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();

    connection_type := 'donation'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  DELETE FROM public.entity_connections ec
  USING _dirty_from_ids d
  WHERE ec.connection_type = 'donation'
    AND ec.from_type = d.from_type
    AND ec.from_id = d.from_id;

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN _dirty_from_ids d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
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

  -- recipient_count UPDATE — only for individual donors in the dirty set. Off-
  -- set donors keep their existing count.
  UPDATE public.financial_entities fe
  SET recipient_count = sub.cnt
  FROM (
    SELECT
      ec.from_id,
      COUNT(DISTINCT ec.to_id)::SMALLINT AS cnt
    FROM public.entity_connections ec
    INNER JOIN _dirty_from_ids d
      ON d.from_type = ec.from_type AND d.from_id = ec.from_id
    WHERE ec.connection_type = 'donation'
      AND ec.from_type = 'financial_entity'
    GROUP BY ec.from_id
  ) sub
  WHERE fe.id = sub.from_id
    AND fe.entity_type = 'individual';

  -- Advance watermark.
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, NOW())::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'donation'; edges_upserted := v_count; RETURN NEXT;
  RETURN;
END;
$$;

-- Incremental should never take 90min; 45min is a conservative ceiling.
ALTER FUNCTION public.rebuild_entity_connections_donations()
  SET statement_timeout = '45min';

GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations()
  TO service_role;

-- ── 3. _votes_full() — rename of current body ────────────────────────────────
--
-- Body byte-identical to 20260513000000:110-160 with watermark advance bolted
-- on.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes_full()
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
$$;

ALTER FUNCTION public.rebuild_entity_connections_votes_full()
  SET statement_timeout = '15min';

GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes_full()
  TO service_role;

-- ── 4. _votes() — incremental on votes.updated_at ────────────────────────────
--
-- Dirty key = (official_id, bill_proposal_id) tuple. The full-rebuild's
-- DISTINCT ON picks the latest vote per key, so the incremental:
--   * DELETEs all three vote-type edges for each dirty key (covers vote-flip
--     cases like 'yes' → 'no').
--   * Re-derives the latest qualifying vote per dirty key from votes — joining
--     the dirty-keys temp table back to votes pulls every vote row for those
--     keys so DISTINCT ON sees the full history, not just the recently-changed
--     row. A vote that changed to a non-qualifying value (e.g. 'present')
--     correctly drops its edge.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_vote_yes             BIGINT;
  v_vote_no              BIGINT;
  v_vote_abstain         BIGINT;
  v_last_indexed_at      TIMESTAMPTZ;
  v_new_max_updated_at   TIMESTAMPTZ;
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz
    INTO v_last_indexed_at
  FROM public.pipeline_state
  WHERE key = 'entity_connections_votes';

  IF v_last_indexed_at IS NULL THEN
    RETURN QUERY SELECT * FROM public.rebuild_entity_connections_votes_full();
    RETURN;
  END IF;

  CREATE TEMP TABLE _dirty_vote_keys ON COMMIT DROP AS
  SELECT DISTINCT v.official_id, v.bill_proposal_id
  FROM public.votes v
  WHERE v.updated_at > v_last_indexed_at
    AND v.bill_proposal_id IS NOT NULL
    AND v.official_id IS NOT NULL;

  SELECT MAX(v.updated_at) INTO v_new_max_updated_at
  FROM public.votes v
  WHERE v.bill_proposal_id IS NOT NULL
    AND v.official_id IS NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM _dirty_vote_keys) THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (
      'entity_connections_votes',
      jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, NOW())::text)
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();

    connection_type := 'vote_yes';     edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_no';      edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_abstain'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  DELETE FROM public.entity_connections ec
  USING _dirty_vote_keys d
  WHERE ec.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')
    AND ec.from_type = 'official'
    AND ec.from_id = d.official_id
    AND ec.to_type = 'proposal'
    AND ec.to_id = d.bill_proposal_id;

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
    INNER JOIN _dirty_vote_keys d
      ON d.official_id = v.official_id AND d.bill_proposal_id = v.bill_proposal_id
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
    jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, NOW())::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_votes()
  SET statement_timeout = '15min';

GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes()
  TO service_role;
