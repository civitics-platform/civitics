-- scripts/fix1441-revert-ec-donations-incr-window.sql
-- FIX-1441 ROLLBACK (cc-308) — puts back rebuild_ec_donations_incr_window() as
-- it ran before 20261122000000_fix1441_ec_donations_incr_window_merge.sql: the
-- body of 20260819030000_fix1069_ec_incremental_donations_windowing.sql §3
-- VERBATIM (md5(prosrc) 2e70260b6f3cb1c0bfb913d4fce212a9, LOCAL at cc-308 read
-- 0; prod's is read by the push prompt), with no SET clause: the live
-- proconfig is NULL. Grants and comment as 20260819030000 states them.
--
-- It DROPS NOTHING. The edges are not reverted either: the next dirty window
-- under this body is a delete-all + insert of its donors, as before. It refuses
-- a live body that is neither FIX-1441's nor this one.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1441-revert-ec-donations-incr-window.sql
-- (prod: only under a supervised session, through the primary checkout).

DO $$
DECLARE
  v_d text;
BEGIN
  SELECT md5(prosrc) INTO v_d FROM pg_proc
   WHERE proname = 'rebuild_ec_donations_incr_window' AND pronamespace = 'public'::regnamespace;
  IF v_d IS DISTINCT FROM '419d941075843c7e0b8f3eab72b95e49' AND v_d IS DISTINCT FROM '2e70260b6f3cb1c0bfb913d4fce212a9' THEN
    RAISE EXCEPTION '[fix1441 revert] rebuild_ec_donations_incr_window md5 % is neither FIX-1441''s 419d941075843c7e0b8f3eab72b95e49 nor FIX-1069''s 2e70260b6f3cb1c0bfb913d4fce212a9',
      COALESCE(v_d, '(no function)');
  END IF;
END $$;

-- ── rebuild_ec_donations_incr_window() — 20260819030000 §3 ────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_window(
  p_idx    int,
  p_lo     uuid,
  p_hi     uuid,
  p_target timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  c_key   CONSTANT text := 'entity_connections_donations';
  v_count bigint := 0;
  v_opp   bigint := 0;
  v_since timestamptz;
  v_wins  jsonb;
  v_min   timestamptz;
BEGIN
  SELECT (value->'windows'->>p_idx::text)::timestamptz
    INTO v_since
    FROM public.pipeline_state
   WHERE key = c_key;

  -- Already level with this cycle's target => banked by an earlier firing.
  -- This is the intra-arm resume: re-entering the arm after a budget exit
  -- costs one cheap read per completed window, not a redo.
  IF v_since IS NOT NULL AND v_since >= p_target THEN
    RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', p_idx + 1;
    RETURN 0;
  END IF;

  -- ── Clear both derived classes for this window's dirty donors ──────────────
  -- Scoped by the dirty set AND by the from_id range: the range predicate is
  -- redundant given the join but lets the planner use
  -- entity_connections_from_id_connection_type (from_id, connection_type).
  DELETE FROM public.entity_connections ec
   USING public.ec_donations_incr_dirty d
   WHERE ec.connection_type IN ('donation', 'opposition')
     AND ec.from_type = d.from_type
     AND ec.from_id   = d.from_id
     AND d.from_id   >= p_lo
     AND (p_hi IS NULL OR d.from_id < p_hi);

  -- ── donation + ie_support -> 'donation' ────────────────────────────────────
  -- NOTE the aggregation is NOT filtered by updated_at: a dirty donor's edge is
  -- re-derived from their FULL history, which is what makes the window
  -- idempotent and the result identical to a single-pass run.
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN public.ec_donations_incr_dirty d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type IN ('donation', 'ie_support')
      AND d.from_id >= p_lo
      AND (p_hi IS NULL OR d.from_id < p_hi)
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

  -- ── ie_oppose -> 'opposition' (same dirty set, same window) ────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN public.ec_donations_incr_dirty d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type = 'ie_oppose'
      AND d.from_id >= p_lo
      AND (p_hi IS NULL OR d.from_id < p_hi)
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

  -- ── The ratchet: advance THIS window only, and recompute the scalar ────────
  -- `last_indexed_at` is kept as the MIN across the 16 windows so every existing
  -- reader keeps seeing a conservative, true "everything before this is fully
  -- indexed" — it does not move until the slowest window has caught up.
  UPDATE public.pipeline_state
     SET value = jsonb_set(value, ARRAY['windows', p_idx::text],
                           to_jsonb(p_target::text)),
         updated_at = now()
   WHERE key = c_key;

  SELECT min((e.value)::timestamptz) INTO v_min
    FROM public.pipeline_state ps,
         jsonb_each_text(ps.value->'windows') AS e(key, value)
   WHERE ps.key = c_key;

  UPDATE public.pipeline_state
     SET value = jsonb_set(value, ARRAY['last_indexed_at'], to_jsonb(v_min::text)),
         updated_at = now()
   WHERE key = c_key AND v_min IS NOT NULL;

  RETURN v_count + v_opp;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz) IS
  'FIX-1069 — rebuild donation + opposition edges for the DIRTY donors in '
  '[p_lo, p_hi), then advance window p_idx''s watermark to p_target as the last '
  'act of the same transaction. Self-contained and idempotent so the caller can '
  'COMMIT after each window; a cancelled window rolls back its watermark with '
  'its edges and is simply redone. Skips instantly when already at target.';

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE proname = 'rebuild_ec_donations_incr_window' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM '2e70260b6f3cb1c0bfb913d4fce212a9' THEN
    RAISE EXCEPTION '[fix1441 revert] read-back failed: md5 %, expected 2e70260b6f3cb1c0bfb913d4fce212a9', v_md5;
  END IF;
  RAISE NOTICE '[fix1441 revert] read-back ok: rebuild_ec_donations_incr_window %', v_md5;
END $$;
