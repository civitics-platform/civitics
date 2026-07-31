-- =============================================================================
-- FIX-944 — Make the donor-rollup refresh resumable across a statement_timeout.
--
-- ── What was actually happening (measured on prod 2026-07-31) ────────────────
-- The FIX-944 bullet reads the failure as "runs for ~20 hours and is reaped by
-- the nightly". `cron.job_run_details` says otherwise, and the distinction is
-- the whole fix:
--
--   jobid 24 runid 105  2026-07-27 09:00 → 15:07  ERROR: canceling statement due to statement timeout
--   jobid 24 runid 116  2026-07-28 09:00 → 15:00  ERROR: canceling statement due to statement timeout
--   jobid 24 runid 123  2026-07-29 09:00 → 15:00  ERROR: canceling statement due to statement timeout
--   jobid 24 runid 129  2026-07-30 09:00 → 15:00  ERROR: canceling statement due to statement timeout
--
-- Every run dies at EXACTLY 6h00m. `pg_db_role_setting` carries
-- `postgres@postgres → statement_timeout=6h`, and that timeout is armed once at
-- CALL start and covers the ENTIRE procedure — the per-chunk COMMITs below do
-- NOT re-arm it. There is no 20h run: `reaped_orphan` is the nightly's
-- `reap_stale_sync_log()` cosmetically stamping `completed_at = NOW()` on a
-- data_sync_log row whose backend had already been dead for ~14 hours. The
-- reaper never killed anything; it only mislabelled the corpse.
--
-- ── Why it can never converge (the livelock) ─────────────────────────────────
-- 8,382 dirty recipients; a 6h window completes ~1,000 of them (measured:
-- 1,081 on 07-30, 824 on 07-29, counted off official_small_dollar_rollup /
-- official_donor_totals updated_at inside the 09:00–15:00 window). The chunk
-- work IS committed — but the watermark only advances on a fully clean run, so
-- the next run rebuilds the IDENTICAL dirty set from recipient #1, redoes the
-- same ~1,000, and dies again. Recipient #1,001 is never reached. That is why
-- `dirty_recipients` sat pinned at 8,382/8,383 for four days: not a stuck
-- watermark computation, a livelock.
--
-- ── Why a per-chunk statement_timeout is NOT part of this fix ────────────────
-- It is not implementable from inside a CALLed procedure. Measured locally:
--   * `SET statement_timeout='1s'` inside the proc body → a following
--     pg_sleep(3) SURVIVES. The inner SET does not re-arm the running timer.
--   * A function-level `SET statement_timeout='30s'` on the proc → does NOT
--     escape a caller-armed 2s timeout; the sleep is cancelled at 2s.
-- So the only in-proc guard that can actually fire is a between-chunk
-- wall-clock budget, and it must stop the loop BEFORE the 6h ceiling so the
-- run can persist its cursor and close its log row cleanly. The 6h role
-- setting remains the outer backstop.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- A resume cursor in pipeline_state, advanced inside each chunk's transaction:
--
--   {
--     "last_indexed_at": "...",   -- committed watermark (semantics unchanged)
--     "sweep_cursor":    "uuid",  -- last recipient processed, uuid order; absent = no sweep in flight
--     "sweep_target":    "...",   -- v_new_max captured at SWEEP start, not run start
--     "sweep_failures":  0        -- chunk failures accumulated across the whole sweep
--   }
--
-- The dirty set is `array_agg(DISTINCT to_id ORDER BY to_id)`, so it is
-- deterministic and `to_id > sweep_cursor` resumes exactly where the previous
-- run stopped. Progress is derivable purely from committed state — no
-- in-memory counter survives a cancel, and the cursor write shares the chunk's
-- transaction, so a cancelled run can never claim a chunk it did not finish.
--
-- `sweep_target` is captured ONCE at sweep start and reused by every resuming
-- run. This preserves the FIX-704 invariant the bullet asks to keep: FR rows
-- written mid-sweep are re-processed by the NEXT sweep, never silently
-- consumed. Recomputing MAX(updated_at) on each resuming run would consume
-- them.
--
-- Failure semantics are unchanged in effect: a failed chunk advances the cursor
-- (so the sweep still terminates) but increments `sweep_failures`, and
-- `last_indexed_at` advances only when a sweep finishes with zero failures.
-- A failed sweep therefore re-does the whole set next time, exactly as before.
--
-- ── Convergence ─────────────────────────────────────────────────────────────
-- At the measured ~1,000 recipients per 6h window, 8,382 recipients needs
-- ~50h of compute — about 9 nightly runs. Resumability makes that converge;
-- it does not make it fast. For an operator who wants it done in one pass, use
-- the break-glass sweep (packages/data/src/scripts/donor-rollup-sweep.ts),
-- which opens a direct connection, sets statement_timeout=0 for the session
-- BEFORE the CALL (the only place that ceiling can be lifted) and re-CALLs
-- until the proc reports `complete`.
--
-- Out of scope by design: nothing about WHAT donor_rollup_rebuild_recipients()
-- computes changes here. This is only about it finishing.
--
-- Cross-ref [[FIX-704]] [[FIX-832]] [[FIX-836]] [[FIX-776]] [[FIX-777]]
-- [[FIX-779]] [[FIX-868]] [[FIX-933]] [[FIX-943]] [[FIX-234]].
-- =============================================================================

-- ── Body based on prod's live pg_get_functiondef (md5
--    dc22edfb4d8dd0cc69f642c794180518, 4561 bytes, read 2026-07-31) so the
--    FIX-776/777/779/836/868 layering is preserved rather than reverted.
CREATE OR REPLACE PROCEDURE public.refresh_official_donor_rollup_incremental()
LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_chunk_size int    := 200;
  -- Wall-clock budget for ONE run. Must leave room under the 6h role-level
  -- statement_timeout for the slowest single chunk to finish plus the closing
  -- bookkeeping, because the budget can only be tested BETWEEN chunks.
  -- Overridable via pipeline_state key 'donor_rollup_run_budget'.
  c_budget     interval := interval '4 hours 30 minutes';
  v_state      jsonb;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_new_max    timestamptz;
  v_cursor     uuid;
  v_resumed    boolean := false;
  v_dirty      uuid[];
  v_chunk      uuid[];
  v_n_recips   int;
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  v_prior_fail int := 0;
  v_budget_cfg int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_elapsed    double precision;
BEGIN
  -- Session advisory lock (survives the COMMITs below); also excludes a
  -- concurrent compat-function refresh via the same rebuild helper being safe
  -- anyway (idempotent per recipient), this is mostly stampede protection.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Bounded per-chunk memory. Plain SET (not SET LOCAL) survives the per-chunk
  -- COMMITs. NOTE (FIX-703/FIX-944): the CALL's statement_timeout is the
  -- postgres role default (6h) armed at CALL start — nothing in this body can
  -- change it, which is exactly why the c_budget loop guard below exists.
  SET work_mem = '128MB';

  SELECT value INTO v_state
  FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

  v_watermark := (v_state->>'last_indexed_at')::timestamptz;
  v_cursor    := NULLIF(v_state->>'sweep_cursor', '')::uuid;

  -- Optional operator override for a manual off-hours catch-up, as a SESSION
  -- GUC rather than shared state:
  --     SET civitics.donor_rollup_budget_seconds = '72000';
  -- Deliberately session-scoped (FIX-944, and decision 6 of the FIX-944 brief):
  -- a shared pipeline_state override would have to be restored afterwards, and
  -- a run that died before restoring would silently re-widen every subsequent
  -- pg_cron run past the 6h ceiling. A GUC cannot strand — it dies with the
  -- connection. Used by data:donor-rollup:sweep, which also lifts
  -- statement_timeout for its own session.
  v_budget_cfg := NULLIF(current_setting('civitics.donor_rollup_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_budget_cfg);
  END IF;

  v_prior_fail := COALESCE((v_state->>'sweep_failures')::int, 0);

  IF v_cursor IS NOT NULL AND (v_state ? 'sweep_target') THEN
    -- RESUMING an interrupted sweep. Reuse the target captured at sweep start
    -- so mid-sweep FR writes stay for the NEXT sweep (FIX-704 invariant).
    v_resumed := true;
    v_new_max := (v_state->>'sweep_target')::timestamptz;
  ELSE
    -- Capture the new watermark BEFORE building the dirty set so FR writes that
    -- land mid-refresh are re-processed by the next run, never silently consumed.
    v_cursor     := NULL;
    v_prior_fail := 0;
    SELECT MAX(fr.updated_at) INTO v_new_max
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');
  END IF;

  -- ORDER BY is load-bearing: the cursor resumes on uuid order, so the dirty
  -- set must be built the same way on every resuming run.
  IF v_watermark IS NULL THEN
    -- Bootstrap: every recipient, same chunked loop.
    SELECT array_agg(DISTINCT fr.to_id ORDER BY fr.to_id) INTO v_dirty
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
      AND fr.from_type = 'financial_entity'
      AND (v_cursor IS NULL OR fr.to_id > v_cursor);
  ELSE
    SELECT array_agg(DISTINCT fr.to_id ORDER BY fr.to_id) INTO v_dirty
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
      AND fr.from_type = 'financial_entity'
      AND fr.updated_at > v_watermark
      AND (v_cursor IS NULL OR fr.to_id > v_cursor);
  END IF;

  v_n_recips := COALESCE(array_length(v_dirty, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_refresh', 'running', now(),
          jsonb_build_object(
            'mode', CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END,
            'dirty_recipients', v_n_recips,
            'resumed', v_resumed,
            'resume_cursor', v_cursor,
            'sweep_failures_before', v_prior_fail,
            'budget_seconds', EXTRACT(epoch FROM c_budget),
            'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  WHILE v_i <= v_n_recips LOOP
    -- PREDICTIVE budget check. Testing `elapsed > budget` alone is useless when
    -- a single chunk costs ~60min against a 6h ceiling — the overshoot IS the
    -- failure. Stop when the SLOWEST chunk observed so far (plus 25% headroom)
    -- would not fit in what remains.
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_chunk_no > 0
       AND v_elapsed + (v_max_chunk * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[donor-rollup] budget guard — stopping before chunk % (elapsed %s, slowest chunk %s)',
        v_chunk_no + 1, round(v_elapsed)::int, round(v_max_chunk)::int;
      EXIT;
    END IF;

    v_chunk     := v_dirty[v_i : LEAST(v_i + c_chunk_size - 1, v_n_recips)];
    v_chunk_no  := v_chunk_no + 1;
    v_chunk_beg := clock_timestamp();
    BEGIN
      v_n    := public.donor_rollup_rebuild_recipients(v_chunk);
      v_rows := v_rows + v_n;
      IF v_chunk_no % 10 = 0 THEN
        RAISE NOTICE '[donor-rollup] chunk % — % recipients done, % rows so far',
          v_chunk_no, LEAST(v_i + c_chunk_size - 1, v_n_recips), v_rows;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its recipients keep their PRIOR
      -- rollup rows (complete-if-stale). The cursor still advances so the sweep
      -- terminates, but sweep_failures blocks the watermark advance at the end,
      -- so the whole set is retried by the next sweep — same net semantics as
      -- the pre-FIX-944 "don't advance on failure" rule.
      v_failures := v_failures || format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk_size - 1, v_n_recips), SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;

    -- FIX-944 — persist the cursor in the SAME transaction as the chunk's work.
    -- This is the whole fix: a run cancelled by the 6h statement_timeout keeps
    -- every committed chunk, and the next run starts at the next recipient
    -- instead of redoing the first ~1,000 forever.
    v_cursor := v_dirty[LEAST(v_i + c_chunk_size - 1, v_n_recips)];
    UPDATE public.pipeline_state
       SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object(
                     'sweep_cursor',   v_cursor::text,
                     'sweep_target',   v_new_max::text,
                     'sweep_failures', v_prior_fail + COALESCE(array_length(v_failures, 1), 0)),
           updated_at = NOW()
     WHERE key = 'donor_rollup_watermark';
    IF NOT FOUND THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark', jsonb_build_object(
                'sweep_cursor',   v_cursor::text,
                'sweep_target',   v_new_max::text,
                'sweep_failures', v_prior_fail + COALESCE(array_length(v_failures, 1), 0)))
      ON CONFLICT (key) DO UPDATE
        SET value = public.pipeline_state.value || EXCLUDED.value, updated_at = NOW();
    END IF;

    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Bounds txn size + advances xmin between chunks.
    COMMIT;

    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    v_i := v_i + c_chunk_size;
  END LOOP;

  IF v_budget_hit THEN
    -- Partial, resumable. Distinct from both 'complete' and 'failed' so four
    -- days of "the job is making progress but needs more windows" can never
    -- again read as either success or a hard error.
    UPDATE public.data_sync_log
    SET status        = 'partial',
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        error_message = format('budget exhausted — resumable at recipient %s of %s (cursor %s)',
                               v_i, v_n_recips, v_cursor),
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'resumable', true,
                          'resume_at_chunk', v_chunk_no + 1,
                          'remaining_recipients', GREATEST(v_n_recips - v_i + 1, 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] PARTIAL — % of % recipients this run, resumable at chunk %',
      v_i - 1, v_n_recips, v_chunk_no + 1;
  ELSE
    -- Sweep finished. Advance the durable watermark only if NO chunk failed
    -- anywhere in the sweep (including earlier, interrupted runs of it), then
    -- clear the cursor so the next run starts a fresh sweep.
    IF v_prior_fail + COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark',
              jsonb_build_object('last_indexed_at', COALESCE(v_new_max, NOW())::text))
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object('last_indexed_at', COALESCE(v_new_max, NOW())::text),
            updated_at = NOW();
    ELSE
      UPDATE public.pipeline_state
         SET value = (value - 'sweep_cursor' - 'sweep_target' - 'sweep_failures'),
             updated_at = NOW()
       WHERE key = 'donor_rollup_watermark';
    END IF;

    UPDATE public.data_sync_log
    SET status        = CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0
                             THEN 'failed' ELSE 'complete' END,
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        error_message = CASE WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                             ELSE NULL END,
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'sweep_failures_total', v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] % — % recipients in % chunks, % rows (% failures this run)',
      CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'PARTIAL' ELSE 'complete' END,
      v_n_recips, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);
  END IF;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

COMMENT ON PROCEDURE public.refresh_official_donor_rollup_incremental() IS
  'FIX-704/832/944 — incremental refresh of the six per-official money rollups '
  'via donor_rollup_rebuild_recipients(). FIX-944: resumable. The prod postgres '
  'role carries statement_timeout=6h, armed at CALL start and NOT re-armed by '
  'the per-chunk COMMITs, so a sweep larger than one 6h window is cancelled '
  'mid-flight; before FIX-944 that discarded the watermark and the next run '
  'redid the identical first ~1,000 recipients forever (livelock). Now a cursor '
  '(pipeline_state.donor_rollup_watermark.sweep_cursor) is advanced inside each '
  'chunk transaction, a predictive wall-clock budget stops the loop before the '
  '6h ceiling, and the run closes as status=''partial'' with resume_at_chunk. '
  'last_indexed_at advances only when a sweep completes with zero chunk '
  'failures. Break-glass single-pass: packages/data/src/scripts/donor-rollup-sweep.ts.';

-- ── Observability: make a reap distinguishable from a genuine failure ────────
-- The pre-FIX-944 reaper set status='failed', error_message='reaped_orphan' and
-- completed_at=NOW() on any row still 'running' past the threshold. On the
-- donor rollup that produced four consecutive rows reading "failed after ~20h",
-- when the truth was "cancelled by statement_timeout after exactly 6h, then
-- mislabelled 14h later". Two changes:
--   * status='reaped' — a distinct status, so a reap can never again be read as
--     the pipeline's own failure report. (data_sync_log.status is free text;
--     the FIX-234 canary matches on 'complete'/'partial' and is unaffected.)
--   * completed_at is left ALONE when the row is a pg_cron-sourced pipeline
--     whose backend is already gone — stamping NOW() is what manufactured the
--     20h. The reap time goes in metadata instead, where it cannot be mistaken
--     for a duration.
CREATE OR REPLACE FUNCTION public.reap_stale_sync_log(stale_minutes INT DEFAULT 10)
RETURNS TABLE(id UUID, pipeline TEXT, reaped_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.data_sync_log AS dsl
     SET status = 'reaped',
         error_message = format(
           'reaped_orphan — no completion after %s min; the pipeline''s own '
           'backend is gone. started_at..reap time is NOT a runtime (FIX-944).',
           stale_minutes),
         -- FIX-944: do NOT overwrite completed_at with NOW(). A row reaped
         -- hours after its backend died would otherwise report the gap as
         -- duration, which is exactly how four days of 6h statement_timeout
         -- cancellations were misread as 20h runs.
         completed_at = dsl.completed_at,
         metadata = COALESCE(dsl.metadata, '{}'::jsonb) || jsonb_build_object(
           'reaped', true,
           'reaped_at', NOW(),
           'reap_stale_minutes', stale_minutes,
           'observed_running_for_minutes',
             round(EXTRACT(epoch FROM (NOW() - dsl.started_at)) / 60)::int,
           'reap_note',
             'Elapsed since started_at is an UPPER BOUND on runtime, not a '
             'measurement. For pg_cron pipelines the true end is in '
             'cron.job_run_details.end_time.')
   WHERE dsl.status = 'running'
     AND dsl.started_at < NOW() - (stale_minutes::text || ' minutes')::interval
  RETURNING dsl.id, dsl.pipeline, NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.reap_stale_sync_log(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_stale_sync_log(INT) TO authenticated;

COMMENT ON FUNCTION public.reap_stale_sync_log(INT) IS
  'FIX-255/944 — flip stranded data_sync_log ''running'' rows to ''reaped''. '
  'FIX-944 changed the status from ''failed'' (indistinguishable from a '
  'pipeline-reported error) to ''reaped'', and stopped overwriting completed_at '
  'with NOW() — the reap timestamp lives in metadata.reaped_at so the '
  'started_at..reaped_at gap is never mistaken for a runtime.';

-- ── Freshness helper for the canary (FIX-944 / FIX-234) ──────────────────────
-- The FIX-234 canary only ever watched `nightly_cron`, which is why the donor
-- rollup could fail four days running and read as ordinary noise. This returns
-- the state the canary needs for ANY rollup pipeline: when it last reached a
-- terminal-good status, and whether a sweep is stuck mid-flight.
CREATE OR REPLACE FUNCTION public.check_rollup_freshness(
  p_pipeline text DEFAULT 'donor_rollup_refresh',
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH last_good AS (
    SELECT started_at, completed_at, status, metadata
    FROM public.data_sync_log
    WHERE pipeline = p_pipeline AND status = 'complete'
    ORDER BY started_at DESC LIMIT 1
  ),
  last_any AS (
    SELECT started_at, completed_at, status, error_message, metadata
    FROM public.data_sync_log
    WHERE pipeline = p_pipeline
    ORDER BY started_at DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'pipeline',            p_pipeline,
    'max_age_hours',       p_max_age_hours,
    'last_complete_at',    (SELECT completed_at FROM last_good),
    'hours_since_complete',
      ROUND(EXTRACT(epoch FROM (NOW() - (SELECT completed_at FROM last_good))) / 3600.0, 2),
    'stale',
      COALESCE(
        (SELECT completed_at FROM last_good) < NOW() - make_interval(hours => p_max_age_hours),
        true),
    'last_status',         (SELECT status        FROM last_any),
    'last_started_at',     (SELECT started_at    FROM last_any),
    'last_error',          (SELECT error_message FROM last_any),
    'last_metadata',       (SELECT metadata      FROM last_any),
    -- A sweep parked mid-flight is NOT a failure — it is the FIX-944 partial
    -- path working. Surface it so "converging over N nights" is visible and
    -- distinguishable from "wedged".
    'sweep_in_progress',
      (SELECT (value ? 'sweep_cursor') FROM public.pipeline_state
        WHERE key = 'donor_rollup_watermark'),
    'sweep_cursor',
      (SELECT value->>'sweep_cursor' FROM public.pipeline_state
        WHERE key = 'donor_rollup_watermark')
  );
$$;

-- Route/script-gated only (createAdminClient → service_role). No anon or
-- authenticated surface — FIX-834/835 hygiene.
REVOKE ALL ON FUNCTION public.check_rollup_freshness(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rollup_freshness(text, int) TO service_role;

COMMENT ON FUNCTION public.check_rollup_freshness(text, int) IS
  'FIX-944 — freshness probe for a rollup pipeline: hours since its last '
  '''complete'' row, whether that exceeds p_max_age_hours, and whether a '
  'FIX-944 resumable sweep is currently parked mid-flight. Consumed by the '
  'FIX-234 canary (packages/data/src/scripts/canary-check.ts), which before '
  'this only ever watched nightly_cron.';
