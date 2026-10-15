-- =============================================================================
-- FIX-1312 (cc-226) — park vote-stats-refresh, the one derived-layer pg_cron
-- job FIX-1311 left active because cc-232 did not list it. It returns only
-- through its job_registry row with a real deadline rule.
--
-- THE DECISION (Craig, Tue 2026-10-13 19:54 PDT, "recs good on 1"): the
-- dispatcher migrates from ZERO (FIX-1311's premise), so the derived layer is
-- parked whole. vote-stats-refresh (jobid 27 on prod, `CALL
-- public.rebuild_official_vote_stats();`, daily 03:30Z, guarded) derives
-- official_vote_stats from votes; it is derived-layer by every test cc-232
-- applied and was missed only because the list was written by hand.
--
-- PARKED (1, read ACTIVE on prod 2026-10-15 ~02:00Z): vote-stats-refresh.
--
-- NOT TOUCHED: every other cron.job row. The three remaining unlisted jobs
-- (vm-probe-pre-fe, vm-probe-pre-fr, votes-vacuum-analyze) are plumbing and
-- stay KEEP; FIX-1311's 18 are already parked.
--
-- THE RETURN. Its job_registry row (FIX-1307, 20261014230000) stays
-- `at 30 3 * * *`. It comes back via the registry as `by 30 3 * * *` once the
-- dispatcher (FIX-1308) is live — the row cc-224 rehearsed for the `by` path.
--
-- SHAPE — FIX-1311's, verbatim, with a one-element list:
--   * By NAME, never by jobid (FIX-946): the jobid is resolved in-statement
--     from cron.job.jobname. A missing or duplicated name RAISEs. A name
--     already inactive is a no-op, so the file is idempotent (applied twice on
--     the clone).
--   * Park, don't unschedule: active := false keeps the row, the schedule and
--     the jobid.
--   * The FIX-1059 hold row rides the same statement. rollup_watch_overrides
--     keys on the DERIVED PIPELINE (official_vote_stats_rebuild — Q_CRON_JOB_PIPELINES'
--     derivation, read on prod 2026-10-15).
--   * THE SESSION-HOLD COLLISION. This file lands through a gated push, which
--     CLAIMS a FIX-950 session, and claimProdSession() upserts a hold for every
--     guarded pipeline BEFORE the migration runs. With FIX-1311's 16 parked,
--     official_vote_stats_rebuild is the ONLY guarded pipeline the claim
--     holds (cc-220 saw "held 1"). A plain ON CONFLICT DO NOTHING would insert
--     nothing, and the release would then clear and garbage-collect that
--     session row: the park would land with ZERO hold rows. So a conflicting
--     row that is the session's own machinery (note = SESSION_HOLD_NOTE, no
--     cadence, not retired) is taken over; any other existing row is a human
--     declaration and RAISEs instead. A re-run finds its own row and changes
--     nothing. The literal is pinned to prod-session.ts' SESSION_HOLD_NOTE by
--     fix1312-park-vote-stats-refresh.test.ts.
--   * No cron_job_budget change (vote-stats-refresh has no budget row). No
--     proconfig, no SET — a DO block, not a routine (FIX-1128).
--
-- ROLLBACK: scripts/fix1312-unpark-vote-stats-refresh.sql — the mirror
-- (active := true by name, the hold row deleted by its hold_reason). A
-- db-query --call payload, NOT a migration.
-- =============================================================================

DO $$
DECLARE
  c_reason CONSTANT text :=
    'parked for the dispatcher cutover (cc-226, FIX-1312); returns via job_registry';
  -- packages/data/src/lib/prod-session.ts SESSION_HOLD_NOTE, verbatim.
  c_session_note CONSTANT text :=
    'FIX-1177/1172 — set by claimProdSession(); cleared by release(); '
    'a row with this note and no hold is inert';
  -- The job and its derived pipeline, position for position.
  c_jobs CONSTANT text[] := ARRAY[
    'vote-stats-refresh'
  ];
  c_pipes CONSTANT text[] := ARRAY[
    'official_vote_stats_rebuild'
  ];
  v_name    text;
  v_n       int;
  v_jobid   bigint;
  v_active  boolean;
  v_parked  int := 0;
  v_already int := 0;
  v_rows    int;
  v_bad     text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '[fix1312] pg_cron absent — nothing to park';
    RETURN;
  END IF;

  IF cardinality(c_jobs) <> 1 OR cardinality(c_pipes) <> 1 THEN
    RAISE EXCEPTION '[fix1312] park list is % jobs / % pipelines, expected 1 / 1',
      cardinality(c_jobs), cardinality(c_pipes);
  END IF;

  -- 1. Park, by name.
  FOREACH v_name IN ARRAY c_jobs LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1312] % cron.job rows named % — expected exactly 1; refusing to park by a name that does not resolve',
        v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF v_active THEN
      PERFORM cron.alter_job(job_id := v_jobid, active := false);
      v_parked := v_parked + 1;
      RAISE NOTICE '[fix1312] parked % (jobid %)', v_name, v_jobid;
    ELSE
      v_already := v_already + 1;
      RAISE NOTICE '[fix1312] % (jobid %) already inactive — no-op', v_name, v_jobid;
    END IF;
  END LOOP;

  -- 2. One FIX-1059 hold row for the derived pipeline, in the same statement.
  INSERT INTO public.rollup_watch_overrides AS o (pipeline, held_since, hold_reason, note)
  SELECT p.pipeline,
         now(),
         c_reason,
         format('FIX-1312 (cc-226) — pg_cron %s parked (active = false) by migration '
                '20261014220000 for the dispatcher cutover. Returns only through its '
                'job_registry row with a deadline rule; that return deletes this row. '
                'Rollback: scripts/fix1312-unpark-vote-stats-refresh.sql.',
                string_agg(p.jobname, ' + ' ORDER BY p.jobname))
  FROM unnest(c_jobs, c_pipes) AS p(jobname, pipeline)
  GROUP BY p.pipeline
  ON CONFLICT (pipeline) DO UPDATE
    SET held_since  = EXCLUDED.held_since,
        hold_reason = EXCLUDED.hold_reason,
        note        = EXCLUDED.note,
        updated_at  = now()
    WHERE o.note = c_session_note
      AND o.retired_at    IS NULL
      AND o.cadence_hours IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- 3. Guard: the parked pipeline now carries THIS hold. Anything else is a
  --    human declaration this file refused to overwrite.
  SELECT string_agg(format('%s (row %s, hold_reason %L, retired_at %s)',
                           d.pipeline,
                           CASE WHEN o.pipeline IS NULL THEN 'absent' ELSE 'present' END,
                           o.hold_reason, o.retired_at), '; ' ORDER BY d.pipeline)
    INTO v_bad
  FROM (SELECT DISTINCT pipeline FROM unnest(c_pipes) AS t(pipeline)) d
  LEFT JOIN public.rollup_watch_overrides o ON o.pipeline = d.pipeline
  WHERE o.hold_reason IS DISTINCT FROM c_reason;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[fix1312] the parked pipeline is already declared by someone else — not overwriting: %', v_bad;
  END IF;

  RAISE NOTICE '[fix1312] % job(s) parked, % already inactive; % hold row(s) written or taken over, 1 pipeline held',
    v_parked, v_already, v_rows;
END $$;
