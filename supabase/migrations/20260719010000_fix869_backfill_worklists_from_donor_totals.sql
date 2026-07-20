-- =============================================================================
-- FIX-869 — Source three focused-backfill work-lists from official_donor_totals
--           instead of a whole-financial_relationships-table array_agg(DISTINCT).
--
-- backfill_official_donor_brackets()      (20260718020000, FIX-868)
-- backfill_official_small_dollar_rollup() (20260715000000, FIX-776)
-- backfill_official_sector_affinity_rollup() (20260715010000, FIX-777)
--
-- each still build their per-official work-list with the non-chunked
--   SELECT array_agg(DISTINCT fr.to_id) FROM financial_relationships fr [JOIN fe] ...
-- that FIX-779b already removed from backfill_treemap_individuals_focused(). That
-- scan bitmap-scans millions of donation→official FR rows + sorts for the DISTINCT
-- before ANY chunk commits; under concurrent prod I/O (the 06:00 UTC
-- refresh-derived-mvs REFRESH) it stalled prod bootstraps ~19–24 min on
-- DataFileRead, committing nothing. Only the one-shot bootstraps are affected —
-- the incremental refreshes use the FIX-704 dirty set, not these lists.
--
-- ── New source: the tiny FIX-836 summary official_donor_totals (~4.2k rows) ────
-- The work-list each proc needs is exactly a projection of official_donor_totals:
--   • brackets      → officials with ≥1 POSITIVE individual donation
--                     = official_donor_totals WHERE individual_cents > 0
--                       (matches FIX-779b exactly; NOT `IS NOT NULL`, which pulls
--                        ~945 no-op officials with only pac/other donations)
--   • small-dollar  → all officials with ≥1 donation = every official_donor_totals row
--   • sector-affinity → same (all rows). The live sector-affinity work-list scan is
--                     ALREADY donation-only (relationship_type='donation') even though
--                     its per-chunk rebuild helper aggregates ie_support/ie_oppose, so
--                     all-rows preserves current behavior exactly. NOT widened to IE
--                     recipients here (that pre-existing IE-only gap is tracked
--                     separately — see below).
--
-- ── Set-equality gate (FIX-779b method): symmetric diff must be 0 on both envs ─
-- old whole-table scan set  vs  new official_donor_totals source set, EXCEPT both
-- directions. Measured 2026-07-19:
--   brackets            local 3904==3904 (0/0) | prod 3875==3875 (0/0)
--   small-dollar+sector local 4207==4207 (0/0) | prod 4336==4336 (0/0)
-- All three procs passed on both envs, so all three redefinitions ship here.
--
-- ── Pre-existing IE-only gap (decision-11, informational) ─────────────────────
-- Officials with ie_support/ie_oppose FR rows but ZERO donation rows are absent
-- from official_donor_totals AND from the OLD donation-only scan, so both the old
-- and new sector-affinity work-lists miss them identically — this migration does
-- NOT change that. Count: local 824, prod 385. Tracked as a follow-up FIX
-- (filed FIX-872); do not fix here. See [[FIX-779b]] [[FIX-836]] [[FIX-872]].
--
-- Every other line of each procedure body below is byte-identical to the live
-- definition (verified via pg_get_functiondef 2026-07-19); only the work-list
-- SELECT ... INTO v_officials block changes.
-- =============================================================================

-- ── 1. backfill_official_donor_brackets() ─────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.backfill_official_donor_brackets()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('official_donor_brackets_backfill')::bigint;
  c_chunk    int    := 300;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donor-brackets backfill] advisory lock held — skipping';
    RETURN;
  END IF;
  SET work_mem = '256MB';

  -- FIX-869: officials with ≥1 positive individual donation, from the tiny FIX-836
  -- summary (was a whole-FR-table array_agg(DISTINCT) scan). Set-equal to the old
  -- scan (gate: 3904==3904, 0 symmetric diff, local+prod).
  SELECT array_agg(official_id) INTO v_officials
  FROM public.official_donor_totals
  WHERE individual_cents > 0;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.treemap_individual_brackets_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('official_donor_brackets_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));
  RAISE NOTICE '[donor-brackets backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
REVOKE ALL ON PROCEDURE public.backfill_official_donor_brackets() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_official_donor_brackets() TO service_role;

-- ── 2. backfill_official_small_dollar_rollup() ────────────────────────────────
CREATE OR REPLACE PROCEDURE public.backfill_official_small_dollar_rollup()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('official_small_dollar_rollup_backfill')::bigint;
  c_chunk    int    := 500;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[small-dollar backfill] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  -- FIX-869: all officials with ≥1 donation, from the tiny FIX-836 summary (was a
  -- whole-FR-table array_agg(DISTINCT) scan). Set-equal to the old scan
  -- (gate: 4207==4207, 0 symmetric diff, local+prod).
  SELECT array_agg(official_id) INTO v_officials
  FROM public.official_donor_totals;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.small_dollar_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;  -- bounds txn size + advances xmin between chunks
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('small_dollar_rollup_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));

  RAISE NOTICE '[small-dollar backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
REVOKE ALL ON PROCEDURE public.backfill_official_small_dollar_rollup() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_official_small_dollar_rollup() TO service_role;

-- ── 3. backfill_official_sector_affinity_rollup() ─────────────────────────────
CREATE OR REPLACE PROCEDURE public.backfill_official_sector_affinity_rollup()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('official_sector_affinity_rollup_backfill')::bigint;
  c_chunk    int    := 500;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[sector-affinity backfill] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  -- FIX-869: all officials with ≥1 donation, from the tiny FIX-836 summary (was a
  -- whole-FR-table array_agg(DISTINCT) scan). Set-equal to the old scan
  -- (gate: 4207==4207, 0 symmetric diff, local+prod). The old scan was already
  -- donation-only; all-rows preserves it (IE-only recipients remain out of scope).
  SELECT array_agg(official_id) INTO v_officials
  FROM public.official_donor_totals;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.sector_affinity_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('sector_affinity_rollup_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));

  RAISE NOTICE '[sector-affinity backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
REVOKE ALL ON PROCEDURE public.backfill_official_sector_affinity_rollup() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_official_sector_affinity_rollup() TO service_role;

NOTIFY pgrst, 'reload schema';
