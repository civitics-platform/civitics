-- =============================================================================
-- FIX-1399 — io_samples 3 → 2: the io: rung holds on the SECOND consecutive
-- sample at the ceiling. cc-267, 2026-11-11 (D11, Craig 11-09 20:39 PST "1a").
-- Class P: one platform_dials UPDATE. No body moves: record_box_health_mem,
-- box_is_saturated and prod_op_gate read the dial at call time.
--
-- WHY. cc-266's replay of the 11-09 post-landing pass over the 30 h ring:
-- io_samples 3 sets holds at 08:30 and 14:22Z (prod's real 08:32:25 / 14:23Z);
-- 2 sets five, at 05:54, 07:52, 10:00, 14:20 and 19:12Z, every one at
-- <= 12 MB/s. Cost: five 60-min holds where there were two, and saturated
-- minutes 16 → 40 per 30 h. The replay holds only where the ring had samples:
-- it gapped 24–38 min inside the stall (the record says so; FIX-1392 is the
-- stale-mirror half, file D). io_time_pct_ceiling 90, io_mbps_floor 12 and
-- io_throttle_hold_min 60 stay.
--
-- A FRESH STREAK OF 2 READS io_saturated ON THE NEXT TICK. If the mirror
-- stands at busy_streak 2 when this lands, box_is_saturated reads io_saturated
-- at once; that is the dial working, not a fault. The NOTICE below quotes the
-- streak and the hold as they stand.
--
-- ROLLBACK: scripts/fix1399-revert-io-samples-3.sql (the same UPDATE back to
-- 3). IDEMPOTENT (rule 241): a second run NOTICEs "already 2".
-- =============================================================================

DO $$
DECLARE
  v_n   int;
  v_now int;
BEGIN
  UPDATE public.platform_dials SET io_samples = 2 WHERE io_samples = 3;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1399] platform_dials.io_samples 3 → 2 (1 row)';
  ELSE
    SELECT io_samples INTO v_now FROM public.platform_dials WHERE id;
    IF v_now = 2 THEN
      RAISE NOTICE '[fix1399] platform_dials.io_samples already 2 — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1399] platform_dials.io_samples reads %, expected 3 or 2 — a hand write? refusing', COALESCE(v_now::text, '(no row)');
    END IF;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_d       public.platform_dials%ROWTYPE;
  v_mem     jsonb;
  v_age     int;
BEGIN
  SELECT * INTO v_d FROM public.platform_dials WHERE id;
  IF v_d.io_time_pct_ceiling IS DISTINCT FROM 90 OR v_d.io_samples IS DISTINCT FROM 2
     OR v_d.io_mbps_floor IS DISTINCT FROM 12 OR v_d.io_throttle_hold_min IS DISTINCT FROM 60 THEN
    v_missing := v_missing || format('the io dials %s / %s / %s / %s, expected 90 / 2 / 12 / 60',
                                     v_d.io_time_pct_ceiling, v_d.io_samples, v_d.io_mbps_floor, v_d.io_throttle_hold_min)::text;
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace))
     IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18' THEN
    v_missing := v_missing || 'dispatch_one_unit md5 moved'::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1399] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  SELECT value INTO v_mem FROM public.pipeline_state WHERE key = 'box_health_mem';
  v_age := round(EXTRACT(epoch FROM (clock_timestamp() - (v_mem->>'at')::timestamptz)))::int;
  RAISE NOTICE '[fix1399] read-back ok: io dials 90 / 2 / 12 / 60. The mirror now: io_busy_streak %, io_throttle_until %, age % s%',
    COALESCE(v_mem->>'io_busy_streak', 'NULL'), COALESCE(v_mem->>'io_throttle_until', 'NULL'), COALESCE(v_age::text, 'NULL'),
    CASE WHEN (v_mem->>'io_busy_streak')::int >= 2 THEN ' — a streak of 2 reads io_saturated from the next tick (expected)' ELSE '' END;
END $$;
