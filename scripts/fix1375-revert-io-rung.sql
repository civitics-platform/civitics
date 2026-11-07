-- =============================================================================
-- FIX-1375 (cc-264) ROLLBACK — the io: rung OFF.
--
-- The mirror of supabase/migrations/20261108000000_fix1375_io_rung_box_is_saturated_mirror_streak_dials.sql.
-- NOT a migration: a payload for the --call path.
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1375-revert-io-rung.sql
--
-- A LIGHTER NET COMES FIRST: UPDATE public.platform_dials SET io_time_pct_ceiling = 101;
-- disarms the streak on the next sample with no body change.
--
-- ORDER: file B's revert goes first (scripts/fix1377-revert-prod-op-gate-d.sql).
-- The gate reads platform_dials.io_samples, and dropping that column under it
-- would make every gate read fail (closed). This file RAISEs if the gate still
-- reads the dial. Then both bodies back, then DROP COLUMN ×4.
--
-- The bodies are fix1375's (b6a472e5ccabbf65e4f05106563ce6f4) and fix1354's (ac8dbcddf71978e73d28c999433156b7),
-- verbatim from their migrations, which hash to what prod carried at cc-264 read 2.
--
-- THE MIRROR ROW keeps io_busy_streak and io_throttle_until until the next
-- sample (~2 min). Harmless: neither restored body reads them.
--
-- Idempotent: the guard accepts the old md5s, CREATE OR REPLACE ×2, DROP COLUMN IF EXISTS.
-- =============================================================================

DO $$
DECLARE
  v_mem  text;
  v_box  text;
  v_gate text;
BEGIN
  SELECT md5(prosrc) INTO v_mem FROM pg_proc WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_box FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  SELECT prosrc INTO v_gate FROM pg_proc WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;
  IF v_mem NOT IN ('de9ebee733077a59dfe2959981f8e0c3', 'b6a472e5ccabbf65e4f05106563ce6f4') THEN
    RAISE EXCEPTION '[fix1375 revert] record_box_health_mem md5 % is neither the rung''s de9ebee733077a59dfe2959981f8e0c3 nor fix1375''s', v_mem;
  END IF;
  IF v_box NOT IN ('aaf6cc6552df532eff4a9b21e9780670', 'ac8dbcddf71978e73d28c999433156b7') THEN
    RAISE EXCEPTION '[fix1375 revert] box_is_saturated md5 % is neither the rung''s aaf6cc6552df532eff4a9b21e9780670 nor fix1354''s', v_box;
  END IF;
  IF v_gate LIKE '%io_samples%' THEN
    RAISE EXCEPTION '[fix1375 revert] prod_op_gate still reads platform_dials.io_samples — run scripts/fix1377-revert-prod-op-gate-d.sql first';
  END IF;
END $$;

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

  FOR v_k IN SELECT jsonb_object_keys(p) LOOP
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

  v_value := jsonb_build_object('at', v_at) || v_value;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('box_health_mem', v_value)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object('at', v_at, 'ignored_keys', to_jsonb(v_ignored));
END;
$function$;

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
BEGIN
  SELECT value INTO v_bh  FROM public.pipeline_state WHERE key = 'box_health';
  SELECT value INTO v_mem FROM public.pipeline_state WHERE key = 'box_health_mem';

  v_age  := round(EXTRACT(epoch FROM (p_now - (v_bh->>'at')::timestamptz)))::int;
  v_to10 := (v_bh->>'startup_timeouts_10m')::int;
  v_wall := GREATEST((v_bh->'watchdog_max_wall_10m'->>'budget')::numeric,
                     (v_bh->'watchdog_max_wall_10m'->>'unit')::numeric);

  SELECT d.swap_ceiling_mb, d.headroom_target_mb INTO v_ceiling, v_headroom
    FROM public.platform_dials d WHERE d.id;
  v_ceiling  := COALESCE(v_ceiling, c_swap_ceiling_mb);
  v_headroom := COALESCE(v_headroom, c_headroom_mb);

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
      'thresholds', jsonb_build_object(
        'stale_seconds',            p_stale_seconds,
        'fork_failures_10m',        p_fork_failures_10m,
        'watchdog_wall_s',          c_watchdog_wall_s,
        'watchdog_wall_considered', v_walls,
        'memory',                   jsonb_build_object(
                                      'swap_ceiling_mb',    v_ceiling,
                                      'headroom_target_mb', v_headroom,
                                      'mem_stale',          v_mem_stale))));
END;
$function$;

ALTER TABLE public.platform_dials
  DROP COLUMN IF EXISTS io_time_pct_ceiling,
  DROP COLUMN IF EXISTS io_samples,
  DROP COLUMN IF EXISTS io_mbps_floor,
  DROP COLUMN IF EXISTS io_throttle_hold_min;

DO $$
DECLARE
  v_mem text;
  v_box text;
  v_n   int;
BEGIN
  SELECT md5(prosrc) INTO v_mem FROM pg_proc WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_box FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'platform_dials' AND column_name LIKE 'io\_%';
  IF v_mem IS DISTINCT FROM 'b6a472e5ccabbf65e4f05106563ce6f4' OR v_box IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7' OR v_n <> 0 THEN
    RAISE EXCEPTION '[fix1375 revert] read-back: record_box_health_mem % / box_is_saturated % / % io_ dial column(s) left', v_mem, v_box, v_n;
  END IF;
  RAISE NOTICE '[fix1375 revert] done: record_box_health_mem % · box_is_saturated % · 0 io_ dial columns; the mirror drops the derived keys on its next sample', v_mem, v_box;
END $$;
