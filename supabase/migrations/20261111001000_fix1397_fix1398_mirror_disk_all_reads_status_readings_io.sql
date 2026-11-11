-- =============================================================================
-- FIX-1397 + FIX-1398 — the mirror stores the root read COUNT; the status call
-- shows the io: rung. cc-267, 2026-11-11. Class P: two CREATE OR REPLACE.
--
-- (B1) record_box_health_mem(jsonb) — c_numeric gains 'disk_all_reads' and
--      'disk_all_reads_ps', the two keys the sampler emits from cc-267 on
--      (packages/db/src/box-health-store.ts: Σ node_disk_reads_completed_total
--      over the whole disks, and its rate). Nothing else in the body moves:
--      dispatcher-r16.test.ts compares the body with the array literal cut
--      out against fix1375's (20261108000000). NOT a pin. de9ebee7… → 5cc93c2ade0f9f6008154e3ffbf5276c.
--      Until this lands the mirror drops the two keys as ignored_keys; the
--      off-box ring stores them from the deploy on, so the receipts' Root
--      budget line (FIX-1397's receipt) does not wait on this file.
--
-- WHY (FIX-1397). cc-265 showed the ~142 GB/d of root reads that swap-in does
-- not explain cannot be attributed from bytes and fault counts (pgmajfault ×
-- 4 KiB is a floor). The read COUNT gives the mean read size: ~4–8 KiB is
-- page-sized (faults, swap: the memory ceiling spends the IO budget), 64 KiB
-- and up is file-backed sequential. Read 6 (prod, two scrapes 68.9 s apart at
-- 00:20Z, idle): root nvme0n1 212 reads/s, 7.9 MB/s, mean 36.4 KiB; /data
-- nvme1n1 3.6 reads/s, 15.0 KiB.
--
-- (B2) get_dispatcher_status() — ->'box' gains:
--        io                  the tick row's box->'io' {io_time_pct, all_mbps,
--                            reads_ps, busy_streak, throttle_until}
--        thresholds_io       its box->'thresholds'->'io' {ceiling, samples,
--                            mbps_floor, hold_min}; a row stamped before the
--                            rung falls back to the dials as they stand now
--        mirror_age_seconds  box->'memory'->'age_seconds'
--        mem_stale           box->'thresholds'->'memory'->'mem_stale'
--      and ->'dials' lists io_time_pct_ceiling, io_samples, io_mbps_floor and
--      io_throttle_hold_min. THE PIN MOVES (D10): 4c305237… → d6bb02aab3eb8c9625275227f564c5c9;
--      PIN_LINEAGE (packages/data/src/__tests__/lib/migration-text.ts) and
--      docs/cc/PROMPT_TEMPLATE.md §Database carry it.
--
-- THE KEY NAMES ARE READ, NOT THE PROMPT'S (cc-267 read 7, prod 00:09Z). The
-- tick writes box_is_saturated()->'readings' to dispatch_log.box, so the io
-- block is box->'io' (not box->'readings'->'io'), thresholds box->'thresholds'
-- ->'io', the mirror's age box->'memory'->'age_seconds' and mem_stale
-- box->'thresholds'->'memory'->'mem_stale'. The last tick read:
--   io {"all_mbps": 0.44, "reads_ps": 3.4, "busy_streak": 0, "io_time_pct": 0.2,
--       "throttle_until": null}; thresholds.io {"ceiling": 90, "samples": 3,
--       "hold_min": 60, "mbps_floor": 12}; memory.age_seconds 37; mem_stale false.
--
-- WHY (FIX-1398). cc-264 could not surface the rung here without moving a pin
-- its prompt forbade (contradiction 3); cc-266's stall showed why it matters:
-- the rung went blind on a stale mirror and nothing in the status call said so.
--
-- BOTH BODIES ARE PROD'S pg_get_functiondef (LF, rule 450) plus the hunks;
-- the guard refuses any other starting body. dispatch_one_unit stays pinned
-- exactly; box_is_saturated and prod_op_gate may already read file D's bodies
-- (this file is re-applied after it on the clone and by the suite).
--
-- ROLLBACK: scripts/fix1398-revert-status-readings-io.sql (both bodies back,
-- de9ebee7… and 4c305237…). IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_mem text;
  v_st  text;
BEGIN
  SELECT md5(prosrc) INTO v_mem FROM pg_proc WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_st  FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_mem IS DISTINCT FROM 'de9ebee733077a59dfe2959981f8e0c3' AND v_mem IS DISTINCT FROM '5cc93c2ade0f9f6008154e3ffbf5276c' THEN
    RAISE EXCEPTION '[fix1397] record_box_health_mem md5 % is neither fix1375''s de9ebee733077a59dfe2959981f8e0c3 nor this file''s — the mirror moved; rebuild this file on the live body',
      COALESCE(v_mem, '(no function)');
  END IF;
  IF v_st IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6' AND v_st IS DISTINCT FROM 'd6bb02aab3eb8c9625275227f564c5c9' THEN
    RAISE EXCEPTION '[fix1398] get_dispatcher_status md5 % is neither fix1354''s 4c30523742e280a4b48ea2ec390654d6 nor this file''s — the pin moved; rebuild this file on the live body',
      COALESCE(v_st, '(no function)');
  END IF;
  RAISE NOTICE '[fix1397/1398] guards: record_box_health_mem % · get_dispatcher_status %', v_mem, v_st;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (B1) record_box_health_mem() — two whitelist keys
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_box_health_mem(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_required CONSTANT text[] := ARRAY['mem_available_bytes', 'mem_total_bytes'];
  -- FIX-1375 (cc-259): the disk keys follow scrape_ms. The route OMITS an
  -- unratable rate; a null here RAISEs by design.
  c_numeric  CONSTANT text[] := ARRAY['mem_available_bytes', 'mem_total_bytes',
                                      'swap_total_bytes', 'swap_free_bytes',
                                      'load1', 'pswpin', 'pswpout', 'pgmajfault',
                                      'oom_kill', 'scrape_ms',
                                      'disk_read_mbps', 'disk_write_mbps', 'io_time_pct', 'io_queue',
                                      'disk_reads_ps', 'disk_writes_ps', 'disk_all_read_mbps', 'disk_all_write_mbps',
                                      'disk_clock_s', 'disk_read_bytes', 'disk_written_bytes', 'disk_reads',
                                      'disk_writes', 'disk_io_time_s', 'disk_io_weighted_s',
                                      'disk_all_read_bytes', 'disk_all_written_bytes',
                                      'disk_all_reads', 'disk_all_reads_ps'];
  v_at      timestamptz := now();
  v_k       text;
  v_value   jsonb := '{}'::jsonb;
  v_ignored text[] := ARRAY[]::text[];
  -- FIX-1375 (cc-264): the two keys this function derives. They are never
  -- accepted from the caller. The numeric CONSTANTs are the dials' DEFAULTs,
  -- used only when platform_dials has no row.
  c_derived             CONSTANT text[]  := ARRAY['io_busy_streak', 'io_throttle_until'];
  c_io_time_pct_ceiling CONSTANT numeric := 90;
  c_io_samples          CONSTANT int     := 3;
  c_io_mbps_floor       CONSTANT numeric := 12;
  c_io_throttle_hold_min CONSTANT int    := 60;
  v_ceiling  numeric;
  v_samples  int;
  v_floor    numeric;
  v_hold     int;
  v_prev     jsonb;
  v_streak   int;
  v_until    timestamptz;
  v_all_mbps numeric;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'record_box_health_mem: p must be a jsonb object' USING ERRCODE = '22023';
  END IF;

  FOREACH v_k IN ARRAY c_required LOOP
    IF jsonb_typeof(p->v_k) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'record_box_health_mem: % is required and must be a number', v_k
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (p->>'mem_total_bytes')::numeric <= 0
     OR (p->>'mem_available_bytes')::numeric < 0
     OR (p->>'mem_available_bytes')::numeric > (p->>'mem_total_bytes')::numeric THEN
    RAISE EXCEPTION 'record_box_health_mem: need 0 <= mem_available_bytes (%) <= mem_total_bytes (%)',
      p->>'mem_available_bytes', p->>'mem_total_bytes' USING ERRCODE = '22023';
  END IF;

  FOR v_k IN SELECT jsonb_object_keys(p - c_derived) LOOP
    IF v_k = ANY (c_numeric) THEN
      IF jsonb_typeof(p->v_k) <> 'number' THEN
        RAISE EXCEPTION 'record_box_health_mem: % must be a number, got %', v_k, jsonb_typeof(p->v_k)
          USING ERRCODE = '22023';
      END IF;
      v_value := v_value || jsonb_build_object(v_k, p->v_k);
    ELSIF v_k = 'route_at' THEN
      -- Cast to prove it parses; stored as the caller sent it.
      PERFORM (p->>'route_at')::timestamptz;
      v_value := v_value || jsonb_build_object('route_at', p->'route_at');
    ELSE
      v_ignored := v_ignored || v_k;
    END IF;
  END LOOP;

  -- FIX-1375 (cc-264): the busy streak and the throttle hold. The mirror keeps
  -- one row, so the streak is kept here: prev + 1 at or over the ceiling, 0 when
  -- rated below it, CARRIED when the sample carries no io_time_pct (the route
  -- omits a rate it cannot compute, and a gap over 6 min is exactly when the box
  -- is in trouble). io_throttle_until is set when the streak stands and the
  -- all-disk rate sits at the floor; it is kept while future, then absent.
  SELECT d.io_time_pct_ceiling, d.io_samples, d.io_mbps_floor, d.io_throttle_hold_min
    INTO v_ceiling, v_samples, v_floor, v_hold
    FROM public.platform_dials d WHERE d.id;
  v_ceiling := COALESCE(v_ceiling, c_io_time_pct_ceiling);
  v_samples := COALESCE(v_samples, c_io_samples);
  v_floor   := COALESCE(v_floor, c_io_mbps_floor);
  v_hold    := COALESCE(v_hold, c_io_throttle_hold_min);

  SELECT value INTO v_prev FROM public.pipeline_state WHERE key = 'box_health_mem';
  v_streak := COALESCE((v_prev->>'io_busy_streak')::int, 0);
  v_until  := (v_prev->>'io_throttle_until')::timestamptz;
  IF v_until <= v_at THEN
    v_until := NULL;
  END IF;
  IF p ? 'io_time_pct' THEN
    v_streak := CASE WHEN (p->>'io_time_pct')::numeric >= v_ceiling THEN v_streak + 1 ELSE 0 END;
  END IF;
  v_all_mbps := (p->>'disk_all_read_mbps')::numeric + (p->>'disk_all_write_mbps')::numeric;
  IF v_streak >= v_samples AND v_all_mbps <= v_floor THEN
    v_until := v_at + make_interval(mins => v_hold);
  END IF;
  v_value := v_value || jsonb_build_object('io_busy_streak', v_streak);
  IF v_until IS NOT NULL THEN
    v_value := v_value || jsonb_build_object('io_throttle_until', v_until);
  END IF;

  v_value := jsonb_build_object('at', v_at) || v_value;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('box_health_mem', v_value)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object('at', v_at, 'ignored_keys', to_jsonb(v_ignored));
END;
$function$;

REVOKE ALL ON FUNCTION public.record_box_health_mem(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_box_health_mem(jsonb) TO service_role;

COMMENT ON FUNCTION public.record_box_health_mem(jsonb) IS
  'FIX-1125 — the ON-box mirror of the memory series /api/cron/box-health scrapes every 2 min. Upserts '
  'pipeline_state.box_health_mem = {at (DB clock), route_at, mem_available_bytes, mem_total_bytes, swap_*, '
  'load1, …}. Validates keys (required numbers, consistent; unlisted keys dropped and returned as '
  'ignored_keys). Best-effort by design: the route writes the OFF-box Upstash ring FIRST, and a failure here '
  'never fails the route — the series exists to survive the box. FIX-1375: the /data disk rates (disk_read_mbps '
  '… io_time_pct … disk_all_write_mbps) and their raw counters are stored too; disk_device (a string) stays '
  'ignored, and a null rate RAISEs (the route omits one it cannot compute). cc-264: reads its previous row and '
  'writes two DERIVED keys, io_busy_streak and io_throttle_until (the dials io_time_pct_ceiling / io_samples / '
  'io_mbps_floor / io_throttle_hold_min); a caller cannot set either. FIX-1397 (cc-267): disk_all_reads (reads '
  'completed across every whole disk) and disk_all_reads_ps are stored too, so the receipts can divide root''s '
  'read bytes by its read count.';

-- ═══════════════════════════════════════════════════════════════════════════
-- (B2) get_dispatcher_status() — the io: rung in ->'box' and ->'dials'
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_dispatcher_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'cron'
AS $function$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_dials public.platform_dials%ROWTYPE;
  v_n     int;
  v_last  record;
  v_ticks int;
  v_dec   jsonb;
  v_live  jsonb := '[]'::jsonb;
  v_reg   jsonb;
  v_job   jsonb;
  v_box   record;  -- FIX-1354: the newest tick row that carries box readings
  v_stale int;     -- FIX-1354: ticks in 24 h whose memory mirror was stale
BEGIN
  SELECT * INTO v_dials FROM public.platform_dials WHERE id;
  v_n := GREATEST(1, ceil(COALESCE(v_dials.tick_seconds, 120) / 60.0))::int;

  SELECT l.ticked_at, l.source, l.decision, l.job, l.reason, l.excluded INTO v_last
    FROM public.dispatch_log l
   WHERE l.decision NOT IN ('reaped', 'missed', 'unsupported_deadline')
   ORDER BY l.ticked_at DESC
   LIMIT 1;

  SELECT count(*) INTO v_ticks
    FROM public.dispatch_log l
   WHERE l.ticked_at > v_now - interval '60 minutes'
     AND l.source = 'pg_cron'
     AND l.decision NOT IN ('reaped', 'missed', 'unsupported_deadline');

  SELECT COALESCE(jsonb_object_agg(d.decision, d.n), '{}'::jsonb) INTO v_dec
    FROM (SELECT l.decision, count(*) AS n FROM public.dispatch_log l
           WHERE l.ticked_at > v_now - interval '24 hours'
           GROUP BY l.decision) d;

  IF EXISTS (SELECT 1 FROM public.dispatch_log a
              WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
                AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                                 WHERE x.armed_jobid = a.armed_jobid
                                   AND x.decision IN ('reaped', 'missed'))) THEN
    -- I2 (FIX-1316): the live rows first, then one floored LATERAL each.
    WITH live AS MATERIALIZED (
      SELECT a.id, a.job, a.armed_jobid, a.armed_jobname, a.armed_for, a.runid_floor
        FROM public.dispatch_log a
       WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'
         AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x
                          WHERE x.armed_jobid = a.armed_jobid
                            AND x.decision IN ('reaped', 'missed'))
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'job', a.job, 'armed_jobname', a.armed_jobname, 'armed_for', a.armed_for,
             'run_status', COALESCE(rd.status, 'not started')) ORDER BY a.id), '[]'::jsonb)
      INTO v_live
      FROM live a
      LEFT JOIN LATERAL (SELECT d.status FROM cron.job_run_details d
                          WHERE d.jobid = a.armed_jobid
                            AND d.runid > COALESCE(a.runid_floor, 0)
                          ORDER BY d.runid DESC LIMIT 1) rd ON true;
  END IF;
  -- N2 (FIX-1336): a GHA arm is a request stamp, live until its reap.
  SELECT v_live || COALESCE(jsonb_agg(jsonb_build_object(
           'job', ps.value->>'job', 'armed_jobname', ps.key, 'armed_for', ps.value->'requested_at',
           'run_status', CASE WHEN ps.value->>'consumed_at' IS NULL THEN 'requested'
                              ELSE 'dispatch ' || COALESCE(ps.value->>'outcome', '?') END) ORDER BY ps.key), '[]'::jsonb)
    INTO v_live
    FROM public.pipeline_state ps
   WHERE ps.key LIKE 'gha_dispatch_request_%' AND ps.value->>'reaped_at' IS NULL;

  SELECT jsonb_build_object(
           'rows',      count(*),
           'eligible',  count(*) FILTER (WHERE j.deadline_rule NOT LIKE 'at %'
                                           AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$')),
           'by_runner', (SELECT COALESCE(jsonb_object_agg(x.runner, x.n), '{}'::jsonb)
                           FROM (SELECT runner, count(*) AS n FROM public.job_registry GROUP BY runner) x))
    INTO v_reg
    FROM public.job_registry j;

  SELECT jsonb_build_object('jobid', c.jobid, 'active', c.active, 'schedule', c.schedule,
                            'budget_seconds', b.budget_seconds)
    INTO v_job
    FROM cron.job c
    LEFT JOIN public.cron_job_budget b ON b.jobname = c.jobname
   WHERE c.jobname = 'dispatcher-tick';

  -- FIX-1354: armed and box-skipped rows carry the box readings (nothing_due
  -- rows do not); mem_stale counts the gate-evaluated ticks it failed open on.
  SELECT l.ticked_at, l.decision, l.box INTO v_box
    FROM public.dispatch_log l
   WHERE l.box IS NOT NULL
   ORDER BY l.ticked_at DESC
   LIMIT 1;
  SELECT count(*) INTO v_stale
    FROM public.dispatch_log l
   WHERE l.ticked_at > v_now - interval '24 hours'
     AND l.box->'thresholds'->'memory'->>'mem_stale' = 'true';

  RETURN jsonb_build_object(
    'last_tick_at',       v_last.ticked_at,
    'last_tick_source',   v_last.source,
    'last_decision',      v_last.decision,
    'last_job',           v_last.job,
    'last_reason',        v_last.reason,
    'last_excluded',      v_last.excluded,
    'ticks_60m',          v_ticks,
    'expected_ticks_60m', floor(58.0 / v_n)::int + 1,
    'decisions_24h',      v_dec,
    'live',               v_live,
    'box', CASE WHEN v_box.ticked_at IS NULL THEN NULL ELSE jsonb_build_object(
             'ticked_at',         v_box.ticked_at,
             'decision',          v_box.decision,
             'memory',            v_box.box->'memory',
             'thresholds_memory', v_box.box->'thresholds'->'memory',
             -- FIX-1398 (cc-267): the io: rung, from the same tick row as memory.
             -- thresholds_io is what that tick read; a row stamped before the
             -- rung (cc-264) falls back to the dials as they stand now. The
             -- mirror's age and mem_stale sit beside io, so a blind rung (a
             -- stale mirror, cc-266) shows in the status call.
             'io',                 v_box.box->'io',
             'thresholds_io',      COALESCE(v_box.box->'thresholds'->'io',
                                            CASE WHEN v_dials.id IS NULL THEN NULL ELSE jsonb_build_object(
                                              'ceiling',    v_dials.io_time_pct_ceiling,
                                              'samples',    v_dials.io_samples,
                                              'mbps_floor', v_dials.io_mbps_floor,
                                              'hold_min',   v_dials.io_throttle_hold_min) END),
             'mirror_age_seconds', v_box.box->'memory'->'age_seconds',
             'mem_stale',          v_box.box->'thresholds'->'memory'->'mem_stale') END,
    'mem_stale_ticks_24h', v_stale,
    'dials', CASE WHEN v_dials.id IS NULL THEN NULL ELSE jsonb_build_object(
               'pause',                v_dials.pause,
               'tick_seconds',         v_dials.tick_seconds,
               'unit_target_seconds',  v_dials.unit_target_seconds,
               'max_concurrent_units', v_dials.max_concurrent_units,
               'max_live_caps_mb',     v_dials.max_live_caps_mb,
               'headroom_target_mb',   v_dials.headroom_target_mb,
               'swap_ceiling_mb',      v_dials.swap_ceiling_mb,
               'rearm_cooldown_seconds', v_dials.rearm_cooldown_seconds,
               'io_time_pct_ceiling',  v_dials.io_time_pct_ceiling,
               'io_samples',           v_dials.io_samples,
               'io_mbps_floor',        v_dials.io_mbps_floor,
               'io_throttle_hold_min', v_dials.io_throttle_hold_min,
               'updated_at',           v_dials.updated_at) END,
    'registry',           v_reg,
    'tick_job',           v_job,
    'generated_at',       v_now);
END;
$function$;

ALTER FUNCTION public.get_dispatcher_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_dispatcher_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_dispatcher_status() TO service_role;

COMMENT ON FUNCTION public.get_dispatcher_status() IS
  'FIX-1308 — the dispatcher at a glance: last tick (any source), pg_cron ticks in the last 60 min vs what the '
  'schedule fires, decisions in the last 24 h, the live one-shots with their run status, the seven dials, '
  'registry counts, and the tick job''s active/schedule/budget. One read for the /dashboard tile (via the status '
  'snapshot) and the receipts'' §9 line. SECURITY DEFINER (owner postgres) because it reads cron.job. runid '
  'floor (FIX-1316): live[] reads each one-shot''s run rows above its arm''s floor; re-arm cooldown dial in '
  'dials. last_excluded (FIX-1333, cc-239): the newest tick row''s dispatch_log.excluded. N2 (FIX-1336, cc-243): '
  'live[] also lists a GHA request stamp not yet reaped (run_status requested | dispatch <outcome>); '
  'registry.eligible counts what the pick admits (pg_cron, or a gha-dispatch:<stem> unit_call). FIX-1354 '
  '(cc-251): dials.swap_ceiling_mb; box = the newest tick row carrying box readings {ticked_at, decision, '
  'memory, thresholds_memory}; mem_stale_ticks_24h = such rows in 24 h whose memory mirror was stale (the gate '
  'failed open on them). FIX-1398 (cc-267): box also carries io (that tick row''s box->''io''), thresholds_io (its '
  'box->''thresholds''->''io'', else the dials now), mirror_age_seconds and mem_stale; dials lists '
  'io_time_pct_ceiling / io_samples / io_mbps_floor / io_throttle_hold_min.';

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_md5_m   text;
  v_md5_g   text;
  v_md5_d   text;
  v_md5_b   text;
  v_md5_p   text;
  v_cfg     text;
  v_src     text;
  v_status  jsonb;
  v_dials   public.platform_dials%ROWTYPE;
  v_k       text;
BEGIN
  SELECT md5(prosrc), prosrc INTO v_md5_m, v_src FROM pg_proc WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc WHERE proname = 'prod_op_gate'          AND pronamespace = 'public'::regnamespace;

  IF v_md5_m IS DISTINCT FROM '5cc93c2ade0f9f6008154e3ffbf5276c' THEN
    v_missing := v_missing || format('record_box_health_mem md5 %s, expected 5cc93c2ade0f9f6008154e3ffbf5276c', v_md5_m)::text;
  END IF;
  IF v_md5_g IS DISTINCT FROM 'd6bb02aab3eb8c9625275227f564c5c9' THEN
    v_missing := v_missing || format('get_dispatcher_status md5 %s, expected d6bb02aab3eb8c9625275227f564c5c9', v_md5_g)::text;
  END IF;
  IF v_md5_d IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18' THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s moved (expected d6a9073bcc4d9084b9d7994324a89b18)', v_md5_d)::text;
  END IF;
  IF v_md5_b IS NULL OR v_md5_b NOT IN ('aaf6cc6552df532eff4a9b21e9780670', 'b05961ca6d1cf7e56874071bfe334da1') THEN
    v_missing := v_missing || format('box_is_saturated md5 %s, expected aaf6cc6552df532eff4a9b21e9780670 or file D''s b05961ca6d1cf7e56874071bfe334da1', v_md5_b)::text;
  END IF;
  IF v_md5_p IS NULL OR v_md5_p NOT IN ('6488601cf8c09287d540989c0e0fd074', '70a799ab3df2484fc424fe2762ffa797') THEN
    v_missing := v_missing || format('prod_op_gate md5 %s, expected 6488601cf8c09287d540989c0e0fd074 or file D''s 70a799ab3df2484fc424fe2762ffa797', v_md5_p)::text;
  END IF;

  -- The whitelist carries the two keys (no dry call: a call would overwrite the live mirror).
  IF position('''disk_all_reads'', ''disk_all_reads_ps''' IN v_src) = 0 THEN
    v_missing := v_missing || 'record_box_health_mem c_numeric lacks disk_all_reads / disk_all_reads_ps'::text;
  END IF;
  -- proconfig as before (check:proconfig's census unchanged).
  SELECT array_to_string(proconfig, ',') INTO v_cfg FROM pg_proc WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  IF v_cfg IS DISTINCT FROM 'search_path=public, pg_catalog' THEN
    v_missing := v_missing || format('record_box_health_mem proconfig %L', v_cfg)::text;
  END IF;
  SELECT array_to_string(proconfig, ',') INTO v_cfg FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_cfg IS DISTINCT FROM 'search_path=public, pg_catalog, cron' THEN
    v_missing := v_missing || format('get_dispatcher_status proconfig %L', v_cfg)::text;
  END IF;

  -- The self-check (fix1354 :1569's shape): the new keys, read through the call.
  v_status := public.get_dispatcher_status();
  SELECT * INTO v_dials FROM public.platform_dials WHERE id;
  FOREACH v_k IN ARRAY ARRAY['io_time_pct_ceiling', 'io_samples', 'io_mbps_floor', 'io_throttle_hold_min'] LOOP
    IF NOT (v_status->'dials' ? v_k) THEN
      v_missing := v_missing || format('get_dispatcher_status dials lacks %s', v_k)::text;
    END IF;
  END LOOP;
  IF (v_status->'dials'->>'io_samples')::int IS DISTINCT FROM v_dials.io_samples THEN
    v_missing := v_missing || format('dials.io_samples %s, platform_dials %s', v_status->'dials'->>'io_samples', v_dials.io_samples)::text;
  END IF;
  IF jsonb_typeof(v_status->'box') = 'object' THEN
    FOREACH v_k IN ARRAY ARRAY['ticked_at', 'decision', 'memory', 'thresholds_memory', 'io', 'thresholds_io', 'mirror_age_seconds', 'mem_stale'] LOOP
      IF NOT (v_status->'box' ? v_k) THEN
        v_missing := v_missing || format('get_dispatcher_status box lacks %s', v_k)::text;
      END IF;
    END LOOP;
    IF jsonb_typeof(v_status->'box'->'thresholds_io') IS DISTINCT FROM 'object' THEN
      v_missing := v_missing || format('box.thresholds_io %s, expected an object', v_status->'box'->'thresholds_io')::text;
    END IF;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1397/1398] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1397/1398] md5 record_box_health_mem % (was de9ebee733077a59dfe2959981f8e0c3) / get_dispatcher_status % (was 4c30523742e280a4b48ea2ec390654d6)', v_md5_m, v_md5_g;
  RAISE NOTICE '[fix1397/1398] unchanged: dispatch_one_unit % · box_is_saturated % · prod_op_gate %', v_md5_d, v_md5_b, v_md5_p;
  RAISE NOTICE '[fix1398] box io % · thresholds_io % · mirror_age_seconds % · mem_stale % · dials io % / % / % / %',
    v_status->'box'->'io', v_status->'box'->'thresholds_io', v_status->'box'->'mirror_age_seconds', v_status->'box'->'mem_stale',
    v_status->'dials'->'io_time_pct_ceiling', v_status->'dials'->'io_samples', v_status->'dials'->'io_mbps_floor', v_status->'dials'->'io_throttle_hold_min';
END $$;
