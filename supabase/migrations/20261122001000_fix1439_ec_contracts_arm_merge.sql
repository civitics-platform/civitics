-- 20261122001000_fix1439_ec_contracts_arm_merge.sql
-- FIX-1439 — rebuild_entity_connections_contracts() merges its aggregate
-- instead of deleting every contract_award edge and re-inserting all of them
-- (built by cc-308, landed by cc-310 on Craig's ruling below).
--
-- Design of record: cc-308's prompt, D1, D3–D9, on cc-302's read 8. The shape
-- is FIX-1409's rebuild_entity_connections_votes_full() merge (20261117000000)
-- and this run's FIX-1441 window (20261122000000).
--
-- THE FINDING (FIX-1439, cc-294 / cc-302 read 8). ec_arm_source_fingerprint()
--   fingerprints this arm as count(*), max(updated_at) over FR contract +
--   grant rows, so 18 irs990 Schedule I grants on 2026-11-18 re-ran the whole
--   arm. The body (20260905000000_fix1136 §1, md5(prosrc)
--   88990e414b485a8ac1148d7f9b1a1444 on the clone) deletes every
--   financial_relationships contract_award edge and re-inserts the aggregate:
--   18 grants cost 219,185 rows and 419.0 s, and ec-vacuum-analyze armed on
--   its line. The fingerprint is not changed here; what one firing writes is.
--
-- THE MERGE (D3). The aggregate is built ONCE into a temp table — the
--   aggregation, the strength formula (/ 9.0) and the column list exactly as
--   the INSERT produced them — then, scoped as FIX-1136 scoped the arm
--   (connection_type = 'contract_award' AND evidence_source =
--   'financial_relationships'):
--     1. DELETEs the edges whose key is not in the set;
--     2. UPDATEs the rows whose key is in the set and whose strength,
--        amount_cents, occurred_at, ended_at, evidence_count or evidence_ids
--        IS DISTINCT FROM the set's, stamping derived_at on those rows only;
--     3. INSERTs the set rows with no edge of their key from this source (a
--        key held by another producer meets the unique key, as the
--        delete-all + insert did).
--   A key column is never UPDATEd; a row equal on every value is not written
--   and keeps its id, derived_at and ctid. evidence_source is in the scope, so
--   step 2 never needs to write it. The trailing ANALYZE stays.
--
-- THE ORDER (D5). evidence_ids takes fr.id as the tiebreak after
--   occurred_at DESC NULLS LAST. 19,801 of the clone's 188,234 contract
--   edges hold a tie in their first hundred (read 3): those are rewritten
--   once, on this body's first run.
--
-- THE COUNTS (D4, second branch). edges_upserted stays the size of the set,
--   what the delete-all + insert returned; the rows written are in a NOTICE:
--     [contracts] merge: deleted % / updated % / inserted % / untouched %
--   run_entity_connections_rebuild() passes edges_upserted to
--   ec_crawl_record_unit() as the throughput sensor's denominator (seconds *
--   1000 / rows against the ring's median for this arm; the clone's ring holds
--   a rated contracts sample at 188,234 rows). A written count would trip the
--   2 h backoff on any firing that writes 1,000 rows or more.
--
-- WHAT IS UNCHANGED. The signature, RETURNS TABLE(connection_type text,
--   edges_upserted bigint), LANGUAGE plpgsql, and no SET: the newest definer
--   (20260905000000) re-stated SET statement_timeout TO '30min', which FIX-1128
--   (20260913000000) RESET — the live proconfig is NULL and check:proconfig
--   holds it there. The returned row, the ANALYZE, the grants.
--
-- MEASURED on the clone, one rolled-back transaction each:
--                            old (delete-all + insert)    new (merge): first run · again
--     wall                   62.3 s                       118.9 s · 45.9 s
--     n_tup ins / upd / del  188,234 / 0 / 188,234        0 / 14,760 / 0 · 0 / 0 / 0
--     WAL                    658.2 MB                     1,251.7 MB · 0.1 MB
--   The first run's 14,760 updates are D5's one-time cost, scattered single-row
--   writes (~11 random pages each), so more WAL than the append-only rewrite,
--   once. 18 planted grants then write 18 rows (9 updated, 9 inserted).
--   The old body over the merge's result: key and scalars 0 / 0. evidence_ids as
--   a SET differs on 791 edges, every one over a hundred rows with a tie
--   straddling the hundredth and the same occurred_at multiset.
--
-- THE RULING (Craig, 2026-11-21, on cc-308's 791). A date tie at the [1:100]
--   cap may keep different ids: an edge is equal to the old body's when its key
--   and scalars are equal and its evidence_ids are equal as a set, or differ
--   only among ids that share the boundary occurred_at on an edge with more
--   than 100 rows. The old body's order within a tie was undefined, so neither
--   side's ids are the right ones; D5 makes the choice stable.
--
-- NOT ON PROD. cc-310 lands this file on main and does not push it; the next
--   class-P push applies it. The guard below refuses a live body that is
--   neither the one this replaces nor this file's.
--
-- ROLLBACK: scripts/fix1439-revert-ec-contracts-arm.sql — the old body
--   verbatim, without the inert SET. It drops nothing.

-- ── 1. Guard — the body this replaces, or this file's ─────────────────────────

DO $$
DECLARE
  v_d text;
BEGIN
  SELECT md5(prosrc) INTO v_d FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_contracts' AND pronamespace = 'public'::regnamespace;
  IF v_d IS DISTINCT FROM '88990e414b485a8ac1148d7f9b1a1444' AND v_d IS DISTINCT FROM 'cfbbd4d1b38be4529947a5646111d55a' THEN
    RAISE EXCEPTION '[fix1439] rebuild_entity_connections_contracts md5 % is neither FIX-1136''s 88990e414b485a8ac1148d7f9b1a1444 nor this file''s cfbbd4d1b38be4529947a5646111d55a — the body moved; rebuild this file on the live body',
      COALESCE(v_d, '(no function)');
  END IF;
  RAISE NOTICE '[fix1439] guard: rebuild_entity_connections_contracts %', v_d;
END $$;

-- ── 2. rebuild_entity_connections_contracts() — a merge ───────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_contracts()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE v_count BIGINT;
  v_deleted  BIGINT;   -- FIX-1439: the merge's counts
  v_updated  BIGINT;
  v_inserted BIGINT;
BEGIN
  -- FIX-1439 — the aggregate, built once. connection_type is an OUT column of
  -- this function, so the set carries none: every row is 'contract_award'.
  -- Dropped at the end, so a second call in one transaction can build it again.
  CREATE TEMP TABLE _ec_contracts_set (
    from_type       text,
    from_id         uuid,
    to_type         text,
    to_id           uuid,
    strength        numeric(4,3),
    amount_cents    bigint,
    occurred_at     date,
    ended_at        date,
    evidence_count  integer,
    evidence_ids    uuid[]
  ) ON COMMIT DROP;

  -- FIX-1439 (D5): fr.id breaks an occurred_at tie, so equal inputs give equal
  -- arrays and an unchanged edge is not rewritten.
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.occurred_at)               AS first_at,
      MAX(fr.occurred_at)               AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST, fr.id))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('contract', 'grant')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  )
  INSERT INTO _ec_contracts_set (
    from_type, from_id, to_type, to_id,
    strength, amount_cents, occurred_at, ended_at,
    evidence_count, evidence_ids
  )
  SELECT
    a.from_type, a.from_id, a.to_type, a.to_id,
    LEAST(0.999, GREATEST(0.001,
      LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 9.0
    ))::numeric(4,3),
    a.total_cents, a.first_at, a.last_at,
    a.evidence_count, a.evidence_ids
  FROM agg a;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  ANALYZE _ec_contracts_set;

  -- 1. An edge whose key left the aggregate goes. FIX-1136's scope.
  WITH gone AS (
    DELETE FROM public.entity_connections ec
     WHERE ec.connection_type = 'contract_award'
       AND ec.evidence_source = 'financial_relationships'
       AND NOT EXISTS (
         SELECT 1 FROM _ec_contracts_set s
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
           amount_cents   = s.amount_cents,
           occurred_at    = s.occurred_at,
           ended_at       = s.ended_at,
           evidence_count = s.evidence_count,
           evidence_ids   = s.evidence_ids,
           derived_at     = NOW()
      FROM _ec_contracts_set s
     WHERE ec.connection_type = 'contract_award'
       AND ec.evidence_source = 'financial_relationships'
       AND s.from_type = ec.from_type AND s.from_id = ec.from_id
       AND s.to_type = ec.to_type AND s.to_id = ec.to_id
       AND (ec.strength       IS DISTINCT FROM s.strength
         OR ec.amount_cents   IS DISTINCT FROM s.amount_cents
         OR ec.occurred_at    IS DISTINCT FROM s.occurred_at
         OR ec.ended_at       IS DISTINCT FROM s.ended_at
         OR ec.evidence_count IS DISTINCT FROM s.evidence_count
         OR ec.evidence_ids   IS DISTINCT FROM s.evidence_ids)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM changed;

  -- 3. The set rows with no edge of their key from this source.
  WITH added AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT s.from_type, s.from_id, s.to_type, s.to_id, 'contract_award'::public.connection_type,
           s.strength, s.amount_cents, s.occurred_at, s.ended_at,
           s.evidence_count, 'financial_relationships', s.evidence_ids
      FROM _ec_contracts_set s
     WHERE NOT EXISTS (
       SELECT 1 FROM public.entity_connections ec
        WHERE ec.from_type = s.from_type AND ec.from_id = s.from_id
          AND ec.to_type = s.to_type AND ec.to_id = s.to_id
          AND ec.connection_type = 'contract_award'
          AND ec.evidence_source = 'financial_relationships')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM added;

  RAISE NOTICE '[contracts] merge: deleted % / updated % / inserted % / untouched %',
    v_deleted, v_updated, v_inserted, v_count - v_updated - v_inserted;

  DROP TABLE _ec_contracts_set;

  -- FIX-1439 (D4): the set's size, as the delete-all + insert returned it — the
  -- crawl sensor's throughput denominator. The rows written are in the NOTICE.
  connection_type := 'contract_award'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_contracts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_contracts() TO service_role;

-- ── 3. Read-back ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_new CONSTANT text := 'cfbbd4d1b38be4529947a5646111d55a';
  c_old CONSTANT text := '88990e414b485a8ac1148d7f9b1a1444';
  v_md5 text;
  v_cfg text[];
BEGIN
  SELECT md5(prosrc), proconfig INTO v_md5, v_cfg FROM pg_proc
   WHERE proname = 'rebuild_entity_connections_contracts' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM c_new THEN
    RAISE EXCEPTION '[fix1439] read-back failed: rebuild_entity_connections_contracts md5 %, expected % (was %)', v_md5, c_new, c_old;
  END IF;
  IF v_cfg IS NOT NULL THEN
    RAISE EXCEPTION '[fix1439] read-back failed: rebuild_entity_connections_contracts carries a SET clause: %', v_cfg;
  END IF;
  RAISE NOTICE '[fix1439] read-back ok: rebuild_entity_connections_contracts % (was %)', v_md5, c_old;
END $$;
