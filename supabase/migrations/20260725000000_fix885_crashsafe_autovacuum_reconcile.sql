-- =============================================================================
-- FIX-885 — make the entity_connections autovacuum re-enable crash-safe, and
-- give the canary a visibility-map signal it can escalate on.
--
-- FIX-884 cleared a ~4-week strand on prod (autovacuum_enabled=false, 9,505,759
-- dead tuples, 0.9% of pages all-visible) but not the mechanism. Root cause,
-- traced 2026-07-25:
--
--   * FIX-590 pauses autovacuum for a FULL rebuild; FIX-591 re-enables it in a
--     finally + a startup reconcile inside rebuild-entity-connections.ts.
--   * FIX-688 then moved the schedule to pg_cron. The TS script became manual
--     break-glass only, so its startup reconcile no longer runs on prod.
--   * The in-DB procedure that replaced it gates EVERY autovacuum touch on
--     v_full — and both pg_cron jobs (rebuild-ec-incremental Wed,
--     rebuild-ec-incremental-mon Mon) call it with 'incremental'. So the
--     procedure has never re-enabled anything.
--   * The last GHA run (2026-06-28, run 28319286353) was cancelled at the 4h
--     cap. SIGKILL skipped the finally, the signal handler did not finish, and
--     from then until FIX-884 nothing on prod could restore the flag.
--
-- Two changes here.
--
-- 1. run_entity_connections_rebuild() gets an UNCONDITIONAL startup reconcile,
--    after the advisory-lock guard and before the mode-gated pause. Both pg_cron
--    jobs run it, so any strand now self-heals within <=3 days no matter how the
--    previous run died. Base is the LIVE body (pg_get_functiondef, local
--    2026-07-25 — the FIX-703 per-window-COMMIT form); only the reconcile block
--    is added.
--
-- 2. check_rebuild_autovacuum_status() also reports the VISIBILITY MAP. The flag
--    is a proxy; what actually breaks queries is relallvisible collapsing, which
--    silently downgrades every index-only scan to a heap probe. On prod that
--    turned FIX-497's partial covering index into 34,534 heap fetches for 34,552
--    rows (20.5s of a 22.1s query) and neither FIX-497 nor FIX-883 had any way
--    to notice. New keys: vm[] (per-table relallvisible/relpages/pct) and
--    vm_degraded[] (below VM_MIN_PCT). Existing keys (tables, stranded,
--    rebuild_active) are unchanged, so the shape stays backward compatible.
--    CREATE OR REPLACE preserves the FIX-650/834 service_role-only grants.
--
-- Threshold: 50%. Deliberately loose — a legitimate post-rebuild dip must not
-- page anyone. The canary runs 05:00 UTC daily; rebuilds are Mon/Wed 08:00, so
-- the nearest read is ~21h later, by which time autovacuum (scale factor 0.05,
-- FIX-331) has long since caught up. 0.9% is the failure this must catch.
--
-- NOT changed: the monthly ec-vacuum-analyze job (FIX-704, jobid 6). It has
-- never fired — created 2026-07-02, after that month's 1st, so its first run is
-- 2026-08-01 — but it is a backstop, not the mechanism. With the flag reliably
-- on, the autovacuum daemon maintains the visibility map continuously.
-- =============================================================================

-- ── 1. Rebuild procedure: unconditional startup reconcile ───────────────────
CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(IN p_mode text DEFAULT 'incremental'::text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
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

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer.
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object('mode', p_mode, 'source', 'pg_cron')
  )
  RETURNING id INTO v_log_id;

  -- ── Startup reconcile: heal a stranded autovacuum flag (FIX-885) ──────────
  -- Runs on EVERY invocation, both modes, before the mode-gated pause below.
  -- This is the crash-safe half of FIX-590/591: the pause is undone at the end
  -- of a successful run, but a run that dies hard (or a GHA break-glass run
  -- SIGKILLed at the 4h cap) leaves the flag off with nothing to restore it.
  -- The TS rebuild script has carried this reconcile since FIX-591, but FIX-688
  -- moved the schedule to pg_cron and left that script as manual break-glass —
  -- so the self-heal stopped running on prod entirely. That is how FIX-884
  -- happened: the 2026-06-28 GHA run was cancelled at the cap, and the flag sat
  -- off for ~4 weeks (9,505,759 dead tuples, all-visible 0.9%) because both
  -- pg_cron jobs are 'incremental' and every re-enable here was gated on v_full.
  --
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  --
  -- The predicate parses reloptions the way check_rebuild_autovacuum_status()
  -- does (split_part -> boolean, absent => default true) rather than matching a
  -- literal 'autovacuum_enabled=false', so the reconcile and the detector can
  -- never disagree about what "stranded" means.
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

  -- ── Full donations chunk — per-window COMMIT (FIX-703) ─────────────────────
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint on Micro
  -- (so the raised CALL-level budget never becomes an atomic multi-hour txn).
  -- Each window range-scopes its delete+insert, so a mid-run failure leaves
  -- un-processed windows' PRIOR edges intact (complete-if-stale, never missing).
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band (reconcile_recipient_count(), monthly post-VACUUM) and stays
  -- dirty-scoped in the incremental donations path.
  IF v_full THEN
    BEGIN
      PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('donations prepare: %s', SQLERRM);
      RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
    END;
    COMMIT;

    v_donations_total := 0;
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
        v_donations_total := v_donations_total + v_win;
        RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
      EXCEPTION WHEN OTHERS THEN
        -- Per-window catch: one bad window must not abort the rest; the run is
        -- reported `failed`. WHEN OTHERS catches a statement_timeout cancel too.
        v_failures := v_failures || format('donations window %s [%s..%s): %s',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
        RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
      END;
      -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction — PL/pgSQL
      -- forbids COMMIT inside one).
      COMMIT;
    END LOOP;

    v_total := v_total + v_donations_total;
    RAISE NOTICE '  [chunk] donations (windowed) — complete (% edges)', v_donations_total;
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
      EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
        INTO v_n;
      v_total := v_total + v_n;
      RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;
    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    COMMIT;
  END LOOP;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

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

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

-- ── 2. Detector: add visibility-map reporting ────────────────────────────────
-- Base is the LIVE FIX-650 body (pg_get_functiondef, local 2026-07-25); the
-- toggled/state CTEs and the tables/stranded keys are byte-for-byte unchanged.
-- Added: relallvisible/relpages/pct in state, the vm + vm_degraded keys, and a
-- second rebuild_active predicate for the pg_cron path.
CREATE OR REPLACE FUNCTION public.check_rebuild_autovacuum_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  WITH toggled(relname) AS (
    -- The set of tables the entity_connections rebuild toggles autovacuum on.
    -- Add a row here if a future rebuild path pauses autovacuum on another table.
    VALUES ('entity_connections')
  ),
  state AS (
    SELECT
      t.relname,
      -- reloptions only carries 'autovacuum_enabled=false' when EXPLICITLY set;
      -- absent => the default (true). Parse it out, defaulting to true.
      COALESCE(
        (SELECT (split_part(opt, '=', 2))::boolean
           FROM unnest(c.reloptions) AS opt
          WHERE opt LIKE 'autovacuum_enabled=%'),
        true
      ) AS autovacuum_enabled,
      -- FIX-885 — the signal that actually predicts query plans. With an empty
      -- visibility map every "Index Only Scan" does a per-row heap fetch, so a
      -- covering index silently stops being one (FIX-497 / FIX-883 on prod).
      c.relallvisible,
      c.relpages,
      CASE WHEN c.relpages > 0
           THEN round(100.0 * c.relallvisible / c.relpages, 1)
           ELSE 100.0 END AS pct_all_visible
    FROM toggled t
    JOIN pg_class c     ON c.relname = t.relname
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  )
  SELECT jsonb_build_object(
    'tables', COALESCE(
      jsonb_agg(jsonb_build_object(
        'relname',            s.relname,
        'autovacuum_enabled', s.autovacuum_enabled
      ) ORDER BY s.relname),
      '[]'::jsonb
    ),
    -- A full rebuild legitimately holds autovacuum off while running; don't flag
    -- that as stranded. The TS rebuild tags its backend application_name
    -- (FIX-591). FIX-885 — the pg_cron path (FIX-687/688, now the only scheduled
    -- one) runs as a plain CALL with no such tag, so match its statement too;
    -- otherwise an in-flight full rebuild would read as stranded.
    'rebuild_active', EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE state <> 'idle'
        AND (application_name LIKE 'entity_connections_rebuild%'
             OR query ILIKE '%run_entity_connections_rebuild%')
    ),
    'stranded', COALESCE(
      jsonb_agg(s.relname ORDER BY s.relname) FILTER (WHERE NOT s.autovacuum_enabled),
      '[]'::jsonb
    ),
    -- FIX-885 — per-table visibility-map health, always reported so the canary
    -- meta row carries the number even when nothing is wrong.
    'vm', COALESCE(
      jsonb_agg(jsonb_build_object(
        'relname',         s.relname,
        'relallvisible',   s.relallvisible,
        'relpages',        s.relpages,
        'pct_all_visible', s.pct_all_visible
      ) ORDER BY s.relname),
      '[]'::jsonb
    ),
    -- FIX-885 — tables whose visibility map has collapsed far enough that
    -- index-only scans are effectively dead. Threshold is deliberately loose
    -- (50%) so a legitimate post-rebuild dip never pages anyone; the failure
    -- this exists to catch measured 0.9%. relpages guard skips small tables
    -- where the ratio is noise.
    'vm_degraded', COALESCE(
      jsonb_agg(s.relname ORDER BY s.relname)
        FILTER (WHERE s.relpages > 1000 AND s.pct_all_visible < 50.0),
      '[]'::jsonb
    )
  )
  FROM state s;
$fn$;

COMMENT ON FUNCTION public.check_rebuild_autovacuum_status() IS
  'FIX-650/FIX-885 — read-only: rebuild-toggled tables stranded at '
  'autovacuum_enabled=false (excluding an in-flight rebuild), PLUS visibility-map '
  'health (vm/vm_degraded). Consumed by the daily sync canary, which exits '
  'non-zero on a non-empty stranded[] or vm_degraded[] (FIX-885).';

-- CREATE OR REPLACE preserves grants; re-assert the FIX-650/834 posture anyway.
REVOKE ALL ON FUNCTION public.check_rebuild_autovacuum_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rebuild_autovacuum_status() TO service_role;

NOTIFY pgrst, 'reload schema';
