-- verify_fix950_guards.sql — CALL every guarded procedure with a supervised
-- prod session held, and prove each one stands down: a `skipped` row with this
-- session's reason, in well under a second, with its own advisory lock RELEASED.
--
-- LOCAL ONLY.
--
--     psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--          -v ON_ERROR_STOP=1 -f supabase/tests/verify_fix950_guards.sql
--
-- BARE psql, deliberately — NOT scripts/db-query.mjs, which passes
-- --single-transaction. Several of these procedures COMMIT between chunks, and
-- a COMMIT inside an explicit transaction block raises `invalid transaction
-- termination`. Same constraint as verify_fix1002.sql and the FIX-717/718
-- CALL-with-COMMIT rollups.
--
-- WHY THIS EXISTS RATHER THAN A REVIEW OF THE MIGRATION. The migration's bodies
-- are already proved equal to the live ones byte for byte (the md5 walk in the
-- FIX-950 report), so "did the guard get inserted" is not the question. The
-- question is whether it FIRES, and whether it fires CLEANLY — a guard that
-- returns while still holding the procedure's own advisory lock would convert a
-- one-firing deferral into a permanent one, because the next firing would find
-- the lock held and skip for the wrong reason forever. That failure is
-- invisible to code review and to any test that only reads data_sync_log, so
-- the lock census below is the load-bearing assertion here.
--
-- THE UNHELD PATH is checked too. A guard that fired unconditionally would pass
-- every assertion above and take the platform down.

\set ON_ERROR_STOP on
SET statement_timeout = 0;
-- Local Docker has /dev/shm = 64MB; parallel workers on these arms can exhaust
-- it. Session-scoped, mirrors donor-rollup-bulk.ts's local branch.
SET max_parallel_workers_per_gather = 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Claim the session from THIS psql backend, exactly as session:claim-prod does.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_advisory_lock(hashtext('prod_supervised_session')::bigint) AS _claim \gset

INSERT INTO public.pipeline_state (key, value, updated_at)
VALUES ('prod_session',
        jsonb_build_object('reason', 'verify_fix950_guards',
                           'claimed_by', 'verify_fix950_guards@localhost',
                           'claimed_at', clock_timestamp()::text,
                           'expected_minutes', 5,
                           'pid', pg_backend_pid()),
        now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

DROP TABLE IF EXISTS fix950_marker;
CREATE TABLE fix950_marker AS SELECT clock_timestamp() AS t0;

DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF NOT (s->>'defer')::boolean THEN RAISE EXCEPTION 'setup: the session did not take: %', s; END IF;
  RAISE NOTICE 'session claimed: %', s->>'reason_text';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CALL all twenty. Each must return immediately via its guard.
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration B — the rollup-refresh family
CALL public.refresh_derived_mvs('daily');
CALL public.refresh_official_donor_rollup_incremental();
CALL public.donor_rollup_rebuild_bulk();
CALL public.refresh_donor_party_rollup_incremental();
CALL public.refresh_financial_entity_totals_incremental();
CALL public.refresh_sector_affinity_from_tag_changes();
CALL public.refresh_treemap_individuals_global();
CALL public.refresh_agency_staffing_rollup();
CALL public.run_group_donor_rollup_refresh();
CALL public.refresh_contract_flow_rollups();
-- Migration C — the rebuild / crawl / tagger / reconcile family
CALL public.run_entity_connections_rebuild('incremental', p_max_units := 1);
CALL public.run_fe_totals_crawl(p_max_units := 1);
CALL public.run_rule_taggers('daily');
CALL public.rebuild_entity_connection_stats();
CALL public.rebuild_official_vote_stats();
CALL public.reconcile_donation_edge_orphans();
CALL public.reconcile_donor_party_rollup_orphans();
CALL public.reconcile_donor_rollup_orphans();
CALL public.reconcile_entity_connection_stats_orphans();
CALL public.reconcile_financial_entity_totals();

-- ─────────────────────────────────────────────────────────────────────────────
-- Assert: twenty skip rows, one per CALL, all carrying THIS session's reason.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_t0       timestamptz := (SELECT t0 FROM fix950_marker);
  v_expected CONSTANT text[] := ARRAY[
    'refresh_derived_mvs', 'donor_rollup_refresh', 'donor_party_rollup_refresh',
    'financial_entity_totals_refresh', 'sector_affinity_tag_refresh',
    'treemap_individuals_global_refresh', 'agency_staffing_rollup_refresh',
    'group_donor_rollup_refresh', 'contract_flow_rollups_rebuild',
    'entity_connections_rebuild', 'run_rule_taggers',
    'entity_connection_stats_rebuild', 'official_vote_stats_rebuild',
    'donation_edge_orphan_sweep', 'donor_party_rollup_orphan_sweep',
    'donor_rollup_orphan_sweep', 'entity_connection_stats_orphan_sweep',
    'financial_entity_totals_reconcile'
  ];
  v_rows     bigint;
  v_missing  text[];
  v_secs     numeric;
BEGIN
  SELECT count(*) INTO v_rows
    FROM public.data_sync_log
   WHERE started_at >= v_t0
     AND status = 'skipped'
     AND metadata->>'skip_reason' = 'prod session held: verify_fix950_guards';

  -- Twenty CALLs, eighteen distinct pipeline names: donor_rollup_refresh is
  -- written by both the incremental and the bulk procedure, and
  -- financial_entity_totals_refresh by both the incremental and the crawl.
  IF v_rows <> 20 THEN
    RAISE EXCEPTION 'expected 20 prod-session skip rows, found %', v_rows;
  END IF;

  SELECT array_agg(e) INTO v_missing
    FROM unnest(v_expected) e
   WHERE NOT EXISTS (
     SELECT 1 FROM public.data_sync_log d
      WHERE d.started_at >= v_t0
        AND d.status = 'skipped'
        AND d.pipeline = e
        AND d.metadata->>'skip_reason' = 'prod session held: verify_fix950_guards');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'no prod-session skip row for: %', v_missing;
  END IF;

  -- The holder is recorded, so an operator reading this row in six weeks knows
  -- who to ask rather than only that "someone" was on the box.
  IF EXISTS (
    SELECT 1 FROM public.data_sync_log
     WHERE started_at >= v_t0 AND status = 'skipped'
       AND metadata->>'skip_reason' = 'prod session held: verify_fix950_guards'
       AND metadata->>'held_by' IS DISTINCT FROM 'verify_fix950_guards@localhost')
  THEN
    RAISE EXCEPTION 'a skip row lost held_by';
  END IF;

  -- Every one of them declined a firing rather than doing work: twenty
  -- procedures, several of which take hours when they run, inside seconds.
  SELECT EXTRACT(epoch FROM (clock_timestamp() - v_t0)) INTO v_secs;
  IF v_secs > 30 THEN
    RAISE EXCEPTION 'twenty guarded CALLs took %s — a guard is not short-circuiting', round(v_secs);
  END IF;

  RAISE NOTICE 'guards fired ..................... OK (20 skip rows in %s)', round(v_secs, 1);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Assert: NOTHING is still held. This is the assertion that matters most — a
-- guard that returned without releasing its own lock would wedge that
-- procedure's every future firing behind a lock nobody owns.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF jsonb_array_length(to_jsonb(s->'live_writers')) > 0 THEN
    RAISE EXCEPTION 'a guarded procedure left its advisory lock held: %', s->'live_writers';
  END IF;
  RAISE NOTICE 'no writer lock stranded .......... OK';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Release, and prove the unheld path is NOT guarded.
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.pipeline_state WHERE key = 'prod_session';
SELECT pg_advisory_unlock(hashtext('prod_supervised_session')::bigint) AS _release \gset

DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF (s->>'defer')::boolean THEN RAISE EXCEPTION 'release did not clear the session: %', s; END IF;
  IF (s->>'label_present')::boolean THEN RAISE EXCEPTION 'release did not clear the label: %', s; END IF;
END $$;

DROP TABLE IF EXISTS fix950_marker2;
CREATE TABLE fix950_marker2 AS SELECT clock_timestamp() AS t0;

-- One real firing is enough to prove the guard is conditional. fe-crawl is the
-- one the prod receipt is taken against, and it is bounded to a single unit.
CALL public.run_fe_totals_crawl(p_max_units := 1);

DO $$
DECLARE
  v_t0 timestamptz := (SELECT t0 FROM fix950_marker2);
  v_n  bigint;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.data_sync_log
   WHERE started_at >= v_t0
     AND metadata->>'skip_reason' LIKE 'prod session held%';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'the guard fired with NO session held — % row(s)', v_n;
  END IF;

  -- It must have done SOMETHING: a real unit, or its own crawl_gate skip. Both
  -- are the normal path; neither is the prod-session guard.
  IF NOT EXISTS (SELECT 1 FROM public.data_sync_log
                  WHERE started_at >= v_t0
                    AND pipeline = 'financial_entity_totals_refresh') THEN
    RAISE WARNING 'fe-crawl wrote no row at all — check crawl_gate, not the guard';
  END IF;
  RAISE NOTICE 'unheld path unguarded ............ OK';
END $$;

DROP TABLE IF EXISTS fix950_marker;
DROP TABLE IF EXISTS fix950_marker2;

DO $$ BEGIN RAISE NOTICE 'verify_fix950_guards: ALL CASES PASSED'; END $$;
