-- =============================================================================
-- FIX-1375 (the mirror half) — record_box_health_mem() stores the sampler's
-- disk keys. cc-259, 2026-11-04. FIX-1375 stays OPEN: the `io:` rung that
-- reads these keys is a later prompt.
--
-- THE GAP. cc-262's sampler (5d23037f) puts eight per-sample rates and the
-- /data device's raw counters on every ring sample, but the on-box mirror
-- WHITELISTS: fix1194's c_numeric (20260920130000:330-333) lists ten memory
-- keys and every other key lands in ignored_keys and is dropped. cc-262 read
-- the mirror at 03:24Z (0 disk keys stored), and cc-259 read it again at
-- 2026-11-04 01:06Z: still 0. The rung reads the mirror, so the keys must be
-- listed.
--
-- THE KEYS (packages/db/src/box-health-store.ts, DiskRaw + DiskRates — every
-- one a NUMBER on the wire):
--   rates     disk_read_mbps, disk_write_mbps, io_time_pct, io_queue,
--             disk_reads_ps, disk_writes_ps, disk_all_read_mbps,
--             disk_all_write_mbps
--   counters  disk_clock_s, disk_read_bytes, disk_written_bytes, disk_reads,
--             disk_writes, disk_io_time_s, disk_io_weighted_s,
--             disk_all_read_bytes, disk_all_written_bytes
-- NOT listed: disk_device (a string, e.g. 'nvme1n1') stays in ignored_keys.
-- disk_missing is not a sample key at all (ParsedSample carries it beside
-- the sample), so the route never sends it.
--
-- NULL RAISES BY DESIGN. The route OMITS a rate it cannot compute (the first
-- sample, a device change, a counter that went backwards, the same exporter
-- snapshot twice, a gap over 6 min). It never sends null (box-health-store.ts
-- header). So the strict numeric check stays: a null here is a caller bug, and
-- the route logs the RAISE without failing (the stamp is best-effort; the ring
-- is written first).
--
-- WHAT:
--   (1) a guard: md5(prosrc) must be fix1194's 98fba835ce2f00e9d04dc3658060f934
--       (prod = clone, cc-259 read 2) or this file's own body (a re-apply);
--       anything else RAISEs: the mirror moved, rebuild this file on the live
--       body.
--   (2) CREATE OR REPLACE = fix1194's body VERBATIM with ONE edit: c_numeric
--       gains the seventeen keys after 'scrape_ms', with a comment line above.
--   (3) the REVOKE / GRANT / COMMENT restated from fix1194:382-390 (the
--       COMMENT gains one sentence on the disk keys).
--   (4) a read-back: the new md5 as a NOTICE, prosecdef, proconfig, the
--       grants, and ONE round-trip inside a subtransaction that is always
--       rolled back, so the real mirror row is never overwritten by a
--       synthetic sample (on prod it would hand the gate a fake
--       mem_available_bytes for one tick).
--
-- WHAT IT CHANGES FOR READERS: nothing. box_is_saturated() reads `at`,
-- mem_available_bytes, mem_total_bytes and swap_* from the mirror and no
-- other key (its prosrc's ->>'…' reads, cc-259 clone). The fix1354 file's
-- expected-md5 for this function is append-only history in THAT file, and
-- dispatcher-r4.test.ts pins the file's text, not the live function.
--
-- ROLLBACK: re-apply fix1194's CREATE OR REPLACE of record_box_health_mem
-- (20260920130000:321-390) verbatim. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  IF v_md5 = '98fba835ce2f00e9d04dc3658060f934' THEN
    RAISE NOTICE '[fix1375] record_box_health_mem md5 % = fix1194''s body — extending c_numeric', v_md5;
  ELSIF v_md5 = 'b6a472e5ccabbf65e4f05106563ce6f4' THEN
    RAISE NOTICE '[fix1375] record_box_health_mem md5 % = this file''s body — a re-apply, no change', v_md5;
  ELSE
    RAISE EXCEPTION '[fix1375] record_box_health_mem md5 % is neither fix1194''s 98fba835ce2f00e9d04dc3658060f934 nor this file''s — the mirror moved since fix1194; rebuild this file on the live body',
      COALESCE(v_md5, '(no function)');
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

REVOKE ALL ON FUNCTION public.record_box_health_mem(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_box_health_mem(jsonb) TO service_role;

COMMENT ON FUNCTION public.record_box_health_mem(jsonb) IS
  'FIX-1125 — the ON-box mirror of the memory series /api/cron/box-health scrapes every 2 min. Upserts '
  'pipeline_state.box_health_mem = {at (DB clock), route_at, mem_available_bytes, mem_total_bytes, swap_*, '
  'load1, …}. Validates keys (required numbers, consistent; unlisted keys dropped and returned as '
  'ignored_keys). Best-effort by design: the route writes the OFF-box Upstash ring FIRST, and a failure here '
  'never fails the route — the series exists to survive the box. '
  'FIX-1375: the /data disk rates (disk_read_mbps … io_time_pct … disk_all_write_mbps) and their raw counters '
  'are stored too; disk_device (a string) stays ignored, and a null rate RAISEs (the route omits one it cannot compute).';

-- ── read-back — RAISE on any miss ───────────────────────────────────────────
DO $$
DECLARE
  v_oid     oid := 'public.record_box_health_mem(jsonb)'::regprocedure;
  v_md5     text;
  v_definer boolean;
  v_config  text[];
  v_missing text[] := '{}';
  v_ret     jsonb;
  v_stored  jsonb;
BEGIN
  SELECT md5(prosrc), prosecdef, proconfig INTO v_md5, v_definer, v_config FROM pg_proc WHERE oid = v_oid;
  IF v_md5 IS DISTINCT FROM 'b6a472e5ccabbf65e4f05106563ce6f4' THEN
    v_missing := v_missing || format('md5 %s (expected this file''s body b6a472e5ccabbf65e4f05106563ce6f4)', v_md5);
  END IF;
  IF v_definer IS DISTINCT FROM true THEN
    v_missing := v_missing || 'prosecdef is not true'::text;
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
    v_missing := v_missing || format('proconfig %s (expected {search_path=public, pg_catalog})', v_config);
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    v_missing := v_missing || format('grants anon %s / authenticated %s / service_role %s (expected f / f / t)',
                                     has_function_privilege('anon', v_oid, 'EXECUTE'),
                                     has_function_privilege('authenticated', v_oid, 'EXECUTE'),
                                     has_function_privilege('service_role', v_oid, 'EXECUTE'));
  END IF;

  -- One synthetic sample, always rolled back: the subtransaction ends in a
  -- RAISE this block catches, so the real mirror row is never overwritten.
  BEGIN
    v_ret := public.record_box_health_mem(jsonb_build_object(
      'mem_available_bytes', 418258944, 'mem_total_bytes', 948195328,
      'swap_total_bytes', 1073737728, 'swap_free_bytes', 539893760,
      'load1', 0.14, 'pswpin', 1, 'pswpout', 1, 'pgmajfault', 1, 'oom_kill', 0, 'scrape_ms', 342,
      'disk_read_mbps', 27.71, 'disk_write_mbps', 0.21, 'io_time_pct', 97.9, 'io_queue', 30.8,
      'disk_reads_ps', 3127, 'disk_writes_ps', 4.3, 'disk_all_read_mbps', 28.5, 'disk_all_write_mbps', 1.2,
      'bogus', 1));
    SELECT value INTO v_stored FROM public.pipeline_state WHERE key = 'box_health_mem';
    RAISE EXCEPTION 'fix1375 read-back: roll back the synthetic sample' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'fix1375 read-back: roll back the synthetic sample' THEN
      RAISE;
    END IF;
  END;
  IF v_ret->'ignored_keys' IS DISTINCT FROM '["bogus"]'::jsonb THEN
    v_missing := v_missing || format('round-trip ignored_keys %s (expected ["bogus"])', v_ret->'ignored_keys');
  END IF;
  IF v_stored->'io_time_pct' IS DISTINCT FROM '97.9'::jsonb OR v_stored->'disk_all_write_mbps' IS DISTINCT FROM '1.2'::jsonb THEN
    v_missing := v_missing || format('round-trip stored io_time_pct %s / disk_all_write_mbps %s (expected 97.9 / 1.2)',
                                     v_stored->'io_time_pct', v_stored->'disk_all_write_mbps');
  END IF;
  IF EXISTS (SELECT 1 FROM public.pipeline_state WHERE key = 'box_health_mem'
              AND value->>'mem_available_bytes' = '418258944' AND value->>'io_time_pct' = '97.9') THEN
    v_missing := v_missing || 'the synthetic sample survived the rollback'::text;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1375] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1375] read-back ok: record_box_health_mem md5 % (was 98fba835…); prosecdef t; proconfig %; grants f / f / t; round-trip ignored_keys % and io_time_pct % stored, then rolled back (the live mirror row is untouched)',
    v_md5, v_config, v_ret->'ignored_keys', v_stored->'io_time_pct';
END $$;
