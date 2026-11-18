-- =============================================================================
-- FIX-1423 — ec-crawl rests 25 minutes after a unit, not 10 (cc-292, file B of
-- three; A = FIX-1421's reap close, C = FIX-1424's three GHA starts). One
-- registry row, one column, the one dial. fe-crawl's value.
--
-- WHY. After a Sunday landing each ecs window reads ~8.8 GB at the volume's
-- ~3,000 IOPS burst for 4–5 min; the Micro sustains 500 IOPS and refills the
-- burst budget only below that. `stale_after 10 minutes` re-arms the crawl
-- ~10–12 min after a unit completes, so the pass spends several times what the
-- gaps refill. Three Mondays got worse under the io: rung's holds (Disk IO
-- consumed 11-02 88 %, 11-16 96 %; startup timeouts 270 / 306 / 414): a brake
-- that only holds does not pace.
--
-- READ 5 (cc-292, prod 2026-11-18; dispatch_log from 11-04 on, its retention):
--   cycle (closed)              units arms wall_h  p50 reap→arm  p90   p50 unit
--   11-16 02:29 → 11-17 01:37     32   35  23.14      10.0 min  101.6   3.7 min
--   11-15 14:51 → 11-15 18:47     17   17   3.94      10.0       12.0   0.7
--   11-14 23:21 → 11-15 08:47     35   35   9.44      10.0       10.1   0.2
--   11-17 07:41 / 13:47 / 19:51    1    1   0.00      next arm 360 min later
-- (1-unit cycles are paced by ec_crawl.min_cycle_interval_minutes 360, not by
-- this rule.) 11-16's 23.14 h holds the FIX-1421 orphan's 330-min gap.
--
-- THE PROJECTION AT 25. A reap→arm gap ≤ 12 min becomes gap + 15; one in
-- (12, 25] becomes 25; a held gap (> 25) is unchanged — an upper bound, since
-- pacing is meant to remove holds:
--   11-16's pass   intra-cycle gaps 12.36 h → 19.01 h; the wall 23.14 h, less
--                  the orphan (5.5 h, ~0.5 h under FIX-1421's cooldown), plus
--                  6.65 h ≈ 24.8 h (Cowork's no-hold count: ~34 × 29 min ≈ 16 h)
--   11-14/15       9.44 h → ~17.7 h;   11-15 pm  3.94 h → ~7.9 h
-- READERS, each against that (none is crossed, so this file moves only the rule):
--   check_rollup_freshness via the canary (rollup_watch_overrides
--     entity_connections_rebuild cadence_hours 24 → report 36 h, escalate
--     60 h, counted from the last `complete` row): the pass's prior close was
--     7.7 h before its first unit, so ≤ 7.7 + 24.8 = 32.5 h at the bound (11-16
--     at 10: 30.8 h). The nearest threshold; Mon 11-23 reads it.
--   get_ec_crawl_health: signal on the donations watermark's age > 7 days.
--   the dashboard's entity_connections_rebuild row: tiered weekly (8 d / 15 d).
--   docs/receipts/bands.json ec-crawl: a PER-UNIT duration band (0–1,769 s),
--     not a cadence.
--   get_dispatcher_status: shows the ttd; no threshold.
--
-- NOT TOUCHED (cc-292 D6): max_concurrent_units 2, io_samples 2, every other
-- dial, the ec_crawl config, fe-crawl, every other row. One variable for Mon
-- 11-23's receipt.
--
-- ROLLBACK: scripts/fix1423-revert-ec-crawl-cadence.sql (the row back to 10,
-- matched on 25; the note's clause off).
--
-- IDEMPOTENT: matched on the exact old text; a second run NOTICEs, 0 rows.
-- =============================================================================

DO $$
DECLARE
  v_n    int;
  v_rule text;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'stale_after 25 minutes',
         note          = note || '; cc-292 (FIX-1423): 25 minutes from 10 — the post-landing pass',
         updated_at    = now()
   WHERE job = 'ec-crawl'
     AND deadline_rule = 'stale_after 10 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1423] ec-crawl: stale_after 10 minutes → 25 minutes (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'ec-crawl';
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1423] job_registry has no row ec-crawl';
    ELSIF v_rule = 'stale_after 25 minutes' THEN
      RAISE NOTICE '[fix1423] ec-crawl already stale_after 25 minutes — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1423] ec-crawl deadline_rule = %, expected stale_after 10 minutes (or 25)', v_rule;
    END IF;
  END IF;
END $$;

-- read-back — RAISE on any miss
DO $$
DECLARE
  v_missing text[] := '{}';
  v_rule    text;
  v_note    text;
  v_n       int;
BEGIN
  SELECT deadline_rule, note INTO v_rule, v_note FROM public.job_registry WHERE job = 'ec-crawl';
  IF v_rule IS DISTINCT FROM 'stale_after 25 minutes' THEN
    v_missing := v_missing || format('ec-crawl deadline_rule %L', v_rule)::text;
  END IF;
  v_n := (length(v_note) - length(replace(v_note, '; cc-292 (FIX-1423): ', ''))) / length('; cc-292 (FIX-1423): ');
  IF v_n IS DISTINCT FROM 1 THEN
    v_missing := v_missing || format('ec-crawl note carries the cc-292 clause %s time(s)', v_n)::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1423] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1423] read-back ok: ec-crawl % (note …%)', v_rule, right(v_note, 70);
END $$;
