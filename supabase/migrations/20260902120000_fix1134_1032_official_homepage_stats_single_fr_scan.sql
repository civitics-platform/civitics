-- =============================================================================
-- FIX-1134 — official_homepage_stats_mv scans financial_relationships ONCE.
-- FIX-1032 — and it is redefined through the no-lock-window SWAP, whose recipe
--            this migration is the first instance of.
--
-- -- FIX-1134: the cost ------------------------------------------------------
-- The 20260510000001 definition had four CTEs, three of which (donor_counts,
-- fin_counts, donation_sums) each did their own `to_type = 'official' ... GROUP
-- BY to_id` pass over financial_relationships. On prod (2026-09-02) FR is
-- 631,265 pages / 4,932 MB heap / 14,541,168 rows against a 256 MB
-- shared_buffers, so the unit paid ~14.8 GB of reads per refresh for three
-- copies of the same scan.
--
-- Measured jobid 9 (`refresh-derived-mvs-daily`, 06:00 UTC) unit_seconds for
-- official_homepage_stats_mv:
--     2026-08-31 06:00   253.9 s
--     2026-08-31 23:36   252.8 s
--     2026-09-01 06:00   800.5 s   <- under contention; job total 1,394.4 s
--     2026-09-02 06:00   298.0 s   <- job total 561.4 s
-- It is the largest remaining unit in that job after FIX-1123 windowed
-- rebuild_entity_search_index.
--
-- This is NOT the FIX-884/943 visibility-map story: FR is 100% all-visible with
-- 0 dead tuples (last vacuum 2026-09-02 00:13) and the plan has no index-only
-- scan to degrade. The cost is scan COUNT. Three passes become one, using
-- FILTER aggregates.
--
-- Equivalence (why one grouped pass is the same answer):
--   * fin_counts' group set (to_type='official' GROUP BY to_id) is a superset of
--     donor_counts' and donation_sums', so the merged CTE emits a row wherever
--     any of the three did.
--   * Where donor_counts had no group, COUNT(*) FILTER (...) returns 0 -- the
--     same value the old LEFT JOIN + COALESCE produced from a NULL.
--   * Where donation_sums had no group, SUM(...) FILTER (...) over an empty set
--     is NULL -- again COALESCE'd to 0. (SUM already ignores NULL amount_cents;
--     the `amount_cents IS NOT NULL` conjunct is kept verbatim for parity.)
--   * officials.id is the PK, so the LEFT JOIN fan-out is unchanged.
-- Column names, order, types (bigint x4, timestamptz) and COALESCE-to-0
-- semantics are byte-identical to the outgoing definition.
--
-- -- FIX-1032: why a swap and not DROP + CREATE -------------------------------
-- official_homepage_stats_mv is unit 4 of the daily list in 20260813030000,
-- refreshed with REFRESH MATERIALIZED VIEW CONCURRENTLY. That leaves two bad
-- ways to redefine it and one good one:
--   NO   DROP + CREATE ... WITH DATA -- holds ACCESS EXCLUSIVE for the whole
--        populate. That is FIX-1032's incident: 442 s of request-path timeouts
--        on 2026-08-13.
--   NO   DROP + CREATE ... WITH NO DATA -- CONCURRENTLY refuses to refresh an
--        unpopulated MV, so the homepage reads empty until the next 06:00.
--   YES  Build a populated twin under a temporary name, then swap. The live MV
--        is never locked until the DROP, and the DROP + RENAME is a single
--        atomic statement measured in milliseconds.
--
-- THE SWAP RECIPE (five steps -- mirrored into packages/db/CLAUDE.md):
--   1. CREATE MATERIALIZED VIEW <name>_new AS <new query> WITH NO DATA;
--   2. CREATE UNIQUE INDEX <name>_new_pk ON <name>_new (<pk col>);
--   3. GRANT SELECT ON <name>_new TO anon, authenticated, service_role;
--   4. REFRESH MATERIALIZED VIEW <name>_new;   -- non-CONCURRENT; no lock on live
--   5. Atomically: DROP MATERIALIZED VIEW <name>;
--      ALTER MATERIALIZED VIEW <name>_new RENAME TO <name>;
--      ALTER INDEX <name>_new_pk RENAME TO <name>_pk;
--
-- Each step is wrapped in its own DO block here rather than an explicit
-- BEGIN/COMMIT pair. A DO block is ONE statement, so step 5 is atomic whether or
-- not the CLI wraps the file in an implicit transaction -- which an explicit
-- BEGIN/COMMIT inside an already-open implicit block would not guarantee.
--
-- Nothing else moves. refresh_official_homepage_stats_mv() and the jobid-9 unit
-- string both resolve the name at run time, so neither is touched. Phase 0 read
-- prod for things a RENAME does not carry: no COMMENT, no reloptions, and
-- pg_depend shows exactly one dependent -- the MV's own index -- so the DROP has
-- no VIEW or RULE blocking it. The MV's ACL (anon/authenticated/service_role)
-- comes from Supabase's schema-public default privileges and is re-established
-- on the new object at CREATE time; step 3 is belt-and-braces.
--
-- -- What this is measured to buy, and what it is not ------------------------
-- Clone (local prod clone, 10.4M FR rows, max_parallel_workers_per_gather=0),
-- EXPLAIN (ANALYZE, BUFFERS) of the two defining queries:
--     old   shared hit=3,872,988 read=442,151  = 4,315,139 blocks   4,749 ms
--     new   shared hit=8,167     read=312,557  =   320,724 blocks   2,408 ms
--     ratio 7.4% of the blocks (13.5x), 51% of the wall time
-- Equivalence on that same clone, both queries in ONE snapshot: 37,175 = 37,175
-- rows, symmetric difference 0.
--
-- DO NOT carry the 13.5x to prod. The clone's old plan is dominated by an
-- index-only scan of financial_relationships_derivation that prod does not pay
-- the same way. Prod's plans (EXPLAIN, no ANALYZE, 2026-09-02):
--     old  Parallel Index Only Scan financial_relationships_derivation (1,157 MB idx)
--        + Parallel Index Only Scan financial_relationships_to           (207 MB idx)
--        + Parallel Bitmap Heap Scan on the 4,932 MB heap        total cost 1,185,661
--     new  Parallel Seq Scan on financial_relationships           total cost   822,024
-- In blocks that is roughly ~780k -> 631k, so expect a MODEST prod win on I/O
-- (~20%) plus a real CPU win (one aggregation pass over 6.6M rows instead of
-- three over ~12.6M, and two fewer sort/merge legs). The honest prediction for
-- the 06:00 unit is therefore "meaningfully under 253-298 s", not "one third of
-- it" -- the durable number is the next firing's
-- metadata.unit_seconds.official_homepage_stats_mv.
--
-- The remaining 631k blocks are the floor for this definition: every row it
-- needs carries relationship_type and amount_cents, which no existing index
-- covers, so the heap must be read. A covering partial index on
-- (to_type, to_id) INCLUDE (relationship_type, amount_cents) WHERE
-- to_type = 'official' would be ~200 MB and take the scan to ~25k blocks. That
-- is a separate change with its own write-amplification cost -- deliberately
-- NOT bundled here.
--
-- This migration's own populate is one FR scan AND non-CONCURRENT (cheaper than
-- the nightly unit, which diffs into the existing heap). Precedent that a long
-- statement completes through `pnpm db:push:prod`: FIX-1030's populate ran 442 s.
-- =============================================================================

SET statement_timeout = '30min';


-- -- Steps 1-3: build the twin, unpopulated ------------------------------------
DO $swap_build$
BEGIN
  IF to_regclass('public.official_homepage_stats_mv') IS NULL THEN
    RAISE NOTICE 'FIX-1134: official_homepage_stats_mv absent - nothing to swap.';
    RETURN;
  END IF;

  -- Already carrying the new definition (the old one is the only one with a
  -- donor_counts CTE) -> this migration has run. No-op.
  IF pg_get_viewdef('public.official_homepage_stats_mv'::regclass) NOT LIKE '%donor_counts%' THEN
    RAISE NOTICE 'FIX-1134: official_homepage_stats_mv already single-scan - skipping.';
    RETURN;
  END IF;

  IF to_regclass('public.official_homepage_stats_mv_new') IS NOT NULL THEN
    RAISE NOTICE 'FIX-1134: _new already exists (resumed run) - reusing it.';
    RETURN;
  END IF;

  CREATE MATERIALIZED VIEW public.official_homepage_stats_mv_new AS
  WITH
    vote_counts AS (
      SELECT official_id, COUNT(*)::BIGINT AS vote_count
      FROM public.votes
      GROUP BY official_id
    ),
    -- FIX-1134: the three former FR CTEs, collapsed into one grouped pass.
    fr AS (
      SELECT
        to_id AS official_id,
        (COUNT(*) FILTER (WHERE relationship_type = 'donation'))::BIGINT
          AS donor_count,
        COUNT(*)::BIGINT
          AS financial_relationship_count,
        (SUM(amount_cents) FILTER (
           WHERE relationship_type = 'donation' AND amount_cents IS NOT NULL))::BIGINT
          AS total_donations_cents
      FROM public.financial_relationships
      WHERE to_type = 'official'
      GROUP BY to_id
    )
  SELECT
    o.id                                                 AS official_id,
    COALESCE(vc.vote_count,                   0)::BIGINT AS vote_count,
    COALESCE(fr.donor_count,                  0)::BIGINT AS donor_count,
    COALESCE(fr.financial_relationship_count, 0)::BIGINT AS financial_relationship_count,
    COALESCE(fr.total_donations_cents,        0)::BIGINT AS total_donations_cents,
    NOW()                                                AS refreshed_at
  FROM public.officials o
  LEFT JOIN vote_counts vc ON vc.official_id = o.id
  LEFT JOIN fr             ON fr.official_id = o.id
  WITH NO DATA;

  CREATE UNIQUE INDEX official_homepage_stats_mv_new_pk
    ON public.official_homepage_stats_mv_new (official_id);

  GRANT SELECT ON public.official_homepage_stats_mv_new
    TO anon, authenticated, service_role;

  RAISE NOTICE 'FIX-1134: _new created (unpopulated).';
END
$swap_build$;


-- -- Step 4: populate the twin. Long, and holds no lock on the live MV. --------
DO $swap_populate$
BEGIN
  IF to_regclass('public.official_homepage_stats_mv_new') IS NULL THEN
    RETURN;
  END IF;
  RAISE NOTICE 'FIX-1134: populating _new (one FR scan) ...';
  REFRESH MATERIALIZED VIEW public.official_homepage_stats_mv_new;
END
$swap_populate$;


-- -- Step 5: the swap. One statement; ACCESS EXCLUSIVE for milliseconds. -------
DO $swap_cutover$
DECLARE
  v_old_rows  BIGINT;
  v_new_rows  BIGINT;
  v_differing BIGINT;
  v_bound     BIGINT;
BEGIN
  IF to_regclass('public.official_homepage_stats_mv_new') IS NULL
     OR to_regclass('public.official_homepage_stats_mv') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_old_rows FROM public.official_homepage_stats_mv;
  SELECT count(*) INTO v_new_rows FROM public.official_homepage_stats_mv_new;

  -- Both MVs are populated right now, so this is comparable. Any delta is
  -- STALENESS, not disagreement: the old side was last refreshed at the 06:00
  -- firing, the new side moments ago, and FR is written by the nightly
  -- pipelines in between. The exactness proof for the rewrite itself is the
  -- clone check, where both sides see one snapshot. Here we only need to catch
  -- a structural break, so the bound is generous.
  SELECT count(*) INTO v_differing
  FROM public.official_homepage_stats_mv o
  FULL JOIN public.official_homepage_stats_mv_new n USING (official_id)
  WHERE o.official_id IS NULL
     OR n.official_id IS NULL
     OR (o.vote_count, o.donor_count, o.financial_relationship_count, o.total_donations_cents)
        IS DISTINCT FROM
        (n.vote_count, n.donor_count, n.financial_relationship_count, n.total_donations_cents);

  v_bound := GREATEST(100, (v_old_rows * 5) / 100);

  RAISE NOTICE 'FIX-1134 pre-swap equivalence: old=% rows, new=% rows, differing=% (bound %)',
    v_old_rows, v_new_rows, v_differing, v_bound;

  IF v_differing > v_bound THEN
    RAISE EXCEPTION
      'FIX-1134: % of % officials differ between the old MV and the single-scan twin - '
      'past the %-row staleness bound. Refusing the swap; _new is left in place for '
      'inspection (DROP MATERIALIZED VIEW public.official_homepage_stats_mv_new to retry).',
      v_differing, v_old_rows, v_bound;
  END IF;

  DROP MATERIALIZED VIEW public.official_homepage_stats_mv;

  ALTER MATERIALIZED VIEW public.official_homepage_stats_mv_new
    RENAME TO official_homepage_stats_mv;

  ALTER INDEX public.official_homepage_stats_mv_new_pk
    RENAME TO official_homepage_stats_mv_pk;

  RAISE NOTICE 'FIX-1134/FIX-1032: swap complete.';
END
$swap_cutover$;


RESET statement_timeout;

-- DOWN (not expected -- the old definition is strictly more expensive):
--   Re-run 20260510000001's CREATE MATERIALIZED VIEW body through the same
--   five-step swap, with the guard's LIKE test inverted.
