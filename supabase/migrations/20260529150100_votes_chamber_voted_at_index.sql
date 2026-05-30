-- FIX-439 (follow-up): composite index backing get_institution_recent_votes v2.
--
-- recent_calls filters votes by (chamber = X AND voted_at > now()-180d) and takes
-- the most recent roll calls. Without this index the planner range-scans
-- votes_voted_at for the whole window (~84k rows across both chambers) then
-- discards the other chamber by filter — cheap warm (~1s) but ~13s cold because
-- the heap blocks are uncached. That cold path risks tripping the function's 3s
-- statement_timeout on prod and returning an empty Recent Votes section.
--
-- (chamber, voted_at DESC) lets the scan touch only the target chamber's windowed
-- rows (~8k for the Senate), keeping it fast cold and warm. votes is written by
-- batch pipelines, not the request path, so the brief build-time lock is fine.

CREATE INDEX IF NOT EXISTS votes_chamber_voted_at
  ON public.votes (chamber, voted_at DESC);
