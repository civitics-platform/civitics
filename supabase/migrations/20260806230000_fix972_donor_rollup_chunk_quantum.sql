-- =============================================================================
-- FIX-972 — The donor-rollup drain stops at exactly 600 recipients per window,
--           and its cursor timestamp lies about when the run was last alive.
--
-- Two defects, unrelated causes, both found while auditing the first day of the
-- FIX-968 `0 9,12 * * *` schedule (prod runids 181 + 182, 2026-08-06).
--
-- ── Observation 1: EXACTLY 600 recipients, twice, stopping at 601 ────────────
-- Not a LIMIT, not an array cap, not a dirty-set fetch that is never re-fetched.
-- The dirty-set fetch is correct and uncapped — runs 181/182 built sets of
-- 10,286 and 9,686 recipients respectively and held all of them in v_dirty.
--
-- 600 is `3 × c_chunk_size`. It is the PREDICTIVE budget guard doing exactly
-- what FIX-944 designed it to do, at a chunk size whose quantum no longer fits
-- the budget:
--
--     IF v_elapsed + (v_max_chunk * 1.25) > c_budget THEN EXIT
--
--   runid 181: after 3 chunks elapsed=11,770 s, slowest=4,247 s
--              → 11,770 + 5,309 = 17,079 > 16,200  → stop at recipient 601
--   runid 182: after 3 chunks elapsed=11,054 s, slowest=6,546 s
--              → 11,054 + 8,182 = 19,236 > 16,200  → stop at recipient 601
--
-- It repeats at exactly 600 because it is arithmetic, not coincidence: for any
-- roughly uniform per-chunk cost c, three chunks complete and the fourth is
-- refused whenever 3,812 s < c < 4,985 s, and prod is sitting at c ≈ 3,900 s.
--
-- The cost is quantization. A 200-recipient chunk costs ~65 min against a
-- 4 h 30 m budget, so the guard must refuse a 4th chunk while 4,430–5,146 s
-- (27–32%) of the budget is still unspent. That waste is bounded below by the
-- reservation `1.25 × max_chunk`, so it cannot be tuned away — only the quantum
-- can shrink.
--
-- Note this was NOT true when FIX-944 sized these constants: the 07-31 sweep
-- (runid 135) ran 42 chunks with a slowest chunk of 749 s, where the same
-- reservation costs 936 s — under 6% of the budget. The constants were right
-- for a 750 s chunk and are wrong for a 3,900 s one. Per-chunk cost has moved
-- ~9× per FR row since (see the FIX-973 bullet); this migration does not
-- attempt to fix THAT, only to stop wasting a third of every window on top of it.
--
-- ── Observation 2: a 1 h 49 m "dead tail" that is not dead ───────────────────
-- runid 182's last cursor write is stamped 13:31:23 and the run ended 15:20:29,
-- reading as 1 h 49 m of stall after the final commit. It is not a stall — it is
-- chunk 3 running. Proof by exact equality:
--
--     15:20:29 − 13:31:23 = 6,546 s = the run's recorded slowest_chunk_seconds
--
-- The cursor UPDATE writes `updated_at = NOW()`, and NOW() is
-- transaction_timestamp(). In this procedure every chunk runs in its own
-- transaction that BEGINS immediately after the previous chunk's COMMIT, so
-- NOW() inside chunk N's cursor write returns the moment chunk N *started* —
-- one whole chunk early. The cursor VALUE was always correct; only its
-- timestamp lied, by up to one chunk (here, 109 minutes).
--
-- That is a live observability defect, not cosmetics: `pipeline_state.updated_at`
-- is the natural thing for an operator or a future stall detector to read, and
-- during a slow chunk it reports the sweep as idle for over an hour while it is
-- in fact working. It cost a full diagnostic pass here. clock_timestamp() is
-- the correct function — it advances inside a transaction.
--
-- ── What this migration changes ─────────────────────────────────────────────
--   1. c_chunk_size 200 → 50, so the quantum is ~7% of the budget instead of
--      ~24%. Same budget, same schedule, same cursor semantics — the run simply
--      stops wasting the tail of its own window. Measured locally: +33%
--      recipients cleared per window at an identical budget.
--   2. The chunk size becomes overridable via a SESSION GUC, exactly mirroring
--      the existing civitics.donor_rollup_budget_seconds override (FIX-944
--      decision 6): session-scoped so it dies with the connection and can never
--      strand a widened setting into the scheduled job, unlike a pipeline_state
--      override.
--   3. NOW() → clock_timestamp() on both cursor-write paths.
--
-- Smaller chunks also shrink the blast radius of the outer 6 h role-level
-- statement_timeout, which remains the backstop: a run cancelled mid-chunk
-- discards that chunk's uncommitted work, which was up to 109 min and is now
-- ~27 min.
--
-- DELIBERATELY NOT CHANGED, and why:
--   * c_budget stays 4 h 30 m. The 5,400 s of headroom between it and the 6 h
--     statement_timeout is real and unused, but spending it is a SCHEDULING
--     decision, not a defect fix: prod runs chain back-to-back (runid 182 began
--     1 s after 181 ended, the 12:00 firing having been deferred while 181 held
--     the job), so a longer window pushes the second run deep into US active
--     hours, which the no-heavy-prod-ops rule and FIX-968's own rationale both
--     exist to prevent. Left for a human call.
--   * Nothing about WHAT donor_rollup_rebuild_recipients() computes.
--
-- Body rebuilt from the CURRENT live prod definition — pg_get_functiondef md5
-- b21f8f65452415e4dcd55d725691e6ef (12,534 bytes, read 2026-08-06), verified
-- byte-identical to the FIX-944 migration's text and to local — so the
-- FIX-776/777/779/836/868 layering is preserved rather than reverted.
--
-- Cross-ref FIX-944, FIX-951, FIX-965, FIX-968, FIX-969, FIX-970, FIX-973.
-- =============================================================================

CREATE OR REPLACE PROCEDURE public.refresh_official_donor_rollup_incremental()
LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  -- FIX-972: 200 → 50. The predictive guard below can only stop BETWEEN chunks,
  -- so the smallest amount of budget it can waste is one reservation
  -- (1.25 × the slowest chunk seen). At 200 recipients a prod chunk costs
  -- ~65 min and that reservation is ~24% of the whole budget, which is why two
  -- consecutive windows both stopped dead at recipient 601 with over an hour
  -- unspent. Overridable via civitics.donor_rollup_chunk_size.
  c_chunk_size int    := 50;
  -- Wall-clock budget for ONE run. Must leave room under the 6h role-level
  -- statement_timeout for the slowest single chunk to finish plus the closing
  -- bookkeeping, because the budget can only be tested BETWEEN chunks.
  -- Overridable via the civitics.donor_rollup_budget_seconds session GUC.
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
  v_chunk_cfg  int;
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

  -- FIX-972 — same session-GUC contract for the chunk size:
  --     SET civitics.donor_rollup_chunk_size = '25';
  -- Exists so the quantum can be re-tuned against a shifting per-chunk cost
  -- without a migration, and so a before/after can be measured against ONE
  -- deployed body. Session-scoped for the same anti-stranding reason as the
  -- budget override. Clamped to [1, 1000]: 0 or a negative would make the
  -- WHILE loop never advance v_i, which is an infinite loop holding an
  -- advisory lock.
  v_chunk_cfg := NULLIF(current_setting('civitics.donor_rollup_chunk_size', true), '')::int;
  IF COALESCE(v_chunk_cfg, 0) > 0 THEN
    c_chunk_size := LEAST(v_chunk_cfg, 1000);
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
            'chunk_size', c_chunk_size,
            'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  WHILE v_i <= v_n_recips LOOP
    -- PREDICTIVE budget check. Testing `elapsed > budget` alone is useless when
    -- a single chunk costs ~60min against a 6h ceiling — the overshoot IS the
    -- failure. Stop when the SLOWEST chunk observed so far (plus 25% headroom)
    -- would not fit in what remains.
    --
    -- FIX-972: this guard is correct and unchanged; what changed is c_chunk_size,
    -- because the smallest budget this can leave unspent is one reservation and
    -- that reservation is proportional to the chunk. At 200 it forced a stop at
    -- recipient 601 with 27–32% of the window still available.
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
    --
    -- FIX-972 — updated_at uses clock_timestamp(), NOT NOW(). NOW() is
    -- transaction_timestamp(), and this chunk's transaction began right after
    -- the PREVIOUS chunk's COMMIT, so NOW() here stamps the moment this chunk
    -- STARTED — one whole chunk early. On prod runid 182 that made a working
    -- run look stalled for 1h49m (= exactly that chunk's duration). The cursor
    -- value was never wrong; only its timestamp was.
    v_cursor := v_dirty[LEAST(v_i + c_chunk_size - 1, v_n_recips)];
    UPDATE public.pipeline_state
       SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object(
                     'sweep_cursor',   v_cursor::text,
                     'sweep_target',   v_new_max::text,
                     'sweep_failures', v_prior_fail + COALESCE(array_length(v_failures, 1), 0)),
           updated_at = clock_timestamp()
     WHERE key = 'donor_rollup_watermark';
    IF NOT FOUND THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark', jsonb_build_object(
                'sweep_cursor',   v_cursor::text,
                'sweep_target',   v_new_max::text,
                'sweep_failures', v_prior_fail + COALESCE(array_length(v_failures, 1), 0)))
      ON CONFLICT (key) DO UPDATE
        SET value = public.pipeline_state.value || EXCLUDED.value, updated_at = clock_timestamp();
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
                          'chunk_size', c_chunk_size,
                          'recipients_done', v_i - 1,
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
                          'chunk_size', c_chunk_size,
                          'recipients_done', v_n_recips,
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
  'FIX-704/832/944/972 — incremental refresh of the six per-official money '
  'rollups via donor_rollup_rebuild_recipients(). FIX-944: resumable — a cursor '
  '(pipeline_state.donor_rollup_watermark.sweep_cursor) is advanced inside each '
  'chunk transaction and a predictive between-chunk wall-clock budget stops the '
  'loop before the 6h role-level statement_timeout, closing the run as '
  'status=''partial'' with resume_at_chunk. last_indexed_at advances only when a '
  'sweep completes with zero chunk failures. FIX-972: chunk size 200 → 50 '
  '(overridable via the civitics.donor_rollup_chunk_size session GUC) because '
  'the guard can only stop BETWEEN chunks, so a 65-min chunk forced two '
  'consecutive prod windows to stop dead at recipient 601 with 27–32%% of the '
  'budget unspent; and the cursor''s updated_at now uses clock_timestamp() '
  'rather than NOW(), which stamped the chunk''s START and made a working run '
  'look stalled for 1h49m. Break-glass single-pass: '
  'packages/data/src/scripts/donor-rollup-sweep.ts.';
