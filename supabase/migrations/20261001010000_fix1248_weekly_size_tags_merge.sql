-- FIX-1248 — the weekly `size` tags are MERGED, not rewritten.
--
-- THE COST. `run_rule_taggers('weekly')` (jobid 12, Tue 16:00 UTC) DELETEs
-- every financial-entity `size` tag and re-INSERTs all of them: 4,421,363 rows
-- on 2026-09-29 in 5,062.9 s = `phase_seconds {delete: 49.6, insert: 4974.3}`
-- against a 7,200 s budget, after 4,692.4 s (09-08) and 4,837.7 s (09-15). 98 %
-- of it is the INSERT: 4.4M fresh heap tuples plus an entry in each of seven
-- indexes, every week, for a set that moves by thousands of rows. The heap sits
-- at 1,768 MB / 226,259 pages, ~1.72x its packed size, and each rewrite feeds
-- the ratchet. This migration stops rewriting rows that are already correct.
--
-- THE SHAPE is the daily's (FIX-1178a, 20260920080000), three functions called
-- in order inside ONE transaction by the same procedure, with no COMMIT between
-- them:
--
--   _scan()    CREATE TEMP TABLE fes_desired AS <the desired set>   -> |desired|
--   _delete()  DELETE current \ desired, on (entity_id, tag)        -> rows gone
--   _insert()  INSERT desired \ current; DO UPDATE a moved total    -> (inserted, updated)
--
-- They still stand or fall together: a cancel or a guard rolls all three back
-- with the signature advance, and the next Tuesday redoes the same work.
--
-- ── THE TWO WAYS THE WEEKLY IS NOT THE DAILY ───────────────────────────────
--
-- 1. The payload moves. A size row carries `metadata.total_cents`, and that
--    changes with every new donation row even when the tier does not. The
--    daily's `ON CONFLICT DO NOTHING` would leave such a row with a stale
--    total forever, so _insert UPDATEs on conflict, but only when the stored
--    metadata actually differs.
-- 2. The tier is part of the key. `tag` is in the UNIQUE key
--    (entity_type, entity_id, tag, tag_category), so a donor that crosses a
--    tier is a DELETE of the old row and an INSERT of the new one, never an
--    UPDATE. Both anti-joins therefore key on (entity_id, tag), not entity_id.
--
-- ── THE STRAND-PROOF, against the predicates below ─────────────────────────
--
-- Let C = rows with entity_type='financial_entity', generated_by='rule',
-- tag_category='size' (prod 2026-10-01: all 4.42M size rows are 'rule'; zero
-- of any other generated_by). Let D = the (entity_id, tag) pairs in
-- fes_desired, one per donor, since the scan GROUPs BY from_id.
--
--   _delete removes every c in C whose (entity_id, tag) is not in D. What
--           survives is C_keep = C ∩ D, on that pair.
--   _insert, for each d in D:
--     - a C_keep row with the same metadata    -> skipped by the anti-join
--     - a C_keep row whose metadata differs    -> ON CONFLICT -> UPDATEd
--     - no row on the key                      -> INSERTed
--     - a NON-rule row on the key              -> ON CONFLICT -> left alone
--
--   Final rule rows = D minus the keys a non-rule row holds, each carrying
--   the desired metadata. With no non-rule size rows (today), |C after| =
--   |D|, and the second pass moves nothing: the DELETE matches 0, the
--   anti-join matches 0. Both identities are asserted by the test suite
--   (size-tags-merge.test.ts), not just argued here.
--
-- The `generated_by = 'rule'` term on the DO UPDATE goes beyond the design
-- note's D1 text, and it is there to preserve behaviour. Today's INSERT is `DO
-- NOTHING`, so a manual row on a size key has never been touched by this job.
-- An unguarded DO UPDATE would start overwriting its metadata and labels. As
-- with the daily, the anti-join keys on the UNIQUE columns and NOT on
-- generated_by, and _delete is scoped to 'rule'.
--
-- ── THE TWO GUARDS (_delete RAISEs, so the procedure's WHEN OTHERS stamps
-- 'failed', the subtransaction rolls back, the old state is intact, and the
-- signature does not advance) ──────────────────────────────────────────────
--
--   * shrink: |desired| < 0.5 x |current|. The daily's guard. A truncated or
--     empty scan must not delete the category.
--   * delete: |current \ desired| > 10 % of |current|. New here. The steady
--     state is thousands of rows out of 4.4M, so a run that would delete more
--     than 442k is not a normal Tuesday. It is either a data event worth a
--     supervised look or a bug, and in both cases refusing is cheap.
--
-- Both are checked BEFORE the DELETE. One LEFT JOIN pass over C yields |current|
-- and |current \ desired| together; the daily already paid for a count(*)
-- over its category here. The alternative, deleting and then checking
-- ROW_COUNT, would cost one pass less in the steady state but, when the guard
-- fires, would have xmax-marked hundreds of thousands of rows before rolling
-- back.
--
-- ── WHAT THE STAMP MEANS NOW ───────────────────────────────────────────────
--
-- `rows_inserted` and `metadata.tags_written` = inserted + updated, the rows
-- this run WROTE. They no longer equal the table's row count, which was
-- 4,421,363 on 09-29 only because every row was rewritten. The weekly row
-- gains `desired_rows`, `deleted_rows`, `inserted_rows` and `updated_rows`, and
-- `phase_seconds` gains `scan`. Reconcile with
-- current_after = current_before - deleted_rows + inserted_rows, and
-- |current_after| = desired_rows.
--
-- ── MEASURED ON THE CLONE (restored 2026-08-10; 2026-10-01) ────────────────
--
-- First CALL, against a clone whose size rows dated from 07-21: desired
-- 2,819,195 / deleted 79,103 / inserted 901,955 / updated 594,367, exactly
-- the independently computed delta. phase_seconds {scan 9.6, delete 8.2,
-- insert 102.7}, 134.3 s. |category after| = 2,819,195 = desired. The second
-- CALL stamped skipped_unchanged (12.2 s, the signature read). A third CALL,
-- forced past the gate, gave 2,819,195 / 0 / 0 / 0 with {scan 14.1, delete
-- 10.1, insert 4.4}, 30.5 s.
--
-- Cold plans in the steady state (VM page cache dropped, container restarted):
-- every hash is Batches: 1 under work_mem 256MB x hash_mem_multiplier 2.
-- Pre-count Hash Right Join 3.6 s / 202 MB; DELETE Hash Anti Join 2.8 s /
-- 218 MB; INSERT Hash Right Anti Join 4.7 s / 358 MB. Scaled to prod's
-- 4.42M rows, the INSERT's hash is ~560 MB, over the 512 MB hash_mem. Expect
-- Batches: 2 there and a few hundred MB of temp, not a GB. The temp table is
-- 362 MB heap + 133 MB index on the clone (~0.8 GB on prod), written through
-- 8 MB of temp_buffers.
--
-- Projected prod wall for a small delta: the clone's ~35 s cold, scaled by
-- prod/clone pages (FR rollup index x1.79, entity_tags heap x2.08), is
-- ~65 s. The x3.2 clone->prod factor cc-166 measured for an FR-shaped scan
-- brackets it at ~210 s. Adding the ~40 s signature read gives a bracket of
-- ~1.7-4.2 min, against 5,062.9 s.
--
-- `_insert()` changes its return shape (bigint -> OUT inserted, OUT updated), so
-- it is DROPped and re-created: CREATE OR REPLACE cannot change a return type.
-- Its only callers are the procedure and the wrapper, both re-created below.
-- The wrapper keeps `RETURNS bigint` (now inserted + updated, the rows written),
-- so heavy-rebuild.ts's allow-list and its `SELECT public.<fn>() AS count`
-- shape stay valid.
--
-- fix1128: NO SET clause on the PROCEDURE. It COMMITs, and a routine carrying
-- any SET clause runs atomic and cannot. The body below is PROD's
-- (pg_get_functiondef 2026-10-01, 0 differing lines against
-- 20260920080000:312-495). The edits are the weekly branch, four DECLAREs and
-- one stamp term. The daily branch, both EXCEPTION blocks, the lock, the
-- FIX-950 stand-down, `SET work_mem` and every COMMIT are verbatim. No routine
-- here carries planner GUCs or a statement_timeout.
--
-- NO `Fixes:` TRAILER. FIX-1248 closes by Pattern B on the second in-band
-- Tuesday (2026-10-13). The first stamped merge is the next scheduled
-- firing, Tue 2026-10-06 16:00 UTC.

-- ---------------------------------------------------------------------------
-- 1. _scan() — the desired set, materialised once
-- ---------------------------------------------------------------------------
-- A TEMP CTAS, as in the daily: CREATE TABLE AS is the one data-writing
-- statement still ELIGIBLE for a parallel plan. Here the planner does not use
-- it. On the clone (2026-10-01, cold) it chose a serial GroupAggregate over the
-- sorted Index Only Scan on financial_relationships_donation_size_rollup, with
-- no Gather: 21.8 s cold / 6.7 s warm for 6.58M rows -> 2.82M groups, 44.5k
-- index pages read. That is cheap enough not to chase.
--
-- Every reference to the temp table is schema-qualified `pg_temp.`. With
-- search_path 'public','pg_temp', an unqualified `fes_desired` resolves against
-- public FIRST, and a call made out of order would fail quietly instead of
-- with a loud 42P01.
CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_scan()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n bigint;
BEGIN
  -- Idempotent within a transaction: the test suite runs the trio twice to
  -- prove the second pass moves nothing, and ON COMMIT DROP does not help
  -- before the commit.
  DROP TABLE IF EXISTS pg_temp.fes_desired;

  CREATE TEMP TABLE fes_desired ON COMMIT DROP AS
  SELECT
    d.entity_id,
    CASE WHEN d.total_cents <    500000 THEN 'small_donation'
         WHEN d.total_cents <   5000000 THEN 'medium_donation'
         WHEN d.total_cents <  50000000 THEN 'large_donation'
         ELSE                                'major_donation'  END AS tag,
    CASE WHEN d.total_cents <    500000 THEN 'Small Donation'
         WHEN d.total_cents <   5000000 THEN 'Medium Donation'
         WHEN d.total_cents <  50000000 THEN 'Large Donation'
         ELSE                                'Major Donation'  END AS display_label,
    CASE WHEN d.total_cents <   5000000 THEN NULL
         WHEN d.total_cents <  50000000 THEN '💰'
         ELSE                                '💰💰'           END AS display_icon,
    CASE WHEN d.total_cents <    500000 THEN 'internal'
         WHEN d.total_cents <   5000000 THEN 'secondary'
         ELSE                                'primary'         END AS visibility,
    d.total_cents,
    jsonb_build_object('total_cents', d.total_cents) AS metadata
  FROM (
    SELECT fr.from_id AS entity_id,
           SUM(COALESCE(fr.amount_cents, 0))::bigint AS total_cents
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
    GROUP BY fr.from_id
  ) d;

  CREATE INDEX ON pg_temp.fes_desired (entity_id, tag);
  ANALYZE pg_temp.fes_desired;

  SELECT count(*) INTO n FROM pg_temp.fes_desired;
  RETURN n;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. _delete() — current \ desired on (entity_id, tag), behind two guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_delete()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n      bigint;
  v_cur  bigint;
  v_gone bigint;
  v_des  bigint;
BEGIN
  -- One pass for both guards: |current|, and how many of them have no
  -- (entity_id, tag) partner in the desired set. The temp table holds one row
  -- per entity_id, so the LEFT JOIN cannot multiply a current row.
  SELECT count(*), count(*) FILTER (WHERE d.entity_id IS NULL)
    INTO v_cur, v_gone
  FROM public.entity_tags t
  LEFT JOIN pg_temp.fes_desired d
    ON d.entity_id = t.entity_id
   AND d.tag       = t.tag
  WHERE t.entity_type  = 'financial_entity'
    AND t.generated_by = 'rule'
    AND t.tag_category = 'size';

  SELECT count(*) INTO v_des FROM pg_temp.fes_desired;

  IF v_cur > 0 AND v_des < v_cur * 0.5 THEN
    RAISE EXCEPTION
      'size_tags: desired set % vs current % — refusing a shrink past 50%% (a wrong-but-green truncated scan would otherwise delete the category)',
      v_des, v_cur;
  END IF;

  IF v_cur > 0 AND v_gone > v_cur * 0.10 THEN
    RAISE EXCEPTION
      'size_tags: % of % current rows have no desired partner — refusing a delete past 10%% (the steady state is thousands; this is a data event or a bug, and wants a supervised run)',
      v_gone, v_cur;
  END IF;

  -- A donor that left (no donation rows) or crossed a tier (its old tag is no
  -- longer the desired one). The second is half of a move; _insert adds the
  -- other half.
  DELETE FROM public.entity_tags t
  WHERE t.entity_type  = 'financial_entity'
    AND t.generated_by = 'rule'
    AND t.tag_category = 'size'
    AND NOT EXISTS (
      SELECT 1 FROM pg_temp.fes_desired d
      WHERE d.entity_id = t.entity_id
        AND d.tag       = t.tag
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. _insert() — desired \ current, and a moved total updated in place
-- ---------------------------------------------------------------------------
-- The anti-join skips a row that is already exactly right (same key, same
-- metadata). The label, icon and visibility are functions of `tag`, which is
-- in the key, so metadata is the only payload that can differ on a matched
-- key. What gets past it is either new (INSERT) or a same-tier donor whose
-- total moved (ON CONFLICT -> UPDATE). `xmax = 0` on the returned row tells
-- the two apart: a freshly inserted tuple has no xmax, and the new version
-- written by ON CONFLICT DO UPDATE carries the updating transaction's.
--
-- A conflicting row that the DO UPDATE's WHERE rejects returns nothing, so a
-- non-rule row on a desired key is counted in neither total.
DROP FUNCTION IF EXISTS public.rebuild_financial_entity_size_tags_insert();

CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_insert(OUT inserted bigint, OUT updated bigint)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  WITH w AS (
    INSERT INTO public.entity_tags (
      entity_type, entity_id, tag, tag_category, display_label, display_icon,
      visibility, confidence, generated_by, pipeline_version, metadata
    )
    SELECT
      'financial_entity', d.entity_id, d.tag, 'size', d.display_label, d.display_icon,
      d.visibility, 1.0, 'rule', 'v1', d.metadata
    FROM pg_temp.fes_desired d
    WHERE NOT EXISTS (
      SELECT 1 FROM public.entity_tags t
      WHERE t.entity_type  = 'financial_entity'
        AND t.entity_id    = d.entity_id
        AND t.tag          = d.tag
        AND t.tag_category = 'size'
        AND t.metadata     = d.metadata
    )
    ON CONFLICT (entity_type, entity_id, tag, tag_category) DO UPDATE
      SET metadata      = EXCLUDED.metadata,
          display_label = EXCLUDED.display_label,
          display_icon  = EXCLUDED.display_icon,
          visibility    = EXCLUDED.visibility
      WHERE entity_tags.metadata IS DISTINCT FROM EXCLUDED.metadata
        AND entity_tags.generated_by = 'rule'
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT count(*) FILTER (WHERE was_insert),
         count(*) FILTER (WHERE NOT was_insert)
    INTO inserted, updated
  FROM w;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The wrapper — scan, delete, insert; returns the rows written
-- ---------------------------------------------------------------------------
-- The return value CHANGES MEANING: it was the whole re-inserted set and it is
-- now inserted + updated. Its only reference outside this file is the
-- heavy-rebuild.ts allow-list, which has no live caller for this name.
CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ins bigint;
  v_upd bigint;
BEGIN
  PERFORM public.rebuild_financial_entity_size_tags_scan();
  PERFORM public.rebuild_financial_entity_size_tags_delete();
  SELECT i.inserted, i.updated INTO v_ins, v_upd
    FROM public.rebuild_financial_entity_size_tags_insert() i;
  RETURN v_ins + v_upd;
END;
$function$;

-- Grants restated in full (FIX-834 posture: Supabase default-grants EXECUTE to
-- anon and authenticated, and _scan and the re-created _insert are new objects).
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_size_tags_scan()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_size_tags_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_size_tags_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rebuild_financial_entity_size_tags()        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags_scan()   TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags()        TO service_role;

-- ---------------------------------------------------------------------------
-- 5. run_rule_taggers — the weekly branch calls the trio and stamps four counts
-- ---------------------------------------------------------------------------
-- The signature gate, the watermark advance, the subtransaction, its two
-- handlers and the COMMIT are unchanged. Only what runs between the gate and
-- the advance is new. The daily branch is byte-identical.
--
-- `inserted_rows` / `updated_rows` are stamped ABSENT, not null, on any branch
-- that did not measure them: the daily, and the weekly's skipped_unchanged.
-- That is the FIX-1178 (d)/(a) discipline for `phase_seconds` and
-- `desired_rows`, extended rather than re-invented.
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
        -- FIX-1248 — the MERGE, three phases, timed separately, all in the
        -- SAME transaction as the signature advance below, with no COMMIT
        -- between them: scan, then DELETE current\desired on (entity_id, tag),
        -- then INSERT desired\current with a moved total UPDATEd in place.
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
-- 6. The budget note (design D6). The note column is `note`, singular.
-- ---------------------------------------------------------------------------
-- The VALUE stays at 7,200 s until two post-merge runs give it a band. The
-- old note described the rewrite, so it would mislead whoever next sizes this.
UPDATE public.cron_job_budget
   SET note = 'FIX-1248: merge landed 2026-10-01 (scan / delete / insert in one transaction; was DELETE-all + INSERT-all of ~4.42M rows at 4,692-5,063 s). The previous note, "FIX-1063. Healthy max 2741s. Hit the 6h ceiling 2026-08-04; stranded a sync row 2026-08-18.", described the rewrite. 7,200 s stays until two in-band runs (2026-10-06, 2026-10-13) give a band, then resizes to ~3x the band high in the FIX-1248 Pattern-B close.',
       updated_at = now()
 WHERE jobname = 'rule-taggers-weekly';
