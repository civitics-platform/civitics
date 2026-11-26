-- =============================================================================
-- FIX-1453 — the bill-details walker becomes a dispatcher unit, a mirror of
-- crs-summaries (cc-328 D6). cc-318 built the one-row GHA end it needs (FIX-1454,
-- dispatch_one_unit d0f5bf5b…, on prod since 2026-11-26 08:09:53Z) and kept this
-- row out on Craig's ruling until the co_sponsorship-edge decision; Craig
-- ratified the edges on 2026-11-26 (09:02Z) and FIX-1456 made the cosponsor arm
-- a merge first (20261126007000).
--
-- THE ROW. One INSERT into job_registry, every column but four equal to what
--   cc-318 set on crs-summaries (20261126004000 §3):
--     job            bill-details
--     unit_call      gha-dispatch:bill-details   (the arm writes
--                    gha_dispatch_request_bill-details; the bill-details-request
--                    target, every 5 min, fires bill-details.yml with only "all"
--                    and max_minutes "15" and consumes it)
--     pipeline       congress_bill_details        (bill-details.ts PIPELINE: one
--                    data_sync_log row a run, no metadata.phase, so 3b ends the
--                    request on it)
--     note           its own
--   and, as crs-summaries: runner github_actions, unit_shape resumable,
--   priority 5, deadline_rule stale_after 2 hours, cost_class cpu, cap_mb 16,
--   exclusion_group proposals (the shared congress.gov key: one walker at a
--   time), budget_seconds 2700, gates {prod_session}, idempotent_refire true,
--   phase_lock false, yield_to {nightly} at 2,400 s.
--   Craig's pace: 15 minutes when 2 hours stale. only "all" already orders the
--   voted measures first (bill-details.ts selectTargets), so the fill takes the
--   ~1,566 voted measures first and then the rest of the ~8,986, then rests on
--   the metadata.next_due_at (now + 12 h) an empty selection reports.
--
-- THE ORDER (D7, cc-318's): the bill-details-request route is deployed before
--   this file is pushed, or the first arm reads `missed`.
--
-- THE FENCE below is required: a live row no fence seeds is red in
--   check:job-registry (ix) once the nightly's snapshot carries it.
--
-- GUARD: no bill-details row yet (or this file's, on a re-run), and
--   crs-summaries reads as cc-318 left it. READ-BACK: the row as written, the
--   pick's eligibility predicate admits it, crs-summaries unchanged, the
--   dispatch_one_unit pin unchanged; the eligible count is printed.
--
-- CLASS: P. One row INSERT and a read-back. It arms nothing itself: the next
--   free tick does, when the row is due (it has never run, so at once).
--
-- ROLLBACK: scripts/fix1453-revert-bill-details-row.sql (DELETE by job) through
--   the gate. A dispatch_log row naming it is history and stays. The
--   bill-details-request cron is a vercel.json line to remove by commit; with no
--   row it reads no request and fires nothing.
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) the guard
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_crs  CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:crs-summaries | congress_crs_summaries | resumable | 5 | cpu | 16 | proposals | 2700 | {prod_session} | t | {nightly} | 2400';
  c_mine CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:bill-details | congress_bill_details | resumable | 5 | cpu | 16 | proposals | 2700 | {prod_session} | t | {nightly} | 2400';
  v_crs  text;
  v_bd   text;
BEGIN
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, yield_to, yield_lead_seconds)
    INTO v_crs FROM public.job_registry WHERE job = 'crs-summaries';
  IF v_crs IS DISTINCT FROM c_crs THEN
    RAISE EXCEPTION '[fix1453] crs-summaries reads %, not as cc-318 left it (%) — the model row moved; rebuild this file on it', v_crs, c_crs;
  END IF;
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, yield_to, yield_lead_seconds)
    INTO v_bd FROM public.job_registry WHERE job = 'bill-details';
  IF FOUND AND v_bd IS DISTINCT FROM c_mine THEN
    RAISE EXCEPTION '[fix1453] a bill-details row already exists and is not this file''s: %', v_bd;
  END IF;
  RAISE NOTICE '[fix1453] guard: crs-summaries as cc-318 left it; bill-details %', COALESCE(v_bd, 'absent');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) the row
-- ═══════════════════════════════════════════════════════════════════════════

-- job-registry-seed:begin
INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, phase_lock, yield_to, yield_lead_seconds, note) VALUES
  ('bill-details', 'github_actions', 'congress_bill_details', 'resumable', 'gha-dispatch:bill-details', 5, 'stale_after 2 hours', 'cpu', 16, 'proposals', 2700, '{prod_session}', true, false, '{nightly}', 2400, 'FIX-1453 (cc-328): the congress.gov bill-details walker (sponsor, cosponsors, actions, titles, introduced dates; FIX-1452), one congress_bill_details data_sync_log row a run; no-band. A mirror of crs-summaries (cc-318): due 2 h after its last complete | partial row, or at the metadata.next_due_at (now + 12 h) a run with nothing to take reports; the bill-details-request target sends only "all" and max_minutes "15" (apps/civitics/src/lib/gha-dispatch.ts), and only all takes the voted measures first. Group proposals is the shared congress.gov key: one walker at a time. yield_to nightly at 2,400 s keeps a run clear of the nightly''s congress phase. budget_seconds 2,700 = the run + the */5 poll + the runner''s start + slack. cap_mb 16: single-row writes, one transaction a measure.')
ON CONFLICT (job) DO NOTHING;
-- job-registry-seed:end

-- ═══════════════════════════════════════════════════════════════════════════
-- (3) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_row  CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:bill-details | congress_bill_details | resumable | 5 | cpu | 16 | proposals | 2700 | {prod_session} | t | f | {nightly} | 2400';
  c_crs  CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:crs-summaries | congress_crs_summaries | resumable | 5 | cpu | 16 | proposals | 2700 | {prod_session} | t | f | {nightly} | 2400';
  c_disp CONSTANT text := 'd0f5bf5b59120716ab15e73c805435d2';
  v_missing text[] := '{}';
  v_row  text;
  v_crs  text;
  v_disp text;
  v_elig int;
  v_mine boolean;
BEGIN
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, phase_lock, yield_to, yield_lead_seconds),
         (deadline_rule NOT LIKE 'at %' AND unit_call ~ '^gha-dispatch:[a-z0-9-]+$')
    INTO v_row, v_mine FROM public.job_registry WHERE job = 'bill-details';
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, phase_lock, yield_to, yield_lead_seconds)
    INTO v_crs FROM public.job_registry WHERE job = 'crs-summaries';
  SELECT md5(prosrc) INTO v_disp FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT count(*) INTO v_elig FROM public.job_registry j
   WHERE j.deadline_rule NOT LIKE 'at %' AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$');
  IF v_row IS DISTINCT FROM c_row THEN
    v_missing := v_missing || format('bill-details reads %L, expected %L', v_row, c_row)::text;
  END IF;
  IF v_mine IS DISTINCT FROM true THEN
    v_missing := v_missing || 'the pick''s eligibility predicate does not admit bill-details'::text;
  END IF;
  IF v_crs IS DISTINCT FROM c_crs THEN
    v_missing := v_missing || format('crs-summaries reads %L, expected %L', v_crs, c_crs)::text;
  END IF;
  IF v_disp IS DISTINCT FROM c_disp THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s moved (pin %s)', v_disp, c_disp)::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1453] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1453] read-back ok: bill-details %; % eligible rows; crs-summaries unchanged; dispatch_one_unit %',
    v_row, v_elig, v_disp;
END $$;
