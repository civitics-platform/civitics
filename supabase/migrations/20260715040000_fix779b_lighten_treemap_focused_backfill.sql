-- =============================================================================
-- FIX-779b — Lighten backfill_treemap_individuals_focused()'s officials list.
--
-- The FIX-779 backfill built its per-official work list with a non-chunked
--   SELECT array_agg(DISTINCT fr.to_id) FROM financial_relationships fr
--     JOIN financial_entities fe (entity_type='individual') WHERE donation...
-- which bitmap-scans ~2.8M donation->official rows + sorts ~1M for the DISTINCT
-- before ANY chunk commits. Under concurrent prod I/O (a 06:00 UTC
-- refresh-derived-mvs REFRESH MATERIALIZED VIEW CONCURRENTLY) that single
-- statement stalled ~24min on DataFileRead, committing nothing.
--
-- The set "officials with >=1 positive individual donation" is exactly
-- official_donor_totals WHERE individual_cents > 0 (FIX-836 summary, ~4.2k rows,
-- individual_cents = SUM(amount) FILTER entity_type='individual'). Verified equal
-- to the scan set (3,904 == 3,904, 0 symmetric diff, local). Sourcing the list
-- from that tiny table makes the backfill's heavy footprint just the per-chunk
-- rebuilds (index-scoped) + the unavoidable global full-scan pass. Only the
-- one-shot backfill is affected — the incremental refresh
-- (donor_rollup_rebuild_recipients 5th block) uses the dirty set, not this list.
-- =============================================================================

CREATE OR REPLACE PROCEDURE public.backfill_treemap_individuals_focused()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('treemap_individuals_focused_backfill')::bigint;
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
    RAISE NOTICE '[treemap-focused backfill] advisory lock held — skipping';
    RETURN;
  END IF;
  SET work_mem = '256MB';

  -- FIX-779b: officials with >=1 positive individual donation, from the tiny
  -- FIX-836 summary (was a ~2.8M-row scan + 1M-row DISTINCT sort).
  SELECT array_agg(official_id) INTO v_officials
  FROM public.official_donor_totals
  WHERE individual_cents > 0;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.treemap_individuals_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('treemap_individuals_focused_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));
  RAISE NOTICE '[treemap-focused backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.backfill_treemap_individuals_focused() TO service_role;
REVOKE ALL ON PROCEDURE public.backfill_treemap_individuals_focused() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_treemap_individuals_focused() TO service_role;
