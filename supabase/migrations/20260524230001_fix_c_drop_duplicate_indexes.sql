-- IOWait Round 2 / FIX-C — Drop true-duplicate indexes identified in
-- audit 2026-05-24 §E (docs/audits/2026-05-24-iowait-diagnosis.md).
--
-- Each pair re-verified byte-identical (modulo the UNIQUE-covers-non-unique
-- case on graph_snapshots) at ship time via
-- docs/audits/scratch/2026-05-24-round2-preflight.ts against prod.
--
-- Naming-convention rule applied: when two indexes index the same column(s)
-- with the same opclass, prefer the `idx_<table>_<column>_<type>` form
-- (added in `0008_search_indexes.sql` as the codebase convention) over the
-- legacy unprefixed form (from `0001_initial_schema.sql`). For UNIQUE vs
-- non-UNIQUE pairs on the same key, prefer UNIQUE (it serves equality
-- lookups AND enforces uniqueness; the non-unique copy adds zero value).
--
-- Total shrink: ~6.6 MB (officials pair) + ~120 kB (agencies pair) +
-- ~8 kB (graph_snapshots pair) ≈ 6.8 MB. Hygiene cleanup; main value is
-- removing footguns where a future rename would need to track two indexes.

SET lock_timeout = '5s';

-- officials — drop the legacy unprefixed name; keep idx_officials_name_trgm
-- (the `0008_search_indexes.sql` form is the convention).
DROP INDEX IF EXISTS public.officials_full_name_trgm;                -- 6.5 MB

-- agencies — drop the legacy unprefixed name; keep idx_agencies_name_trgm.
DROP INDEX IF EXISTS public.agencies_name_trgm;                      -- 120 kB

-- graph_snapshots — drop the non-unique copy; the UNIQUE constraint
-- (graph_snapshots_code_key) serves equality lookups equally well and is
-- the load-bearing index for the FK / dedup semantics.
DROP INDEX IF EXISTS public.idx_graph_snapshots_code;                -- 8 kB
