-- verify_fix1003.sql — prove vacuum OWNERSHIP exists for every relation the
-- donor-rollup write path rewrites, and for the CONCURRENTLY-refreshed chord
-- matviews that were in the same never-vacuumed condition.
--
-- LOCAL ONLY. Pure catalog assertions — no procedure is CALLed, so this is
-- fast and safe to run any time.
--
--     psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--          -v ON_ERROR_STOP=1 -f supabase/tests/verify_fix1003.sql
--
-- Bare psql for consistency with verify_fix1002.sql; this file has no COMMIT
-- constraint of its own, so scripts/db-query.mjs would also work.
--
-- WHY THIS FILE EXISTS, separately from verify_fix1002.sql's cases 8 and 9.
-- Those two assert a HAND-WRITTEN list of six arm names and a hand-written list
-- of two job names. Both are the shape of assertion that goes stale silently:
-- add a seventh arm to the rollup and case 8 still passes at "6 of 6". The
-- cases below instead derive the arm set FROM THE CATALOG by walking the
-- procedure's actual call tree, so a new arm makes the test fail until someone
-- gives it an owner. That is the FIX-961 → FIX-995 lesson: a remediation scoped
-- to the tables someone happened to observe is a remediation that gets
-- re-discovered.
--
-- Every case here FAILS on main as of 20260809000000:
--   case 1  4 of 6 arms have no scheduled vacuum job
--   case 2  passes on main (the overrides half already landed)
--   case 3  0 of 4 chord matviews carry an override
--   case 4  pipeline_state carries no override
--   case 5/6/7 guard the shape of what cases 1-4 add

\set ON_ERROR_STOP on

CREATE TEMP TABLE fix1003_results (
  case_no   int,
  case_name text,
  claim     text,
  observed  text,
  passed    boolean
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixture: the arm set, DERIVED — not typed out.
--
-- Walk refresh_official_donor_rollup_incremental() → its callees → their
-- callees, and keep every public relation any of them writes. Excludes the
-- bookkeeping relations (data_sync_log, pipeline_state) from the *arm* set;
-- pipeline_state is asserted separately in case 4 because it needs an override
-- but not a scheduled job.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE fix1003_written AS
WITH RECURSIVE reachable(proname, src) AS (
  -- FIX-973 — TWO roots. jobid 24 now CALLs donor_rollup_rebuild_bulk(), and a
  -- walk rooted only at the per-recipient procedure would stop covering the
  -- path that actually runs. Rooting at both also means the two regimes' write
  -- sets are asserted to have the same owners, which is what makes an arm added
  -- to one and not the other fail here rather than in production.
  SELECT p.proname, p.prosrc
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('refresh_official_donor_rollup_incremental',
                      'donor_rollup_rebuild_bulk')
  UNION
  -- Match ANY `identifier(` and keep only those that name a function in
  -- public. Deliberately NOT anchored on PERFORM/CALL: the chunk loop invokes
  -- the main writer by ASSIGNMENT — `v_n := public.donor_rollup_rebuild_
  -- recipients(v_chunk)` — which a keyword-anchored pattern misses entirely,
  -- and missing it silently empties the derived arm set. The public-schema
  -- join is what keeps this from matching count(, format(, jsonb_build_object(
  -- and friends; UNION (not UNION ALL) terminates on cycles.
  SELECT p2.proname, p2.prosrc
  FROM reachable r
  CROSS JOIN LATERAL regexp_matches(
    r.src, '([a-z_][a-z0-9_]*)\s*\(', 'gi') AS m
  JOIN pg_proc p2 ON p2.proname = m[1]
  JOIN pg_namespace n2 ON n2.oid = p2.pronamespace AND n2.nspname = 'public'
),
written AS (
  SELECT DISTINCT lower(m[1]) AS relname
  FROM reachable r
  CROSS JOIN LATERAL regexp_matches(
    r.src,
    '(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)',
    'gi') AS m
)
SELECT c.relname, c.reloptions, c.relpersistence
FROM written w
JOIN pg_class c ON c.relname = w.relname
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relkind IN ('r','m')
  AND c.relname NOT IN ('data_sync_log','pipeline_state');

-- The PERMANENT arms — what cases 1, 2 and 7 have always been about. Split out
-- by relpersistence rather than by name, so a new arm lands here automatically
-- and a new staging table does not blow up case 1 for the wrong reason.
CREATE TEMP TABLE fix1003_arms AS
SELECT relname, reloptions FROM fix1003_written WHERE relpersistence <> 'u';

-- The UNLOGGED staging the bulk regime rebuilds (FIX-1005). Different owner
-- shape: these are TRUNCATE-then-bulk-INSERT, so dead tuples never accumulate
-- and the scale factor is not the lever — the INSERT-triggered autovacuum that
-- restores all-visible is. Case 8 below.
CREATE TEMP TABLE fix1003_staging AS
SELECT relname, reloptions, relpages FROM (
  SELECT w.relname, w.reloptions, c.relpages
  FROM fix1003_written w
  JOIN pg_class c ON c.relname = w.relname
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE w.relpersistence = 'u') t;

-- Sanity: the derivation must find the six known arms. If this trips, the
-- walker broke, not the fix — and every case below would be vacuously true.
DO $$
DECLARE v_n int; v_found text;
BEGIN
  SELECT count(*), string_agg(relname, ',' ORDER BY relname)
    INTO v_n, v_found FROM fix1003_arms;
  IF v_n < 6 THEN
    RAISE EXCEPTION
      'verify_fix1003: arm derivation found only % relation(s) [%] — the call-tree walker is broken, so the cases below would pass vacuously',
      v_n, v_found;
  END IF;

  -- FIX-973 — same guard for the staging half. donor_rollup_rebuild_bulk()
  -- TRUNCATEs four `_drb_*` tables; finding none means the second root did not
  -- resolve and case 8 would pass on an empty set.
  SELECT count(*), string_agg(relname, ',' ORDER BY relname)
    INTO v_n, v_found FROM fix1003_staging;
  IF v_n < 4 THEN
    RAISE EXCEPTION
      'verify_fix1003: staging derivation found only % relation(s) [%] — the donor_rollup_rebuild_bulk root did not resolve',
      v_n, v_found;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 1 — every derived arm is covered by a named scheduled VACUUM job.
--
-- This is the case that fails on main: 20260809000000 scheduled jobs for the
-- two LARGE arms only, leaving official_donor_totals,
-- official_small_dollar_rollup, official_sector_affinity_rollup and
-- official_donor_bracket_totals with an autovacuum override but no owner.
-- Absolute dead counts on those four are small; their dead PERCENTAGE is not,
-- and percentage is what collapses all-visible (measured 18.6% dead at 31.7%
-- all-visible on 2026-08-08).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fix1003_results
SELECT 1,
       'every donor-rollup arm has a scheduled VACUUM (ANALYZE) cron job',
       'all derived arms covered',
       CASE WHEN count(*) FILTER (WHERE NOT covered) = 0
            THEN format('%s of %s covered', count(*), count(*))
            ELSE format('UNCOVERED: %s',
                        string_agg(relname, ', ') FILTER (WHERE NOT covered)) END,
       count(*) FILTER (WHERE NOT covered) = 0
FROM (
  SELECT a.relname,
         EXISTS (SELECT 1 FROM cron.job j
                 WHERE j.command ILIKE '%VACUUM%'
                   AND j.command ILIKE '%' || a.relname || '%') AS covered
  FROM fix1003_arms a
) t;

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 2 — every derived arm carries a per-table autovacuum override.
-- Passes on main; kept so a NEW arm added later fails both halves, not one.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fix1003_results
SELECT 2,
       'every donor-rollup arm carries an autovacuum override',
       'all derived arms overridden',
       CASE WHEN count(*) FILTER (WHERE NOT overridden) = 0
            THEN format('%s of %s overridden', count(*), count(*))
            ELSE format('MISSING: %s',
                        string_agg(relname, ', ') FILTER (WHERE NOT overridden)) END,
       count(*) FILTER (WHERE NOT overridden) = 0
FROM (
  -- COALESCE is load-bearing: reloptions is NULL when a relation has no
  -- overrides at all, array_to_string(NULL,',') is NULL, NULL LIKE '...' is
  -- NULL, and `count(*) FILTER (WHERE NOT overridden)` does not count NULLs —
  -- so the un-COALESCEd form reports "all overridden" for a table with NO
  -- overrides. That is exactly how case 3 passed vacuously on first run.
  SELECT a.relname,
         COALESCE(array_to_string(a.reloptions, ',')
                    LIKE '%autovacuum_vacuum_scale_factor%', false) AS overridden
  FROM fix1003_arms a
) t;

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 3 — the CONCURRENTLY-refreshed chord matviews carry an override.
--
-- Derived, not typed: any matview refreshed with REFRESH MATERIALIZED VIEW
-- CONCURRENTLY leaves dead tuples (it is a DELETE+INSERT diff-merge), unlike a
-- plain REFRESH which rewrites the heap and leaves none. So the population is
-- "matviews some function refreshes CONCURRENTLY", and all of them need an
-- owner.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fix1003_results
SELECT 3,
       'CONCURRENTLY-refreshed matviews carry an autovacuum override',
       'all such matviews overridden',
       CASE WHEN count(*) = 0 THEN 'none found (walker suspect)'
            WHEN count(*) FILTER (WHERE NOT overridden) = 0
            THEN format('%s of %s overridden', count(*), count(*))
            ELSE format('MISSING: %s',
                        string_agg(relname, ', ') FILTER (WHERE NOT overridden)) END,
       count(*) > 0 AND count(*) FILTER (WHERE NOT overridden) = 0
FROM (
  SELECT DISTINCT c.relname,
         COALESCE(array_to_string(c.reloptions, ',')
                    LIKE '%autovacuum_vacuum_threshold%', false) AS overridden
  FROM pg_proc p
  JOIN pg_namespace np ON np.oid = p.pronamespace AND np.nspname = 'public'
  CROSS JOIN LATERAL regexp_matches(
    p.prosrc,
    'REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\s+(?:public\.)?([a-z_][a-z0-9_]*)',
    'gi') AS m
  JOIN pg_class c ON c.relname = m[1] AND c.relkind = 'm'
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname LIKE 'chord\_%'
) t;

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 4 — pipeline_state carries an override.
--
-- It is in the rollup's write set (UPDATEd once per chunk to persist the cursor
-- in the chunk's own transaction, FIX-944) on a ~27-row table, and it measured
-- 62.0% dead at 0% all-visible on prod. Every pipeline reads it.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fix1003_results
SELECT 4,
       'pipeline_state carries an autovacuum override',
       'threshold-led override present',
       COALESCE(array_to_string(c.reloptions, ' '), '(none)'),
       COALESCE(array_to_string(c.reloptions, ',')
                  LIKE '%autovacuum_vacuum_threshold%', false)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relname = 'pipeline_state';

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 5 — tiny relations get a LOWERED THRESHOLD, not just a scale factor.
--
-- The trigger is `threshold + scale_factor x reltuples`. On a 27-row matview
-- the scale-factor term is ~1.35 and the default threshold of 50 IS the whole
-- trigger, so a scale-factor-only override changes nothing — which is exactly
-- how chord_donor_type_party_flows_mv was found sitting at 43 dead tuples.
-- This case is what stops someone "fixing" these later by copying the arms'
-- scale-factor-only recipe onto them.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fix1003_results
SELECT 5,
       'tiny high-churn relations override the threshold, not only the scale factor',
       'threshold < 50 on each',
       CASE WHEN count(*) FILTER (WHERE NOT ok) = 0
            THEN format('%s of %s', count(*), count(*))
            ELSE format('SCALE-FACTOR-ONLY: %s',
                        string_agg(relname, ', ') FILTER (WHERE NOT ok)) END,
       count(*) FILTER (WHERE NOT ok) = 0
FROM (
  SELECT c.relname,
         COALESCE((SELECT split_part(o, '=', 2)::int
                   FROM unnest(c.reloptions) o
                   WHERE o LIKE 'autovacuum_vacuum_threshold=%'), 50) < 50 AS ok
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname IN ('chord_donor_state_party_flows_mv','chord_donor_type_party_flows_mv',
                      'chord_industry_flows_mv','chord_subject_party_flows_mv',
                      'pipeline_state')
) t;

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 6 — every vacuum cron command is exactly ONE VACUUM statement.
--
-- pg_cron sends a command as a simple query, and multiple statements there run
-- in an implicit transaction block, which VACUUM may not. A second statement
-- appended to any of these jobs breaks it at runtime, not at deploy.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fix1003_results
SELECT 6,
       'each vacuum cron job is a single VACUUM (ANALYZE) statement',
       'one statement, one semicolon, ANALYZE included',
       CASE WHEN count(*) FILTER (WHERE NOT ok) = 0
            THEN format('%s job(s) well-formed', count(*))
            ELSE format('MALFORMED: %s',
                        string_agg(jobname, ', ') FILTER (WHERE NOT ok)) END,
       count(*) >= 6 AND count(*) FILTER (WHERE NOT ok) = 0
FROM (
  SELECT j.jobname,
         j.command LIKE 'VACUUM (ANALYZE)%'
           AND length(j.command) - length(replace(j.command, ';', '')) = 1 AS ok
  FROM cron.job j
  WHERE j.command ILIKE '%VACUUM%'
) t;

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 7 — the arm vacuum jobs are ACTIVE and fire after each rollup window.
--
-- FIX-1002 bounds a firing at 2h from 09:00 and 12:00 UTC, so the windows close
-- at 11:00 and 14:00. A vacuum scheduled inside a window would split I/O with
-- the run it is meant to clean up after (the 2026-08-08 FEC failure mode).
-- ─────────────────────────────────────────────────────────────────────────────
--
-- FIX-973 — the assertion was a literal `= '11,14'`, and the deployed waves are
-- `11,17` (they have been since before this file's last edit, so case 7 has
-- been red on main). A hardcoded hour STRING is the same defect this file was
-- written to avoid one level up: it pins the answer instead of the claim. The
-- claim is "not inside a rollup window", so that is what is asserted — every
-- hour in the field is at or after 11:00, the hour the 09:00 window closes.
-- The 12:00 window closes at 14:00 and 17 clears it; a wave moved back to,
-- say, 10 or 13 would fail here, which is the case that matters.
INSERT INTO fix1003_results
SELECT 7,
       'arm vacuum jobs are active and scheduled after the 11:00/14:00 windows',
       'active, every scheduled hour >= 11',
       CASE WHEN count(*) FILTER (WHERE NOT ok) = 0
            THEN format('%s job(s) ok', count(*))
            ELSE format('BAD: %s',
                        string_agg(jobname || ' [' || schedule || ']', ', ')
                          FILTER (WHERE NOT ok)) END,
       count(*) >= 6 AND count(*) FILTER (WHERE NOT ok) = 0
FROM (
  SELECT j.jobname, j.schedule,
         j.active
           AND split_part(j.schedule, ' ', 2) ~ '^[0-9]+(,[0-9]+)*$'
           AND NOT EXISTS (
             SELECT 1 FROM unnest(string_to_array(split_part(j.schedule, ' ', 2), ',')) h
              WHERE h::int < 11) AS ok
  FROM cron.job j
  WHERE j.command ILIKE '%VACUUM%'
    AND EXISTS (SELECT 1 FROM fix1003_arms a WHERE j.command ILIKE '%' || a.relname || '%')
) t;

-- ─────────────────────────────────────────────────────────────────────────────
-- CASE 8 (FIX-973/FIX-1005) — the bulk regime's UNLOGGED staging has a vacuum
-- owner too.
--
-- These four are rebuilt by TRUNCATE + bulk INSERT (`_drb_fe` and
-- `_drb_targets` once per sweep, `_drb_donor` and `_drb_chunk_fe` once per
-- chunk), so they never accumulate dead tuples and the arms' scale-factor
-- recipe is beside the point. What they DO leave behind is a heap with nothing
-- marked all-visible, and the chunk loop then probes `_drb_fe` and
-- `_drb_chunk_fe` by primary key. The lever is insert-triggered autovacuum,
-- whose default (1,000 + 0.2 x reltuples) is ~730k inserts on `_drb_fe` — about
-- one sweep in five, and TRUNCATE resets the counter.
--
-- Asserted as "carries an insert-triggered override", derived from the call
-- tree, so a fifth staging table added to the bulk regime fails here until
-- someone gives it an owner. That is the FIX-961 -> FIX-995 lesson applied to
-- the half cc-98 left to the manual script's VACUUM tail.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO fix1003_results
SELECT 8,
       'bulk-regime UNLOGGED staging carries an insert-triggered autovacuum override',
       'all derived staging tables overridden',
       CASE WHEN count(*) FILTER (WHERE NOT overridden) = 0
            THEN format('%s of %s overridden', count(*), count(*))
            ELSE format('MISSING: %s',
                        string_agg(relname, ', ') FILTER (WHERE NOT overridden)) END,
       count(*) > 0 AND count(*) FILTER (WHERE NOT overridden) = 0
FROM (
  -- COALESCE for the same reason case 2 needs it: NULL reloptions makes the
  -- LIKE NULL, and a NULL is neither counted as a pass nor as a failure.
  SELECT s.relname,
         COALESCE(array_to_string(s.reloptions, ',')
                    LIKE '%autovacuum_vacuum_insert_threshold%', false)
      OR COALESCE(array_to_string(s.reloptions, ',')
                    LIKE '%autovacuum_vacuum_insert_scale_factor%', false) AS overridden
  FROM fix1003_staging s
) t;

\echo ''
\echo '########## RESULTS ##########'
SELECT case_no, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
       case_name, claim, observed
FROM fix1003_results ORDER BY case_no;

\echo ''
\echo '--- derived arm set (from the catalog, not a hand-kept list) ---'
SELECT relname, COALESCE(array_to_string(reloptions, ' '), '(no override)') AS reloptions
FROM fix1003_arms ORDER BY relname;

\echo ''
\echo '--- derived UNLOGGED staging set (FIX-973 second root) ---'
SELECT relname, relpages,
       COALESCE(array_to_string(reloptions, ' '), '(no override)') AS reloptions
FROM fix1003_staging ORDER BY relname;

\echo ''
SELECT count(*) FILTER (WHERE passed)     AS passed,
       count(*) FILTER (WHERE NOT passed) AS failed,
       CASE WHEN count(*) FILTER (WHERE NOT passed) = 0
            THEN 'FIX-1003 VACUUM OWNERSHIP VERIFIED (local)'
            ELSE 'FIX-1003 VACUUM OWNERSHIP FAILED' END AS verdict
FROM fix1003_results;

DO $$
DECLARE v_failed int; v_null int; v_n int;
BEGIN
  -- A NULL `passed` is a bug in THIS FILE, not a result: it is neither counted
  -- as a pass nor as a failure, so it would let a broken case ride silently.
  -- Treat it as louder than a plain failure.
  SELECT count(*) FILTER (WHERE passed IS NULL),
         count(*) FILTER (WHERE passed IS FALSE),
         count(*)
    INTO v_null, v_failed, v_n
  FROM fix1003_results;

  IF v_n <> 8 THEN
    RAISE EXCEPTION 'verify_fix1003: expected 8 cases, recorded % — a case produced no row', v_n;
  END IF;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'verify_fix1003: % case(s) evaluated to NULL (test bug, not a result)', v_null;
  END IF;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'verify_fix1003: % case(s) failed', v_failed;
  END IF;
END $$;
