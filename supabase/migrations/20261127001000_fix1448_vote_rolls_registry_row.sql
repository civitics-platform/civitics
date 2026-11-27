-- =============================================================================
-- FIX-1448 (cc-331 D7) — the vote-rolls walker becomes a dispatcher unit, a
-- mirror of bill-details (20261126008000, cc-330) in every column but five.
--
-- THE ROW. One INSERT into job_registry:
--     job            vote-rolls
--     unit_call      gha-dispatch:vote-rolls   (the arm writes
--                    gha_dispatch_request_vote-rolls; the vote-rolls-request
--                    target, every 5 min, fires vote-rolls.yml with max_minutes
--                    "15" and consumes it)
--     pipeline       congress_vote_rolls        (vote-rolls.ts PIPELINE: one
--                    data_sync_log row a run, no metadata.phase, so 3b ends the
--                    request on it)
--     exclusion_group vote-rolls               its own: it shares no key and no
--                    host with the congress.gov walkers (group proposals). It
--                    shares senate.gov and clerk.house.gov with the nightly,
--                    which yield_to {nightly} and the walker's own D6 window
--                    (no senate.gov request 15:00Z → the votes phase's end)
--                    cover. Its only votes read is the seed's index walk.
--     note           its own
--   and, as bill-details: runner github_actions, unit_shape resumable,
--   priority 5, deadline_rule stale_after 2 hours, cost_class cpu, cap_mb 16,
--   budget_seconds 2700, gates {prod_session}, idempotent_refire true,
--   phase_lock false, yield_to {nightly} at 2,400 s.
--
-- THE UNIT (cc-331 D7). Anchor: the newest closed congress_vote_rolls row, a
--   terminal run's included, or the metadata.next_due_at (now + 12 h) a run
--   with nothing left reports. End: step 3b ends the request on that one row
--   (reaped succeeded: GHA). Orphan: a run still open at budget_seconds is
--   reaped; a SIGTERM at the workflow's 60-min cap is closed by its mark-killed
--   step. Shared: senate.gov and clerk.house.gov with the nightly; votes'
--   votes_roll_call index (the seed); it writes only vote_rolls.
--
-- THE ORDER (D7): the vote-rolls-request route is deployed before this file is
--   pushed (cc-331 Item 3), or the first arm reads `missed`.
--
-- GUARD: no vote-rolls row yet (or this file's, on a re-run), and bill-details
--   reads as cc-330 left it. READ-BACK: the row as written, the pick's
--   eligibility predicate admits it, bill-details unchanged, the
--   dispatch_one_unit pin unchanged; the eligible count is printed (37 → 38).
--
-- CLASS: P. One row INSERT and a read-back. It arms nothing itself: the next
--   free tick does, two hours after the newest closed congress_vote_rolls row.
--
-- ROLLBACK: scripts/fix1448-revert-vote-rolls-row.sql (DELETE by job) through
--   the gate. A dispatch_log row naming it is history and stays. The
--   vote-rolls-request cron is a vercel.json line to remove by commit; with no
--   row it reads no request and fires nothing.
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) the guard
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_bd   CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:bill-details | congress_bill_details | resumable | 5 | cpu | 16 | proposals | 2700 | {prod_session} | t | {nightly} | 2400';
  c_mine CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:vote-rolls | congress_vote_rolls | resumable | 5 | cpu | 16 | vote-rolls | 2700 | {prod_session} | t | {nightly} | 2400';
  v_bd   text;
  v_vr   text;
BEGIN
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, yield_to, yield_lead_seconds)
    INTO v_bd FROM public.job_registry WHERE job = 'bill-details';
  IF v_bd IS DISTINCT FROM c_bd THEN
    RAISE EXCEPTION '[fix1448] bill-details reads %, not as cc-330 left it (%) — the model row moved; rebuild this file on it', v_bd, c_bd;
  END IF;
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, yield_to, yield_lead_seconds)
    INTO v_vr FROM public.job_registry WHERE job = 'vote-rolls';
  IF FOUND AND v_vr IS DISTINCT FROM c_mine THEN
    RAISE EXCEPTION '[fix1448] a vote-rolls row already exists and is not this file''s: %', v_vr;
  END IF;
  RAISE NOTICE '[fix1448] guard: bill-details as cc-330 left it; vote-rolls %', COALESCE(v_vr, 'absent');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) the row
-- ═══════════════════════════════════════════════════════════════════════════

-- job-registry-seed:begin
INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, phase_lock, yield_to, yield_lead_seconds, note) VALUES
  ('vote-rolls', 'github_actions', 'congress_vote_rolls', 'resumable', 'gha-dispatch:vote-rolls', 5, 'stale_after 2 hours', 'cpu', 16, 'vote-rolls', 2700, '{prod_session}', true, false, '{nightly}', 2400, 'FIX-1448 (cc-331): the vote-rolls walker (each federal roll''s own totals, result, title and majority requirement into vote_rolls: seed by an index walk of votes_roll_call, the six Senate session lists, then the per-roll files from clerk.house.gov and senate.gov), one congress_vote_rolls data_sync_log row a run; no-band. A mirror of bill-details (cc-330) but for its own exclusion group: it shares no key and no host with the congress.gov walkers. Due 2 h after its last complete | partial row, or at the metadata.next_due_at (now + 12 h) a run with nothing left reports; the vote-rolls-request target sends max_minutes "15" (apps/civitics/src/lib/gha-dispatch.ts). yield_to nightly at 2,400 s, and the walker asks senate.gov nothing from 15:00Z until the nightly''s votes phase closes (D6): the nightly''s senate.gov allowance comes first. budget_seconds 2,700 = the run + the */5 poll + the runner''s start + slack. cap_mb 16: single-row writes.')
ON CONFLICT (job) DO NOTHING;
-- job-registry-seed:end

-- ═══════════════════════════════════════════════════════════════════════════
-- (3) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  c_row  CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:vote-rolls | congress_vote_rolls | resumable | 5 | cpu | 16 | vote-rolls | 2700 | {prod_session} | t | f | {nightly} | 2400';
  c_bd   CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:bill-details | congress_bill_details | resumable | 5 | cpu | 16 | proposals | 2700 | {prod_session} | t | f | {nightly} | 2400';
  c_disp CONSTANT text := 'd0f5bf5b59120716ab15e73c805435d2';
  v_missing text[] := '{}';
  v_row  text;
  v_bd   text;
  v_disp text;
  v_elig int;
  v_mine boolean;
BEGIN
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, phase_lock, yield_to, yield_lead_seconds),
         (deadline_rule NOT LIKE 'at %' AND unit_call ~ '^gha-dispatch:[a-z0-9-]+$')
    INTO v_row, v_mine FROM public.job_registry WHERE job = 'vote-rolls';
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline, unit_shape, priority, cost_class, cap_mb,
                   exclusion_group, budget_seconds, gates, idempotent_refire, phase_lock, yield_to, yield_lead_seconds)
    INTO v_bd FROM public.job_registry WHERE job = 'bill-details';
  SELECT md5(prosrc) INTO v_disp FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT count(*) INTO v_elig FROM public.job_registry j
   WHERE j.deadline_rule NOT LIKE 'at %' AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$');
  IF v_row IS DISTINCT FROM c_row THEN
    v_missing := v_missing || format('vote-rolls reads %L, expected %L', v_row, c_row)::text;
  END IF;
  IF v_mine IS DISTINCT FROM true THEN
    v_missing := v_missing || 'the pick''s eligibility predicate does not admit vote-rolls'::text;
  END IF;
  IF v_bd IS DISTINCT FROM c_bd THEN
    v_missing := v_missing || format('bill-details reads %L, expected %L', v_bd, c_bd)::text;
  END IF;
  IF v_disp IS DISTINCT FROM c_disp THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s moved (pin %s)', v_disp, c_disp)::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1448] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1448] read-back ok: vote-rolls %; % eligible rows; bill-details unchanged; dispatch_one_unit %',
    v_row, v_elig, v_disp;
END $$;
