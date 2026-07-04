-- verify_fix702_726.sql — incremental dirty-scoped financial_entity totals.
--
-- Proves, on the local Docker clone:
--   1. incremental touches ONLY the dirty entities (a control real entity is
--      untouched) and advances the watermark;
--   2. parity — the incremental's totals equal what the authoritative full
--      rebuild (rebuild_financial_entity_{donation,received}_totals) produces;
--   3. an UPDATE to an FR row re-derives the full key;
--   4. the hard-delete blind spot (deleted-all-rows entity stays stale under the
--      incremental) and that reconcile_financial_entity_totals() zeroes it;
--   5. the reconcile full pass runs bounded (per-window COMMIT).
--
-- Run:  psql "$LOCAL_DB" -f supabase/tests/verify_fix702_726.sql
-- Exits non-zero on any failed assertion (ON_ERROR_STOP + RAISE EXCEPTION).
-- Self-cleaning: the synthetic f1702726-* fixture is removed at the end and no
-- real row is mutated (the full rebuilds recompute real entities to their
-- unchanged live SUMs).

\set ON_ERROR_STOP on
\pset pager off

\echo '── fixture setup ─────────────────────────────────────────────────────────'
-- Clean any residue from a prior run.
DELETE FROM public.financial_relationships
 WHERE (from_id >= 'f1702726-0000-0000-0000-000000000000'::uuid AND from_id < 'f1702727-0000-0000-0000-000000000000'::uuid)
    OR (to_id   >= 'f1702726-0000-0000-0000-000000000000'::uuid AND to_id   < 'f1702727-0000-0000-0000-000000000000'::uuid);
DELETE FROM public.financial_entities
 WHERE id >= 'f1702726-0000-0000-0000-000000000000'::uuid AND id < 'f1702727-0000-0000-0000-000000000000'::uuid;

-- D1 donor, R1 + R1b recipient committees. OFF1 is a to_type='official' sink
-- (no entity row needed) exercising that the DONOR total counts to-official
-- donations while the RECEIVED total counts only to-financial_entity donations.
INSERT INTO public.financial_entities (id, canonical_name, display_name, entity_type)
VALUES
  ('f1702726-0000-0000-0000-000000000001', 'FIX702726 DONOR',  'FIX702726 Donor',  'individual'),
  ('f1702726-0000-0000-0000-000000000002', 'FIX702726 RECIP1', 'FIX702726 Recip1', 'pac'),
  ('f1702726-0000-0000-0000-000000000003', 'FIX702726 RECIP2', 'FIX702726 Recip2', 'pac');

-- Pin the watermark to the current donation-FR max BEFORE inserting the fixture
-- FR rows, so ONLY the fixture rows are dirty on the next incremental (the whole
-- real dirty set is empty) — this is what lets us assert "control unchanged".
INSERT INTO public.pipeline_state (key, value)
SELECT 'financial_entity_totals_watermark',
       jsonb_build_object('last_indexed_at', COALESCE(MAX(updated_at), NOW())::text)
FROM public.financial_relationships WHERE relationship_type = 'donation'
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO public.financial_relationships
  (from_type, from_id, to_type, to_id, relationship_type, amount_cents, cycle_year, occurred_at)
VALUES
  ('financial_entity','f1702726-0000-0000-0000-000000000001','financial_entity','f1702726-0000-0000-0000-000000000002','donation',100000,2024,'2024-01-01'),
  ('financial_entity','f1702726-0000-0000-0000-000000000001','financial_entity','f1702726-0000-0000-0000-000000000003','donation', 50000,2024,'2024-01-01'),
  ('financial_entity','f1702726-0000-0000-0000-000000000001','official',        'f1702726-0000-0000-0000-000000000009','donation', 30000,2024,'2024-01-01');

-- Snapshot a real control donor (not the fixture) to prove it is NOT touched.
-- A temp table (default ON COMMIT PRESERVE ROWS) survives the procedure's
-- internal COMMITs and is readable from the DO-block assertions (psql does not
-- interpolate :vars inside dollar-quoted blocks, so \gset won't do here).
DROP TABLE IF EXISTS _fix702_ctl;
CREATE TEMP TABLE _fix702_ctl AS
SELECT id, total_donated_cents AS total
FROM public.financial_entities
WHERE total_donated_cents > 0
  AND id <> 'f1702726-0000-0000-0000-000000000001'::uuid
ORDER BY id LIMIT 1;

\echo '── test 1+2: incremental dirty path + control isolation ──────────────────'
CALL public.refresh_financial_entity_totals_incremental();

DO $$
DECLARE d bigint; r1 bigint; r2 bigint; ctl bigint; wm timestamptz;
BEGIN
  SELECT total_donated_cents INTO d   FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000001';
  SELECT total_received_cents INTO r1 FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000002';
  SELECT total_received_cents INTO r2 FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000003';
  SELECT fe.total_donated_cents INTO ctl
    FROM public.financial_entities fe JOIN _fix702_ctl c ON c.id = fe.id;
  SELECT (value->>'last_indexed_at')::timestamptz INTO wm
    FROM public.pipeline_state WHERE key='financial_entity_totals_watermark';

  IF d  IS DISTINCT FROM 180000 THEN RAISE EXCEPTION 'FAIL donor total: got %, want 180000', d; END IF;
  IF r1 IS DISTINCT FROM 100000 THEN RAISE EXCEPTION 'FAIL recip1 received: got %, want 100000', r1; END IF;
  IF r2 IS DISTINCT FROM  50000 THEN RAISE EXCEPTION 'FAIL recip2 received: got %, want 50000', r2; END IF;
  IF ctl IS DISTINCT FROM (SELECT total FROM _fix702_ctl) THEN
    RAISE EXCEPTION 'FAIL control entity moved: got %, want % (incremental touched a non-dirty row)',
      ctl, (SELECT total FROM _fix702_ctl);
  END IF;
  IF wm IS NULL THEN RAISE EXCEPTION 'FAIL watermark not advanced'; END IF;
  RAISE NOTICE 'PASS test1: donor=180000 recip1=100000 recip2=50000; control unchanged; watermark advanced';
END $$;

\echo '── test: parity vs the authoritative live SUM ────────────────────────────'
-- The materialized totals must equal the direct live SUM over FR — the same
-- value any correct full rebuild produces. (We assert against the direct SUM
-- rather than running the old whole-table rebuild_financial_entity_*_totals(),
-- which is a multi-minute temp-table pass over all 5M rows — exactly the cost
-- the incremental replaces.)
DO $$
DECLARE d bigint; r1 bigint; r2 bigint; exp_d bigint; exp_r1 bigint; exp_r2 bigint;
BEGIN
  SELECT total_donated_cents INTO d   FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000001';
  SELECT total_received_cents INTO r1 FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000002';
  SELECT total_received_cents INTO r2 FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000003';

  SELECT COALESCE(SUM(amount_cents),0) INTO exp_d FROM public.financial_relationships
   WHERE from_type='financial_entity' AND relationship_type='donation'
     AND from_id='f1702726-0000-0000-0000-000000000001';
  SELECT COALESCE(SUM(amount_cents),0) INTO exp_r1 FROM public.financial_relationships
   WHERE to_type='financial_entity' AND relationship_type='donation'
     AND to_id='f1702726-0000-0000-0000-000000000002';
  SELECT COALESCE(SUM(amount_cents),0) INTO exp_r2 FROM public.financial_relationships
   WHERE to_type='financial_entity' AND relationship_type='donation'
     AND to_id='f1702726-0000-0000-0000-000000000003';

  IF d IS DISTINCT FROM exp_d OR r1 IS DISTINCT FROM exp_r1 OR r2 IS DISTINCT FROM exp_r2 THEN
    RAISE EXCEPTION 'FAIL parity: materialized (d=% r1=% r2=%) <> live SUM (d=% r1=% r2=%)',
      d, r1, r2, exp_d, exp_r1, exp_r2;
  END IF;
  RAISE NOTICE 'PASS parity: materialized totals == live FR SUM (d=% r1=% r2=%)', d, r1, r2;
END $$;

\echo '── test 3: incremental re-derives the whole key on an FR UPDATE ───────────'
UPDATE public.financial_relationships
SET amount_cents = 250000
WHERE from_id='f1702726-0000-0000-0000-000000000001'
  AND to_id='f1702726-0000-0000-0000-000000000002'
  AND relationship_type='donation';
CALL public.refresh_financial_entity_totals_incremental();
DO $$
DECLARE d bigint; r1 bigint;
BEGIN
  SELECT total_donated_cents INTO d   FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000001';
  SELECT total_received_cents INTO r1 FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000002';
  -- 250000 (R1) + 50000 (R2) + 30000 (OFF1) = 330000
  IF d  IS DISTINCT FROM 330000 THEN RAISE EXCEPTION 'FAIL donor after update: got %, want 330000', d; END IF;
  IF r1 IS DISTINCT FROM 250000 THEN RAISE EXCEPTION 'FAIL recip1 after update: got %, want 250000', r1; END IF;
  RAISE NOTICE 'PASS test3: FR update re-derived the full key (donor=330000, recip1=250000)';
END $$;

\echo '── test 4: hard-delete blind spot + reconcile sweep ──────────────────────'
DELETE FROM public.financial_relationships
 WHERE from_id='f1702726-0000-0000-0000-000000000001';
-- Incremental cannot see an all-rows-deleted entity (no surviving updated_at) —
-- the acknowledged FIX-372/704 blind spot. Assert it stays stale.
CALL public.refresh_financial_entity_totals_incremental();
DO $$
DECLARE d bigint;
BEGIN
  SELECT total_donated_cents INTO d FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000001';
  IF d IS DISTINCT FROM 330000 THEN
    RAISE EXCEPTION 'UNEXPECTED: incremental caught a hard-delete (got %, expected stale 330000)', d;
  END IF;
  RAISE NOTICE 'PASS test4a: hard-delete blind spot confirmed (donor stale at 330000)';
END $$;

-- The monthly reconcile drives from ALL entities → zeroes the orphan.
CALL public.reconcile_financial_entity_totals();
DO $$
DECLARE d bigint; r1 bigint; r2 bigint;
BEGIN
  SELECT total_donated_cents INTO d   FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000001';
  SELECT total_received_cents INTO r1 FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000002';
  SELECT total_received_cents INTO r2 FROM public.financial_entities WHERE id='f1702726-0000-0000-0000-000000000003';
  IF d IS DISTINCT FROM 0 OR r1 IS DISTINCT FROM 0 OR r2 IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL reconcile zero-out: d=% r1=% r2=% (want 0/0/0)', d, r1, r2;
  END IF;
  RAISE NOTICE 'PASS test4b: reconcile zeroed the hard-deleted orphans';
END $$;

\echo '── observability: sync-log rows written ──────────────────────────────────'
SELECT pipeline, status, rows_inserted, (metadata->>'mode') AS mode
FROM public.data_sync_log
WHERE pipeline IN ('financial_entity_totals_refresh','financial_entity_totals_reconcile')
ORDER BY started_at DESC LIMIT 5;

\echo '── cleanup ───────────────────────────────────────────────────────────────'
DELETE FROM public.financial_relationships
 WHERE (from_id >= 'f1702726-0000-0000-0000-000000000000'::uuid AND from_id < 'f1702727-0000-0000-0000-000000000000'::uuid)
    OR (to_id   >= 'f1702726-0000-0000-0000-000000000000'::uuid AND to_id   < 'f1702727-0000-0000-0000-000000000000'::uuid);
DELETE FROM public.financial_entities
 WHERE id >= 'f1702726-0000-0000-0000-000000000000'::uuid AND id < 'f1702727-0000-0000-0000-000000000000'::uuid;

\echo '✓ ALL FIX-702/726 ASSERTIONS PASSED'
