-- FIX-687 — port the entity_connections rebuild orchestration into a SQL
-- procedure callable by pg_cron.
--
-- This is a faithful port of the direct-pg orchestration in
-- packages/data/src/scripts/rebuild-entity-connections.ts. The per-chunk SQL
-- functions are reused UNCHANGED (votes/donations windowed trio/cosponsors/
-- appointments/oversight/holds/gifts/contracts/lobbying/external/investigation);
-- the only new SQL is the orchestration that previously lived in TypeScript.
--
-- Why a PROCEDURE (not a function): pg_cron wraps a function call in a single
-- transaction, but we need to COMMIT between phases — (1) so the
-- autovacuum-disable ALTER is durable before the heavy donations write begins
-- (an uncommitted storage-param change is invisible to the autovacuum daemon),
-- (2) so each chunk commits independently and a later chunk's failure doesn't
-- roll back earlier chunks (mirroring the TS direct-pg autocommit semantics),
-- and (3) to advance the xmin horizon between chunks so the multi-hour full
-- rebuild doesn't pin global vacuum. Only a procedure called via CALL may issue
-- COMMIT.
--
-- Concurrency guard — SESSION-scoped advisory lock (pg_try_advisory_lock), NOT
-- pg_advisory_xact_lock: an xact lock releases at the first COMMIT, which would
-- let a second cron firing grab it mid-rebuild. A session lock survives every
-- COMMIT below and is released by the explicit pg_advisory_unlock at the end —
-- or, if the procedure aborts on an unexpected error, by the pg_cron background
-- worker's session ending (pg_cron runs each job in its own backend). That
-- session-end release is the "releases on error too" backstop; an explicit
-- unlock cannot live in an outer EXCEPTION block here because a block with an
-- EXCEPTION handler is a subtransaction and PL/pgSQL forbids COMMIT inside one.
--
-- Observability — writes a `running` data_sync_log row at entry and a terminal
-- `complete`/`failed`/`skipped` row at exit, keyed to pipeline
-- 'entity_connections_rebuild' (NOT 'nightly_cron' — different cadence,
-- different semantics; the FIX-234 canary only watches nightly_cron). Shape
-- matches startSync/completeSync/failSync in packages/data/src/pipelines/
-- sync-log.ts so the existing mark-killed/reaper tooling keeps working.

CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(p_mode text DEFAULT 'incremental')
LANGUAGE plpgsql
AS $$
DECLARE
  -- Stable session-advisory-lock key for this rebuild (any concurrent firing of
  -- either pg_cron job, or a manual CALL, contends on the same key).
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- Donations full window bounds — the 16 from_id nibble lo-bounds. window i
  -- runs [bounds[i], bounds[i+1]); the 16th runs [bounds[16], NULL) to the end
  -- of the uuid space. Mirrors DONATION_WINDOW_BOUNDS in
  -- rebuild-entity-connections.ts (the GROUP BY keys on from_id, so a
  -- from_id-range window emits each donor's complete edge set — result-identical
  -- to the monolith).
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
BEGIN
  IF p_mode NOT IN ('full', 'incremental') THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: invalid p_mode %, expected ''full'' or ''incremental''', p_mode;
  END IF;

  -- ── Concurrency guard ──────────────────────────────────────────────────────
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

  -- ── Session GUCs (plain SET survives COMMIT; SET LOCAL would not) ───────────
  -- 90min per-statement cap matches the chunk functions' precedent and the TS
  -- session backstop; 256MB work_mem keeps the donation HashAggregate from
  -- thrashing at prod's tiny default (FIX-588).
  SET statement_timeout = '90min';
  SET work_mem = '256MB';

  -- ── Start-row ──────────────────────────────────────────────────────────────
  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object('mode', p_mode, 'source', 'pg_cron')
  )
  RETURNING id INTO v_log_id;

  -- ── Pause autovacuum on entity_connections for the full rebuild (FIX-590) ──
  -- The donations prepare() DELETE leaves ~2.7M dead tuples; with FIX-331's
  -- aggressive scale factor that trips autovacuum MID-rebuild and its I/O
  -- competes with the window INSERTs on the cache-starved Micro. Commit the
  -- change before the heavy work so the autovacuum daemon actually sees it.
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = false);
    RAISE NOTICE '[rebuild] autovacuum paused on entity_connections (full rebuild)';
  END IF;
  COMMIT;

  -- ── Chunk sequence (TS chunkFns(mode) ordering) ────────────────────────────
  -- donations + votes carry the _full suffix in full mode; the other 9 always
  -- run their single full-rebuild function. external + investigation MUST stay
  -- last — both are ON CONFLICT DO NOTHING passes, so every authoritative pass
  -- must populate its (from,to,type) tuples first.
  IF v_full THEN
    v_fns := ARRAY[
      'rebuild_entity_connections_donations_full',
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
    v_fns := ARRAY[
      'rebuild_entity_connections_donations',
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
    BEGIN
      IF v_fn = 'rebuild_entity_connections_donations_full' THEN
        -- Windowed donations (prepare + 16 from_id windows + finalize). Each
        -- call is its own top-level statement, so each gets a fresh
        -- statement_timeout (the windowing's whole point; FIX-588). The whole
        -- sequence runs in THIS chunk's subtransaction, so a window failure
        -- rolls the donations work back atomically and is recorded as a hard
        -- chunk failure — never a silent partial (a stricter guarantee than the
        -- TS path, which left donations short on a mid-window failure).
        PERFORM public.rebuild_ec_donations_full_prepare();
        v_donations_total := 0;
        FOR i IN 1..16 LOOP
          v_lo := c_bounds[i];
          v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
          v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
          v_donations_total := v_donations_total + v_win;
          RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
        END LOOP;
        PERFORM public.rebuild_ec_donations_full_finalize();
        v_total := v_total + v_donations_total;
        RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_donations_total;
      ELSE
        -- Every other chunk returns TABLE(connection_type, edges_upserted).
        EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
          INTO v_n;
        v_total := v_total + v_n;
        RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Record and continue (matches the TS chunkFailures semantics): one bad
      -- chunk must not abort the rest, but the run is reported `failed`.
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;
    -- Commit after each chunk (top-level, outside the subtransaction block):
    -- mirrors the TS direct-pg autocommit-per-chunk and advances xmin.
    COMMIT;
  END LOOP;

  -- ── Re-enable autovacuum + one post-rebuild settle ─────────────────────────
  -- The TS also runs a manual VACUUM (ANALYZE) here; VACUUM cannot run inside a
  -- procedure's transaction, so it is dropped — re-enabled autovacuum picks up
  -- the churn (acceptable; the chunk DELETE/INSERT churn is bounded).
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;
  COMMIT;

  -- ── Donor-rollup MV refresh (full only, post-COMMIT, CONCURRENTLY) ─────────
  -- Moved here from rebuild-entity-connections.yml's data:refresh-donor-mv:ci
  -- step (FIX-641). Donation edges only change when the chunks above run, so
  -- this is the right (and only) cadence. Wrapped advisory: a refresh failure
  -- leaves the prior MV snapshot in place (still served; next rebuild
  -- re-aggregates) rather than masking a successful rebuild. CONCURRENTLY needs
  -- the unique index official_donor_rollup_mv_pk, which exists (FIX-518).
  IF v_full THEN
    BEGIN
      REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_donor_rollup_mv;
      RAISE NOTICE '[rebuild] refreshed official_donor_rollup_mv (CONCURRENTLY)';
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[rebuild] official_donor_rollup_mv refresh FAILED (advisory): %', SQLERRM;
    END;
  END IF;

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0)
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0);

  -- ── Release the session advisory lock (success path) ───────────────────────
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;

COMMENT ON PROCEDURE public.run_entity_connections_rebuild(text) IS
  'FIX-687 — pg_cron-driven entity_connections rebuild. Ports the orchestration '
  'from scripts/rebuild-entity-connections.ts: session advisory-lock guard, '
  'per-chunk COMMIT, donations window-loop (full), data_sync_log observability, '
  'donor-rollup MV refresh (full). Governed by chunk statement_timeout, not a '
  'GHA wall-clock budget. CALL with ''full'' (Mon) or ''incremental'' (Wed).';

GRANT EXECUTE ON PROCEDURE public.run_entity_connections_rebuild(text) TO service_role;
