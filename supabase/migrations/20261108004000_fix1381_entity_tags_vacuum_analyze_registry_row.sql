-- =============================================================================
-- FIX-1381 — entity_tags gets a registry vacuum row, entity-tags-vacuum-analyze.
-- cc-264, 2026-11-07.
--
-- Prompt: cc-prompt-264-…, D6 and D7. The row was READ-THEN-DECIDE: build it only
-- if harm is measured. cc-263 read 3(h) had settled the premise, autovacuum DOES
-- fire here (the bullet's "0.2 → 893 k" and rule 430's "224 k" were both wrong; the
-- reloptions are fix652's scale factor 0.05).
--
-- THE TESTS (prod, cc-264 read 6, 2026-11-07 05:4xZ, before this file was written):
--   the trigger   50 + 0.05 × 5,471,745 reltuples = 273,637 dead tuples
--   T1 bloat      TRIPS on both arms. relpages 133,889 >= 1.05 × 124,400 = 130,620
--                 (+7.6 % on cc-244's post-repack read of 10-24; the curve reads
--                 130,321 / 130,634 / 133,889). Total 2,288.4 MB >= 1.05 × 2,168.7 =
--                 2,277.1 MB (+5.5 %). reltuples grew 0.5 %, so density fell from
--                 43.8 to 40.9 rows/page.
--   T2 lag        does not trip. autovacuum_count 5 >= 14.2 days / 3 = 4.7. The
--                 count is a floor: last_vacuum is NULL though cc-244 ran a VACUUM
--                 on 10-24, so the counters started after it.
--   Either trips → build. Reads now: 119,228 dead (60 % of the trigger is 164,182),
--   all-visible 0.672, last autovacuum 11-05 21:17:16Z.
--
-- THE ROW, on the ec/fe shape (fix1307 + fix1349): runner pg_cron, pipeline NULL,
-- unit_shape bare, priority 4, cost_class io, cap_mb 64, budget_seconds NULL (a bare
-- VACUUM's only bound is the role's 3 h, rule 311), gates {prod_session},
-- phase_lock true, idempotent_refire true.
--
-- THE GROUP IS `tags`, NOT A NEW ONE. The prompt's new group `entity-tags` rested
-- on two things the census does not support. FIX-1322's one-VACUUM cap is
-- group-independent (`r.unit_shape = 'bare' AND r.unit_call ~* '^\s*VACUUM'`), so no
-- group is needed for it. And entity_tags DOES have writers in the registry:
-- rule-taggers-daily and rule-taggers-weekly, group `tags`. ec-vacuum sits in `ec`
-- and fe-vacuum in `fe-totals` for exactly that reason, so a VACUUM of a table
-- excludes that table's writers.
--
-- WHEN IT FIRST ARMS. Not in the 04:xx window the prompt expected. The floor anchors
-- on last_autovacuum (11-05 21:17Z) + 24 h, which is already past, so the row is
-- due on the first free tick after the push's claim releases. That first arm writes
-- phase_due_at; it runs more than 4 ticks after that due, so it does not lock, and
-- the next floor anchors on its own finish + 24 h. The phase therefore lands near the
-- push's hour, around rule-taggers-daily's 06:30Z (same group: whichever is live, the
-- other waits). Monday's falls inside the post-landing pass, where the io: rung
-- decides. phase_due_at is Craig's dial if 04:xx is wanted.
--
-- THE FENCE below is required: a live row no fence seeds is red in check:job-registry
-- (ix), once the nightly's snapshot carries it.
--
-- WHAT IT COSTS: a daily VACUUM of 2.3 GB of heap + indexes, less the all-visible
-- heap. cc-244's post-repack tail read 30.8 s.
--
-- CLASS: P. One row INSERT and a read-back. It arms nothing itself.
--
-- ROLLBACK: scripts/fix1381-revert-entity-tags-vacuum-row.sql (DELETE by job). A
-- dispatch_log row naming it is history and stays. No cron row exists to park.
-- =============================================================================

-- job-registry-seed:begin
INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, phase_lock, note) VALUES
  ('entity-tags-vacuum-analyze', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.entity_tags;', 4, 'dead_tuples > 60% of trigger + floor 24 hours', 'io', 64, 'tags', NULL, '{prod_session}', true, true, 'FIX-1381 (cc-264): autovacuum fires at 50 + 0.05 x reltuples (~273.6 k dead, fix652) and lags ~2 days; relpages read 1.076 x the post-repack 124,400. Group tags = the table''s writers. no-band')
ON CONFLICT (job) DO NOTHING;
-- job-registry-seed:end

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_row     text;
  v_rule    text;
  v_group   text;
  v_lock    boolean;
  v_budget  int;
  v_box     text;
  v_gate    text;
  v_mem     text;
  v_disp    text;
  v_status  text;
BEGIN
  SELECT format('%s / %s / %s / %s / cap %s / prio %s / gates %s', j.runner, j.unit_shape, j.unit_call, j.cost_class,
                j.cap_mb::text, j.priority::text, j.gates::text),
         j.deadline_rule::text, j.exclusion_group::text, j.phase_lock, j.budget_seconds
    INTO v_row, v_rule, v_group, v_lock, v_budget
    FROM public.job_registry j WHERE j.job = 'entity-tags-vacuum-analyze';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1381] read-back failed: no entity-tags-vacuum-analyze row';
  END IF;
  IF v_rule IS DISTINCT FROM 'dead_tuples > 60% of trigger + floor 24 hours' THEN
    v_missing := v_missing || format('deadline_rule reads %s', v_rule);
  END IF;
  IF v_group IS DISTINCT FROM 'tags' OR v_lock IS DISTINCT FROM true OR v_budget IS NOT NULL THEN
    v_missing := v_missing || format('group %s / phase_lock %s / budget %s (expected tags / true / NULL)', v_group, v_lock, v_budget);
  END IF;
  IF to_regclass(substring('VACUUM (ANALYZE) public.entity_tags;' FROM '^\s*VACUUM\s*(?:\([^)]*\))?\s*([a-zA-Z0-9_."]+)')) IS DISTINCT FROM 'public.entity_tags'::regclass THEN
    v_missing := v_missing || 'the dispatcher''s vac_rel regex does not resolve the unit_call'::text;
  END IF;

  SELECT md5(prosrc) INTO v_box FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_gate FROM pg_proc WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_mem FROM pg_proc WHERE proname = 'record_box_health_mem' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_disp FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_status FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_box IS DISTINCT FROM 'aaf6cc6552df532eff4a9b21e9780670' OR v_gate IS DISTINCT FROM '6488601cf8c09287d540989c0e0fd074' OR v_mem IS DISTINCT FROM 'de9ebee733077a59dfe2959981f8e0c3' THEN
    v_missing := v_missing || format('the rung''s bodies moved: box %s / gate %s / mirror %s', v_box, v_gate, v_mem);
  END IF;
  IF v_disp IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18' OR v_status IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6' THEN
    v_missing := v_missing || format('the dispatcher pair moved: %s / %s', v_disp, v_status);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1381] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1381] read-back ok: entity-tags-vacuum-analyze %; rule %; group %; phase_lock %; budget NULL; pins box % · gate % · dispatch_one_unit % · get_dispatcher_status %',
    v_row, v_rule, v_group, v_lock, v_box, v_gate, v_disp, v_status;
END $$;
