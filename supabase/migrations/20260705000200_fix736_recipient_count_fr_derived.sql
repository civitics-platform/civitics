-- FIX-736 — derive recipient_count from financial_relationships, not
-- entity_connections.
--
-- recipient_count (per individual donor: COUNT of distinct recipients they have
-- donated to) was EC-DERIVED — maintained from entity_connections donation edges
-- by the incremental donations rebuild (round3 step 5, 20260525000000) and the
-- full rebuild (round3 block 1b). But entity_connections is INCOMPLETE for
-- individual→committee donation edges (FIX-735): "no edge" ≠ "no donation". That
-- made recipient_count under-count, and made the EC-based orphan sweep (the
-- reverted FIX-734 zero-out, 20260705000100) UNSOUND — it zeroed ~124k donors who
-- had real donation FR to committees the graph simply has no edge for.
--
-- Post-incident, prod recipient_count was recomputed FR-authoritatively
-- (COUNT(DISTINCT to_id) over each individual's donation financial_relationships —
-- the complete source): 1,960,472 individuals positive, ZERO rc>0-but-no-FR rows.
-- This migration repoints ONGOING MAINTENANCE to FR so the snapshot does not
-- re-drift on the next EC incremental — exactly the FIX-702/726 treatment for
-- total_donated_cents. recipient_count is per from_id (donor), the SAME dirty set
-- and SAME source as total_donated_cents, so it folds into the totals incremental.
--
--   Decision 1  FR-derived recipient_count = COUNT(DISTINCT to_id) of donation FR
--               per from_id (entity_type='individual'). Folded into the totals
--               incremental (refresh_financial_entity_totals_incremental): same
--               dirty from_id set, same FR watermark, same chunked-committed pass.
--   Decision 2  Remove the EC-based recipient_count UPDATE from BOTH round3
--               donation rebuilds — the EC rebuild is now edges-only.
--   Decision 3  FR-based orphan sweep folded into the monthly reconcile
--               (reconcile_financial_entity_totals): zero recipient_count only for
--               individuals with count>0 AND no donation FR from-side — a single
--               anti-join, SOUND because FR is complete (unlike EC).
--   Decision 4  Re-enable the monthly reconcile (financial-entity-totals-reconcile
--               now owns the FR recipient_count sweep). Retire the EC-based
--               ec-recipient-count-reconcile job; reconcile_recipient_count() is
--               repurposed as an FR-based break-glass full recompute.
--
-- Predicate parity: the FR recipient_count aggregate uses the SAME donation
-- predicate as total_donated_cents (from_type='financial_entity',
-- relationship_type='donation'), only COUNT(DISTINCT to_id) instead of
-- SUM(amount_cents) — matching the prod FR-authoritative recompute (donation-only,
-- no to_type filter). Index support: financial_relationships_donation_size_rollup
-- ((from_id) WHERE from_type='financial_entity' AND relationship_type='donation')
-- seeks the dirty from_ids; to_id comes from the heap (the dirty set is bounded —
-- donations only change on the Sunday FEC ingest). Outer of the orphan sweep rides
-- financial_entities_recipient_count_idx (partial WHERE entity_type='individual').
--
-- Hard-delete blind spot (same acknowledged FIX-372/704/734 limitation): a donor
-- whose donation FR rows are all hard-deleted carries no surviving updated_at, so
-- it never dirties — the monthly Sweep C is its catch-all.

-- ── 1. Window helper (full pass — bootstrap + break-glass) ────────────────────
-- Two-pass (bump to live FR count + zero orphans), range-scoped, NO COMMIT (the
-- caller owns the txn / COMMIT between windows). Mirrors
-- financial_entity_donation_totals_window: the zero pass drives from
-- financial_entities so an individual whose donation FR was all hard-deleted gets
-- zeroed. Returns rows written across both passes.
CREATE OR REPLACE FUNCTION public.financial_entity_recipient_count_window(
  p_lo uuid, p_hi uuid
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bump bigint;
  v_zero bigint;
BEGIN
  -- Pass 1 — bump: set each in-window individual donor's recipient_count to its
  -- live COUNT(DISTINCT to_id) over donation FR.
  UPDATE public.financial_entities fe
  SET recipient_count = agg.cnt
  FROM (
    SELECT fr.from_id, COUNT(DISTINCT fr.to_id)::smallint AS cnt
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.from_id >= p_lo
      AND (p_hi IS NULL OR fr.from_id < p_hi)
    GROUP BY fr.from_id
  ) agg
  WHERE fe.id = agg.from_id
    AND fe.entity_type = 'individual'
    AND fe.recipient_count IS DISTINCT FROM agg.cnt;
  GET DIAGNOSTICS v_bump = ROW_COUNT;

  -- Pass 2 — zero: any in-window individual carrying a positive recipient_count
  -- but no surviving donation FR from-side (all rows hard-deleted). SOUND because
  -- FR is complete (the EC-based version of this was the reverted FIX-734 bug).
  UPDATE public.financial_entities fe
  SET recipient_count = 0
  WHERE fe.id >= p_lo
    AND (p_hi IS NULL OR fe.id < p_hi)
    AND fe.entity_type = 'individual'
    AND fe.recipient_count > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.from_type = 'financial_entity'
        AND fr.relationship_type = 'donation'
        AND fr.from_id = fe.id
    );
  GET DIAGNOSTICS v_zero = ROW_COUNT;

  RETURN v_bump + v_zero;
END;
$$;
GRANT EXECUTE ON FUNCTION public.financial_entity_recipient_count_window(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.financial_entity_recipient_count_window(uuid, uuid) IS
  'FIX-736 — window-scoped (from_id [lo,hi)) two-pass recompute of '
  'financial_entities.recipient_count for individual donors from '
  'financial_relationships (bump to live COUNT(DISTINCT to_id) of donation FR + '
  'zero orphans). FR-derived (complete), not EC-derived (incomplete; FIX-735). No '
  'COMMIT — the bootstrap/reconcile procedure commits per window.';

-- ── 2. Array helper (incremental — dirty chunks) ─────────────────────────────
-- Single BUMP pass over an explicit from_id array. NO zero pass: a from_id only
-- enters the dirty set via a live donation FR row, so its live count is > 0
-- (nothing to zero). Mirrors financial_entity_donation_totals_rebuild. NO COMMIT.
CREATE OR REPLACE FUNCTION public.financial_entity_recipient_count_rebuild(
  p_ids uuid[]
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  UPDATE public.financial_entities fe
  SET recipient_count = agg.cnt
  FROM (
    SELECT fr.from_id, COUNT(DISTINCT fr.to_id)::smallint AS cnt
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.from_id = ANY (p_ids)
    GROUP BY fr.from_id
  ) agg
  WHERE fe.id = agg.from_id
    AND fe.entity_type = 'individual'
    AND fe.recipient_count IS DISTINCT FROM agg.cnt;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.financial_entity_recipient_count_rebuild(uuid[]) TO service_role;

COMMENT ON FUNCTION public.financial_entity_recipient_count_rebuild(uuid[]) IS
  'FIX-736 — recompute recipient_count for a dirty set of individual donor ids '
  '(COUNT(DISTINCT to_id) of donation FR per id). Bump only. No COMMIT — the '
  'incremental procedure commits per chunk.';

-- ── 3. Fold recipient_count into the totals incremental (Decision 1) ──────────
-- Byte-identical to refresh_financial_entity_totals_incremental (FIX-702/726,
-- 20260704000000) EXCEPT: recipient_count is recomputed alongside
-- total_donated_cents — same dirty from_id set, same watermark, same chunk COMMIT.
--   * bootstrap loop  → financial_entity_recipient_count_window(lo, hi)
--   * incremental loop→ financial_entity_recipient_count_rebuild(dirty chunk), in
--     the SAME BEGIN block as the donation-totals rebuild (a failure of either
--     fails that chunk together; watermark not advanced → retried next run).
CREATE OR REPLACE PROCEDURE public.refresh_financial_entity_totals_incremental()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key  bigint := hashtext('financial_entity_totals_refresh')::bigint;
  c_chunk     int    := 500;
  c_bounds    uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id    uuid;
  v_watermark timestamptz;
  v_new_max   timestamptz;
  v_dirty_from uuid[];
  v_dirty_to   uuid[];
  v_chunk     uuid[];
  v_n_from    int;
  v_n_to      int;
  v_i         int;
  v_lo        uuid;
  v_hi        uuid;
  v_rows      bigint := 0;
  v_rc        bigint := 0;   -- FIX-736: recipient_count rows written
  v_n         bigint;
  v_failures  text[] := ARRAY[]::text[];
  v_mode      text;
  i           int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent financial-entity-totals refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[fe-totals] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'financial_entity_totals_watermark';

  -- Capture the new watermark BEFORE building the dirty set so FR writes that
  -- land mid-refresh are re-processed next run, never silently consumed.
  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  v_mode := CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END;

  IF v_watermark IS NOT NULL THEN
    SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty_from
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type = 'financial_entity'
      AND fr.updated_at > v_watermark;

    SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty_to
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type = 'financial_entity'
      AND fr.updated_at > v_watermark;
  END IF;

  v_n_from := COALESCE(array_length(v_dirty_from, 1), 0);
  v_n_to   := COALESCE(array_length(v_dirty_to, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_refresh', 'running', now(),
          jsonb_build_object('mode', v_mode,
                             'dirty_donors', v_n_from,
                             'dirty_recipients', v_n_to,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_watermark IS NULL THEN
    -- Bootstrap: 16-window full pass over both totals sides + recipient_count.
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_rows := v_rows + public.financial_entity_donation_totals_window(v_lo, v_hi);
        v_rows := v_rows + public.financial_entity_received_totals_window(v_lo, v_hi);
        v_rc   := v_rc   + public.financial_entity_recipient_count_window(v_lo, v_hi);  -- FIX-736
        RAISE NOTICE '  [fe-totals] bootstrap window %/16 — % totals rows, % rc rows so far', i, v_rows, v_rc;
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level (outside the EXCEPTION subtransaction)
    END LOOP;
  ELSE
    -- Incremental: chunk the dirty donor set (totals + recipient_count together),
    -- then the dirty recipient set (received totals).
    v_i := 1;
    WHILE v_i <= v_n_from LOOP
      v_chunk := v_dirty_from[v_i : LEAST(v_i + c_chunk - 1, v_n_from)];
      BEGIN
        v_n := public.financial_entity_donation_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
        v_n := public.financial_entity_recipient_count_rebuild(v_chunk);  -- FIX-736
        v_rc := v_rc + v_n;
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      v_i := v_i + c_chunk;
    END LOOP;

    v_i := 1;
    WHILE v_i <= v_n_to LOOP
      v_chunk := v_dirty_to[v_i : LEAST(v_i + c_chunk - 1, v_n_to)];
      BEGIN
        v_n := public.financial_entity_received_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      v_i := v_i + c_chunk;
    END LOOP;
  END IF;

  -- Advance the watermark only on a clean run — a failed chunk/window's keys
  -- must stay in the next run's dirty set.
  IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('financial_entity_totals_watermark',
            jsonb_build_object('last_indexed_at', COALESCE(v_new_max, NOW())::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_rows + v_rc,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'rows_updated', v_rows,
                        'recipient_count_updated', v_rc,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals] % (mode=%) — % totals rows, % recipient_count rows (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_mode, v_rows, v_rc, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_financial_entity_totals_incremental() TO service_role;

COMMENT ON PROCEDURE public.refresh_financial_entity_totals_incremental() IS
  'FIX-702/726/736 — chunked, committed, watermark-driven refresh of '
  'financial_entities.total_donated_cents (dirty from_id) + total_received_cents '
  '(dirty to_id) + recipient_count (dirty individual from_id, FIX-736 — '
  'COUNT(DISTINCT to_id) of donation FR), all aggregating financial_relationships '
  'directly. NULL watermark → 16-window bootstrap (all three). Watermark = '
  'pipeline_state.financial_entity_totals_watermark on FR.updated_at. Weekly '
  'pg_cron; the monthly reconcile is the hard-delete sweep.';

-- ── 4. EC rebuild is now edges-only — drop recipient_count writes (Decision 2) ─
-- Both round3 (20260525000000) donation rebuilds wrote recipient_count from the
-- entity_connections aggregate. recipient_count is now owned entirely by the FR
-- path (§3 + §5), so remove those UPDATEs. Bodies are otherwise byte-identical to
-- round3 (the CURRENT/latest definition). CREATE OR REPLACE FUNCTION resets
-- per-function GUCs, so the statement_timeout ALTERs are re-issued below.

-- 4a. Full rebuild — drop block 1b (the recipient_count recompute-all).
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

  -- FIX-736: block 1b (EC-based recipient_count recompute-all) REMOVED —
  -- recipient_count is FR-derived, owned by the totals incremental. EC donation
  -- edges are incomplete for individual→committee (FIX-735), so an EC-based count
  -- under-counts; this rebuild stays edges-only.

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

-- 4b. Incremental rebuild — drop step 5 (the dirty-scoped recipient_count UPDATE).
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

  -- FIX-736: step 5 (EC-based dirty-scoped recipient_count UPDATE) REMOVED —
  -- recipient_count is FR-derived, maintained by the totals incremental over the
  -- same dirty from_id set. This rebuild stays edges-only.

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

-- ── 5. Fold the FR recipient_count orphan sweep into the monthly reconcile ────
-- (Decision 3) Byte-identical to reconcile_financial_entity_totals (FIX-734,
-- 20260705000000) PLUS Sweep C: zero recipient_count for individuals with count>0
-- and no surviving donation FR from-side. Same single anti-join as Sweep A, SOUND
-- because FR is complete (the EC-based version was the reverted FIX-734 bug). NO
-- watermark advance (the weekly incremental owns it).
CREATE OR REPLACE PROCEDURE public.reconcile_financial_entity_totals()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_financial_entity_totals')::bigint;
  v_log_id   uuid;
  v_donated  bigint := 0;
  v_received bigint := 0;
  v_reccount bigint := 0;   -- FIX-736: recipient_count orphans zeroed
  v_failures text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[fe-totals-reconcile] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Keep the anti-join hash builds in memory (single batch).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_reconcile', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep each sweep its own short txn

  -- Sweep A — donated orphans: a donor carrying a positive total_donated_cents
  -- but with no surviving donation FR from-side (all rows hard-deleted).
  BEGIN
    UPDATE public.financial_entities fe
    SET total_donated_cents = 0
    WHERE fe.total_donated_cents > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_relationships fr
        WHERE fr.from_type = 'financial_entity'
          AND fr.relationship_type = 'donation'
          AND fr.from_id = fe.id
      );
    GET DIAGNOSTICS v_donated = ROW_COUNT;
    RAISE NOTICE '  [fe-totals-reconcile] donated orphans zeroed: %', v_donated;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('donated sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] donated sweep FAILED: %', SQLERRM;
  END;
  COMMIT;

  -- Sweep B — received orphans: a recipient carrying a positive
  -- total_received_cents but no surviving inbound donation FR.
  BEGIN
    UPDATE public.financial_entities fe
    SET total_received_cents = 0
    WHERE fe.total_received_cents > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_relationships fr
        WHERE fr.to_type = 'financial_entity'
          AND fr.from_type = 'financial_entity'
          AND fr.relationship_type = 'donation'
          AND fr.to_id = fe.id
      );
    GET DIAGNOSTICS v_received = ROW_COUNT;
    RAISE NOTICE '  [fe-totals-reconcile] received orphans zeroed: %', v_received;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('received sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] received sweep FAILED: %', SQLERRM;
  END;
  COMMIT;

  -- Sweep C (FIX-736) — recipient_count orphans: an individual carrying a
  -- positive recipient_count but no surviving donation FR from-side. SOUND (FR is
  -- complete) — this replaces the reverted, UNSOUND EC-based sweep. Outer driven
  -- by financial_entities_recipient_count_idx (partial WHERE entity_type=
  -- 'individual'); anti-join FR side rides financial_relationships_donation_size_rollup.
  BEGIN
    UPDATE public.financial_entities fe
    SET recipient_count = 0
    WHERE fe.entity_type = 'individual'
      AND fe.recipient_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_relationships fr
        WHERE fr.from_type = 'financial_entity'
          AND fr.relationship_type = 'donation'
          AND fr.from_id = fe.id
      );
    GET DIAGNOSTICS v_reccount = ROW_COUNT;
    RAISE NOTICE '  [fe-totals-reconcile] recipient_count orphans zeroed: %', v_reccount;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('recipient_count sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] recipient_count sweep FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_donated + v_received + v_reccount,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'donated_orphans_zeroed', v_donated,
                        'received_orphans_zeroed', v_received,
                        'recipient_count_orphans_zeroed', v_reccount,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals-reconcile] % — donated=% received=% recipient_count=% zeroed (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_donated, v_received, v_reccount, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_financial_entity_totals() TO service_role;

COMMENT ON PROCEDURE public.reconcile_financial_entity_totals() IS
  'FIX-702/726/734/736 — monthly hard-delete ORPHAN SWEEP for '
  'financial_entities.total_donated_cents + total_received_cents + recipient_count '
  '(FIX-736: individuals with count>0 but no donation FR from-side — SOUND because '
  'FR is complete, unlike the reverted EC-based sweep). Three single set-based '
  'anti-joins; the weekly refresh_financial_entity_totals_incremental keeps live '
  'values current. Does NOT advance the watermark (the weekly owns it).';

-- ── 6. reconcile_recipient_count() → FR-based break-glass full recompute ──────
-- (Decision 4) The EC-based bump reconcile is retired — EC donation edges are
-- incomplete (FIX-735), so an EC bump under-counts. Repurpose the name as an
-- FR-based break-glass full recompute (16-window bump+zero via the FR window fn).
-- Its cron job (ec-recipient-count-reconcile) is unscheduled below — the routine
-- FR orphan sweep is now owned by financial-entity-totals-reconcile (§5).
CREATE OR REPLACE PROCEDURE public.reconcile_recipient_count()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_recipient_count')::bigint;
  c_bounds   uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo       uuid;
  v_hi       uuid;
  v_total    bigint := 0;
  v_n        bigint;
  v_failures text[] := ARRAY[]::text[];
  i          int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[reconcile-rc] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  FOR i IN 1..16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    BEGIN
      -- FR-derived two-pass (bump to live COUNT(DISTINCT to_id) + zero orphans).
      v_n := public.financial_entity_recipient_count_window(v_lo, v_hi);
      v_total := v_total + v_n;
      RAISE NOTICE '  [reconcile-rc] window %/16 — % rows', i, v_n;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [reconcile-rc] window %/16 FAILED: %', i, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, rows_failed, error_message, metadata)
  VALUES ('recipient_count_reconcile',
          CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
          now(), now(), v_total,
          COALESCE(array_length(v_failures, 1), 0),
          CASE WHEN array_length(v_failures, 1) > 0
               THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
          jsonb_build_object('source', 'manual', 'kind', 'fr-full-recompute'));

  RAISE NOTICE '[reconcile-rc] % — recipient_count recomputed, % rows (% window failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_total, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_recipient_count() TO service_role;

COMMENT ON PROCEDURE public.reconcile_recipient_count() IS
  'FIX-736 — BREAK-GLASS FR-based full recompute of financial_entities.recipient_count '
  'for individual donors (16 from_id windows, COMMIT each; two-pass bump to live '
  'COUNT(DISTINCT to_id) of donation FR + zero orphans). Replaces the retired '
  'EC-based bump reconcile (EC donation edges are incomplete for individual→'
  'committee; FIX-735). Not scheduled — routine maintenance is the weekly totals '
  'incremental (§3) + the monthly financial-entity-totals-reconcile FR sweep (§5).';

-- ── 7. cron: enable the FR reconcile, retire the EC recipient_count job ───────
-- (Decision 4) financial-entity-totals-reconcile now owns the FR recipient_count
-- orphan sweep (Sweep C) — enable it (idempotent; already enabled live on prod
-- during the 2026-07-05 supervised run). ec-recipient-count-reconcile is retired:
-- recipient_count is no longer EC-owned.
SELECT cron.alter_job(job_id := jobid, active := true)
  FROM cron.job WHERE jobname = 'financial-entity-totals-reconcile';

SELECT cron.unschedule(jobname)
  FROM cron.job WHERE jobname = 'ec-recipient-count-reconcile';

NOTIFY pgrst, 'reload schema';
