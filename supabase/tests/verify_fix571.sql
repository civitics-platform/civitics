-- verify_fix571.sql — deterministic scorer proof for detect_sybil_clusters().
--
-- The abuse_events log is pre-launch thin (0 rows on prod), so there is no real
-- data to tune against yet. This proof is the SUBSTITUTE for real-data tuning and
-- the regression anchor for later tuning: it seeds a synthetic constellation into
-- abuse_events, asserts the scorer's verdict on each case, and ROLLS BACK so
-- nothing persists. Run as ONE command:
--
--   node scripts/db-query.mjs --local --file supabase/tests/verify_fix571.sql
--   # or: psql "$LOCAL_DB" -f supabase/tests/verify_fix571.sql
--
-- Exits non-zero on any failed assertion (ON_ERROR_STOP + RAISE EXCEPTION). The
-- whole run is wrapped BEGIN; ... ROLLBACK; — abuse_events is left untouched.
--
-- CASES (all timestamps within the 30-day default horizon):
--   1. FARM      — 3 accounts on ONE fingerprint (ip+ua), tight hand-off timing,
--                  + a cap_hit  → MUST cluster as 'shared_fingerprint', score >= 0.6.
--   2. HOUSEHOLD — 2 accounts on one ip → below p_min_accounts(3), MUST NOT cluster.
--   3. CAMPUS    — 30 accounts on one ip, each a DISTINCT ua → shared_ip only;
--                  cardinality dampening (n=30 > cap=25) pushes it BELOW threshold.
--   4. NULL-skip — 3 accounts with NULL ip_hash → linkage-blind, MUST be ignored.

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

\echo '── seeding synthetic constellation into abuse_events ──────────────────────'

-- Deterministic account UUIDs, namespaced f571* so the intent is greppable.
-- (abuse_events has no FK to auth.users, so these accounts need no users row; a
--  non-existent user_id is simply "not excluded from standing".)
--
-- 1. FARM: 3 accounts, one fingerprint (ip_farm | ua_farm), interleaved every ~2
--    min inside a 15-min window (A1,A2,A3,A1,A2,A3) + one cap_hit on A1.
INSERT INTO public.abuse_events (user_id, ip_hash, ua_hash, action, occurred_at, meta) VALUES
  ('f5710001-0000-0000-0000-000000000001', 'ip_farm', 'ua_farm', 'comment_create', now() - interval '60 min',              '{}'),
  ('f5710001-0000-0000-0000-000000000002', 'ip_farm', 'ua_farm', 'comment_create', now() - interval '58 min',              '{}'),
  ('f5710001-0000-0000-0000-000000000003', 'ip_farm', 'ua_farm', 'statement_vote', now() - interval '56 min',              '{}'),
  ('f5710001-0000-0000-0000-000000000001', 'ip_farm', 'ua_farm', 'statement_vote', now() - interval '54 min',              '{}'),
  ('f5710001-0000-0000-0000-000000000002', 'ip_farm', 'ua_farm', 'position_set',   now() - interval '52 min',              '{}'),
  ('f5710001-0000-0000-0000-000000000003', 'ip_farm', 'ua_farm', 'position_set',   now() - interval '50 min',              '{}'),
  ('f5710001-0000-0000-0000-000000000001', 'ip_farm', 'ua_farm', 'cap_hit',        now() - interval '49 min',              '{"route":"comments","cap":"comment_daily"}');

-- 2. HOUSEHOLD: 2 accounts behind one router (shared ip, distinct devices).
INSERT INTO public.abuse_events (user_id, ip_hash, ua_hash, action, occurred_at, meta) VALUES
  ('f5710002-0000-0000-0000-000000000001', 'ip_home', 'ua_home_a', 'comment_create', now() - interval '3 hours', '{}'),
  ('f5710002-0000-0000-0000-000000000002', 'ip_home', 'ua_home_b', 'position_set',   now() - interval '2 hours', '{}');

-- 3. CAMPUS: 30 accounts behind one CGNAT egress, each a distinct device/ua.
--    Events spread across ~10 hours so coupling stays low; the point under test is
--    that size-dampening keeps a large shared network below threshold.
INSERT INTO public.abuse_events (user_id, ip_hash, ua_hash, action, occurred_at, meta)
SELECT
  ('f5710003-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid,
  'ip_campus',
  'ua_campus_' || g::text,
  'comment_create',
  now() - make_interval(mins => g * 20),   -- 20,40,...,600 min ago
  '{}'::jsonb
FROM generate_series(1, 30) g;

-- 4. NULL-skip: 3 accounts with NULL network hashes (linkage-blind). If the scorer
--    respected them they would form a fingerprint/ip cluster; it must not.
INSERT INTO public.abuse_events (user_id, ip_hash, ua_hash, action, occurred_at, meta) VALUES
  ('f5710004-0000-0000-0000-000000000001', NULL, NULL, 'comment_create', now() - interval '40 min', '{}'),
  ('f5710004-0000-0000-0000-000000000002', NULL, NULL, 'comment_create', now() - interval '38 min', '{}'),
  ('f5710004-0000-0000-0000-000000000003', NULL, NULL, 'statement_vote', now() - interval '36 min', '{}');

\echo '── running assertions ─────────────────────────────────────────────────────'

DO $$
DECLARE
  v_farm      RECORD;
  v_campus    RECORD;
  v_rows0     int;
  v_null_rows int;
BEGIN
  -- CASE 1 — FARM clusters as shared_fingerprint above threshold (defaults).
  SELECT * INTO v_farm
  FROM public.detect_sybil_clusters()
  WHERE cluster_key = 'ip_farm|ua_farm';

  IF v_farm IS NULL THEN
    RAISE EXCEPTION 'FAIL case1(farm): expected a candidate for ip_farm|ua_farm, got none';
  END IF;
  IF v_farm.signal <> 'shared_fingerprint' THEN
    RAISE EXCEPTION 'FAIL case1(farm): signal = %, want shared_fingerprint', v_farm.signal;
  END IF;
  IF v_farm.cluster_size <> 3 THEN
    RAISE EXCEPTION 'FAIL case1(farm): cluster_size = %, want 3', v_farm.cluster_size;
  END IF;
  IF v_farm.score < 0.6 THEN
    RAISE EXCEPTION 'FAIL case1(farm): score = % (< 0.6 threshold); signals=%', v_farm.score, v_farm.signals;
  END IF;
  IF (v_farm.signals->>'intent_events')::int < 1 THEN
    RAISE EXCEPTION 'FAIL case1(farm): expected the cap_hit to register as abuse-intent; signals=%', v_farm.signals;
  END IF;
  RAISE NOTICE '  ✓ case1(farm): shared_fingerprint size=3 score=% (coupling=%, intent=%)',
    v_farm.score, v_farm.signals->>'coupling', v_farm.signals->>'abuse_intent';

  -- CASE 2 — HOUSEHOLD never clusters (2 < min_accounts), even at threshold 0.
  IF EXISTS (
    SELECT 1 FROM public.detect_sybil_clusters(30, 3, 15, 60, 25, 0.0)
    WHERE cluster_key LIKE 'ip_home%'
  ) THEN
    RAISE EXCEPTION 'FAIL case2(household): a 2-account key surfaced (must be < min_accounts)';
  END IF;
  RAISE NOTICE '  ✓ case2(household): 2-account shared-ip never clusters';

  -- CASE 3 — CAMPUS is below threshold at defaults; force threshold 0 to inspect
  -- the suppressed row and prove size-dampening engaged (damp_factor < 1).
  IF EXISTS (
    SELECT 1 FROM public.detect_sybil_clusters()   -- defaults, threshold 0.6
    WHERE cluster_key = 'ip_campus'
  ) THEN
    RAISE EXCEPTION 'FAIL case3(campus): a 30-account shared-ip cleared the 0.6 threshold';
  END IF;

  SELECT * INTO v_campus
  FROM public.detect_sybil_clusters(30, 3, 15, 60, 25, 0.0)   -- threshold 0 to inspect
  WHERE cluster_key = 'ip_campus';

  IF v_campus IS NULL THEN
    RAISE EXCEPTION 'FAIL case3(campus): expected the row to exist at threshold 0';
  END IF;
  IF v_campus.cluster_size <> 30 THEN
    RAISE EXCEPTION 'FAIL case3(campus): cluster_size = %, want 30', v_campus.cluster_size;
  END IF;
  IF v_campus.signal = 'shared_fingerprint' THEN
    RAISE EXCEPTION 'FAIL case3(campus): mislabeled as shared_fingerprint (30 distinct uas → shared_ip class)';
  END IF;
  IF (v_campus.signals->>'damp_factor')::numeric >= 1.0 THEN
    RAISE EXCEPTION 'FAIL case3(campus): damp_factor = % (expected < 1 for n=30 > cap=25)',
      v_campus.signals->>'damp_factor';
  END IF;
  IF v_campus.score >= 0.6 THEN
    RAISE EXCEPTION 'FAIL case3(campus): dampened score = % still >= 0.6', v_campus.score;
  END IF;
  RAISE NOTICE '  ✓ case3(campus): shared_ip size=30 dampened (raw=% × damp=% → score=%) below 0.6',
    v_campus.signals->>'raw_score', v_campus.signals->>'damp_factor', v_campus.score;

  -- CASE 4 — NULL-hash accounts are ignored. At threshold 0 the ONLY rows are the
  -- farm fingerprint + the campus ip (household < min_accounts, nulls skipped).
  SELECT count(*) INTO v_rows0 FROM public.detect_sybil_clusters(30, 3, 15, 60, 25, 0.0);
  IF v_rows0 <> 2 THEN
    RAISE EXCEPTION 'FAIL case4(null-skip): expected exactly 2 rows at threshold 0 (farm+campus), got %', v_rows0;
  END IF;
  SELECT count(*) INTO v_null_rows
  FROM public.detect_sybil_clusters(30, 3, 15, 60, 25, 0.0)
  WHERE account_ids && ARRAY[
    'f5710004-0000-0000-0000-000000000001'::uuid,
    'f5710004-0000-0000-0000-000000000002'::uuid,
    'f5710004-0000-0000-0000-000000000003'::uuid
  ];
  IF v_null_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL case4(null-skip): a NULL-hash account appeared in % candidate row(s)', v_null_rows;
  END IF;
  RAISE NOTICE '  ✓ case4(null-skip): NULL-hash accounts ignored; exactly farm+campus at threshold 0';
END $$;

\echo '✓ ALL FIX-571 CONSTELLATION ASSERTIONS PASSED'

ROLLBACK;
