-- FIX-246: tier column on officials to distinguish elected from candidate-only rows.
--
-- FEC candidate master (cn{yy}.zip) ingests every certified FEC candidate per cycle as
-- tier='candidate'. Existing officials (Congress members, agency heads, judges, state
-- legislators) remain tier='elected' via the DEFAULT.
--
-- 'former' is future work — requires term-end tracking. Widen the CHECK then.

ALTER TABLE public.officials
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'elected'
    CHECK (tier IN ('elected', 'candidate'));

CREATE INDEX IF NOT EXISTS officials_tier_idx ON public.officials(tier);
