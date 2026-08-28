-- =============================================================================
-- FIX-1115 — entity_connection_stats becomes a BOUNDED, GATED crawl arm.
-- FIX-1117 — the ten unconditional non-donations arms get a source-change gate.
--
-- Both land in one migration because both edit the same procedure body, and
-- writing run_entity_connections_rebuild() out twice in two files is how a
-- 41 kB body acquires a divergence.
--
-- ═══ FIX-1115: WHAT KILLED THE BOX, MEASURED ═══════════════════════════════
-- rebuild_entity_connection_stats() did `SET work_mem = '256MB'` and then built
-- the WHOLE stage table in one statement: a HashAggregate over a UNION ALL of
-- from_id and to_id across all of entity_connections. Prod died at 21,610 s on
-- 2026-08-10 inside that CREATE TEMP TABLE, and the two firings after it both
-- ended in a postmaster restart. jobid 16 has been paused since 2026-08-28.
--
-- The peak-memory reading, taken on the local prod clone (6,985,892 EC rows,
-- 3,225,903 distinct ids) at the shipped work_mem = 256MB:
--
--     HashAggregate (actual rows=3225903)
--       Batches: 5  Memory Usage: 540737kB  Disk Usage: 11648kB
--       Buffers: shared hit=1049 read=656967
--       ->  Seq Scan on entity_connections (rows=6985892)
--       ->  Seq Scan on entity_connections (rows=6985892)
--       Execution Time: 30334.852 ms
--
-- **540,737 kB of peak backend memory** — on a box with 2 GB of RAM and 256 MB
-- of shared_buffers — and it still spilled to 5 batches. Prod carries 10,505,216
-- EC rows, 1.50x local, so prod's peak is larger again. That is the OOM, in one
-- line, and no amount of chunking the APPLY half (which FIX-703 already did,
-- 16 committed uuid windows) touches it, because the stage build is one
-- statement.
--
-- ═══ THE REPLACEMENT, AND WHY IT IS CHEAPER AND NOT MERELY SAFER ═══════════
-- The FIX-1115 bullet offered (a) window the stage build, "trading FIX-734's
-- single-scan property for survivability", or (b) drive it from a watermark.
-- This ships BOTH, and the trade turns out not to be a trade at all.
--
-- Aggregating one uuid window at a time lets the planner use
-- entity_connections_from_id_connection_type and
-- entity_connections_to_id_connection_type, both of which COVER exactly the two
-- columns the aggregate needs. Same clone, same query, window 1/16, at
-- work_mem = 64MB:
--
--     HashAggregate (actual rows=203124)
--       Batches: 1  Memory Usage: 36897kB          <- no spill
--       ->  Index Only Scan ..._from_id_connection_type  (rows=425234)
--       ->  Index Only Scan ..._to_id_connection_type    (rows=437483)
--       Buffers: shared hit=152323 read=6351
--       Execution Time: 938.382 ms
--
--   peak memory   540,737 kB  ->  36,897 kB     (14.7x smaller, and BOUNDED)
--   physical reads   656,967  ->   6,351/window (~101,600 for all 16: 6.5x less)
--   spill              5 batches -> none
--
-- So the "single scan" FIX-734 was protecting was a scan of the 7,467 MB HEAP,
-- twice. Sixteen index-only windows read less, not more. The keyspace is uuid
-- v4 so the windows are near-perfectly even — measured groups per window on the
-- clone: 196,351 to 203,124, a 3.4% spread across all sixteen.
--
-- ═══ AND THE APPLY HALF STOPS REWRITING ROWS THAT DID NOT CHANGE ═══════════
-- The old apply was DELETE-the-window then INSERT-the-window: 2.4M rows
-- rewritten every single run, whatever changed. The window function below fuses
-- aggregate + apply into ONE statement with an upsert whose DO UPDATE carries an
-- IS DISTINCT FROM guard, so only genuinely-changed rows are written. Measured
-- on the clone against three-weeks-stale state — i.e. the WORST case this will
-- ever see:
--
--     Tuples Inserted: 50779   Conflicting Tuples: 152345
--     Rows Removed by Conflict Filter: 130331      <- unchanged, not written
--     => 72,793 rows written out of 203,124 (64% of the write avoided)
--
-- In steady state, where a cycle moves a few thousand edges, that ratio goes the
-- rest of the way. This is the difference between "the stats arm costs a full
-- 2.4M-row rewrite per cycle" and "the stats arm costs what actually changed",
-- which is what makes it affordable to run inside the crawl at all.
--
-- ⚠ ONE STATEMENT, TWO DATA-MODIFYING CTEs. `ups` and `del` are disjoint by
-- construction and by primary key: `ups` writes exactly the entity_ids present
-- in `agg`, `del` removes exactly the in-window entity_ids NOT present in `agg`.
-- PostgreSQL leaves the outcome undefined when two modifying CTEs touch the SAME
-- row; these provably cannot. `agg` is MATERIALIZED so the aggregation runs once
-- and both CTEs see the identical set.
--
-- ═══ FIX-1117: THE SOURCE-CHANGE GATE ══════════════════════════════════════
-- The ring is the receipt, and it is exact rather than approximate:
--
--     rebuild_entity_connections_external   n=2  median 899.1 s  rows 1,148,418
--                                                                = 2 x 574,209
--     rebuild_entity_connections_contracts  n=3  median 344.6 s  rows   569,847
--                                                                = 3 x 189,949
--
-- Byte-identical row counts on consecutive cycles: ~1,244 s of writer per cycle
-- recomputing edges that did not change, against a whole-cycle cost around
-- 1,830 s. On a box whose scarce resource is the daily disk burst budget
-- (FIX-1107) that is the largest remaining pure waste in the crawl.
--
-- The gate is a per-arm fingerprint over that arm's OWN source scope. Scope
-- matters: four arms read financial_relationships, and an unscoped FR
-- fingerprint would fire all four on every donation write, which is every day.
-- The predicates below were read out of the shipped arm bodies, not guessed —
-- `relationship_type IN ('contract','grant')` for _contracts (NOT 'contract'
-- alone), IN ('gift','honorarium') for _gifts, IN ('owns_stock','owns_bond',
-- 'property') for _holds, = 'lobbying_spend' for _lobbying — and every label was
-- checked against pg_enum. That is the FIX-073 'not_voting' rule: the schema is
-- ground truth, not a prior pipeline's normaliser.
--
-- ⚠ THE GATE FAILS OPEN, EVERYWHERE. A probe that errors returns NULL, and NULL
-- means RUN THE ARM. A gate that silently freezes an arm is the FIX-885
-- stranded-flag class and would be strictly worse than the waste it replaces:
-- waste costs I/O, a frozen arm costs correctness and is invisible.
--
-- ⚠ THE STORED FINGERPRINT IS THE PRE-RUN ONE. Recording a fingerprint taken
-- AFTER the arm finished would mark any source write that landed DURING the run
-- as already consumed. Storing the value the build actually consumed means such
-- a write is seen next cycle and the arm re-runs. Conservative in the only
-- direction that is safe.
--
-- Measured probe costs on the clone: agencies 7 ms, evidence_cards 4 ms,
-- external_relationships 586 ms, FR scoped to 'contract' 15,975 ms — the last
-- against an arm that costs 344.6 s, i.e. 4.6%.
--
-- ═══ WHAT THIS DOES NOT DO ═════════════════════════════════════════════════
-- Nothing here enables anything on a schedule, and nothing here unpauses
-- anything. jobid 16 stays retired. The stats arm and the gate both become live
-- the moment this lands because they run INSIDE the already-live ec-crawl —
-- which is the point, and is safe in both directions: the gate can only SKIP
-- work, and the stats arm is bounded per unit by the same cap, budget, sensor
-- and blackout as every other unit.
--
-- Cross-ref FIX-1111 (the crawl and its pattern), FIX-1111b (the throughput
-- sensor), FIX-1107 (the I/O budget fact), FIX-1103 (the correlation that
-- paused jobid 16), FIX-734/FIX-703/FIX-717 (the shape being replaced),
-- FIX-969 (the regime), FIX-885 (fail-open), FIX-1028 (query_canceled by name),
-- FIX-073 (enum labels are the schema's, not the prose's).
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The bounded stats window — aggregate + apply, one uuid range, one statement.
--
--    `SET work_mem` is a FUNCTION-level proconfig, applied on entry and restored
--    on exit, so the driver's session-wide 256MB (which FIX-588 needs for the
--    donations HashAggregate) is untouched everywhere else. FIX-1069 measured
--    that a function's proconfig DOES change the GUC inside the body — it is only
--    the statement_timeout TIMER that cannot be re-armed — so this is a real
--    bound, not a decorative one.
--
--    64MB against a measured 36,897 kB peak: enough headroom for prod's 1.50x
--    cardinality to stay at Batches: 1, and 4x below the 256MB that killed the
--    box. If a future cardinality does spill, it spills ONE window's worth.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_entity_connection_stats_window(
  p_lo uuid,
  p_hi uuid          -- NULL = open-ended (the last window)
)
RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_catalog
SET work_mem = '64MB'
AS $$
  WITH agg AS MATERIALIZED (
    SELECT sub.id                                          AS entity_id,
           COUNT(*)::bigint                                AS connection_count,
           COUNT(*) FILTER (
             WHERE sub.connection_type IN (
               'vote_yes', 'vote_no', 'vote_abstain',
               'nomination_vote_yes', 'nomination_vote_no')
           )::bigint                                       AS vote_count,
           bool_or(sub.connection_type = 'donation')       AS has_donation,
           bool_or(sub.connection_type IN (
             'vote_yes', 'vote_no', 'vote_abstain',
             'nomination_vote_yes', 'nomination_vote_no')) AS has_vote
      FROM (
        -- Both branches are covered by (from_id, connection_type) and
        -- (to_id, connection_type) respectively, so both are Index Only Scans.
        SELECT from_id AS id, connection_type
          FROM public.entity_connections
         WHERE from_id >= p_lo AND (p_hi IS NULL OR from_id < p_hi)
        UNION ALL
        SELECT to_id   AS id, connection_type
          FROM public.entity_connections
         WHERE to_id   >= p_lo AND (p_hi IS NULL OR to_id   < p_hi)
      ) sub
     GROUP BY sub.id
  ),
  ups AS (
    INSERT INTO public.entity_connection_stats_mv AS t
          (entity_id, connection_count, vote_count, has_donation, has_vote)
    SELECT entity_id, connection_count, vote_count, has_donation, has_vote
      FROM agg
    ON CONFLICT (entity_id) DO UPDATE
       SET connection_count = EXCLUDED.connection_count,
           vote_count       = EXCLUDED.vote_count,
           has_donation     = EXCLUDED.has_donation,
           has_vote         = EXCLUDED.has_vote
     -- Do not write a row whose four values are already right. This is the
     -- 64%-of-writes-avoided measurement in the header.
     WHERE t.connection_count IS DISTINCT FROM EXCLUDED.connection_count
        OR t.vote_count       IS DISTINCT FROM EXCLUDED.vote_count
        OR t.has_donation     IS DISTINCT FROM EXCLUDED.has_donation
        OR t.has_vote         IS DISTINCT FROM EXCLUDED.has_vote
    RETURNING 1
  ),
  del AS (
    -- Orphans: an entity that lost its last edge. Disjoint from `ups` by PK.
    DELETE FROM public.entity_connection_stats_mv d
     WHERE d.entity_id >= p_lo AND (p_hi IS NULL OR d.entity_id < p_hi)
       AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.entity_id = d.entity_id)
    RETURNING 1
  )
  SELECT jsonb_build_object(
           'upserted', (SELECT count(*) FROM ups),
           'deleted',  (SELECT count(*) FROM del),
           'groups',   (SELECT count(*) FROM agg));
$$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connection_stats_window(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.rebuild_entity_connection_stats_window(uuid, uuid) IS
  'FIX-1115 — rebuilds entity_connection_stats_mv for ONE uuid window in one '
  'memory-bounded statement. Replaces the whole-table HashAggregate that peaked '
  'at 540,737 kB (5 batches, spilled) on a 2 GB box and took the postmaster with '
  'it twice. Windowing lets both scan branches use the covering indexes '
  '(from_id, connection_type) and (to_id, connection_type), so each window is '
  'two Index Only Scans and a Batches:1 HashAggregate measured at 36,897 kB peak '
  'under a function-scoped work_mem of 64MB. The upsert carries an IS DISTINCT '
  'FROM guard so unchanged rows are not rewritten (measured: 64% of writes '
  'avoided against three-week-stale state). The two data-modifying CTEs are '
  'disjoint by primary key — ups writes ids present in agg, del removes in-window '
  'ids absent from it — so the undefined-behaviour case for same-row modification '
  'cannot arise. Returns {upserted, deleted, groups}.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The old procedure becomes a bounded loop over those windows.
--
--    It is NOT deleted and NOT left as it was. jobid 16 is retired, but a job row
--    that still exists is a job row somebody can re-enable, and the FIX-717
--    comment advertises this procedure as the escape hatch. Making the escape
--    hatch itself bounded means a re-enable is survivable rather than a second
--    postmaster restart. One implementation, two callers.
--
--    Gone with the old body: the 256MB session work_mem, the ecs_stage temp
--    table, and the unbounded double HashAggregate.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.rebuild_entity_connection_stats()
LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('entity_connection_stats_rebuild')::bigint;
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
  v_log_id   uuid;
  v_lo       uuid;
  v_hi       uuid;
  v_res      jsonb;
  v_ups      bigint := 0;
  v_del      bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text   := NULL;
  i          int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connection_stats_rebuild', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent stats rebuild',
                               'source', 'manual'));
    RAISE NOTICE '[ec-stats] advisory lock held — skipping';
    RETURN;
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('entity_connection_stats_rebuild', 'running', now(),
          jsonb_build_object('mode', 'bounded-windows', 'source', 'manual'))
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR i IN 1..16 LOOP
    EXIT WHEN v_canceled IS NOT NULL;
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    BEGIN
      v_res := public.rebuild_entity_connection_stats_window(v_lo, v_hi);
      v_ups := v_ups + (v_res->>'upserted')::bigint;
      v_del := v_del + (v_res->>'deleted')::bigint;
      RAISE NOTICE '  [ec-stats] window %/16 — % upserted, % deleted, % groups',
        i, v_res->>'upserted', v_res->>'deleted', v_res->>'groups';
    EXCEPTION
    -- FIX-1028 — by name and FIRST; OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [ec-stats] window %/16 CANCELED: %', i, SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [ec-stats] window %/16 FAILED: %', i, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  END LOOP;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN v_canceled IS NOT NULL           THEN 'partial'
                           WHEN array_length(v_failures, 1) > 0  THEN 'failed'
                           ELSE 'complete' END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_ups + v_del,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN v_canceled IS NOT NULL THEN left('canceled — ' || v_canceled, 1000)
                           WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000) END,
      metadata      = metadata || jsonb_build_object(
                        'stats_upserted', v_ups,
                        'stats_deleted',  v_del,
                        'canceled',       v_canceled IS NOT NULL,
                        'failures',       COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[ec-stats] % — % upserted, % deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_ups, v_del, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.rebuild_entity_connection_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.rebuild_entity_connection_stats() TO service_role;

COMMENT ON PROCEDURE public.rebuild_entity_connection_stats() IS
  'FIX-1115 — BREAK-GLASS full rebuild of entity_connection_stats_mv, now a loop '
  'over 16 memory-bounded rebuild_entity_connection_stats_window() calls with a '
  'COMMIT per window and a query_canceled handler. NOT SCHEDULED: cron jobid 16 '
  '(entity-connection-stats-rebuild) is retired and held inactive — the ec-crawl '
  'drives the same windows as a gated arm. The pre-FIX-1115 body built the whole '
  'stage table in ONE statement at work_mem=256MB, measured on the prod clone at '
  '540,737 kB peak with a 5-batch spill; it died at 21,610 s on prod 2026-08-10 '
  'and the two firings after it ended in postmaster restarts. This body cannot '
  'do that: the escape hatch is bounded so that re-enabling jobid 16 is '
  'survivable rather than a repeat.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FIX-1117 — the per-arm source fingerprint.
--
--    Returns NULL for anything it does not recognise, and the caller reads NULL
--    as "cannot tell — run the arm". That is the fail-open contract, and it is
--    why the CASE has an ELSE rather than an exception.
--
--    Each fingerprint is (count, max timestamp) over the arm's own source scope.
--    Where an arm filters more narrowly than the fingerprint (e.g. _investigation
--    reads only status='promoted' AND claim_type='edge'), the fingerprint is
--    deliberately BROADER: over-triggering costs one extra arm run, under-
--    triggering costs a silently frozen arm. Only the four FR-sourced arms are
--    scoped, because they must be — an unscoped FR fingerprint moves on every
--    donation write and would gate nothing.
--
--    STABLE, not VOLATILE: it only reads. That also lets the planner keep it out
--    of the way inside the driver.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ec_arm_source_fingerprint(p_arm text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n  bigint;
  v_ts timestamptz;
BEGIN
  CASE p_arm

    -- votes.updated_at is indexed (votes_updated_at); whole-table is broader
    -- than the arm's vote-value filter, which is the safe direction.
    WHEN 'rebuild_entity_connections_votes' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.votes;

    -- proposal_cosponsors has NO updated_at at all — created_at is the only
    -- timestamp it carries, so count is doing most of the work here.
    WHEN 'rebuild_entity_connections_cosponsors' THEN
      SELECT count(*), max(created_at) INTO v_n, v_ts FROM public.proposal_cosponsors;

    WHEN 'rebuild_entity_connections_appointments' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.career_history;

    WHEN 'rebuild_entity_connections_oversight' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.agencies;

    WHEN 'rebuild_entity_connections_investigation' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.evidence_cards;

    -- external_relationships has neither created_at nor updated_at. ingested_at
    -- moves when a row is (re)ingested and source_updated_at when the upstream
    -- says it changed; GREATEST ignores NULLs, so either one moving is enough.
    WHEN 'rebuild_entity_connections_external' THEN
      SELECT count(*), GREATEST(max(ingested_at), max(source_updated_at))
        INTO v_n, v_ts FROM public.external_relationships;

    -- ── the four FR-sourced arms, each scoped to its OWN predicate ───────────
    -- Labels read out of the shipped arm bodies and checked against pg_enum
    -- (financial_relationship_type: donation, gift, honorarium, loan,
    --  owns_stock, owns_bond, property, contract, grant, lobbying_spend, other,
    --  ie_support, ie_oppose). Six of these carry zero rows today, which makes
    --  those probes free and those arms permanently gated until data arrives.
    WHEN 'rebuild_entity_connections_contracts' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type IN ('contract', 'grant');

    WHEN 'rebuild_entity_connections_gifts' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type IN ('gift', 'honorarium');

    WHEN 'rebuild_entity_connections_holds' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type IN ('owns_stock', 'owns_bond', 'property');

    WHEN 'rebuild_entity_connections_lobbying' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type = 'lobbying_spend';

    -- FIX-1115's stats arm rides the same registry. entity_connections is its
    -- source; derived_at is indexed (entity_connections_derived_at) and every
    -- arm stamps it on insert, and count(*) is what catches a delete-only cycle
    -- (the FIX-969 arms that DELETE and insert nothing).
    WHEN 'entity_connection_stats_windows' THEN
      SELECT count(*), max(derived_at) INTO v_n, v_ts FROM public.entity_connections;

    ELSE
      RETURN NULL;   -- unknown arm ⇒ cannot tell ⇒ the caller runs it
  END CASE;

  RETURN format('n=%s;t=%s', COALESCE(v_n, -1), COALESCE(v_ts::text, '-'));
END;
$$;

REVOKE ALL ON FUNCTION public.ec_arm_source_fingerprint(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ec_arm_source_fingerprint(text) IS
  'FIX-1117 — cheap (count, max-timestamp) fingerprint over ONE entity_connections '
  'arm''s own source scope, used by run_entity_connections_rebuild() to skip an arm '
  'whose source has not changed since that arm''s last successful build. Returns '
  'NULL for an unrecognised arm, and NULL means RUN — the gate fails open in every '
  'direction (FIX-885). Scope is per arm and deliberately BROADER than the arm''s '
  'own filter wherever they differ, because over-triggering costs one arm run and '
  'under-triggering costs a silently frozen arm. The four financial_relationships '
  'arms are the exception and MUST be scoped by relationship_type, or a donation '
  'write would move all four fingerprints every day and gate nothing; their labels '
  'come from the arm bodies and were checked against pg_enum (the FIX-073 rule). '
  'Measured probe costs on the prod clone: agencies 7 ms, evidence_cards 4 ms, '
  'external_relationships 586 ms, FR scoped to contract 15,975 ms — the last '
  'against an arm measured at 344.6 s.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Seed the fingerprint registry row.
--
--    ON CONFLICT DO NOTHING, and seeded EMPTY. An empty registry means every arm
--    reads a NULL previous fingerprint on the first cycle after this lands, so
--    every arm runs once and records what it consumed. The gate starts working
--    on the SECOND cycle. That is deliberate — there is no state from before this
--    migration that could honestly be claimed as "already built".
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.pipeline_state (key, value)
VALUES ('ec_arm_source_fingerprints', jsonb_build_object('arms', '{}'::jsonb))
ON CONFLICT (key) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Retire cron jobid 16.
--
--    Held inactive, NOT unscheduled: cron.job_run_details is the only instrument
--    this job has ever had, and unscheduling would drop the row that carries its
--    history (the same reasoning FIX-1031 used for jobid 13). Resolved by NAME,
--    and the DO block refuses to touch anything if the name is ambiguous.
--
--    Its cron_job_budget row is left in place on purpose: if anyone ever does
--    re-enable it, the FIX-1063 outside watchdog should still bound it.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_jobid  bigint;
  v_n      int;
  v_active boolean;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'entity-connection-stats-rebuild';
  IF v_n = 0 THEN
    RAISE NOTICE '[FIX-1115] no cron job named entity-connection-stats-rebuild — nothing to retire';
  ELSIF v_n > 1 THEN
    RAISE WARNING '[FIX-1115] % jobs named entity-connection-stats-rebuild — refusing to guess; retire by hand', v_n;
  ELSE
    SELECT jobid, active INTO v_jobid, v_active
      FROM cron.job WHERE jobname = 'entity-connection-stats-rebuild';
    IF v_active THEN
      PERFORM cron.alter_job(v_jobid, active := false);
      RAISE WARNING '[FIX-1115] jobid % (entity-connection-stats-rebuild) was ACTIVE — retired; the ec-crawl now owns this work', v_jobid;
    ELSE
      RAISE NOTICE '[FIX-1115] jobid % (entity-connection-stats-rebuild) already inactive — left retired', v_jobid;
    END IF;
  END IF;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The driver — the stats arm and the source-change gate wired in.
--
--    NO DROP NEEDED, and that is worth stating rather than assuming: FIX-1111
--    had to DROP first because it ADDED a parameter, creating a second
--    overload and a hard "procedure ... is not unique" error at every existing
--    call site. This migration changes only the BODY, so CREATE OR REPLACE
--    replaces in place and no caller is disturbed. Any FUTURE migration that
--    touches the SIGNATURE must go back to dropping first.
--
--    The body below was produced from the shipped FIX-1111 body by eight
--    anchored substitutions and nothing else. The starting text was verified
--    byte-identical to the live prosrc before editing:
--
--        pg_proc.prosrc md5 = 92391ef1c916f9b4a42f5f0d020985c3  (41,230 bytes)
--
--    Everything not marked FIX-1115 or FIX-1117 is unchanged from that body.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(
  IN p_mode      text DEFAULT 'incremental'::text,
  IN p_max_units int  DEFAULT NULL
)
 LANGUAGE plpgsql
AS $procedure$DECLARE
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- EXCEPTION WHEN OTHERS does not match query_canceled, so before this the 6h
  -- statement_timeout blew straight through both handlers below and out of the
  -- procedure, skipping the terminal UPDATE and stranding the row 'running'.
  v_canceled   text := NULL;
  -- ── FIX-1056 — budget + durable per-arm resume checkpoint ─────────────────
  -- 5h, deliberately 1h under the 6h `postgres` role statement_timeout so the
  -- terminal bookkeeping below is never the thing that gets cancelled. Do NOT
  -- raise this to 6h: the margin IS the feature. FIX-1071 mirrors this value in
  -- cron_job_budget as an OUTSIDE bound, because this one is checked at arm
  -- boundaries and therefore cannot bound a single arm.
  c_budget_default interval := interval '5 hours';
  c_budget        interval;
  c_cursor_key    text     := 'entity_connections_rebuild_cursor';
  c_budget_key    text     := 'entity_connections_rebuild_budget';
  c_cycle_max_age interval := interval '7 days';
  v_cursor        jsonb;
  v_done_arms     text[]   := ARRAY[]::text[];
  v_cycle_started timestamptz;
  v_budget_out    boolean  := false;
  v_arm_started   timestamptz;
  v_arm_failed    boolean;
  v_arm_timings   jsonb    := '{}'::jsonb;
  v_next_arm      text     := NULL;
  v_resumed       boolean  := false;
  -- ── FIX-1069 — the donations arm is windowed in BOTH modes ────────────────
  v_don_arm       text;
  v_incr_target   timestamptz := NULL;
  v_bootstrap     boolean  := false;
  v_closed        boolean;
  -- ── FIX-1101 ──────────────────────────────────────────────────────────────
  c_inflight_key  text     := 'entity_connections_window_inflight';
  v_interlock     jsonb;
  -- ── FIX-1111 — the crawl ──────────────────────────────────────────────────
  v_crawl        boolean := (p_max_units IS NOT NULL);
  v_units_run    int     := 0;
  v_unit_capped  boolean := false;
  v_gate         jsonb;
  v_unit_t0      timestamptz;
  v_unit_secs    numeric;
  v_rec          jsonb;
  v_backoff_set  boolean := false;
  v_win_since    timestamptz;
  v_unit_log     jsonb   := '[]'::jsonb;
  -- ── FIX-1115 — entity_connection_stats as 16 bounded windows ──────────────
  c_stats_arm    text    := 'entity_connection_stats_windows';
  c_stats_key    text    := 'entity_connection_stats_progress';
  v_stats_prog   jsonb;
  v_stats_done   int[]   := ARRAY[]::int[];
  v_stats_fp     text;
  v_stats_res    jsonb;
  v_stats_ups    bigint  := 0;
  v_stats_del    bigint  := 0;
  -- ── FIX-1117 — the per-arm source-change gate ─────────────────────────────
  c_fp_key       text    := 'ec_arm_source_fingerprints';
  v_fp           text;
  v_fp_prev      text;
  v_fp_t0        timestamptz;
  v_fp_secs      numeric := 0;
  v_gated_arms   text[]  := ARRAY[]::text[];
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo         uuid;
  v_hi         uuid;
  v_win        bigint;
  v_donations_total bigint;
  i            int;
  -- FIX-1028 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF p_mode NOT IN ('full', 'incremental') THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: invalid p_mode %, expected ''full'' or ''incremental''', p_mode;
  END IF;

  -- FIX-1111 — a unit cap of 0 or less is meaningless; treat it as a caller bug
  -- rather than silently doing nothing forever on a */15 schedule.
  IF v_crawl AND p_max_units < 1 THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: p_max_units must be >= 1 (got %)', p_max_units;
  END IF;

  -- ── Concurrency guard (session advisory lock; survives the COMMITs below) ───
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'skipped', now(), now(),
      jsonb_build_object(
        'mode', p_mode,
        'skip_reason', 'advisory lock held by a concurrent entity_connections rebuild',
        'source', 'pg_cron'
      )
    );
    RAISE NOTICE '[rebuild] advisory lock held — skipping (mode=%)', p_mode;
    RETURN;
  END IF;

  -- ── FIX-1111 — the crawl gate ─────────────────────────────────────────────
  -- Crawl mode only: p_max_units IS NULL is byte-for-byte today's behaviour, so
  -- an operator's unbounded manual run is never blocked by a policy written for
  -- a */15 background job.
  --
  -- Placed AFTER the advisory-lock guard (so the unlock below is unconditional)
  -- and BEFORE the FEC interlock, because it is strictly cheaper: two
  -- pipeline_state reads and one indexed data_sync_log aggregate, against the
  -- interlock's pg_locks scan.
  --
  -- LOGGING ASYMMETRY, deliberate. Only `backoff` writes a data_sync_log row.
  -- At */15 a blackout or cooldown skip would write up to 96 rows a day saying
  -- "I did nothing, on purpose", drowning the very log that FIX-1107-class
  -- diagnosis is read from. Backoff is rare, means the box is throttled, and is
  -- exactly what you want to find in that log. The other two are counted in
  -- ec_crawl.skips and RAISEd, which is greppable without being noise.
  IF v_crawl THEN
    v_gate := public.ec_crawl_gate();
    IF NOT (v_gate->>'run')::boolean THEN
      IF v_gate->>'reason' = 'backoff' THEN
        INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
        VALUES (
          'entity_connections_rebuild', 'skipped', v_started, clock_timestamp(),
          jsonb_build_object(
            'mode',        p_mode,
            'source',      'pg_cron',
            'skip_reason', v_gate->>'detail',
            'crawl',       true,
            'max_units',   p_max_units,
            'gate',        v_gate));
      END IF;

      UPDATE public.pipeline_state
         SET value = value
                   || jsonb_build_object(
                        'skips',
                        COALESCE(value->'skips', '{}'::jsonb)
                        || jsonb_build_object(
                             v_gate->>'reason',
                             COALESCE((value->'skips'->>(v_gate->>'reason'))::int, 0) + 1,
                             'last_skip_at',     clock_timestamp(),
                             'last_skip_reason', v_gate->>'reason')),
             updated_at = now()
       WHERE key = 'ec_crawl';

      RAISE NOTICE '[rebuild/crawl] SKIPPED (%) — %', v_gate->>'reason', v_gate->>'detail';
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;
  END IF;

  -- ── FIX-1101 — the widened FEC interlock ──────────────────────────────────
  -- Defers BEFORE the log row goes 'running', before the cursor read and before
  -- any cycle is opened, so a deferred firing leaves no state behind and the
  -- next firing is indistinguishable from a first one.
  --
  -- The status is its own value, 'deferred', not 'skipped': a skip means a peer
  -- rebuild is already doing this work, a defer means the work is deliberately
  -- postponed. Conflating them would make the two indistinguishable in exactly
  -- the log this line of work is diagnosed from.
  --
  -- Placed AFTER the advisory-lock guard, so at this point we HOLD the rebuild
  -- lock and the unlock below is both required and unconditional.
  --
  -- FIX-1111 — this is also the whole Monday fix. jobid 22 is retired by the
  -- crawl, and the weekly FIX-903 FEC replay now simply defers crawl firings
  -- while it holds the lock or leaves a run_state. When it clears, the crawl's
  -- next unit runs — and if the replay spent the day's I/O budget, that unit's
  -- DURATION says so and the sensor above backs off 2 h. No schedule arithmetic.
  v_interlock := public.fec_bulk_interlock_state();

  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'deferred', v_started, clock_timestamp(),
      jsonb_build_object(
        'mode',          p_mode,
        'source',        'pg_cron',
        'defer_reason',  v_interlock->>'reason',
        'fec_interlock', v_interlock)
    );
    RAISE WARNING '[rebuild] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- A stale marker does NOT defer, but it must not be silent either: a
  -- run_state that never clears would otherwise convert one bad run into an
  -- indefinitely skipped arm.
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[rebuild] fec_bulk_run_state present but STALE (%s old) — proceeding; the marker is stranded and wants investigating',
      v_interlock->>'run_state_age';
  END IF;

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer. FIX-1069 re-measured the same for a FUNCTION's
  -- proconfig on the plain SELECT path (the GUC does change inside the body; the
  -- timer does not re-arm) and REMOVED the decorative 45min/90min guards from
  -- the donations arm functions rather than leave them to mislead.
  SET work_mem = '256MB';

  -- ── FIX-1056 — budget, overridable without a migration ────────────────────
  -- pipeline_state.entity_connections_rebuild_budget = {"seconds": N}. Exists so
  -- an operator can shrink or widen the budget in one UPDATE, and so the repro
  -- paths exercise the SHIPPED code path rather than a test variant of it.
  SELECT GREATEST(interval '1 second', make_interval(secs => (value->>'seconds')::numeric))
    INTO c_budget
    FROM public.pipeline_state
   WHERE key = c_budget_key AND (value->>'seconds') IS NOT NULL;
  c_budget := COALESCE(c_budget, c_budget_default);

  -- ── FIX-1056 — read the resume cursor BEFORE opening the log row ───────────
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;

  IF v_cursor IS NOT NULL
     AND v_cursor->>'mode' = p_mode
     AND (v_cursor->>'cycle_started_at')::timestamptz > now() - c_cycle_max_age
  THEN
    v_cycle_started := (v_cursor->>'cycle_started_at')::timestamptz;
    SELECT COALESCE(array_agg(x), ARRAY[]::text[])
      INTO v_done_arms
      FROM jsonb_array_elements_text(COALESCE(v_cursor->'completed_arms', '[]'::jsonb)) x;
    v_resumed := COALESCE(array_length(v_done_arms, 1), 0) > 0;
    IF v_resumed THEN
      RAISE NOTICE '[rebuild] resuming cycle started % — % arm(s) already banked: %',
        v_cycle_started, array_length(v_done_arms, 1), array_to_string(v_done_arms, ', ');
    END IF;
  ELSE
    -- No cursor, wrong mode, or a cycle too old to trust: start fresh.
    v_cycle_started := v_started;
    v_done_arms     := ARRAY[]::text[];
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object(
      'mode', p_mode,
      'source', 'pg_cron',
      'resumed', v_resumed,
      'cycle_started_at', v_cycle_started,
      'budget_seconds', round(EXTRACT(epoch FROM c_budget))::int,
      'arms_banked_on_entry', to_jsonb(v_done_arms),
      -- FIX-1111
      'crawl', v_crawl,
      'max_units', p_max_units
    )
  )
  RETURNING id INTO v_log_id;

  -- ── Startup reconcile: heal a stranded autovacuum flag (FIX-885) ──────────
  -- Runs on EVERY invocation, both modes, before the mode-gated pause below.
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  IF NOT COALESCE(
       (SELECT (split_part(opt, '=', 2))::boolean
          FROM pg_catalog.pg_class c, unnest(c.reloptions) AS opt
         WHERE c.oid = 'public.entity_connections'::regclass
           AND opt LIKE 'autovacuum_enabled=%'),
       true
     ) THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE WARNING '[rebuild] startup reconcile: autovacuum was stranded OFF on entity_connections — re-enabled (FIX-885)';
  END IF;

  -- ── Pause autovacuum on entity_connections for the full rebuild (FIX-590) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = false);
    RAISE NOTICE '[rebuild] autovacuum paused on entity_connections (full rebuild)';
  END IF;
  COMMIT;

  -- ═══ DONATIONS ARM — 16 COMMITTED WINDOWS, BOTH MODES (FIX-703/FIX-1069) ═══
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint, so the
  -- CALL-level budget never becomes an atomic multi-hour txn.
  --
  -- FIX-1069 — this is the change that matters. Before it this whole block was
  -- gated on `IF v_full`, and BOTH scheduled jobs run mode='incremental', so on
  -- prod the windowed path was unreachable code while the incremental arm ran
  -- as one 6-hour statement that banked nothing and wrote nothing.
  --
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band. reconcile_recipient_count() survives as a break-glass full
  -- recompute with NO caller and NO cron job (FIX-736 unscheduled it; the
  -- FIX-1056 comment correction records why that mattered).
  v_don_arm := CASE WHEN v_full THEN 'donations_full_windows' ELSE 'donations_incr_windows' END;

  IF NOT (v_don_arm = ANY(v_done_arms)) THEN
    v_arm_started := clock_timestamp();

    -- ── prepare ──────────────────────────────────────────────────────────────
    IF v_full THEN
      BEGIN
        PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('donations prepare: %s', SQLERRM);
        RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;
    ELSE
      -- FIX-1069 — stages the dirty set ONCE per cycle and returns the cycle
      -- target. Free on resume: an open cycle whose staging table is still
      -- populated returns immediately without rebuilding anything.
      BEGIN
        v_incr_target := public.rebuild_ec_donations_incr_prepare();
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare CANCELED: %', SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;

      -- A NULL target means no watermark has ever been set. The incremental
      -- path only touches donors present in its dirty set, so it cannot clear
      -- an edge whose donor has vanished from financial_relationships; a true
      -- bootstrap must go through the full windowed path, which range-DELETEs.
      IF v_canceled IS NULL
         AND v_incr_target IS NULL
         AND COALESCE(array_length(v_failures, 1), 0) = 0
      THEN
        v_bootstrap := true;
        v_don_arm   := 'donations_full_windows';
        RAISE WARNING '  [donations/incr] no watermark — bootstrapping via the FULL windowed path';
        BEGIN
          PERFORM public.rebuild_ec_donations_full_prepare();
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations prepare: %s', SQLERRM);
          RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
        END;
        COMMIT;
      END IF;
    END IF;

    -- ── the 16 windows ───────────────────────────────────────────────────────
    v_donations_total := 0;
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        -- ── FIX-1111 — skip a banked window BEFORE spending a unit on it ─────
        -- rebuild_ec_donations_incr_window() already returns 0 immediately for a
        -- window level with the cycle target; this hoists that same check into
        -- the driver so an already-banked window does not consume the crawl's
        -- one unit. Without it, a crawl firing that met 15 banked windows would
        -- "run" window 1 in ~0 s, count it, and exit — livelock at one useless
        -- firing every 15 minutes forever.
        --
        -- Read-only and exactly the function's own predicate, so NULL-mode
        -- behaviour is unchanged: the call it replaces returned 0 anyway.
        IF NOT v_full AND NOT v_bootstrap THEN
          SELECT (value->'windows'->>(i - 1)::text)::timestamptz
            INTO v_win_since
            FROM public.pipeline_state
           WHERE key = 'entity_connections_donations';

          IF v_win_since IS NOT NULL AND v_win_since >= v_incr_target THEN
            RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', i;
            CONTINUE;
          END IF;
        END IF;

        -- ── FIX-1111 — the unit cap ─────────────────────────────────────────
        -- Checked AFTER the skip above, so the cap is only ever spent on a
        -- window that will do real work.
        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, i);
          RAISE NOTICE '  [donations] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        -- FIX-1056 — stop at a window boundary rather than being axed mid-window.
        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          -- FIX-1069 — name the arm AND the window. The end-of-run lookup below
          -- only covers v_fns, which never contains the donations window arm.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        -- ── FIX-1101 — publish the in-flight window ────────────────────────
        -- Must be COMMITted before the window starts, or the watchdog — which
        -- runs in a different backend — cannot see it. FIX-1030's shape.
        -- clock_timestamp(), not now(): now() is transaction_timestamp() and
        -- would date the window to whenever this transaction began.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_inflight_key, jsonb_build_object(
                  'window_idx',  i,
                  'started_at',  clock_timestamp(),
                  'backend_pid', pg_backend_pid(),
                  'mode',        p_mode,
                  'log_id',      v_log_id))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now();
        COMMIT;

        v_unit_t0 := clock_timestamp();   -- FIX-1111
        v_win     := 0;                   -- FIX-1111 — so a cancel records 0 rows, not NULL

        BEGIN
          IF v_full OR v_bootstrap THEN
            v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
          ELSE
            -- p_idx is 0-based, to match the window watermark keys "0".."15".
            v_win := public.rebuild_ec_donations_incr_window(i - 1, v_lo, v_hi, v_incr_target);
          END IF;
          v_donations_total := v_donations_total + v_win;
          RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
        EXCEPTION
        -- FIX-1028 — by name, FIRST. PL/pgSQL's OTHERS matches every error
        -- EXCEPT query_canceled and assert_failure.
        WHEN query_canceled THEN
          v_canceled := format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          -- FIX-1101 — name the arm AND the window, matching what the BUDGET
          -- exit above already does. Before this, a cancelled window closed the
          -- row with next_arm = 'donations_incr_windows' and the window index
          -- only in cancel_detail, so the two exit paths described the same
          -- situation differently and next_arm alone could not tell an operator
          -- where to resume. Now that FIX-1101's watchdog makes a per-window
          -- cancel a ROUTINE outcome rather than an incident, that asymmetry
          -- would be read every week.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — CANCELED (statement_timeout or operator cancel): %', i, SQLERRM;
        WHEN OTHERS THEN
          -- Per-window catch: one bad window must not abort the rest; the run is
          -- reported `failed`.
          v_failures := v_failures || format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
        END;
        -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction —
        -- PL/pgSQL forbids COMMIT inside one). This is the point at which the
        -- window's edges AND, in incremental mode, its watermark become durable
        -- together. Neither can land without the other.
        COMMIT;

        -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────
        -- A CANCELLED window is still counted and still recorded. It spent the
        -- I/O either way, and a 1,800 s cancel against a ~346 s median is
        -- precisely the reading that should trip the backoff — that is the
        -- sensor working, not an edge case to exclude.
        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     CASE WHEN v_full OR v_bootstrap THEN 'donations_full_window'
                          ELSE 'donations_incr_window' END,
                     format('%s window %s/16', v_don_arm, i),
                     v_unit_secs, v_win,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled' ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          -- The sensor must never be able to fail the run it is measuring.
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        -- FIX-1028 — stop the sweep. The box has just proven it cannot finish
        -- one window; the remaining ones would each re-arm the same axe.
        IF v_canceled IS NOT NULL THEN
          EXIT;
        END IF;

        -- FIX-1111 — the sensor tripped. In crawl mode stop here and let the
        -- gate hold the next firings off; in NULL mode the backoff is RECORDED
        -- for the crawl to obey but does NOT change this run's behaviour, which
        -- is what "NULL = today's behaviour" has to mean.
        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;
    END IF;

    v_total := v_total + v_donations_total;
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_don_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- ── bank only a clean, complete pass over all 16 windows ─────────────────
    -- FIX-1111 — `AND NOT v_unit_capped` is load-bearing. Without it a crawl
    -- firing that ran ONE window would fall into this branch, and although
    -- rebuild_ec_donations_incr_close() correctly refuses to close a cycle
    -- whose windows still lag (FIX-1069c), the arm would still be appended to
    -- v_done_arms below — so the NEXT firing would skip the entire donations
    -- arm with 15 windows unbuilt. The cap exit is an incomplete pass and must
    -- be treated exactly like a budget exit.
    IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1069 — close the incremental cycle: drop the staging rows and set
      -- the scalar watermark. Returns false if any window still lags, which
      -- cannot happen on this branch but is checked rather than assumed.
      IF NOT v_full AND NOT v_bootstrap THEN
        BEGIN
          v_closed := public.rebuild_ec_donations_incr_close(v_incr_target);
          IF NOT v_closed THEN
            RAISE WARNING '  [donations/incr] cycle NOT closed — a window still lags the target';
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations incr close: %s', SQLERRM);
          RAISE WARNING '  [donations/incr] close FAILED: %', SQLERRM;
        END;
      END IF;

      IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
        v_done_arms := v_done_arms || v_don_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
      END IF;
      COMMIT;
    END IF;

    RAISE NOTICE '  [chunk] donations (windowed, %) — % (% edges)',
      CASE WHEN v_full THEN 'full' WHEN v_bootstrap THEN 'bootstrap' ELSE 'incremental' END,
      CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
           WHEN v_unit_capped THEN 'UNIT CAP'
           WHEN v_canceled IS NOT NULL THEN 'CANCELED'
           ELSE 'complete' END,
      v_donations_total;
  ELSE
    RAISE NOTICE '  [chunk] donations (windowed) — SKIPPED (already banked this cycle)';
  END IF;

  -- ── Remaining chunks (external + investigation MUST stay last) ─────────────
  IF v_full THEN
    v_fns := ARRAY[
      'rebuild_entity_connections_votes_full',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  ELSE
    -- FIX-1069 — 'rebuild_entity_connections_donations' REMOVED. That entry is
    -- what routed the incremental donations arm through the generic
    -- single-statement EXECUTE below; it is now driven as 16 committed windows
    -- above. The function still exists as a break-glass single-shot.
    v_fns := ARRAY[
      'rebuild_entity_connections_votes',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  END IF;

  FOREACH v_fn IN ARRAY v_fns LOOP
    -- FIX-1028 — a cancel in the donations windows above skips the chunks too.
    EXIT WHEN v_canceled IS NOT NULL;
    -- FIX-1056 — and so does a budget exhaustion in those windows.
    EXIT WHEN v_budget_out;
    -- FIX-1111 — and so does a unit-cap or backoff exit. Placed BEFORE the
    -- banked-arm CONTINUE so v_next_arm keeps the window index the donations
    -- exit already wrote into it, rather than being overwritten with the first
    -- outstanding chunk arm.
    EXIT WHEN v_unit_capped;

    -- FIX-1056 — resume: an arm banked earlier in this cycle is already built.
    -- Its edges are stale by at most one cadence, never missing.
    IF v_fn = ANY(v_done_arms) THEN
      RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', v_fn;
      CONTINUE;
    END IF;

    -- ── FIX-1117 — the source-change gate ───────────────────────────────────
    -- Placed AFTER the banked-arm skip and BEFORE the unit cap, for exactly the
    -- reason the banked-window skip sits before the window cap: a gated arm did
    -- no work, so it must not consume the firing's one unit. A cycle whose ten
    -- arms are all unchanged therefore finishes in ONE firing rather than ten,
    -- and that is most of the saving — the ring measured _external and
    -- _contracts rebuilding byte-identical row counts (2 x 574,209 and
    -- 3 x 189,949) for ~1,244 s of writer per cycle.
    --
    -- ⚠ FAIL OPEN. A NULL fingerprint — unknown arm, probe error, or no stored
    -- previous value — RUNS the arm. The only path that skips is "I measured
    -- this source before the last successful build, I measured it now, and the
    -- two are equal". A gate that can silently freeze an arm is the FIX-885
    -- stranded-flag class and is strictly worse than the waste it removes.
    v_fp      := NULL;
    v_fp_prev := NULL;
    v_fp_t0   := clock_timestamp();
    BEGIN
      v_fp := public.ec_arm_source_fingerprint(v_fn);
    EXCEPTION
    -- FIX-1028 — by name, and it earns its place here: the probe is a statement
    -- like any other, so the FIX-1063 watchdog can land on it, and OTHERS does
    -- not match query_canceled. Without this a cancelled probe would escape the
    -- procedure entirely and strand the log row 'running'.
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', v_fn, SQLERRM);
      v_next_arm := v_fn;
      RAISE WARNING '  [gate] % — fingerprint probe CANCELED: %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [gate] % — fingerprint probe FAILED (%) — running the arm', v_fn, SQLERRM;
      v_fp := NULL;
    END;
    EXIT WHEN v_canceled IS NOT NULL;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    IF v_fp IS NOT NULL THEN
      SELECT value->'arms'->v_fn->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_fp THEN
      -- Unchanged. Bank it for this cycle — an arm whose source did not move IS
      -- built, and refusing to bank it would stop the cycle ever closing — then
      -- carry straight on to the next arm without spending a unit.
      v_done_arms  := v_done_arms  || v_fn;
      v_gated_arms := v_gated_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(v_fn, round(v_fp_secs)::int);

      -- The ring gets a "skipped_unchanged" mark so the lag metric can tell an
      -- IDLE arm from a GATED one. rows = 0 makes the entry unratable under
      -- FIX-1111b (rate is NULL below backoff_min_rows), so it is excluded from
      -- the median rate by construction and cannot drag down the baseline the
      -- next REAL run of this class is judged against. That property is why the
      -- mark can live in the same ring rather than needing a second one.
      BEGIN
        v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      RAISE NOTICE '  [chunk] % — SKIPPED (source unchanged since last build: %)', v_fn, v_fp;
      CONTINUE;
    END IF;

    -- FIX-1111 — the unit cap, after the banked-arm skip for the same reason
    -- the window cap sits after the banked-window skip: a cap must only ever be
    -- spent on work that will actually run.
    IF v_crawl AND v_units_run >= p_max_units THEN
      v_unit_capped := true;
      v_next_arm    := v_fn;
      RAISE NOTICE '  [chunk] % — UNIT CAP reached (% unit(s)); banking and exiting', v_fn, v_units_run;
      EXIT;
    END IF;

    -- FIX-1056 — stop BEFORE starting an arm the budget cannot cover, so the
    -- exit lands on an arm boundary with the cursor and the log row intact
    -- rather than being cancelled mid-statement by the 6h axe.
    IF clock_timestamp() - v_started >= c_budget THEN
      v_budget_out := true;
      v_next_arm   := v_fn;
      RAISE WARNING '  [chunk] % — BUDGET EXHAUSTED (%s elapsed); banking % arm(s) and exiting',
        v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
        COALESCE(array_length(v_done_arms, 1), 0);
      EXIT;
    END IF;

    v_arm_started := clock_timestamp();
    v_arm_failed  := false;
    v_n           := 0;   -- FIX-1111 — so a cancelled arm records 0 rows, not NULL
    BEGIN
      EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
        INTO v_n;
      v_total := v_total + v_n;
      RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
    EXCEPTION
    -- FIX-1028 — by name; see the donations handler above.
    WHEN query_canceled THEN
      v_canceled := format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — CANCELED (statement_timeout or operator cancel): %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      v_arm_failed := true;
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;

    -- FIX-1056 — per-arm elapsed, recorded for EVERY outcome. This is the
    -- observability gap that let the 08-17 overrun be attributed to the arm the
    -- axe hit rather than the arm that spent the hours.
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- FIX-1056 — bank the arm only if it neither cancelled nor raised. A
    -- cancelled arm rolled back, so re-running it next firing is exactly right.
    IF v_canceled IS NULL AND NOT v_arm_failed THEN
      v_done_arms := v_done_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();

      -- ── FIX-1117 — store the fingerprint this build CONSUMED ──────────────
      -- v_fp was captured BEFORE the arm ran. Re-reading the source here would
      -- mark any write that landed DURING the run as already consumed and gate
      -- it away forever; storing the pre-run value means such a write is seen
      -- next cycle and the arm runs again. Conservative in the only safe
      -- direction. Merged key-wise rather than jsonb_set()-ed, so a registry row
      -- that somehow lacks the 'arms' object still gets written correctly.
      IF v_fp IS NOT NULL THEN
        INSERT INTO public.pipeline_state AS ps (key, value)
        VALUES (c_fp_key, jsonb_build_object('arms',
                  jsonb_build_object(v_fn,
                    jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))))
        ON CONFLICT (key) DO UPDATE
          SET value = COALESCE(ps.value, '{}'::jsonb)
                      || jsonb_build_object('arms',
                           COALESCE(ps.value->'arms', '{}'::jsonb)
                           || jsonb_build_object(v_fn,
                                jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))),
              updated_at = now();
      END IF;
    END IF;

    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    -- Also the point at which the arm AND its cursor become durable together.
    COMMIT;

    -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────────
    v_units_run := v_units_run + 1;
    v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_arm_started));
    BEGIN
      v_rec := public.ec_crawl_record_unit(
                 v_fn, v_fn, v_unit_secs, v_n,
                 CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                      WHEN v_arm_failed          THEN 'failed'
                      ELSE 'ok' END);
      IF (v_rec->>'backoff_set')::boolean THEN
        v_backoff_set := true;
      END IF;
      v_unit_log := v_unit_log || jsonb_build_array(v_rec);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
    END;
    COMMIT;

    IF v_canceled IS NOT NULL THEN
      EXIT;
    END IF;

    -- FIX-1111 — sensor tripped; crawl mode stops, NULL mode carries on.
    IF v_crawl AND v_backoff_set THEN
      v_unit_capped := true;
      EXIT;
    END IF;
  END LOOP;

  -- ═══ EC STATS ARM — 16 BOUNDED, GATED WINDOWS (FIX-1115) ═══════════════════
  -- LAST in the cycle by construction: it aggregates entity_connections, so it
  -- has to run after every arm that writes edges — including _external and
  -- _investigation, which are themselves pinned last.
  --
  -- Shaped exactly like the donations windows above, and for the same reasons:
  -- one window is one unit, each window COMMITs, an already-banked window is
  -- skipped WITHOUT spending a unit (or a firing that met 15 banked windows
  -- would "run" window 1 in ~0 s and livelock at one useless firing every 15
  -- minutes), and per-window progress is durable so a cancel loses at most one
  -- window.
  --
  -- THE STALENESS THIS CLEARS: entity_connection_stats_mv last rebuilt
  -- successfully 2026-08-05 while the crawl writes edges continuously, so the
  -- first gated pass is a full 16-window backfill of three weeks of drift. At
  -- one unit per */15 firing that is ~4 h of wall clock, paced under the same
  -- sensor and blackout as everything else — which is the entire point of doing
  -- it here rather than in a 6-hour cron job.
  IF c_stats_arm = ANY(v_done_arms) THEN
    RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', c_stats_arm;
  ELSIF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped THEN
    v_arm_started := clock_timestamp();

    -- ── the FIX-1117 gate, over entity_connections itself ───────────────────
    v_fp_t0    := clock_timestamp();
    v_stats_fp := NULL;
    BEGIN
      v_stats_fp := public.ec_arm_source_fingerprint(c_stats_arm);
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', c_stats_arm, SQLERRM);
      v_next_arm := c_stats_arm;
      RAISE WARNING '  [ec-stats] fingerprint probe CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [ec-stats] fingerprint probe FAILED (%) — running the arm', SQLERRM;
      v_stats_fp := NULL;
    END;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    v_fp_prev := NULL;
    IF v_canceled IS NULL AND v_stats_fp IS NOT NULL THEN
      SELECT value->'arms'->c_stats_arm->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_canceled IS NOT NULL THEN
      NULL;   -- fall through to the terminal bookkeeping below

    ELSIF v_stats_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_stats_fp THEN
      -- No edge has been written since the last successful stats build. Bank the
      -- arm and move on without spending a unit. On a day where the gate above
      -- also silenced the ten source arms, this is the whole cycle costing
      -- nothing but probes.
      v_done_arms  := v_done_arms  || c_stats_arm;
      v_gated_arms := v_gated_arms || c_stats_arm;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      DELETE FROM public.pipeline_state WHERE key = c_stats_key;
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(c_stats_arm, round(v_fp_secs)::int);
      BEGIN
        v_rec := public.ec_crawl_record_unit(c_stats_arm, c_stats_arm || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;
      RAISE NOTICE '  [chunk] % — SKIPPED (entity_connections unchanged since last build: %)',
        c_stats_arm, v_stats_fp;

    ELSE
      -- ── resume this cycle's per-window progress ──────────────────────────
      SELECT value INTO v_stats_prog FROM public.pipeline_state WHERE key = c_stats_key;
      IF v_stats_prog IS NOT NULL
         AND (v_stats_prog->>'cycle_started_at')::timestamptz = v_cycle_started
      THEN
        SELECT COALESCE(array_agg(x::int), ARRAY[]::int[])
          INTO v_stats_done
          FROM jsonb_array_elements_text(COALESCE(v_stats_prog->'done', '[]'::jsonb)) x;
        -- Keep the fingerprint the FIRST firing of this arm captured. A pass
        -- that spans four hours of firings must record what it actually
        -- consumed, not a value re-read at the end with edges written between.
        v_stats_fp := COALESCE(v_stats_prog->>'fp', v_stats_fp);
        IF COALESCE(array_length(v_stats_done, 1), 0) > 0 THEN
          RAISE NOTICE '  [ec-stats] resuming — %/16 window(s) already banked this cycle',
            array_length(v_stats_done, 1);
        END IF;
      ELSE
        v_stats_done := ARRAY[]::int[];
      END IF;

      FOR i IN 1..16 LOOP
        -- Banked window: skip BEFORE the cap, never spending a unit on a no-op.
        IF (i - 1) = ANY(v_stats_done) THEN
          RAISE NOTICE '    [ec-stats] window %/16 — SKIPPED (already banked this cycle)', i;
          CONTINUE;
        END IF;

        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, i);
          RAISE NOTICE '  [ec-stats] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          v_next_arm   := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        v_unit_t0    := clock_timestamp();
        v_n          := 0;   -- so a cancelled window records 0 rows, not NULL
        v_arm_failed := false;
        BEGIN
          v_stats_res := public.rebuild_entity_connection_stats_window(v_lo, v_hi);
          v_n         := (v_stats_res->>'upserted')::bigint + (v_stats_res->>'deleted')::bigint;
          v_stats_ups := v_stats_ups + (v_stats_res->>'upserted')::bigint;
          v_stats_del := v_stats_del + (v_stats_res->>'deleted')::bigint;

          -- The window's rows and the window's progress become durable in the
          -- SAME transaction. FIX-1112's rule in its strongest form: there is no
          -- ratchet to lose, because the progress marker IS part of the chunk.
          INSERT INTO public.pipeline_state (key, value)
          VALUES (c_stats_key, jsonb_build_object(
                    'cycle_started_at', v_cycle_started,
                    'done',             to_jsonb(v_stats_done || (i - 1)),
                    'fp',               v_stats_fp))
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now();

          RAISE NOTICE '    [ec-stats] window %/16 [%..%) — % upserted, % deleted, % groups',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'),
            v_stats_res->>'upserted', v_stats_res->>'deleted', v_stats_res->>'groups';
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('%s window %s/16: %s', c_stats_arm, i, SQLERRM);
          v_next_arm := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — CANCELED: %', i, SQLERRM;
        WHEN OTHERS THEN
          v_arm_failed := true;
          v_failures := v_failures || format('%s window %s: %s', c_stats_arm, i, SQLERRM);
          RAISE WARNING '  [ec-stats] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;

        -- Claim the window only once its transaction actually committed.
        -- PL/pgSQL variables are NOT rolled back by a subtransaction abort, so
        -- appending inside the block above would let a failed INSERT leave this
        -- array claiming a window that never banked.
        IF v_canceled IS NULL AND NOT v_arm_failed THEN
          v_stats_done := v_stats_done || (i - 1);
        END IF;

        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     'entity_connection_stats_window',
                     format('%s window %s/16', c_stats_arm, i),
                     v_unit_secs, v_n,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                          WHEN v_arm_failed          THEN 'failed'
                          ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        EXIT WHEN v_canceled IS NOT NULL;

        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;

      v_total := v_total + v_stats_ups + v_stats_del;
      v_arm_timings := v_arm_timings || jsonb_build_object(
        c_stats_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

      -- Bank the ARM only on a clean, complete pass over all sixteen windows —
      -- the same "AND NOT v_unit_capped" discipline the donations arm needs, and
      -- for the same reason: a cap exit is an INCOMPLETE pass, and banking it
      -- would make the next firing skip the whole arm with windows unbuilt.
      IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
         AND COALESCE(array_length(v_failures, 1), 0) = 0
         AND COALESCE(array_length(v_stats_done, 1), 0) = 16
      THEN
        v_done_arms := v_done_arms || c_stats_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();

        IF v_stats_fp IS NOT NULL THEN
          INSERT INTO public.pipeline_state AS ps (key, value)
          VALUES (c_fp_key, jsonb_build_object('arms',
                    jsonb_build_object(c_stats_arm,
                      jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))))
          ON CONFLICT (key) DO UPDATE
            SET value = COALESCE(ps.value, '{}'::jsonb)
                        || jsonb_build_object('arms',
                             COALESCE(ps.value->'arms', '{}'::jsonb)
                             || jsonb_build_object(c_stats_arm,
                                  jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))),
                updated_at = now();
        END IF;

        DELETE FROM public.pipeline_state WHERE key = c_stats_key;
        COMMIT;
      END IF;

      RAISE NOTICE '  [chunk] % — % (% upserted, % deleted)', c_stats_arm,
        CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
             WHEN v_unit_capped THEN 'UNIT CAP'
             WHEN v_canceled IS NOT NULL THEN 'CANCELED'
             ELSE 'complete' END,
        v_stats_ups, v_stats_del;
    END IF;
  END IF;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;

  -- ── FIX-1056 — cycle bookkeeping ───────────────────────────────────────────
  -- FIX-1069 — the donations WINDOW arm is in v_fns in neither mode, so it has
  -- to be named explicitly here. Without this, a run whose donations windows
  -- never banked could compute v_next_arm = NULL and sit one gate away from
  -- reporting 'complete'. Only computed when nothing already claimed it — a
  -- budget exit sets it with the window index attached.
  IF v_next_arm IS NULL THEN
    IF NOT (v_don_arm = ANY(v_done_arms)) THEN
      v_next_arm := v_don_arm;
    ELSE
      -- WITH ORDINALITY because unnest() ordering is not contractually
      -- guaranteed and "first outstanding arm" has to mean first in ARM ORDER,
      -- not first returned.
      SELECT f INTO v_next_arm
        FROM unnest(v_fns) WITH ORDINALITY AS u(f, ord)
       WHERE NOT (u.f = ANY(v_done_arms))
       ORDER BY u.ord
       LIMIT 1;
    END IF;
    -- FIX-1115 — the stats arm is not a member of v_fns either, and it is LAST,
    -- so it is only the outstanding arm once every other one has banked.
    IF v_next_arm IS NULL AND NOT (c_stats_arm = ANY(v_done_arms)) THEN
      v_next_arm := c_stats_arm;
    END IF;
  END IF;

  IF v_next_arm IS NULL
     AND v_canceled IS NULL
     AND NOT v_budget_out
     AND COALESCE(array_length(v_failures, 1), 0) = 0
  THEN
    -- Every arm banked AND the pass was clean: the cycle is closed, so the
    -- cursor must not survive to make the NEXT firing skip everything.
    -- Deliberately also gated on v_failures: the donations windows can fail
    -- without being banked while every v_fns arm succeeds, which would
    -- otherwise clear the cursor on a run that still owes work. Leaving the
    -- cursor is safe either way — each arm is an idempotent DELETE-then-INSERT
    -- over its own connection_type — but clearing it on a failed pass would
    -- throw away the record of what still needs redoing.
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
    -- FIX-1115 — belt-and-braces: the stats arm clears this itself when it
    -- banks, but a cycle can close having GATED the arm on a firing where the
    -- key was already gone, and a stale key carrying a dead cycle_started_at
    -- would otherwise sit here until the next stats pass ignored it.
    DELETE FROM public.pipeline_state WHERE key = c_stats_key;
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

  -- ── FIX-1101 — the belt-and-braces clear (playbook C3) ────────────────────
  -- Unconditional, and NOT gated on this run having published anything: this is
  -- the "put it where it can FIRE" backstop, and it must be able to clean up
  -- state this run did not create. Reached on every software exit from the
  -- procedure — convergence, budget exit, a caught cancel, per-arm failures.
  -- Only a hard terminate or a crash skips it, and that case is the watchdog's.
  DELETE FROM public.pipeline_state WHERE key = c_inflight_key;
  COMMIT;

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE
                        -- FIX-1028 — a cancelled run is PARTIAL: the edges it did
                        -- commit are real, but the sweep did not cover everything.
                        WHEN v_canceled IS NOT NULL THEN 'partial'
                        -- FIX-1056 — a budget exit is also PARTIAL, and unlike a
                        -- cancel it is an ORDERLY stop with a resumable cursor.
                        WHEN v_budget_out THEN 'partial'
                        -- FIX-1111 — so is a unit-cap exit, and it is the crawl's
                        -- NORMAL outcome rather than an incident. It must still be
                        -- 'partial' (work remains), but `unit_capped` in metadata
                        -- is what distinguishes ~96 routine crawl exits a day from
                        -- the budget exhaustions FIX-969 counts.
                        WHEN v_unit_capped THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        -- FIX-1056 — arms left unrun without a cancel or a budget
                        -- exit can only mean a failure skipped them; never claim
                        -- 'complete' while v_next_arm is non-NULL.
                        WHEN v_next_arm IS NOT NULL THEN 'partial'
                        ELSE 'complete'
                      END,
      -- clock_timestamp(), not now(): now() is transaction_timestamp() and this
      -- transaction began after the last chunk's COMMIT (FIX-979 / FIX-972).
      completed_at  = clock_timestamp(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s%s', v_canceled,
                                 CASE WHEN v_next_arm IS NOT NULL
                                      THEN format('; resumable at arm %s', v_next_arm)
                                      ELSE '' END,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN v_budget_out
                          -- +2 on the arm count: the donations window arm and
                          -- (FIX-1115) the stats window arm are both bankable
                          -- but neither is a member of v_fns.
                          THEN left(format('budget exhausted — resumable at arm %s (%s of %s arms banked)',
                                 COALESCE(v_next_arm, '?'),
                                 COALESCE(array_length(v_done_arms, 1), 0),
                                 COALESCE(array_length(v_fns, 1), 0) + 2), 1000)
                        -- FIX-1111 — an ORDERLY, expected stop. Worded so it can
                        -- never be mistaken for a budget blowout in a grep.
                        WHEN v_unit_capped
                          THEN left(format('unit cap reached — %s unit(s) run%s; resumable at arm %s',
                                 v_units_run,
                                 CASE WHEN v_backoff_set THEN ' then BACKOFF tripped' ELSE '' END,
                                 COALESCE(v_next_arm, '?')), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- FIX-1056
                        'budget_exhausted', v_budget_out,
                        'arm_timings', v_arm_timings,
                        'arms_banked', to_jsonb(v_done_arms),
                        'next_arm', v_next_arm,
                        'cycle_started_at', v_cycle_started,
                        -- FIX-1069 — the donations cycle target this run drove
                        -- its windows toward, so a partial run's remaining work
                        -- is readable from the log row alone.
                        'donations_target_at', v_incr_target,
                        'donations_bootstrap', v_bootstrap,
                        -- FIX-1111
                        'crawl', v_crawl,
                        'max_units', p_max_units,
                        'units_run', v_units_run,
                        'unit_capped', v_unit_capped,
                        'backoff_tripped', v_backoff_set,
                        'units', v_unit_log,
                        -- FIX-1115
                        'stats_upserted', v_stats_ups,
                        'stats_deleted', v_stats_del,
                        -- FIX-1117 — which arms this firing skipped as unchanged.
                        -- Distinguishable from an idle arm, which simply never
                        -- appears, and from a banked one, which is in arms_banked
                        -- without being here.
                        'gated_arms', to_jsonb(v_gated_arms),
                        'gated_count', COALESCE(array_length(v_gated_arms, 1), 0)
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures), % arm(s) banked, % unit(s), next=%',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
         WHEN v_unit_capped THEN 'UNIT CAP'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0),
    COALESCE(array_length(v_done_arms, 1), 0), v_units_run, COALESCE(v_next_arm, '(none)');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

COMMENT ON PROCEDURE public.run_entity_connections_rebuild(text, int) IS
  'Rebuilds entity_connections arm by arm. FIX-1056: 5h wall-clock budget '
  'checked at arm boundaries, per-arm banking into '
  'pipeline_state.entity_connections_rebuild_cursor, per-arm timings. '
  'FIX-1069: the donations arm is driven as 16 COMMITted windows in BOTH modes. '
  'FIX-1071 adds the outside bound this internal budget cannot provide for a '
  'single arm. FIX-1101: publishes the in-flight window and DEFERS the whole run '
  'when a FEC bulk run is live or pending resume. FIX-1111: p_max_units — NULL is '
  'the pre-1111 behaviour, N runs at most N PENDING units and exits partial with '
  'a resumable cursor, which is what makes the */15 ec-crawl possible. '
  'FIX-1115 adds a THIRD unit family, LAST in the cycle: entity_connection_stats '
  'as 16 memory-bounded windows (rebuild_entity_connection_stats_window), each '
  'one unit, each COMMITting its rows and its progress marker in the SAME '
  'transaction so a cancel loses at most one window and there is no watermark '
  'ratchet to strand (FIX-1112). This retires cron jobid 16, whose single '
  'unbounded stage build peaked at 540,737 kB and took the postmaster with it '
  'twice. FIX-1117 gates every non-donations arm AND the stats arm on a cheap '
  'per-arm source fingerprint (ec_arm_source_fingerprint): an arm whose source '
  'has not changed since its last successful build is banked for the cycle and '
  'skipped WITHOUT spending a unit, so a no-change cycle costs probes instead of '
  'the ~1,244 s/cycle the ring measured _external and _contracts spending on '
  'byte-identical rebuilds. The gate FAILS OPEN in every direction and the '
  'fingerprint recorded is the PRE-run one, so a source write landing mid-run is '
  'seen next cycle rather than swallowed.';

NOTIFY pgrst, 'reload schema';

-- FIX-1114 shipped the rule that every pipeline routine loses its default
-- anon/authenticated EXECUTE grant. A CREATE OR REPLACE does not re-open the
-- grants on an existing routine, but the two functions created above are NEW,
-- and the REVOKEs next to their definitions are the ones that close them. This
-- is the belt-and-braces repeat for the recreated procedure.
REVOKE ALL ON PROCEDURE public.run_entity_connections_rebuild(text, int)
  FROM PUBLIC, anon, authenticated;
