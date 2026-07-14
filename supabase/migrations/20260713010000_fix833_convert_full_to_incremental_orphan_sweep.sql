-- FIX-833 — retire the 6h Monday FULL entity_connections rebuild; keep twice-
-- weekly reconcile via two INCREMENTAL runs + a light monthly donation-edge
-- orphan sweep as the durable hard-delete catch-all.
--
-- ── Why (measured on prod 2026-07-13) ────────────────────────────────────────
-- `rebuild-ec-full` (pg_cron '0 8 * * 1', CALL run_entity_connections_rebuild
-- ('full')) has SIGTERM'd at exactly its 6h role-default CALL budget every week
-- (06-29 / 07-06 / 07-13) inside rebuild_ec_donations_full_window — it never
-- reaches any other chunk, so the Monday run has accomplished NOTHING since ~June
-- 22 while burning 6h and stranding a status='running' data_sync_log row. The
-- donations full re-aggregates 4.39M donation/ie_support FR → 3.88M edges across
-- 2.0M from_ids on cold Micro; 16 full windows do not fit in 6h at the current
-- (FIX-672/677-grown) FR population. The Wednesday INCREMENTAL completes the same
-- reconcile for its dirty subset in ~42 min (2026-07-08: 42 min, 1.83M rows).
--
-- ── What the full uniquely did, and why the incremental + this sweep cover it ─
-- run_entity_connections_rebuild('incremental') already:
--   * re-derives donations from the FR.updated_at dirty set (nightly FEC dirties
--     ~790k donors/day ≈ 42% of all donors weekly — the incremental refreshes
--     nearly the whole active graph every week);
--   * FULL-rebuilds the 9 non-donation/vote chunks (cosponsors, appointments,
--     oversight, holds, gifts, contracts, lobbying, external, investigation) on
--     EVERY run — identical functions in both the full and incremental branches.
-- The ONLY thing the full did that the incremental does not is remove ORPHAN
-- donation edges left by HARD-DELETEd FR (the FR.updated_at-blind class — a donor
-- whose FR rows are hard-deleted without a subsequent update never re-enters the
-- incremental's dirty set). Measured 2026-07-13: 0 orphan donation edges across
-- 4 uuid windows (00/40/80/f0). And no existing monthly sweep covers the
-- entity_connections EDGE table (FIX-734/705 sweep the aggregate columns +
-- official_donor_rollup_mv, never the edges). Section 2 adds that missing sweep.
--
-- ── The change ───────────────────────────────────────────────────────────────
-- 1. Convert the Monday job from 'full' to 'incremental' (do NOT unschedule it):
--    keeping two runs (Mon + Wed) preserves the twice-weekly cadence, so the
--    largest gap between completed rebuilds stays Wed→Mon = 5 days, comfortably
--    under the health check's REBUILD_STALE_MS = 6 days. A bare unschedule would
--    drop to Wed-only (7-day gap) and false-fail the health check every week.
--    Both runs are now the cheap ~42 min incremental → the 6h timeout is gone by
--    construction, and rebuild_ec_donations_full_prepare()'s eager watermark bump
--    (which advanced entity_connections_donations to NOW() before the windows,
--    stranding a hole on every full failure) is never invoked again.
-- 2. Add reconcile_donation_edge_orphans() — a SINGLE set-based anti-join DELETE
--    (Merge Anti Join, EXPLAIN-validated: one sort of each big table, no
--    per-window re-scan) of donation edges whose (from_type, from_id, to_type,
--    to_id) has no surviving qualifying FR. Same shape as FIX-705's rollup orphan
--    sweep (reconcile_donor_rollup_orphans). Monthly, PAUSED until a supervised
--    prod CALL confirms it (measured 0 orphans → a no-op today, cheap insurance
--    for a future FIX-672-style quarantine).
--
-- Fork B (a set-based rewrite so a weekly full fits <6h) and Fork C (raise the
-- role budget >6h) were rejected: the incremental already does the full's work,
-- and Micro cannot sustain a >6h job under live load.
--
-- No function-signature changes → no db:types regen. Reads FR + entity_connections
-- directly; independent of the edge rebuild jobs.

-- ── 1. Convert the Monday rebuild: full → incremental ────────────────────────
-- Idempotent (FIX-688 pattern): unschedule the old 'full' job and any prior
-- Monday-incremental, then (re)create the Monday incremental. The Wednesday
-- 'rebuild-ec-incremental' job is untouched.
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('rebuild-ec-full', 'rebuild-ec-incremental-mon');

SELECT cron.schedule(
  'rebuild-ec-incremental-mon',
  '0 8 * * 1',
  $$CALL public.run_entity_connections_rebuild('incremental');$$
);

-- ── 2. Monthly donation-edge orphan sweep (the retired full's only unique job) ─
-- A single set-based anti-join DELETE — NOT a per-window loop. The prod + local
-- EXPLAIN is a Merge Anti Join (one Sort of the donation edges, one Sort of the
-- qualifying FR, one merge pass); windowing by from_id would force 16 separate
-- passes that each re-Sort all ~5M FR rows (measured: a 16-window build ran >20
-- min on the local clone vs a single bounded merge join). Deletes ONLY true
-- orphans: donation edges whose exact (from_type,from_id,to_type,to_id) has no
-- surviving FR of relationship_type IN ('donation','ie_support') — the same
-- source predicate rebuild_ec_donations_full_window INSERTs from. A no-op run
-- (0 orphans) writes ~nothing; the scan is the only cost. Mirror of FIX-705's
-- reconcile_donor_rollup_orphans (advisory lock, running/terminal data_sync_log
-- rows, COMMIT after the sweep).
CREATE OR REPLACE PROCEDURE public.reconcile_donation_edge_orphans()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donation_edge_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donation-edge-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Keep the Merge Anti Join sorts as in-memory as Micro allows (they spill past
  -- ~256MB regardless at this cardinality — external merge sort, sequential IO).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donation_edge_orphan_sweep', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the sweep its own short txn

  BEGIN
    DELETE FROM public.entity_connections ec
     WHERE ec.connection_type = 'donation'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_relationships fr
         WHERE fr.from_type = ec.from_type
           AND fr.from_id   = ec.from_id
           AND fr.to_type   = ec.to_type
           AND fr.to_id     = ec.to_id
           AND fr.relationship_type IN ('donation', 'ie_support')
       );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [donation-edge-orphans] orphan donation edges deleted: %', v_deleted;
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donation-edge-orphans] DELETE FAILED: %', SQLERRM;
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
                        'orphan_edges_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[donation-edge-orphans] % — % orphan donation edges deleted (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_donation_edge_orphans() TO service_role;

COMMENT ON PROCEDURE public.reconcile_donation_edge_orphans() IS
  'FIX-833 — monthly hard-delete ORPHAN SWEEP for entity_connections donation '
  'edges (the only work the retired Monday full uniquely did). Single set-based '
  'Merge Anti Join DELETE of donation edges whose exact '
  '(from_type,from_id,to_type,to_id) has no surviving FR of relationship_type IN '
  '(donation,ie_support) — the FR.updated_at watermark blind spot the incremental '
  'cannot see. 0 orphans measured 2026-07-13; cheap insurance for future FR '
  'hard-deletes (e.g. a FIX-672-style quarantine). Mirror of '
  'reconcile_donor_rollup_orphans (FIX-705).';

-- ── 3. Schedule the sweep, PAUSED (supervised prod enable) ───────────────────
-- Monthly, 1st 11:30 UTC — between ec-recipient-count-reconcile (11:00) and
-- financial-entity-totals-reconcile (12:00), after ec-vacuum-analyze (08:00) has
-- long finished. Created PAUSED (FIX-704/734 precedent): the prod runbook CALLs
-- it once (off-peak, watches resource use — a no-op today at 0 orphans), then:
--   SELECT cron.alter_job(job_id := jobid, active := true)
--     FROM cron.job WHERE jobname = 'donation-edge-orphan-sweep';
SELECT cron.unschedule(jobname)
  FROM cron.job WHERE jobname = 'donation-edge-orphan-sweep';

SELECT cron.schedule(
  'donation-edge-orphan-sweep',
  '30 11 1 * *',
  $$CALL public.reconcile_donation_edge_orphans();$$
);

SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job WHERE jobname = 'donation-edge-orphan-sweep';

NOTIFY pgrst, 'reload schema';
