-- FIX-1178 (d) — the INSTRUMENT, not the fix.
--
-- `rule-taggers-daily` has been above its 713-858 s band for three consecutive
-- runs (899.5 / 891.2 / 873.3 s). Nothing today says WHERE that time goes. The
-- procedure stamps one `elapsed_seconds` for the whole cadence and the daily
-- branch is a single call to `rebuild_pre_vote_timing_tags()`, so the DELETE and
-- the INSERT...SELECT are indistinguishable from outside — and they are the two
-- candidate causes, with opposite fixes. This migration makes the split
-- measurable. It changes no tagging semantics and writes no tag differently.
--
-- HOW. A call to a function is ONE statement; you cannot time halves of it from
-- the caller. So each rebuild function is split into a _delete() half and an
-- _insert() half, and the original name is kept as a two-line wrapper that calls
-- both -- so every other caller (`heavy-rebuild.ts`, the FIX-1028 sweeps, the
-- database.ts types) is untouched and keeps its exact contract, including the
-- return value, which is and stays the INSERT's ROW_COUNT.
--
-- `run_rule_taggers` then calls the two halves directly, inside the SAME
-- transaction, with no COMMIT between them: atomicity is exactly what it was.
-- The DELETE and its INSERT still stand or fall together, so a cancel still
-- rolls both back and the next run redoes the same work -- which is what the
-- existing `query_canceled` handler already documents and relies on.
--
-- THE PROCONFIG SPLIT, and why it is safe:
--
--   rebuild_pre_vote_timing_tags() carries
--     SET search_path, SET enable_hashjoin=off, SET enable_mergejoin=off
--   (NOTE: no work_mem -- the 256MB comes from the plain `SET work_mem` the
--   PROCEDURE executes before the call, which survives COMMIT and is inherited.
--   cc-136 described the proconfig as carrying work_mem; prod does not. And
--   `statement_timeout` is absent because FIX-1128 RESET it as inert -- see
--   20260913000000.)
--
--   The two planner GUCs exist for the INSERT's scan: the correlated EXISTS
--   over `votes` against `financial_relationships`, which is the only join in
--   either half. They are carried to the _insert() half ONLY. The _delete() half
--   is `DELETE FROM entity_tags WHERE entity_type = ... AND generated_by = ...
--   AND tag_category = ...` -- three equality predicates on one table and NO
--   join at all, so enable_hashjoin / enable_mergejoin cannot change its plan.
--   Giving it GUCs it cannot use would be noise that reads as meaningful.
--
--   rebuild_financial_entity_size_tags() carries SET search_path only. Its body
--   is the same DELETE + INSERT...SELECT shape (a GROUP BY over
--   financial_relationships, no join), so it splits identically, and neither
--   half gains a planner GUC because the original had none.
--
-- SECURITY DEFINER and search_path are carried to BOTH halves of both functions,
-- unchanged. EXECUTE is REVOKEd from PUBLIC / anon / authenticated and GRANTed to
-- service_role on each new function, matching the FIX-834 posture the originals
-- already have (`{postgres=X/postgres,service_role=X/postgres}` on prod) --
-- Supabase default-grants EXECUTE to anon and authenticated, so a new function
-- that does not say otherwise is reachable from the front door.
--
-- fix1128: no SET clause on the PROCEDURE. `run_rule_taggers` COMMITs, and a
-- routine carrying ANY `SET` clause runs atomic and cannot COMMIT (`invalid
-- transaction termination`). Proconfig and transaction control are mutually
-- exclusive. The body below is prod's, verified byte-identical to
-- 20260911000200:1612-1759 before this edit (pg_get_functiondef, 2026-09-20).
--
-- WHAT IS STAMPED. `metadata.phase_seconds = {"delete": n.n, "insert": n.n}`, in
-- the closing UPDATE, alongside the existing `elapsed_seconds`. Seconds to one
-- decimal, which is the `arm_timings` row shape from the FIX-950 rebuild family
-- (jsonb object keyed by phase name -> seconds) with one decimal instead of an
-- integer, because a local clone's halves are sub-second and an integer would
-- report 0 for both. The key is ABSENT, not null, when nothing was timed -- the
-- weekly gated branch that skips as `skipped_unchanged` times nothing.
--
-- Assignments to PL/pgSQL variables are not transactional, so a cancel midway
-- through the INSERT keeps the `delete` figure that was already recorded: the
-- stamp degrades to `{"delete": n.n}` rather than vanishing. That is the reading
-- you most want from a run that got killed.
--
-- NO `Fixes:` TRAILER. FIX-1178 closes on proposal (a) -- the temp-table
-- restructure that splits scan from write INSIDE the INSERT. This is the
-- measurement that tells (a) where to aim.

-- ---------------------------------------------------------------------------
-- 1. pre-vote timing -- the daily branch's rebuild, split
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_delete()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n bigint;
BEGIN
  -- Authoritative clear of this function's own tag category. Scoped to
  -- tag_category='internal' so the size/industry tags written by the Node
  -- tagFinancialEntities path survive.
  DELETE FROM public.entity_tags
  WHERE entity_type = 'financial_entity'
    AND generated_by = 'rule'
    AND tag_category = 'internal';

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_insert()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET enable_hashjoin TO 'off'
 SET enable_mergejoin TO 'off'
AS $function$
DECLARE
  n bigint;
BEGIN
  INSERT INTO public.entity_tags (
    entity_type, entity_id, tag, tag_category, display_label, display_icon,
    visibility, confidence, generated_by, pipeline_version, metadata
  )
  SELECT
    'financial_entity', q.entity_id, 'pre_vote_timing', 'internal',
    'Pre-Vote Timing', NULL, 'internal', 1.0, 'rule', 'v1', '{}'::jsonb
  FROM (
    SELECT DISTINCT fr.from_id AS entity_id
    FROM public.financial_relationships fr
    WHERE fr.to_type = 'official'
      AND fr.relationship_type = 'donation'
      AND fr.occurred_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.votes v
        WHERE v.official_id = fr.to_id
          AND v.voted_at >= (fr.occurred_at::timestamp AT TIME ZONE 'UTC') + interval '1 day'
          AND v.voted_at <  (fr.occurred_at::timestamp AT TIME ZONE 'UTC') + interval '91 days'
      )
  ) q
  ON CONFLICT (entity_type, entity_id, tag, tag_category) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

-- The original name, now a wrapper. Same signature, same SECURITY DEFINER, same
-- return value (the INSERT's ROW_COUNT), same DELETE-then-INSERT order, same
-- single-statement-per-caller contract for everyone who is not run_rule_taggers.
CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.rebuild_pre_vote_timing_tags_delete();
  RETURN public.rebuild_pre_vote_timing_tags_insert();
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_pre_vote_timing_tags_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_pre_vote_timing_tags_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags_insert() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. financial-entity size tags -- the weekly branch's rebuild, split
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_delete()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n bigint;
BEGIN
  -- Authoritative clear of just the 'size' category. Industry (keyword + NAICS)
  -- is cleared and rebuilt by the Node path, and 'internal' by
  -- rebuild_pre_vote_timing_tags — both survive this DELETE.
  DELETE FROM public.entity_tags
  WHERE entity_type = 'financial_entity'
    AND generated_by = 'rule'
    AND tag_category = 'size';

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_insert()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n bigint;
BEGIN
  WITH don AS (
    SELECT fr.from_id AS entity_id,
           SUM(COALESCE(fr.amount_cents, 0))::bigint AS total_cents
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
    GROUP BY fr.from_id
  )
  INSERT INTO public.entity_tags (
    entity_type, entity_id, tag, tag_category, display_label, display_icon,
    visibility, confidence, generated_by, pipeline_version, metadata
  )
  SELECT
    'financial_entity',
    d.entity_id,
    CASE WHEN d.total_cents <    500000 THEN 'small_donation'
         WHEN d.total_cents <   5000000 THEN 'medium_donation'
         WHEN d.total_cents <  50000000 THEN 'large_donation'
         ELSE                                'major_donation'  END,
    'size',
    CASE WHEN d.total_cents <    500000 THEN 'Small Donation'
         WHEN d.total_cents <   5000000 THEN 'Medium Donation'
         WHEN d.total_cents <  50000000 THEN 'Large Donation'
         ELSE                                'Major Donation'  END,
    CASE WHEN d.total_cents <   5000000 THEN NULL
         WHEN d.total_cents <  50000000 THEN '💰'
         ELSE                                '💰💰'           END,
    CASE WHEN d.total_cents <    500000 THEN 'internal'
         WHEN d.total_cents <   5000000 THEN 'secondary'
         ELSE                                'primary'         END,
    1.0, 'rule', 'v1',
    jsonb_build_object('total_cents', d.total_cents)
  FROM don d
  ON CONFLICT (entity_type, entity_id, tag, tag_category) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.rebuild_financial_entity_size_tags_delete();
  RETURN public.rebuild_financial_entity_size_tags_insert();
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_financial_entity_size_tags_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_size_tags_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags_insert() TO service_role;

-- ---------------------------------------------------------------------------
-- 3. run_rule_taggers -- prod's body, plus the phase clocks
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
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'run_rule_taggers: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

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
  -- vote set). Plain SET survives COMMIT. Budget = 6h role default (FIX-703).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('run_rule_taggers', 'running', v_started,
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
        -- FIX-1178 (d) — the two halves, timed separately, same transaction.
        v_t0 := clock_timestamp();
        PERFORM public.rebuild_financial_entity_size_tags_delete();
        v_t1 := clock_timestamp();
        v_phase := jsonb_build_object('delete', round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 1));
        v_rows := public.rebuild_financial_entity_size_tags_insert();
        v_phase := v_phase || jsonb_build_object(
                     'insert', round(EXTRACT(epoch FROM (clock_timestamp() - v_t1))::numeric, 1));
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_wm_key, jsonb_build_object('sig', v_current_sig))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
        v_action := 'rebuilt';
        RAISE NOTICE '  [rule-taggers] size-tags — rebuilt (% tags, sig=%, phases=%)', v_rows, v_current_sig, v_phase;
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
      -- FIX-1178 (d) — the two halves, timed separately, same transaction. No
      -- COMMIT between them: the DELETE and the INSERT still stand or fall
      -- together, exactly as when they were one function call.
      v_t0 := clock_timestamp();
      PERFORM public.rebuild_pre_vote_timing_tags_delete();
      v_t1 := clock_timestamp();
      v_phase := jsonb_build_object('delete', round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 1));
      v_rows := public.rebuild_pre_vote_timing_tags_insert();
      v_phase := v_phase || jsonb_build_object(
                   'insert', round(EXTRACT(epoch FROM (clock_timestamp() - v_t1))::numeric, 1));
      v_action := 'rebuilt';
      RAISE NOTICE '  [rule-taggers] pre-vote timing — rebuilt (% tags, phases=%)', v_rows, v_phase;
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
  WHERE id = v_log_id;

  RAISE NOTICE '[rule-taggers] % (cadence=%) — action=%, % tags (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_action, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;
