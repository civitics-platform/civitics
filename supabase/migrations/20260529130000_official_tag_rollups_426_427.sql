-- =============================================================================
-- FIX-427 + FIX-426 — Official rule-tagger rollup RPCs
--
-- The rule-based official tagger (packages/data/src/pipelines/tags/rules.ts,
-- tagOfficials()) derived donor- and voting-pattern tags from PostgREST selects
-- that silently truncated at the 1,000-row cap (supabase/config.toml max_rows):
--
--   • financial_relationships donations to officials: ~1.38M rows → only the
--     first 1,000 were read, so pac_heavy / grassroots / large_donor_funded
--     tags were computed from ~0.07% of donations (FIX-427, the headline
--     silent-zero). The follow-on `.in("id", donorIds)` lookup would also blow
--     the URL-length limit once the donation load was un-truncated (550k+
--     distinct donor ids).
--   • votes: the select projected a non-existent column `proposal_id` (the real
--     FK is `bill_proposal_id`). The 400 was swallowed (`const { data } = …`,
--     no error check) so the bipartisan/partisan analysis ran on ZERO vote rows
--     (FIX-426) — a full silent-zero, not merely a 1,000-row cap.
--
-- Fix: push both heavy joins into SQL. Two SECURITY DEFINER aggregation RPCs,
-- consumed by the rewritten tagOfficials(). The tag thresholds and taxonomy are
-- unchanged — only the underlying data is corrected.
--
-- Each RPC returns its whole result set as a SINGLE jsonb array (one row).
-- A RETURNS TABLE / SETOF shape would itself be capped at 1,000 rows by
-- PostgREST (donor rollup is ~1.1k officials), and paginating it with .range()
-- would re-execute the ~1.4M-row aggregation once per page. One jsonb row →
-- the aggregation runs exactly once and nothing is truncated. Both functions set a
-- per-function statement_timeout via ALTER FUNCTION because the donor rollup
-- (~1.4M donation rows joined to financial_entities, ~16s) exceeds the
-- service_role role's short default request budget on Pro.
-- =============================================================================

-- ── 1. Donor rollup — feeds pac_heavy / grassroots / large_donor_funded ──────
--   One element per official that received ≥1 donation. amount_cents summed
--   overall and split by donor entity_type. pac_cents mirrors the Node check
--   (entity_type IN ('pac','super_pac')); individual_cents preserves the
--   existing (currently unused) individualTotal reference. LEFT JOIN so a
--   donation whose donor entity row is missing still counts toward
--   total_cents / donor_count (matching the Node default of donor_type='other').
DROP FUNCTION IF EXISTS public.get_official_donor_rollup();
CREATE OR REPLACE FUNCTION public.get_official_donor_rollup()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  FROM (
    SELECT
      fr.to_id                                                                                AS official_id,
      SUM(COALESCE(fr.amount_cents, 0))::BIGINT                                                AS total_cents,
      (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::BIGINT AS pac_cents,
      (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type = 'individual'))::BIGINT AS individual_cents,
      COUNT(*)::BIGINT                                                                         AS donor_count
    FROM public.financial_relationships fr
    LEFT JOIN public.financial_entities fe ON fe.id = fr.from_id
    WHERE fr.to_type = 'official'
      AND fr.relationship_type = 'donation'
    GROUP BY fr.to_id
  ) t;
$$;

ALTER FUNCTION public.get_official_donor_rollup() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.get_official_donor_rollup() TO service_role;

-- ── 2. Bipartisan voting stats — feeds bipartisan / partisan ─────────────────
--   One element per official with ≥1 vote. total_votes counts every vote row;
--   yes_votes counts vote='yes'; bipartisan_yes counts this official's yes-votes
--   cast on a bill where ≥2 distinct (non-null) party affiliations voted yes —
--   i.e. an official of a DIFFERENT party also voted yes (the official's own
--   party is always present in that set, so a count ≥2 ⟺ a cross-party yes
--   exists). Reproduces the Node `yesVotesByProposal` cross-party check exactly,
--   but over ALL votes and using the real `bill_proposal_id` (FIX-426).
--   Null-party officials are excluded from the cross-party set (matching the
--   Node `p && p !== officialParty` guard); the caller still gates the final tag
--   on the official having a party.
DROP FUNCTION IF EXISTS public.get_official_bipartisan_stats();
CREATE OR REPLACE FUNCTION public.get_official_bipartisan_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH yes_party_votes AS (
    SELECT v.official_id, v.bill_proposal_id, o.party
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE v.vote = 'yes' AND o.party IS NOT NULL
  ),
  proposal_party_counts AS (
    SELECT bill_proposal_id, COUNT(DISTINCT party) AS distinct_parties
    FROM yes_party_votes
    GROUP BY bill_proposal_id
  ),
  bipartisan AS (
    SELECT ypv.official_id,
           COUNT(*) FILTER (WHERE ppc.distinct_parties >= 2) AS bipartisan_yes
    FROM yes_party_votes ypv
    JOIN proposal_party_counts ppc ON ppc.bill_proposal_id = ypv.bill_proposal_id
    GROUP BY ypv.official_id
  ),
  totals AS (
    SELECT v.official_id,
           COUNT(*)                               AS total_votes,
           COUNT(*) FILTER (WHERE v.vote = 'yes') AS yes_votes
    FROM public.votes v
    GROUP BY v.official_id
  )
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  FROM (
    SELECT
      to2.official_id,
      to2.total_votes::BIGINT                 AS total_votes,
      to2.yes_votes::BIGINT                   AS yes_votes,
      COALESCE(b.bipartisan_yes, 0)::BIGINT   AS bipartisan_yes
    FROM totals to2
    LEFT JOIN bipartisan b ON b.official_id = to2.official_id
  ) t;
$$;

ALTER FUNCTION public.get_official_bipartisan_stats() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.get_official_bipartisan_stats() TO service_role;
