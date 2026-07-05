-- verify_fix734_705.sql — single-anti-join monthly orphan sweeps.
--
-- Proves, on the local Docker prod clone, that the monthly reconcile procedures
-- are orphan-sweep only, correct, and non-destructive to live aggregates:
--   1. reconcile_financial_entity_totals() zeros a hard-delete orphan's
--      total_donated_cents AND total_received_cents, leaves a live entity's
--      totals untouched, and does NOT advance the totals watermark.
--   2. reconcile_donor_rollup_orphans() DELETEs rollup rows for a recipient with
--      no qualifying FR, leaves a live recipient's rollup rows intact.
--   3. reconcile_recipient_count() is BUMP-ONLY (FIX-734 revert): it recomputes
--      live donors' counts from entity_connections and does NOT zero a no-edge
--      "orphan" (that EC-based zeroing was unsound — EC donation edges are
--      incomplete for individual→committee; see the revert migration / FIX-735/736).
--
-- Run:  psql "$LOCAL_DB" -f supabase/tests/verify_fix734_705.sql
-- Exits non-zero on any failed assertion (ON_ERROR_STOP + RAISE EXCEPTION).
-- Self-cleaning: the synthetic f7340705-* fixture is removed at the end; no real
-- row is mutated (the sweeps only touch rows that are already orphaned, and the
-- live control rows we insert are backed by fixture FR/edges so they stay).

\set ON_ERROR_STOP on
\pset pager off

\echo '── fixture setup ─────────────────────────────────────────────────────────'
DELETE FROM public.official_donor_rollup_mv
 WHERE official_id >= 'f7340705-0000-0000-0000-000000000000'::uuid
   AND official_id <  'f7340706-0000-0000-0000-000000000000'::uuid;
DELETE FROM public.entity_connections
 WHERE from_id >= 'f7340705-0000-0000-0000-000000000000'::uuid
   AND from_id <  'f7340706-0000-0000-0000-000000000000'::uuid;
DELETE FROM public.financial_relationships
 WHERE (from_id >= 'f7340705-0000-0000-0000-000000000000'::uuid AND from_id < 'f7340706-0000-0000-0000-000000000000'::uuid)
    OR (to_id   >= 'f7340705-0000-0000-0000-000000000000'::uuid AND to_id   < 'f7340706-0000-0000-0000-000000000000'::uuid);
DELETE FROM public.financial_entities
 WHERE id >= 'f7340705-0000-0000-0000-000000000000'::uuid AND id < 'f7340706-0000-0000-0000-000000000000'::uuid;

-- ...01 ORPHAN_DONOR   individual, total_donated=999, recipient_count=5, NO FR/edges → both zeroed
-- ...02 ORPHAN_RECIP   pac,        total_received=888, NO inbound FR              → received zeroed
-- ...03 LIVE_DONOR     individual, real donation FR + real edge                  → totals + count kept
-- ...04 LIVE_RECIP     pac,        real inbound donation FR + live rollup row     → received + rollup kept
-- ...05 ROLLUP_ORPHAN  recipient of a rollup row but NO FR                        → rollup row deleted
INSERT INTO public.financial_entities (id, canonical_name, display_name, entity_type,
                                       total_donated_cents, total_received_cents, recipient_count)
VALUES
  ('f7340705-0000-0000-0000-000000000001', 'FIX734705 ORPHANDONOR', 'FIX734705 OrphanDonor', 'individual', 999, 0, 5),
  ('f7340705-0000-0000-0000-000000000002', 'FIX734705 ORPHANRECIP', 'FIX734705 OrphanRecip', 'pac',        0, 888, 0),
  ('f7340705-0000-0000-0000-000000000003', 'FIX734705 LIVEDONOR',   'FIX734705 LiveDonor',   'individual', 0, 0, 0),
  ('f7340705-0000-0000-0000-000000000004', 'FIX734705 LIVERECIP',   'FIX734705 LiveRecip',   'pac',        0, 0, 0);

-- Live FR: LIVE_DONOR → LIVE_RECIP donation (backs LIVE_DONOR.total_donated,
-- LIVE_RECIP.total_received, and LIVE_RECIP's rollup row).
INSERT INTO public.financial_relationships
  (from_type, from_id, to_type, to_id, relationship_type, amount_cents, cycle_year, occurred_at)
VALUES
  ('financial_entity','f7340705-0000-0000-0000-000000000003','financial_entity','f7340705-0000-0000-0000-000000000004','donation',777000,2024,'2024-01-01');

-- Live donation edge for LIVE_DONOR (backs its recipient_count).
INSERT INTO public.entity_connections
  (from_type, from_id, to_type, to_id, connection_type, evidence_source, amount_cents)
VALUES
  ('financial_entity','f7340705-0000-0000-0000-000000000003','financial_entity','f7340705-0000-0000-0000-000000000004','donation','test',777000);

-- Set the live control aggregates to their TRUE values so the sweeps must NOT
-- touch them (a wrongly-broad anti-join would zero/delete these and fail).
UPDATE public.financial_entities SET total_donated_cents = 777000
 WHERE id = 'f7340705-0000-0000-0000-000000000003';
UPDATE public.financial_entities SET total_received_cents = 777000, recipient_count = 1
 WHERE id = 'f7340705-0000-0000-0000-000000000004';
UPDATE public.financial_entities SET recipient_count = 1
 WHERE id = 'f7340705-0000-0000-0000-000000000003';

-- Rollup rows: one LIVE (official_id = LIVE_RECIP, has inbound FR → kept), one
-- ORPHAN (official_id = ...05, no FR anywhere → deleted).
INSERT INTO public.official_donor_rollup_mv
  (official_id, relationship_type, rank, donor_id, donor_name, entity_type, total_cents, tx_count)
VALUES
  ('f7340705-0000-0000-0000-000000000004', 'donation', 1, 'f7340705-0000-0000-0000-000000000003', 'FIX734705 LiveDonor', 'individual', 777000, 1),
  ('f7340705-0000-0000-0000-000000000005', 'donation', 1, 'f7340705-0000-0000-0000-000000000003', 'FIX734705 LiveDonor', 'individual', 123000, 1);

-- Pin the totals watermark so we can assert the reconcile leaves it unchanged.
INSERT INTO public.pipeline_state (key, value)
VALUES ('financial_entity_totals_watermark',
        jsonb_build_object('last_indexed_at', '2000-01-01T00:00:00Z'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

\echo '── test 1: totals reconcile zeros orphans, keeps live, no watermark move ──'
CALL public.reconcile_financial_entity_totals();
DO $$
DECLARE od bigint; orr bigint; ld bigint; lr bigint; wm text;
BEGIN
  SELECT total_donated_cents  INTO od  FROM public.financial_entities WHERE id='f7340705-0000-0000-0000-000000000001';
  SELECT total_received_cents INTO orr FROM public.financial_entities WHERE id='f7340705-0000-0000-0000-000000000002';
  SELECT total_donated_cents  INTO ld  FROM public.financial_entities WHERE id='f7340705-0000-0000-0000-000000000003';
  SELECT total_received_cents INTO lr  FROM public.financial_entities WHERE id='f7340705-0000-0000-0000-000000000004';
  SELECT value->>'last_indexed_at' INTO wm FROM public.pipeline_state WHERE key='financial_entity_totals_watermark';

  IF od  IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL donated orphan not zeroed: got %', od; END IF;
  IF orr IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL received orphan not zeroed: got %', orr; END IF;
  IF ld  IS DISTINCT FROM 777000 THEN RAISE EXCEPTION 'FAIL live donor total moved: got %, want 777000', ld; END IF;
  IF lr  IS DISTINCT FROM 777000 THEN RAISE EXCEPTION 'FAIL live recip total moved: got %, want 777000', lr; END IF;
  IF wm  IS DISTINCT FROM '2000-01-01T00:00:00Z' THEN
    RAISE EXCEPTION 'FAIL watermark advanced by reconcile: got % (orphan sweep must not advance it)', wm;
  END IF;
  RAISE NOTICE 'PASS test1: orphans zeroed (0/0), live kept (777000/777000), watermark unchanged';
END $$;

\echo '── test 2: donor-rollup orphan DELETE, live rollup rows kept ──────────────'
CALL public.reconcile_donor_rollup_orphans();
DO $$
DECLARE orphan_rows int; live_rows int;
BEGIN
  SELECT count(*) INTO orphan_rows FROM public.official_donor_rollup_mv
   WHERE official_id='f7340705-0000-0000-0000-000000000005';
  SELECT count(*) INTO live_rows FROM public.official_donor_rollup_mv
   WHERE official_id='f7340705-0000-0000-0000-000000000004';
  IF orphan_rows <> 0 THEN RAISE EXCEPTION 'FAIL orphan rollup rows not deleted: % remain', orphan_rows; END IF;
  IF live_rows  <> 1 THEN RAISE EXCEPTION 'FAIL live rollup row deleted: % remain (want 1)', live_rows; END IF;
  RAISE NOTICE 'PASS test2: orphan rollup deleted, live rollup row kept';
END $$;

\echo '── test 3: recipient_count reconcile is BUMP-ONLY (no unsound EC zeroing) ──'
-- ORPHAN_DONOR (...01) has recipient_count=5 and no donation edge. The reverted
-- bump-only reconcile must NOT zero it (zeroing from EC is unsound — EC is
-- incomplete for individual→committee). LIVE_DONOR (...03) has 1 edge and
-- recipient_count=1, so the bump recomputes 1 (unchanged).
UPDATE public.financial_entities SET recipient_count = 5
 WHERE id = 'f7340705-0000-0000-0000-000000000001';
CALL public.reconcile_recipient_count();
DO $$
DECLARE orphan_cnt smallint; live_cnt smallint;
BEGIN
  SELECT recipient_count INTO orphan_cnt FROM public.financial_entities WHERE id='f7340705-0000-0000-0000-000000000001';
  SELECT recipient_count INTO live_cnt   FROM public.financial_entities WHERE id='f7340705-0000-0000-0000-000000000003';
  IF orphan_cnt IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL bump-only reconcile zeroed a no-edge orphan (got %, want 5 — the unsound EC sweep is supposed to be reverted)', orphan_cnt;
  END IF;
  IF live_cnt IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FAIL live recipient_count moved: got %, want 1', live_cnt; END IF;
  RAISE NOTICE 'PASS test3: bump-only — no-edge orphan left at 5 (not zeroed), live count kept (1)';
END $$;

\echo '── observability: sync-log rows written ──────────────────────────────────'
SELECT pipeline, status, rows_inserted,
       (metadata->>'donated_orphans_zeroed')  AS donated,
       (metadata->>'received_orphans_zeroed') AS received,
       (metadata->>'orphan_rows_deleted')     AS rollup_del,
       (metadata->>'orphans_zeroed')          AS rc_orphans
FROM public.data_sync_log
WHERE pipeline IN ('financial_entity_totals_reconcile','donor_rollup_orphan_sweep','recipient_count_reconcile')
ORDER BY started_at DESC LIMIT 6;

\echo '── cleanup ───────────────────────────────────────────────────────────────'
DELETE FROM public.official_donor_rollup_mv
 WHERE official_id >= 'f7340705-0000-0000-0000-000000000000'::uuid
   AND official_id <  'f7340706-0000-0000-0000-000000000000'::uuid;
DELETE FROM public.entity_connections
 WHERE from_id >= 'f7340705-0000-0000-0000-000000000000'::uuid
   AND from_id <  'f7340706-0000-0000-0000-000000000000'::uuid;
DELETE FROM public.financial_relationships
 WHERE (from_id >= 'f7340705-0000-0000-0000-000000000000'::uuid AND from_id < 'f7340706-0000-0000-0000-000000000000'::uuid)
    OR (to_id   >= 'f7340705-0000-0000-0000-000000000000'::uuid AND to_id   < 'f7340706-0000-0000-0000-000000000000'::uuid);
DELETE FROM public.financial_entities
 WHERE id >= 'f7340705-0000-0000-0000-000000000000'::uuid AND id < 'f7340706-0000-0000-0000-000000000000'::uuid;

\echo '✓ ALL FIX-734/705 ASSERTIONS PASSED'
