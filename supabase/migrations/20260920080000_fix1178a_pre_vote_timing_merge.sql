-- FIX-1178 (a) — pre-vote timing tags are MERGED, not rewritten.
--
-- THE FIX cc-136 diagnosed and cc-138 measured. `rebuild_pre_vote_timing_tags`
-- DELETEs all ~868k rows of its category and re-INSERTs all ~868k, every night,
-- for a set that moved by 642 rows in 18 days. cc-138's instrument split the
-- cost and the first PROD reading (2026-09-21 06:30 UTC) was
-- `phase_seconds = {delete: 46.5, insert: 947.6}` over a 994 s wall for 868,167
-- rows -- 95.3 % INSERT, and the fourth consecutive run above the 713-858 s
-- band. cc-136 split that INSERT further on the clone: ~48 % is the FR x votes
-- scan and ~48 % is the Insert node's OWN heap+index write, across eight
-- indexes. So the write is half the run and it is re-writing rows that were
-- already correct. This migration stops doing that.
--
-- THE SHAPE. Three functions in place of two halves, called in order inside ONE
-- transaction by the same procedure, with no COMMIT between them:
--
--   _scan()    CREATE TEMP TABLE pvt_desired AS <the desired set>   -> |desired|
--   _delete()  DELETE current \ desired                             -> rows gone
--   _insert()  INSERT desired \ current                             -> rows added
--
-- Atomicity is exactly what it was: the three still stand or fall together, a
-- cancel still rolls all of it back, and the next run redoes the same work --
-- which is what the procedure's existing `query_canceled` handler documents.
--
-- ── THE STRAND-PROOF, against the ACTUAL predicates below ───────────────────
--
-- Let C = the rows with entity_type='financial_entity', generated_by='rule',
-- tag_category='internal' (prod census 2026-09-22: 868,167 rows, ALL of them
-- tag='pre_vote_timing' and ALL generated_by='rule' -- one tag, one writer).
-- Let D = the entity_ids in pvt_desired.
--
--   _delete keeps a row iff NOT( NOT EXISTS(d: d.entity_id=t.entity_id
--                                              AND t.tag='pre_vote_timing') )
--           i.e. iff t.tag='pre_vote_timing' AND t.entity_id IN D.
--           Read that twice: `t.tag = 'pre_vote_timing'` is a condition on the
--           OUTER row sitting inside the EXISTS, so for any row whose tag is
--           something else the subquery is empty, NOT EXISTS is true, and the
--           row is DELETED -- which is exactly what today's unqualified
--           `DELETE ... WHERE entity_type/generated_by/tag_category` does to it.
--           The population is therefore UNCHANGED (rule 87: narrowing it would
--           be a reader change), it is only the *kept* subset that is new.
--           Call what survives C_keep.
--   _insert adds (d,'pre_vote_timing') for each d in D with no row on the
--           UNIQUE key (entity_type, entity_id, tag, tag_category). After the
--           DELETE that key is occupied exactly for entities(C_keep) -- plus
--           any non-'rule' row, which the DELETE deliberately does not own and
--           the INSERT therefore must not duplicate. So _insert adds exactly
--           D \ entities(C_keep).
--
--   Final = C_keep u (D \ entities(C_keep)) = {(d,'pre_vote_timing') : d in D}.
--
-- Nothing is stranded: every row outside the desired set is deleted, every
-- desired row is present, and a SECOND pass moves nothing (C = desired => the
-- DELETE matches 0 and the INSERT anti-joins to 0). That second-pass identity
-- is asserted by the test suite, not just argued here.
--
-- Note the deliberate asymmetry: _delete is scoped to generated_by='rule' and
-- _insert's anti-join is NOT. The anti-join must match the UNIQUE KEY, which
-- does not include generated_by -- if it carried the 'rule' predicate it would
-- try to insert over a 'manual' row and be silently swallowed by ON CONFLICT
-- every single night. Today's category has no non-rule rows (census above), so
-- this is a correctness margin rather than a live case.
--
-- ── WHY THE SCAN MOVES OUT OF THE INSERT, beyond measurability ──────────────
--
-- Measured on the clone 2026-09-22, and this was NOT in the design: a
-- data-writing statement gets NO parallel workers, so today's fused
-- `INSERT ... SELECT` is serial by rule -- its plan has no Gather node at all
-- (cost 2,812,079). `CREATE TABLE AS` is the documented exception, and the
-- TEMP CTAS below keeps a parallel plan: 2 workers launched, cost 1,447,440,
-- wall 4.6 s against 12.96 s for the identical SELECT forced serial. So
-- splitting the scan out does not merely make it measurable, it makes it
-- ELIGIBLE for parallelism, which it has never been.
--
-- ── THE PLANNER GUCs MOVE TO _scan(), and they are still right ──────────────
--
-- enable_hashjoin/enable_mergejoin=off exist for the correlated EXISTS over
-- `votes`, which is the only join in any of the three bodies. They therefore
-- belong to _scan() and to nothing else: _delete's anti-join over two ~868k-row
-- sets WANTS a hash anti-join, and _insert probes a unique index. Re-measured
-- serially on the clone 2026-09-22 rather than assumed:
--
--   GUCs off  ->  12.96 s   Bitmap Heap Scan on FR via financial_relationships_to
--                           + Index Only Scan on votes_official_voted_at_desc
--                           (the same plan shape cc-136 read off PROD)
--   default   -> 228.04 s   Hash Semi Join that hashes all 969,302 votes and
--                           then throws away 586,340,678 rows on the date-range
--                           Join Filter, because a BETWEEN cannot be a hash key
--
-- 17.6x. The GUC question design §4 deferred is hereby answered in the
-- direction it already pointed, with a bigger margin than anyone assumed, so
-- there is nothing to file.
--
-- ── THE SHRINK GUARD ────────────────────────────────────────────────────────
--
-- Today's rewrite is wrong-but-green on an empty scan: it DELETEs the category,
-- INSERTs nothing, reports success, and the tags are gone until someone
-- notices. The merge cannot have that shape, so _delete refuses when the
-- desired set is under half the current category. The EXCEPTION lands in the
-- procedure's existing `WHEN OTHERS` -> action='failed', the transaction rolls
-- back, and the old state is intact. A legitimate >50 % contraction of this
-- category would be an event worth a supervised run, not a silent night.
--
-- fix1128: no SET clause is added to the PROCEDURE -- it COMMITs, and a routine
-- carrying ANY SET clause runs atomic and cannot. The procedure body below is
-- PROD's, verified byte-identical to 20260920010000:258-428 by
-- pg_get_functiondef on 2026-09-22 before this edit (0 content lines of diff).
-- `SET work_mem = '256MB'` stays a plain statement inside it.
--
-- D5 (the source-signature gate) is NOT BUILT. It was measured first, per the
-- prompt's own gate, and it failed on something the gate did not test: HIT
-- RATE. The signature is votes(count,max(updated_at)) || FR(count,max(updated_at)),
-- and on prod over 2026-09-12..09-21 at least one of the two moved on ALL TEN
-- days (FR on 7, votes on 5, union 10/10). A gate that never fires is pure
-- added cost. Its cost was also not free: 2.28 s warm / 14.18 s cold on the
-- clone against a 12.96 s scan, because summarising FR requires scanning FR --
-- the same bitmap heap scan the desired set already pays for. See the cc-143
-- report.
--
-- FIX-1178 (c) rides here as an idempotent twin: `DROP INDEX IF EXISTS
-- public.idx_entity_tags_visibility` at the foot of this file. On PROD it is a
-- no-op because `scripts/fix1178c-drop-entity-tags-visibility-index.mjs` does
-- the real drop CONCURRENTLY first; on a fresh local or a rebuilt clone it is
-- the real drop. Rule 19's shape.
--
-- NO `Fixes:` TRAILER. FIX-1178 closes on two in-band daily receipts after this
-- lands; the first stamped merge is the next scheduled 06:30 UTC firing.

-- ---------------------------------------------------------------------------
-- 1. _scan() — the desired set, materialised once
-- ---------------------------------------------------------------------------
-- Every reference to the temp table is schema-qualified `pg_temp.` on purpose.
-- With search_path 'public','pg_temp' an unqualified `pvt_desired` would resolve
-- against public FIRST, so a same-named table there would silently become the
-- desired set. Qualifying makes that impossible, and it makes an out-of-order
-- call fail loudly (42P01) instead of quietly.
CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_scan()
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
  -- Idempotent within a transaction: the test suite calls the trio twice to
  -- prove the second pass moves nothing, and ON COMMIT DROP does not help
  -- before the commit.
  DROP TABLE IF EXISTS pg_temp.pvt_desired;

  CREATE TEMP TABLE pvt_desired ON COMMIT DROP AS
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
    );

  CREATE INDEX ON pg_temp.pvt_desired (entity_id);
  ANALYZE pg_temp.pvt_desired;

  SELECT count(*) INTO n FROM pg_temp.pvt_desired;
  RETURN n;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. _delete() — current \ desired, plus the shrink guard
-- ---------------------------------------------------------------------------
-- No planner GUCs: there is no join here that enable_hashjoin/mergejoin could
-- help, and the anti-join over two ~868k-row sets is exactly the case a hash
-- anti-join is for. Giving it GUCs it cannot use would be noise that reads as
-- meaningful (the cc-138 argument, unchanged).
CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_delete()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n     bigint;
  v_cur bigint;
  v_des bigint;
BEGIN
  SELECT count(*) INTO v_cur
  FROM public.entity_tags
  WHERE entity_type = 'financial_entity'
    AND generated_by = 'rule'
    AND tag_category = 'internal';

  SELECT count(*) INTO v_des FROM pg_temp.pvt_desired;

  IF v_cur > 0 AND v_des < v_cur * 0.5 THEN
    RAISE EXCEPTION
      'pre_vote_timing: desired set % vs current % — refusing a shrink past 50%% (a wrong-but-green empty scan would otherwise delete the category)',
      v_des, v_cur;
  END IF;

  -- The population is today's _delete's, unchanged; the NOT EXISTS only spares
  -- the rows the desired set keeps. See the strand-proof in the header.
  DELETE FROM public.entity_tags t
  WHERE t.entity_type = 'financial_entity'
    AND t.generated_by = 'rule'
    AND t.tag_category = 'internal'
    AND NOT EXISTS (
      SELECT 1 FROM pg_temp.pvt_desired d
      WHERE d.entity_id = t.entity_id
        AND t.tag = 'pre_vote_timing'
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. _insert() — desired \ current
-- ---------------------------------------------------------------------------
-- The anti-join is on the UNIQUE KEY columns, NOT on generated_by (header).
-- ON CONFLICT DO NOTHING stays as the belt: the anti-join makes it a no-op in
-- the steady state, and it is what keeps a concurrent writer from turning this
-- into an error. D2 as taken, corrected by the tree: the design's
-- `DO UPDATE ... WHERE IS DISTINCT FROM` is moot on the daily -- the payload is
-- eleven constants and entity_tags has no `updated_at` to stamp -- so the
-- single statement is DO NOTHING plus the anti-join.
CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_insert()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n bigint;
BEGIN
  INSERT INTO public.entity_tags (
    entity_type, entity_id, tag, tag_category, display_label, display_icon,
    visibility, confidence, generated_by, pipeline_version, metadata
  )
  SELECT
    'financial_entity', d.entity_id, 'pre_vote_timing', 'internal',
    'Pre-Vote Timing', NULL, 'internal', 1.0, 'rule', 'v1', '{}'::jsonb
  FROM pg_temp.pvt_desired d
  WHERE NOT EXISTS (
    SELECT 1 FROM public.entity_tags t
    WHERE t.entity_type  = 'financial_entity'
      AND t.entity_id    = d.entity_id
      AND t.tag          = 'pre_vote_timing'
      AND t.tag_category = 'internal'
  )
  ON CONFLICT (entity_type, entity_id, tag, tag_category) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The wrapper — contract change, stated
-- ---------------------------------------------------------------------------
-- The return value CHANGES MEANING: it was the whole re-inserted set, it is now
-- the DELTA inserted. The only callers are run_rule_taggers (which reads it as
-- `tags_written` and is updated below to stamp the delta beside the desired and
-- deleted counts) and the `heavy-rebuild.ts` allow-list, which has no live
-- caller for this name. Nothing reads it as a population size.
CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.rebuild_pre_vote_timing_tags_scan();
  PERFORM public.rebuild_pre_vote_timing_tags_delete();
  RETURN public.rebuild_pre_vote_timing_tags_insert();
END;
$function$;

-- Grants restated in full (FIX-834 posture; Supabase default-grants EXECUTE to
-- anon and authenticated, so a new function that does not say otherwise is
-- reachable from the front door).
REVOKE ALL ON FUNCTION public.rebuild_pre_vote_timing_tags_scan()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_pre_vote_timing_tags_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_pre_vote_timing_tags_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_pre_vote_timing_tags()        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags_scan()   TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags()        TO service_role;

-- ---------------------------------------------------------------------------
-- 5. run_rule_taggers — the daily branch calls the trio and stamps three phases
-- ---------------------------------------------------------------------------
-- Body is PROD's (pg_get_functiondef 2026-09-22, 0 content lines of diff
-- against 20260920010000:258-428). The ONLY edits are in the daily branch and
-- the closing stamp; the weekly branch, both EXCEPTION blocks, the advisory
-- lock, the FIX-950 stand-down, `SET work_mem`, and every COMMIT are verbatim.
--
-- fix1128: NO SET clause on this PROCEDURE. It COMMITs.
--
-- `desired_rows` / `deleted_rows` are stamped ABSENT, not null, when the branch
-- did not measure them -- the same discipline FIX-1178 (d) gave `phase_seconds`,
-- so the weekly's row does not grow two misleading zeroes (rule 93: extend the
-- sibling's row in the sibling's idiom).
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
  WHERE id = v_log_id;

  RAISE NOTICE '[rule-taggers] % (cadence=%) — action=%, % tags (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_action, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

-- Grants restated (20260714000000_fix834…:212-213 for the wrapper,
-- 20260902100000_fix1028…:790-791 for the procedure).
REVOKE ALL ON PROCEDURE public.run_rule_taggers(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_rule_taggers(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. FIX-1178 (c) — idx_entity_tags_visibility, the idempotent twin
-- ---------------------------------------------------------------------------
-- Craig's D4. PROD counters, two observations against the SAME
-- pg_postmaster_start_time epoch of 2026-09-15 15:09:48 UTC (pg_stat_database
-- .stats_reset is NULL, so the postmaster start IS the epoch — FIX-1178's own
-- cc-136 correction): cc-141 read idx_scan 0 / 450 MB at 2026-09-21 23:37 UTC,
-- and cc-143 read idx_scan 0 / 471,678,976 bytes at 2026-09-22 03:15 UTC. The
-- index is (visibility, confidence); the one query shaped for it
-- (snapshot/route.ts fetchEntityTags) was re-pointed at
-- idx_entity_tags_entity by FIX-503, which is why it takes no scans. No code
-- path names it — the only non-prose references in the tree are its own
-- CREATE INDEX in 0012_entity_tags.sql and a historical comment.
--
-- On PROD this is a NO-OP: scripts/fix1178c-drop-entity-tags-visibility-index.mjs
-- does the real drop CONCURRENTLY, out of band, before this migration is
-- pushed. Here it is the real drop for a fresh local or a rebuilt clone. It is
-- NOT CONCURRENTLY here because a migration runs inside a transaction and
-- DROP INDEX CONCURRENTLY cannot. Rule 19's two-part shape.
DROP INDEX IF EXISTS public.idx_entity_tags_visibility;
