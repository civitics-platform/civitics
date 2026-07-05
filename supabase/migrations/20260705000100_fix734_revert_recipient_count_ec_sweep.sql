-- FIX-734 follow-up — REVERT the EC-based recipient_count orphan sweep.
--
-- The FIX-734 recipient_count orphan zero-out (added to reconcile_recipient_count
-- in 20260705000000) was UNSOUND. Its premise — "an individual with
-- recipient_count > 0 but no entity_connections donation edge is a hard-delete
-- orphan" — is false, because entity_connections donation edges are INCOMPLETE
-- for individual→committee donations. The first supervised prod run (2026-07-05)
-- zeroed 527,626 individuals, of whom ~124k had live donations to REAL, existing
-- PACs (NAR PAC, PwC PAC, …) that simply have no EC edge. recipient_count is
-- EC-derived (FIX-194 block 1b), so it inherited EC's incompleteness; the sweep
-- made it visible by zeroing the stragglers.
--
-- Post-incident, prod recipient_count was recomputed FR-authoritatively
-- (COUNT(DISTINCT to_id) over each individual's donation financial_relationships,
-- the complete source) — a one-off set-based UPDATE, not a scheduled job. That
-- restored the ~124k live donors and correctly left ~404k true orphans (no
-- surviving donation FR) at 0. Final: 1,960,472 individuals positive, with ZERO
-- rc>0-but-no-donation-FR rows (fully FR-consistent).
--
-- This migration reverts reconcile_recipient_count() to its FIX-704 bump-only
-- form (recompute counts for individuals whose EC edge set changed; NEVER zero).
-- The ec-recipient-count-reconcile pg_cron job is left operationally PAUSED
-- (paused live 2026-07-05); it stays paused until the rework FIXes land:
--   * FIX-735 — entity_connections donation edges incomplete for individual→
--     committee (the root cause; recipient_count under-count).
--   * FIX-736 — make recipient_count FR-derived (incremental + reconcile) instead
--     of EC-derived, then re-introduce an FR-based (safe) orphan sweep.
--
-- The FIX-734 TOTALS orphan sweeps (reconcile_financial_entity_totals) and the
-- FIX-705 donor-rollup sweep (reconcile_donor_rollup_orphans) are UNAFFECTED —
-- they read financial_relationships directly (complete), found 0 orphans on the
-- supervised run, and their jobs are enabled. Only the EC-based recipient_count
-- sweep was unsound.

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
    RAISE NOTICE '[reconcile] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  FOR i IN 1..16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    BEGIN
      -- Same aggregation as the old finalize (FIX-194 block 1b), scoped to one
      -- from_id window. Only updates individuals whose count actually changed.
      -- BUMP ONLY — never zeroes. Donors that lost all their donation edges are
      -- NOT reached (absent from the ec aggregate); zeroing them from EC is
      -- UNSOUND because EC donation edges are incomplete for individual→committee
      -- (see the FIX-734 revert header). The hard-delete blind spot for
      -- recipient_count is deferred to the FR-derived rework (FIX-736).
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

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, rows_failed, error_message, metadata)
  VALUES ('recipient_count_reconcile',
          CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
          now(), now(), v_total,
          COALESCE(array_length(v_failures, 1), 0),
          CASE WHEN array_length(v_failures, 1) > 0
               THEN left(array_to_string(v_failures, '; '), 1000) ELSE NULL END,
          jsonb_build_object('source', 'pg_cron'));

  RAISE NOTICE '[reconcile] % — recipient_count updated for % donors (% window failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_total, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.reconcile_recipient_count() TO service_role;

COMMENT ON PROCEDURE public.reconcile_recipient_count() IS
  'FIX-704 — chunked (16 from_id windows, COMMIT each) BUMP-ONLY recompute of '
  'financial_entities.recipient_count for individual donors from entity_connections '
  'donation edges. Never zeroes (the FIX-734 EC-based orphan sweep was reverted — '
  'EC donation edges are incomplete for individual→committee, so no-edge does NOT '
  'imply no-donation; see FIX-735/736). Run AFTER VACUUM (ANALYZE) '
  'entity_connections. recipient_count is eventually-consistent (display-only). '
  'Job ec-recipient-count-reconcile is operationally PAUSED pending FIX-736.';

-- Belt-and-braces: ensure the job is paused on any environment replaying this
-- migration (it was created PAUSED by FIX-704 and paused live on prod 2026-07-05).
-- Direct UPDATE on cron.job is permission-denied; cron.alter_job is the API.
SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job WHERE jobname = 'ec-recipient-count-reconcile';
