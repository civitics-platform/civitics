-- verify_fix736.sql — recipient_count is FR-derived, not EC-derived.
--
-- The SOUNDNESS proof for the FIX-734 bug. recipient_count used to be maintained
-- from entity_connections donation edges, which are INCOMPLETE for individual→
-- committee (FIX-735) — so the EC-based orphan sweep zeroed ~124k donors who had
-- real donation FR to committees the graph has no edge for. This test proves the
-- FR-derived maintenance is correct AND that the FR-based orphan sweep does NOT
-- reproduce that bug.
--
-- Proves, on the local Docker prod clone:
--   CRUX  an individual with a real donation FR to a committee that has NO
--         entity_connections edge is (a) counted correctly by the FR-derived
--         incremental and (b) NOT zeroed by the FR-based orphan sweep. This is the
--         exact case the EC-based sweep got wrong.
--   1. the FR-derived incremental sets recipient_count = COUNT(DISTINCT to_id) of
--      donation FR for only the dirty individual donors; a real control is
--      untouched; parity vs a direct COUNT(DISTINCT to_id).
--   2. the FR-based orphan sweep (folded into reconcile_financial_entity_totals)
--      zeros a genuine orphan (count>0, no FR) and leaves a live donor untouched.
--   3. the FR-derived window fn (bootstrap / break-glass path) bumps + zeros.
--   4. the EC rebuild (rebuild_entity_connections_donations) NO LONGER writes
--      recipient_count — it builds an edge but leaves a sentinel count untouched.
--
-- Run:  psql "$LOCAL_DB" -f supabase/tests/verify_fix736.sql
-- Exits non-zero on any failed assertion (ON_ERROR_STOP + RAISE EXCEPTION).
-- Self-cleaning: the synthetic f7360000-* fixture is removed at the end; no real
-- row is mutated (the incremental/sweep only touch the dirty fixtures + already-
-- orphaned rows, and the real control is backed by live FR).

\set ON_ERROR_STOP on
\pset pager off

\echo '── fixture setup ─────────────────────────────────────────────────────────'
DELETE FROM public.entity_connections
 WHERE from_id >= 'f7360000-0000-0000-0000-000000000000'::uuid
   AND from_id <  'f7360001-0000-0000-0000-000000000000'::uuid;
DELETE FROM public.financial_relationships
 WHERE (from_id >= 'f7360000-0000-0000-0000-000000000000'::uuid AND from_id < 'f7360001-0000-0000-0000-000000000000'::uuid)
    OR (to_id   >= 'f7360000-0000-0000-0000-000000000000'::uuid AND to_id   < 'f7360001-0000-0000-0000-000000000000'::uuid);
DELETE FROM public.financial_entities
 WHERE id >= 'f7360000-0000-0000-0000-000000000000'::uuid AND id < 'f7360001-0000-0000-0000-000000000000'::uuid;

-- ...0001 EDGELESS_DONOR  individual, donation FR → RECIP_A but NO EC edge  → crux
-- ...0002 GENUINE_ORPHAN  individual, recipient_count=3, NO FR anywhere     → zeroed
-- ...0003 LIVE_DONOR      individual, donation FR → RECIP_B + RECIP_C        → count=2
-- ...0091/92/93 recipient committees (donation to_id targets)
INSERT INTO public.financial_entities (id, canonical_name, display_name, entity_type, recipient_count)
VALUES
  ('f7360000-0000-0000-0000-000000000001', 'FIX736 EDGELESSDONOR', 'FIX736 EdgelessDonor', 'individual', 0),
  ('f7360000-0000-0000-0000-000000000002', 'FIX736 GENUINEORPHAN', 'FIX736 GenuineOrphan', 'individual', 3),
  ('f7360000-0000-0000-0000-000000000003', 'FIX736 LIVEDONOR',     'FIX736 LiveDonor',     'individual', 0),
  ('f7360000-0000-0000-0000-000000000091', 'FIX736 RECIPA',        'FIX736 RecipA',        'pac',        0),
  ('f7360000-0000-0000-0000-000000000092', 'FIX736 RECIPB',        'FIX736 RecipB',        'pac',        0),
  ('f7360000-0000-0000-0000-000000000093', 'FIX736 RECIPC',        'FIX736 RecipC',        'pac',        0);

-- Capture the pre-fixture donation-FR maxima BEFORE inserting fixture FR, so ONLY
-- the fixture rows are dirty on the next incremental / EC rebuild (the whole real
-- dirty set is empty). Two maxima: donation-only (totals path) and
-- donation+ie_support (EC path). A temp table survives the procedures' internal
-- COMMITs and is readable from later INSERT…SELECTs.
DROP TABLE IF EXISTS _fix736_wm;
CREATE TEMP TABLE _fix736_wm AS
SELECT
  (SELECT MAX(updated_at) FROM public.financial_relationships WHERE relationship_type = 'donation')                    AS wm_tot,
  (SELECT MAX(updated_at) FROM public.financial_relationships WHERE relationship_type IN ('donation','ie_support'))    AS wm_ec;

-- Pin the totals watermark to the pre-fixture donation max.
INSERT INTO public.pipeline_state (key, value)
SELECT 'financial_entity_totals_watermark',
       jsonb_build_object('last_indexed_at', COALESCE(wm_tot, NOW())::text)
FROM _fix736_wm
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO public.financial_relationships
  (from_type, from_id, to_type, to_id, relationship_type, amount_cents, cycle_year, occurred_at)
VALUES
  ('financial_entity','f7360000-0000-0000-0000-000000000001','financial_entity','f7360000-0000-0000-0000-000000000091','donation',100000,2024,'2024-01-01'),
  ('financial_entity','f7360000-0000-0000-0000-000000000003','financial_entity','f7360000-0000-0000-0000-000000000092','donation', 50000,2024,'2024-01-01'),
  ('financial_entity','f7360000-0000-0000-0000-000000000003','financial_entity','f7360000-0000-0000-0000-000000000093','donation', 70000,2024,'2024-01-01');

-- NOTE: deliberately NO entity_connections edges inserted for EDGELESS_DONOR (or
-- any fixture) — the crux is that FR-derived counting needs no edge.

-- Real control: an individual with recipient_count>0 that DOES have donation FR
-- (so the sweep must not zero it) and is non-dirty (its FR predates the pinned
-- watermark, so the incremental must not touch it).
DROP TABLE IF EXISTS _fix736_ctl;
CREATE TEMP TABLE _fix736_ctl AS
SELECT fe.id, fe.recipient_count AS cnt
FROM public.financial_entities fe
WHERE fe.entity_type = 'individual'
  AND fe.recipient_count > 0
  AND fe.id < 'f7360000-0000-0000-0000-000000000000'::uuid
  AND EXISTS (
    SELECT 1 FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity' AND fr.relationship_type = 'donation'
      AND fr.from_id = fe.id
  )
ORDER BY fe.id LIMIT 1;

\echo '── test 1 + CRUX(a): FR-derived incremental counts an EDGE-LESS donation ──'
CALL public.refresh_financial_entity_totals_incremental();
DO $$
DECLARE edgeless smallint; live smallint; orphan smallint; ctl smallint;
        exp_edgeless bigint; exp_live bigint; wm timestamptz; edge_ct int;
BEGIN
  SELECT recipient_count INTO edgeless FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000001';
  SELECT recipient_count INTO live     FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000003';
  SELECT recipient_count INTO orphan   FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000002';
  SELECT fe.recipient_count INTO ctl
    FROM public.financial_entities fe JOIN _fix736_ctl c ON c.id = fe.id;
  SELECT (value->>'last_indexed_at')::timestamptz INTO wm
    FROM public.pipeline_state WHERE key='financial_entity_totals_watermark';

  -- Sanity: EDGELESS_DONOR genuinely has NO donation edge (the crux precondition).
  SELECT count(*) INTO edge_ct FROM public.entity_connections
   WHERE connection_type='donation' AND from_type='financial_entity'
     AND from_id='f7360000-0000-0000-0000-000000000001';
  IF edge_ct <> 0 THEN RAISE EXCEPTION 'FIXTURE BROKEN: EDGELESS_DONOR has % donation edge(s), expected 0', edge_ct; END IF;

  -- CRUX (a): counted despite having no EC edge.
  IF edgeless IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL CRUX(a): edge-less donor recipient_count = %, want 1 (FR-derived count must not need an edge)', edgeless;
  END IF;
  IF live IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'FAIL live donor count: got %, want 2', live; END IF;
  -- Bump-only incremental must not zero the genuine orphan (not in the dirty set).
  IF orphan IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'FAIL incremental touched a non-dirty orphan: got %, want 3', orphan; END IF;
  IF ctl IS DISTINCT FROM (SELECT cnt FROM _fix736_ctl) THEN
    RAISE EXCEPTION 'FAIL control moved: got %, want % (incremental touched a non-dirty row)', ctl, (SELECT cnt FROM _fix736_ctl);
  END IF;
  IF wm IS NULL THEN RAISE EXCEPTION 'FAIL watermark not advanced'; END IF;

  -- Parity vs direct COUNT(DISTINCT to_id) from FR.
  SELECT COUNT(DISTINCT to_id) INTO exp_edgeless FROM public.financial_relationships
   WHERE from_type='financial_entity' AND relationship_type='donation' AND from_id='f7360000-0000-0000-0000-000000000001';
  SELECT COUNT(DISTINCT to_id) INTO exp_live FROM public.financial_relationships
   WHERE from_type='financial_entity' AND relationship_type='donation' AND from_id='f7360000-0000-0000-0000-000000000003';
  IF edgeless IS DISTINCT FROM exp_edgeless OR live IS DISTINCT FROM exp_live THEN
    RAISE EXCEPTION 'FAIL parity: materialized (edgeless=% live=%) <> FR COUNT(DISTINCT to_id) (edgeless=% live=%)', edgeless, live, exp_edgeless, exp_live;
  END IF;

  RAISE NOTICE 'PASS test1+CRUX(a): edge-less donor counted=1 (no edge), live=2, orphan untouched=3, control unchanged, parity holds';
END $$;

\echo '── test 2 + CRUX(b): FR-based sweep does NOT zero the edge-less donor ─────'
-- The regression guard against the EC-based bug: EDGELESS_DONOR has a real
-- donation FR, so the sweep must leave it at 1 even though it has no edge.
-- GENUINE_ORPHAN (no FR at all) is the only one that gets zeroed.
CALL public.reconcile_financial_entity_totals();
DO $$
DECLARE edgeless smallint; live smallint; orphan smallint; ctl smallint;
BEGIN
  SELECT recipient_count INTO edgeless FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000001';
  SELECT recipient_count INTO live     FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000003';
  SELECT recipient_count INTO orphan   FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000002';
  SELECT fe.recipient_count INTO ctl
    FROM public.financial_entities fe JOIN _fix736_ctl c ON c.id = fe.id;

  IF edgeless IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL CRUX(b): FR sweep zeroed an edge-less donor WITH donation FR (got %, want 1) — this is the reverted EC bug', edgeless;
  END IF;
  IF live IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'FAIL live donor zeroed by sweep: got %, want 2', live; END IF;
  IF orphan IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL genuine orphan (no FR) not zeroed: got %, want 0', orphan; END IF;
  IF ctl IS DISTINCT FROM (SELECT cnt FROM _fix736_ctl) THEN
    RAISE EXCEPTION 'FAIL control zeroed by sweep: got %, want % (control has FR — must survive)', ctl, (SELECT cnt FROM _fix736_ctl);
  END IF;

  RAISE NOTICE 'PASS test2+CRUX(b): edge-less-with-FR donor kept=1, live kept=2, genuine orphan zeroed=0, control kept';
END $$;

\echo '── test 3: FR-derived window fn (bootstrap / break-glass) bumps + zeros ───'
-- Corrupt EDGELESS to a wrong value and GENUINE_ORPHAN back to a positive value,
-- then run the two-pass window over the narrow fixture id-range only.
UPDATE public.financial_entities SET recipient_count = 77 WHERE id='f7360000-0000-0000-0000-000000000001';
UPDATE public.financial_entities SET recipient_count =  9 WHERE id='f7360000-0000-0000-0000-000000000002';
SELECT public.financial_entity_recipient_count_window(
  'f7360000-0000-0000-0000-000000000000'::uuid,
  'f7360001-0000-0000-0000-000000000000'::uuid
);
DO $$
DECLARE edgeless smallint; orphan smallint;
BEGIN
  SELECT recipient_count INTO edgeless FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000001';
  SELECT recipient_count INTO orphan   FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000002';
  IF edgeless IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FAIL window bump: got %, want 1', edgeless; END IF;
  IF orphan   IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL window zero pass: got %, want 0', orphan; END IF;
  RAISE NOTICE 'PASS test3: window fn bumped edge-less→1 and zeroed no-FR orphan→0';
END $$;

\echo '── test 4: EC rebuild no longer writes recipient_count (decision 2) ───────'
-- Sentinel: set EDGELESS to 99, pin the EC watermark to the pre-fixture max so the
-- fixture FR are dirty, run the EC donations incremental. It must build a donation
-- edge for EDGELESS (proving it ran) yet leave recipient_count at the sentinel 99.
UPDATE public.financial_entities SET recipient_count = 99 WHERE id='f7360000-0000-0000-0000-000000000001';
INSERT INTO public.pipeline_state (key, value)
SELECT 'entity_connections_donations',
       jsonb_build_object('last_indexed_at', COALESCE(wm_ec, NOW())::text)
FROM _fix736_wm
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

SELECT * FROM public.rebuild_entity_connections_donations();
DO $$
DECLARE edgeless smallint; edge_ct int;
BEGIN
  SELECT recipient_count INTO edgeless FROM public.financial_entities WHERE id='f7360000-0000-0000-0000-000000000001';
  SELECT count(*) INTO edge_ct FROM public.entity_connections
   WHERE connection_type='donation' AND from_type='financial_entity'
     AND from_id='f7360000-0000-0000-0000-000000000001';
  IF edge_ct < 1 THEN RAISE EXCEPTION 'FIXTURE: EC rebuild did not build the edge (edges=%), test is vacuous', edge_ct; END IF;
  IF edgeless IS DISTINCT FROM 99 THEN
    RAISE EXCEPTION 'FAIL: EC rebuild wrote recipient_count (got %, want sentinel 99) — decision 2 violated', edgeless;
  END IF;
  RAISE NOTICE 'PASS test4: EC rebuild built the edge but left recipient_count at sentinel 99 (edges-only)';
END $$;

\echo '── observability: sync-log rows written ──────────────────────────────────'
SELECT pipeline, status, rows_inserted,
       (metadata->>'recipient_count_updated')         AS rc_updated,
       (metadata->>'recipient_count_orphans_zeroed')  AS rc_orphans
FROM public.data_sync_log
WHERE pipeline IN ('financial_entity_totals_refresh','financial_entity_totals_reconcile')
ORDER BY started_at DESC LIMIT 4;

\echo '── cleanup ───────────────────────────────────────────────────────────────'
DELETE FROM public.entity_connections
 WHERE from_id >= 'f7360000-0000-0000-0000-000000000000'::uuid
   AND from_id <  'f7360001-0000-0000-0000-000000000000'::uuid;
DELETE FROM public.financial_relationships
 WHERE (from_id >= 'f7360000-0000-0000-0000-000000000000'::uuid AND from_id < 'f7360001-0000-0000-0000-000000000000'::uuid)
    OR (to_id   >= 'f7360000-0000-0000-0000-000000000000'::uuid AND to_id   < 'f7360001-0000-0000-0000-000000000000'::uuid);
DELETE FROM public.financial_entities
 WHERE id >= 'f7360000-0000-0000-0000-000000000000'::uuid AND id < 'f7360001-0000-0000-0000-000000000000'::uuid;

\echo '✓ ALL FIX-736 ASSERTIONS PASSED'
