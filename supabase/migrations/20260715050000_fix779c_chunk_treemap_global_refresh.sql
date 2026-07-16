-- =============================================================================
-- FIX-779c — Make refresh_treemap_individuals_global() I/O-bounded (was
-- memory-bounded but I/O-UNBOUNDED).
--
-- The FIX-779 global refresh built the (state, donor_name) aggregate in ONE
-- statement: a bitmap heap scan of ~2.8M donation->official rows + a Nested-Loop
-- Memoize'd financial_entities fetch (width 181 ≈ 206MB of jsonb+name) —
-- HashAggregate to ~1.1M groups. Memory fit (~90MB), but on cache-starved Pro
-- Small (256MB shared_buffers) the 2.8M FR heap fetches + ~1.1M FE fetches thrash
-- the cache for the WHOLE statement: it ran 40+min of continuous DataFileRead in
-- one blocking transaction (would collide with the 08:00 EC rebuild; and the
-- weekly cron would saturate prod every Tuesday). Terminated mid-run.
--
-- ── Two-phase, I/O-bounded ───────────────────────────────────────────────────
-- Phase A — per-donor aggregate (from_id -> total_cents, count) in 16 from_id
--   RANGE chunks, COMMIT each. Rides financial_relationships_donation_size_rollup
--   (from_id) INCLUDE (amount_cents) WHERE from_type='financial_entity' AND
--   relationship_type='donation'; heap only for the to_type='official' recheck.
--   NO financial_entities join here. from_id ranges partition donors, so each
--   donor lands in exactly one chunk → plain INSERT (no cross-chunk merge). Bounds
--   the FR I/O per committed step; the site interleaves between chunks.
-- Phase B — join the per-donor aggregate (~1.1M rows) to financial_entities ONCE
--   (individual, state, name), aggregate by (state, donor_name), top-50/state into
--   the GLOBAL scope. ~1.1M FE fetches, not the naive ~2.8M memoized.
--
-- Result identical to FIX-779's global (top-50 individual donors/state, uncapped);
-- only the execution shape changes. Staging is an UNLOGGED table (survives the
-- per-chunk COMMITs; dropped at the end).
-- =============================================================================

CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('treemap_individuals_global_refresh')::bigint;
  c_global   uuid   := '00000000-0000-0000-0000-000000000000';
  c_bounds   uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo   uuid;
  v_hi   uuid;
  v_rows bigint;
  i      int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[treemap-global refresh] advisory lock held — skipping';
    RETURN;
  END IF;
  SET work_mem = '256MB';

  DROP TABLE IF EXISTS public._tin_donor_agg;
  CREATE UNLOGGED TABLE public._tin_donor_agg (
    donor_id       uuid   NOT NULL,
    total_cents    bigint NOT NULL,
    donation_count bigint NOT NULL
  );
  COMMIT;  -- publish the staging table; keep each chunk txn short

  -- Phase A: per-donor aggregate in 16 from_id-range chunks (plain INSERT — ranges
  -- partition donors), COMMIT each.
  FOR i IN 1..16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    INSERT INTO public._tin_donor_agg (donor_id, total_cents, donation_count)
    SELECT fr.from_id, SUM(fr.amount_cents)::bigint, COUNT(*)::bigint
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'
      AND fr.to_type           = 'official'
      AND fr.amount_cents > 0
      AND fr.from_id >= v_lo
      AND (v_hi IS NULL OR fr.from_id < v_hi)
    GROUP BY fr.from_id;
    COMMIT;
  END LOOP;

  -- Phase B: join the per-donor aggregate to financial_entities ONCE, aggregate by
  -- (state, donor_name), top-50/state into the GLOBAL scope.
  DELETE FROM public.treemap_individuals_rollup WHERE scope_id = c_global;

  WITH by_state_name AS (
    SELECT
      COALESCE(fe.metadata->>'state', '??') AS state,
      fe.display_name                       AS donor_name,
      SUM(da.total_cents)::bigint           AS total_cents,
      SUM(da.donation_count)::bigint        AS donation_count
    FROM public._tin_donor_agg da
    JOIN public.financial_entities fe ON fe.id = da.donor_id AND fe.entity_type = 'individual'
    GROUP BY 1, 2
  ),
  ranked AS (
    SELECT state, donor_name, total_cents, donation_count,
      ROW_NUMBER() OVER (PARTITION BY state ORDER BY total_cents DESC, donor_name) AS rank
    FROM by_state_name
  ),
  ins AS (
    INSERT INTO public.treemap_individuals_rollup
      (scope_id, state, rank, donor_name, total_cents, donation_count)
    SELECT c_global, state, rank::int, donor_name, total_cents, donation_count
    FROM ranked WHERE rank <= 50
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_rows FROM ins;

  DROP TABLE IF EXISTS public._tin_donor_agg;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('treemap_individuals_global_refresh', 'complete', now(), now(), v_rows,
          jsonb_build_object('scope', 'global', 'shape', 'two-phase chunked'));
  RAISE NOTICE '[treemap-global refresh] complete — % rows', v_rows;

  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_treemap_individuals_global() TO service_role;
REVOKE ALL ON PROCEDURE public.refresh_treemap_individuals_global() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.refresh_treemap_individuals_global() TO service_role;
