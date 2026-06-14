-- FIX-588 — make the Sunday full rebuild_entity_connections fit the 4h budget.
--
-- Root cause (prod EXPLAIN ANALYZE, 2026-06-14, run 27496446207):
--   * votes_full ran 72min though its plan is a clean Index Scan on
--     votes_derivation_idx — because that index does NOT store `vote`, the
--     DISTINCT ON heap-fetches `vote` for all ~911k qualifying rows, and on the
--     cache-starved Pro Small (256MB shared_buffers) those are cold random
--     reads. Fix: add INCLUDE (vote) → index-only scan → no heap fetches.
--   * donations_full FAILED at exactly 5400s (its 90min statement_timeout). It
--     is one top-level statement, so the session timeout covers the whole
--     agg+INSERT(~4M edges into a 9-index table)+recipient_count UPDATE. The
--     agg scan is already index-only and ~I/O-bound; the durable fix is to
--     split the work across SEPARATE top-level statements (each gets a fresh
--     statement_timeout) by from_id window. The GROUP BY keys on from_id, so a
--     from_id-range window emits each donor's complete edge set — windowing is
--     result-identical to the monolith. prepare()/window()/finalize() below are
--     orchestrated by scripts/rebuild-entity-connections.ts.
--
-- The legacy rebuild_entity_connections_donations_full() is left intact (the
-- local-dev PostgREST umbrella still calls it); the prod direct-pg path switches
-- to the windowed sequence.

-- ── 1. votes_derivation_idx → index-only (add INCLUDE (vote)) ─────────────────
-- Drop + recreate (can't ALTER INCLUDE in place). Recreated in the same
-- transaction, so the incremental votes path is never without it. Brief
-- write-lock on votes (~937k rows, seconds) — applied off the nightly cycle.
DROP INDEX IF EXISTS public.votes_derivation_idx;
CREATE INDEX votes_derivation_idx
  ON public.votes (official_id, bill_proposal_id, voted_at DESC NULLS LAST, id DESC)
  INCLUDE (vote)
  WHERE vote = ANY (ARRAY['yes'::text, 'no'::text, 'abstain'::text]);

COMMENT ON INDEX public.votes_derivation_idx IS
  'FIX-422 derivation index for votes_full DISTINCT ON; FIX-588 added INCLUDE (vote) '
  'so the rebuild scan is index-only (was 911k cold heap fetches → 72min on prod).';

-- ── 2. donations full rebuild, split into prepare / window / finalize ─────────

-- 2a. prepare — clear donation edges + advance the incremental watermark. Run
-- once before the windows. (The watermark advances up front so a concurrent FR
-- write during the rebuild is caught by the next incremental, not lost.)
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_full_prepare()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'donation';

  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', NOW()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$$;
ALTER FUNCTION public.rebuild_ec_donations_full_prepare()
  SET statement_timeout = '30min';
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_prepare() TO service_role;

-- 2b. window — aggregate + insert donation edges for from_id in [p_lo, p_hi).
-- p_hi NULL means "to the end" (last window). Identical aggregation to
-- rebuild_entity_connections_donations_full()'s CTE, scoped by from_id range.
-- Each call is its OWN top-level statement → its own statement_timeout.
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_full_window(
  p_lo uuid,
  p_hi uuid
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_count bigint;
BEGIN
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
      AND fr.from_id >= p_lo
      AND (p_hi IS NULL OR fr.from_id < p_hi)
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

  RETURN v_count;
END;
$$;
ALTER FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid)
  SET statement_timeout = '45min';
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid) TO service_role;

-- 2c. finalize — recompute recipient_count for individual donors (FIX-194
-- block 1b) once, after all windows have landed. Own statement → own timeout.
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_full_finalize()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_count bigint;
BEGIN
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

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
ALTER FUNCTION public.rebuild_ec_donations_full_finalize()
  SET statement_timeout = '60min';
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_finalize() TO service_role;
