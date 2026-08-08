-- verify_fix1002.sql — prove the donor-rollup budget guard actually fires.
--
-- LOCAL ONLY. Runs the real procedure against the local Docker DB over a dirty
-- set of 3 recipients pinned by cursor, so each case costs seconds.
--
--     psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--          -v ON_ERROR_STOP=1 -f supabase/tests/verify_fix1002.sql
--
-- BARE psql, deliberately — NOT scripts/db-query.mjs, which passes
-- --single-transaction. The procedure COMMITs between chunks, and a COMMIT
-- inside an explicit transaction block raises `invalid transaction termination`.
-- Same constraint as the FIX-717/718 CALL-with-COMMIT rollups.
--
-- WHY THIS FILE EXISTS. The defect FIX-1002 fixes is not "the guard has a bug".
-- It is "the guard is structurally incapable of firing in the case it exists
-- for" — on 2026-08-08 jobid 24 ran six hours, was killed by the 6h
-- statement_timeout, and committed zero chunks, because the guard was written
-- `IF v_chunk_no > 0 AND ...` and the run never finished a first chunk. That
-- class of defect is invisible to code review and to any test that asserts the
-- guard's arithmetic rather than watching it stop a run. So every case below
-- CALLs the procedure for real and asserts on what it durably recorded.
--
-- Each case re-seeds pipeline_state, so cases are order-independent.

\set ON_ERROR_STOP on
SET statement_timeout = 0;
-- Local Docker has /dev/shm = 64MB; parallel workers on these arms can exhaust
-- it. Session-scoped, mirrors donor-rollup-bulk.ts's local branch.
SET max_parallel_workers_per_gather = 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixture: pin the sweep to the last 3 recipients in uuid order.
--
-- The dirty-set query is `updated_at > last_indexed_at AND to_id > sweep_cursor`,
-- so an epoch watermark plus a cursor near the end of uuid order yields a small,
-- deterministic set without touching financial_relationships.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE fix1002_fixture AS
SELECT
  (SELECT d.to_id FROM (
     SELECT DISTINCT fr.to_id
     FROM public.financial_relationships fr
     WHERE fr.relationship_type IN ('donation','ie_support','ie_oppose')
       AND fr.from_type = 'financial_entity'
   ) d ORDER BY d.to_id DESC OFFSET 3 LIMIT 1)         AS cursor_id,
  (SELECT jsonb_agg(x.to_id ORDER BY x.to_id) FROM (
     SELECT DISTINCT fr.to_id
     FROM public.financial_relationships fr
     WHERE fr.relationship_type IN ('donation','ie_support','ie_oppose')
       AND fr.from_type = 'financial_entity'
     ORDER BY 1 DESC LIMIT 3
   ) x)                                                AS expected_set;

CREATE TEMP TABLE fix1002_results (
  case_no   int,
  case_name text,
  claim     text,
  observed  text,
  passed    boolean
);

CREATE OR REPLACE FUNCTION pg_temp.fix1002_seed() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark', jsonb_build_object(
            'last_indexed_at', '1970-01-01T00:00:00Z',
            'sweep_cursor',    (SELECT cursor_id::text FROM fix1002_fixture),
            'sweep_target',    '2099-01-01T00:00:00Z',
            'sweep_failures',  0))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION pg_temp.fix1002_last_log() RETURNS public.data_sync_log
LANGUAGE sql AS $$
  SELECT * FROM public.data_sync_log
  WHERE pipeline = 'donor_rollup_refresh'
  ORDER BY started_at DESC, id DESC LIMIT 1;
$$;

\echo ''
\echo '########## FIX-1002 — budget guard verification ##########'
\echo ''
SELECT cursor_id, jsonb_array_length(expected_set) AS dirty_recipients FROM fix1002_fixture;

-- ═════════════════════════════════════════════════════════════════════════════
-- CASE 1 — THE POINT OF THIS FILE: the guard refuses a chunk on its own
--          projected cost, stops cleanly, and names what blocked it.
--
-- The FIX-972 guard reserved 1.25 x the SLOWEST CHUNK ALREADY SEEN, which says
-- nothing about the chunk in hand, and it was skipped entirely before chunk 1.
-- That is why prod run 195 could spend six hours inside its first chunk without
-- the guard being evaluated even once.
--
-- Set-up makes the third recipient a synthetic whale by inflating the weight
-- the sizer reads (official_donor_totals.donor_count). Local is disposable dev
-- state and the value is an ESTIMATE re-derived by the next real rebuild, so
-- this changes what the sizer believes without changing what the arms compute.
-- With a 10 s budget, no measured rows-per-second can make 1e9 rows fit, so the
-- refusal is arithmetic rather than a timing race.
--
-- Expect: chunks 1 and 2 commit (one recipient each, because the weight target
-- is what splits them), chunk 3 is REFUSED, run closes 'partial' with
-- stop_reason='chunk_would_not_fit' and blocked_recipient naming the whale.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE fix1002_whale AS
SELECT (expected_set ->> 2)::uuid AS official_id FROM fix1002_fixture;

UPDATE public.official_donor_totals odt
   SET donor_count = 1000000000
  FROM fix1002_whale w
 WHERE odt.official_id = w.official_id;
-- A recipient with no odt row is weighted at the c_weight_default of 1500, which
-- is not a whale; give it one so the fixture is deterministic either way.
INSERT INTO public.official_donor_totals (official_id, total_cents, pac_cents, individual_cents, donor_count)
SELECT w.official_id, 0, 0, 0, 1000000000 FROM fix1002_whale w
ON CONFLICT (official_id) DO UPDATE SET donor_count = EXCLUDED.donor_count;

SELECT pg_temp.fix1002_seed();
SET civitics.donor_rollup_latest_start_hour = '24';  -- the wall clock is not what this case tests
SET civitics.donor_rollup_budget_seconds    = '10';
CALL public.refresh_official_donor_rollup_incremental();
RESET civitics.donor_rollup_budget_seconds;
RESET civitics.donor_rollup_latest_start_hour;

INSERT INTO fix1002_results
SELECT 1, 'guard refuses a chunk it projects will not fit, and stops there',
       'status=partial AND stop_reason=chunk_would_not_fit AND recipients_done=2',
       format('status=%s chunks=%s recipients_done=%s stop_reason=%s resumable=%s',
              l.status, l.metadata->>'chunks', l.metadata->>'recipients_done',
              l.metadata->>'stop_reason', l.metadata->>'resumable'),
       l.status = 'partial'
         AND l.metadata->>'stop_reason' = 'chunk_would_not_fit'
         AND (l.metadata->>'recipients_done')::int = 2
         AND (l.metadata->>'resumable')::boolean
FROM pg_temp.fix1002_last_log() l;

-- "No silent caps": a lone recipient the guard cannot fit inside a whole budget
-- is a PARKED sweep, not a paced one, and the log has to say so by name.
INSERT INTO fix1002_results
SELECT 2, 'the blocking recipient is named in the log, not silently dropped',
       'metadata.blocked_recipient = the synthetic whale',
       format('blocked=%s expected=%s', l.metadata->>'blocked_recipient', w.official_id),
       (l.metadata->>'blocked_recipient')::uuid = w.official_id
FROM pg_temp.fix1002_last_log() l, fix1002_whale w;

INSERT INTO fix1002_results
SELECT 3, 'progress is durable — the cursor advanced past the fixture cursor',
       'pipeline_state.sweep_cursor > fixture cursor',
       format('cursor=%s', ps.value->>'sweep_cursor'),
       (ps.value->>'sweep_cursor')::uuid > f.cursor_id
FROM public.pipeline_state ps, fix1002_fixture f
WHERE ps.key = 'donor_rollup_watermark';

-- ═════════════════════════════════════════════════════════════════════════════
-- CASE 4 — the chunk is sized by COST, not by recipient count.
--
-- Same three recipients, same code, whale weight removed. A fixed-count quantum
-- would behave identically to case 1; a weight target puts all three in ONE
-- chunk and the sweep COMPLETES. The only variable between the two cases is the
-- weight the sizer reads.
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE public.official_donor_totals odt
   SET donor_count = 87
  FROM fix1002_whale w
 WHERE odt.official_id = w.official_id;

SELECT pg_temp.fix1002_seed();
SET civitics.donor_rollup_latest_start_hour     = '24';
SET civitics.donor_rollup_budget_seconds       = '3600';
SET civitics.donor_rollup_chunk_target_seconds = '300';
CALL public.refresh_official_donor_rollup_incremental();
RESET civitics.donor_rollup_budget_seconds;
RESET civitics.donor_rollup_chunk_target_seconds;
RESET civitics.donor_rollup_latest_start_hour;

INSERT INTO fix1002_results
SELECT 4, 'without the whale weight, all 3 fit ONE chunk and the sweep completes',
       'status=complete AND chunks=1 AND recipients_done=3',
       format('status=%s chunks=%s recipients_done=%s',
              l.status, l.metadata->>'chunks', l.metadata->>'recipients_done'),
       l.status = 'complete'
         AND (l.metadata->>'chunks')::int = 1
         AND (l.metadata->>'recipients_done')::int = 3
FROM pg_temp.fix1002_last_log() l;

-- CASE 5 — the cross-run calibration survives sweep completion.
--
-- The completion branch REPLACES pipeline_state.value wholesale (that is how
-- sweep_cursor/sweep_target/sweep_failures get cleared), so rows_per_second has
-- to be re-stated there or it is silently dropped on every successful sweep and
-- the next run's first chunk is uncalibrated again — the exact hole this fix
-- closes. Same clobber shape as the entity_comments rating trigger.
INSERT INTO fix1002_results
SELECT 5, 'calibration carried across sweep completion, sweep keys cleared',
       'rows_per_second present AND sweep_cursor absent AND last_indexed_at present',
       format('keys=%s rps=%s',
              (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(ps.value) k),
              ps.value->>'rows_per_second'),
       (ps.value ? 'rows_per_second')
         AND NOT (ps.value ? 'sweep_cursor')
         AND (ps.value ? 'last_indexed_at')
         AND (ps.value->>'rows_per_second')::numeric > 0
FROM public.pipeline_state ps WHERE ps.key = 'donor_rollup_watermark';

-- ═════════════════════════════════════════════════════════════════════════════
-- CASE 6 — the latest-start window refuses a firing and says so.
--
-- This is what stops pg_cron's QUEUED second firing from chaining a full second
-- window onto an overrunning first one (measured 08-06/07/08: the second run
-- starts ~1.0 s after the first ends, never at its scheduled 12:00).
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.fix1002_seed();
SET civitics.donor_rollup_latest_start_hour = '0';
CALL public.refresh_official_donor_rollup_incremental();
RESET civitics.donor_rollup_latest_start_hour;

INSERT INTO fix1002_results
SELECT 6, 'start-window refusal logs skipped and runs no chunks',
       'status=skipped AND skip_reason names the start window',
       format('status=%s reason=%s', l.status, left(l.metadata->>'skip_reason', 60)),
       l.status = 'skipped' AND l.metadata->>'skip_reason' LIKE 'start window closed%'
FROM pg_temp.fix1002_last_log() l;

-- CASE 7 — break-glass overrides the refusal (donor-rollup-sweep.ts relies on it).
SELECT pg_temp.fix1002_seed();
SET civitics.donor_rollup_latest_start_hour   = '0';
SET civitics.donor_rollup_ignore_start_window = 'on';
SET civitics.donor_rollup_budget_seconds      = '3600';
CALL public.refresh_official_donor_rollup_incremental();
RESET civitics.donor_rollup_latest_start_hour;
RESET civitics.donor_rollup_ignore_start_window;
RESET civitics.donor_rollup_budget_seconds;

INSERT INTO fix1002_results
SELECT 7, 'ignore_start_window lets a deliberate run through',
       'status <> skipped',
       format('status=%s recipients_done=%s', l.status, l.metadata->>'recipients_done'),
       l.status <> 'skipped'
FROM pg_temp.fix1002_last_log() l;

-- CASE 8 — the FIX-1003 half: every arm table now carries an autovacuum override.
INSERT INTO fix1002_results
SELECT 8, 'all six rollup arms have per-table autovacuum overrides',
       '6 of 6 with autovacuum_vacuum_scale_factor',
       format('%s of 6', count(*)),
       count(*) = 6
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relname IN ('official_donor_rollup_mv','official_donor_totals',
                    'official_small_dollar_rollup','official_sector_affinity_rollup',
                    'treemap_individuals_rollup','official_donor_bracket_totals')
  AND array_to_string(c.reloptions, ',') LIKE '%autovacuum_vacuum_scale_factor%';

-- CASE 9 — the FIX-1003 vacuum tail is scheduled, one VACUUM per cron command.
-- (Two VACUUMs in one command would run inside an implicit transaction block
-- and fail; that is why these are separate jobs, as jobids 6/30/31 already are.)
INSERT INTO fix1002_results
SELECT 9, 'vacuum-tail cron jobs exist with exactly one VACUUM each',
       '2 jobs, each a single VACUUM statement',
       format('%s jobs: %s', count(*), string_agg(jobname, ',' ORDER BY jobname)),
       count(*) = 2
         AND bool_and(command LIKE 'VACUUM (ANALYZE)%')
         AND bool_and(length(command) - length(replace(command, ';', '')) = 1)
FROM cron.job
WHERE jobname IN ('odr-mv-vacuum-analyze','treemap-individuals-vacuum-analyze');

\echo ''
\echo '########## RESULTS ##########'
SELECT case_no, CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
       case_name, claim, observed
FROM fix1002_results ORDER BY case_no;

\echo ''
SELECT count(*) FILTER (WHERE passed)       AS passed,
       count(*) FILTER (WHERE NOT passed)   AS failed,
       CASE WHEN count(*) FILTER (WHERE NOT passed) = 0
            THEN 'FIX-1002/1003 VERIFIED (local)'
            ELSE 'FIX-1002/1003 FAILED' END AS verdict
FROM fix1002_results;

DO $$
DECLARE v_failed int;
BEGIN
  SELECT count(*) INTO v_failed FROM fix1002_results WHERE NOT passed;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'verify_fix1002: % case(s) failed', v_failed;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Teardown. The fixture parks last_indexed_at at 2099 to pin a 3-recipient
-- dirty set; leaving it there would silently disable the local rollup. Reset to
-- the epoch instead — the next local run is then a full (slow) sweep rather
-- than a no-op, which is the safe direction to be wrong in.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.pipeline_state
   SET value = jsonb_build_object('last_indexed_at', '1970-01-01T00:00:00Z'),
       updated_at = now()
 WHERE key = 'donor_rollup_watermark';
\echo 'teardown: donor_rollup_watermark reset to epoch (next local run is a full sweep)'
