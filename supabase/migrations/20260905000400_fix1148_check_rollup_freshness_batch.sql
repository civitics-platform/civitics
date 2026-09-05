-- 20260905000400_fix1148_check_rollup_freshness_batch.sql
-- FIX-1148 — the canary asks check_rollup_freshness 49 times; one call answers.
--
-- ── THE LOOP ────────────────────────────────────────────────────────────────
-- canary-check.ts `fetchRollupFreshness` walks the registry returned by
-- `list_scheduled_rollup_pipelines()` and issues one PostgREST
-- `rpc(check_rollup_freshness)` per pipeline. The registry currently holds 49
-- pipelines, so a canary run makes 49 round trips — each with its own
-- connection accept, PostgREST plan, and JSON envelope — to assemble one array.
-- On an instance whose measured failure mode is connection-accept pressure
-- (FIX-1052, FIX-1073), 49 sequential accepts is not free, and the canary runs
-- inside the nightly window where that pressure is highest.
--
-- ── THE SHAPE, AND WHY THE UNIT DOES NOT MOVE ──────────────────────────────
-- `check_rollup_freshness(text, int)` stays EXACTLY as it is and remains the
-- unit of judgement. The batch is a loop moved into the database and nothing
-- else: it CROSS JOIN LATERALs the unchanged per-pipeline function over a jsonb
-- array of {pipeline, cadence_hours}. There is no second implementation of the
-- verdict, so the two cannot drift — which is the whole reason not to write a
-- set-based rewrite that "does the same thing".
--
-- Returns ONE jsonb array rather than a set of rows. PostgREST caps a
-- set-returning RPC at 1000 rows and the array is the established shape on this
-- codebase for "many results, one call"; at 49 elements neither matters much,
-- but the cap is a real edge and the array has no edge at all. Element order
-- follows input order (WITH ORDINALITY), and each element already carries its
-- own 'pipeline' key, so the caller can key by name and never depends on order.
--
-- The caller keeps the FIX-1135 ROUNDING exactly: `check_rollup_freshness`
-- takes `p_max_age_hours int`, and an observed median now yields fractional
-- cadences (163.88h → a 245.8h report threshold). Passing the raw value made
-- PostgREST reject the call with `invalid input syntax for type integer:
-- "245.8"` and silently un-checked 20 of 49 pipelines. `cadence_hours int` in
-- the recordset column list is the same coercion, one layer down, and the
-- caller rounds before it builds the array.
--
-- STABLE, SECURITY INVOKER, service_role only — same posture as the function it
-- wraps (which is STABLE, SECURITY INVOKER, search_path=public, granted to
-- service_role alone).
--
-- Cross-ref FIX-1135, FIX-1059, FIX-977b, FIX-1140, FIX-834.
--
-- Fixes: FIX-1148
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_rollup_freshness_batch(p_items jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT COALESCE(jsonb_agg(f.result ORDER BY i.ord), '[]'::jsonb)
  -- ROWS FROM (…), not a bare WITH ORDINALITY: Postgres rejects WITH ORDINALITY
  -- on a function that carries a column definition list (42601), and
  -- jsonb_to_recordset needs one.
  FROM ROWS FROM (jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb))
                    AS (pipeline text, cadence_hours int))
         WITH ORDINALITY AS i(pipeline, cadence_hours, ord)
  CROSS JOIN LATERAL public.check_rollup_freshness(i.pipeline, i.cadence_hours) AS f(result);
$function$;

REVOKE ALL ON FUNCTION public.check_rollup_freshness_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rollup_freshness_batch(jsonb) TO service_role;

COMMENT ON FUNCTION public.check_rollup_freshness_batch(jsonb) IS
  'FIX-1148 — batched form of check_rollup_freshness. Takes a jsonb array of '
  '{pipeline, cadence_hours} and returns a jsonb array of the SAME objects the '
  'per-pipeline function returns, in input order, by CROSS JOIN LATERAL over that '
  'unchanged function. The per-pipeline function stays the unit of judgement so '
  'verdict semantics cannot drift; this only collapses 49 PostgREST round trips '
  'into one. Callers must round cadence_hours to an int before calling (FIX-1135).';

-- Guard: the batch must agree with the loop, element for element, on whatever
-- pipelines this environment actually has. A shape that returns the right count
-- of wrong objects is the failure worth catching here.
DO $$
DECLARE
  v_items  jsonb;
  v_batch  jsonb;
  v_one    jsonb;
  v_n      int;
  r        record;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('pipeline', pipeline, 'cadence_hours', 48)), '[]'::jsonb)
    INTO v_items
  FROM (SELECT DISTINCT pipeline FROM public.data_sync_log
         WHERE started_at > NOW() - interval '30 days'
         ORDER BY 1 LIMIT 60) s;

  v_n := jsonb_array_length(v_items);
  IF v_n = 0 THEN
    RAISE NOTICE '[fix1148] no pipelines in the lookback — parity check skipped';
    RETURN;
  END IF;

  v_batch := public.check_rollup_freshness_batch(v_items);

  IF jsonb_array_length(v_batch) <> v_n THEN
    RAISE EXCEPTION '[fix1148] batch returned % elements for % items',
      jsonb_array_length(v_batch), v_n;
  END IF;

  FOR r IN SELECT (e.value->>'pipeline') AS pipeline, (e.ord - 1)::int AS idx
             FROM jsonb_array_elements(v_items) WITH ORDINALITY AS e(value, ord)
  LOOP
    v_one := public.check_rollup_freshness(r.pipeline, 48);
    -- `hours_since_complete` is NOW()-relative and moves between the two calls,
    -- so compare everything that is a verdict and not a clock reading.
    IF (v_batch -> r.idx) - 'hours_since_complete' IS DISTINCT FROM v_one - 'hours_since_complete' THEN
      RAISE EXCEPTION '[fix1148] batch and loop disagree for %: % vs %',
        r.pipeline, v_batch -> r.idx, v_one;
    END IF;
  END LOOP;

  RAISE NOTICE '[fix1148] batch matches the loop on all % pipelines', v_n;
END $$;
