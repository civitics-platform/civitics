-- =============================================================================
-- FIX-1069 (part c) — rebuild_ec_donations_incr_close() must refuse to close a
--                     cycle it cannot see the windows for.
--
-- SELF-REVIEW FINDING, caught before the first prod run. As shipped in part (a),
-- close() decides whether the cycle is complete by counting window watermarks
-- that still lag the target:
--
--     SELECT count(*) INTO v_lag
--       FROM public.pipeline_state ps,
--            jsonb_each_text(ps.value->'windows') AS e(key, value)
--      WHERE ps.key = c_key AND (e.value)::timestamptz < p_target;
--
-- If `windows` is absent, `jsonb_each_text` yields NO ROWS, so v_lag = 0 and the
-- function reads "nothing lags, therefore everything is done". It then advances
-- the scalar `last_indexed_at` to p_target — permanently skipping every donor
-- dirtied before it, with no error and no log line. Measured:
--
--     SELECT count(*) FROM jsonb_each_text('null'::jsonb->'windows') e(k,v)
--      WHERE (e.v)::timestamptz < now();     ->  0
--
-- "Zero rows lag" and "zero rows exist" are the same number here, and they mean
-- opposite things. That is the FIX-704 invariant exactly — wasteful
-- re-enumeration is fine, a silently-skipped dirty donor is not — and it is the
-- same absent-evidence-reads-as-good-news shape as FIX-073 (an enum typo
-- returning zero rows) and the silent-zero sweep.
--
-- NOT REACHABLE VIA EITHER CURRENT CALLER: run_entity_connections_rebuild()
-- calls close() only after a clean 16-window pass, and scripts/
-- drain-ec-donations.mjs only after prepare(); prepare() always seeds all 16
-- keys before either can proceed. So this is a latent footgun for a future
-- hand-call, not a live defect — which is the cheapest possible moment to fix
-- it and the reason it is worth a migration of its own rather than a note.
--
-- THE GUARD: close only when all 16 windows are present AND all are level.
-- Absence is now a refusal, not a pass.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_close(p_target timestamptz)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  c_key      CONSTANT text := 'entity_connections_donations';
  c_expected CONSTANT int  := 16;
  v_present  int;
  v_level    int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE (e.value)::timestamptz >= p_target)
    INTO v_present, v_level
    FROM public.pipeline_state ps,
         jsonb_each_text(ps.value->'windows') AS e(key, value)
   WHERE ps.key = c_key;

  -- Absence is a refusal. Without this, "no windows recorded" counted as
  -- "no windows lagging" and closed the cycle over unprocessed donors.
  IF COALESCE(v_present, 0) <> c_expected THEN
    RAISE WARNING '[donations/incr] refusing to close: % of % window watermarks present',
      COALESCE(v_present, 0), c_expected;
    RETURN false;
  END IF;

  IF v_level <> c_expected THEN
    RETURN false;
  END IF;

  TRUNCATE public.ec_donations_incr_dirty;

  UPDATE public.pipeline_state
     SET value      = (value - 'cycle')
                      || jsonb_build_object('last_indexed_at', p_target::text),
         updated_at = now()
   WHERE key = c_key;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_incr_close(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_incr_close(timestamptz) TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_incr_close(timestamptz) IS
  'FIX-1069 — close an incremental donations cycle once ALL 16 window '
  'watermarks are present AND level with p_target: drop the staging rows and '
  'the cycle block, and set the scalar last_indexed_at. Returns false (changing '
  'nothing) if any window lags OR if the window map is absent/incomplete — '
  'part (c) made absence a refusal, because jsonb_each_text over a missing key '
  'yields no rows and "nothing lags" read identically to "nothing exists", '
  'which would have advanced the watermark over unprocessed donors.';
