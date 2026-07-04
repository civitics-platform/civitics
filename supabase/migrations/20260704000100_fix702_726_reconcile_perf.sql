-- FIX-702/726 follow-up — make the full-reconcile / bootstrap zero-pass bounded.
--
-- The first supervised prod bootstrap (2026-07-04) was ABORTED: window 1 held a
-- single transaction >5 min doing cold DataFileRead and never committed. EXPLAIN
-- on prod showed the zero-orphan pass was:
--
--   Nested Loop Anti Join
--     -> Index Scan using financial_entities_pkey  (id range)
--          Filter: total_{donated,received}_cents > 0     ← heap-fetches EVERY
--            row in the id window (~173k) just to test the > 0 filter, because
--            neither total column is indexed. ×16 windows = a full cold heap
--            scan of the 2.77M-row table, twice. THAT was the saturation.
--
-- Two fixes, both validated by EXPLAIN on the local clone:
--
--  1. Partial indexes on the "> 0" predicate so the zero-pass enumerates ONLY
--     positive-total rows via an index (bitmap) instead of heap-scanning the
--     whole id window. Low churn — the totals change only in the weekly/monthly
--     batch jobs + the FEC pipeline, never on the request path.
--       financial_entities_received_positive  — tiny (~4.5k rows).
--       financial_entities_donated_positive   — ~2.4M rows / ~55MB, but its
--         entries already satisfy > 0, so the pass reads index entries (cheap)
--         + FR probes and heap-updates only the actual orphans.
--
--  2. Range-scope the anti-join's FR side by from_id / to_id in the window
--     helpers. The correlation (fr.from_id = fe.id, fe.id in [lo,hi)) makes
--     fr.from_id implicitly in [lo,hi), but the planner did not exploit it and
--     seq-scanned all 4M FR rows PER WINDOW (16× full scans). Adding the explicit
--     range predicate is a semantic no-op (every matching row already satisfies
--     it) that turns the anti-join FR side into a per-window bitmap index scan
--     (~1/16 of FR) — so the whole reconcile is ~one FR scan + one entity scan
--     spread across 16 committed windows, with sequential (bitmap) page I/O.
--
-- Only the window helpers (bootstrap + monthly reconcile) change. The array
-- helpers (incremental dirty path) already probe small sets efficiently and are
-- untouched.

-- ── Partial indexes ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS financial_entities_received_positive
  ON public.financial_entities (id) WHERE total_received_cents > 0;

CREATE INDEX IF NOT EXISTS financial_entities_donated_positive
  ON public.financial_entities (id) WHERE total_donated_cents > 0;

-- ── Window helpers — add the range-scoped anti-join to the zero pass ─────────-
CREATE OR REPLACE FUNCTION public.financial_entity_donation_totals_window(
  p_lo uuid, p_hi uuid
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bump bigint;
  v_zero bigint;
BEGIN
  -- Pass 1 — bump (range-scoped FR aggregate → index-only on donation_size_rollup).
  UPDATE public.financial_entities fe
  SET total_donated_cents = agg.total
  FROM (
    SELECT fr.from_id, SUM(fr.amount_cents)::bigint AS total
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.from_id >= p_lo
      AND (p_hi IS NULL OR fr.from_id < p_hi)
    GROUP BY fr.from_id
  ) agg
  WHERE fe.id = agg.from_id
    AND fe.total_donated_cents IS DISTINCT FROM agg.total;
  GET DIAGNOSTICS v_bump = ROW_COUNT;

  -- Pass 2 — zero orphans. financial_entities_donated_positive drives the outer
  -- (positive rows in the id window, no heap scan for the filter); the explicit
  -- from_id range makes the anti-join FR side a per-window bitmap scan (no 16×
  -- full seq scan). The range predicate is a semantic no-op (fr.from_id = fe.id
  -- and fe.id is already in [p_lo,p_hi)).
  UPDATE public.financial_entities fe
  SET total_donated_cents = 0
  WHERE fe.id >= p_lo
    AND (p_hi IS NULL OR fe.id < p_hi)
    AND fe.total_donated_cents > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.from_type = 'financial_entity'
        AND fr.relationship_type = 'donation'
        AND fr.from_id >= p_lo
        AND (p_hi IS NULL OR fr.from_id < p_hi)
        AND fr.from_id = fe.id
    );
  GET DIAGNOSTICS v_zero = ROW_COUNT;

  RETURN v_bump + v_zero;
END;
$$;

CREATE OR REPLACE FUNCTION public.financial_entity_received_totals_window(
  p_lo uuid, p_hi uuid
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bump bigint;
  v_zero bigint;
BEGIN
  -- Pass 1 — bump (range-scoped FR aggregate → index-only on donor_rollup_idx).
  UPDATE public.financial_entities fe
  SET total_received_cents = agg.total
  FROM (
    SELECT fr.to_id, SUM(fr.amount_cents)::bigint AS total
    FROM public.financial_relationships fr
    WHERE fr.to_type = 'financial_entity'
      AND fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.to_id >= p_lo
      AND (p_hi IS NULL OR fr.to_id < p_hi)
    GROUP BY fr.to_id
  ) agg
  WHERE fe.id = agg.to_id
    AND fe.total_received_cents IS DISTINCT FROM agg.total;
  GET DIAGNOSTICS v_bump = ROW_COUNT;

  -- Pass 2 — zero orphans (financial_entities_received_positive drives the outer;
  -- to_id range scopes the anti-join FR side).
  UPDATE public.financial_entities fe
  SET total_received_cents = 0
  WHERE fe.id >= p_lo
    AND (p_hi IS NULL OR fe.id < p_hi)
    AND fe.total_received_cents > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.to_type = 'financial_entity'
        AND fr.from_type = 'financial_entity'
        AND fr.relationship_type = 'donation'
        AND fr.to_id >= p_lo
        AND (p_hi IS NULL OR fr.to_id < p_hi)
        AND fr.to_id = fe.id
    );
  GET DIAGNOSTICS v_zero = ROW_COUNT;

  RETURN v_bump + v_zero;
END;
$$;
