-- =============================================================================
-- FIX-974 (follow-up) — make the bulk regime's from_type invariant FAIL LOUD.
--
-- The bulk regime derives all six arms from ONE scan of
-- financial_relationships_donor_rollup_idx, whose partial-index predicate is
--
--     WHERE relationship_type IN ('donation','ie_support','ie_oppose')
--       AND from_type = 'financial_entity'
--
-- Five of the six arms filter `from_type = 'financial_entity'` in their live
-- per-recipient bodies too, so for them the index scope IS the arm's scope.
--
-- Arm 2 (`official_donor_totals`, FIX-836) is the exception. Its live body is:
--
--     WHERE fr.to_type = 'official' AND fr.relationship_type = 'donation'
--       AND fr.to_id = ANY (p_recipients)          -- NO from_type predicate
--
-- so it is defined more broadly than the index can see. Measured on prod
-- 2026-08-07, the difference is empty — ALL 4,098,213 donation→official rows
-- are `from_type = 'financial_entity'`, a single group — which is why the
-- byte-identity proof against the per-recipient path passed on every arm.
-- `small_dollar_rebuild_officials` already leans on the same invariant and says
-- so in a comment ("100% of donation→official; enables the FIX-704 idx").
--
-- But "equal because the difference happens to be empty" is not the same as
-- "equal". If a donation→official row ever lands with from_type <> 'financial_
-- entity' — a new ingest path, an agency-sourced contribution, a bad merge —
-- the per-recipient regime would count it and the bulk regime would not, and
-- `official_donor_totals` would silently understate that official. Nothing
-- would raise, and the two regimes would disagree depending on which one last
-- touched the recipient. That is precisely the silent-divergence class this
-- repo keeps paying for.
--
-- So: assert it at sweep start. One indexed probe against
-- financial_relationships_derivation (relationship_type, from_type, from_id,
-- to_type, to_id), bounded by LIMIT 1 — it costs nothing and it converts a
-- future silent wrong number into an immediate, named failure. The check runs
-- BEFORE any arm is written, so a violating sweep writes nothing at all.
--
-- Body rebuilt from the migration text applied minutes earlier
-- (20260807000000); no other behaviour changes.
--
-- Cross-ref FIX-974, FIX-836, FIX-776, FIX-704.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.donor_rollup_bulk_assert_invariants()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_bad_from_type text;
BEGIN
  -- Arm 2 is defined without a from_type predicate; the bulk regime can only
  -- see from_type='financial_entity'. If that gap is ever non-empty the two
  -- regimes disagree, so refuse rather than publish a quietly-low number.
  SELECT fr.from_type INTO v_bad_from_type
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type   = 'official'
    AND fr.from_type <> 'financial_entity'
  LIMIT 1;

  IF v_bad_from_type IS NOT NULL THEN
    RAISE EXCEPTION
      'donor_rollup_rebuild_bulk(): donation->official rows exist with from_type=% . '
      'The bulk regime reads financial_relationships_donor_rollup_idx, whose partial '
      'predicate is from_type=''financial_entity'', so official_donor_totals (arm 2, '
      'which has no from_type predicate) would understate those officials. Widen the '
      'bulk scan or the index before running this again.', v_bad_from_type;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.donor_rollup_bulk_assert_invariants() IS
  'FIX-974 — preconditions for donor_rollup_rebuild_bulk(). Asserts that every '
  'donation->official row is from_type=''financial_entity'', which is what makes '
  'the index-only bulk scan equivalent to arm 2''s broader per-recipient '
  'definition. Measured empty on prod 2026-08-07 (4,098,213 rows, one group); '
  'this makes a future violation fail loud instead of silently understating '
  'official_donor_totals.';

REVOKE ALL ON FUNCTION public.donor_rollup_bulk_assert_invariants() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.donor_rollup_bulk_assert_invariants() TO service_role;


-- Wire the assertion into the fresh-sweep path. Only two lines differ from
-- 20260807000000: the PERFORM below, and this comment.
CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()
LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_state_key  text   := 'donor_rollup_bulk_sweep';
  c_global     uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks     int    := 32;      -- must divide 256 (uuid first-byte ranges)
  c_budget     interval := interval '4 hours 30 minutes';
  c_max_sweep  interval := interval '48 hours';

  v_state      jsonb;
  v_cursor     int;
  v_mode       text;
  v_resumed    boolean := false;
  v_restarted  text    := NULL;
  v_sweep_beg  timestamptz;
  v_sweep_tgt  timestamptz;
  v_watermark  timestamptz;
  v_log_id     uuid;
  v_cfg        int;
  v_cfg_txt    text;
  v_step       int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_n_targets  int := 0;
  v_n_offic    int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_done       int := 0;
  k            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_bulk', 'skipped', now(), now(),
            jsonb_build_object('skip_reason',
              'advisory lock held by a concurrent donor-rollup refresh (incremental or bulk)'));
    RAISE NOTICE '[donor-rollup bulk] advisory lock held — skipping';
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

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);
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
    -- FIX-974 follow-up: assert the from_type invariant BEFORE anything is
    -- written, so a violating sweep publishes nothing at all.
    PERFORM public.donor_rollup_bulk_assert_invariants();

    SELECT MAX(fr.updated_at) INTO v_sweep_tgt
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

    TRUNCATE public._drb_targets;
    IF v_mode = 'full' OR v_watermark IS NULL THEN
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
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
          AND fr.updated_at > v_watermark
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    END IF;

    TRUNCATE public._drb_fe;
    INSERT INTO public._drb_fe (id, display_name, entity_type, state, industry_tag, industry_label)
    SELECT fe.id, fe.display_name, fe.entity_type, fe.metadata->>'state',
           t.tag, t.display_label
    FROM public.financial_entities fe
    LEFT JOIN (
      SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag, et.display_label
      FROM public.entity_tags et
      WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
      ORDER BY et.entity_id, et.tag
    ) t ON t.entity_id = fe.id;

    ANALYZE public._drb_targets;
    ANALYZE public._drb_fe;

    v_sweep_beg := now();
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks),
          updated_at = clock_timestamp();
  END IF;

  SELECT count(*), count(*) FILTER (WHERE is_official) INTO v_n_targets, v_n_offic
  FROM public._drb_targets;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_bulk', 'running', now(),
          jsonb_build_object(
            'shape', 'to_id-range chunks, one FR scan per chunk, six arms derived',
            'mode', v_mode, 'chunks', c_chunks,
            'targets', v_n_targets, 'target_officials', v_n_offic,
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'sweep_target', v_sweep_tgt,
            'budget_seconds', EXTRACT(epoch FROM c_budget)))
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_chunk > 0
       AND v_elapsed + (v_max_chunk * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[donor-rollup bulk] budget guard — stopping before chunk % (elapsed %s, slowest %s)',
        k, round(v_elapsed)::int, round(v_max_chunk)::int;
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
        (official_id, total_cents, pac_cents, individual_cents, donor_count)
      SELECT d.to_id,
             SUM(d.total_cents0)::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
             SUM(d.tx_count)::bigint
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
      SELECT d.to_id, SUM(d.small_cents)::bigint, SUM(d.small_count)::bigint, now()
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
             now()
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
         SET value = value || jsonb_build_object('chunk_cursor', k),
             updated_at = clock_timestamp()
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;

    v_done := v_done + 1;
    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    RAISE NOTICE '[donor-rollup bulk] chunk %/% done (%s, % arm-1 rows so far)',
      k + 1, c_chunks, round(v_chunk_secs)::int, v_rows;
  END LOOP;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = now(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  IF v_budget_hit THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = now(), rows_inserted = v_rows,
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
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
          jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, now())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, now())::text),
        updated_at = clock_timestamp();

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', now()::text,
                                    'mode', v_mode, 'chunks', c_chunks,
                                    'targets', v_n_targets),
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  TRUNCATE public._drb_donor;
  TRUNCATE public._drb_chunk_fe;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = now(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'chunks_done_this_run', v_done,
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
           'watermark_advanced_to', v_sweep_tgt)
   WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup bulk] complete — % targets, % arm-1 rows', v_n_targets, v_rows;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;
