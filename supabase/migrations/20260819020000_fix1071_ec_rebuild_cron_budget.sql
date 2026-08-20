-- =============================================================================
-- FIX-1071 — bound the two EC rebuild jobs from OUTSIDE. The internal budget is
--            structurally blind to the failure that actually happens.
--
-- ── WHY FIX-1063 LEFT THESE TWO OUT, AND WHY THAT RESERVATION IS NOW SPENT ───
-- FIX-1063's header is explicit about the omission and the reason was a good
-- one:
--
--     2, 22  rebuild-ec-incremental{,-mon}  FIX-1056 shipped its budget and
--            per-arm resume checkpoint on 08-18, and Wednesday 08-19 08:00 UTC
--            is the DESIGNED first test of it. A second, outside canceller
--            racing that test would destroy the measurement. Do not add these
--            until the 08-19 read is in.
--
-- The 08-19 read is in. Verbatim from `data_sync_log` row
-- 3777eabf-eba7-40ce-beff-062aa31b91cc (jobid 2, 08:00:00 -> 14:04:28 UTC):
--
--     status            partial
--     rows_inserted     0
--     elapsed_seconds   21868
--     arm_timings       {"rebuild_entity_connections_donations": 21677}
--     arms_banked       []
--     next_arm          rebuild_entity_connections_donations
--     budget_exhausted  false
--     error_message     canceled — rebuild_entity_connections_donations:
--                       canceling statement due to statement timeout
--
-- Read `budget_exhausted false` next to `elapsed_seconds 21868` against a
-- 18,000 s internal budget. The budget did not fail to trip because it was
-- sized wrong. It never got the chance to evaluate: FIX-1056 checks the budget
-- at ARM BOUNDARIES, and this run spent 99.1% of its life inside ONE arm's ONE
-- statement and never reached the next boundary. The 6 h cluster
-- statement_timeout is what finally stopped it, mid-statement, which is exactly
-- the un-banked mid-statement kill FIX-1056 exists to prevent.
--
-- ── THE GENERAL RULE THIS INSTANCE ESTABLISHES ──────────────────────────────
-- An in-procedure budget can only bound work it can get BETWEEN. It bounds the
-- number of units; it cannot bound any single unit. So an internal budget is a
-- scheduling guarantee, never a safety guarantee, and every procedure carrying
-- one still needs an outside bound sized above it. That is the same relationship
-- FIX-1063 already built for `donor-rollup-refresh` (14,400 s outside vs
-- FIX-1002's 7,200 s inside) for the same reason in a different shape: FIX-1018
-- found job 24's cost sat in the PRE-LOOP dirty-set build, before the guard
-- could evaluate anything. Pre-loop there, intra-arm here — both are the blind
-- spot of a guard that can only run between units. Playbook C3.
--
-- FIX-1069 fixes the underlying blindness by windowing the incremental
-- donations arm so the units become small enough for the internal budget to see
-- between them. This migration is the backstop that holds REGARDLESS of whether
-- that lands, and it deliberately ships FIRST and ALONE for that reason.
--
-- ── SIZING: 18,000 s (5 h) ───────────────────────────────────────────────────
-- Not a fresh guess — it is FIX-1056's own declared internal budget
-- (c_budget_default = interval '5 hours'), enforced at the layer where it can
-- actually land. That choice makes the two bounds agree by construction instead
-- of being two independent numbers that can drift apart:
--
--   * healthy incremental runs are far below it (the 08-17 run did real work —
--     4,011,180 edges — and the arm that mattered took 11,824 s);
--   * 18,000 s < 21,600 s cluster ceiling, so the watchdog always wins the race
--     and the cancel lands in FIX-1028's `WHEN query_canceled` handler, which
--     closes the row 'partial' with the cursor durable — instead of the 6 h axe
--     landing wherever it lands;
--   * on a healthy run FIX-1056's internal check trips first (same value,
--     evaluated earlier in wall-clock), so this row only ever acts when the
--     internal one is blind — which is precisely the 08-19 case.
--
-- Per FIX-1021: "a breaker that trips every Tuesday is a breaker nobody should
-- have shipped". This one has never tripped on a healthy run in the recorded
-- history of either job.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
-- Nothing about either job's command, schedule, or procedure changes. This is
-- two rows in an existing registry read by an existing watchdog (jobid 44,
-- every 2 minutes). It is additive and independently revertible with a DELETE.
--
-- Cross-ref FIX-1063 (the registry + watchdog), FIX-1056 (the internal budget
-- and the re-arm finding), FIX-1069 (the windowing that makes the arm bankable),
-- FIX-1028 (the handler the cancel lands in), FIX-1002/1018 (the same blind spot
-- one level up), FIX-985 (why the 6 h ceiling is not raised).
-- =============================================================================

INSERT INTO public.cron_job_budget (jobname, budget_seconds, note) VALUES
  ('rebuild-ec-incremental',     18000,
   'FIX-1071. 5h = FIX-1056''s own internal budget, enforced from outside because '
   'the internal one is checked at arm boundaries and cannot bound a single arm. '
   '2026-08-19 jobid 2: 21,677s inside one arm, budget_exhausted=false, 0 arms banked.'),
  ('rebuild-ec-incremental-mon', 18000,
   'FIX-1071. Same bound as jobid 2 — same procedure, same command, different day. '
   'This is the one that fires Mon 08:00 UTC against the un-drained dirty set.')
ON CONFLICT (jobname) DO NOTHING;
