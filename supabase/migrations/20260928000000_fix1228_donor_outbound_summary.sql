-- =============================================================================
-- FIX-1228 — donor_outbound_summary(): exact recipients and top-N by sum for one
-- donor
-- =============================================================================
--
-- THE BUG. /donors/[id] read the donor's top 1,000 outbound donation rows BY
-- AMOUNT and summed them per recipient in JS. So "Top recipients" was a
-- top-50-by-sum over a top-1,000-by-amount sample, and the Recipients stat
-- (recipients.length) was that sample's distinct count. For any donor with
-- more than 1,000 outbound rows both were wrong — the shape FIX-1225 fixed on
-- the inbound side.
--
-- Measured on prod 2026-09-28 (cc-168 read 5), the three largest donors by
-- outbound rows:
--
--   donor                              rows   exact   sample   top-50 members wrong
--   NAR PAC            04b3a83a…      2,074     830      536     11
--   NBWA PAC           016861e2…      1,762     726      520      8
--   America's CU PAC   7e59c437…      1,759     771      523      5
--
-- Every recipient of all three is an official (to_type mix: official only).
--
-- THE FIX. One exact aggregate over the donor's outbound donation rows,
-- returned as ONE jsonb (a set-returning RPC is capped at 1,000 rows by
-- PostgREST — reference_postgrest_rpc_row_cap):
--
--   distinct_recipients  count(DISTINCT to_id)            the Recipients stat
--   rows                 count(*)                          the "N transactions" note
--   total_cents          sum(amount_cents)
--   cycles               distinct cycle_year, ascending    the page's cycles-active note
--   top                  the top p_top recipients by sum(amount_cents), each
--                        {to_type, to_id, total_cents, tx_count, cycles}
--
-- `cycles` is not in the design's shape. It is here because the page's Donors
-- note falls back to "N cycles" computed from the outbound rows, and without it
-- that number would stay a sample while the stat beside it became exact.
--
-- Ties in the top list break on to_id, so the list is deterministic.
--
-- PLAN AND BOUND. The rows are found by financial_relationships_donation_size_rollup
-- (from_id) INCLUDE (amount_cents) WHERE from_type='financial_entity' AND
-- relationship_type='donation' — a seek on from_id. to_id / to_type /
-- cycle_year come from the heap, at most one heap tuple per outbound row:
-- ≤ 2,074 on prod (read 5; no whale class — the FIX-1228 bullet measured the
-- max). Measured (cc-168, 2026-09-28):
--
--   prod, plain EXPLAIN   Index Scan using financial_relationships_donation_size_rollup
--                         Index Cond: (from_id = '04b3a83a…'), heap for the rest
--   clone, 2,279 rows     cold: 1,421 ms, shared read=995 (one heap page per row,
--                         near enough); warm: 7.7 ms, shared hit=2,307. The clone
--                         planner picked financial_relationships_derivation — the
--                         same from_id seek + heap shape.
--
-- The cold figure is the honest ceiling: the page's old `donors:outbound` read
-- fetched the same heap tuples (1,000 of them, with metadata), so this is the
-- cost the page already paid, not a new one. No proconfig statement_timeout
-- (FIX-1128: a routine-level one bounds nothing, and check:proconfig refuses
-- it). The bound is the caller's role: anon's 3 s, authenticated's 8 s.
--
-- GRANTS. The get_official_page precedent: SECURITY INVOKER (RLS applies as
-- the caller; financial_relationships is public-readable), EXECUTE for anon,
-- authenticated and service_role.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.donor_outbound_summary(p_donor_id uuid, p_top int DEFAULT 50)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH r AS (
    SELECT fr.to_type, fr.to_id, fr.amount_cents, fr.cycle_year
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
      AND fr.from_id = p_donor_id
  ),
  per_recipient AS (
    SELECT to_type,
           to_id,
           coalesce(sum(amount_cents), 0)::bigint AS total_cents,
           count(*)::int AS tx_count,
           coalesce(
             array_agg(DISTINCT cycle_year ORDER BY cycle_year) FILTER (WHERE cycle_year IS NOT NULL),
             '{}'::int[]
           ) AS cycles
    FROM r
    GROUP BY to_type, to_id
  ),
  top AS (
    SELECT *
    FROM per_recipient
    ORDER BY total_cents DESC, to_id
    LIMIT greatest(coalesce(p_top, 50), 0)
  )
  SELECT jsonb_build_object(
    'distinct_recipients', (SELECT count(DISTINCT to_id) FROM r),
    'rows',                (SELECT count(*) FROM r),
    'total_cents',         (SELECT coalesce(sum(amount_cents), 0)::bigint FROM r),
    'cycles',              (SELECT coalesce(jsonb_agg(DISTINCT cycle_year ORDER BY cycle_year), '[]'::jsonb)
                              FROM r WHERE cycle_year IS NOT NULL),
    'top',                 coalesce(
                             (SELECT jsonb_agg(
                                       jsonb_build_object(
                                         'to_type',     to_type,
                                         'to_id',       to_id,
                                         'total_cents', total_cents,
                                         'tx_count',    tx_count,
                                         'cycles',      to_jsonb(cycles)
                                       )
                                       ORDER BY total_cents DESC, to_id
                                     )
                                FROM top),
                             '[]'::jsonb
                           )
  );
$$;

COMMENT ON FUNCTION public.donor_outbound_summary(uuid, int) IS
  'FIX-1228 — one donor''s outbound donations, exact: distinct_recipients, rows, '
  'total_cents, cycles, and the top p_top recipients by sum. ONE jsonb. Read by '
  '/donors/[id] as anon (3 s role bound; no proconfig timeout — FIX-1128).';

GRANT EXECUTE ON FUNCTION public.donor_outbound_summary(uuid, int) TO anon, authenticated, service_role;
