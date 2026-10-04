-- =============================================================================
-- FIX-1145 — official_homepage_stats_mv reads the two rollups instead of
--            scanning financial_relationships, and donor_rollup_rebuild_bulk
--            (jobid 24) refreshes it at the end of a run that moved the
--            donor-rollup watermark. Rec (iii) of cc-188, D3's body (cc-195).
--
-- -- The cost this removes ----------------------------------------------------
-- The 20260902120000 (FIX-1134) body's `fr` CTE reads every to_type='official'
-- row of financial_relationships with no to_id predicate: a Parallel Seq Scan
-- of the whole heap, 442,306 buffers on the prod-scale clone. On prod it is the
-- 06:00 stack's worst single reader: unit 4 of refresh_derived_mvs, p50 48.4 s
-- / max 58.3 s over 30 dailies (2026-09-04 .. 10-03), and 43.4-56.8 s over the
-- last eight (cc-195 read 3).
--
-- Three of the MV's four columns already exist as rollups (cc-186 R5; cc-195
-- read 3 on prod 2026-10-04 20:14 UTC, 39,037 / 39,037 officials each):
--     total_donations_cents = official_donor_totals.total_cents
--     donor_count           = official_donor_totals.donor_count
--     vote_count            = official_vote_stats.total_votes
-- Reading them costs 1,743 buffers / 58 ms on the clone.
--
-- The fourth, financial_relationship_count (every relationship type, not only
-- donations), has ZERO readers: grep across apps/ packages/ supabase/ finds it
-- only in the two migrations that defined it and database.ts. It is DROPPED.
-- Readers of the MV: apps/civitics/app/page.tsx, officials/components/
-- OfficialCard.tsx and api/officials/[id]/summary/route.ts, all reading only
-- vote_count / donor_count / total_donations_cents.
--
-- Semantic note, for the next person. official_donor_totals is built from
-- _drb_donor, which filters fr.from_type = 'financial_entity', and its
-- donor_count is SUM(tx_count): the number of donation ROWS (donor-and-cycle
-- pairs), the same thing the old COUNT(*) FILTER (donation) counted. The old
-- MV counted every to_type='official' donation row regardless of from_type.
-- The two are equal today for every official. They diverge only if a
-- non-financial_entity donor type ever lands donation rows on an official.
--
-- -- Why jobid 24 refreshes it (cc-188's stop) -------------------------------
-- official_donor_totals is written ONLY by jobid 24 (donor-rollup-refresh,
-- 0 9,12 * * *), and its watermark moves only on drop nights. Read at 06:00 by
-- unit 4 alone, the MV would carry the previous 12:00's rollup and lag every
-- drop by about a day more than today's FR-scan body does. So the procedure
-- refreshes the MV CONCURRENTLY right after its success tail's COMMIT. That is
-- the one point reached only by a run that wrote the watermark. The caught-up
-- exit RETURNs before any work. The canceled / failed / backoff / budget closes
-- each RETURN before the watermark write. A resumed sweep reaches the tail only
-- when its last chunk is done, and that sweep's target cleared the caught-up
-- check when it was staged. Net: the MV lags the rollup by minutes, not a day.
--
-- The refresh is advisory, after the last COMMIT, in the CALL's own trailing
-- transaction. It follows the run_entity_connections_rebuild precedent
-- (20260703 fix703:361-371). FIX-704 removed THAT refresh because the full-set
-- official_donor_rollup_mv OOM'd the Micro box. This MV is 39k rows built from
-- two PK-keyed rollups (~1.7k buffers), which is not that case. A failure is a
-- WARNING plus homepage_mv_refreshed=false on the run's log row, never a failed
-- run. query_canceled is caught by name with OTHERS, because WHEN OTHERS alone
-- does not catch it and the receipt must not read a cancel as "no refresh
-- attempted". lock_timeout bounds a wait on a concurrent refresh of the same MV
-- (unit 4, a remediation tail). The receipt key: data_sync_log.metadata
-- ->'homepage_mv_refreshed' on the donor_rollup_refresh row. The key is absent
-- on every path that did not move the watermark.
--
-- Unit 4 of refresh_derived_mvs STAYS (D3). It now costs seconds, and it also
-- picks up official_vote_stats' 03:30 rebuild. refresh_official_homepage_
-- stats_mv() stays too. Both resolve the MV by name at run time, so neither is
-- touched.
--
-- -- donor_rollup_rebuild_bulk: what changed ---------------------------------
-- The body below is 20261003030000 (FIX-1194 P1-A) lines 261-977 byte for byte,
-- which equals prod's pg_get_functiondef as read 2026-10-04 20:12 UTC (0
-- differing lines), PLUS the hook between the FIX-1145 markers before the final
-- pg_advisory_unlock. Diff against that body: +N / -0, N = the hook's lines.
-- There is still no proconfig, so it may still COMMIT (FIX-1128). Grants are
-- restated (REVOKE ... anon, authenticated; GRANT service_role).
--
-- -- The swap (the FIX-1032 recipe, 20260902120000's shape) -------------------
-- The twin is built WITH DATA here, because the populate reads two rollups and
-- takes seconds, not one FR scan. Then come its pk index and the grants
-- (Supabase default privileges re-establish the ACL at CREATE; the grant is
-- belt-and-braces). The atomic DROP + RENAME + index rename follows, after a
-- pre-swap equivalence check on the three kept columns. Prod precondition
-- (read 2026-10-04): the MV has exactly one non-type dependent, its own index,
-- and no COMMENT. Its owner is postgres, and the two rollups are owned by
-- postgres with FORCE ROW LEVEL SECURITY off, so the owner-run REFRESH reads
-- them whole. Their RLS keeps anon out of the rollups, not out of this MV.
--
-- No bulk rewrite of any table: no VACUUM tail is owed (FIX-943).
-- =============================================================================

SET statement_timeout = '10min';


-- -- Steps 1-4: build the populated twin from the rollups ----------------------
DO $swap_build$
BEGIN
  IF to_regclass('public.official_homepage_stats_mv') IS NULL THEN
    RAISE NOTICE 'FIX-1145: official_homepage_stats_mv absent - nothing to swap.';
    RETURN;
  END IF;

  -- Already carrying the rollup body -> this migration has run. No-op.
  IF pg_get_viewdef('public.official_homepage_stats_mv'::regclass) NOT LIKE '%financial_relationships%' THEN
    RAISE NOTICE 'FIX-1145: official_homepage_stats_mv already reads the rollups - skipping.';
    RETURN;
  END IF;

  IF to_regclass('public.official_homepage_stats_mv_new') IS NOT NULL THEN
    IF pg_get_viewdef('public.official_homepage_stats_mv_new'::regclass) LIKE '%financial_relationships%' THEN
      RAISE EXCEPTION
        'FIX-1145: a stale official_homepage_stats_mv_new (an FR-scan body) is in the way - '
        'DROP MATERIALIZED VIEW public.official_homepage_stats_mv_new and re-run.';
    END IF;
    RAISE NOTICE 'FIX-1145: _new already exists with the rollup body (resumed run) - reusing it.';
    RETURN;
  END IF;

  CREATE MATERIALIZED VIEW public.official_homepage_stats_mv_new AS
  SELECT
    o.id                               AS official_id,
    COALESCE(vs.total_votes, 0)::BIGINT AS vote_count,
    COALESCE(dt.donor_count, 0)::BIGINT AS donor_count,
    COALESCE(dt.total_cents, 0)::BIGINT AS total_donations_cents,
    NOW()                              AS refreshed_at
  FROM public.officials o
  LEFT JOIN public.official_vote_stats   vs ON vs.official_id = o.id
  LEFT JOIN public.official_donor_totals dt ON dt.official_id = o.id
  WITH DATA;

  CREATE UNIQUE INDEX official_homepage_stats_mv_new_pk
    ON public.official_homepage_stats_mv_new (official_id);

  GRANT SELECT ON public.official_homepage_stats_mv_new
    TO anon, authenticated, service_role;

  RAISE NOTICE 'FIX-1145: _new created and populated from the rollups.';
END
$swap_build$;


-- -- Step 5: the swap. One statement; ACCESS EXCLUSIVE for milliseconds. -------
DO $swap_cutover$
DECLARE
  v_old_rows  BIGINT;
  v_new_rows  BIGINT;
  v_old_only  BIGINT;
  v_new_only  BIGINT;
  v_differing BIGINT;
  v_bound     BIGINT;
BEGIN
  IF to_regclass('public.official_homepage_stats_mv_new') IS NULL
     OR to_regclass('public.official_homepage_stats_mv') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_old_rows FROM public.official_homepage_stats_mv;
  SELECT count(*) INTO v_new_rows FROM public.official_homepage_stats_mv_new;

  -- Officials present on one side only are cohort drift since the old side's
  -- last refresh (officials inserted or merged away), not disagreement.
  SELECT count(*) FILTER (WHERE n.official_id IS NULL),
         count(*) FILTER (WHERE o.official_id IS NULL),
         count(*) FILTER (WHERE o.official_id IS NOT NULL AND n.official_id IS NOT NULL
                            AND (o.vote_count, o.donor_count, o.total_donations_cents)
                                IS DISTINCT FROM
                                (n.vote_count, n.donor_count, n.total_donations_cents))
    INTO v_old_only, v_new_only, v_differing
  FROM public.official_homepage_stats_mv o
  FULL JOIN public.official_homepage_stats_mv_new n USING (official_id);

  -- Any value delta on a shared official is STALENESS between the old side's
  -- last refresh (FR at 06:00) and the rollups now (jobid 24's last success),
  -- not a structural break. Prod read 2026-10-04 20:14 UTC: 0 of 39,037. The
  -- exactness proof is the clone check, both bodies in one snapshot; here we
  -- only catch a broken definition, so the bound is generous.
  v_bound := GREATEST(100, (v_old_rows * 5) / 100);

  RAISE NOTICE 'FIX-1145 pre-swap: old=% rows, new=% rows, old-only=%, new-only=%, differing=% (bound %)',
    v_old_rows, v_new_rows, v_old_only, v_new_only, v_differing, v_bound;

  IF v_differing > v_bound THEN
    RAISE EXCEPTION
      'FIX-1145: % of % shared officials differ between the FR-scan MV and the rollup twin - '
      'past the %-row staleness bound. Refusing the swap; _new is left in place for '
      'inspection (DROP MATERIALIZED VIEW public.official_homepage_stats_mv_new to retry).',
      v_differing, v_old_rows, v_bound;
  END IF;

  DROP MATERIALIZED VIEW public.official_homepage_stats_mv;

  ALTER MATERIALIZED VIEW public.official_homepage_stats_mv_new
    RENAME TO official_homepage_stats_mv;

  ALTER INDEX public.official_homepage_stats_mv_new_pk
    RENAME TO official_homepage_stats_mv_pk;

  RAISE NOTICE 'FIX-1145: swap complete.';
END
$swap_cutover$;


-- ═══════════════════════════════════════════════════════════════════════════
-- donor_rollup_rebuild_bulk() — FIX-1194 P1-A body + the FIX-1145 refresh hook
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_state_key  text   := 'donor_rollup_bulk_sweep';
  c_global     uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks     int    := 32;      -- must divide 256 (uuid first-byte ranges)
  -- FIX-973 - the SCHEDULED budget, sized the FIX-1002 way. Was 4h30m, which
  -- was right for a hand-driven break-glass run and wrong for jobid 24: two
  -- firings 3 h apart mean a 4h30m run is still inside itself when the second
  -- starts, and pg_cron QUEUES rather than skips. 2 h is the same bound the
  -- per-recipient path carried; the measured full sweep is 926 s.
  -- Overridable via civitics.donor_rollup_bulk_budget_seconds (break-glass).
  c_budget     interval := interval '2 hours';
  c_max_sweep  interval := interval '48 hours';

  -- FIX-973 - the log pipeline. The registry, the canary and
  -- check_rollup_freshness all judge `donor_rollup_refresh`; routing jobid 24
  -- here must not move the freshness clock to a new name, so the REGIME is
  -- metadata and the PIPELINE stays put. 'donor_rollup_bulk' survives as
  -- metadata.regime so the two histories stay separable after the fact.
  c_pipeline   text   := 'donor_rollup_refresh';

  -- FIX-973 - carried over from refresh_official_donor_rollup_incremental().
  -- The 12:00 backstop exists for a starved 09:00 launch; it must not open a
  -- second window into active hours. Same two GUCs as the incremental so the
  -- refusal stays testable without a wall clock.
  c_latest_hour int := 13;

  -- FIX-973 - cold seed for the predictive budget guard, so it is ARMED BEFORE
  -- CHUNK 0 rather than only after one chunk has completed. Without a seed
  -- `v_max_chunk > 0` is false on the first iteration and the guard cannot
  -- refuse a first chunk - which is exactly the window a slow pre-loop staging
  -- build opens. 600 s is ~10x the worst chunk ever measured (59 s, the 08-07
  -- full sweep). Overridable via civitics.donor_rollup_bulk_chunk_seed_seconds,
  -- which is also how the refusal is exercised in test.
  c_seed_chunk double precision := 600.0;

  v_state      jsonb;
  v_cursor     int;
  v_mode       text;
  v_resumed    boolean := false;
  v_restarted  text    := NULL;
  v_sweep_beg  timestamptz;
  v_sweep_tgt  timestamptz;
  v_horizon    timestamptz;   -- FIX-983
  v_watermark  timestamptz;
  v_log_id     uuid;
  v_cfg        int;
  v_cfg_txt    text;
  v_step       int;
  v_ignore_win boolean;
  v_hour_cfg   int;
  v_seed_cfg   double precision;
  v_seed_ref   double precision;
  v_guard_ref  double precision;
  v_prev_slow  int := 0;
  v_resume_at  int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- This is the manual break-glass bulk path, so the axe here is normally an
  -- operator cancel or the 6h role default rather than a cron budget — the
  -- stranding is identical either way.
  v_canceled   text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_n_targets  int := 0;
  v_n_offic    int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_done       int := 0;
  -- FIX-1194 P1-A — the start gate's answer, each chunk boundary's reading,
  -- and the reading that stopped the loop (NULL = the box did not stop it).
  v_gate       jsonb;
  v_sat        jsonb;
  v_backoff    jsonb := NULL;
  k            int;
BEGIN
  -- Start-window refusal (FIX-1002, carried to the bulk regime by FIX-973).
  -- BEFORE the advisory lock, so a firing pg_cron queued behind an overrunning
  -- run exits immediately instead of waiting on a lock it would then hold for
  -- another full budget.
  v_ignore_win := COALESCE(
    NULLIF(current_setting('civitics.donor_rollup_ignore_start_window', true), '')::boolean,
    false);
  v_hour_cfg := NULLIF(current_setting('civitics.donor_rollup_latest_start_hour', true), '')::int;
  IF v_hour_cfg IS NOT NULL THEN
    c_latest_hour := GREATEST(0, LEAST(v_hour_cfg, 24));
  END IF;
  IF NOT v_ignore_win
     AND EXTRACT(hour FROM (clock_timestamp() AT TIME ZONE 'UTC')) >= c_latest_hour THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'regime', 'bulk',
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup bulk] start window closed (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;

  -- FIX-1194 P1-A — the START gate: wait up to 600 s for a box that is neither
  -- stale nor failing forks (D2 — the watchdog wall is not an input). After the
  -- start-window refusal, so a queued firing past the cutoff still exits at
  -- once; BEFORE the lock, so a waiting firing holds nothing. A wait that
  -- crosses the cutoff hands the decision back to the start-window refusal.
  v_gate := public.box_backoff_gate('donor-rollup-refresh', 600);
  IF (v_gate->>'waited_s')::int > 0 AND NOT v_ignore_win
     AND EXTRACT(hour FROM (clock_timestamp() AT TIME ZONE 'UTC')) >= c_latest_hour THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'regime', 'bulk',
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron',
              'gate', v_gate));
    RAISE NOTICE '[donor-rollup bulk] start window closed during the box gate''s wait (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;
  IF NOT (v_gate->>'clear')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'regime', 'bulk',
              'skip_reason', format('box saturated after %s s: %s', v_gate->>'waited_s', v_gate->>'reason'),
              'source', 'pg_cron',
              'gate', v_gate));
    RAISE NOTICE '[donor-rollup bulk] box saturated (%) after % s — skipping (FIX-1194)',
      v_gate->>'reason', v_gate->>'waited_s';
    RETURN;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('regime', 'bulk', 'source', 'pg_cron', 'skip_reason',
              'advisory lock held by a concurrent donor-rollup refresh (incremental or bulk)'));
    RAISE NOTICE '[donor-rollup bulk] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-rollup bulk] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '256MB';

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_budget_seconds', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_cfg);
  END IF;

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunks', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    IF v_cfg NOT IN (16, 32, 64, 128, 256) THEN
      PERFORM pg_advisory_unlock(c_lock_key);
      RAISE EXCEPTION 'civitics.donor_rollup_bulk_chunks must be one of 16/32/64/128/256 (got %)', v_cfg;
    END IF;
    c_chunks := v_cfg;
  END IF;
  v_step := 256 / c_chunks;

  v_cfg_txt := NULLIF(current_setting('civitics.donor_rollup_bulk_mode', true), '');
  v_mode := COALESCE(v_cfg_txt, 'dirty');
  IF v_mode NOT IN ('dirty', 'full') THEN
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE EXCEPTION 'civitics.donor_rollup_bulk_mode must be ''dirty'' or ''full'' (got %)', v_mode;
  END IF;

  v_seed_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunk_seed_seconds', true), '')::double precision;
  IF COALESCE(v_seed_cfg, 0) > 0 THEN
    c_seed_chunk := v_seed_cfg;
  END IF;

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);

  -- FIX-973 — arm the guard from chunk 0. `v_max_chunk` stays a pure
  -- MEASUREMENT (it is what gets logged and persisted); the guard consults
  -- v_seed_ref instead, until this run has actually completed a chunk.
  --
  -- The 0.75 cap is what keeps the seed from becoming a wedge: 1.25 x 0.75 is
  -- under 1, so a run that arrives at the loop having spent none of its budget
  -- CANNOT be refused by the seed alone, however bad the previous sweep's worst
  -- chunk was. What the seed CAN refuse is a run that reaches the loop having
  -- already burned the budget in the pre-loop staging build — the FIX-1018
  -- shape, and the only case a chunk-0 guard exists for.
  v_prev_slow := COALESCE((v_state->>'slowest_chunk_seconds')::int, 0);
  v_seed_ref  := LEAST(
    GREATEST(v_prev_slow::double precision, c_seed_chunk),
    EXTRACT(epoch FROM c_budget) * 0.75);
  v_sweep_beg := (v_state->>'sweep_started_at')::timestamptz;
  v_sweep_tgt := (v_state->>'sweep_target')::timestamptz;

  IF v_cursor >= 0 THEN
    v_resumed := true;
    IF (v_state->>'mode') IS DISTINCT FROM v_mode THEN
      v_restarted := format('mode changed %s -> %s', v_state->>'mode', v_mode);
    ELSIF COALESCE((v_state->>'chunks')::int, -1) <> c_chunks THEN
      v_restarted := format('chunk count changed %s -> %s', v_state->>'chunks', c_chunks);
    ELSIF v_sweep_beg IS NULL OR clock_timestamp() - v_sweep_beg > c_max_sweep THEN
      v_restarted := format('sweep started %s exceeds the %s staleness bound', v_sweep_beg, c_max_sweep);
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_targets LIMIT 1) THEN
      v_restarted := 'target staging empty (crash recovery truncates UNLOGGED tables)';
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_fe LIMIT 1) THEN
      v_restarted := 'donor-dimension staging empty (crash recovery truncates UNLOGGED tables)';
    END IF;
    IF v_restarted IS NOT NULL THEN
      RAISE NOTICE '[donor-rollup bulk] discarding in-flight sweep: %', v_restarted;
      v_cursor  := -1;
      v_resumed := false;
    END IF;
  END IF;

  IF v_cursor < 0 THEN
    SELECT MAX(fr.updated_at) INTO v_sweep_tgt
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

    -- FIX-983 — the head-lag horizon, then the never-go-backwards floor.
    v_horizon   := public.fr_watermark_horizon();
    v_sweep_tgt := LEAST(COALESCE(v_sweep_tgt, v_horizon), v_horizon);

    -- Caught-up refusal (FIX-973; invariant (c) as an EXIT rather than a
    -- no-op sweep). The GREATEST clamp below still guarantees the watermark
    -- can never move backwards, but on the SCHEDULED path a caught-up firing
    -- must not pay for the staging build to discover it has nothing to do:
    -- `_drb_fe` is a full pass over financial_entities (5.2M rows / 1.9 GB
    -- heap on prod today) joined to entity_tags, and jobid 24 fires twice a
    -- day. The per-recipient path exits a caught-up run in ~0.1 s; this makes
    -- the bulk path do the same.
    -- Logged 'complete', not 'skipped' — FIX-1140: freshness counts ONLY
    -- status='complete', so a caught-up run that logs 'skipped' freezes the
    -- clock and the canary pages on a pipeline that is working perfectly.
    IF v_watermark IS NOT NULL AND v_sweep_tgt <= v_watermark THEN
      INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
      VALUES (c_pipeline, 'complete', v_started, clock_timestamp(),
              jsonb_build_object(
                'regime', 'bulk', 'mode', v_mode, 'chunks', c_chunks,
                'source', 'pg_cron', 'resumed', false,
                'targets', 0, 'target_officials', 0, 'recipients_done', 0,
                'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                'skip_reason', format('caught up at the FIX-983 horizon — %s is at or before the watermark %s',
                                      v_sweep_tgt, v_watermark),
                'horizon', v_sweep_tgt, 'watermark', v_watermark));
      RAISE NOTICE '[donor-rollup bulk] caught up at the horizon (% <= %) — nothing to do', v_sweep_tgt, v_watermark;
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;

    v_sweep_tgt := GREATEST(v_sweep_tgt, v_watermark);

    -- FIX-974 follow-up: assert the from_type invariant BEFORE anything is
    -- written, so a violating sweep publishes nothing at all. Placed after the
    -- caught-up exit above, because a run that writes nothing needs no guard
    -- and the assert anti-joins all six arms.
    PERFORM public.donor_rollup_bulk_assert_invariants();

    TRUNCATE public._drb_targets;
    IF v_mode = 'full' OR v_watermark IS NULL THEN
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    ELSE
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
          AND fr.updated_at >  v_watermark
          AND fr.updated_at <= v_sweep_tgt                             -- FIX-983
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    END IF;

    TRUNCATE public._drb_fe;
    INSERT INTO public._drb_fe (id, display_name, entity_type, state, industry_tag, industry_label)
    SELECT fe.id, fe.display_name, fe.entity_type, fe.metadata->>'state',
           t.tag, t.display_label
    FROM public.financial_entities fe
    LEFT JOIN (
      -- FIX-918: the donor's primary industry, from its one home.
      SELECT pit.entity_id, pit.tag, pit.display_label
      FROM public.primary_industry_tag(NULL) pit
    ) t ON t.entity_id = fe.id;

    ANALYZE public._drb_targets;
    ANALYZE public._drb_fe;

    v_sweep_beg := clock_timestamp();   -- FIX-981: the instant, not the txn start
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks,
              'slowest_chunk_seconds', v_prev_slow))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks,
              'slowest_chunk_seconds', v_prev_slow),
          updated_at = clock_timestamp();
  END IF;

  SELECT count(*), count(*) FILTER (WHERE is_official) INTO v_n_targets, v_n_offic
  FROM public._drb_targets;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (c_pipeline, 'running', v_started,
          jsonb_build_object(
            'regime', 'bulk', 'source', 'pg_cron',
            'shape', 'to_id-range chunks, one FR scan per chunk, six arms derived',
            'mode', v_mode, 'chunks', c_chunks,
            'targets', v_n_targets, 'target_officials', v_n_offic,
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'sweep_target', v_sweep_tgt,
            'budget_seconds', EXTRACT(epoch FROM c_budget))
          -- FIX-1194 P1-A — only when the start gate actually waited.
          || CASE WHEN (v_gate->>'waited_s')::int > 0
                  THEN jsonb_build_object('gate', v_gate) ELSE '{}'::jsonb END)
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    -- Before any chunk has completed THIS run, size on the seed; after that, on
    -- what this run has actually measured.
    v_guard_ref := CASE WHEN v_done > 0 THEN v_max_chunk ELSE v_seed_ref END;
    IF v_guard_ref > 0
       AND v_elapsed + (v_guard_ref * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[donor-rollup bulk] budget guard — stopping before chunk % (elapsed %s, reference %s, sized from %)',
        k, round(v_elapsed)::int, round(v_guard_ref)::int,
        CASE WHEN v_done > 0 THEN 'this run' ELSE 'seed' END;
      EXIT;
    END IF;

    -- FIX-1194 P1-A — back off at the chunk boundary on a stale probe or
    -- failing forks (D2). The cursor is committed with every chunk, so the
    -- next firing resumes at exactly this k.
    v_sat := public.box_is_saturated(p_include_watchdog_wall := false);
    IF (v_sat->>'saturated')::boolean THEN
      v_backoff := v_sat;
      RAISE NOTICE '[donor-rollup bulk] box saturated (%) — backing off before chunk %', v_sat->>'reason', k;
      EXIT;
    END IF;

    v_lo := (lpad(to_hex(k * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid;
    v_hi := CASE WHEN k < c_chunks - 1
                 THEN (lpad(to_hex((k + 1) * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid
                 ELSE NULL END;
    v_chunk_beg := clock_timestamp();

    BEGIN
      TRUNCATE public._drb_donor;
      INSERT INTO public._drb_donor
        (to_id, relationship_type, from_id, total_cents, total_cents0, tx_count,
         small_cents, small_count, pos_cents, pos_count)
      SELECT
        fr.to_id,
        fr.relationship_type::text,
        fr.from_id,
        SUM(fr.amount_cents)::bigint,
        SUM(COALESCE(fr.amount_cents, 0))::bigint,
        COUNT(*)::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0))::bigint
      FROM public.financial_relationships fr
      JOIN public._drb_targets t ON t.to_id = fr.to_id
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_id >= v_lo
        AND (v_hi IS NULL OR fr.to_id < v_hi)
      GROUP BY fr.to_id, fr.relationship_type, fr.from_id;

      TRUNCATE public._drb_chunk_fe;
      INSERT INTO public._drb_chunk_fe (id, display_name, entity_type, state, industry_tag, industry_label)
      SELECT f.id, f.display_name, f.entity_type, f.state, f.industry_tag, f.industry_label
      FROM public._drb_fe f
      WHERE f.id IN (SELECT DISTINCT d.from_id FROM public._drb_donor d);

      ANALYZE public._drb_donor;
      ANALYZE public._drb_chunk_fe;

      DELETE FROM public.official_donor_rollup_mv m
       WHERE m.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH ranked AS (
        SELECT d.to_id AS official_id, d.relationship_type, d.from_id AS donor_id,
               d.total_cents, d.tx_count,
               ROW_NUMBER() OVER (PARTITION BY d.to_id, d.relationship_type
                                  ORDER BY d.total_cents DESC, d.from_id) AS rn
        FROM public._drb_donor d
      ),
      top_rows AS (
        SELECT r.official_id, r.relationship_type, r.rn::int AS rank, r.donor_id,
               fe.display_name, fe.entity_type, fe.industry_tag, fe.industry_label,
               r.total_cents, r.tx_count, NULL::bigint AS tail_donor_count
        FROM ranked r
        LEFT JOIN public._drb_chunk_fe fe ON fe.id = r.donor_id
        WHERE r.rn <= 200
      ),
      tail_rows AS (
        SELECT r.official_id, r.relationship_type, 201 AS rank, NULL::uuid, NULL::text,
               NULL::text, NULL::text, NULL::text,
               SUM(r.total_cents)::bigint, SUM(r.tx_count)::bigint, COUNT(*)::bigint
        FROM ranked r WHERE r.rn > 200
        GROUP BY r.official_id, r.relationship_type
      ),
      ins AS (
        INSERT INTO public.official_donor_rollup_mv (
          official_id, relationship_type, rank, donor_id, donor_name, entity_type,
          industry_tag, industry_label, total_cents, tx_count, tail_donor_count)
        SELECT * FROM top_rows UNION ALL SELECT * FROM tail_rows
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_n FROM ins;
      v_rows := v_rows + v_n;

      DELETE FROM public.official_donor_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_donor_totals
        (official_id, total_cents, pac_cents, individual_cents, donor_count, updated_at)
      SELECT d.to_id,
             SUM(d.total_cents0)::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
             SUM(d.tx_count)::bigint,
             -- FIX-981: was the column DEFAULT now(), i.e. the START of this
             -- chunk's transaction, N COMMITs into the sweep.
             clock_timestamp()
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_small_dollar_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_small_dollar_rollup
        (official_id, small_dollar_cents, small_dollar_count, updated_at)
      SELECT d.to_id, SUM(d.small_cents)::bigint, SUM(d.small_count)::bigint, clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_sector_affinity_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_sector_affinity_rollup
        (official_id, industry, total_cents, donor_count, updated_at)
      SELECT d.to_id,
             COALESCE(fe.industry_tag, 'Untagged'),
             SUM(d.pos_cents)::bigint,
             COUNT(*)::bigint,
             clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
        AND d.pos_cents > 0
      GROUP BY d.to_id, COALESCE(fe.industry_tag, 'Untagged');

      DELETE FROM public.treemap_individuals_rollup x
       WHERE x.scope_id <> c_global
         AND x.scope_id IN (
           SELECT t.to_id FROM public._drb_targets t
            WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH per_name AS (
        SELECT d.to_id AS scope_id,
               COALESCE(fe.state, '??') AS state,
               fe.display_name          AS donor_name,
               SUM(d.pos_cents)::bigint AS total_cents,
               SUM(d.pos_count)::bigint AS donation_count
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
        GROUP BY d.to_id, COALESCE(fe.state, '??'), fe.display_name
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY scope_id, state
                                     ORDER BY total_cents DESC, donor_name) AS rank
        FROM per_name
      )
      INSERT INTO public.treemap_individuals_rollup
        (scope_id, state, rank, donor_name, total_cents, donation_count)
      SELECT scope_id, state, rank::int, donor_name, total_cents, donation_count
      FROM ranked WHERE rank <= 50;

      DELETE FROM public.official_donor_bracket_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH bucketed AS (
        SELECT d.to_id AS official_id, d.pos_cents AS donor_cents,
               CASE WHEN d.pos_cents >= 1000000 THEN 'mega'
                    WHEN d.pos_cents >=  250000 THEN 'major'
                    WHEN d.pos_cents >=   50000 THEN 'mid'
                    ELSE                              'small' END AS tier
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
      )
      INSERT INTO public.official_donor_bracket_totals (official_id, tier, total_cents, donor_count)
      SELECT official_id, tier, SUM(donor_cents)::bigint, COUNT(*)::bigint
      FROM bucketed GROUP BY official_id, tier;

      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object(
                       'chunk_cursor', k,
                       'slowest_chunk_seconds', GREATEST(round(v_max_chunk)::int, v_prev_slow)),
             updated_at = clock_timestamp()
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. The cursor is written INSIDE this chunk's
    -- transaction, so a cancelled chunk rolls back together with its cursor
    -- advance and the next CALL resumes at exactly k.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % CANCELED (statement_timeout or operator cancel): %', k, SQLERRM;
    WHEN OTHERS THEN
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_canceled IS NOT NULL;
    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;

    v_done := v_done + 1;
    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    RAISE NOTICE '[donor-rollup bulk] chunk %/% done (%s, % arm-1 rows so far)',
      k + 1, c_chunks, round(v_chunk_secs)::int, v_rows;
  END LOOP;

  -- FIX-1028 — cancelled is PARTIAL and RESUMABLE. The bulk path's watermark
  -- write is at the very end and stays there (this is the manual, re-runnable
  -- path — a re-CALL resumes from the committed cursor), but the ROW now closes
  -- itself instead of sitting 'running' until the reaper.
  -- FIX-973 — check_rollup_freshness now derives sweep_in_progress/sweep_cursor
  -- from THIS pipeline's own last row (it used to hard-wire a read of
  -- pipeline_state.donor_rollup_watermark, which the bulk regime never writes
  -- a cursor into). `resumable` + `resume_at_chunk` are that contract.
  SELECT COALESCE((value->>'chunk_cursor')::int + 1, 0) INTO v_resume_at
  FROM public.pipeline_state WHERE key = c_state_key;
  v_resume_at := COALESCE(v_resume_at, 0);

  IF v_canceled IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = left(format('canceled — %s; resumable at chunk %s of %s', v_canceled,
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks), 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'canceled', true, 'cancel_detail', v_canceled,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE WARNING '[donor-rollup bulk] CANCELED — partial, resumable; re-CALL to continue';
    RETURN;
  END IF;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- FIX-1194 P1-A — backed off on a saturated box: partial and resumable, in
  -- the budget close's shape, plus what the box read when it stopped the loop.
  IF v_backoff IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = format('box saturated (%s) — resumable at chunk %s of %s',
             v_backoff->>'reason', v_resume_at, c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'backoff_reason', v_backoff->>'reason',
             'backoff_readings', v_backoff->'readings',
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[donor-rollup bulk] PARTIAL — box saturated (%); resumable at chunk %', v_backoff->>'reason', v_resume_at;
    RETURN;
  END IF;

  IF v_budget_hit THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[donor-rollup bulk] PARTIAL — resumable; re-CALL to continue';
    RETURN;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text),
        updated_at = clock_timestamp();

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', clock_timestamp()::text,   -- FIX-981
                                    'mode', v_mode, 'chunks', c_chunks,
                                    'targets', v_n_targets,
                                    -- FIX-973: seeds the NEXT run's chunk-0 guard.
                                    'slowest_chunk_seconds', GREATEST(round(v_max_chunk)::int, v_prev_slow)),
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  TRUNCATE public._drb_donor;
  TRUNCATE public._drb_chunk_fe;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'chunks_done_this_run', v_done,
           'recipients_done', v_n_offic,
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
           'watermark_advanced_to', v_sweep_tgt)
   WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup bulk] complete — % targets, % arm-1 rows', v_n_targets, v_rows;
  COMMIT;
  -- >>> FIX-1145 — refresh the home-page MV now that official_donor_totals
  -- moved. Reached only here, after the success tail's COMMIT: the caught-up
  -- exit and the canceled / failed / backoff / budget closes all RETURN before
  -- the watermark write. Advisory, in the CALL's trailing transaction: a failure
  -- (a cancel included, which WHEN OTHERS alone does not catch) is a WARNING
  -- plus homepage_mv_refreshed=false on this run's log row, never a failed run.
  -- lock_timeout bounds a wait on a concurrent refresh of the same MV.
  BEGIN
    SET LOCAL lock_timeout = '60s';
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv;
    UPDATE public.data_sync_log
       SET metadata = metadata || jsonb_build_object('homepage_mv_refreshed', true)
     WHERE id = v_log_id;
    RAISE NOTICE '[donor-rollup bulk] refreshed official_homepage_stats_mv (FIX-1145)';
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    RAISE WARNING '[donor-rollup bulk] official_homepage_stats_mv refresh FAILED (advisory, FIX-1145): %', SQLERRM;
    UPDATE public.data_sync_log
       SET metadata = metadata || jsonb_build_object('homepage_mv_refreshed', false,
                                                     'homepage_mv_refresh_error', left(SQLERRM, 300))
     WHERE id = v_log_id;
  END;
  -- <<< FIX-1145
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.donor_rollup_rebuild_bulk() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.donor_rollup_rebuild_bulk() TO service_role;


RESET statement_timeout;

-- DOWN (not expected): re-run 20260902120000's CREATE MATERIALIZED VIEW body
-- through the same swap with the guard inverted, and re-run 20261003030000's
-- donor_rollup_rebuild_bulk definition (this file minus the FIX-1145 hook).
