-- FIX-1128 Half 1 — the six statement_timeout timing experiments.
--
-- Run against the LOCAL clone only (throwaway schema, dropped at the end).
-- Each case is run as its own `node scripts/db-query.mjs --local --call` batch so
-- that a deliberate 57014 stops only that case. Output recorded verbatim in
-- 2026-09-13-fix1128-experiments.md.
--
-- The question each case answers:
--   1. Is a function-level proconfig timeout inert for the call it decorates?
--   2. Does a PROCEDURE's post-COMMIT transaction re-arm from its own proconfig?
--   3. Does set_config(..., is_local => false) inside a procedure survive COMMIT
--      and arm the next transaction?  (the C1 fix)
--   4. Does the LOCAL form (is_local => true) survive COMMIT?  (expected: no)
--   5. After a CAUGHT query_canceled, does the next unit get a fresh timer, or
--      FIX-703's "every subsequent statement instantly re-times-out"?
--   6. Does pg_cron accept a multi-statement command, so `SET …; CALL …` is a
--      real bound for a C2 procedure?  (the C2 fix)

-- ── setup ───────────────────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS fix1128_exp CASCADE;
CREATE SCHEMA fix1128_exp;

-- Case 1 — function, proconfig 1s, body sleeps 3s.
CREATE FUNCTION fix1128_exp.c1_fn() RETURNS text LANGUAGE plpgsql
  SET statement_timeout = '1s' AS $fn$
BEGIN
  RAISE NOTICE 'c1 inside fn, current_setting = %', current_setting('statement_timeout');
  PERFORM pg_sleep(3);
  RETURN 'c1 COMPLETED a 3s sleep under a 1s proconfig';
END $fn$;

-- Case 2 — procedure, proconfig 1s, COMMIT then sleep 3s.
CREATE PROCEDURE fix1128_exp.c2_proc() LANGUAGE plpgsql
  SET statement_timeout = '1s' AS $pr$
BEGIN
  RAISE NOTICE 'c2 before COMMIT, current_setting = %', current_setting('statement_timeout');
  COMMIT;
  RAISE NOTICE 'c2 after  COMMIT, current_setting = %', current_setting('statement_timeout');
  PERFORM pg_sleep(3);
  RAISE NOTICE 'c2 COMPLETED the post-COMMIT 3s sleep';
END $pr$;

-- Case 3 — procedure, no proconfig, SESSION-level set_config then COMMIT then sleep 3s.
CREATE PROCEDURE fix1128_exp.c3_proc() LANGUAGE plpgsql AS $pr$
BEGIN
  PERFORM set_config('statement_timeout', '1s', false);
  RAISE NOTICE 'c3 before COMMIT, current_setting = %', current_setting('statement_timeout');
  COMMIT;
  RAISE NOTICE 'c3 after  COMMIT, current_setting = %', current_setting('statement_timeout');
  PERFORM pg_sleep(3);
  RAISE NOTICE 'c3 COMPLETED the post-COMMIT 3s sleep';
END $pr$;

-- Case 4 — same as 3 but the LOCAL form (is_local => true).
CREATE PROCEDURE fix1128_exp.c4_proc() LANGUAGE plpgsql AS $pr$
BEGIN
  PERFORM set_config('statement_timeout', '1s', true);
  RAISE NOTICE 'c4 before COMMIT, current_setting = %', current_setting('statement_timeout');
  COMMIT;
  RAISE NOTICE 'c4 after  COMMIT, current_setting = %', current_setting('statement_timeout');
  PERFORM pg_sleep(3);
  RAISE NOTICE 'c4 COMPLETED the post-COMMIT 3s sleep';
END $pr$;

-- Case 5 — unit loop: caught 57014, then does the NEXT unit get a fresh timer?
CREATE PROCEDURE fix1128_exp.c5_proc() LANGUAGE plpgsql AS $pr$
BEGIN
  PERFORM set_config('statement_timeout', '1s', false);
  COMMIT;
  BEGIN PERFORM pg_sleep(3);   RAISE NOTICE 'c5 unit1 (3s)   COMPLETED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5 unit1 (3s)   CANCELLED 57014'; END;
  COMMIT;
  BEGIN PERFORM pg_sleep(0.5); RAISE NOTICE 'c5 unit2 (0.5s) COMPLETED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5 unit2 (0.5s) CANCELLED 57014'; END;
  COMMIT;
  BEGIN PERFORM pg_sleep(3);   RAISE NOTICE 'c5 unit3 (3s)   COMPLETED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5 unit3 (3s)   CANCELLED 57014'; END;
END $pr$;

-- Case 5b — case 5 could not produce a cancel at all (see the .md), so this
-- variant forces one: the bound comes from the TOP-LEVEL statement (4s) and
-- unit2 runs into it. The question it actually answers is FIX-703's: after a
-- CAUGHT 57014, what happens to the next unit?
CREATE OR REPLACE PROCEDURE fix1128_exp.c5b_proc() LANGUAGE plpgsql AS $pr$
BEGIN
  BEGIN PERFORM pg_sleep(3);   RAISE NOTICE 'c5b unit1 (3s)   COMPLETED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5b unit1 (3s)   CANCELLED 57014'; END;
  COMMIT;
  BEGIN PERFORM pg_sleep(3);   RAISE NOTICE 'c5b unit2 (3s)   COMPLETED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5b unit2 (3s)   CANCELLED 57014'; END;
  COMMIT;
  BEGIN PERFORM pg_sleep(0.5); RAISE NOTICE 'c5b unit3 (0.5s) COMPLETED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5b unit3 (0.5s) CANCELLED 57014'; END;
END $pr$;

-- Case 5c — 5b's unit3 was short enough that "freshly re-armed" and "unbounded"
-- look the same. 5c separates them: unit2 sleeps 10s under a 4s bound.
CREATE OR REPLACE PROCEDURE fix1128_exp.c5c_proc() LANGUAGE plpgsql AS $pr$
BEGIN
  BEGIN PERFORM pg_sleep(6);  RAISE NOTICE 'c5c unit1 (6s) COMPLETED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5c unit1 (6s) CANCELLED 57014'; END;
  COMMIT;
  BEGIN PERFORM pg_sleep(10); RAISE NOTICE 'c5c unit2 (10s) COMPLETED — post-cancel units are UNBOUNDED';
  EXCEPTION WHEN query_canceled THEN RAISE NOTICE 'c5c unit2 (10s) CANCELLED 57014 — timer re-armed'; END;
END $pr$;

-- ── the runs ────────────────────────────────────────────────────────────────
-- Each of these is its own `--call` batch (a deliberate 57014 must stop only
-- its own case), and each re-states the SESSION timeout first because cases 3
-- and 5 leave it at 1s.
--   SET statement_timeout = '60s'; SELECT fix1128_exp.c1_fn();
--   SET statement_timeout = '60s'; CALL   fix1128_exp.c2_proc();  SHOW statement_timeout;
--   SET statement_timeout = '60s'; CALL   fix1128_exp.c3_proc();  SHOW statement_timeout;
--   SET statement_timeout = '60s'; CALL   fix1128_exp.c4_proc();  SHOW statement_timeout;
--   SET statement_timeout = '60s'; CALL   fix1128_exp.c5_proc();  SHOW statement_timeout;
--   SET statement_timeout = '4s';  CALL   fix1128_exp.c5b_proc(); SHOW statement_timeout;
--   SET statement_timeout = '4s';  CALL   fix1128_exp.c5c_proc();

-- Case 6 — pg_cron multi-statement command. Run on the LOCAL clone: read 7
-- established the clone's scheduler is live (38 jobs, 405 runs/24h), so the
-- prod probe the prompt sanctioned as a fallback was NOT needed.
--   SELECT cron.schedule('fix1128-probe', '* * * * *',
--            $$SET statement_timeout='1s'; SELECT pg_sleep(3)$$);
--   -- wait one firing, then:
--   SELECT jobid, runid, status, return_message, start_time, end_time,
--          end_time - start_time AS elapsed
--     FROM cron.job_run_details WHERE jobid = 74 ORDER BY start_time;
--   SELECT cron.unschedule('fix1128-probe');

-- ── teardown ────────────────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS fix1128_exp CASCADE;
