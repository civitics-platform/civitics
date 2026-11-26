-- 20261126007000_fix1456_ec_cosponsors_arm_merge.sql
-- FIX-1456 — rebuild_entity_connections_cosponsors() merges its set instead of
-- deleting every co_sponsorship edge and re-inserting one per cosponsor row
-- (cc-328, D1–D4). The shape is FIX-1439's contracts merge (20261122001000).
--
-- THE FINDING (cc-327 read 4). The arm (20260905000000_fix1136 §2, less the SET
--   FIX-1128 RESET; md5(prosrc) d534e1637a5b49d2e6ef852a34b3bbdd on the clone
--   and on prod at cc-328 read 1) DELETEs every co_sponsorship /
--   cosponsorship edge, INSERTs one per non-withdrawn proposal_cosponsors row,
--   then ANALYZEs public.entity_connections. ec_arm_source_fingerprint()
--   fingerprints it as count(*), max(created_at) on proposal_cosponsors, so
--   every chunk of the bill-details fill re-runs it whole. Harmless at prod's 0
--   rows; under the fill, 100–170 K edges rewritten each cycle the count moves.
--   The fingerprint is not changed here (D5, FIX-1457).
--
-- THE MERGE (D1). The set is built ONCE into a temp table: one row per
--   non-withdrawn proposal_cosponsors row, the columns and the strength
--   (0.700 original / 0.600) exactly as the INSERT produced them.
--   proposal_cosponsors_unique (proposal_id, official_id) makes its key unique.
--   Then, scoped as FIX-1136 scoped the arm (connection_type = 'co_sponsorship'
--   AND evidence_source = 'cosponsorship'):
--     1. DELETEs the edges whose key is not in the set;
--     2. UPDATEs the rows whose key is in the set and whose strength,
--        occurred_at, evidence_count or evidence_ids IS DISTINCT FROM the
--        set's, stamping derived_at on those rows only;
--     3. INSERTs the set rows with no edge of their key from this source (a
--        key held by another producer meets the unique key, as the
--        delete-all + insert did).
--   A key column is never UPDATEd; a row equal on every value is not written
--   and keeps its id, derived_at and ctid.
--
-- THE COUNTS (D2). edges_upserted stays the size of the set, what the
--   delete-all + insert returned: run_entity_connections_rebuild() passes it to
--   ec_crawl_record_unit() as the throughput sensor's denominator, and a
--   written count would trip the 2 h backoff. The rows written are a NOTICE:
--     [cosponsors] merge: deleted % / updated % / inserted % / untouched %
--
-- THE ANALYZE (D3). The trailing ANALYZE public.entity_connections runs only
--   when the merge wrote at least one row.
--
-- WHAT IS UNCHANGED. The signature, RETURNS TABLE(connection_type text,
--   edges_upserted bigint), LANGUAGE plpgsql, and no SET: the newest definer
--   (20260905000000) re-stated SET statement_timeout TO '10min', which FIX-1128
--   (20260913000000) RESET — the live proconfig is NULL and check:proconfig
--   holds it there. The returned row, the grants.
--
-- MEASURED on the clone (cc-328 read 3, 2026-11-26 22:1xZ): 3,649 non-withdrawn
--   proposal_cosponsors rows (3,655 in all, grown by the local walker),
--   entity_connections reltuples 6.9 M; one rolled-back transaction each case;
--   n_tup from pg_stat_xact_user_tables, WAL from pg_current_wal_insert_lsn():
--                                        wall      ins / upd / del         WAL
--     old (delete-all + insert), empty   8.42 s    3,649 / 0 / 0           36.6 MB
--     old, again (every cycle)           5.85 s    3,649 / 0 / 3,649       16.9 MB
--     new (merge), from empty            4.84 s    3,649 / 0 / 0           17.4 MB
--     new, first run over old's output   0.03 s    0 / 0 / 0                0.11 MB
--     new, again                         0.03 s    0 / 0 / 0                0.08 MB
--     new, after one inserted row        3.03 s    1 / 0 / 0                0.18 MB
--     new, after one row withdrawn       2.71 s    0 / 0 / 1                0.15 MB
--     new, after one original flipped    2.57 s    0 / 1 / 0                0.18 MB
--     old over that state (reference)    4.25 s    3,649 / 0 / 3,649       45.9 MB
--   The edge set equals the old body's on every value column from empty, over
--   the old body's output and after the three edits (0 / 0 each way). The
--   0.08 MB a zero-write call costs is the temp table's catalog rows.
--   ANALYZE public.entity_connections alone: 4.23 / 3.91 / 3.58 s — more than
--   the merge of a 15-minute walker run's rows (~2,600 rows, about 1 s), so a
--   write of one row costs ~3 s, nearly all of it the ANALYZE (D3: filed, not
--   removed here; ec-vacuum-analyze is floor-gated at 24 h).
--
-- CLASS: P. One CREATE OR REPLACE, its grants, a guard and a read-back. Prod
--   holds 0 proposal_cosponsors rows and 0 co_sponsorship edges at the push, so
--   the first call writes nothing.
--
-- ROLLBACK: scripts/fix1456-revert-ec-cosponsors-arm.sql — the old body
--   verbatim, without the inert SET. It drops nothing.

-- ── 1. Guard — the body this replaces, or this file's ─────────────────────────

DO $$
DECLARE
  v_d text;
BEGIN
  SELECT md5(prosrc) INTO v_d FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_cosponsors' AND pronamespace = 'public'::regnamespace;
  IF v_d IS DISTINCT FROM 'd534e1637a5b49d2e6ef852a34b3bbdd' AND v_d IS DISTINCT FROM '675d2a6836402c235107e0f8a1686ae8' THEN
    RAISE EXCEPTION '[fix1456] rebuild_entity_connections_cosponsors md5 % is neither FIX-1136''s d534e1637a5b49d2e6ef852a34b3bbdd nor this file''s 675d2a6836402c235107e0f8a1686ae8 — the body moved; rebuild this file on the live body',
      COALESCE(v_d, '(no function)');
  END IF;
  RAISE NOTICE '[fix1456] guard: rebuild_entity_connections_cosponsors %', v_d;
END $$;

-- ── 2. rebuild_entity_connections_cosponsors() — a merge ──────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_cosponsors()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE v_count BIGINT;
  v_deleted  BIGINT;   -- FIX-1456: the merge's counts
  v_updated  BIGINT;
  v_inserted BIGINT;
BEGIN
  -- FIX-1456 — the set, built once: one row per non-withdrawn cosponsor row,
  -- the columns and the strength as the INSERT produced them.
  -- proposal_cosponsors_unique (proposal_id, official_id) makes its key unique.
  -- connection_type is an OUT column of this function, so the set carries none:
  -- every row is 'co_sponsorship'. Dropped at the end, so a second call in one
  -- transaction can build it again.
  CREATE TEMP TABLE _ec_cosponsors_set (
    from_type       text,
    from_id         uuid,
    to_type         text,
    to_id           uuid,
    strength        numeric(4,3),
    occurred_at     date,
    evidence_count  integer,
    evidence_ids    uuid[]
  ) ON COMMIT DROP;

  INSERT INTO _ec_cosponsors_set (
    from_type, from_id, to_type, to_id,
    strength, occurred_at, evidence_count, evidence_ids
  )
  SELECT
    'official', pc.official_id, 'proposal', pc.proposal_id,
    CASE WHEN pc.is_original_cosponsor THEN 0.700 ELSE 0.600 END::numeric(4,3),
    pc.date_added,
    1, ARRAY[pc.id]
  FROM public.proposal_cosponsors pc
  WHERE pc.date_withdrawn IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  ANALYZE _ec_cosponsors_set;

  -- 1. An edge whose key left the set goes. FIX-1136's scope.
  WITH gone AS (
    DELETE FROM public.entity_connections ec
     WHERE ec.connection_type = 'co_sponsorship'
       AND ec.evidence_source = 'cosponsorship'
       AND NOT EXISTS (
         SELECT 1 FROM _ec_cosponsors_set s
          WHERE s.from_type = ec.from_type AND s.from_id = ec.from_id
            AND s.to_type = ec.to_type AND s.to_id = ec.to_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM gone;

  -- 2. Same key, a value moved: written, derived_at stamped. A row equal on
  --    every value is not written. No key column is in the SET list.
  WITH changed AS (
    UPDATE public.entity_connections ec
       SET strength       = s.strength,
           occurred_at    = s.occurred_at,
           evidence_count = s.evidence_count,
           evidence_ids   = s.evidence_ids,
           derived_at     = NOW()
      FROM _ec_cosponsors_set s
     WHERE ec.connection_type = 'co_sponsorship'
       AND ec.evidence_source = 'cosponsorship'
       AND s.from_type = ec.from_type AND s.from_id = ec.from_id
       AND s.to_type = ec.to_type AND s.to_id = ec.to_id
       AND (ec.strength       IS DISTINCT FROM s.strength
         OR ec.occurred_at    IS DISTINCT FROM s.occurred_at
         OR ec.evidence_count IS DISTINCT FROM s.evidence_count
         OR ec.evidence_ids   IS DISTINCT FROM s.evidence_ids)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM changed;

  -- 3. The set rows with no edge of their key from this source.
  WITH added AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT s.from_type, s.from_id, s.to_type, s.to_id, 'co_sponsorship'::public.connection_type,
           s.strength, s.occurred_at,
           s.evidence_count, 'cosponsorship', s.evidence_ids
      FROM _ec_cosponsors_set s
     WHERE NOT EXISTS (
       SELECT 1 FROM public.entity_connections ec
        WHERE ec.from_type = s.from_type AND ec.from_id = s.from_id
          AND ec.to_type = s.to_type AND ec.to_id = s.to_id
          AND ec.connection_type = 'co_sponsorship'
          AND ec.evidence_source = 'cosponsorship')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM added;

  RAISE NOTICE '[cosponsors] merge: deleted % / updated % / inserted % / untouched %',
    v_deleted, v_updated, v_inserted, v_count - v_updated - v_inserted;

  DROP TABLE _ec_cosponsors_set;

  -- FIX-1456 (D2): the set's size, as the delete-all + insert returned it — the
  -- crawl sensor's throughput denominator. The rows written are in the NOTICE.
  connection_type := 'co_sponsorship'; edges_upserted := v_count; RETURN NEXT;

  -- FIX-1456 (D3): the trailing ANALYZE only when the merge wrote a row.
  IF v_deleted + v_updated + v_inserted > 0 THEN
    ANALYZE public.entity_connections;
  END IF;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_cosponsors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_cosponsors() TO service_role;

-- ── 3. Read-back ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_new CONSTANT text := '675d2a6836402c235107e0f8a1686ae8';
  c_old CONSTANT text := 'd534e1637a5b49d2e6ef852a34b3bbdd';
  v_md5 text;
  v_cfg text[];
BEGIN
  SELECT md5(prosrc), proconfig INTO v_md5, v_cfg FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_cosponsors' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM c_new THEN
    RAISE EXCEPTION '[fix1456] read-back failed: rebuild_entity_connections_cosponsors md5 %, expected % (was %)', v_md5, c_new, c_old;
  END IF;
  IF v_cfg IS NOT NULL THEN
    RAISE EXCEPTION '[fix1456] read-back failed: rebuild_entity_connections_cosponsors carries a SET clause: %', v_cfg;
  END IF;
  RAISE NOTICE '[fix1456] read-back ok: rebuild_entity_connections_cosponsors % (was %)', v_md5, c_old;
END $$;
