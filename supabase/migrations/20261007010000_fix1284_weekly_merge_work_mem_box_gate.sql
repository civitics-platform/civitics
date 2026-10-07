-- FIX-1284 — the weekly size-tags merge runs at work_mem 64MB, behind the P1-A
-- box gate. cc-205.
--
-- Design of record: docs/audits/2026-10-06-box-crash-triage.md (cc-204) and
-- FIX-1284's bullet; D1–D4 ratified by Craig 2026-10-06 19:00 PDT.
--
-- ── THE FINDING ──────────────────────────────────────────────────────────────
--
-- jobid 12 `CALL public.run_rule_taggers('weekly')` fired the first FIX-1248
-- merge Tue 2026-10-06 16:00:00Z. By auto_explain: the signature read 39.9 s,
-- `_scan`'s CTAS 59.6 s, the pre-count 21.6 s, the DELETE 30.3 s (desired
-- 4,426,852 / deleted 623), then the INSERT. The box (MemTotal 904 MB): swap
-- 825 of 1,024 MB used at 15:58:22Z; 1,005 used at 16:02:22Z, during the
-- pre-count and DELETE; MemAvailable 141 MB, swap 1,024/1,024, swap-in 1,379
-- pages/s at 16:04:22Z. pg_cron starved 16:04–21:27Z. The statement was
-- cancelled at 21:03:37Z, 18,218 s in (the 3 h ceiling landed 2 h 03 min late
-- under swap thrash), the merge rolled back with the signature, and the front
-- door stayed dark until the 00:46Z manual restart. 10-13 repeats the work.
--
-- The owner is the `SET work_mem = '256MB'` this procedure takes for both
-- cadences: with hash_mem_multiplier 2 one hash node may hold 512 MB. Every
-- hash in the merge sizes by |desired|. The INSERT's is ~560 MB on prod (the
-- FIX-1248 header predicted it and expected "Batches: 2"), and the pre-count's
-- and the DELETE's are ~320–340 MB. One backend took a third to a half of the
-- box, on a box already carrying ~800 MB in swap.
--
-- ── MEASURED ON THE CLONE (cc-205, 2026-10-07 02:37–02:41Z) ─────────────────
--
-- Before each run the container was restarted AND the Docker VM page cache was
-- dropped (`echo 3 > /proc/sys/vm/drop_caches` from a privileged alpine). The
-- clone is in steady state: 2,819,195 desired, 0 deleted, 0 inserted, 1
-- conflicting. The three statements were run exactly as the functions issue
-- them, under EXPLAIN (ANALYZE, BUFFERS, SETTINGS), one session per work_mem,
-- then rolled back. Peak = the backend's RssAnon, sampled each second from
-- /proc.
--
--                    work_mem 256MB         64MB                   32MB
--   _scan (CTAS)       24.4 s  no hash      18.5 s                 15.0 s
--   pre-count HRJ       6.8 s  B1 202 MB     4.0 s  B2 101 MB       3.9 s  B4 50 MB
--   DELETE HAJ          3.3 s  B1 218 MB     3.0 s  B2 109 MB       3.1 s  B4 54 MB
--   INSERT HRAJ         5.1 s  B1 358 MB     6.7 s  B4  90 MB       6.2 s  B8 45 MB
--   temp written        0                  683 MB (138/154/392)   894 MB
--   psql wall          42.2 s               35.4 s                 30.8 s
--   peak RssAnon      380 MB               126 MB                  69 MB
--
-- HRJ / HAJ / HRAJ = Hash Right Join / Hash Anti Join / Hash Right Anti Join.
-- B = Batches; the final count equals the planned one in every case. MB = the
-- Hash node's Memory Usage. Lowering work_mem costs no wall on the clone: the
-- spill is sequential temp I/O, and the cold heap reads dominate. 32MB halves
-- the memory again at no cost either. 64MB is the ratified number and caps
-- every hash at a 128 MB hash_mem, so it stays. 32MB is the next lever if the
-- 10-13 ring still shows swap-in.
--
-- ── PROJECTED ON PROD ────────────────────────────────────────────────────────
--
-- Page ratios, prod / clone (pg_class.relpages, read 2026-10-07 02:33Z):
--   entity_tags heap                              226,259 / 108,719 = x2.08
--   financial_relationships_donation_size_rollup   79,687 /  44,505 = x1.79
--   |desired|                                   4,426,852 / 2,819,195 = x1.57
-- By pages alone the 64MB trio is ~67 s: the scan's 21.7 s x1.79 plus the
-- rest's 13.6 s x2.08. On 10-06 the healthy-box phases ran x2.4–3.2 the
-- clone's cold wall (CTAS 59.6 vs 24.4, pre-count 21.6 vs 6.8), and the
-- swapping one x9.2 (DELETE 30.3 vs 3.3).
--   at x3.2: 39.9 s signature + 35.3 s x3.2 = ~155 s
--   at x9.2 throughout: ~365 s
-- At 64MB on prod the INSERT's ~560 MB hash runs as Batches 8 of <= 128 MB, and
-- the pre-count and DELETE as Batches 4, writing and reading ~1.1 GB of temp.
-- Even the FIX-1248 first-clone delta (1.5M rows written, an extra ~98 s of
-- INSERT) at x9.2 lands at ~1,270 s, inside half the 7,200 s budget.
--
-- ── WHAT CHANGES (the procedure only; the trio and the daily are untouched) ─
--
-- D1. In the weekly branch, inside the signature gate and immediately before
--     the trio: a plain SET of work_mem to 64MB. That is this procedure's own
--     idiom: a plain SET survives COMMIT and governs every statement after it,
--     and cc-195 showed a body-level SET takes effect inside a procedure. It
--     runs only when the merge runs. The daily's 256MB is unchanged.
-- D2. The P1-A START gate (FIX-1194, 20261003030000), weekly only:
--     box_backoff_gate('rule-taggers-weekly', 600). Not clear → a `skipped`
--     row with skip_reason 'box saturated after N s: <reason>', then RETURN.
--     It sits where P1-A puts it, after the cadence check and BEFORE the
--     advisory lock and the FIX-950 stand-down (gate → lock → defer → work).
--     The cc-205 prompt read it after the stand-down instead. There, a 600 s
--     wait would hold the lock the daily shares, and a supervised claim taken
--     during the wait would never be read. The running row gains `gate` when
--     the gate waited.
--     HONEST SCOPE: box_is_saturated() reads `stale` and `fork_failures` (the
--     gate switches the wall off), and its memory half is REPORT-ONLY. A box at
--     141 MB MemAvailable with full swap therefore reads `clear` for as long as
--     the probe still forks. The gate would not have stopped 10-06: the box was
--     clear at 16:00 and this job wedged it by 16:04. It stops a firing on a
--     box whose forker is already failing. D1 is the load-bearing change.
-- D3. The stale budget comment: 6h (FIX-703) → 3 h (FIX-1185).
-- D4. If jobid 12 was parked after 10-06, re-activate it: by NAME, guarded on
--     NOT active, and never by unscheduling (that mints a new jobid). Prod read
--     2026-10-07 02:33Z: active = true, so it is a no-op there. The clone's
--     copy (jobid 24) is parked by local convention, so the block switches it
--     on, and cc-205 parks it again after `migration up --local`.
--
-- fix1128: NO SET clause on the PROCEDURE. It COMMITs, and a routine carrying
-- any SET clause runs atomic and cannot. The body below is PROD's: md5(prosrc)
-- b397c4e6fb82feeb582692ccc5715b11, 10,697 chars, read 2026-10-07 02:33Z, the
-- 20261001010000:360-559 body with 0 differing bytes. The additions are fenced
-- `-- >>> FIX-1284` / `-- <<< FIX-1284`, plus one DECLARE and the D3 comment.
-- weekly-size-tags-merge.test.ts proves everything else byte-equal.
--
-- `Fixes: FIX-1284` rides this commit as local-only. The prod receipt is the
-- Tue 2026-10-13 16:00Z firing.

-- ---------------------------------------------------------------------------
-- run_rule_taggers — D1, D2, D3
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.run_rule_taggers(IN p_cadence text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key    bigint := hashtext('run_rule_taggers')::bigint;  -- shared by both cadences
  c_wm_key      text   := 'size_tags:donation_watermark';
  v_log_id      uuid;
  v_rows        bigint := 0;
  v_action      text;
  v_current_sig text;
  v_stored_sig  text;
  v_failures    text[] := ARRAY[]::text[];
  v_canceled    text := NULL;                          -- FIX-1028
  v_started     timestamptz := clock_timestamp();      -- FIX-979
  v_phase       jsonb := '{}'::jsonb;                  -- FIX-1178 (d)
  v_t0          timestamptz;                           -- FIX-1178 (d)
  v_t1          timestamptz;                           -- FIX-1178 (d)
  v_t2          timestamptz;                           -- FIX-1178 (a)
  v_desired     bigint := NULL;                        -- FIX-1178 (a)
  v_deleted     bigint := NULL;                        -- FIX-1178 (a)
  v_inserted    bigint := NULL;                        -- FIX-1248
  v_updated     bigint := NULL;                        -- FIX-1248
  v_gate        jsonb  := NULL;                        -- FIX-1284
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'run_rule_taggers: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;
  -- >>> FIX-1284 D2 — the P1-A START gate (FIX-1194), weekly only: wait up to
  -- 600 s for a box that is neither stale nor failing forks. BEFORE the lock,
  -- so a waiting firing holds nothing; before the FIX-950 stand-down, so a
  -- claim taken during the wait is still read. The sensor's memory half is
  -- report-only: this does not see a swapping box whose probe still forks.
  IF p_cadence = 'weekly' THEN
    v_gate := public.box_backoff_gate('rule-taggers-weekly', 600);
    IF NOT (v_gate->>'clear')::boolean THEN
      INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
      VALUES ('run_rule_taggers', 'skipped', v_started, clock_timestamp(),
              jsonb_build_object('cadence', p_cadence,
                                 'skip_reason', format('box saturated after %s s: %s',
                                                       v_gate->>'waited_s', v_gate->>'reason'),
                                 'source', 'pg_cron',
                                 'gate', v_gate));
      RAISE NOTICE '[rule-taggers] box saturated (%) after % s — skipping (FIX-1284)',
        v_gate->>'reason', v_gate->>'waited_s';
      RETURN;
    END IF;
  END IF;
  -- <<< FIX-1284 D2

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent run_rule_taggers',
                               'source', 'pg_cron'));
    RAISE NOTICE '[rule-taggers] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[rule-taggers] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Bounded memory for the aggregate rebuilds (they HashAggregate the donation /
  -- vote set). Plain SET survives COMMIT. Budget = 3 h (FIX-1185; the 10-06
  -- cancel landed 2 h late under swap thrash — cc-204 §8 Q1). Weekly: 64MB below.
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('run_rule_taggers', 'running', v_started,
          jsonb_build_object('cadence', p_cadence, 'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  -- >>> FIX-1284 D2 — a wait the gate took is on the record (the P1-A shape).
  IF (v_gate->>'waited_s')::int > 0 THEN
    UPDATE public.data_sync_log
       SET metadata = metadata || jsonb_build_object('gate', v_gate)
     WHERE id = v_log_id;
  END IF;
  -- <<< FIX-1284 D2
  COMMIT;

  IF p_cadence = 'weekly' THEN
    -- ── size-tags (donation-derived), gated ──────────────────────────────────
    BEGIN
      SELECT count(*)::text || '|'
             || COALESCE(max(created_at), 'epoch'::timestamptz)::text || '|'
             || COALESCE(max(updated_at), 'epoch'::timestamptz)::text
        INTO v_current_sig
        FROM public.financial_relationships
       WHERE from_type = 'financial_entity' AND relationship_type = 'donation';

      SELECT value->>'sig' INTO v_stored_sig
        FROM public.pipeline_state WHERE key = c_wm_key;

      IF v_stored_sig IS DISTINCT FROM v_current_sig THEN
        -- FIX-1248 — the MERGE, three phases, timed separately, all in the
        -- SAME transaction as the signature advance below, with no COMMIT
        -- between them: scan, then DELETE current\desired on (entity_id, tag),
        -- then INSERT desired\current with a moved total UPDATEd in place.
        -- >>> FIX-1284 D1 — every hash in the trio sizes by |desired| (4.43M
        -- on prod). At 256MB x hash_mem_multiplier 2 the INSERT's ~560 MB
        -- anti-join hash ran against a 512 MB hash_mem on a 904 MB box already
        -- carrying ~800 MB in swap, and wedged it (10-06 16:04Z, MemAvailable
        -- 141 MB). At 64MB each hash spills to temp past 128 MB: the clone
        -- measured Batches 2 / 2 / 4 (pre-count / DELETE / INSERT), no slower,
        -- peak backend memory 380 -> 126 MB. A plain SET, like the daily's
        -- above; it holds for the rest of the session.
        SET work_mem = '64MB';
        -- <<< FIX-1284 D1
        v_t0      := clock_timestamp();
        v_desired := public.rebuild_financial_entity_size_tags_scan();
        v_t1      := clock_timestamp();
        v_deleted := public.rebuild_financial_entity_size_tags_delete();
        v_t2      := clock_timestamp();
        SELECT i.inserted, i.updated INTO v_inserted, v_updated
          FROM public.rebuild_financial_entity_size_tags_insert() i;
        v_rows    := v_inserted + v_updated;
        v_phase   := jsonb_build_object(
                       'scan',   round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 1),
                       'delete', round(EXTRACT(epoch FROM (v_t2 - v_t1))::numeric, 1),
                       'insert', round(EXTRACT(epoch FROM (clock_timestamp() - v_t2))::numeric, 1));
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_wm_key, jsonb_build_object('sig', v_current_sig))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
        v_action := 'rebuilt';
        RAISE NOTICE '  [rule-taggers] size-tags — merged (desired % / deleted % / inserted % / updated %, sig=%, phases=%)',
          v_desired, v_deleted, v_inserted, v_updated, v_current_sig, v_phase;
      ELSE
        v_action := 'skipped_unchanged';
        RAISE NOTICE '  [rule-taggers] size-tags — donation source unchanged (sig=%), skipping rebuild', v_current_sig;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, first. The rebuild and its signature advance share
    -- this subtransaction, so a cancel rolls BOTH back and the next run redoes
    -- the same work. Nothing to gate; just record it and close the row.
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      -- Rebuild + watermark advance roll back together → next run retries.
      v_action := 'failed';
      v_failures := v_failures || format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  ELSE
    -- ── pre-vote timing (vote-derived), ungated ──────────────────────────────
    BEGIN
      -- FIX-1178 (a) — the MERGE, three phases, timed separately, all in the
      -- SAME transaction with no COMMIT between them: scan, then DELETE
      -- current\desired, then INSERT desired\current. They still stand or fall
      -- together, exactly as when this was one rewriting function call.
      v_t0      := clock_timestamp();
      v_desired := public.rebuild_pre_vote_timing_tags_scan();
      v_t1      := clock_timestamp();
      v_deleted := public.rebuild_pre_vote_timing_tags_delete();
      v_t2      := clock_timestamp();
      v_rows    := public.rebuild_pre_vote_timing_tags_insert();
      v_phase   := jsonb_build_object(
                     'scan',   round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 1),
                     'delete', round(EXTRACT(epoch FROM (v_t2 - v_t1))::numeric, 1),
                     'insert', round(EXTRACT(epoch FROM (clock_timestamp() - v_t2))::numeric, 1));
      v_action := 'rebuilt';
      RAISE NOTICE '  [rule-taggers] pre-vote timing — merged (desired % / deleted % / inserted %, phases=%)',
        v_desired, v_deleted, v_rows, v_phase;
    EXCEPTION
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      v_action := 'failed';
      v_failures := v_failures || format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'tagger', CASE WHEN p_cadence = 'weekly' THEN 'size_tags' ELSE 'pre_vote_timing' END,
                        'action', v_action,
                        'tags_written', v_rows,
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
                      -- FIX-1178 (d) — absent, not null, when nothing was timed
                      -- (the gated weekly branch that skips as skipped_unchanged).
                      || CASE WHEN v_phase = '{}'::jsonb THEN '{}'::jsonb
                              ELSE jsonb_build_object('phase_seconds', v_phase) END
                      -- FIX-1178 (a) — same discipline: the merge's set sizes,
                      -- absent on any branch that did not measure them.
                      || CASE WHEN v_desired IS NULL THEN '{}'::jsonb
                              ELSE jsonb_build_object('desired_rows', v_desired,
                                                      'deleted_rows', v_deleted) END
                      -- FIX-1248 — the weekly merge's two write counts, absent
                      -- on the daily and on a weekly skipped_unchanged.
                      || CASE WHEN v_inserted IS NULL THEN '{}'::jsonb
                              ELSE jsonb_build_object('inserted_rows', v_inserted,
                                                      'updated_rows', v_updated) END
  WHERE id = v_log_id;

  RAISE NOTICE '[rule-taggers] % (cadence=%) — action=%, % tags (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_action, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

-- Grants restated (20260920080000:499-500).
REVOKE ALL ON PROCEDURE public.run_rule_taggers(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_rule_taggers(text) TO service_role;

-- ---------------------------------------------------------------------------
-- D4 — rule-taggers-weekly back on, if it was parked after 10-06. By NAME
-- (jobid 12 on prod, 24 on the clone); alter_job keeps the jobid and its
-- cron.job_run_details history.
-- ---------------------------------------------------------------------------
DO $fix1284_d4$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid
    FROM cron.job
   WHERE jobname = 'rule-taggers-weekly' AND NOT active;
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := true);
    RAISE NOTICE 'FIX-1284 D4: rule-taggers-weekly (jobid %) was parked — re-activated', v_jobid;
  ELSE
    RAISE NOTICE 'FIX-1284 D4: rule-taggers-weekly absent or already active — no change';
  END IF;
END
$fix1284_d4$;
