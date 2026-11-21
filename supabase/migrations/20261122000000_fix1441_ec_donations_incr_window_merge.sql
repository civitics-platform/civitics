-- 20261122000000_fix1441_ec_donations_incr_window_merge.sql
-- FIX-1441 — rebuild_ec_donations_incr_window() merges a dirty donor's edges
-- instead of deleting every one of them and re-inserting the donor's full
-- history (cc-308).
--
-- Design of record: cc-308's prompt, D1–D9, on cc-302's reads 3 (c)/(d) and 8.
-- The shape is FIX-1409's rebuild_entity_connections_votes_full() merge
-- (20261117000000, cc-283 / cc-288).
--
-- THE FINDING. One moved financial_relationships row makes its donor dirty, and
--   the window (20260819030000_fix1069 §3, md5(prosrc)
--   2e70260b6f3cb1c0bfb913d4fce212a9 on the clone) deletes every donation and
--   opposition edge of every dirty donor in its range, then re-inserts each
--   donor's full history. A landing therefore rewrites every edge of every
--   donor it touched:
--     the clone's 08-20 landing   26,104 FR rows   26,103 pairs   191,272 edges   7.3x
--     prod 11-20 11:03Z (cc-302)  43,847 FR rows   39,137 pairs   692,600 edges  17.7x
--   Each rewritten edge is a heap delete, a heap insert and ten index inserts,
--   and it clears a visibility-map bit under the index-only scans of
--   rebuild_entity_connection_stats_window (cc-302: 11 stats windows at
--   1,135.6 s after that rewrite against 381.8–515.4 s for an ordinary sixteen).
--
-- THE MERGE (D2). The window builds its edge set ONCE into a temp table —
--   both classes ('donation' <- donation + ie_support, 'opposition' <-
--   ie_oppose), the aggregation, the strength formula and the column list
--   exactly as the two INSERTs produced them — then:
--     1. DELETEs the window's dirty donors' donation / opposition edges whose
--        key is not in the set. Scoped exactly as the old DELETE (dirty donor,
--        range, the two types; no evidence_source predicate: every such edge
--        on the clone is 'financial_relationships', read 2);
--     2. UPDATEs the rows whose key is in the set and whose strength,
--        amount_cents, occurred_at, ended_at, evidence_count, evidence_source
--        or evidence_ids IS DISTINCT FROM the set's, stamping derived_at on
--        those rows only (ec_arm_source_fingerprint() reads count(*) +
--        max(derived_at) for the stats arm; an insert moves it too, a delete
--        moves count);
--     3. INSERTs the set rows with no edge of their key.
--   A key column is never UPDATEd. The rows this can touch are exactly the
--   rows the old DELETE touched. A row equal on all seven is not written:
--   it keeps its id, its derived_at and its ctid. metadata is not reset (the
--   delete-all + insert wrote '{}'; no donation or opposition edge on the
--   clone carries any other value).
--
-- THE ORDER (D5). evidence_ids is (ARRAY_AGG(fr.id ORDER BY fr.occurred_at
--   DESC NULLS LAST, fr.id))[1:100]: occurred_at is a date, so equal values
--   left the array's order — and, past a hundred, its membership — to the
--   sort. A total order is what lets step 2 skip an unchanged row. The cost is
--   one rewrite of each tied edge the first time its donor is dirty (the 08-20
--   set: 19 of 191,323 edges, read 3).
--
-- THE COUNTS (D4, second branch). The window still RETURNS the size of its
--   set — v_count + v_opp, what the delete-all + insert returned — and the
--   rows it wrote live in the NOTICE only:
--     [donations/incr] window N/16 merge: deleted % / updated % / inserted % / untouched %
--   Because run_entity_connections_rebuild() hands the returned bigint to
--   ec_crawl_record_unit() -> crawl_record_unit(), whose backoff is a
--   THROUGHPUT test (seconds * 1000 / rows against the median of the ring's
--   donations_incr_window samples, backoff_multiple 2.0, backoff_min_rows
--   1000). Returning the rows written would divide a still-full-history read
--   by a 7–18x smaller count and trip the 2 h backoff on a healthy window.
--   The same value also feeds data_sync_log.rows_inserted, as before.
--
-- WHAT IS UNCHANGED. The signature, RETURNS bigint, LANGUAGE plpgsql, no SET
--   (the live proconfig is NULL), the already-at-target skip and the ratchet
--   (the window watermark and the MIN-across-windows last_indexed_at) byte
--   for byte. The temp table is ON COMMIT DROP and DROPped at the end, so a
--   second window in one transaction builds it again (D6); the orchestrator
--   COMMITs after every window.
--
-- MEASURED on the clone, the 08-20 set staged directly (25,681 donors,
--   191,272 edges), sixteen windows, one rolled-back transaction each:
--                            old (delete-all + insert)    new (merge)
--   as the clone stands — the landing already consumed; 51 keys new, 620 moved
--     wall                   120.7 s                      86.4 s   (again: 20.7 s)
--     n_tup ins / upd / del  191,323 / 0 / 191,272        51 / 620 / 0  (again: 0)
--     WAL                    1,348.6 MB                   11.3 MB  (again: 1.1 MB)
--   rewound to before the landing's 19,723 inserts — 19,461 keys new, 274 moved
--     wall                   86.1 s                       45.2 s   (again: 9.4 s)
--     n_tup ins / upd / del  191,323 / 0 / 171,862        19,461 / 274 / 0  (again: 0)
--     WAL                    1,939.5 MB                   353.7 MB (again: 1.2 MB)
--   The old body over the merge's result: symmetric difference 0 / 0, evidence_ids
--   as a set; 10 arrays differ in order only, each an edge with a tie in its first
--   hundred. Rows written equal the keys whose values moved, both scenarios.
--
-- NOT ON PROD. cc-308 lands this file on main and does not push it; the next
--   class-P push applies it. The guard below refuses a live body that is
--   neither the one this replaces nor this file's.
--
-- ROLLBACK: scripts/fix1441-revert-ec-donations-incr-window.sql — the old
--   body verbatim. It drops nothing.

-- ── 1. Guard — the body this replaces, or this file's ─────────────────────────

DO $$
DECLARE
  v_d text;
BEGIN
  SELECT md5(prosrc) INTO v_d FROM pg_proc
   WHERE proname = 'rebuild_ec_donations_incr_window' AND pronamespace = 'public'::regnamespace;
  IF v_d IS DISTINCT FROM '2e70260b6f3cb1c0bfb913d4fce212a9' AND v_d IS DISTINCT FROM '419d941075843c7e0b8f3eab72b95e49' THEN
    RAISE EXCEPTION '[fix1441] rebuild_ec_donations_incr_window md5 % is neither FIX-1069''s 2e70260b6f3cb1c0bfb913d4fce212a9 nor this file''s 419d941075843c7e0b8f3eab72b95e49 — the body moved; rebuild this file on the live body',
      COALESCE(v_d, '(no function)');
  END IF;
  RAISE NOTICE '[fix1441] guard: rebuild_ec_donations_incr_window %', v_d;
END $$;

-- ── 2. rebuild_ec_donations_incr_window() — a merge ───────────────────────────

CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_window(
  p_idx    int,
  p_lo     uuid,
  p_hi     uuid,
  p_target timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  c_key   CONSTANT text := 'entity_connections_donations';
  v_count bigint := 0;
  v_opp   bigint := 0;
  v_since timestamptz;
  v_wins  jsonb;
  v_min   timestamptz;
  v_deleted  bigint := 0;   -- FIX-1441: the merge's counts
  v_updated  bigint := 0;
  v_inserted bigint := 0;
BEGIN
  SELECT (value->'windows'->>p_idx::text)::timestamptz
    INTO v_since
    FROM public.pipeline_state
   WHERE key = c_key;

  -- Already level with this cycle's target => banked by an earlier firing.
  -- This is the intra-arm resume: re-entering the arm after a budget exit
  -- costs one cheap read per completed window, not a redo.
  IF v_since IS NOT NULL AND v_since >= p_target THEN
    RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', p_idx + 1;
    RETURN 0;
  END IF;

  -- ── FIX-1441 — the window's edge set, built once ───────────────────────────
  -- Both derived classes for this window's dirty donors, as the delete-all +
  -- insert derived them. Dropped at the end, so a second window in one
  -- transaction can build it again.
  CREATE TEMP TABLE _ec_donations_window_set (
    from_type       text,
    from_id         uuid,
    to_type         text,
    to_id           uuid,
    connection_type public.connection_type,
    strength        numeric(4,3),
    amount_cents    bigint,
    occurred_at     date,
    ended_at        date,
    evidence_count  integer,
    evidence_source text,
    evidence_ids    uuid[]
  ) ON COMMIT DROP;

  -- ── donation + ie_support -> 'donation' ────────────────────────────────────
  -- NOTE the aggregation is NOT filtered by updated_at: a dirty donor's edge is
  -- re-derived from their FULL history, which is what makes the window
  -- idempotent and the result identical to a single-pass run.
  -- FIX-1441 (D5): fr.id breaks an occurred_at tie, so equal inputs give equal
  -- arrays and an unchanged edge is not rewritten.
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST, fr.id))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN public.ec_donations_incr_dirty d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type IN ('donation', 'ie_support')
      AND d.from_id >= p_lo
      AND (p_hi IS NULL OR d.from_id < p_hi)
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  )
  INSERT INTO _ec_donations_window_set (
    from_type, from_id, to_type, to_id, connection_type,
    strength, amount_cents, occurred_at, ended_at,
    evidence_count, evidence_source, evidence_ids
  )
  SELECT
    a.from_type, a.from_id, a.to_type, a.to_id, 'donation'::public.connection_type,
    LEAST(0.999, GREATEST(0.001,
      LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
    ))::numeric(4,3),
    a.total_cents, a.first_at, a.last_at,
    a.evidence_count, 'financial_relationships', a.evidence_ids
  FROM agg a;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- ── ie_oppose -> 'opposition' (same dirty set, same window) ────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST, fr.id))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN public.ec_donations_incr_dirty d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type = 'ie_oppose'
      AND d.from_id >= p_lo
      AND (p_hi IS NULL OR d.from_id < p_hi)
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  )
  INSERT INTO _ec_donations_window_set (
    from_type, from_id, to_type, to_id, connection_type,
    strength, amount_cents, occurred_at, ended_at,
    evidence_count, evidence_source, evidence_ids
  )
  SELECT
    a.from_type, a.from_id, a.to_type, a.to_id, 'opposition'::public.connection_type,
    LEAST(0.999, GREATEST(0.001,
      LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
    ))::numeric(4,3),
    a.total_cents, a.first_at, a.last_at,
    a.evidence_count, 'financial_relationships', a.evidence_ids
  FROM agg a;

  GET DIAGNOSTICS v_opp = ROW_COUNT;

  ANALYZE _ec_donations_window_set;

  -- ── FIX-1441 — 1. a dirty donor's edge whose key left the set goes ─────────
  -- Scoped exactly as the delete-all was: the two derived classes of this
  -- window's dirty donors. The range predicate is redundant given the join but
  -- lets the planner use entity_connections_from_id_connection_type.
  WITH gone AS (
    DELETE FROM public.entity_connections ec
     USING public.ec_donations_incr_dirty d
     WHERE ec.connection_type IN ('donation', 'opposition')
       AND ec.from_type = d.from_type
       AND ec.from_id   = d.from_id
       AND d.from_id   >= p_lo
       AND (p_hi IS NULL OR d.from_id < p_hi)
       AND NOT EXISTS (
         SELECT 1 FROM _ec_donations_window_set s
          WHERE s.from_type = ec.from_type AND s.from_id = ec.from_id
            AND s.to_type = ec.to_type AND s.to_id = ec.to_id
            AND s.connection_type = ec.connection_type)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM gone;

  -- ── 2. same key, a value moved: written, derived_at stamped ────────────────
  -- A row equal on all seven is not written. No key column is in the SET list.
  WITH changed AS (
    UPDATE public.entity_connections ec
       SET strength        = s.strength,
           amount_cents    = s.amount_cents,
           occurred_at     = s.occurred_at,
           ended_at        = s.ended_at,
           evidence_count  = s.evidence_count,
           evidence_source = s.evidence_source,
           evidence_ids    = s.evidence_ids,
           derived_at      = now()
      FROM _ec_donations_window_set s
     WHERE ec.from_type = s.from_type AND ec.from_id = s.from_id
       AND ec.to_type = s.to_type AND ec.to_id = s.to_id
       AND ec.connection_type = s.connection_type
       AND (ec.strength        IS DISTINCT FROM s.strength
         OR ec.amount_cents    IS DISTINCT FROM s.amount_cents
         OR ec.occurred_at     IS DISTINCT FROM s.occurred_at
         OR ec.ended_at        IS DISTINCT FROM s.ended_at
         OR ec.evidence_count  IS DISTINCT FROM s.evidence_count
         OR ec.evidence_source IS DISTINCT FROM s.evidence_source
         OR ec.evidence_ids    IS DISTINCT FROM s.evidence_ids)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM changed;

  -- ── 3. the set rows with no edge of their key ──────────────────────────────
  WITH added AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT s.from_type, s.from_id, s.to_type, s.to_id, s.connection_type,
           s.strength, s.amount_cents, s.occurred_at, s.ended_at,
           s.evidence_count, s.evidence_source, s.evidence_ids
      FROM _ec_donations_window_set s
     WHERE NOT EXISTS (
       SELECT 1 FROM public.entity_connections ec
        WHERE ec.from_type = s.from_type AND ec.from_id = s.from_id
          AND ec.to_type = s.to_type AND ec.to_id = s.to_id
          AND ec.connection_type = s.connection_type)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM added;

  RAISE NOTICE '    [donations/incr] window %/16 merge: deleted % / updated % / inserted % / untouched %',
    p_idx + 1, v_deleted, v_updated, v_inserted, v_count + v_opp - v_updated - v_inserted;

  DROP TABLE _ec_donations_window_set;

  -- ── The ratchet: advance THIS window only, and recompute the scalar ────────
  -- `last_indexed_at` is kept as the MIN across the 16 windows so every existing
  -- reader keeps seeing a conservative, true "everything before this is fully
  -- indexed" — it does not move until the slowest window has caught up.
  UPDATE public.pipeline_state
     SET value = jsonb_set(value, ARRAY['windows', p_idx::text],
                           to_jsonb(p_target::text)),
         updated_at = now()
   WHERE key = c_key;

  SELECT min((e.value)::timestamptz) INTO v_min
    FROM public.pipeline_state ps,
         jsonb_each_text(ps.value->'windows') AS e(key, value)
   WHERE ps.key = c_key;

  UPDATE public.pipeline_state
     SET value = jsonb_set(value, ARRAY['last_indexed_at'], to_jsonb(v_min::text)),
         updated_at = now()
   WHERE key = c_key AND v_min IS NOT NULL;

  -- FIX-1441 (D4): the set's size, as the delete-all + insert returned it — the
  -- crawl sensor's throughput denominator. The rows written are in the NOTICE.
  RETURN v_count + v_opp;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz) IS
  'FIX-1069 — rebuild donation + opposition edges for the DIRTY donors in '
  '[p_lo, p_hi), then advance window p_idx''s watermark to p_target as the last '
  'act of the same transaction. Self-contained and idempotent so the caller can '
  'COMMIT after each window; a cancelled window rolls back its watermark with '
  'its edges and is simply redone. Skips instantly when already at target. '
  'FIX-1441 — a merge: deletes the keys that left the set, updates only the rows '
  'whose values moved, inserts the new keys; returns the set''s size (the crawl '
  'sensor''s denominator) and NOTICEs the rows written.';

-- ── 3. Read-back ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_new CONSTANT text := '419d941075843c7e0b8f3eab72b95e49';
  c_old CONSTANT text := '2e70260b6f3cb1c0bfb913d4fce212a9';
  v_md5 text;
  v_cfg text[];
BEGIN
  SELECT md5(prosrc), proconfig INTO v_md5, v_cfg FROM pg_proc
   WHERE proname = 'rebuild_ec_donations_incr_window' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM c_new THEN
    RAISE EXCEPTION '[fix1441] read-back failed: rebuild_ec_donations_incr_window md5 %, expected % (was %)', v_md5, c_new, c_old;
  END IF;
  IF v_cfg IS NOT NULL THEN
    RAISE EXCEPTION '[fix1441] read-back failed: rebuild_ec_donations_incr_window carries a SET clause: %', v_cfg;
  END IF;
  RAISE NOTICE '[fix1441] read-back ok: rebuild_ec_donations_incr_window % (was %)', v_md5, c_old;
END $$;
