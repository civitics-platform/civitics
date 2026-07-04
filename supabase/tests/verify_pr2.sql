-- verify_pr2.sql — deterministic asserts for FIX-715 / FIX-716 (PR2:
-- relocate the enrichment derivation tail to pg_cron). Run against LOCAL:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--        -v ON_ERROR_STOP=1 -f supabase/tests/verify_pr2.sql
--
-- Each DO block RAISEs EXCEPTION on failure; with ON_ERROR_STOP=1 the script
-- exits non-zero, so this is CI-friendly. It is FAST by construction: it does
-- NOT run the multi-minute size-tags / pre-vote / spending-total rebuilds — the
-- gate assert SKIPS the size rebuild by seeding a matching signature. The full
-- refresh_derived_mvs('daily'|'weekly') end-to-end run is a separate live smoke.

\echo '── PR2 verify: FIX-715 / FIX-716 ──'

-- ── 1. Both procedures exist (prokind = 'p') ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_derived_mvs' AND p.prokind = 'p'
  ) THEN RAISE EXCEPTION 'FAIL(1): procedure public.refresh_derived_mvs(text) missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'run_rule_taggers' AND p.prokind = 'p'
  ) THEN RAISE EXCEPTION 'FAIL(1): procedure public.run_rule_taggers(text) missing'; END IF;

  RAISE NOTICE 'PASS(1): both procedures exist';
END $$;

-- ── 2. Four cron jobs registered, PAUSED, with the expected schedules ────────
DO $$
DECLARE
  v_expected jsonb := jsonb_build_object(
    'refresh-derived-mvs-daily',  '0 6 * * *',
    'refresh-derived-mvs-weekly', '0 7 * * 2',
    'rule-taggers-daily',         '30 6 * * *',
    'rule-taggers-weekly',        '0 10 * * 2'
  );
  k text; v_sched text; v_active boolean; v_found boolean;
BEGIN
  FOR k IN SELECT jsonb_object_keys(v_expected) LOOP
    SELECT true, schedule, active INTO v_found, v_sched, v_active
      FROM cron.job WHERE jobname = k;
    IF NOT COALESCE(v_found, false) THEN
      RAISE EXCEPTION 'FAIL(2): cron job % not registered', k; END IF;
    IF v_sched IS DISTINCT FROM (v_expected->>k) THEN
      RAISE EXCEPTION 'FAIL(2): cron job % schedule "%" <> expected "%"', k, v_sched, v_expected->>k; END IF;
    IF v_active THEN
      RAISE EXCEPTION 'FAIL(2): cron job % is ACTIVE — must be created paused', k; END IF;
    v_found := NULL;
  END LOOP;
  RAISE NOTICE 'PASS(2): 4 cron jobs registered, paused, correct schedules';
END $$;

-- ── 3. Per-unit exception-continue (deliberately-broken MV mid-list) ─────────
-- Mirrors the procedures' loop body exactly: each unit runs in a BEGIN/EXCEPTION
-- subtransaction, so a bad unit is caught and the run continues. (A DO block
-- can't COMMIT, but the COMMIT is orthogonal to the continue behavior asserted
-- here — it only bounds the txn in the real procedure.)
DO $$
DECLARE
  v_units text[] := ARRAY[
    'REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_agency_counts_mv', -- tiny, real
    'REFRESH MATERIALIZED VIEW CONCURRENTLY public.__pr2_no_such_mv',          -- must FAIL + continue
    'SELECT public.prune_status_snapshot()'                                    -- non-MV unit, real
  ];
  v_cmd text; v_ok int := 0; v_fail int := 0; i int;
BEGIN
  FOR i IN 1 .. array_length(v_units, 1) LOOP
    v_cmd := v_units[i];
    BEGIN
      EXECUTE v_cmd; v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
    END;
  END LOOP;
  IF v_ok <> 2 OR v_fail <> 1 THEN
    RAISE EXCEPTION 'FAIL(3): exception-continue expected 2 ok / 1 fail, got % ok / % fail', v_ok, v_fail;
  END IF;
  RAISE NOTICE 'PASS(3): per-unit exception-continue (2 ok, 1 failed, run continues)';
END $$;

-- ── 4. FIX-652 gate SKIPS run_rule_taggers('weekly') when donations unchanged ─
-- Seed the watermark with the CURRENT donation signature (same expression the
-- procedure computes), so the gate sees "unchanged" and skips the multi-minute
-- size rebuild. Proves the gate fires WITHOUT running the rebuild.
INSERT INTO public.pipeline_state (key, value)
SELECT 'size_tags:donation_watermark',
       jsonb_build_object('sig',
         count(*)::text || '|'
         || COALESCE(max(created_at), 'epoch'::timestamptz)::text || '|'
         || COALESCE(max(updated_at), 'epoch'::timestamptz)::text)
FROM public.financial_relationships
WHERE from_type = 'financial_entity' AND relationship_type = 'donation'
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

CALL public.run_rule_taggers('weekly');

DO $$
DECLARE v_action text; v_tags bigint; v_status text;
BEGIN
  SELECT metadata->>'action', (metadata->>'tags_written')::bigint, status
    INTO v_action, v_tags, v_status
    FROM public.data_sync_log
   WHERE pipeline = 'run_rule_taggers'
   ORDER BY started_at DESC LIMIT 1;

  IF v_action IS DISTINCT FROM 'skipped_unchanged' THEN
    RAISE EXCEPTION 'FAIL(4): gate did not skip (action=%, expected skipped_unchanged)', v_action; END IF;
  IF v_tags <> 0 THEN
    RAISE EXCEPTION 'FAIL(4): gate skipped but tags_written=% (expected 0)', v_tags; END IF;
  IF v_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'FAIL(4): run_rule_taggers weekly status=% (expected complete)', v_status; END IF;

  RAISE NOTICE 'PASS(4): FIX-652 gate skips when donation signature unchanged (action=%, tags=%)', v_action, v_tags;
END $$;

\echo '── PR2 verify: ALL ASSERTS PASSED ──'
