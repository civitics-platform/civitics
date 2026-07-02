-- FIX-703 — make the pg_cron entity_connections FULL rebuild survive Micro's
-- 90min donations wall.
--
-- Symptom (prod one-shot CALL run_entity_connections_rebuild('full'),
-- 2026-07-01): the run survived 90 min with no 2-min death (FIX-697's
-- postgres-role statement_timeout=90min default works), then FAILED at exactly
-- start+90min inside rebuild_ec_donations_full_window with "canceling statement
-- due to statement timeout". The whole donations chunk (prepare + 16 windows +
-- finalize) ran as ONE transaction, so the 16 windows shared a single budget.
--
-- ── The mechanism, established empirically on PG17 (local, 2026-07-01) ────────
-- statement_timeout inside a CALLed PROCEDURE is armed ONCE, at CALL start, with
-- the value in effect at that instant (the role/cluster default). It is then
-- IMMUTABLE for the life of the CALL:
--   * a per-chunk / per-window COMMIT does NOT re-arm it (verified: a per-window-
--     COMMIT build still died at exactly the role-default budget);
--   * a `SET statement_timeout = ...` inside the procedure body does NOT re-arm
--     or disarm it (verified: even changing the value, or SET ...=0, had no
--     effect on the already-armed timer);
--   * the ONLY things that set the CALL's budget are (a) the role/cluster
--     default at CALL start, or (b) an explicit `SET statement_timeout` run as
--     its OWN top-level statement in the same session BEFORE the CALL (verified
--     via psql two-statement session). Note (b) is NOT usable from pg_cron for a
--     COMMIT-ing procedure — see the rejected-knobs list below.
-- So FIX-687's comment (and this FIX's original design) — "each window gets its
-- own fresh statement_timeout after a COMMIT" — is FALSE on this PG. FIX-697
-- did not give per-COMMIT fresh timers; it merely raised the single, global,
-- CALL-start budget from 2min to 90min. That 90min global budget is the wall.
--
-- Every other knob was tried and REJECTED (all verified on PG17 local):
--   * `SET statement_timeout` inside the procedure body — no-op on the timer.
--   * per-window / per-chunk COMMIT re-arming the timer — does not happen.
--   * function proconfig on the window fn — ignored when called inside the CALL.
--   * procedure proconfig (ALTER PROCEDURE … SET statement_timeout) — ignored;
--     proconfig is applied AFTER the timer is already armed at CALL start.
--   * a multi-statement pg_cron command `SET statement_timeout=…; CALL …` —
--     FAILS with "invalid transaction termination": pg_cron runs a multi-command
--     string in ONE implicit transaction, so the procedure's COMMIT is illegal.
-- The job must also run as a superuser/owner role (it does ALTER TABLE … SET
-- autovacuum on entity_connections, FIX-590), so a dedicated low-timeout cron
-- role is not an option either. That leaves exactly one working knob: the
-- role/cluster default that is in effect for the pg_cron `postgres` session at
-- CALL start.
--
-- ── The fix (two parts) ──────────────────────────────────────────────────────
-- 1. Per-window COMMIT in the procedure (this migration). NOT to beat the timer
--    (it can't), but to avoid an ATOMIC multi-hour donations transaction: with
--    the budget raised (part 2), a single-transaction donations chunk would pin
--    the xmin horizon, hold locks, and block vacuum for hours on Micro (the exact
--    hazard FIX-703 decision-3 names). Per-window COMMIT keeps each transaction
--    short, advances xmin between windows, and makes the rebuild resumable.
--    This is what keeps "raise the budget" from becoming "one giant transaction"
--    — decision-3's real concern is addressed by the COMMITs, not the cap.
-- 2. Raise the CALL-start budget: bump the `postgres` role default
--    statement_timeout from FIX-697's 90min to 6h (this is the value the pg_cron
--    session arms the CALL with). 6h is a generous backstop for a cache-starved
--    Micro (a clean full rebuild is well under it); combined with per-window
--    COMMIT it is NOT an atomic multi-hour transaction. The pg_cron command
--    stays a plain `CALL` (kept paused per FIX-697; the FIX-677 runbook
--    re-enables). Blast radius is the same as FIX-697's 90min: on prod the only
--    `postgres` sessions are pg_cron jobs, migrations, and Supavisor's pooler
--    tenant — never the request path (which runs as `authenticator`). The change
--    vs FIX-697 is only that a pathological hung migration now auto-dies at 6h
--    instead of 90min (migrations are supervised).
--
-- 3. No-gap: each window does a from_id-range-scoped DELETE+INSERT and commits,
--    so an un-processed window keeps its PRIOR edges (complete-if-stale, never
--    missing). prepare() no longer global-DELETEs (which, with per-window COMMIT,
--    would leave un-processed ranges missing between a mid-run failure and the
--    retry). The 16 windows cover the whole uuid space, so their union is a
--    complete rebuild. The scoped DELETE is backed by
--    entity_connections_from_id_connection_type (from_id, connection_type).
--
-- 4. Resilience: a window failure is caught per window (recorded in v_failures,
--    run continues, run reported `failed`); because the total budget is now 6h
--    (not the chunk-total wall) the wrap-up (autovacuum re-enable, MV refresh,
--    terminal data_sync_log UPDATE, advisory unlock) is always reached — no more
--    stranded `running` row / stranded autovacuum-off.
--
-- Scope: only the FULL donations path's transaction structure changes. The
-- incremental rebuild_entity_connections_donations() (its own dirty-set scoped
-- delete+insert + watermark) and the legacy monolith
-- rebuild_entity_connections_donations_full() are untouched. Function SIGNATURES
-- are unchanged, so no db:types regen. The TS interim path
-- (scripts/rebuild-entity-connections.ts) calls the same prepare/window/finalize
-- with autocommit-per-query, so it inherits the no-gap improvement for free.
--
-- ⚠ PR2 template note: MV-refresh procedures ported to pg_cron inherit this same
-- constraint. Do NOT rely on in-procedure SET, per-COMMIT re-arm, function/proc
-- proconfig, or a `SET …; CALL …` cron command to bound a long COMMIT-ing
-- pg_cron procedure's runtime — the ONLY working knob is the role default in
-- effect for the cron session at CALL start.

-- ── 1. prepare — watermark only (drop the global DELETE) ─────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_full_prepare()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- FIX-703: no global DELETE here anymore — each window range-scopes its own
  -- delete+insert so per-window COMMIT never leaves a gap. Keep only the
  -- non-destructive watermark advance (push it up front so a concurrent FR write
  -- during the multi-commit rebuild is caught by the next incremental).
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', NOW()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$$;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_prepare() TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_full_prepare() IS
  'FIX-588/FIX-703 — advance the donations incremental watermark before a full '
  'windowed rebuild. No longer deletes edges (FIX-703 moved the delete into each '
  'range-scoped window so per-window COMMIT never leaves a gap).';

-- ── 2. window — range-scoped DELETE + INSERT (self-contained, idempotent) ────
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_full_window(
  p_lo uuid,
  p_hi uuid
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_count bigint;
BEGIN
  -- FIX-703: range-scoped delete (was the global DELETE in prepare()). Backed by
  -- entity_connections_from_id_connection_type (from_id, connection_type).
  DELETE FROM public.entity_connections ec
   WHERE ec.connection_type = 'donation'
     AND ec.from_id >= p_lo
     AND (p_hi IS NULL OR ec.from_id < p_hi);

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support')
      AND fr.from_id >= p_lo
      AND (p_hi IS NULL OR fr.from_id < p_hi)
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
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
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  RETURN v_count;
END;
$$;
-- NOTE: this proconfig statement_timeout does NOT bound a call made from inside
-- the rebuild PROCEDURE (function proconfig cannot re-arm the CALL's timer — see
-- header). It only applies when the function is invoked as its own top-level
-- statement (e.g. the TS direct-pg path, one client statement per window).
ALTER FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid)
  SET statement_timeout = '45min';
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid) IS
  'FIX-588/FIX-703 — rebuild donation edges for from_id in [p_lo, p_hi) (p_hi '
  'NULL = to end). Self-contained range-scoped DELETE+INSERT so the caller can '
  'COMMIT after each window (FIX-703) without leaving a gap; idempotent.';

-- ── 3. procedure — per-window COMMIT (bounds txn size; budget is CALL-site) ───
CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(p_mode text DEFAULT 'incremental')
LANGUAGE plpgsql
AS $$
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
  -- default (raised to 6h in the section at the bottom of this migration). A
  -- `SET statement_timeout` here would be a no-op on the already-armed timer.
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object('mode', p_mode, 'source', 'pg_cron')
  )
  RETURNING id INTO v_log_id;

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

    BEGIN
      v_n := public.rebuild_ec_donations_full_finalize();
      RAISE NOTICE '  [donations] finalize — recipient_count updated for % individual donors', v_n;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('donations finalize: %s', SQLERRM);
      RAISE WARNING '  [donations] finalize FAILED: %', SQLERRM;
    END;
    COMMIT;

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

  -- ── Donor-rollup MV refresh (full only, post-COMMIT, CONCURRENTLY) ─────────
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

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;

COMMENT ON PROCEDURE public.run_entity_connections_rebuild(text) IS
  'FIX-687/FIX-703 — pg_cron entity_connections rebuild. Session advisory-lock '
  'guard, per-window/per-chunk COMMIT (external/investigation last), '
  'data_sync_log observability, donor-rollup MV refresh (full). FIX-703: the '
  'full-donations chunk COMMITs after EACH window with range-scoped delete+insert '
  '(no gap, xmin advances). The total-runtime budget is the postgres role default '
  '(6h, FIX-703) armed at CALL start — an in-procedure SET / COMMIT / proconfig '
  'cannot re-arm it on this PG. CALL with ''full'' (Mon) or ''incremental'' (Wed).';

GRANT EXECUTE ON PROCEDURE public.run_entity_connections_rebuild(text) TO service_role;

-- ── 4. Raise the CALL-start budget: postgres role default 90min → 6h ─────────
-- This is the value the pg_cron `postgres` session arms the CALL with (see
-- header — it is the only knob that works for a COMMIT-ing procedure launched by
-- pg_cron). Supersedes FIX-697's 90min. Same blast radius as FIX-697: on prod
-- the only `postgres` sessions are cron jobs, migrations, and the pooler tenant;
-- the request path runs as `authenticator`. Per-window COMMIT (above) keeps this
-- from becoming an atomic multi-hour transaction.
ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '6h';

-- Keep the cron command a PLAIN `CALL` (do NOT prefix `SET statement_timeout=…;`
-- — pg_cron wraps a multi-statement command in one implicit transaction and the
-- procedure's COMMIT then fails with "invalid transaction termination"). Reset
-- both jobs to the plain command in case an earlier experiment altered them,
-- preserving schedule + PAUSED state (FIX-697). No-op if the jobs don't exist
-- yet (FIX-688 creates them; this migration is ordered after it).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT jobid, jobname FROM cron.job
     WHERE jobname IN ('rebuild-ec-full', 'rebuild-ec-incremental')
  LOOP
    IF r.jobname = 'rebuild-ec-full' THEN
      PERFORM cron.alter_job(job_id := r.jobid,
        command := $cmd$CALL public.run_entity_connections_rebuild('full');$cmd$);
    ELSE
      PERFORM cron.alter_job(job_id := r.jobid,
        command := $cmd$CALL public.run_entity_connections_rebuild('incremental');$cmd$);
    END IF;
  END LOOP;
END $$;
