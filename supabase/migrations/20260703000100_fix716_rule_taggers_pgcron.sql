-- FIX-716 — relocate the two heavy SQL rule-tagger rebuilds to pg_cron (PR2).
--
-- The nightly `tag_rules` step (runRuleBasedTagger) bundles four taggers. Two of
-- them are pure-SQL heavy rebuilds invoked via the direct-pg heavy-rebuild path
-- (packages/data/src/lib/heavy-rebuild.ts), and they are the budget burners:
--   * rebuild_financial_entity_size_tags()  — DELETE + re-INSERT ~2.33M 'size'
--     tags by aggregating ~4.9M donation rows (>2 min / the ~80 min burn when it
--     is NOT gated); donation-derived → WEEKLY.
--   * rebuild_pre_vote_timing_tags()         — DELETE + INSERT…SELECT the
--     'pre_vote_timing' tags (~80s); vote-derived → DAILY.
-- The other two taggers in runRuleBasedTagger (proposal urgency/new, official
-- tenure/voting/donor patterns, financial-entity industry keywords) are Node-side
-- logic (JS keyword regex, date math, direct-pg jsonb rollups) that cannot run in
-- a SQL procedure — they STAY in the GHA enrichment phase (a lighter tag_rules).
--
-- This procedure relocates ONLY the two SQL rebuilds, reusing the FIX-704 pg_cron
-- pattern (CALL + advisory lock + per-tagger COMMIT + EXCEPTION-continue +
-- data_sync_log + 6h role-default budget). Not chunked yet (decision: only if the
-- Sunday size-tags run is still a problem on its own budget — a follow-up); the
-- size rebuild stays a single statement / transaction, same as it is today.
--
-- ── FIX-652 source-change gate — ported from TS to SQL ───────────────────────
-- The size rebuild deletes+re-inserts byte-identical rows 6 of 7 nights because
-- donations only change on the weekly Sunday FEC ingest. The gate (originally in
-- tags/rules.ts, removed there in the same commit) skips the rebuild when a
-- signature of the donation source — count + max(created_at) + max(updated_at)
-- over the donor rows — is unchanged since the last build. Same signature shape
-- and same pipeline_state key ('size_tags:donation_watermark', value->>'sig') as
-- the TS gate, so a watermark written by either side is read by the other.
-- Fail-safe direction is REBUILD: a missing/unreadable/mismatched watermark all
-- force a rebuild (the gate never wrongly skips). The rebuild + watermark advance
-- share one subtransaction, so a failure rolls back BOTH → next run retries
-- (byte-identical final state either way; FIX-443 invariant preserved). Now that
-- pre-vote has its own 6h-budget daily job the budget pressure FIX-654 wanted to
-- gate away is gone, so pre-vote runs unconditionally (FIX-654 superseded).

CREATE OR REPLACE PROCEDURE public.run_rule_taggers(p_cadence text)
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key    bigint := hashtext('run_rule_taggers')::bigint;  -- shared by both cadences
  c_wm_key      text   := 'size_tags:donation_watermark';
  v_log_id      uuid;
  v_rows        bigint := 0;
  v_action      text;
  v_current_sig text;
  v_stored_sig  text;
  v_failures    text[] := ARRAY[]::text[];
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'run_rule_taggers: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', now(), now(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent run_rule_taggers',
                               'source', 'pg_cron'));
    RAISE NOTICE '[rule-taggers] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;

  -- Bounded memory for the aggregate rebuilds (they HashAggregate the donation /
  -- vote set). Plain SET survives COMMIT. Budget = 6h role default (FIX-703).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('run_rule_taggers', 'running', now(),
          jsonb_build_object('cadence', p_cadence, 'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
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
        v_rows := public.rebuild_financial_entity_size_tags();
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_wm_key, jsonb_build_object('sig', v_current_sig))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
        v_action := 'rebuilt';
        RAISE NOTICE '  [rule-taggers] size-tags — rebuilt (% tags, sig=%)', v_rows, v_current_sig;
      ELSE
        v_action := 'skipped_unchanged';
        RAISE NOTICE '  [rule-taggers] size-tags — donation source unchanged (sig=%), skipping rebuild', v_current_sig;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Rebuild + watermark advance roll back together → next run retries.
      v_action := 'failed';
      v_failures := v_failures || format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  ELSE
    -- ── pre-vote timing (vote-derived), ungated ──────────────────────────────
    BEGIN
      v_rows := public.rebuild_pre_vote_timing_tags();
      v_action := 'rebuilt';
      RAISE NOTICE '  [rule-taggers] pre-vote timing — rebuilt (% tags)', v_rows;
    EXCEPTION WHEN OTHERS THEN
      v_action := 'failed';
      v_failures := v_failures || format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'tagger', CASE WHEN p_cadence = 'weekly' THEN 'size_tags' ELSE 'pre_vote_timing' END,
                        'action', v_action,
                        'tags_written', v_rows)
  WHERE id = v_log_id;

  RAISE NOTICE '[rule-taggers] % (cadence=%) — action=%, % tags (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_action, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.run_rule_taggers(text) TO service_role;

COMMENT ON PROCEDURE public.run_rule_taggers(text) IS
  'FIX-716 — pg_cron rule taggers, cadence-matched: weekly = size-tags '
  '(rebuild_financial_entity_size_tags, donation-derived, gated on the FIX-652 '
  'donation signature in pipeline_state.size_tags:donation_watermark); daily = '
  'pre-vote timing (rebuild_pre_vote_timing_tags, vote-derived, ungated). FIX-704 '
  'pattern: advisory lock, per-tagger COMMIT + EXCEPTION, data_sync_log, 6h '
  'role-default budget. The Node-side taggers (proposals/officials/industry) stay '
  'in the GHA enrichment phase. Supersedes FIX-653 + FIX-654. CALL with ''daily'' '
  'or ''weekly''.';

-- ── pg_cron jobs — created PAUSED (FIX-704 discipline) ───────────────────────
-- Runbook (supervised, off-peak): after db:push:prod registers these, run a
-- one-off CALL run_rule_taggers('daily') and confirm the gate SKIPS on a
-- CALL run_rule_taggers('weekly') when donations are unchanged, THEN enable:
--   SELECT cron.alter_job(jobid, active := true)
--     FROM cron.job WHERE jobname LIKE 'rule-taggers-%';
--
-- Off-peak slots (UTC), clear of the 02:00 nightly and the 08:00 rebuild jobs:
--   rule-taggers-daily   06:30 daily — pre-vote (~80s), light; after the nightly
--     vote ingest, staggered 30 min after refresh-derived-mvs-daily (06:00).
--   rule-taggers-weekly  10:00 Tue   — size-tags is the heavy one; isolated from
--     donor-rollup-refresh (Tue 08:00) and the light 06:00–07:00 jobs so no two
--     heavy jobs saturate Micro I/O at once. Gated, so it usually skips fast; the
--     real rebuild only runs the week after a Sunday FEC ingest.
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('rule-taggers-daily', 'rule-taggers-weekly');

SELECT cron.schedule(
  'rule-taggers-daily',
  '30 6 * * *',
  $$CALL public.run_rule_taggers('daily');$$
);

SELECT cron.schedule(
  'rule-taggers-weekly',
  '0 10 * * 2',
  $$CALL public.run_rule_taggers('weekly');$$
);

SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job
 WHERE jobname IN ('rule-taggers-daily', 'rule-taggers-weekly');
