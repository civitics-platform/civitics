-- FIX-218 — Index for "Top Individual Donors by State" preset.
--
-- The /api/graph/treemap-individuals endpoint groups individual donors
-- by state. Without an index on the JSON state path, queries scan the
-- ~540k+ individual donor rows (FIX-181) every time the preset loads.
-- A partial index restricted to entity_type='individual' keeps the
-- write cost low (PAC/corp rows don't bloat the index) while making
-- the per-state aggregation O(state-count) instead of O(donor-count).

CREATE INDEX IF NOT EXISTS financial_entities_individual_state_idx
  ON public.financial_entities ((metadata->>'state'))
  WHERE entity_type = 'individual';
