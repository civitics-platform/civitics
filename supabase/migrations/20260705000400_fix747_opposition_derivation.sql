-- FIX-747 — derive ie_oppose financial_relationships → 'opposition' entity_connections
-- edges, alongside the existing donation+ie_support → 'donation' derivation.
--
-- ie_oppose (FEC Schedule E "O" — super-PAC independent expenditures AGAINST a
-- candidate) had no edge class: every EC donation rebuild aggregated
-- relationship_type IN ('donation','ie_support') → 'donation' and dropped
-- ie_oppose. This migration adds a PARALLEL path in all three donation-rebuild
-- variants that maps relationship_type = 'ie_oppose' → 'opposition' (the enum
-- value added in 20260705000300). Per-pair aggregation, no threshold, same
-- LEAST/LOG strength formula as donation — the only differences are the source
-- predicate (ie_oppose) and the target connection_type ('opposition').
--
-- CRITICAL (double-count guard): each variant's range/dirty-scoped DELETE that
-- currently clears connection_type = 'donation' MUST also clear 'opposition' for
-- the SAME scope. Otherwise opposition edges would either double on re-run
-- (window/incremental never remove the prior 'opposition' rows) or go stale.
-- Every DELETE below is widened to `connection_type IN ('donation','opposition')`.
--
-- ie_support is deliberately LEFT lumped into 'donation' — that is a pre-existing
-- product choice (a super-PAC spending FOR a candidate reads as support money in
-- the same lane as a direct donation). Splitting ie_support into its own class is
-- a separate future decision; FIX-747 only carves out the OPPOSING spend.
--
-- Three variants extended (same three donation paths):
--   1. rebuild_ec_donations_full_window(uuid,uuid)   — FIX-703 windowed full path
--                                                       (what pg_cron 'full' runs)
--   2. rebuild_entity_connections_donations_full()    — legacy monolith full
--                                                       (incremental's bootstrap delegate)
--   3. rebuild_entity_connections_donations()         — dirty-set incremental
--
-- ── FIX-735 lag invariant (documented here, the derivation's home) ────────────
-- entity_connections donation/opposition edges are rebuilt on a SCHEDULE (pg_cron
-- 'full' Monday, 'incremental' Wednesday; FIX-703/687). They therefore LAG the
-- ~1.5 days between the weekend FEC ingest and the next rebuild — an
-- individual→committee pair from the current weekend's ingest legitimately has NO
-- edge until Monday, then self-heals. This is NOT incompleteness: the FR-derived
-- aggregates (financial_entities.recipient_count / total_*_cents; FIX-702/726/736)
-- are recomputed FROM financial_relationships and are effectively real-time. So:
--   *** "no EC edge" NEVER means "no donation" — query financial_relationships   ***
--   *** for authoritative presence/counts; entity_connections is a display cache. ***
-- FIX-735 investigated the "edge gap" and closed it working-as-designed on exactly
-- this reasoning; FIX-736 already repointed recipient_count off EC onto FR because
-- an EC-based count under-counts during the lag window. Do not build another
-- EC-presence-implies-truth assumption.

-- ── 1. Windowed full path (FIX-703) — range-scoped, per-window COMMIT-safe ─────
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_full_window(
  p_lo uuid,
  p_hi uuid
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_count bigint;
  v_opp   bigint;
BEGIN
  -- FIX-703/FIX-747: range-scoped delete of BOTH derived classes so per-window
  -- COMMIT re-derivation never doubles ('opposition' added by FIX-747). Backed by
  -- entity_connections_from_id_connection_type (from_id, connection_type).
  DELETE FROM public.entity_connections ec
   WHERE ec.connection_type IN ('donation', 'opposition')
     AND ec.from_id >= p_lo
     AND (p_hi IS NULL OR ec.from_id < p_hi);

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

  -- FIX-747: ie_oppose → 'opposition' (parallel path; same aggregation shape)
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

  RETURN v_count + v_opp;
END;
$$;
-- Re-issue the per-function GUC (CREATE OR REPLACE resets proconfig).
ALTER FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid)
  SET statement_timeout = '45min';
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid) IS
  'FIX-588/FIX-703/FIX-747 — rebuild donation + opposition edges for from_id in '
  '[p_lo, p_hi) (p_hi NULL = to end). Range-scoped DELETE of BOTH connection_types '
  '(''donation'',''opposition'') then two INSERT aggregations (donation+ie_support '
  '→ donation, ie_oppose → opposition). Self-contained + idempotent so the caller '
  'can COMMIT after each window (FIX-703) without gap or double.';

-- ── 2. Legacy monolith full (incremental bootstrap delegate) ──────────────────
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations_full()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count BIGINT;
  v_opp   BIGINT;
BEGIN
  -- FIX-747: clear both derived classes (was 'donation' only).
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type IN ('donation', 'opposition');

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

  -- Advance watermark so the next incremental run picks up from NOW().
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', NOW()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'donation';   edges_upserted := v_count; RETURN NEXT;
  connection_type := 'opposition'; edges_upserted := v_opp;   RETURN NEXT;
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_donations_full()
  SET statement_timeout = '90min';
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations_full()
  TO service_role;

-- ── 3. Dirty-set incremental ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_count                BIGINT;
  v_opp                  BIGINT;
  v_last_indexed_at      TIMESTAMPTZ;
  v_new_max_updated_at   TIMESTAMPTZ;
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz
    INTO v_last_indexed_at
  FROM public.pipeline_state
  WHERE key = 'entity_connections_donations';

  IF v_last_indexed_at IS NULL THEN
    -- Bootstrap: delegate to _full(), which sets the watermark itself and now
    -- returns BOTH ('donation', …) and ('opposition', …) rows (FIX-747).
    RETURN QUERY SELECT * FROM public.rebuild_entity_connections_donations_full();
    RETURN;
  END IF;

  -- FIX-747: the dirty set now spans ie_oppose too, so a weekend of opposition
  -- spend dirties its donor and gets re-derived on the next incremental.
  CREATE TEMP TABLE _dirty_from_ids ON COMMIT DROP AS
  SELECT DISTINCT fr.from_type, fr.from_id
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND fr.updated_at > v_last_indexed_at;

  SELECT MAX(fr.updated_at) INTO v_new_max_updated_at
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

  -- No-op short-circuit when nothing changed.
  IF NOT EXISTS (SELECT 1 FROM _dirty_from_ids) THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (
      'entity_connections_donations',
      jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, NOW())::text)
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();

    connection_type := 'donation';   edges_upserted := 0; RETURN NEXT;
    connection_type := 'opposition'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  -- FIX-747: clear both derived classes for the dirty donors (was 'donation' only).
  DELETE FROM public.entity_connections ec
  USING _dirty_from_ids d
  WHERE ec.connection_type IN ('donation', 'opposition')
    AND ec.from_type = d.from_type
    AND ec.from_id = d.from_id;

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

  -- FIX-747: ie_oppose → 'opposition' (same dirty set)
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

  -- Advance watermark.
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, NOW())::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'donation';   edges_upserted := v_count; RETURN NEXT;
  connection_type := 'opposition'; edges_upserted := v_opp;   RETURN NEXT;
  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections_donations()
  SET statement_timeout = '45min';
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations()
  TO service_role;

-- ── FIX-735 close-out: document the lag invariant on the rebuild procedure ────
-- No procedure redefinition — just re-issue the COMMENT with the invariant so a
-- future reader sees it at the source of truth for the schedule.
COMMENT ON PROCEDURE public.run_entity_connections_rebuild(text) IS
  'FIX-687/FIX-703/FIX-747 — pg_cron entity_connections rebuild. Session '
  'advisory-lock guard, per-window/per-chunk COMMIT (external/investigation last), '
  'data_sync_log observability, donor-rollup MV refresh (full). Full-donations '
  'chunk COMMITs after EACH window with range-scoped delete+insert covering BOTH '
  'derived classes donation + opposition (FIX-747). CALL with ''full'' (Mon) or '
  '''incremental'' (Wed). FIX-735 INVARIANT: donation/opposition edges lag to the '
  'NEXT scheduled rebuild — "no EC edge" NEVER means "no donation"; the FR-derived '
  'aggregates (recipient_count / total_*_cents, FIX-736) are real-time. Query '
  'financial_relationships for authoritative presence; entity_connections is a '
  'display cache.';

NOTIFY pgrst, 'reload schema';
