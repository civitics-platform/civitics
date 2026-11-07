-- =============================================================================
-- FIX-1375 (the rung half) — the io: rung. box_is_saturated() gains two reasons,
-- io_saturated and io_throttled, read from a busy streak and a throttle hold that
-- record_box_health_mem() keeps on the mirror. cc-264, 2026-11-07.
--
-- DESIGN: docs/audits/2026-11-02-io-budget-census.md §8 (§6 is the calibration).
-- Prompt: cc-prompt-264-io-rung-box-is-saturated-gate-d-3h-class-p-platform-
-- counts-estimated-pg-buffercache-fix1381-decide.md, D1 and D2.
--
-- WHY. The dispatcher and the gate read memory, probe age and fork failures, and
-- nothing IO. The 11-02 post-landing throttle (03:51 → 08:07Z, 270 startup
-- timeouts, five units at 6–28× their walls) armed a heavy unit into each clean
-- 15-min bucket because nothing read the disk. The census reads this rung as
-- refusing the 04:47–04:57Z, 06:01Z and 06:37Z arms and leaving the 03:51Z ecs
-- window alone. That is its inference from the walls: the sampler started 11-03,
-- so no io_time_pct sample from 11-02 exists to run it over.
--
-- THE REPLAY THE RING CAN DO (cc-264 read 3, ring 11-05 23:44Z → 11-07 05:42Z, the
-- only samples at or over 90 %): one lone 100 % at 11-06 21:14Z, then the sweep
-- chain, 11-07 01:14 / :16 / :18 / :20 / :22Z at 100 / 95.9 / 100 / 100 / 96.6 %
-- and 31–51 MB/s. The streak reaches 3 at 01:18Z and clears at 01:24Z.
-- io_throttled never fires (MB/s ≫ 12). donor-party's 01:17:11Z arm is admitted;
-- fe-crawl's 01:21:11Z and the ecs sweep's 01:23:00Z arms wait for the first tick
-- after 01:24Z. It refuses the stack, not the chain.
--
-- THE TWO REASONS. Checked AFTER memory and BEFORE watchdog_wall, in
-- box_is_saturated(), so the tick's skip row reads `box: io_saturated` /
-- `box: io_throttled` (the `box: ` prefix is dispatch_one_unit's; the audit's
-- "io: saturated" is these two tokens). io_throttled comes first because its
-- hold outlives the streak. Only a FRESH mirror reads them, the memory rule's own
-- mem_stale test: a stale or absent mirror leaves the rung silent (fail-open,
-- counted by mem_stale). The reason `stale` remains the on-box probe's.
--
-- WHO READS THE VERDICT (a census the prompt's grep missed; Craig ruled, cc-264:
-- inherit and document). The rung excludes every ARM at dispatch_one_unit's step
-- 4, and no cancel path reads it. But it is a box_is_saturated() reason, so it
-- reaches every reader of that function, exactly as memory and stale do:
--   box_backoff_gate()              unit START: donor_rollup_rebuild_bulk (600 s),
--                                   refresh_agency_staffing_rollup (600 s),
--                                   refresh_contract_flow_rollups (1800 s),
--                                   run_rule_taggers('weekly') (600 s)
--   each chunk, mid-unit            donor_rollup_rebuild_bulk (partial, resumable;
--                                   stale_after 12 hours makes the rest wait 12 h)
--                                   refresh_agency_staffing_rollup (no cursor: the
--                                   next firing redoes the whole dirty set)
-- So a running chunked unit backs off at its next chunk boundary. That is
-- cooperative and never a cancel, but it is not "never touches a running unit".
-- A donor bulk's own IO could trip it; Monday's receipt reads whether it did.
--
-- THE KEYS (both DERIVED, stripped from the input, never accepted from a caller):
--   io_busy_streak     int, always written. prev + 1 when io_time_pct >= the
--                      ceiling; 0 when rated below it; CARRIED when the sample
--                      carries no io_time_pct (the route omits an unratable rate).
--   io_throttle_until  timestamptz, written only while set. at + hold when the new
--                      streak >= io_samples AND disk_all_read_mbps +
--                      disk_all_write_mbps <= io_mbps_floor; kept while future.
--
-- THE DIALS (platform_dials columns, one row; read live by both routines, with
-- the DEFAULTs as constant fallbacks):
--   io_time_pct_ceiling  90   the IOPS ceiling reads 97–100 %, idle < 1 %. 101 is
--                             THE BRAKE: the sampler clamps at 100, so no sample
--                             can reach it and the streak stays 0. (The prompt's
--                             CHECK 50..100 would have refused its own brake.)
--   io_samples           3    ~6 min at the 2-min cadence; one ecs window is ~4
--                             min, so this catches the second window, not the first
--   io_mbps_floor        12   the 87 Mbps baseline is ~10.9 MB/s
--   io_throttle_hold_min 60   a throttle ends when the bucket refills, not when
--                             the unit stops
--
-- THE IN-SESSION BRAKE: UPDATE public.platform_dials SET io_time_pct_ceiling = 101.
-- It disarms the streak on the next sample with no body change. A hold already
-- set stands until it expires (io_throttle_hold_min = 0 does not clear it).
--
-- WHAT DOES NOT CHANGE: box_is_saturated's signature; dispatch_one_unit and
-- get_dispatcher_status, whose pins may not move here (the read-back RAISEs if
-- either did). `box: ` + reason is already the tick's rendering, and the tick
-- writes v_box->'readings' to dispatch_log.box, so readings.io is on every skip and
-- arm row. get_dispatcher_status()->'box' projects only memory and thresholds_memory,
-- and dials lists its own keys, so neither shows the rung: read dispatch_log.box or
-- box_is_saturated(). The route needs no code: the keys are written inside the RPC.
--
-- CLASS: P. An ADD COLUMN ×4 on a one-row table with constant defaults (no
-- rewrite), two CREATE OR REPLACE, the comments, a read-back.
--
-- ROLLBACK: scripts/fix1375-revert-io-rung.sql (both bodies, then DROP COLUMN ×4;
-- file B's revert goes first, it reads io_samples). The mirror row keeps the two
-- derived keys until the next sample, harmlessly. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_mem text;
  v_box text;
BEGIN
  SELECT md5(prosrc) INTO v_mem FROM pg_proc
   WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_box FROM pg_proc
   WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  IF v_mem IS DISTINCT FROM 'b6a472e5ccabbf65e4f05106563ce6f4' AND v_mem IS DISTINCT FROM 'de9ebee733077a59dfe2959981f8e0c3' THEN
    RAISE EXCEPTION '[fix1375] record_box_health_mem md5 % is neither fix1375''s mirror b6a472e5ccabbf65e4f05106563ce6f4 nor this file''s — the mirror moved; rebuild this file on the live body',
      COALESCE(v_mem, '(no function)');
  END IF;
  IF v_box IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7' AND v_box IS DISTINCT FROM 'aaf6cc6552df532eff4a9b21e9780670' THEN
    RAISE EXCEPTION '[fix1375] box_is_saturated md5 % is neither fix1354''s ac8dbcddf71978e73d28c999433156b7 nor this file''s — the pin moved; rebuild this file on the live body',
      COALESCE(v_box, '(no function)');
  END IF;
  RAISE NOTICE '[fix1375] guards: record_box_health_mem % · box_is_saturated %', v_mem, v_box;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) the four dials
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.platform_dials
  ADD COLUMN IF NOT EXISTS io_time_pct_ceiling numeric NOT NULL DEFAULT 90
    CONSTRAINT platform_dials_io_time_pct_ceiling_check CHECK (io_time_pct_ceiling BETWEEN 50 AND 101),
  ADD COLUMN IF NOT EXISTS io_samples int NOT NULL DEFAULT 3
    CONSTRAINT platform_dials_io_samples_check CHECK (io_samples BETWEEN 1 AND 30),
  ADD COLUMN IF NOT EXISTS io_mbps_floor numeric NOT NULL DEFAULT 12
    CONSTRAINT platform_dials_io_mbps_floor_check CHECK (io_mbps_floor BETWEEN 0 AND 200),
  ADD COLUMN IF NOT EXISTS io_throttle_hold_min int NOT NULL DEFAULT 60
    CONSTRAINT platform_dials_io_throttle_hold_min_check CHECK (io_throttle_hold_min BETWEEN 0 AND 1440);

COMMENT ON COLUMN public.platform_dials.io_time_pct_ceiling IS
  'FIX-1375 — percent. A rated mirror sample at or over this counts toward io_busy_streak. The IOPS ceiling reads 97–100 %, idle < 1 % (audit §6). 101 disarms the rung: the sampler clamps io_time_pct at 100.';
COMMENT ON COLUMN public.platform_dials.io_samples IS
  'FIX-1375 — consecutive rated samples at the ceiling before box_is_saturated reads io_saturated. 3 ≈ 6 min at the 2-min cadence: one ecs window is ~4 min, so this catches the second window, not the first (audit §6).';
COMMENT ON COLUMN public.platform_dials.io_mbps_floor IS
  'FIX-1375 — MB/s, all disks, read + write. A standing streak at or under this is the throttle signature and sets io_throttle_until. The 87 Mbps baseline is ~10.9 MB/s; bursting at the ceiling reads ~28 plus root''s 4–21 (audit §6).';
COMMENT ON COLUMN public.platform_dials.io_throttle_hold_min IS
  'FIX-1375 — minutes io_throttle_until holds past the last throttle sample. A throttle ends when the bucket refills, not when the current unit stops (audit §6).';

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) record_box_health_mem() — fix1375's mirror + the streak and the hold
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
                                      'disk_all_read_bytes', 'disk_all_written_bytes'];
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
  'never fails the route — the series exists to survive the box. '
  'FIX-1375: the /data disk rates (disk_read_mbps … io_time_pct … disk_all_write_mbps) and their raw counters '
  'are stored too; disk_device (a string) stays ignored, and a null rate RAISEs (the route omits one it cannot compute). '
  'cc-264: reads its previous row and writes two DERIVED keys, io_busy_streak and io_throttle_until (the dials '
  'io_time_pct_ceiling / io_samples / io_mbps_floor / io_throttle_hold_min); a caller cannot set either.';

-- ═══════════════════════════════════════════════════════════════════════════
-- (3) box_is_saturated() — fix1354's body + the two reasons
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.box_is_saturated(p_stale_seconds integer DEFAULT 180, p_fork_failures_10m integer DEFAULT 3, p_now timestamp with time zone DEFAULT clock_timestamp(), p_include_watchdog_wall boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_watchdog_wall_s CONSTANT numeric := 1.0;
  v_bh      jsonb;
  v_mem     jsonb;
  v_age     int;
  v_mem_age int;
  v_wall    numeric;
  v_to10    int;
  v_reason  text;
  v_memory  jsonb := NULL;
  v_walls   boolean := COALESCE(p_include_watchdog_wall, true);
  -- FIX-1354 (D1): the swap ceiling. The dials are read here, so every reader
  -- of the gate sees one line. The CONSTANTs are the columns' DEFAULTs, used
  -- only when platform_dials has no row.
  c_swap_ceiling_mb CONSTANT int := 1018;
  c_headroom_mb     CONSTANT int := 150;
  v_ceiling   int;
  v_headroom  int;
  v_swap_used numeric;
  v_mem_stale boolean;
  -- FIX-1375 (cc-264): the io: rung. The same one-line pattern: the dials are
  -- read here, the CONSTANTs are their DEFAULTs. record_box_health_mem() keeps
  -- the streak and the hold on the mirror; this reads them.
  c_io_time_pct_ceiling CONSTANT numeric := 90;
  c_io_samples          CONSTANT int     := 3;
  c_io_mbps_floor       CONSTANT numeric := 12;
  c_io_throttle_hold_min CONSTANT int    := 60;
  v_io_ceiling numeric;
  v_io_samples int;
  v_io_floor   numeric;
  v_io_hold    int;
  v_io_streak  int;
  v_io_until   timestamptz;
  v_io         jsonb := NULL;
BEGIN
  SELECT value INTO v_bh  FROM public.pipeline_state WHERE key = 'box_health';
  SELECT value INTO v_mem FROM public.pipeline_state WHERE key = 'box_health_mem';

  v_age  := round(EXTRACT(epoch FROM (p_now - (v_bh->>'at')::timestamptz)))::int;
  v_to10 := (v_bh->>'startup_timeouts_10m')::int;
  v_wall := GREATEST((v_bh->'watchdog_max_wall_10m'->>'budget')::numeric,
                     (v_bh->'watchdog_max_wall_10m'->>'unit')::numeric);

  SELECT d.swap_ceiling_mb, d.headroom_target_mb,
         d.io_time_pct_ceiling, d.io_samples, d.io_mbps_floor, d.io_throttle_hold_min
    INTO v_ceiling, v_headroom, v_io_ceiling, v_io_samples, v_io_floor, v_io_hold
    FROM public.platform_dials d WHERE d.id;
  v_ceiling  := COALESCE(v_ceiling, c_swap_ceiling_mb);
  v_headroom := COALESCE(v_headroom, c_headroom_mb);
  v_io_ceiling := COALESCE(v_io_ceiling, c_io_time_pct_ceiling);
  v_io_samples := COALESCE(v_io_samples, c_io_samples);
  v_io_floor   := COALESCE(v_io_floor, c_io_mbps_floor);
  v_io_hold    := COALESCE(v_io_hold, c_io_throttle_hold_min);

  IF v_mem IS NOT NULL THEN
    v_mem_age := round(EXTRACT(epoch FROM (p_now - (v_mem->>'at')::timestamptz)))::int;
    v_swap_used := round(((v_mem->>'swap_total_bytes')::numeric
                          - (v_mem->>'swap_free_bytes')::numeric) / 1048576);
    v_memory := jsonb_build_object(
      'age_seconds',      v_mem_age,
      'mem_available_mb', round((v_mem->>'mem_available_bytes')::numeric / 1048576),
      'mem_total_mb',     round((v_mem->>'mem_total_bytes')::numeric / 1048576),
      'available_pct',    round(100 * (v_mem->>'mem_available_bytes')::numeric
                                    / NULLIF((v_mem->>'mem_total_bytes')::numeric, 0), 1),
      'swap_used_mb',     v_swap_used,
      'load1',            v_mem->'load1');
    v_io_streak := COALESCE((v_mem->>'io_busy_streak')::int, 0);
    v_io_until  := (v_mem->>'io_throttle_until')::timestamptz;
    v_io := jsonb_build_object(
      'io_time_pct',    v_mem->'io_time_pct',
      'all_mbps',       round((v_mem->>'disk_all_read_mbps')::numeric + (v_mem->>'disk_all_write_mbps')::numeric, 2),
      'reads_ps',       v_mem->'disk_reads_ps',
      'busy_streak',    v_io_streak,
      'throttle_until', v_io_until);
  END IF;
  -- FIX-1354 (D1): fresh = the probe's own freshness (p_stale_seconds). A stale
  -- or absent mirror (the Vercel route writes it) does NOT saturate: fail-open,
  -- and counted (mem_stale). The on-box clauses above it already fail closed.
  v_mem_stale := v_mem_age IS NULL OR v_mem_age > p_stale_seconds;

  IF v_age IS NULL OR v_age > p_stale_seconds THEN
    v_reason := 'stale';
  ELSIF v_to10 >= p_fork_failures_10m THEN
    v_reason := 'fork_failures';
  ELSIF NOT v_mem_stale AND v_swap_used >= v_ceiling THEN
    v_reason := 'memory';  -- FIX-1354 (D1): swap at the ceiling
  ELSIF NOT v_mem_stale AND v_io_until > p_now THEN
    v_reason := 'io_throttled';  -- FIX-1375: first, the hold outlives the streak
  ELSIF NOT v_mem_stale AND v_io_streak >= v_io_samples THEN
    v_reason := 'io_saturated';  -- FIX-1375: io_time at the ceiling for io_samples samples
  ELSIF v_walls AND v_wall > c_watchdog_wall_s THEN
    v_reason := 'watchdog_wall';
  ELSE
    v_reason := 'clear';
  END IF;

  RETURN jsonb_build_object(
    'saturated',   v_reason <> 'clear',
    'reason',      v_reason,
    'age_seconds', v_age,
    'readings',    jsonb_build_object(
      'probe',      v_bh,
      'memory',     v_memory,
      'io',         v_io,
      'thresholds', jsonb_build_object(
        'stale_seconds',            p_stale_seconds,
        'fork_failures_10m',        p_fork_failures_10m,
        'watchdog_wall_s',          c_watchdog_wall_s,
        'watchdog_wall_considered', v_walls,
        'memory',                   jsonb_build_object(
                                      'swap_ceiling_mb',    v_ceiling,
                                      'headroom_target_mb', v_headroom,
                                      'mem_stale',          v_mem_stale),
        'io',                       jsonb_build_object(
                                      'ceiling',    v_io_ceiling,
                                      'samples',    v_io_samples,
                                      'mbps_floor', v_io_floor,
                                      'hold_min',   v_io_hold))));
END;
$function$;

REVOKE ALL ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) TO service_role;

COMMENT ON FUNCTION public.box_is_saturated(int, int, timestamptz, boolean) IS
  'FIX-1194 P1-B / P1-A — is the box saturated right now? {saturated, reason: stale|fork_failures|memory|io_throttled|io_saturated|watchdog_wall|clear, '
  'age_seconds, readings{probe, memory, io, thresholds}}. A stale or absent box_health stamp IS saturation (the probe '
  'is a pg_cron firing and goes dark with the forker). p_include_watchdog_wall := false skips the 1.0 s wall rule '
  '— the three rollup gates call it that way (cc-183 D2: the wall is not a backoff input). memory (FIX-1354, '
  'cc-251): a FRESH box_health_mem mirror with swap_used_mb >= platform_dials.swap_ceiling_mb saturates (reason '
  'memory); a stale or absent mirror never does (fail-open, readings.thresholds.memory.mem_stale true). '
  'thresholds.memory = {swap_ceiling_mb, headroom_target_mb, mem_stale}. '
  'io (FIX-1375, cc-264): a FRESH mirror with io_throttle_until in the future reads io_throttled, else '
  'io_busy_streak >= platform_dials.io_samples reads io_saturated; readings.io = {io_time_pct, all_mbps, reads_ps, '
  'busy_streak, throttle_until}, thresholds.io = {ceiling, samples, mbps_floor, hold_min}. Every reader inherits '
  'them: the dispatcher''s step 4, box_backoff_gate at a unit''s start, and the chunk loops of '
  'donor_rollup_rebuild_bulk and refresh_agency_staffing_rollup. p_now is for tests.';

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_oid     oid := 'public.record_box_health_mem(jsonb)'::regprocedure;
  v_md5_mem text;
  v_md5_box text;
  v_md5_d   text;
  v_md5_s   text;
  v_md5_g   text;
  v_def     text;
  v_definer boolean;
  v_config  text[];
  v_box_config text[];
  v_dials   text;
  -- the round trip
  v_s1      jsonb;
  v_s2      jsonb;
  v_s3      jsonb;
  v_carry   jsonb;
  v_reset   jsonb;
  v_thr     jsonb;
  v_sat     jsonb;
  v_sat_thr jsonb;
  v_sat_clr jsonb;
  v_forged  jsonb;
  c_sample  CONSTANT jsonb := jsonb_build_object(
    'mem_available_bytes', 418258944, 'mem_total_bytes', 948195328,
    'swap_total_bytes', 1073737728, 'swap_free_bytes', 539893760);
BEGIN
  SELECT md5(prosrc), prosecdef, proconfig INTO v_md5_mem, v_definer, v_config FROM pg_proc WHERE oid = v_oid;
  SELECT md5(prosrc), proconfig INTO v_md5_box, v_box_config FROM pg_proc
   WHERE oid = 'public.box_is_saturated(int, int, timestamptz, boolean)'::regprocedure;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_s FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;

  IF v_md5_mem IS DISTINCT FROM 'de9ebee733077a59dfe2959981f8e0c3' THEN
    v_missing := v_missing || format('record_box_health_mem md5 %s (expected de9ebee733077a59dfe2959981f8e0c3)', v_md5_mem);
  END IF;
  IF v_md5_box IS DISTINCT FROM 'aaf6cc6552df532eff4a9b21e9780670' THEN
    v_missing := v_missing || format('box_is_saturated md5 %s (expected aaf6cc6552df532eff4a9b21e9780670)', v_md5_box);
  END IF;
  IF v_md5_d IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18' THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s moved (pin d6a9073bcc4d9084b9d7994324a89b18)', v_md5_d);
  END IF;
  IF v_md5_s IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6' THEN
    v_missing := v_missing || format('get_dispatcher_status md5 %s moved (pin 4c30523742e280a4b48ea2ec390654d6)', v_md5_s);
  END IF;
  -- fix1342's pin, or file B's own once a rehearsal re-applies this over it.
  IF v_md5_g IS DISTINCT FROM '1d3507cd4b71439f0cfff51cde49b9d8' AND v_md5_g IS DISTINCT FROM '6488601cf8c09287d540989c0e0fd074' THEN
    v_missing := v_missing || format('prod_op_gate md5 %s moved (pin 1d3507cd4b71439f0cfff51cde49b9d8)', v_md5_g);
  END IF;
  IF v_definer IS DISTINCT FROM true THEN
    v_missing := v_missing || 'record_box_health_mem prosecdef is not true'::text;
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_catalog']
     OR v_box_config IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
    v_missing := v_missing || format('proconfig %s / %s (expected search_path only)', v_config, v_box_config);
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    v_missing := v_missing || 'record_box_health_mem grants (expected anon f / authenticated f / service_role t)'::text;
  END IF;

  SELECT string_agg(column_name || '=' || COALESCE(column_default::text, '(none)'), ', ' ORDER BY column_name)
    INTO v_def
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'platform_dials' AND column_name LIKE 'io\_%';
  IF v_def IS DISTINCT FROM 'io_mbps_floor=12, io_samples=3, io_throttle_hold_min=60, io_time_pct_ceiling=90' THEN
    v_missing := v_missing || format('the dial columns read %s', v_def);
  END IF;
  SELECT format('%s / %s / %s / %s', d.io_time_pct_ceiling::text, d.io_samples::text,
                d.io_mbps_floor::text, d.io_throttle_hold_min::text)
    INTO v_dials FROM public.platform_dials d WHERE d.id;

  -- One synthetic series, always rolled back: the subtransaction ends in a RAISE
  -- this block catches, so neither real row is ever overwritten. It assumes the
  -- DEFAULT dials this file just added.
  BEGIN
    DELETE FROM public.pipeline_state WHERE key = 'box_health_mem';
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                             'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    PERFORM public.record_box_health_mem(c_sample || jsonb_build_object(
      'io_time_pct', 97, 'disk_all_read_mbps', 30, 'disk_all_write_mbps', 1));
    SELECT value INTO v_s1 FROM public.pipeline_state WHERE key = 'box_health_mem';
    PERFORM public.record_box_health_mem(c_sample || jsonb_build_object(
      'io_time_pct', 97, 'disk_all_read_mbps', 30, 'disk_all_write_mbps', 1));
    SELECT value INTO v_s2 FROM public.pipeline_state WHERE key = 'box_health_mem';
    -- unratable: the streak carries
    PERFORM public.record_box_health_mem(c_sample);
    SELECT value INTO v_carry FROM public.pipeline_state WHERE key = 'box_health_mem';
    -- a forged key loses to the derived one
    PERFORM public.record_box_health_mem(c_sample || jsonb_build_object(
      'io_time_pct', 97, 'disk_all_read_mbps', 30, 'disk_all_write_mbps', 1,
      'io_busy_streak', 50, 'io_throttle_until', '2099-01-01T00:00:00Z'));
    SELECT value INTO v_s3 FROM public.pipeline_state WHERE key = 'box_health_mem';
    v_sat := public.box_is_saturated(p_include_watchdog_wall := false);

    -- the throttle signature: the streak stands and the disk sits at the floor
    PERFORM public.record_box_health_mem(c_sample || jsonb_build_object(
      'io_time_pct', 99, 'disk_all_read_mbps', 4, 'disk_all_write_mbps', 1));
    SELECT value INTO v_thr FROM public.pipeline_state WHERE key = 'box_health_mem';
    v_sat_thr := public.box_is_saturated(p_include_watchdog_wall := false);

    -- rated below the ceiling: the streak resets, and the hold outlives it
    PERFORM public.record_box_health_mem(c_sample || jsonb_build_object(
      'io_time_pct', 10, 'disk_all_read_mbps', 1, 'disk_all_write_mbps', 1));
    SELECT value INTO v_reset FROM public.pipeline_state WHERE key = 'box_health_mem';
    v_sat_clr := public.box_is_saturated(p_include_watchdog_wall := false);

    RAISE EXCEPTION 'fix1375 read-back: roll back the synthetic series' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'fix1375 read-back: roll back the synthetic series' THEN
      RAISE;
    END IF;
  END;

  IF (v_s1->>'io_busy_streak')::int IS DISTINCT FROM 1 OR (v_s2->>'io_busy_streak')::int IS DISTINCT FROM 2 THEN
    v_missing := v_missing || format('the streak read %s then %s (expected 1 then 2)', v_s1->>'io_busy_streak', v_s2->>'io_busy_streak');
  END IF;
  IF (v_carry->>'io_busy_streak')::int IS DISTINCT FROM 2 THEN
    v_missing := v_missing || format('an unrated sample read %s (expected the streak carried: 2)', v_carry->>'io_busy_streak');
  END IF;
  IF (v_s3->>'io_busy_streak')::int IS DISTINCT FROM 3 OR v_s3 ? 'io_throttle_until' THEN
    v_missing := v_missing || format('the third rated sample read %s (expected streak 3 and no hold; a forged key must not land)', v_s3);
  END IF;
  IF v_sat->>'reason' IS DISTINCT FROM 'io_saturated' OR (v_sat->'readings'->'io'->>'busy_streak')::int IS DISTINCT FROM 3 THEN
    v_missing := v_missing || format('box_is_saturated at streak 3 read %s', v_sat->>'reason');
  END IF;
  IF NOT (v_thr ? 'io_throttle_until')
     OR ((v_thr->>'io_throttle_until')::timestamptz - (v_thr->>'at')::timestamptz) IS DISTINCT FROM interval '60 minutes' THEN
    v_missing := v_missing || format('the throttle sample set hold %s at %s (expected at + 60 min)', v_thr->>'io_throttle_until', v_thr->>'at');
  END IF;
  IF v_sat_thr->>'reason' IS DISTINCT FROM 'io_throttled' THEN
    v_missing := v_missing || format('box_is_saturated under the hold read %s', v_sat_thr->>'reason');
  END IF;
  IF (v_reset->>'io_busy_streak')::int IS DISTINCT FROM 0 OR NOT (v_reset ? 'io_throttle_until') THEN
    v_missing := v_missing || format('a rated sample below the ceiling read %s (expected streak 0, the hold kept)', v_reset);
  END IF;
  IF v_sat_clr->>'reason' IS DISTINCT FROM 'io_throttled' THEN
    v_missing := v_missing || format('box_is_saturated after the streak reset read %s (expected the hold: io_throttled)', v_sat_clr->>'reason');
  END IF;
  IF EXISTS (SELECT 1 FROM public.pipeline_state WHERE key = 'box_health_mem'
              AND value->>'mem_available_bytes' = '418258944') THEN
    v_missing := v_missing || 'the synthetic series survived the rollback'::text;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1375] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1375] read-back ok: record_box_health_mem md5 % (was b6a472e5ccabbf65e4f05106563ce6f4); box_is_saturated md5 % (was ac8dbcddf71978e73d28c999433156b7); dials %; dispatch_one_unit % · get_dispatcher_status % · prod_op_gate % unchanged; streak 1, 2, carried 2, 3 (forged key dropped) → io_saturated; floor sample → hold at + 60 min → io_throttled; rated 10 %% → streak 0, hold kept, still io_throttled; all rolled back',
    v_md5_mem, v_md5_box, v_dials, v_md5_d, v_md5_s, v_md5_g;
END $$;
