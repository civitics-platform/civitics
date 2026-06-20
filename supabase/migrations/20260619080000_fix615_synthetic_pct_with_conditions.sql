-- FIX-615 — light the TermsOfConsensus panel on synthetic proposals.
--
-- FIX-614 shipped the authored position-rollup display seam but left
-- pct_with_conditions NULL on the synthetic branch (the panel's "% of N
-- positions name a condition" line). This adds the authored column and carries
-- it through get_position_rollup_display, mirroring how median/n/buckets are
-- already authored. DISPLAY-ONLY: same cardinal isolation as FIX-614 —
-- synthetic_position_rollup is read by EXACTLY ONE function
-- (get_position_rollup_display) and NEVER by compute_alignment_score,
-- user_civic_stats, the choropleth, or the bridge scorer. The live
-- get_entity_position_rollup() (real entities) is untouched.

-- ─── 1. Authored pct column (synthetic-only table) ───────────────────────────
ALTER TABLE public.synthetic_position_rollup
  ADD COLUMN IF NOT EXISTS pct_with_conditions numeric;  -- fraction 0..1, NULL = omit the line

-- ─── 2. Carry pct through the single display read path ───────────────────────
-- Identical to the FIX-614 function except the two synthetic RETURN QUERY rows
-- now emit the authored pct (all lens → column; constituent lens → optional
-- constituent->>'pct_with_conditions'). Real-entity branch unchanged — still
-- delegates to the synthetic-gated get_entity_position_rollup().
CREATE OR REPLACE FUNCTION public.get_position_rollup_display(
  p_entity_type text,
  p_entity_id   uuid,
  p_lens        text DEFAULT 'all'
) RETURNS TABLE (
  n                   int,
  median              numeric,
  pct_with_conditions numeric,
  buckets             jsonb,
  synthetic           boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_lens text := CASE WHEN p_lens = 'constituents' THEN 'constituents' ELSE 'all' END;
  v_row  public.synthetic_position_rollup;
BEGIN
  IF public.is_synthetic_entity(p_entity_type, p_entity_id) THEN
    -- Synthetic → authored display rollup (no standing, no min-n gate: the author
    -- only writes rollups that are meant to render).
    SELECT * INTO v_row
    FROM public.synthetic_position_rollup spr
    WHERE spr.entity_type = p_entity_type AND spr.entity_id = p_entity_id;

    -- Absent authored rollup → gate stays closed (the strip shows its empty state).
    IF v_row.entity_id IS NULL THEN
      RETURN QUERY SELECT 0, NULL::numeric, NULL::numeric, NULL::jsonb, true;
      RETURN;
    END IF;

    IF v_lens = 'constituents' THEN
      -- Constituent subset is optional; absent → gated empty state on this lens only.
      IF v_row.constituent IS NULL THEN
        RETURN QUERY SELECT 0, NULL::numeric, NULL::numeric, NULL::jsonb, true;
        RETURN;
      END IF;
      RETURN QUERY SELECT
        (v_row.constituent->>'n')::int,
        (v_row.constituent->>'median')::numeric,
        (v_row.constituent->>'pct_with_conditions')::numeric,
        v_row.constituent->'buckets',
        true;
      RETURN;
    END IF;

    RETURN QUERY SELECT v_row.n, v_row.median, v_row.pct_with_conditions, v_row.buckets, true;
    RETURN;
  END IF;

  -- Real entity → the UNCHANGED live aggregate (excludes synthetic positions).
  RETURN QUERY
    SELECT r.n, r.median, r.pct_with_conditions, r.buckets, false
    FROM public.get_entity_position_rollup(p_entity_type, p_entity_id, p_lens) r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_position_rollup_display(text, uuid, text) TO anon, authenticated, service_role;
