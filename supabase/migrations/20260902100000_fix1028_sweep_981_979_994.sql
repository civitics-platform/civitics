-- =============================================================================
-- FIX-1028 (the sweep) + FIX-1108 + FIX-981 + FIX-979 (remainder) + FIX-994
--
-- ONE MECHANISM, FILED SIX TIMES.
--
--   PL/pgSQL's `EXCEPTION WHEN OTHERS` matches every error condition EXCEPT
--   `query_canceled` (57014) and `assert_failure`. A budget-watchdog cancel
--   (FIX-1063), a statement_timeout, an operator `pg_cancel_backend` and a
--   client disconnect all raise exactly `query_canceled`. So a procedure that
--
--     1. INSERTs a data_sync_log row with status='running',
--     2. COMMITs it (making it visible),
--     3. relies on a trailing UPDATE to close it,
--
--   has step 3 skipped entirely when the axe lands: the error blows through
--   `WHEN OTHERS`, out of the loop, and out of the procedure. The row sits
--   `running` until the nightly reaper closes it up to 60 minutes later, and
--   where the watermark/cursor is written only after the loop, the whole run's
--   progress is discarded — so the next firing is strictly LARGER than the one
--   that was just cancelled. That is the ratchet.
--
-- FIX-1028 fixed 2 of 14 in 20260813010000 and said the rest were "a later
-- sweep". This is that sweep. FIX-1108 then found two more procedures being
-- cancelled by the very watchdog whose own comment claims the cancel lands in a
-- handler; cc-98 found a third (refresh_treemap_individuals_global, 2026-09-01,
-- 5,409.8 s against a 5,400 s budget). After this migration that comment's
-- claim is TRUE for every job in cron_job_budget.
--
-- THE POPULATION IS CATALOG-DERIVED, NOT HAND-KEPT. Every plpgsql routine in
-- `public` that (a) writes a data_sync_log 'running' row OR a pipeline_state
-- watermark/cursor, AND (b) uses transaction control or is CALLed from cron.job,
-- AND (c) has `WHEN OTHERS` with no `WHEN query_canceled`. On prod 2026-09-02
-- that walk returned exactly eleven:
--
--   donor_rollup_rebuild_bulk                    reconcile_donation_edge_orphans
--   reconcile_donor_party_rollup_orphans         reconcile_donor_rollup_orphans
--   reconcile_entity_connection_stats_orphans    reconcile_financial_entity_totals
--   refresh_donor_party_rollup_incremental       refresh_sector_affinity_from_tag_changes
--   refresh_financial_entity_totals_incremental  refresh_treemap_individuals_global
--   run_rule_taggers
--
-- Ten of them are here. The eleventh — refresh_donor_party_rollup_incremental
-- (jobid 17) — needs more than a handler (its watermark is written only after
-- the loop, so a cancel discards five weeks of progress at a time) and is
-- rewritten in the companion migration 20260902110000.
--
-- THE IDIOM, copied verbatim from run_entity_connections_rebuild() in the
-- FIX-1028 migration. There is deliberately no second shape:
--
--   * `WHEN query_canceled THEN` BY NAME, listed BEFORE `WHEN OTHERS`.
--   * Record it into v_canceled, RAISE WARNING, do NOT re-raise.
--   * The handler CANNOT wrap the loop: PL/pgSQL forbids COMMIT inside a block
--     that has an EXCEPTION clause, so it lives on the per-iteration block that
--     is already there, and the COMMIT stays at the top level outside it.
--   * EXIT the loop — the box has just proven it cannot finish one unit, so
--     starting the next only re-arms the same axe.
--   * The trailing UPDATE closes the row `partial` (distinct from `failed`,
--     which means a unit raised) with completed_at = clock_timestamp(),
--     error_message 'canceled — …', and metadata.canceled / .cancel_detail /
--     .elapsed_seconds.
--   * Any cursor/watermark/signature write after the loop is gated on
--     `v_canceled IS NULL`, so a cancelled run can never advance past work it
--     rolled back.
--
-- The timer that fired is disarmed once it has thrown, so the bookkeeping
-- UPDATE after the catch does run (verified in FIX-1021's local repro and
-- re-verified here — see the three cancel proofs in the commit body).
--
-- ── FIX-981: clock_timestamp(), not now(), after a COMMIT ────────────────────
-- `now()` is `transaction_timestamp()`, frozen at transaction start. In a
-- routine that COMMITs per chunk, the transaction that stamps a row began after
-- the LAST commit, so `now()` is the start of the chunk that is writing, not the
-- instant of the write — and in a trailing statement it is the start of the
-- final bookkeeping transaction, which can be hours after the run began. Every
-- such site in a chunked routine becomes clock_timestamp() here.
--
-- official_donor_totals.updated_at, official_small_dollar_rollup.updated_at and
-- official_sector_affinity_rollup.updated_at all carry `DEFAULT now()`. Per the
-- FIX-981 census, NO routine on prod reads any of the three as a watermark —
-- the only readers of official_donor_totals are the three FIX-869 backfill
-- worklists (which read individual_cents / official_id) and the FIX-1002 weight
-- lookup (donor_count). So the value is set explicitly at the chunked INSERT
-- sites and the column DEFAULTs are LEFT ALONE. No table DDL in this migration.
--
-- ── FIX-979 (remainder) + FIX-994: truthful spans ────────────────────────────
-- FIX-979's migration (20260812000000) reached 3 of its 8 writers. The five it
-- did not reach are here, in the shape 979 shipped: capture v_started :=
-- clock_timestamp() at block entry, stamp the exit with clock_timestamp(). The
-- defect is `VALUES (…, now(), now(), …)` in ONE statement — both calls return
-- transaction_timestamp(), so the recorded duration is EXACTLY zero and
-- pipeline_runtime_stats_mv renders the run as 0 ms.
--
--   backfill_official_small_dollar_rollup       ('small_dollar_rollup_backfill')
--   backfill_official_sector_affinity_rollup    ('sector_affinity_rollup_backfill')
--   backfill_treemap_individuals_focused        ('treemap_individuals_focused_backfill')
--   backfill_official_donor_brackets            ('official_donor_brackets_backfill')
--   reconcile_recipient_count                   ('recipient_count_reconcile')
--
-- backfill_official_donor_brackets was NOT on the FIX-979 list — the catalog
-- walk found it. It is the same defect written the same way; it is fixed here
-- and the census, not the list, is the population.
--
-- reconcile_recipient_count() is FIX-994's writer. (The FIX-994 bullet names
-- reconcile_financial_entity_totals(); that procedure closes an entry row with
-- a trailing UPDATE and never had the zero-span defect. The bullet's
-- attribution is wrong; the defect is real and it is here.) It is unscheduled
-- break-glass, so it additionally records metadata.driver = 'manual'.
--
-- The canary's own meta-row (`canary_check`, FIX-980) has the same zero-span
-- shape in TypeScript — one `new Date()` written to both columns. It is fixed
-- in packages/data/src/scripts/canary-check.ts in the same commit, by taking
-- two timestamps around the work rather than writing one value twice.
--
-- NOT TOUCHED, deliberately: the FIX-944 reaper leaving completed_at NULL on
-- reaped rows. That is by design (started_at..reap is not a runtime) and
-- pipeline_runtime_stats_mv already excludes those rows.
--
-- EVERY BODY BELOW IS pg_get_functiondef() OUTPUT TAKEN FROM PROD (2026-09-02)
-- with only the changes described above applied. md5(prosrc) was compared
-- against the latest migration text for all twenty routines in scope first;
-- all twenty MATCHED, so nothing here can silently revert an intermediate
-- definition. Each recreate re-REVOKEs anon/authenticated/PUBLIC and re-GRANTs
-- service_role, matching the grants observed on prod.
--
-- Cross-ref FIX-1028, FIX-1108, FIX-1112, FIX-1063, FIX-1021, FIX-1002,
-- FIX-994, FIX-981, FIX-979, FIX-972, FIX-969, FIX-944, FIX-943, FIX-884.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. reconcile_donation_edge_orphans() — single-statement shape
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_donation_edge_orphans()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donation_edge_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled text := NULL;
  -- FIX-979 — real entry time so a cancelled run reports a true span.
  v_started  timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donation-edge-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Keep the Merge Anti Join sorts as in-memory as Micro allows (they spill past
  -- ~256MB regardless at this cardinality — external merge sort, sequential IO).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donation_edge_orphan_sweep', 'running', v_started,
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
  EXCEPTION
  -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled, so
  -- before this a watchdog cancel skipped the terminal UPDATE below entirely
  -- and stranded the row 'running' until the reaper.
  WHEN query_canceled THEN
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donation-edge-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donation-edge-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      -- FIX-981/979: clock_timestamp(), not now() — this transaction began
      -- after the sweep's COMMIT.
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_edges_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[donation-edge-orphans] % — % orphan donation edges deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.reconcile_donation_edge_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_donation_edge_orphans() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. reconcile_donor_party_rollup_orphans()
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_donor_party_rollup_orphans()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_party_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[dpr-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- DELETE rollup rows for any donor with NO surviving qualifying FR row —
  -- same predicate as donor_party_rollup_rebuild_donors. The FR.updated_at
  -- watermark cannot see hard deletes (FIX-705 blind spot); this is the
  -- catch-all. Single set-based anti-join.
  BEGIN
    DELETE FROM public.donor_party_rollup_mv r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.from_id = r.donor_id
        AND fr.relationship_type = 'donation'
        AND fr.from_type = 'financial_entity'
        AND fr.to_type   = 'official'
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [dpr-orphans] orphan rollup rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [dpr-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [dpr-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[dpr-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.reconcile_donor_party_rollup_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_donor_party_rollup_orphans() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. reconcile_donor_rollup_orphans()
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_donor_rollup_orphans()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donor-rollup-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_orphan_sweep', 'running', v_started,
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
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('rollup orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donor-rollup-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('rollup orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donor-rollup-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.reconcile_donor_rollup_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_donor_rollup_orphans() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. reconcile_entity_connection_stats_orphans()
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_entity_connection_stats_orphans()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('reconcile_entity_connection_stats_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[ec-stats-orphans] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('entity_connection_stats_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- Belt-and-braces: the staged full rebuild removes orphans by construction
  -- (windowed DELETE covers the whole keyspace), so this normally deletes ~0
  -- rows. Kept per the FIX-705 discipline — it guards a future incremental
  -- conversion and any window that failed complete-if-stale.
  BEGIN
    DELETE FROM public.entity_connection_stats_mv s
    WHERE NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.from_id = s.entity_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.to_id = s.entity_id
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [ec-stats-orphans] orphan stats rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [ec-stats-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [ec-stats-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[ec-stats-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.reconcile_entity_connection_stats_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_entity_connection_stats_orphans() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. reconcile_financial_entity_totals() — three sweeps, three handlers
--
-- The later sweeps are gated on `v_canceled IS NULL`: once the axe has landed
-- on sweep A there is no budget left for B and C, and running them only
-- re-arms it. This is the single-statement analogue of EXITing the loop.
-- COMMIT inside an IF is legal (IF is not a subtransaction); COMMIT inside a
-- BEGIN…EXCEPTION block is not, which is why each COMMIT stays outside.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_financial_entity_totals()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('reconcile_financial_entity_totals')::bigint;
  v_log_id   uuid;
  v_donated  bigint := 0;
  v_received bigint := 0;
  v_reccount bigint := 0;   -- FIX-736: recipient_count orphans zeroed
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[fe-totals-reconcile] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Keep the anti-join hash builds in memory (single batch).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_reconcile', 'running', v_started,
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
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('donated sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] donated sweep CANCELED: %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('donated sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] donated sweep FAILED: %', SQLERRM;
  END;
  COMMIT;

  -- Sweep B — received orphans: a recipient carrying a positive
  -- total_received_cents but no surviving inbound donation FR.
  IF v_canceled IS NULL THEN
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
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('received sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] received sweep CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('received sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] received sweep FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  -- Sweep C (FIX-736) — recipient_count orphans: an individual carrying a
  -- positive recipient_count but no surviving donation FR from-side. SOUND (FR is
  -- complete) — this replaces the reverted, UNSOUND EC-based sweep. Outer driven
  -- by financial_entities_recipient_count_idx (partial WHERE entity_type=
  -- 'individual'); anti-join FR side rides financial_relationships_donation_size_rollup.
  IF v_canceled IS NULL THEN
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
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('recipient_count sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] recipient_count sweep CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('recipient_count sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] recipient_count sweep FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_donated + v_received + v_reccount,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s', v_canceled,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'donated_orphans_zeroed', v_donated,
                        'received_orphans_zeroed', v_received,
                        'recipient_count_orphans_zeroed', v_reccount,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals-reconcile] % — donated=% received=% recipient_count=% zeroed (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_donated, v_received, v_reccount, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.reconcile_financial_entity_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_financial_entity_totals() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. run_rule_taggers(text) — jobid 12 (rule-taggers-weekly), budget 7,200 s
--
-- Its own cron_job_budget note records "Hit the 6h ceiling 2026-08-04" — a
-- cancel that, before this, left the row stranded and the size-tags signature
-- un-advanced with no record of why.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.run_rule_taggers(IN p_cadence text)
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key    bigint := hashtext('run_rule_taggers')::bigint;  -- shared by both cadences
  c_wm_key      text   := 'size_tags:donation_watermark';
  v_log_id      uuid;
  v_rows        bigint := 0;
  v_action      text;
  v_current_sig text;
  v_stored_sig  text;
  v_failures    text[] := ARRAY[]::text[];
  v_canceled    text := NULL;                          -- FIX-1028
  v_started     timestamptz := clock_timestamp();      -- FIX-979
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'run_rule_taggers: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent run_rule_taggers',
                               'source', 'pg_cron'));
    RAISE NOTICE '[rule-taggers] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;

  -- Bounded memory for the aggregate rebuilds (they HashAggregate the donation /
  -- vote set). Plain SET survives COMMIT. Budget = 6h role default (FIX-703).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('run_rule_taggers', 'running', v_started,
          jsonb_build_object('cadence', p_cadence, 'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;

  IF p_cadence = 'weekly' THEN
    -- ── size-tags (donation-derived), gated ──────────────────────────────────
    BEGIN
      SELECT count(*)::text || '|'
             || COALESCE(max(created_at), 'epoch'::timestamptz)::text || '|'
             || COALESCE(max(updated_at), 'epoch'::timestamptz)::text
        INTO v_current_sig
        FROM public.financial_relationships
       WHERE from_type = 'financial_entity' AND relationship_type = 'donation';

      SELECT value->>'sig' INTO v_stored_sig
        FROM public.pipeline_state WHERE key = c_wm_key;

      IF v_stored_sig IS DISTINCT FROM v_current_sig THEN
        v_rows := public.rebuild_financial_entity_size_tags();
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_wm_key, jsonb_build_object('sig', v_current_sig))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
        v_action := 'rebuilt';
        RAISE NOTICE '  [rule-taggers] size-tags — rebuilt (% tags, sig=%)', v_rows, v_current_sig;
      ELSE
        v_action := 'skipped_unchanged';
        RAISE NOTICE '  [rule-taggers] size-tags — donation source unchanged (sig=%), skipping rebuild', v_current_sig;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, first. The rebuild and its signature advance share
    -- this subtransaction, so a cancel rolls BOTH back and the next run redoes
    -- the same work. Nothing to gate; just record it and close the row.
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      -- Rebuild + watermark advance roll back together → next run retries.
      v_action := 'failed';
      v_failures := v_failures || format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  ELSE
    -- ── pre-vote timing (vote-derived), ungated ──────────────────────────────
    BEGIN
      v_rows := public.rebuild_pre_vote_timing_tags();
      v_action := 'rebuilt';
      RAISE NOTICE '  [rule-taggers] pre-vote timing — rebuilt (% tags)', v_rows;
    EXCEPTION
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      v_action := 'failed';
      v_failures := v_failures || format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'tagger', CASE WHEN p_cadence = 'weekly' THEN 'size_tags' ELSE 'pre_vote_timing' END,
                        'action', v_action,
                        'tags_written', v_rows,
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[rule-taggers] % (cadence=%) — action=%, % tags (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_action, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.run_rule_taggers(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_rule_taggers(text) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. refresh_financial_entity_totals_incremental() — jobid 13, PAUSED
--
-- Handler only, per the Bundle-B scope. The job is paused permanently (Craig,
-- 2026-08-26) and superseded by run_fe_totals_crawl()/refresh_fe_totals_slice()
-- (FIX-1031/969), which advances financial_entity_totals_watermark INSIDE the
-- slice transaction. The procedure still exists and can still be CALLed by
-- hand, so it gets the handler; nothing else about it changes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_financial_entity_totals_incremental()
LANGUAGE plpgsql
AS $proc$
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
  v_canceled  text := NULL;                            -- FIX-1028
  v_started   timestamptz := clock_timestamp();        -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', v_started, clock_timestamp(),
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
  VALUES ('financial_entity_totals_refresh', 'running', v_started,
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
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 CANCELED: %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level (outside the EXCEPTION subtransaction)
      EXIT WHEN v_canceled IS NOT NULL;
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
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;

    v_i := 1;
    WHILE v_i <= v_n_to AND v_canceled IS NULL LOOP
      v_chunk := v_dirty_to[v_i : LEAST(v_i + c_chunk - 1, v_n_to)];
      BEGIN
        v_n := public.financial_entity_received_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;
  END IF;

  -- Advance the watermark only on a clean run — a failed chunk/window's keys
  -- must stay in the next run's dirty set. FIX-1028 adds the cancel arm: a
  -- cancelled run has NOT covered its dirty set, so advancing here would
  -- permanently skip every key it did not reach.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('financial_entity_totals_watermark',
            jsonb_build_object('last_indexed_at', COALESCE(v_new_max, clock_timestamp())::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows + v_rc,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; watermark unmoved, the whole dirty set is retried next run', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'rows_updated', v_rows,
                        'recipient_count_updated', v_rc,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals] % (mode=%) — % totals rows, % recipient_count rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_mode, v_rows, v_rc, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.refresh_financial_entity_totals_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_financial_entity_totals_incremental() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. refresh_treemap_individuals_global() — jobid 26, budget 5,400 s
--
-- cc-98's find: cancelled 2026-09-01 at 5,409.8 s. The cursor is already written
-- inside each chunk's transaction (FIX-965), so no progress was lost — but the
-- row sat 'running' and nothing recorded WHY the sweep stopped at chunk 12.
-- prod's pipeline_state still shows chunk_cursor 12 from that firing.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key  bigint := hashtext('treemap_individuals_global_refresh')::bigint;
  c_global    uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks    int    := 64;              -- 4-per-first-byte from_id ranges
  c_state_key text   := 'treemap_global_refresh';
  c_max_sweep interval := interval '72 hours';
  c_budget    interval := interval '4 hours 30 minutes';
  v_state      jsonb;
  v_cursor     int;                      -- last COMMITTED chunk (-1 = none)
  v_resumed    boolean := false;
  v_restarted  text    := NULL;          -- non-NULL = why a resume was discarded
  v_sweep_beg  timestamptz;
  v_log_id     uuid;
  v_budget_cfg int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- cc-98 measured this procedure cancelled on 2026-09-01 at 5,409.8 s against
  -- jobid 26's 5,400 s budget; WHEN OTHERS did not match it, so the terminal
  -- UPDATE below was skipped and the row sat 'running' until the reaper.
  v_canceled   text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint;
  k            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('treemap_individuals_global_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent refresh'));
    RAISE NOTICE '[treemap-global refresh] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Plain SET (not SET LOCAL) survives the per-chunk COMMITs. The caller's
  -- statement_timeout is armed at CALL start and CANNOT be changed from here
  -- (FIX-944, measured) — the c_budget guard below is the only clean stop.
  SET work_mem = '256MB';

  v_budget_cfg := NULLIF(current_setting('civitics.treemap_global_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_budget_cfg);
  END IF;

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);
  v_sweep_beg := (v_state->>'sweep_started_at')::timestamptz;

  IF v_cursor >= 0 THEN
    v_resumed := true;
    IF v_sweep_beg IS NULL OR clock_timestamp() - v_sweep_beg > c_max_sweep THEN
      v_restarted := format('sweep started %s exceeds the %s staleness bound', v_sweep_beg, c_max_sweep);
    ELSIF to_regclass('public._tin_state_name') IS NULL THEN
      v_restarted := 'staging table missing (crash recovery truncates UNLOGGED tables)';
    ELSIF NOT EXISTS (SELECT 1 FROM public._tin_state_name LIMIT 1) THEN
      v_restarted := 'staging table empty despite a committed cursor — crash-truncated';
    END IF;
    IF v_restarted IS NOT NULL THEN
      RAISE NOTICE '[treemap-global refresh] discarding in-flight sweep: %', v_restarted;
      v_cursor  := -1;
      v_resumed := false;
    END IF;
  END IF;

  IF v_cursor < 0 THEN
    -- Fresh sweep: (re)create staging and stamp the sweep start.
    DROP TABLE IF EXISTS public._tin_state_name;
    CREATE UNLOGGED TABLE public._tin_state_name (
      state          text   NOT NULL,
      donor_name     text   NOT NULL,
      total_cents    bigint NOT NULL,
      donation_count bigint NOT NULL,
      PRIMARY KEY (state, donor_name)
    );
    -- Supabase default privileges grant table access broadly; this staging can
    -- persist for days mid-sweep. Route reads go through the rollup, never this.
    REVOKE ALL ON public._tin_state_name FROM PUBLIC, anon, authenticated;
    v_sweep_beg := clock_timestamp();   -- FIX-981: the instant, not the txn start
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object('chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object('chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text),
          updated_at = clock_timestamp();   -- FIX-981
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('treemap_individuals_global_refresh', 'running', v_started,
          jsonb_build_object(
            'scope', 'global', 'shape', 'resumable 64-chunk merge',
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'budget_seconds', EXTRACT(epoch FROM c_budget)))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish staging + running row; keep the first chunk's txn short

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    -- PREDICTIVE budget check (FIX-944): stop when the slowest chunk observed
    -- so far (plus 25% headroom) would not fit in what remains.
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_chunk > 0
       AND v_elapsed + (v_max_chunk * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[treemap-global refresh] budget guard — stopping before chunk % (elapsed %s, slowest chunk %s)',
        k, round(v_elapsed)::int, round(v_max_chunk)::int;
      EXIT;
    END IF;

    v_lo := (lpad(to_hex(k * 4), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid;
    v_hi := CASE WHEN k < c_chunks - 1
                 THEN (lpad(to_hex((k + 1) * 4), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid
                 ELSE NULL END;
    v_chunk_beg := clock_timestamp();

    BEGIN
      -- Group FR by donor FIRST (rides the donation_size rollup index), join
      -- financial_entities once per donor, partial-aggregate to (state, name),
      -- MERGE into staging. GROUP BY dedupes within the statement, so
      -- ON CONFLICT only ever fires for prior chunks' rows.
      INSERT INTO public._tin_state_name AS t (state, donor_name, total_cents, donation_count)
      SELECT
        COALESCE(fe.metadata->>'state', '??') AS state,
        fe.display_name                       AS donor_name,
        SUM(da.total_cents)::bigint,
        SUM(da.donation_count)::bigint
      FROM (
        SELECT fr.from_id, SUM(fr.amount_cents)::bigint AS total_cents, COUNT(*)::bigint AS donation_count
        FROM public.financial_relationships fr
        WHERE fr.relationship_type = 'donation'
          AND fr.from_type         = 'financial_entity'
          AND fr.to_type           = 'official'
          AND fr.amount_cents > 0
          AND fr.from_id >= v_lo
          AND (v_hi IS NULL OR fr.from_id < v_hi)
        GROUP BY fr.from_id
      ) da
      JOIN public.financial_entities fe ON fe.id = da.from_id AND fe.entity_type = 'individual'
      GROUP BY 1, 2
      ON CONFLICT (state, donor_name) DO UPDATE
        SET total_cents    = t.total_cents    + EXCLUDED.total_cents,
            donation_count = t.donation_count + EXCLUDED.donation_count;

      -- The whole fix: cursor advances INSIDE the chunk's transaction. A run
      -- cancelled mid-chunk keeps every committed chunk and resumes at k.
      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object('chunk_cursor', k),
             updated_at = clock_timestamp()   -- FIX-981: after N COMMITs, now() is this chunk's txn start
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        -- Committing the merge WITHOUT the cursor would double-count this
        -- range on the next run. Abort the chunk (the merge rolls back).
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. PL/pgSQL's OTHERS matches every error EXCEPT
    -- query_canceled and assert_failure, so the budget watchdog's cancel used to
    -- blow straight out of the procedure from here. Falling out of the loop
    -- instead reaches the terminal UPDATE, which is the whole point. The cursor
    -- is written INSIDE the chunk txn (above), so the cancelled chunk rolls back
    -- with its cursor advance and the next CALL resumes at exactly k.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s: %s', k, SQLERRM);
      RAISE WARNING '[treemap-global refresh] chunk % CANCELED (statement_timeout or operator cancel): %', k, SQLERRM;
    WHEN OTHERS THEN
      -- A skipped range would corrupt the global aggregate — fail the run,
      -- keep the cursor at the last COMMITTED chunk, let the next CALL retry.
      v_failed := format('chunk %s: %s', k, SQLERRM);
      RAISE WARNING '[treemap-global refresh] chunk % FAILED: %', k, SQLERRM;
    END;

    -- EXIT before the COMMIT: the caught chunk has already rolled back to the
    -- subtransaction savepoint, and committing here would publish nothing but
    -- would also not help. Both arms leave the cursor at the last GOOD chunk.
    EXIT WHEN v_canceled IS NOT NULL;
    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;  -- top level (PL/pgSQL forbids COMMIT inside the EXCEPTION block)

    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    IF (k + 1) % 8 = 0 THEN
      RAISE NOTICE '[treemap-global refresh] chunk %/% done (%s)', k + 1, c_chunks, round(v_chunk_secs)::int;
    END IF;
  END LOOP;

  -- FIX-1028 — a cancelled run is PARTIAL and RESUMABLE: every chunk it did
  -- commit is real and the cursor points at it. Distinct from 'failed' (a chunk
  -- raised) and from the budget guard's own clean stop below.
  IF v_canceled IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(),
           error_message = left(format('canceled — %s; resumable at chunk %s of %s', v_canceled,
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1 FROM public.pipeline_state WHERE key = c_state_key), 0),
             c_chunks), 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true,
             'canceled', true,
             'cancel_detail', v_canceled,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE WARNING '[treemap-global refresh] CANCELED — partial, resumable; re-CALL to continue';
    RETURN;
  END IF;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  IF v_budget_hit THEN
    -- Partial, resumable — distinct from 'complete' and 'failed' (FIX-944).
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(),
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1 FROM public.pipeline_state WHERE key = c_state_key), 0),
             c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[treemap-global refresh] PARTIAL — resumable; re-CALL to continue';
    RETURN;
  END IF;

  -- Publish: swap the GLOBAL scope in ONE transaction, clear the sweep state,
  -- drop staging. Readers see the old top-50 until this commits.
  DELETE FROM public.treemap_individuals_rollup WHERE scope_id = c_global;

  WITH ranked AS (
    SELECT state, donor_name, total_cents, donation_count,
      ROW_NUMBER() OVER (PARTITION BY state ORDER BY total_cents DESC, donor_name) AS rank
    FROM public._tin_state_name
  ),
  ins AS (
    INSERT INTO public.treemap_individuals_rollup
      (scope_id, state, rank, donor_name, total_cents, donation_count)
    SELECT c_global, state, rank::int, donor_name, total_cents, donation_count
    FROM ranked WHERE rank <= 50
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_rows FROM ins;

  DROP TABLE IF EXISTS public._tin_state_name;

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', clock_timestamp()::text),   -- FIX-981
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
   WHERE id = v_log_id;

  RAISE NOTICE '[treemap-global refresh] complete — % rows', v_rows;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.refresh_treemap_individuals_global() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_treemap_individuals_global() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. refresh_sector_affinity_from_tag_changes() — trigger-driven, not on cron
--
-- Three paths. Path 1 (noop) is atomic. Path 3 (targeted, the steady state)
-- gets the handler and gates its signature advance. Path 2 (cold start) CALLs a
-- COMMITting procedure and therefore CANNOT carry a handler — see the note in
-- the body. That is the one structurally unprotectable site in the sweep.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_sector_affinity_from_tag_changes()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key   bigint := hashtext('sector_affinity_tag_refresh')::bigint;
  c_sig_key    constant text := 'sector_affinity:industry_tag_signature';
  c_chunk      constant int  := 500;   -- matches backfill_official_sector_affinity_rollup
  v_log_id     uuid;
  v_live_sig   text;
  v_stored_sig text;
  v_shadow_n   bigint;
  v_reason     text;
  v_donors     uuid[];
  v_n_donors   int;
  v_officials  uuid[];
  v_n_off      int := 0;
  v_chunk_ids  uuid[];
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text := NULL;
  -- FIX-979 — real entry time.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent sector-affinity tag refresh'));
    RAISE NOTICE '[sector-affinity tag refresh] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  -- Signature FIRST, before any rebuild: tag writes that land mid-run make the
  -- NEXT run's live signature differ from what this run stores, so they are
  -- re-processed rather than silently absorbed — the FIX-704
  -- capture-watermark-before-dirty-set discipline, content-shaped.
  v_live_sig := public.compute_fe_industry_tag_signature();

  SELECT value->>'sig' INTO v_stored_sig
    FROM public.pipeline_state WHERE key = c_sig_key;

  SELECT count(*) INTO v_shadow_n FROM public.donor_industry_tag_state;

  -- ── Path 1: no-op — identical content, zero rollup work ────────────────────
  IF v_stored_sig IS NOT NULL AND v_shadow_n > 0 AND v_live_sig = v_stored_sig THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
    VALUES ('sector_affinity_tag_refresh', 'complete', v_started, clock_timestamp(), 0,
            jsonb_build_object('path', 'noop',
                               'reason', 'industry tag content signature unchanged',
                               'sig', v_live_sig));
    RAISE NOTICE '[sector-affinity tag refresh] noop — signature unchanged (%)', v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 2: cold start / signature-store miss — the full backfill ──────────
  IF v_stored_sig IS NULL OR v_shadow_n = 0 THEN
    v_reason := CASE WHEN v_stored_sig IS NULL
                     THEN 'cold_start_no_signature'
                     ELSE 'signature_store_miss_empty_shadow' END;
    INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'running', v_started,
            jsonb_build_object('path', 'full_backfill', 'reason', v_reason))
    RETURNING id INTO v_log_id;
    COMMIT;

    -- Deliberately NOT wrapped in an EXCEPTION block: the nested procedure
    -- COMMITs per chunk, and transaction control is illegal inside a plpgsql
    -- EXCEPTION subtransaction. On failure the error propagates, the signature
    -- is never seeded, and the next run retries the cold path — fail-safe
    -- direction is REBUILD, same as the FIX-652 gate.
    --
    -- FIX-1028 NOTE: this path is therefore the one place in the sweep that
    -- CANNOT carry a query_canceled handler — the language forbids it. A cancel
    -- inside the cold-start backfill still strands the running row for the
    -- reaper. That is a structural consequence of CALLing a COMMITting
    -- procedure, not an oversight; the fix would be to inline the backfill's
    -- chunk loop here, which is out of scope for this sweep. Path 3 below (the
    -- steady-state path, and the only one a scheduled firing takes once the
    -- signature store is warm) IS protected.
    CALL public.backfill_official_sector_affinity_rollup();

    DELETE FROM public.donor_industry_tag_state;
    INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
    SELECT et.entity_id,
           md5(string_agg(et.tag, ',' ORDER BY et.tag)),
           count(*)::int,
           clock_timestamp()   -- FIX-981: after the backfill's per-chunk COMMITs
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();

    UPDATE public.data_sync_log
       SET status = 'complete', completed_at = clock_timestamp(),
           metadata = metadata || jsonb_build_object(
             'sig', v_live_sig,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;

    RAISE NOTICE '[sector-affinity tag refresh] full backfill (%) — signature store seeded (%)',
      v_reason, v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 3: targeted — diff the per-donor shadow, rebuild only the affected ─
  WITH cur AS (
    SELECT et.entity_id AS donor_id,
           md5(string_agg(et.tag, ',' ORDER BY et.tag)) AS sig,
           count(*)::int AS n
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id
  )
  SELECT array_agg(donor_id) INTO v_donors
    FROM (
      SELECT COALESCE(c.donor_id, s.donor_id) AS donor_id
        FROM cur c
        FULL OUTER JOIN public.donor_industry_tag_state s ON s.donor_id = c.donor_id
       WHERE c.donor_id IS NULL                       -- tags removed entirely
          OR s.donor_id IS NULL                       -- newly tagged donor
          OR c.sig IS DISTINCT FROM s.tag_sig
          OR c.n   IS DISTINCT FROM s.tag_count
    ) d;

  v_n_donors := COALESCE(array_length(v_donors, 1), 0);

  -- v_n_donors = 0 with a moved global signature means tags changed between the
  -- signature capture and this diff (the shadow was already advanced past the
  -- captured signature by content that arrived mid-scan). Nothing to rebuild
  -- for THIS signature; the newer content re-diffs on the next run. Advance and
  -- log donors_changed=0 — self-healing by construction.
  IF v_n_donors > 0 THEN
    SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
      FROM unnest(v_donors) AS d(id)
      JOIN public.financial_relationships fr ON fr.from_id = d.id
     WHERE fr.relationship_type = 'donation'
       AND fr.from_type = 'financial_entity'
       AND fr.to_type   = 'official'
       AND fr.amount_cents > 0;
    v_n_off := COALESCE(array_length(v_officials, 1), 0);
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('sector_affinity_tag_refresh', 'running', v_started,
          jsonb_build_object('path', 'targeted',
                             'reason', 'industry tag content signature changed',
                             'donors_changed', v_n_donors,
                             'officials_affected', v_n_off,
                             'sig_before', v_stored_sig,
                             'sig_after', v_live_sig))
  RETURNING id INTO v_log_id;
  COMMIT;

  WHILE v_i <= v_n_off LOOP
    v_chunk_ids := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n_off)];
    v_chunk_no  := v_chunk_no + 1;
    BEGIN
      v_n    := public.sector_affinity_rebuild_officials(v_chunk_ids);
      v_rows := v_rows + v_n;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its officials keep their PRIOR
      -- rollup rows (complete-if-stale) and the un-advanced signature re-derives
      -- the same diff next run.
      v_failures := v_failures || format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction (PL/pgSQL rule)
    -- FIX-1028 — stop the sweep; the remaining chunks would each re-arm the
    -- same axe, and the signature advance below is gated so the un-covered
    -- officials stay in the next run's diff.
    EXIT WHEN v_canceled IS NOT NULL;
    v_i := v_i + c_chunk;
  END LOOP;

  -- Advance shadow + signature only on a clean run. FIX-1028 adds the cancel
  -- arm: a cancelled run did not rebuild every affected official, so storing
  -- the new signature would drop the remainder out of the next run's diff
  -- forever.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    IF v_n_donors > 0 THEN
      DELETE FROM public.donor_industry_tag_state s
       WHERE s.donor_id = ANY (v_donors)
         AND NOT EXISTS (
           SELECT 1 FROM public.entity_tags et
            WHERE et.entity_type  = 'financial_entity'
              AND et.tag_category = 'industry'
              AND et.entity_id    = s.donor_id);

      INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
      SELECT et.entity_id,
             md5(string_agg(et.tag, ',' ORDER BY et.tag)),
             count(*)::int,
             clock_timestamp()   -- FIX-981: after the chunk loop's COMMITs
        FROM unnest(v_donors) AS d(id)
        JOIN public.entity_tags et ON et.entity_id = d.id
       WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
       GROUP BY et.entity_id
      ON CONFLICT (donor_id) DO UPDATE
        SET tag_sig = EXCLUDED.tag_sig,
            tag_count = EXCLUDED.tag_count,
            updated_at = clock_timestamp();
    END IF;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  UPDATE public.data_sync_log
     SET status        = CASE
                             WHEN v_canceled IS NOT NULL          THEN 'partial'
                             WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                             ELSE 'complete'
                           END,
         completed_at  = clock_timestamp(),
         rows_inserted = v_rows,
         rows_failed   = COALESCE(array_length(v_failures, 1), 0),
         error_message = CASE
                           WHEN v_canceled IS NOT NULL
                             THEN left(format('canceled — %s; signature unmoved, the remaining officials stay in the next diff', v_canceled), 1000)
                           WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL
                         END,
         metadata      = metadata || jsonb_build_object(
                           'rollup_rows', v_rows,
                           'chunks', v_chunk_no,
                           'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                           'canceled', v_canceled IS NOT NULL,
                           'cancel_detail', v_canceled,
                           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
   WHERE id = v_log_id;

  RAISE NOTICE '[sector-affinity tag refresh] % — % donor(s) changed, % official(s) in % chunk(s), % rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_n_donors, v_n_off, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.refresh_sector_affinity_from_tag_changes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_sector_affinity_from_tag_changes() TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. donor_rollup_rebuild_bulk() — manual break-glass, not on cron
--
-- Handler + truthful chunk/terminal timestamps only. Its watermark write stays
-- at the end of the run: this is the re-runnable bulk path, a re-CALL resumes
-- from the committed cursor, and changing that is out of scope for this sweep.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_state_key  text   := 'donor_rollup_bulk_sweep';
  c_global     uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks     int    := 32;      -- must divide 256 (uuid first-byte ranges)
  c_budget     interval := interval '4 hours 30 minutes';
  c_max_sweep  interval := interval '48 hours';

  v_state      jsonb;
  v_cursor     int;
  v_mode       text;
  v_resumed    boolean := false;
  v_restarted  text    := NULL;
  v_sweep_beg  timestamptz;
  v_sweep_tgt  timestamptz;
  v_watermark  timestamptz;
  v_log_id     uuid;
  v_cfg        int;
  v_cfg_txt    text;
  v_step       int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- This is the manual break-glass bulk path, so the axe here is normally an
  -- operator cancel or the 6h role default rather than a cron budget — the
  -- stranding is identical either way.
  v_canceled   text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_n_targets  int := 0;
  v_n_offic    int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_done       int := 0;
  k            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_bulk', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason',
              'advisory lock held by a concurrent donor-rollup refresh (incremental or bulk)'));
    RAISE NOTICE '[donor-rollup bulk] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_budget_seconds', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_cfg);
  END IF;

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunks', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    IF v_cfg NOT IN (16, 32, 64, 128, 256) THEN
      PERFORM pg_advisory_unlock(c_lock_key);
      RAISE EXCEPTION 'civitics.donor_rollup_bulk_chunks must be one of 16/32/64/128/256 (got %)', v_cfg;
    END IF;
    c_chunks := v_cfg;
  END IF;
  v_step := 256 / c_chunks;

  v_cfg_txt := NULLIF(current_setting('civitics.donor_rollup_bulk_mode', true), '');
  v_mode := COALESCE(v_cfg_txt, 'dirty');
  IF v_mode NOT IN ('dirty', 'full') THEN
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE EXCEPTION 'civitics.donor_rollup_bulk_mode must be ''dirty'' or ''full'' (got %)', v_mode;
  END IF;

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);
  v_sweep_beg := (v_state->>'sweep_started_at')::timestamptz;
  v_sweep_tgt := (v_state->>'sweep_target')::timestamptz;

  IF v_cursor >= 0 THEN
    v_resumed := true;
    IF (v_state->>'mode') IS DISTINCT FROM v_mode THEN
      v_restarted := format('mode changed %s -> %s', v_state->>'mode', v_mode);
    ELSIF COALESCE((v_state->>'chunks')::int, -1) <> c_chunks THEN
      v_restarted := format('chunk count changed %s -> %s', v_state->>'chunks', c_chunks);
    ELSIF v_sweep_beg IS NULL OR clock_timestamp() - v_sweep_beg > c_max_sweep THEN
      v_restarted := format('sweep started %s exceeds the %s staleness bound', v_sweep_beg, c_max_sweep);
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_targets LIMIT 1) THEN
      v_restarted := 'target staging empty (crash recovery truncates UNLOGGED tables)';
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_fe LIMIT 1) THEN
      v_restarted := 'donor-dimension staging empty (crash recovery truncates UNLOGGED tables)';
    END IF;
    IF v_restarted IS NOT NULL THEN
      RAISE NOTICE '[donor-rollup bulk] discarding in-flight sweep: %', v_restarted;
      v_cursor  := -1;
      v_resumed := false;
    END IF;
  END IF;

  IF v_cursor < 0 THEN
    -- FIX-974 follow-up: assert the from_type invariant BEFORE anything is
    -- written, so a violating sweep publishes nothing at all.
    PERFORM public.donor_rollup_bulk_assert_invariants();

    SELECT MAX(fr.updated_at) INTO v_sweep_tgt
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

    TRUNCATE public._drb_targets;
    IF v_mode = 'full' OR v_watermark IS NULL THEN
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    ELSE
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
          AND fr.updated_at > v_watermark
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    END IF;

    TRUNCATE public._drb_fe;
    INSERT INTO public._drb_fe (id, display_name, entity_type, state, industry_tag, industry_label)
    SELECT fe.id, fe.display_name, fe.entity_type, fe.metadata->>'state',
           t.tag, t.display_label
    FROM public.financial_entities fe
    LEFT JOIN (
      SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag, et.display_label
      FROM public.entity_tags et
      WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
      ORDER BY et.entity_id, et.tag
    ) t ON t.entity_id = fe.id;

    ANALYZE public._drb_targets;
    ANALYZE public._drb_fe;

    v_sweep_beg := clock_timestamp();   -- FIX-981: the instant, not the txn start
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks),
          updated_at = clock_timestamp();
  END IF;

  SELECT count(*), count(*) FILTER (WHERE is_official) INTO v_n_targets, v_n_offic
  FROM public._drb_targets;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_bulk', 'running', v_started,
          jsonb_build_object(
            'shape', 'to_id-range chunks, one FR scan per chunk, six arms derived',
            'mode', v_mode, 'chunks', c_chunks,
            'targets', v_n_targets, 'target_officials', v_n_offic,
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'sweep_target', v_sweep_tgt,
            'budget_seconds', EXTRACT(epoch FROM c_budget)))
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_chunk > 0
       AND v_elapsed + (v_max_chunk * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[donor-rollup bulk] budget guard — stopping before chunk % (elapsed %s, slowest %s)',
        k, round(v_elapsed)::int, round(v_max_chunk)::int;
      EXIT;
    END IF;

    v_lo := (lpad(to_hex(k * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid;
    v_hi := CASE WHEN k < c_chunks - 1
                 THEN (lpad(to_hex((k + 1) * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid
                 ELSE NULL END;
    v_chunk_beg := clock_timestamp();

    BEGIN
      TRUNCATE public._drb_donor;
      INSERT INTO public._drb_donor
        (to_id, relationship_type, from_id, total_cents, total_cents0, tx_count,
         small_cents, small_count, pos_cents, pos_count)
      SELECT
        fr.to_id,
        fr.relationship_type::text,
        fr.from_id,
        SUM(fr.amount_cents)::bigint,
        SUM(COALESCE(fr.amount_cents, 0))::bigint,
        COUNT(*)::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0))::bigint
      FROM public.financial_relationships fr
      JOIN public._drb_targets t ON t.to_id = fr.to_id
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_id >= v_lo
        AND (v_hi IS NULL OR fr.to_id < v_hi)
      GROUP BY fr.to_id, fr.relationship_type, fr.from_id;

      TRUNCATE public._drb_chunk_fe;
      INSERT INTO public._drb_chunk_fe (id, display_name, entity_type, state, industry_tag, industry_label)
      SELECT f.id, f.display_name, f.entity_type, f.state, f.industry_tag, f.industry_label
      FROM public._drb_fe f
      WHERE f.id IN (SELECT DISTINCT d.from_id FROM public._drb_donor d);

      ANALYZE public._drb_donor;
      ANALYZE public._drb_chunk_fe;

      DELETE FROM public.official_donor_rollup_mv m
       WHERE m.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH ranked AS (
        SELECT d.to_id AS official_id, d.relationship_type, d.from_id AS donor_id,
               d.total_cents, d.tx_count,
               ROW_NUMBER() OVER (PARTITION BY d.to_id, d.relationship_type
                                  ORDER BY d.total_cents DESC, d.from_id) AS rn
        FROM public._drb_donor d
      ),
      top_rows AS (
        SELECT r.official_id, r.relationship_type, r.rn::int AS rank, r.donor_id,
               fe.display_name, fe.entity_type, fe.industry_tag, fe.industry_label,
               r.total_cents, r.tx_count, NULL::bigint AS tail_donor_count
        FROM ranked r
        LEFT JOIN public._drb_chunk_fe fe ON fe.id = r.donor_id
        WHERE r.rn <= 200
      ),
      tail_rows AS (
        SELECT r.official_id, r.relationship_type, 201 AS rank, NULL::uuid, NULL::text,
               NULL::text, NULL::text, NULL::text,
               SUM(r.total_cents)::bigint, SUM(r.tx_count)::bigint, COUNT(*)::bigint
        FROM ranked r WHERE r.rn > 200
        GROUP BY r.official_id, r.relationship_type
      ),
      ins AS (
        INSERT INTO public.official_donor_rollup_mv (
          official_id, relationship_type, rank, donor_id, donor_name, entity_type,
          industry_tag, industry_label, total_cents, tx_count, tail_donor_count)
        SELECT * FROM top_rows UNION ALL SELECT * FROM tail_rows
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_n FROM ins;
      v_rows := v_rows + v_n;

      DELETE FROM public.official_donor_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_donor_totals
        (official_id, total_cents, pac_cents, individual_cents, donor_count, updated_at)
      SELECT d.to_id,
             SUM(d.total_cents0)::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
             SUM(d.tx_count)::bigint,
             -- FIX-981: was the column DEFAULT now(), i.e. the START of this
             -- chunk's transaction, N COMMITs into the sweep.
             clock_timestamp()
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_small_dollar_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_small_dollar_rollup
        (official_id, small_dollar_cents, small_dollar_count, updated_at)
      SELECT d.to_id, SUM(d.small_cents)::bigint, SUM(d.small_count)::bigint, clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_sector_affinity_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_sector_affinity_rollup
        (official_id, industry, total_cents, donor_count, updated_at)
      SELECT d.to_id,
             COALESCE(fe.industry_tag, 'Untagged'),
             SUM(d.pos_cents)::bigint,
             COUNT(*)::bigint,
             clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
        AND d.pos_cents > 0
      GROUP BY d.to_id, COALESCE(fe.industry_tag, 'Untagged');

      DELETE FROM public.treemap_individuals_rollup x
       WHERE x.scope_id <> c_global
         AND x.scope_id IN (
           SELECT t.to_id FROM public._drb_targets t
            WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH per_name AS (
        SELECT d.to_id AS scope_id,
               COALESCE(fe.state, '??') AS state,
               fe.display_name          AS donor_name,
               SUM(d.pos_cents)::bigint AS total_cents,
               SUM(d.pos_count)::bigint AS donation_count
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
        GROUP BY d.to_id, COALESCE(fe.state, '??'), fe.display_name
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY scope_id, state
                                     ORDER BY total_cents DESC, donor_name) AS rank
        FROM per_name
      )
      INSERT INTO public.treemap_individuals_rollup
        (scope_id, state, rank, donor_name, total_cents, donation_count)
      SELECT scope_id, state, rank::int, donor_name, total_cents, donation_count
      FROM ranked WHERE rank <= 50;

      DELETE FROM public.official_donor_bracket_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH bucketed AS (
        SELECT d.to_id AS official_id, d.pos_cents AS donor_cents,
               CASE WHEN d.pos_cents >= 1000000 THEN 'mega'
                    WHEN d.pos_cents >=  250000 THEN 'major'
                    WHEN d.pos_cents >=   50000 THEN 'mid'
                    ELSE                              'small' END AS tier
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
      )
      INSERT INTO public.official_donor_bracket_totals (official_id, tier, total_cents, donor_count)
      SELECT official_id, tier, SUM(donor_cents)::bigint, COUNT(*)::bigint
      FROM bucketed GROUP BY official_id, tier;

      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object('chunk_cursor', k),
             updated_at = clock_timestamp()
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. The cursor is written INSIDE this chunk's
    -- transaction, so a cancelled chunk rolls back together with its cursor
    -- advance and the next CALL resumes at exactly k.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % CANCELED (statement_timeout or operator cancel): %', k, SQLERRM;
    WHEN OTHERS THEN
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_canceled IS NOT NULL;
    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;

    v_done := v_done + 1;
    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    RAISE NOTICE '[donor-rollup bulk] chunk %/% done (%s, % arm-1 rows so far)',
      k + 1, c_chunks, round(v_chunk_secs)::int, v_rows;
  END LOOP;

  -- FIX-1028 — cancelled is PARTIAL and RESUMABLE. The bulk path's watermark
  -- write is at the very end and stays there (this is the manual, re-runnable
  -- path — a re-CALL resumes from the committed cursor), but the ROW now closes
  -- itself instead of sitting 'running' until the reaper.
  IF v_canceled IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = left(format('canceled — %s; resumable at chunk %s of %s', v_canceled,
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks), 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'canceled', true, 'cancel_detail', v_canceled,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE WARNING '[donor-rollup bulk] CANCELED — partial, resumable; re-CALL to continue';
    RETURN;
  END IF;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  IF v_budget_hit THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[donor-rollup bulk] PARTIAL — resumable; re-CALL to continue';
    RETURN;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, clock_timestamp())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, clock_timestamp())::text),
        updated_at = clock_timestamp();

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', clock_timestamp()::text,   -- FIX-981
                                    'mode', v_mode, 'chunks', c_chunks,
                                    'targets', v_n_targets),
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  TRUNCATE public._drb_donor;
  TRUNCATE public._drb_chunk_fe;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'chunks_done_this_run', v_done,
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
           'watermark_advanced_to', v_sweep_tgt)
   WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup bulk] complete — % targets, % arm-1 rows', v_n_targets, v_rows;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.donor_rollup_rebuild_bulk() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.donor_rollup_rebuild_bulk() TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- FIX-981 — the two chunk-scoped rebuild FUNCTIONs
--
-- These are FUNCTIONs: they cannot COMMIT, and they run INSIDE their caller's
-- chunk transaction (backfill_official_{small_dollar,sector_affinity}_rollup,
-- and refresh_sector_affinity_from_tag_changes' targeted path). So `now()` here
-- is the START of the enclosing chunk's transaction, N COMMITs into a backfill
-- that can run for tens of minutes — not the instant the row was written.
-- Nothing on prod reads either rollup's updated_at as a watermark (checked
-- against pg_proc), so this is a pure observability correction.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sector_affinity_rebuild_officials(p_recipients uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_sector_affinity_rollup
   WHERE official_id = ANY (p_recipients);

  WITH per_donor AS (
    SELECT
      fr.to_id                     AS official_id,
      fr.from_id                   AS donor_id,
      SUM(fr.amount_cents)::bigint  AS cents
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'
      AND fr.to_type           = 'official'
      AND fr.amount_cents > 0
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id, fr.from_id
  ),
  donor_tag AS (
    -- One deterministic (smallest) industry tag per donor — same pick as the
    -- FIX-518/704 `ind` CTE / fetchIndustryTagsByEntityId. Scoped to this chunk's
    -- donors so it stays an index probe.
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id AS donor_id,
      et.tag       AS industry
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
      AND et.entity_id IN (SELECT donor_id FROM per_donor)
    ORDER BY et.entity_id, et.tag
  ),
  by_sector AS (
    SELECT
      pd.official_id,
      COALESCE(dt.industry, 'Untagged') AS industry,
      SUM(pd.cents)::bigint             AS total_cents,
      COUNT(*)::bigint                  AS donor_count   -- per_donor is 1 row/donor → distinct donors
    FROM per_donor pd
    LEFT JOIN donor_tag dt ON dt.donor_id = pd.donor_id
    GROUP BY pd.official_id, COALESCE(dt.industry, 'Untagged')
  ),
  ins AS (
    INSERT INTO public.official_sector_affinity_rollup
      (official_id, industry, total_cents, donor_count, updated_at)
    -- FIX-981: was now() — the caller's chunk-transaction start, not this write.
    SELECT official_id, industry, total_cents, donor_count, clock_timestamp() FROM by_sector
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.sector_affinity_rebuild_officials(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sector_affinity_rebuild_officials(uuid[]) TO service_role;


CREATE OR REPLACE FUNCTION public.small_dollar_rebuild_officials(p_recipients uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_small_dollar_rollup
   WHERE official_id = ANY (p_recipients);

  WITH sub AS (
    -- All cycles, matching the all-cycle grain of the FR aggregation below and
    -- of officials.total_received_cents. Individual-donor sources only.
    SELECT b.recipient_id AS official_id,
           SUM(b.total_cents)::bigint AS sub_floor_cents,
           SUM(b.donor_count)::bigint AS sub_floor_donor_count
      FROM public.small_dollar_bracket_rollup b
     WHERE b.recipient_type = 'official'
       AND b.source         = 'fec_bulk_indiv'
       AND b.recipient_id   = ANY (p_recipients)
     GROUP BY b.recipient_id
  ),
  ins AS (
    INSERT INTO public.official_small_dollar_rollup
      (official_id, small_dollar_cents, small_dollar_count,
       sub_floor_cents, sub_floor_donor_count, updated_at)
    SELECT
      fr.to_id,
      COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
      (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
      COALESCE(MAX(sub.sub_floor_cents),       0)::bigint,
      COALESCE(MAX(sub.sub_floor_donor_count), 0)::bigint,
      clock_timestamp()   -- FIX-981
    FROM public.financial_relationships fr
    LEFT JOIN sub ON sub.official_id = fr.to_id
    WHERE fr.to_type           = 'official'
      AND fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'   -- 100% of donation→official; enables the FIX-704 idx
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  -- An official can have bracketed sub-floor money and ZERO itemized donation
  -- FRs (every one of their donors stayed under $200). The FR-driven INSERT
  -- above emits nothing for them, so they would read as "absent ⇒ live-compute
  -- fallback" forever and their residual would never surface. Add them.
  INSERT INTO public.official_small_dollar_rollup
    (official_id, small_dollar_cents, small_dollar_count,
     sub_floor_cents, sub_floor_donor_count, updated_at)
  SELECT b.recipient_id, 0, 0,
         SUM(b.total_cents)::bigint,
         SUM(b.donor_count)::bigint,
         clock_timestamp()   -- FIX-981
    FROM public.small_dollar_bracket_rollup b
   WHERE b.recipient_type = 'official'
     AND b.source         = 'fec_bulk_indiv'
     AND b.recipient_id   = ANY (p_recipients)
   GROUP BY b.recipient_id
  ON CONFLICT (official_id) DO NOTHING;

  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.small_dollar_rebuild_officials(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.small_dollar_rebuild_officials(uuid[]) TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- FIX-979 (remainder) — the four single-row backfill writers
--
-- Each closes with ONE statement carrying `now(), now()`, so every row it has
-- ever written reads completed_at - started_at = 0.000000 and
-- pipeline_runtime_stats_mv renders the run as 0 ms. These procedures COMMIT
-- per chunk, so the trailing now() is the start of the transaction that began
-- after the LAST chunk — i.e. BOTH columns are wrong, not just one, exactly as
-- FIX-979 found for refresh_agency_staffing_rollup.
--
-- Shape is FIX-979's: capture v_started := clock_timestamp() at block entry,
-- stamp the exit with clock_timestamp(). Nothing else changes.
--
-- These four are unscheduled (no cron.job references them; they are called by
-- hand or by refresh_sector_affinity_from_tag_changes' cold path), so they do
-- not carry a data_sync_log 'running' row and are NOT in the FIX-1028 handler
-- population — a cancel loses the terminal row entirely rather than stranding
-- it. That is a real but separate gap, and it is recorded rather than widened
-- here.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.backfill_official_donor_brackets()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('official_donor_brackets_backfill')::bigint;
  c_chunk    int    := 300;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
  v_started   timestamptz := clock_timestamp();   -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donor-brackets backfill] advisory lock held — skipping';
    RETURN;
  END IF;
  SET work_mem = '256MB';

  -- FIX-869: officials with ≥1 positive individual donation, from the tiny FIX-836
  -- summary (was a whole-FR-table array_agg(DISTINCT) scan). Set-equal to the old
  -- scan (gate: 3904==3904, 0 symmetric diff, local+prod).
  SELECT array_agg(official_id) INTO v_officials
  FROM public.official_donor_totals
  WHERE individual_cents > 0;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.treemap_individual_brackets_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('official_donor_brackets_backfill', 'complete', v_started, clock_timestamp(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no, 'driver', 'manual'));
  RAISE NOTICE '[donor-brackets backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.backfill_official_donor_brackets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.backfill_official_donor_brackets() TO service_role;


CREATE OR REPLACE PROCEDURE public.backfill_official_sector_affinity_rollup()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('official_sector_affinity_rollup_backfill')::bigint;
  c_chunk    int    := 500;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
  v_started   timestamptz := clock_timestamp();   -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[sector-affinity backfill] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  -- FIX-869: all officials with ≥1 donation, from the tiny FIX-836 summary (was a
  -- whole-FR-table array_agg(DISTINCT) scan). Set-equal to the old scan
  -- (gate: 4207==4207, 0 symmetric diff, local+prod). The old scan was already
  -- donation-only; all-rows preserves it (IE-only recipients remain out of scope).
  SELECT array_agg(official_id) INTO v_officials
  FROM public.official_donor_totals;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.sector_affinity_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('sector_affinity_rollup_backfill', 'complete', v_started, clock_timestamp(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));

  RAISE NOTICE '[sector-affinity backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.backfill_official_sector_affinity_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.backfill_official_sector_affinity_rollup() TO service_role;


CREATE OR REPLACE PROCEDURE public.backfill_official_small_dollar_rollup()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('official_small_dollar_rollup_backfill')::bigint;
  c_chunk    int    := 500;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
  v_started   timestamptz := clock_timestamp();   -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[small-dollar backfill] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT array_agg(id) INTO v_officials
  FROM (
    SELECT DISTINCT fr.to_id AS id
      FROM public.financial_relationships fr
     WHERE fr.to_type           = 'official'
       AND fr.relationship_type = 'donation'
       AND fr.from_type         = 'financial_entity'
    UNION
    SELECT DISTINCT b.recipient_id AS id           -- FIX-1068
      FROM public.small_dollar_bracket_rollup b
     WHERE b.recipient_type = 'official'
  ) s;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.small_dollar_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;  -- bounds txn size + advances xmin between chunks
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('small_dollar_rollup_backfill', 'complete', v_started, clock_timestamp(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no, 'fix', 'FIX-1068'));

  RAISE NOTICE '[small-dollar backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.backfill_official_small_dollar_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.backfill_official_small_dollar_rollup() TO service_role;


CREATE OR REPLACE PROCEDURE public.backfill_treemap_individuals_focused()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('treemap_individuals_focused_backfill')::bigint;
  c_chunk    int    := 300;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
  v_started   timestamptz := clock_timestamp();   -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[treemap-focused backfill] advisory lock held — skipping';
    RETURN;
  END IF;
  SET work_mem = '256MB';

  -- FIX-779b: officials with >=1 positive individual donation, from the tiny
  -- FIX-836 summary (was a ~2.8M-row scan + 1M-row DISTINCT sort).
  SELECT array_agg(official_id) INTO v_officials
  FROM public.official_donor_totals
  WHERE individual_cents > 0;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.treemap_individuals_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('treemap_individuals_focused_backfill', 'complete', v_started, clock_timestamp(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));
  RAISE NOTICE '[treemap-focused backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.backfill_treemap_individuals_focused() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.backfill_treemap_individuals_focused() TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- FIX-994 — reconcile_recipient_count()
--
-- The zero-span writer. It runs a 16-window loop with a COMMIT per window and
-- then writes ONE terminal row with `now(), now()`, so a run that takes an hour
-- records a zero-second duration STARTING at the transaction that began after
-- the sixteenth commit — the timestamp is not just spanless, it is at the wrong
-- end of the run.
--
-- (The FIX-994 bullet attributes this to reconcile_financial_entity_totals().
-- That procedure opens a 'running' row and closes it with a trailing UPDATE and
-- never had the defect. The bullet's attribution is wrong; this is the writer.)
--
-- It is unscheduled break-glass (monthly post-VACUUM, by hand — nothing in
-- cron.job CALLs it), so it also records metadata.driver = 'manual'. It gets
-- the FIX-1028 handler as well: its per-window loop already COMMITs, so a
-- cancel today loses the terminal row ENTIRELY and the run leaves no trace at
-- all. The windows it did commit are real work and now get reported.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.reconcile_recipient_count()
LANGUAGE plpgsql
AS $proc$
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
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-994 / FIX-979
  v_windows  int := 0;
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
      v_windows := v_windows + 1;
      RAISE NOTICE '  [reconcile-rc] window %/16 — % rows', i, v_n;
    EXCEPTION
    WHEN query_canceled THEN                           -- FIX-1028, by name, first
      v_canceled := format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [reconcile-rc] window %/16 CANCELED (statement_timeout or operator cancel): %', i, SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [reconcile-rc] window %/16 FAILED: %', i, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
    EXIT WHEN v_canceled IS NOT NULL;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, rows_failed, error_message, metadata)
  VALUES ('recipient_count_reconcile',
          CASE
            WHEN v_canceled IS NOT NULL          THEN 'partial'
            WHEN array_length(v_failures, 1) > 0 THEN 'failed'
            ELSE 'complete'
          END,
          -- FIX-994: v_started is the real entry time and clock_timestamp() is
          -- the real exit. Both used to be now() in this ONE statement, i.e.
          -- transaction_timestamp() of the txn that began after window 16.
          v_started, clock_timestamp(), v_total,
          COALESCE(array_length(v_failures, 1), 0),
          CASE
            WHEN v_canceled IS NOT NULL
              THEN left(format('canceled — %s', v_canceled), 1000)
            WHEN array_length(v_failures, 1) > 0
              THEN left(array_to_string(v_failures, '; '), 1000)
            ELSE NULL
          END,
          jsonb_build_object(
            'source', 'manual', 'kind', 'fr-full-recompute',
            -- FIX-994 / FIX-1059: this procedure is not on any schedule, so a
            -- registry that derives "expected pipelines" from cron.job must not
            -- expect it. Say so in the row itself.
            'driver', 'manual',
            'windows_done', v_windows,
            'canceled', v_canceled IS NOT NULL,
            'cancel_detail', v_canceled,
            'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int));

  RAISE NOTICE '[reconcile-rc] % — recipient_count recomputed, % rows (% of 16 windows, % failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_total, v_windows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.reconcile_recipient_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_recipient_count() TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- FIX-1108 — refresh_agency_staffing_rollup(), the budgeted target the
-- census-by-'running'-row MISSED.
--
-- jobid 25, agency-staffing-rollup-refresh, cron_job_budget 3,600 s, ACTIVE.
--
-- It does not open a data_sync_log 'running' row and does not write a
-- pipeline_state watermark, so it falls outside the FIX-1028 census predicate
-- that found the other eleven. It nevertheless has the same defect in its most
-- absolute form: it COMMITs per 50-agency chunk and writes ONE terminal row
-- after the loop, with no EXCEPTION handling anywhere. When the watchdog
-- cancels it, that INSERT never runs and the firing leaves NO TRACE IN
-- data_sync_log AT ALL — not a stranded 'running' row the reaper can close, but
-- silence. The FIX-944 rollup watcher then reports it as "never reached
-- complete" with nothing to explain why, and the committed chunks are
-- invisible.
--
-- It is in scope because FIX-1108's re-audit criterion is "every job in
-- cron_job_budget has a handler", not "every routine that opens a running row".
-- The cross-check that found it: every routine CALLed from cron.job that
-- contains COMMIT and lacks query_canceled. That walk returns eleven names on
-- prod; nine are above, this is the tenth, and the eleventh is
-- purge_abuse_events (examined and deliberately unchanged — it keeps no
-- bookkeeping, writes no log row and no watermark, and its batch DELETEs are
-- self-resuming on a time predicate, so a cancel loses nothing).
--
-- MINIMAL CHANGE, ON PURPOSE. The chunk loop has no EXCEPTION block today, so
-- adding one with `WHEN OTHERS` would silently convert a raising chunk from
-- "abort the procedure" into "carry on" — a failure-semantics change nobody
-- asked for. The block below catches ONLY query_canceled; every other error
-- still propagates exactly as it does today.
--
-- Timestamps here were already correct (FIX-979 fixed them); only the status,
-- error_message and cancel metadata are new.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.refresh_agency_staffing_rollup()
LANGUAGE plpgsql
AS $proc$
DECLARE
  c_lock_key bigint := hashtext('agency_staffing_rollup_refresh')::bigint;
  c_chunk    int    := 50;
  v_agencies uuid[];
  v_chunk    uuid[];
  v_n        int;
  v_i        int := 1;
  v_chunk_no int := 0;
  v_rows     bigint := 0;
  v_n_ins    bigint;
  -- FIX-979: survives the per-chunk COMMITs; now() would not.
  v_started  timestamptz := clock_timestamp();
  -- FIX-1028/1108: non-NULL once a query_canceled (57014) has been caught.
  v_canceled text := NULL;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[agency-staffing refresh] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT array_agg(id ORDER BY id) INTO v_agencies FROM public.agencies;
  v_n := COALESCE(array_length(v_agencies, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_agencies[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    BEGIN
      v_n_ins := public.agency_staffing_rebuild_agencies(v_chunk);
      v_rows  := v_rows + v_n_ins;
    EXCEPTION
    -- ONLY query_canceled. No WHEN OTHERS — this loop had no handler at all
    -- before, and every other error must keep propagating out of the procedure
    -- exactly as it does today.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (agencies %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n), SQLERRM);
      RAISE WARNING '[agency-staffing refresh] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
    EXIT WHEN v_canceled IS NOT NULL;
    v_i := v_i + c_chunk;
  END LOOP;

  -- Reached on a cancel now, instead of being jumped over. Every chunk that
  -- COMMITted is real work and is reported; the rollup is per-agency, so a
  -- partial pass leaves the un-reached agencies on their PRIOR rows
  -- (complete-if-stale) and the next firing redoes the whole list.
  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, error_message, metadata)
  VALUES ('agency_staffing_rollup_refresh',
          CASE WHEN v_canceled IS NOT NULL THEN 'partial' ELSE 'complete' END,
          v_started, clock_timestamp(), v_rows,
          CASE WHEN v_canceled IS NOT NULL
               THEN left(format('canceled — %s', v_canceled), 1000) ELSE NULL END,
          jsonb_build_object(
            'agencies', v_n, 'chunks', v_chunk_no, 'source', 'pg_cron/backfill',
            'canceled', v_canceled IS NOT NULL,
            'cancel_detail', v_canceled,
            'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int));

  RAISE NOTICE '[agency-staffing refresh] % — % agencies in % chunks',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED' ELSE 'complete' END, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$proc$;

REVOKE ALL ON PROCEDURE public.refresh_agency_staffing_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_agency_staffing_rollup() TO service_role;
