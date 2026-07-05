-- FIX-734 + FIX-705 — single-anti-join monthly orphan sweeps; re-enable the
-- monthly reconcile.
--
-- The three watermark-driven incrementals keep every NON-orphan aggregate
-- current on their own weekly cadence:
--   * total_donated_cents / total_received_cents  (FIX-702/726, weekly)
--   * official_donor_rollup_mv                    (FIX-704, weekly)
--   * recipient_count                             (dirty-scoped in the donations
--                                                  edge incremental, FIX-704)
-- All three derive their dirty set from FR.updated_at (or the edge incremental),
-- so a HARD-DELETEd row never dirties its from_id/to_id/recipient — that
-- aggregate stays stale forever. The monthly reconcile is the ONLY catch-all for
-- that hard-delete blind spot. Since the weekly incrementals already cover live
-- data, the monthly reconcile does NOT need a full recompute — it only needs to
-- sweep hard-delete orphans. That makes it LIGHT: one set-based anti-join per
-- aggregate, not a 16-window pass.
--
-- ── FIX-734: why the windowed pass was wrong ─────────────────────────────────
-- reconcile_financial_entity_totals() was a 16-window loop, each window a two-
-- pass (bump + zero-orphan) recompute. Even after the FIX-702/726-perf partial
-- indexes + range-scoped anti-join (20260704000100), each of the 16 windows
-- still cold-scanned its slice twice; the FIX-702/726 prod bootstrap (2026-07-04)
-- extrapolated the full 16-window pass to ~60-80 min on cold Pro Small and had
-- to fall back to the set-based rebuild_* functions (ONE FR scan each — received
-- in seconds). Lesson (same as the FIX-702/726 bootstrap): a full pass is a
-- SINGLE set-based scan, never 16 cold windows. And since the weekly incremental
-- owns the live totals, the monthly does not need the bump pass at all — only the
-- zero-orphan anti-join.
--
-- ── FIX-705: donor-rollup orphan sweep ───────────────────────────────────────
-- The FIX-704 incremental donor rollup dirties recipients via FR.updated_at, so
-- a hard-deleted FR row (or a deleted recipient entity) leaves stale rollup rows
-- the watermark can't see. The 2026-07-03 prod bootstrap surfaced 58,369 carried
-- rows across 287 recipients with ZERO qualifying FR (285 FIX-672-deleted junk
-- committees + 2 officials still showing the fake $8-9.98B quarantined IEs). The
-- interim was a manual anti-join DELETE; this makes it the durable monthly sweep.
--
-- Each sweep below is ONE set-based anti-join, EXPLAIN-validated on the local
-- prod clone to be a single efficient anti-join (hash or nested-loop index),
-- NOT a per-window heap scan. Local warm timings (2026-07-04):
--   donated orphan   Hash Right Anti Join (FR seq scan → hash)          ~47s
--   received orphan  Nested Loop Anti Join (received_positive idx)      ~9s
--   donor-rollup DEL Hash Anti Join (FR seq scan → hash)                ~58s
--   recipient_count  Hash Right Anti Join (EC seq scan → hash)          ~234s (post-VACUUM)
-- vs the old windowed pass's ~60-80 min. Sequential (hash-build) I/O, one scan
-- of each big table per sweep, so bounded on cold Small — the supervised prod
-- runbook watches resource use on the first CALL and aborts if it is not.
--
-- The set-based full-rebuild functions
-- (rebuild_financial_entity_donation_totals / _received_totals,
-- donor_rollup_rebuild_recipients over all recipients) remain BREAK-GLASS for a
-- manual, rare full recompute (drift not caused by a hard delete). They are NOT
-- scheduled — the weekly incrementals + these monthly orphan sweeps are the
-- durable path.

-- ── 1. FIX-734 — totals reconcile: orphan-sweep only (two single anti-joins) ──
-- Replaces the 16-window bump+zero loop. NO watermark advance: this sweep does
-- not consume FR updates (it only zeros orphans), so advancing the watermark
-- would skip FR changes the weekly incremental has not yet processed. The weekly
-- refresh_financial_entity_totals_incremental() owns the watermark.
CREATE OR REPLACE PROCEDURE public.reconcile_financial_entity_totals()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_financial_entity_totals')::bigint;
  v_log_id   uuid;
  v_donated  bigint := 0;
  v_received bigint := 0;
  v_failures text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[fe-totals-reconcile] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Keep the donated/received Hash Anti Join builds in memory (single batch).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_reconcile', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep each sweep its own short txn

  -- Sweep A — donated orphans: a donor carrying a positive total_donated_cents
  -- but with no surviving donation FR from-side (all rows hard-deleted). Outer
  -- driven by financial_entities_donated_positive (or seq scan when most rows
  -- qualify); anti-join FR side rides financial_relationships_donation_size_rollup.
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
  -- total_received_cents but no surviving inbound donation FR (same predicate as
  -- the authoritative received-totals recompute — donation-only). Outer driven by
  -- financial_entities_received_positive; anti-join FR side rides
  -- financial_relationships_donor_rollup_idx / _to.
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

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_donated + v_received,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'donated_orphans_zeroed', v_donated,
                        'received_orphans_zeroed', v_received,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals-reconcile] % — donated=% received=% zeroed (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_donated, v_received, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_financial_entity_totals() TO service_role;

COMMENT ON PROCEDURE public.reconcile_financial_entity_totals() IS
  'FIX-702/726/734 — monthly hard-delete ORPHAN SWEEP for '
  'financial_entities.total_donated_cents + total_received_cents. Two single '
  'set-based anti-joins (NOT the old 16-window bump+zero: the weekly '
  'refresh_financial_entity_totals_incremental keeps live totals current, so the '
  'monthly only zeros orphans the FR.updated_at watermark cannot see). Does NOT '
  'advance the watermark (the weekly owns it). Break-glass full recompute: '
  'rebuild_financial_entity_donation_totals() / _received_totals().';

-- ── 2. FIX-705 — donor-rollup orphan sweep (single anti-join DELETE) ──────────
CREATE OR REPLACE PROCEDURE public.reconcile_donor_rollup_orphans()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donor-rollup-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_orphan_sweep', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- DELETE rollup rows for any recipient (official_id) with NO surviving
  -- qualifying FR to-side — same predicate as donor_rollup_rebuild_recipients
  -- (relationship_type IN donation/ie_support/ie_oppose, from_type=fe). Single
  -- Hash Anti Join: seq scan the rollup, anti-join against
  -- financial_relationships_donor_rollup_idx. Catches FIX-672-deleted junk
  -- committees + quarantined-IE officials whose FR rows are gone.
  BEGIN
    DELETE FROM public.official_donor_rollup_mv r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.to_id = r.official_id
        AND fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [donor-rollup-orphans] orphan rollup rows deleted: %', v_deleted;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('rollup orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donor-rollup-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_donor_rollup_orphans() TO service_role;

COMMENT ON PROCEDURE public.reconcile_donor_rollup_orphans() IS
  'FIX-705 — monthly hard-delete orphan sweep for official_donor_rollup_mv. '
  'Single Hash Anti Join DELETE of rollup rows whose recipient (official_id) has '
  'no surviving qualifying FR (donation/ie_support/ie_oppose, from_type=fe) — the '
  'FIX-704 watermark blind spot (deleted junk committees, quarantined-IE '
  'officials). Break-glass full rebuild: clear donor_rollup_watermark + CALL '
  'refresh_official_donor_rollup_incremental().';

-- ── 3. FIX-734 — recipient_count reconcile: add the orphan zero-out ───────────
-- Keeps the FIX-704 16-window bump (recompute counts for individuals whose edge
-- set changed; runs post-VACUUM entity_connections so the scan stays index-only),
-- and ADDS a single anti-join zero-out: individuals with a positive
-- recipient_count but no surviving donation edge (all edges hard-deleted — the
-- bump never touches them because they do not appear in its ec aggregate).
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
  v_orphans  bigint := 0;
  v_n        bigint;
  v_failures text[] := ARRAY[]::text[];
  i          int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[reconcile] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  FOR i IN 1..16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    BEGIN
      -- Same aggregation as the old finalize (FIX-194 block 1b), scoped to one
      -- from_id window. Only updates individuals whose count actually changed;
      -- donors that lost ALL their donation edges are NOT reached here (they are
      -- absent from the ec aggregate) — the orphan sweep below handles them.
      UPDATE public.financial_entities fe
      SET recipient_count = sub.cnt
      FROM (
        SELECT
          ec.from_id,
          COUNT(DISTINCT ec.to_id)::smallint AS cnt
        FROM public.entity_connections ec
        WHERE ec.connection_type = 'donation'
          AND ec.from_type = 'financial_entity'
          AND ec.from_id >= v_lo
          AND (v_hi IS NULL OR ec.from_id < v_hi)
        GROUP BY ec.from_id
      ) sub
      WHERE fe.id = sub.from_id
        AND fe.entity_type = 'individual'
        AND fe.recipient_count IS DISTINCT FROM sub.cnt;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_total := v_total + v_n;
      RAISE NOTICE '  [reconcile] window %/16 — % donors updated', i, v_n;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [reconcile] window %/16 FAILED: %', i, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  END LOOP;

  -- FIX-734 orphan zero-out: single anti-join. Individual donors carrying a
  -- positive recipient_count but no surviving donation edge (hard-delete blind
  -- spot). Outer driven by financial_entities_recipient_count_idx; anti-join EC
  -- side rides entity_connections_from_id_connection_type.
  BEGIN
    UPDATE public.financial_entities fe
    SET recipient_count = 0
    WHERE fe.entity_type = 'individual'
      AND fe.recipient_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec
        WHERE ec.connection_type = 'donation'
          AND ec.from_type = 'financial_entity'
          AND ec.from_id = fe.id
      );
    GET DIAGNOSTICS v_orphans = ROW_COUNT;
    v_total := v_total + v_orphans;
    RAISE NOTICE '  [reconcile] orphan recipient_count zeroed: %', v_orphans;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('orphan sweep: %s', SQLERRM);
    RAISE WARNING '  [reconcile] orphan sweep FAILED: %', SQLERRM;
  END;
  COMMIT;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, rows_failed, error_message, metadata)
  VALUES ('recipient_count_reconcile',
          CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
          now(), now(), v_total,
          COALESCE(array_length(v_failures, 1), 0),
          CASE WHEN array_length(v_failures, 1) > 0
               THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
          jsonb_build_object('source', 'pg_cron', 'orphans_zeroed', v_orphans));

  RAISE NOTICE '[reconcile] % — recipient_count updated for % donors (incl % orphans zeroed; % window failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_total, v_orphans, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_recipient_count() TO service_role;

COMMENT ON PROCEDURE public.reconcile_recipient_count() IS
  'FIX-704/734 — chunked (16 from_id windows, COMMIT each) recompute of '
  'financial_entities.recipient_count for individual donors + a single anti-join '
  'ORPHAN zero-out (FIX-734: individuals with a positive count but no surviving '
  'donation edge — the hard-delete blind spot the window bump cannot reach). Run '
  'AFTER VACUUM (ANALYZE) entity_connections (the ec-vacuum-analyze cron) so the '
  'scans stay index-only. recipient_count is eventually-consistent (display-only).';

-- ── 4. pg_cron — new donor-rollup-orphan-sweep job, created PAUSED ────────────
-- The supervised prod runbook (off-peak, Craig-confirmed) CALLs each reconcile
-- once, watches resource use, then enables:
--   SELECT cron.alter_job(job_id := jobid, active := true) FROM cron.job
--    WHERE jobname IN ('financial-entity-totals-reconcile', 'donor-rollup-orphan-sweep');
-- (ec-recipient-count-reconcile is ALREADY active — its added orphan sweep must
-- be validated by a supervised CALL before its next scheduled fire, 1st of month.)
--
-- Monthly slot after financial-entity-totals-reconcile (12:00): 1st 12:30 UTC.
-- FR-based (independent of entity_connections), so no ec-vacuum dependency.
SELECT cron.unschedule(jobname)
  FROM cron.job WHERE jobname = 'donor-rollup-orphan-sweep';

SELECT cron.schedule(
  'donor-rollup-orphan-sweep',
  '30 12 1 * *',
  $$CALL public.reconcile_donor_rollup_orphans();$$
);

SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job WHERE jobname = 'donor-rollup-orphan-sweep';

-- financial-entity-totals-reconcile stays PAUSED (enabled in the supervised run).

NOTIFY pgrst, 'reload schema';
