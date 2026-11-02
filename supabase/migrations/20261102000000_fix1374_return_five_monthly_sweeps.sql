-- =============================================================================
-- FIX-1374 — RETURN the five monthly orphan sweeps through job_registry as
-- `by … 1 * *` (each its cron slot). The last parked rows that return as `by`
-- rows (cc-258, plan step s12b-11 in docs/cc/projects/dispatcher.md). One
-- class-P push of this one file; no routine, no dial, no budget.
--
--   job                                   at → by          group      class   pipeline
--   donation-edge-orphan-sweep            30 11 1 * *      ec         memory  donation_edge_orphan_sweep
--   financial-entity-totals-reconcile     0 12 1 * *       fe-totals  io      financial_entity_totals_reconcile
--   donor-rollup-orphan-sweep             30 12 1 * *      rollups    memory  donor_rollup_orphan_sweep
--   donor-party-rollup-orphan-sweep       0 13 1 * *       rollups    io      donor_party_rollup_orphan_sweep
--   entity-connection-stats-orphan-sweep  30 13 1 * *      ec         io      entity_connection_stats_orphan_sweep
--
-- Every row: atomic, priority 5, cap 64, budget_seconds NULL, {prod_session},
-- idempotent_refire false, phase_lock false, yield_to {}, anchor_cadence NULL,
-- by_window_minutes NULL; one registry row per pipeline (rule 378).
--
-- WHAT, in one DO block (fix1371's shape, looped over the five rows in c_rows):
--   (1) ×5 the row `at <slot>` → `by <slot>`, matched on the exact old text;
--       an "already returned" NOTICE on the `by` text; anything else RAISEs
--       naming the row. The note carries the UTC date of the apply.
--   (2) ×5 the hold row is ASSERTED to be FIX-1311's takeover hold (held_since
--       set, hold_reason 'parked for the dispatcher cutover…', cadence_hours
--       NULL, note LIKE 'FIX-1311 (cc-232)%') or the gated push's own 'prod
--       session held: …' hold (rule 385). Only its note grows. It stays a
--       hold: the conversion to cadence_hours 744 is owed (cc-259). The
--       recipient_count_reconcile row (FIX-736's retired sweep) is not named.
--   (3) ×5 one owner: the cron of the same name inactive, by NAME, exactly one
--       row (FIX-946). No un-park, ever.
--   (4) a read-back that RAISEs on any miss: the five rules and every other
--       column, one registry row per pipeline, the five holds' shape and
--       notes, the five crons, the four pins. Printed as NOTICEs: the five
--       bodies' md5s and constants, the pick's arithmetic ×5 (prev / next
--       slot, the last complete|partial, DUE NOW + ttd), the premise (each
--       table's reltuples + heap pages, temp_bytes now, the 10-01 walls vs the
--       bands, the 3 h role ceiling as the only cancel), today's headroom for
--       a 64-cap row.
--   No pipeline_state write, no cron_job_budget write, no platform_dials write.
--
-- WHY. THE BODIES, ON PROD (cc-258 read 4, 2026-11-02 04:23Z; prod = clone):
-- all five are PROCEDUREs last CREATEd at 20261010020000 (FIX-1295 M3),
-- proconfig NULL, and share one shape:
--   pg_try_advisory_lock(hashtext('<proc>')) (a session lock; held → RETURN,
--   no row) → prod_session_state()->>'defer' → a `skipped` row and RETURN →
--   SET work_mem = '64MB'; SET max_parallel_workers_per_gather = 0 (M3; NEVER
--   run on prod: M3 landed 10-10, the park was 10-13, the slot is the 1st) →
--   a `running` row COMMITted (source pg_cron, kind orphan-sweep) → ONE
--   sub-block (financial-entity-totals-reconcile: THREE, A/B/C, each its own
--   COMMIT) → the terminal UPDATE. No START gate (no box_backoff_gate).
--     reconcile_donation_edge_orphans           26a26588… 5,085 B
--     reconcile_financial_entity_totals         f0710a7c… 7,633 B
--     reconcile_donor_rollup_orphans            cab2b74b… 4,662 B
--     reconcile_donor_party_rollup_orphans      fda377bb… 4,449 B
--     reconcile_entity_connection_stats_orphans 791e3ba3… 4,498 B
-- THE DELETE SEMANTICS. donation-edge DELETEs entity_connections rows WHERE
-- connection_type = 'donation' AND no financial_relationships row has the same
-- (from_type, from_id, to_type, to_id) with relationship_type IN ('donation',
-- 'ie_support'); rebuild_entity_connections_donations builds 'donation' edges
-- from exactly those two types and 'opposition' from ie_oppose (prod, read 4:
-- "-- donation + ie_support → 'donation'"), so the sweep deletes only edges
-- whose source rows are gone. The three _mv sweeps DELETE orphan rows from
-- official_donor_rollup_mv / donor_party_rollup_mv / entity_connection_stats_mv
-- (tables); fe-totals UPDATEs financial_entities totals / recipient_count to 0
-- for orphans (no DELETE). Each shares its exclusion group with the writer of
-- its table: ec (ec-crawl), rollups (donor-rollup-refresh, donor-party), fe-totals
-- (fe-crawl, fe-inbound).
-- THE WALLS (data_sync_log, every pre-M3 body SET 256MB in-body):
--   donation-edge  09-01 128.5 s · 10-01 135.5 s (0 deleted, every firing)
--   fe-totals      09-01 134.2 s · 10-01 155.3 s (38 zeroed: 19 + 0 + 19)
--   donor-rollup   09-01 3,390.2 s · 10-01 103.4 s (0 deleted)
--   donor-party    no 09-01 row · 10-01 290.4 s (0 deleted)
--   ecs            09-01 1,795.9 s (20) · 10-01 92.8 s (0 deleted)
-- The bands (bands.json, PROVISIONAL n=1, the 10-01 wall × 1.5) are 204 / 234
-- / 156 / 436 / 140 s — R5's bar for the M3 step, so in-band = M3's receipt.
--
-- THE CLOCK AT THE PUSH: prev slots 11-01 11:30 / 12:00 / 12:30 / 13:00 /
-- 13:30Z; each pipeline's last complete|partial is its 10-01 firing, older, so
-- all five are DUE at the push (ttd ≈ −17 h … −15 h). One arm per tick,
-- ordered (priority, ttd, job); the groups serialize each pair; ec-crawl and
-- fe-crawl (priority 2) cut in whenever due.
--
-- EXITS. A cancel (WHEN query_canceled) closes the row `partial`, canceled
-- true, the statement rolled back, and the procedure RETURNs normally: the
-- cron run and the reap read `succeeded`, and `partial` is ADVANCING — the
-- slot is satisfied until the next 1st, no I6 ladder. An error (WHEN OTHERS)
-- closes the row `failed` and the procedure still RETURNs (reap `succeeded`);
-- `failed` is non-advancing, so the I6 ladder re-arms it at reap + 1800 s.
-- The advisory lock held → no row; prod_session_state().defer → `skipped`;
-- both non-advancing.
--
-- NETS: budget NULL → the dispatched unit gets NO cron_job_budget row
-- (dispatch_one_unit: IF v_pick_budget IS NOT NULL), so the ONLY cancel is the
-- postgres role's 3 h statement_timeout, per statement (FIX-1185); the
-- cancel path above (partial, rolled back); the tick's memory rungs (swap
-- ceiling 1018, headroom 150: a 64-cap row needs MemAvailable ≥ 214) and its
-- box_is_saturated skip; the groups vs the crawls and the rollup writers;
-- max_concurrent_units 2; platform_dials.pause; the data revert below.
-- budget_seconds is the one-UPDATE dial if a sweep ever needs one — NOT
-- written here.
--
-- ROLLBACK (data):
-- scripts/fix1374-revert-return-five-monthly-sweeps.sql puts the five rows
-- back to `at …`, each matched on its `by` text. Nothing else: the hold rows'
-- notes stay, the crons stay parked.
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_pin_d CONSTANT text := 'd6a9073bcc4d9084b9d7994324a89b18';
  -- The five rows, in slot order: (job, old rule, new rule, pipeline, routine
  -- = the cron's CALL, class, group, the body's prod md5 (read 4), its
  -- query_canceled sub-blocks, its band's hi_s, the table it writes).
  c_rows  CONSTANT jsonb := '[
    {"job": "donation-edge-orphan-sweep",           "old_rule": "at 30 11 1 * *", "new_rule": "by 30 11 1 * *", "slot": "30 11 1 * *", "pipeline": "donation_edge_orphan_sweep",           "routine": "reconcile_donation_edge_orphans",           "cost_class": "memory", "grp": "ec",        "body_md5": "26a26588573220085174632fd2ce6c1b", "n_cancel": 1, "band_hi": 204, "target": "public.entity_connections"},
    {"job": "financial-entity-totals-reconcile",    "old_rule": "at 0 12 1 * *",  "new_rule": "by 0 12 1 * *",  "slot": "0 12 1 * *",  "pipeline": "financial_entity_totals_reconcile",    "routine": "reconcile_financial_entity_totals",         "cost_class": "io",     "grp": "fe-totals", "body_md5": "f0710a7c430963597d67c83d1467a368", "n_cancel": 3, "band_hi": 234, "target": "public.financial_entities"},
    {"job": "donor-rollup-orphan-sweep",            "old_rule": "at 30 12 1 * *", "new_rule": "by 30 12 1 * *", "slot": "30 12 1 * *", "pipeline": "donor_rollup_orphan_sweep",            "routine": "reconcile_donor_rollup_orphans",            "cost_class": "memory", "grp": "rollups",   "body_md5": "cab2b74b4be409426e5d469276950441", "n_cancel": 1, "band_hi": 156, "target": "public.official_donor_rollup_mv"},
    {"job": "donor-party-rollup-orphan-sweep",      "old_rule": "at 0 13 1 * *",  "new_rule": "by 0 13 1 * *",  "slot": "0 13 1 * *",  "pipeline": "donor_party_rollup_orphan_sweep",      "routine": "reconcile_donor_party_rollup_orphans",      "cost_class": "io",     "grp": "rollups",   "body_md5": "fda377bb4d6ba88572310dbce55f0fd1", "n_cancel": 1, "band_hi": 436, "target": "public.donor_party_rollup_mv"},
    {"job": "entity-connection-stats-orphan-sweep", "old_rule": "at 30 13 1 * *", "new_rule": "by 30 13 1 * *", "slot": "30 13 1 * *", "pipeline": "entity_connection_stats_orphan_sweep", "routine": "reconcile_entity_connection_stats_orphans", "cost_class": "io",     "grp": "ec",        "body_md5": "791e3ba3e669570fbb3eed89e2e08004", "n_cancel": 1, "band_hi": 140, "target": "public.entity_connection_stats_mv"}
  ]';
  v_day     text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  r         record;
  v_n       int;
  v_rule    text;
  v_row     public.rollup_watch_overrides%ROWTYPE;
  v_jobid   bigint;
  v_active  boolean;
  v_missing text[] := '{}';
  v_got     text;
  v_last    timestamptz;
  v_wall    numeric;
  v_prev    timestamptz;
  v_next    timestamptz;
  v_src     text;
  v_md5     text;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
  v_pages   bigint;
  v_tuples  bigint;
  v_temp    bigint;
  v_avail   int;
  v_head    int;
  v_box     jsonb;
BEGIN
  FOR r IN SELECT * FROM jsonb_to_recordset(c_rows) AS v(job text, old_rule text, new_rule text, slot text, pipeline text, routine text, cost_class text, grp text, body_md5 text, n_cancel int, band_hi int, target text) LOOP
    -- ── (1) the row: RETURN on its cron slot ───────────────────────────────
    UPDATE public.job_registry
       SET deadline_rule = r.new_rule,
           note          = note || '; RETURNED ' || v_day || ' (FIX-1374, cc-258): ' || r.new_rule || ' = its cron slot',
           updated_at    = now()
     WHERE job = r.job
       AND deadline_rule = r.old_rule;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      RAISE NOTICE '[fix1374] job_registry %: % → % (1 row)', r.job, r.old_rule, r.new_rule;
    ELSE
      SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = r.job;
      IF v_rule = r.new_rule THEN
        RAISE NOTICE '[fix1374] job_registry % already returned (%) — 0 rows', r.job, r.new_rule;
      ELSE
        RAISE EXCEPTION '[fix1374] job_registry % reads %, expected % or %',
          r.job, COALESCE(v_rule, '(no row)'), r.old_rule, r.new_rule;
      END IF;
    END IF;

    -- ── (2) the hold row: ASSERT FIX-1311's takeover hold; note only ────────
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = r.pipeline;
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1374] rollup_watch_overrides has no % row — expected FIX-1311''s takeover hold', r.pipeline;
    ELSIF NOT ((v_row.held_since IS NOT NULL
                AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
                AND v_row.cadence_hours IS NULL
                AND v_row.note LIKE 'FIX-1311 (cc-232)%')
               OR v_row.hold_reason LIKE 'prod session held: %')
          OR v_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION '[fix1374] % override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
        r.pipeline, v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
    END IF;
    UPDATE public.rollup_watch_overrides
       SET note       = note || '; ' || r.job || ' RETURNED ' || v_day || ' (FIX-1374) — hold kept, conversion to cadence_hours 744 owed (cc-259)',
           updated_at = now()
     WHERE pipeline = r.pipeline
       AND note LIKE 'FIX-1311 (cc-232)%'
       AND note NOT LIKE '%' || r.job || ' RETURNED % (FIX-1374)%';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[fix1374] rollup_watch_overrides %: FIX-1311''s hold kept (held_since %); note % (% row)',
      r.pipeline, v_row.held_since, CASE WHEN v_n = 1 THEN 'appended' ELSE 'already carries the RETURN' END, v_n;

    -- ── (3) one owner: the cron stays parked, by NAME (FIX-946) ─────────────
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = r.job;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1374] % cron.job rows named % — expected exactly 1', v_n, r.job;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = r.job;
    IF v_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION '[fix1374] cron % (jobid %) is active = % — the registry owns it; two owners', r.job, v_jobid, v_active;
    END IF;
    RAISE NOTICE '[fix1374] cron % (jobid %) inactive — registry owns it', r.job, v_jobid;
  END LOOP;

  -- ── (4) read-back — RAISE on any miss ─────────────────────────────────────
  FOR r IN SELECT * FROM jsonb_to_recordset(c_rows) AS v(job text, old_rule text, new_rule text, slot text, pipeline text, routine text, cost_class text, grp text, body_md5 text, n_cancel int, band_hi int, target text) LOOP
    v_got := NULL;
    SELECT deadline_rule INTO v_got FROM public.job_registry
     WHERE job = r.job AND runner = 'pg_cron' AND pipeline = r.pipeline
       AND unit_shape = 'atomic' AND unit_call = 'CALL public.' || r.routine || '();'
       AND priority = 5 AND cost_class = r.cost_class AND cap_mb = 64 AND exclusion_group = r.grp
       AND budget_seconds IS NULL AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL
       AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire
       AND anchor_cadence IS NULL
       AND note LIKE '%; RETURNED % (FIX-1374, cc-258): ' || r.new_rule || ' = its cron slot%';
    IF v_got IS DISTINCT FROM r.new_rule THEN
      v_missing := v_missing || format('%s rule %L (the row''s other columns unchanged? the RETURN note?)', r.job, v_got);
    END IF;
    SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = r.pipeline;
    IF v_n <> 1 THEN
      v_missing := v_missing || format('%s registry rows on %s (rule 378: a second row needs anchor_cadence)', v_n, r.pipeline);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                    WHERE pipeline = r.pipeline
                      AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%')
                           OR hold_reason LIKE 'prod session held: %')
                      AND retired_at IS NULL AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%'
                      AND note LIKE '%' || r.job || ' RETURNED % (FIX-1374)%') THEN
      v_missing := v_missing || format('%s hold row (FIX-1311''s hold + the FIX-1374 note)', r.pipeline);
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = r.job AND active) THEN
      v_missing := v_missing || format('cron %s active', r.job);
    END IF;
  END LOOP;

  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc WHERE proname = 'prod_op_gate'          AND pronamespace = 'public'::regnamespace;
  IF v_md5_b IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7'
     OR v_md5_d IS DISTINCT FROM c_pin_d
     OR v_md5_g IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6'
     OR v_md5_p IS DISTINCT FROM '1d3507cd4b71439f0cfff51cde49b9d8' THEN
    v_missing := v_missing || format('the pins: box_is_saturated %s / dispatch_one_unit %s / get_dispatcher_status %s / prod_op_gate %s',
                                     v_md5_b, v_md5_d, v_md5_g, v_md5_p);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1374] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1374] read-back ok: five rules by … 1 * *, every other column unchanged, one row per pipeline, five holds kept, five crons inactive; md5 % / % / % / %',
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;

  FOR r IN SELECT * FROM jsonb_to_recordset(c_rows) AS v(job text, old_rule text, new_rule text, slot text, pipeline text, routine text, cost_class text, grp text, body_md5 text, n_cancel int, band_hi int, target text) LOOP
    -- The body this premise reads (cc-258 read 4). A NOTICE, not a RAISE.
    SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc
     WHERE proname = r.routine AND pronamespace = 'public'::regnamespace;
    RAISE NOTICE '[fix1374] body: % md5 % % — work_mem 64MB %, parallel 0 %, query_canceled sub-blocks % (expected %), START gate %',
      r.routine, v_md5,
      CASE WHEN v_md5 = r.body_md5 THEN '(the body this premise reads)'
           ELSE '(DIFFERENT from the clone — re-read the shape)' END,
      CASE WHEN position('SET work_mem = ''64MB'';' IN v_src) > 0 THEN 'in-body' ELSE 'NOT FOUND' END,
      CASE WHEN position('SET max_parallel_workers_per_gather = 0;' IN v_src) > 0 THEN 'in-body' ELSE 'NOT FOUND' END,
      (length(v_src) - length(replace(v_src, 'WHEN query_canceled THEN', ''))) / length('WHEN query_canceled THEN'),
      r.n_cancel,
      CASE WHEN position('box_backoff_gate(' IN v_src) > 0 THEN 'PRESENT' ELSE 'none' END;

    -- The pick's arithmetic, read the way step 6 reads it (anchor_cadence NULL).
    v_last := NULL; v_wall := NULL;
    SELECT completed_at, round(EXTRACT(epoch FROM completed_at - started_at)::numeric, 1)
      INTO v_last, v_wall
      FROM public.data_sync_log
     WHERE pipeline = r.pipeline AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1;
    v_prev := public.cron_prev_slot(r.slot, now());
    v_next := public.cron_next_slot(r.slot, now());
    RAISE NOTICE '[fix1374] pick: % % (prev % / next %); its last complete|partial % (wall % s, band 0–% s); %',
      r.job, r.new_rule, v_prev, v_next, v_last, v_wall, r.band_hi,
      CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
           ELSE 'next due ' || v_next END;

    -- The premise: the table the sweep writes.
    SELECT relpages, reltuples::bigint INTO v_pages, v_tuples FROM pg_class WHERE oid = to_regclass(r.target);
    RAISE NOTICE '[fix1374] premise: % writes % (% reltuples, % heap pages); group %, class %, cap 64; budget NULL → the role''s 3 h per statement is the only cancel; a cancel = partial (advancing)',
      r.job, r.target, v_tuples, v_pages, r.grp, r.cost_class;
  END LOOP;

  SELECT relpages INTO v_pages FROM pg_class WHERE oid = to_regclass('public.financial_relationships');
  SELECT temp_bytes INTO v_temp FROM pg_stat_database WHERE datname = current_database();
  RAISE NOTICE '[fix1374] premise: financial_relationships heap % pages (every sweep anti-joins it); pg_stat_database.temp_bytes now % (the before-number for the sorts'' spill)',
    v_pages, v_temp;

  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1374] headroom now: %; box saturated % (%)',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 64 < v_head THEN format('%s MB avail − 64 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                v_avail, v_avail - 64, v_head, 64 + v_head)
         ELSE format('%s MB avail − 64 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 64, v_head) END,
    v_box->>'saturated', COALESCE(v_box->>'reason', '-');
END $$;
