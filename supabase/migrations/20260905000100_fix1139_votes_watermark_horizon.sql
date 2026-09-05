-- 20260905000100_fix1139_votes_watermark_horizon.sql
-- FIX-1139 — the FIX-983 head-lag invariant, applied to the votes arm, through
-- a name that is no longer about financial_relationships.
--
-- ── THE HOLE ────────────────────────────────────────────────────────────────
-- `votes.updated_at` is stamped by a BEFORE UPDATE trigger (`votes_updated_at`
-- → `set_updated_at()`), which uses NOW() — the moment the writing transaction
-- BEGAN, not the moment it committed. `rebuild_entity_connections_votes()`
-- takes its dirty set as `updated_at > last_indexed_at` and then advances the
-- watermark to `MAX(updated_at)` over the whole table. So a vote-writer that
-- STARTS before the arm reads MAX() and COMMITS after it leaves rows stamped
-- BELOW the new watermark that were invisible when the dirty set was built.
-- Nothing ever picks them up again: the edge for that vote is simply never
-- derived. This is precisely the shape FIX-983 closed on
-- financial_relationships, and the votes arm was left on the old pattern.
--
-- The exposure is not theoretical for this arm. The congress-votes writer
-- batches, and the arm's watermark on prod (`pipeline_state`
-- 'entity_connections_votes') advances daily off jobid 9 — measured
-- 2026-09-04 07:01:29 with a fingerprint of n=974,043. Every night the arm
-- runs is a night the race can land.
--
-- ── THE FIX: a horizon, not a lock ─────────────────────────────────────────
-- No watermark may advance past `clock_timestamp() -
-- civitics.watermark_lag_seconds` (default 3600). Any writer whose transaction
-- is shorter than that lag is safe BY CONSTRUCTION: by the time the horizon
-- reaches its start timestamp, it has long since committed. The cost is
-- staleness bounded by the lag, which for a nightly arm is free.
--
-- ── WHY A NEW NAME, AND WHY THE OLD ONE IS NOW A WRAPPER ───────────────────
-- FIX-983 called this `fr_watermark_horizon()` because it only had one
-- consumer family. It is not an FR concept — it is a property of any
-- `updated_at` watermark over a table whose writers stamp NOW(). So:
--
--   * `public.watermark_horizon()` is created with FIX-983's body verbatim,
--     the same GUC and the same grants. It is the canonical name from here on.
--   * `public.fr_watermark_horizon()` is redefined as a one-line wrapper,
--     `SELECT public.watermark_horizon()`.
--
-- The thirteen FR clamp sites are therefore UNTOUCHED — no churn, nothing to
-- re-prove, and the FIX-983 receipts still describe live code. Renaming them
-- would be a large diff whose only effect is to make thirteen proven call
-- sites unproven again. The wrapper is the cheaper correctness.
--
-- STANDING RULE (playbook rule 11, widened here): every `updated_at` watermark
-- reader/writer uses `watermark_horizon()`. Not NOW(), not a bare
-- MAX(updated_at). If a new incremental rollup keys off an `updated_at`
-- column, it clamps.
--
-- ── THE FOUR EDITS TO rebuild_entity_connections_votes() ────────────────────
--   (a) v_horizon := public.watermark_horizon()
--   (b) v_new_max_updated_at := LEAST(COALESCE(MAX(updated_at), v_horizon), v_horizon)
--       and the MAX() is captured BEFORE the dirty set, the ordering every
--       sibling routine already states.
--   (c) the dirty set is bounded ABOVE by that clamped target, so the set and
--       the watermark can never disagree about what was consumed.
--   (d) the caught-up branch: when the clamped target is at or below the
--       current watermark there is nothing old enough to read yet. Log a
--       'complete' cycle with rows=0 and DO NOT move the watermark — writing
--       the clamped target there would move it BACKWARDS. FIX-1140's shape:
--       `check_rollup_freshness` counts only 'complete', so a caught-up run
--       that logged 'skipped' would freeze the freshness clock and eventually
--       page.
--
-- `rebuild_entity_connections_votes_full()` gets the same treatment on its one
-- bare NOW() watermark write. Its DELETE scope is FIX-1136's, applied in the
-- previous migration and carried forward verbatim here.
--
-- Both functions keep their `SET statement_timeout TO '15min'` — CREATE OR
-- REPLACE drops a SET clause the new definition omits — and both are
-- re-REVOKEd (FIX-834).
--
-- Cross-ref FIX-983, FIX-1074, FIX-1140, FIX-1136, FIX-1101.
--
-- Fixes: FIX-1139
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. watermark_horizon() — the canonical name ──────────────────────────────
--
-- VOLATILE because it reads the clock: it must be re-evaluated per call and
-- must never be folded into a plan-time constant by a caller that COMMITs in a
-- loop.

CREATE OR REPLACE FUNCTION public.watermark_horizon()
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $function$
  SELECT clock_timestamp() - make_interval(secs => COALESCE(
           NULLIF(current_setting('civitics.watermark_lag_seconds', true), '')::int,
           3600));
$function$;

REVOKE ALL ON FUNCTION public.watermark_horizon() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.watermark_horizon() TO service_role;

COMMENT ON FUNCTION public.watermark_horizon() IS
  'FIX-983/FIX-1139 — the head-lag horizon every updated_at watermark clamps to. '
  'No incremental rollup may advance a watermark past clock_timestamp() minus '
  'civitics.watermark_lag_seconds (default 3600), so a writer whose transaction '
  'is shorter than that lag cannot commit rows below an already-advanced '
  'watermark. Canonical name; fr_watermark_horizon() is a wrapper kept so the '
  'thirteen FIX-983 financial_relationships call sites need no churn. VOLATILE '
  'deliberately: callers COMMIT in loops and must re-read the clock.';

-- ── 2. fr_watermark_horizon() becomes a wrapper ──────────────────────────────

CREATE OR REPLACE FUNCTION public.fr_watermark_horizon()
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $function$
  SELECT public.watermark_horizon();
$function$;

REVOKE ALL ON FUNCTION public.fr_watermark_horizon() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fr_watermark_horizon() TO service_role;

COMMENT ON FUNCTION public.fr_watermark_horizon() IS
  'FIX-983, wrapped by FIX-1139 — thin alias for public.watermark_horizon(). '
  'Kept so the thirteen financial_relationships clamp sites FIX-983 proved stay '
  'byte-identical. New call sites use watermark_horizon() directly.';

-- ── 3. rebuild_entity_connections_votes() — the incremental arm ──────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '15min'
AS $function$
#variable_conflict use_column
DECLARE
  v_vote_yes             BIGINT;
  v_vote_no              BIGINT;
  v_vote_abstain         BIGINT;
  v_last_indexed_at      TIMESTAMPTZ;
  v_new_max_updated_at   TIMESTAMPTZ;
  v_horizon              TIMESTAMPTZ;   -- FIX-1139
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz
    INTO v_last_indexed_at
  FROM public.pipeline_state
  WHERE key = 'entity_connections_votes';

  IF v_last_indexed_at IS NULL THEN
    RETURN QUERY SELECT * FROM public.rebuild_entity_connections_votes_full();
    RETURN;
  END IF;

  -- FIX-1139 (a)+(b) — capture the target BEFORE the dirty set and clamp it to
  -- the head-lag horizon, so the dirty set can be bounded above by it.
  SELECT MAX(v.updated_at) INTO v_new_max_updated_at
  FROM public.votes v
  WHERE v.bill_proposal_id IS NOT NULL
    AND v.official_id IS NOT NULL;

  v_horizon            := public.watermark_horizon();
  v_new_max_updated_at := LEAST(COALESCE(v_new_max_updated_at, v_horizon), v_horizon);

  -- FIX-1139 (d) — nothing old enough to read yet. Report zero and leave the
  -- watermark exactly where it is; writing v_new_max_updated_at here would move
  -- it BACKWARDS. The rows are returned (not RAISEd, not skipped) so the
  -- orchestrator logs a 'complete' cycle — FIX-1140: check_rollup_freshness
  -- counts only 'complete', so a caught-up run that reported anything else
  -- would freeze the freshness clock.
  IF v_new_max_updated_at <= v_last_indexed_at THEN
    connection_type := 'vote_yes';     edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_no';      edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_abstain'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  CREATE TEMP TABLE _dirty_vote_keys ON COMMIT DROP AS
  SELECT DISTINCT v.official_id, v.bill_proposal_id
  FROM public.votes v
  WHERE v.updated_at >  v_last_indexed_at
    AND v.updated_at <= v_new_max_updated_at   -- FIX-1139 (c)
    AND v.bill_proposal_id IS NOT NULL
    AND v.official_id IS NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM _dirty_vote_keys) THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (
      'entity_connections_votes',
      jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
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
    jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes() TO service_role;

-- ── 4. rebuild_entity_connections_votes_full() — the bare NOW() ──────────────
--
-- Body is FIX-1136's (scoped DELETE, previous migration) with one line changed:
-- the watermark write is the horizon, not NOW(). A full pass reads the head
-- under exactly the same uncommitted-writer exposure as an incremental one —
-- the same argument FIX-983 made for donations_full.

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

  -- FIX-1139: the horizon, not NOW().
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_votes',
    jsonb_build_object('last_indexed_at', public.watermark_horizon()::text)
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

-- ── 5. Guard ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad text[];
BEGIN
  -- Neither votes arm may still write a bare NOW() into its watermark.
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('rebuild_entity_connections_votes', 'rebuild_entity_connections_votes_full')
    AND p.prosrc ~* 'last_indexed_at''\s*,\s*NOW\(\)';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[fix1139] votes arm(s) still stamp a bare NOW() watermark: %', v_bad;
  END IF;

  IF to_regprocedure('public.watermark_horizon()') IS NULL THEN
    RAISE EXCEPTION '[fix1139] public.watermark_horizon() missing';
  END IF;

  -- The wrapper must actually resolve to the same instant.
  IF abs(EXTRACT(epoch FROM (public.fr_watermark_horizon() - public.watermark_horizon()))) > 1 THEN
    RAISE EXCEPTION '[fix1139] fr_watermark_horizon() and watermark_horizon() disagree';
  END IF;

  RAISE NOTICE '[fix1139] votes watermarks clamp to the horizon; fr_watermark_horizon() is a wrapper';
END $$;
