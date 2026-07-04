-- FIX-702 + FIX-726 — incremental, dirty-scoped financial_entity totals.
--
-- Two coupled problems, one disease — a full recompute of a huge aggregate on
-- Pro Small, all at once, in the FEC pipeline's critical path:
--
--   FIX-702  rebuild_financial_entity_donation_totals() (total_donated_cents,
--            the from_id / donor-outbound side) ran >90 min → chronically stale.
--   FIX-726  the full donation + received totals rebuilds saturated Pro Small
--            during the FIX-701 re-capture → live-site RPC timeouts. The interim
--            fix was a targeted index-scoped UPDATE; this makes that the durable
--            path.
--
-- Cure = the FIX-372/373/704 pattern: watermark → dirty set → recompute only the
-- changed keys (aggregating the WHOLE key, not just the changed rows) → advance
-- watermark, chunked with per-chunk COMMIT (FIX-703 discipline) + bounded
-- work_mem so no transaction and no aggregation ever holds the whole set. Both
-- totals aggregate financial_relationships directly, so they are decoupled from
-- the entity_connections edge rebuild and get their OWN pg_cron jobs.
--
--   total_donated_cents  per from_id (donor)     — dirty = DISTINCT from_id of
--                                                   changed donation FR rows.
--   total_received_cents per to_id  (recipient)  — dirty = DISTINCT to_id  of
--                                                   the same changed rows.
--
-- Shared watermark (financial_entity_totals_watermark) on
-- financial_relationships.updated_at — both totals derive from the same donation
-- FR changes. Substrate (set_updated_at trigger + btree(updated_at)) already
-- exists from FIX-372/373 (20260525000000); updated_at DEFAULT now() catches new
-- INSERTs, the BEFORE UPDATE trigger catches ON CONFLICT DO UPDATE upserts.
--
-- Index support (already present — verified 2026-07-04):
--   donation side  financial_relationships_donation_size_rollup (from_id)
--                  INCLUDE (amount_cents) WHERE from_type='financial_entity'
--                  AND relationship_type='donation'  → index-only donor SUM.
--   received side  financial_relationships_donor_rollup_idx
--                  (to_id, relationship_type, from_id) INCLUDE (amount_cents)
--                  WHERE from_type='financial_entity' AND relationship_type IN
--                  ('donation','ie_support','ie_oppose')  → index-only recipient
--                  SUM. Every donation→financial_entity row is from_type=
--                  'financial_entity' (the only donation/*/financial_entity
--                  bucket), so adding from_type='financial_entity' to the
--                  received aggregation is a semantic no-op that lets the planner
--                  use this partial index (parity holds — proven by the fixture
--                  parity test in supabase/tests/verify_fix702_726.sql).
--
-- Known limitation (same as FIX-372 / FIX-704): the dirty set comes from
-- FR.updated_at, so a HARD-DELETEd FR row does not dirty its from_id/to_id —
-- that entity's total stays stale until the monthly full-reconcile touches it.
-- reconcile_financial_entity_totals() is that sweep (drives from ALL entities,
-- zero-out anti-join included) + doubles as the bootstrap (NULL watermark).
--
-- The old temp-table full-rebuild functions
-- (rebuild_financial_entity_donation_totals / _received_totals, migrations
-- 20260513010000 / 20260627000800) are LEFT IN PLACE as break-glass full
-- rebuilds; only their calls are removed from the FEC pipeline (fec-bulk phase).

-- ── 16 hex-prefix id-window bounds (shared by the window helpers + reconcile) ──
-- Same convention as FIX-704's reconcile_recipient_count / run_entity_connections
-- _rebuild: a half-open [lo, hi) range per window over the uuid keyspace.

-- ── 1. Window helpers (full pass — bootstrap + monthly reconcile) ─────────────
-- Two-pass (bump + zero-orphan), range-scoped, NO COMMIT (callers own the txn /
-- COMMIT between windows). Byte-for-byte the same two-pass semantics as the
-- original rebuild_financial_entity_donation_totals(), just scoped to a from_id/
-- to_id window so it never holds the whole 5M-row aggregate. Drives the zero pass
-- from financial_entities so an entity whose FR rows were all hard-deleted (the
-- FIX-705 blind spot) gets zeroed. Returns rows written across both passes.

CREATE OR REPLACE FUNCTION public.financial_entity_donation_totals_window(
  p_lo uuid, p_hi uuid
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bump bigint;
  v_zero bigint;
BEGIN
  -- Pass 1 — bump: set each in-window donor's total to its live donation SUM.
  UPDATE public.financial_entities fe
  SET total_donated_cents = agg.total
  FROM (
    SELECT fr.from_id, SUM(fr.amount_cents)::bigint AS total
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.from_id >= p_lo
      AND (p_hi IS NULL OR fr.from_id < p_hi)
    GROUP BY fr.from_id
  ) agg
  WHERE fe.id = agg.from_id
    AND fe.total_donated_cents IS DISTINCT FROM agg.total;
  GET DIAGNOSTICS v_bump = ROW_COUNT;

  -- Pass 2 — zero: any in-window entity carrying a positive total but no longer
  -- backed by a donation FR row (all rows hard-deleted → not in the dirty set).
  UPDATE public.financial_entities fe
  SET total_donated_cents = 0
  WHERE fe.id >= p_lo
    AND (p_hi IS NULL OR fe.id < p_hi)
    AND fe.total_donated_cents > 0
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
GRANT EXECUTE ON FUNCTION public.financial_entity_donation_totals_window(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.financial_entity_donation_totals_window(uuid, uuid) IS
  'FIX-702/726 — window-scoped (from_id [lo,hi)) two-pass recompute of '
  'financial_entities.total_donated_cents (bump to live donation SUM + zero '
  'orphans). No COMMIT — the reconcile procedure commits per window.';

CREATE OR REPLACE FUNCTION public.financial_entity_received_totals_window(
  p_lo uuid, p_hi uuid
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bump bigint;
  v_zero bigint;
BEGIN
  -- Pass 1 — bump: set each in-window recipient's total to its live inbound-
  -- donation SUM. from_type='financial_entity' is a semantic no-op (see header)
  -- that pins the index-only scan on financial_relationships_donor_rollup_idx.
  UPDATE public.financial_entities fe
  SET total_received_cents = agg.total
  FROM (
    SELECT fr.to_id, SUM(fr.amount_cents)::bigint AS total
    FROM public.financial_relationships fr
    WHERE fr.to_type = 'financial_entity'
      AND fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.to_id >= p_lo
      AND (p_hi IS NULL OR fr.to_id < p_hi)
    GROUP BY fr.to_id
  ) agg
  WHERE fe.id = agg.to_id
    AND fe.total_received_cents IS DISTINCT FROM agg.total;
  GET DIAGNOSTICS v_bump = ROW_COUNT;

  -- Pass 2 — zero orphans.
  UPDATE public.financial_entities fe
  SET total_received_cents = 0
  WHERE fe.id >= p_lo
    AND (p_hi IS NULL OR fe.id < p_hi)
    AND fe.total_received_cents > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.to_type = 'financial_entity'
        AND fr.from_type = 'financial_entity'
        AND fr.relationship_type = 'donation'
        AND fr.to_id = fe.id
    );
  GET DIAGNOSTICS v_zero = ROW_COUNT;

  RETURN v_bump + v_zero;
END;
$$;
GRANT EXECUTE ON FUNCTION public.financial_entity_received_totals_window(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.financial_entity_received_totals_window(uuid, uuid) IS
  'FIX-702/726 — window-scoped (to_id [lo,hi)) two-pass recompute of '
  'financial_entities.total_received_cents (bump to live inbound-donation SUM + '
  'zero orphans). No COMMIT — the reconcile procedure commits per window.';

-- ── 2. Array helpers (incremental — dirty chunks) ────────────────────────────
-- Single bump pass over an explicit id array. NO zero pass: a from_id/to_id only
-- enters the dirty set via a live FR row (donations are positive), so its live
-- SUM is always > 0 — nothing to zero. (An entity whose rows were ALL deleted
-- carries no surviving updated_at, so it never dirties; the monthly reconcile is
-- its only sweep — the acknowledged FIX-372/704 hard-delete limitation.) Pulls
-- the WHOLE key (all of each id's FR rows), not just the changed ones. No COMMIT.

CREATE OR REPLACE FUNCTION public.financial_entity_donation_totals_rebuild(
  p_ids uuid[]
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  UPDATE public.financial_entities fe
  SET total_donated_cents = agg.total
  FROM (
    SELECT fr.from_id, SUM(fr.amount_cents)::bigint AS total
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.from_id = ANY (p_ids)
    GROUP BY fr.from_id
  ) agg
  WHERE fe.id = agg.from_id
    AND fe.total_donated_cents IS DISTINCT FROM agg.total;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.financial_entity_donation_totals_rebuild(uuid[]) TO service_role;

COMMENT ON FUNCTION public.financial_entity_donation_totals_rebuild(uuid[]) IS
  'FIX-702/726 — recompute total_donated_cents for a dirty set of donor ids '
  '(full SUM per id). No COMMIT — the incremental procedure commits per chunk.';

CREATE OR REPLACE FUNCTION public.financial_entity_received_totals_rebuild(
  p_ids uuid[]
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  UPDATE public.financial_entities fe
  SET total_received_cents = agg.total
  FROM (
    SELECT fr.to_id, SUM(fr.amount_cents)::bigint AS total
    FROM public.financial_relationships fr
    WHERE fr.to_type = 'financial_entity'
      AND fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.to_id = ANY (p_ids)
    GROUP BY fr.to_id
  ) agg
  WHERE fe.id = agg.to_id
    AND fe.total_received_cents IS DISTINCT FROM agg.total;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.financial_entity_received_totals_rebuild(uuid[]) TO service_role;

COMMENT ON FUNCTION public.financial_entity_received_totals_rebuild(uuid[]) IS
  'FIX-702/726 — recompute total_received_cents for a dirty set of recipient ids '
  '(full SUM per id). No COMMIT — the incremental procedure commits per chunk.';

-- ── 3. Incremental refresh PROCEDURE (weekly pg_cron entry point) ────────────
-- NULL watermark → bootstrap over ALL entities via the 16-window loop (catches
-- the FIX-675 committee-received staleness + any orphan zero-out). Otherwise a
-- dirty-set chunk loop on both sides. Per-chunk / per-window COMMIT bounds txn
-- size; work_mem bounded; watermark advanced only on a clean run so a failed
-- chunk's keys retry next run. NOTE (FIX-703): the CALL's statement_timeout is
-- the postgres role default (6h) armed at CALL start — nothing here re-arms it.

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
    -- Bootstrap: 16-window full pass over both sides (drives from all entities,
    -- so committee-received staleness + orphan zero-out are caught).
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_rows := v_rows + public.financial_entity_donation_totals_window(v_lo, v_hi);
        v_rows := v_rows + public.financial_entity_received_totals_window(v_lo, v_hi);
        RAISE NOTICE '  [fe-totals] bootstrap window %/16 — % rows so far', i, v_rows;
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level (outside the EXCEPTION subtransaction)
    END LOOP;
  ELSE
    -- Incremental: chunk the dirty donor set, then the dirty recipient set.
    v_i := 1;
    WHILE v_i <= v_n_from LOOP
      v_chunk := v_dirty_from[v_i : LEAST(v_i + c_chunk - 1, v_n_from)];
      BEGIN
        v_n := public.financial_entity_donation_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
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
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'rows_updated', v_rows,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals] % (mode=%) — % rows updated (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_mode, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_financial_entity_totals_incremental() TO service_role;

COMMENT ON PROCEDURE public.refresh_financial_entity_totals_incremental() IS
  'FIX-702/726 — chunked, committed, watermark-driven refresh of '
  'financial_entities.total_donated_cents (dirty from_id) + total_received_cents '
  '(dirty to_id), aggregating financial_relationships directly. NULL watermark → '
  '16-window bootstrap (both sides). Watermark = '
  'pipeline_state.financial_entity_totals_watermark on FR.updated_at. Runtime '
  'budget = postgres role default (6h) armed at CALL start (FIX-703). Weekly '
  'pg_cron; the monthly reconcile is the hard-delete sweep.';

-- ── 4. Full-reconcile PROCEDURE (monthly — hard-delete sweep) ────────────────
-- 16-window full pass over both sides (drives from ALL entities → zeros orphans
-- the watermark can't see; FIX-705 lesson). Advances the watermark on a clean
-- run so the weekly incremental resumes from a fresh baseline.

CREATE OR REPLACE PROCEDURE public.reconcile_financial_entity_totals()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_financial_entity_totals')::bigint;
  c_bounds   uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id   uuid;
  v_new_max  timestamptz;
  v_lo       uuid;
  v_hi       uuid;
  v_rows     bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  i          int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[fe-totals-reconcile] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_reconcile', 'running', now(),
          jsonb_build_object('source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR i IN 1..16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    BEGIN
      v_rows := v_rows + public.financial_entity_donation_totals_window(v_lo, v_hi);
      v_rows := v_rows + public.financial_entity_received_totals_window(v_lo, v_hi);
      RAISE NOTICE '  [fe-totals-reconcile] window %/16 — % rows so far', i, v_rows;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] window %/16 FAILED: %', i, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  END LOOP;

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
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'rows_updated', v_rows,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals-reconcile] % — % rows updated (% window failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_financial_entity_totals() TO service_role;

COMMENT ON PROCEDURE public.reconcile_financial_entity_totals() IS
  'FIX-702/726 — monthly chunked (16 id-windows, COMMIT each) full recompute of '
  'financial_entities.total_donated_cents + total_received_cents. Drives from ALL '
  'entities so hard-deleted-FR orphans (FIX-705 blind spot) are zeroed. Also the '
  'bootstrap path. Advances financial_entity_totals_watermark on a clean run.';

-- ── 5. pg_cron jobs — created PAUSED (FIX-704 discipline) ────────────────────
-- Registered but inactive. The supervised prod runbook runs ONE off-peak
-- CALL reconcile_financial_entity_totals() (the chunked bootstrap — fixes the
-- current committee-received + D/B donor staleness), confirms bounded resource
-- use, THEN enables the jobs:
--   SELECT cron.alter_job(jobid, active := true)
--     FROM cron.job WHERE jobname LIKE 'financial-entity-totals-%';
--
-- Off-peak slots (UTC), decoupled from the entity_connections rebuild (they
-- aggregate FR, not edges) and clear of the existing 06/07/08/10/11 jobs:
--   financial-entity-totals-incremental  Tue 09:00  — after the Sunday FEC bulk
--     ingest + Tue donor-rollup (08:00). Donations only change on the Sunday
--     FEC ingest, so a weekly cadence keeps the dirty set small.
--   financial-entity-totals-reconcile    1st of month 12:00 — the hard-delete
--     sweep, in the monthly maintenance window after ec-recipient-count-reconcile
--     (11:00). Distinct job so a totals-reconcile failure stays independent.
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('financial-entity-totals-incremental', 'financial-entity-totals-reconcile');

SELECT cron.schedule(
  'financial-entity-totals-incremental',
  '0 9 * * 2',
  $$CALL public.refresh_financial_entity_totals_incremental();$$
);

SELECT cron.schedule(
  'financial-entity-totals-reconcile',
  '0 12 1 * *',
  $$CALL public.reconcile_financial_entity_totals();$$
);

SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job
 WHERE jobname IN ('financial-entity-totals-incremental', 'financial-entity-totals-reconcile');
