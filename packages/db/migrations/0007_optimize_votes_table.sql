-- Drop low-cardinality index (4 distinct values across 226K rows — B-tree not useful)
DROP INDEX IF EXISTS public.votes_vote;

-- Drop source_url column (100% NULL, no data ever populated)
ALTER TABLE public.votes DROP COLUMN IF EXISTS source_url;
