-- FIX-614 / SF-P14 — authored position-rollup DISPLAY seam (synthetic only).
--
-- For SYNTHETIC entities only, render an AUTHORED position-rollup distribution
-- (labeled SYNTHETIC, display-only). The live get_entity_position_rollup()
-- continues to EXCLUDE synthetic from all real standing — this adds a PARALLEL
-- display path, it does NOT relax the gate.
--
-- Mechanically identical to two moves already shipped:
--   * bridge_score on synthetic comments — the live scorer excludes synthetic,
--     the seed AUTHORS the column, the display reads it. Scorer never reads it.
--   * commons_active_threads (Option 2) — carries is_synthetic, renders labeled,
--     confers nothing.
--
-- ISOLATION (the cardinal rule): synthetic_position_rollup is read by EXACTLY ONE
-- function — get_position_rollup_display(). It must NEVER feed
-- compute_alignment_score, user_civic_stats, the choropleth, the bridge scorer,
-- or any computation that confers standing/consequence. Those read entity_positions
-- (still synthetic-gated by author_excluded_from_standing); none of them reference
-- this table. Grep `synthetic_position_rollup` to audit: the only readers are this
-- migration's RPC and the franklin seed loader's writer.

-- ─── 1. Authored display table (synthetic-only by construction) ───────────────
CREATE TABLE IF NOT EXISTS public.synthetic_position_rollup (
  entity_type text NOT NULL
    CHECK (entity_type IN ('proposal','official','jurisdiction','institution','financial_entity','district')),
  entity_id   uuid NOT NULL,
  buckets     jsonb   NOT NULL,        -- 7-stop "-3".."3" → count
  median      numeric NOT NULL,        -- authored median stance stop
  n           int     NOT NULL,        -- authored total
  constituent jsonb,                   -- optional {buckets, median, n} for the constituent lens
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

COMMENT ON TABLE public.synthetic_position_rollup IS
  'FIX-614: AUTHORED, DISPLAY-ONLY position-rollup distributions for synthetic entities. Read by get_position_rollup_display() ONLY. Confers no standing — never read by compute_alignment_score / user_civic_stats / the choropleth / the bridge scorer. The live get_entity_position_rollup() still excludes synthetic. Mirrors authored bridge_score on synthetic comments.';

-- ─── 2. The single display read path (branches synthetic → authored) ──────────
-- Real entities delegate to the UNCHANGED get_entity_position_rollup (still
-- synthetic-gated). Synthetic entities read the authored row. Returns an extra
-- `synthetic` boolean so the UI can render the SYNTHETIC (SF-P2) label.
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
        NULL::numeric,
        v_row.constituent->'buckets',
        true;
      RETURN;
    END IF;

    RETURN QUERY SELECT v_row.n, v_row.median, NULL::numeric, v_row.buckets, true;
    RETURN;
  END IF;

  -- Real entity → the UNCHANGED live aggregate (excludes synthetic positions).
  RETURN QUERY
    SELECT r.n, r.median, r.pct_with_conditions, r.buckets, false
    FROM public.get_entity_position_rollup(p_entity_type, p_entity_id, p_lens) r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_position_rollup_display(text, uuid, text) TO anon, authenticated, service_role;

-- service_role writes the authored rows from the franklin seed loader.
GRANT SELECT ON public.synthetic_position_rollup TO service_role;
