-- verify_fix950.sql — prove public.prod_session_state() reads the three states
-- it exists to distinguish, and that live_writers sees both kinds of writer.
--
-- LOCAL ONLY.
--
--     psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--          -v ON_ERROR_STOP=1 -f supabase/tests/verify_fix950.sql
--
-- Bare psql, not scripts/db-query.mjs: the cases take and release SESSION-level
-- advisory locks, and --single-transaction would make the rollback boundaries
-- below meaningless (a session lock is NOT released by ROLLBACK — that is the
-- point of using one, and the reason each case unlocks by hand).
--
-- WHAT THIS HAS TO PROVE, as opposed to what is easy to assert:
--
--   * `defer` follows the LOCK and never the label. The label is documentation
--     and can be stale by construction; a test that only ever sets both
--     together would pass with `defer` wired to the label and nobody would know
--     until a dead session silently held the platform down.
--   * a label with no lock is `label_stale` AND `defer = false`. Same reason.
--   * live_writers sees an advisory-lock writer AND a GHA nightly `running`
--     row. Those are two entirely different mechanisms (pg_locks vs
--     data_sync_log) and the preflight refuses on either.
--
-- Every case restores state, so cases are order-independent.

\set ON_ERROR_STOP on
SET statement_timeout = '60s';

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION 'verify_fix950 expects PG14+';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Case 1 — clear. No lock, no label.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
DELETE FROM public.pipeline_state WHERE key = 'prod_session';
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF (s->>'held')::boolean       THEN RAISE EXCEPTION 'case1: held true with no lock: %', s; END IF;
  IF (s->>'defer')::boolean      THEN RAISE EXCEPTION 'case1: defer true with no lock: %', s; END IF;
  IF (s->>'label_present')::boolean  THEN RAISE EXCEPTION 'case1: label_present true: %', s; END IF;
  IF (s->>'label_stale')::boolean    THEN RAISE EXCEPTION 'case1: label_stale true: %', s; END IF;
  IF s->>'reason_text' <> 'clear'    THEN RAISE EXCEPTION 'case1: reason_text %', s->>'reason_text'; END IF;
  RAISE NOTICE 'case1 clear ....................... OK';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Case 2 — LABEL ONLY. The dead-session shape: a row with no lock behind it.
-- MUST report label_stale and MUST NOT defer.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
INSERT INTO public.pipeline_state (key, value, updated_at)
VALUES ('prod_session',
        jsonb_build_object('reason', 'verify_fix950 case 2',
                           'claimed_by', 'test@localhost',
                           'claimed_at', (clock_timestamp() - interval '9 minutes')::text,
                           'expected_minutes', 30,
                           'pid', 4242),
        now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF (s->>'held')::boolean  THEN RAISE EXCEPTION 'case2: held true with no lock: %', s; END IF;
  IF (s->>'defer')::boolean THEN RAISE EXCEPTION 'case2: a dead label DEFERRED — the lock is the truth: %', s; END IF;
  IF NOT (s->>'label_present')::boolean THEN RAISE EXCEPTION 'case2: label_present false: %', s; END IF;
  IF NOT (s->>'label_stale')::boolean   THEN RAISE EXCEPTION 'case2: label_stale false: %', s; END IF;
  IF s->>'reason' <> 'verify_fix950 case 2' THEN RAISE EXCEPTION 'case2: reason %', s->>'reason'; END IF;
  IF (s->>'age_seconds')::int < 500 OR (s->>'age_seconds')::int > 700 THEN
    RAISE EXCEPTION 'case2: age_seconds % not ~540 (9 min)', s->>'age_seconds';
  END IF;
  IF (s->>'expected_minutes')::int <> 30 THEN RAISE EXCEPTION 'case2: expected_minutes %', s->>'expected_minutes'; END IF;
  IF s->>'reason_text' NOT LIKE 'stale prod_session label%' THEN
    RAISE EXCEPTION 'case2: reason_text %', s->>'reason_text';
  END IF;
  RAISE NOTICE 'case2 label without lock .......... OK (stale, not deferring)';
END $$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Case 3 — LOCK ONLY. A session that claimed but whose best-effort label write
-- failed. MUST still defer: the lock decides.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_advisory_lock(hashtext('prod_supervised_session')::bigint) AS _lock3 \gset
BEGIN;
DELETE FROM public.pipeline_state WHERE key = 'prod_session';
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF NOT (s->>'held')::boolean  THEN RAISE EXCEPTION 'case3: held false with the lock taken: %', s; END IF;
  IF NOT (s->>'defer')::boolean THEN RAISE EXCEPTION 'case3: defer false with the lock taken: %', s; END IF;
  IF (s->>'label_present')::boolean THEN RAISE EXCEPTION 'case3: label_present true: %', s; END IF;
  IF (s->>'label_stale')::boolean   THEN RAISE EXCEPTION 'case3: an unlabelled LIVE session read as stale: %', s; END IF;
  IF s->>'reason' IS NOT NULL       THEN RAISE EXCEPTION 'case3: reason %', s->>'reason'; END IF;
  IF s->>'reason_text' <> 'prod session lock held with no label row' THEN
    RAISE EXCEPTION 'case3: reason_text %', s->>'reason_text';
  END IF;
  RAISE NOTICE 'case3 lock without label ......... OK (defers)';
END $$;
ROLLBACK;
SELECT pg_advisory_unlock(hashtext('prod_supervised_session')::bigint) AS _unlock3 \gset

-- ─────────────────────────────────────────────────────────────────────────────
-- Case 4 — the real shape: lock + label. The reason must reach reason_text in
-- the exact form the guards interpolate into skip_reason.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_advisory_lock(hashtext('prod_supervised_session')::bigint) AS _lock4 \gset
BEGIN;
INSERT INTO public.pipeline_state (key, value, updated_at)
VALUES ('prod_session',
        jsonb_build_object('reason', 'FIX-950 receipt',
                           'claimed_by', 'craig@box',
                           'claimed_at', clock_timestamp()::text,
                           'expected_minutes', 35),
        now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF NOT (s->>'held')::boolean  THEN RAISE EXCEPTION 'case4: held false: %', s; END IF;
  IF NOT (s->>'defer')::boolean THEN RAISE EXCEPTION 'case4: defer false: %', s; END IF;
  IF (s->>'label_stale')::boolean THEN RAISE EXCEPTION 'case4: label_stale true on a live session: %', s; END IF;
  IF s->>'claimed_by' <> 'craig@box' THEN RAISE EXCEPTION 'case4: claimed_by %', s->>'claimed_by'; END IF;
  IF s->>'reason_text' <> 'prod session held: FIX-950 receipt' THEN
    RAISE EXCEPTION 'case4: reason_text %', s->>'reason_text';
  END IF;
  RAISE NOTICE 'case4 lock + label ............... OK';
END $$;
ROLLBACK;
SELECT pg_advisory_unlock(hashtext('prod_supervised_session')::bigint) AS _unlock4 \gset

-- ─────────────────────────────────────────────────────────────────────────────
-- Case 5 — live_writers, mechanism one: an advisory-lock writer.
-- Uses run_fe_totals_crawl's key because that is the procedure the FIX-950
-- prod receipt is taken against.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_advisory_lock(hashtext('financial_entity_totals_refresh')::bigint) AS _lock5 \gset
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF NOT (s->'live_writers' ? 'financial_entity_totals_refresh') THEN
    RAISE EXCEPTION 'case5: fe-totals lock not seen in live_writers: %', s->'live_writers';
  END IF;
  IF jsonb_array_length(s->'live_writer_detail') < 1 THEN
    RAISE EXCEPTION 'case5: live_writer_detail empty: %', s;
  END IF;
  -- The lock alone must not make the session read as held.
  IF (s->>'held')::boolean THEN RAISE EXCEPTION 'case5: a WRITER lock read as a prod session: %', s; END IF;
  RAISE NOTICE 'case5 live_writers (advisory) .... OK';
END $$;
SELECT pg_advisory_unlock(hashtext('financial_entity_totals_refresh')::bigint) AS _unlock5 \gset
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF s->'live_writers' ? 'financial_entity_totals_refresh' THEN
    RAISE EXCEPTION 'case5b: writer still listed after unlock: %', s->'live_writers';
  END IF;
  RAISE NOTICE 'case5b writer clears on unlock ... OK';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Case 6 — live_writers, mechanism two: the GHA nightly's FIX-462 `running`
-- row. No lock exists for it; data_sync_log is the only trace.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
VALUES ('nightly_cron', 'running', clock_timestamp() - interval '4 minutes',
        jsonb_build_object('phase', 'enrichment-heavy'));
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF NOT (s->'live_writers' ? 'nightly_cron:enrichment-heavy') THEN
    RAISE EXCEPTION 'case6: running nightly phase not seen: %', s->'live_writers';
  END IF;
  RAISE NOTICE 'case6 live_writers (nightly) ..... OK';
END $$;
ROLLBACK;

-- A row older than the 6h horizon is NOT a live writer — otherwise a single
-- orphaned `running` row would refuse every claim forever.
BEGIN;
INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
VALUES ('nightly_cron', 'running', clock_timestamp() - interval '7 hours',
        jsonb_build_object('phase', 'fec'));
DO $$
DECLARE s jsonb := public.prod_session_state();
BEGIN
  IF s->'live_writers' ? 'nightly_cron:fec' THEN
    RAISE EXCEPTION 'case6b: a 7h-old orphan row counted as live: %', s->'live_writers';
  END IF;
  RAISE NOTICE 'case6b stale nightly row ignored . OK';
END $$;
ROLLBACK;

DO $$ BEGIN RAISE NOTICE 'verify_fix950: ALL CASES PASSED'; END $$;
