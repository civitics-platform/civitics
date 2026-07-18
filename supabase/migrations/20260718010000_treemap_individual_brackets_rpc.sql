-- treemap_individual_brackets_for_official(uuid) — per-tier INDIVIDUAL donation
-- totals to one official, for the treemap "Individual donors" bracket cells
-- (Graph Polish P5, FIX-848 + FIX-A). Replaces the single "Individual donors
-- (N)" tail cell with per-size-bracket cells.
--
-- Semantics:
--   * PER-DONOR-TOTAL — sum a donor's donations to the official, THEN bucket by
--     that per-donor total. Mirrors the /api/graph/individual-donors drill
--     (which matches one bracket per donor on the entity_connections per-donor
--     amount). NOT per-row: for the whale there are ~42k donation rows across
--     ~38k distinct individual donors (multiple cycles), so per-row would
--     double-bucket a donor.
--   * Bracket boundaries + the small=catch-all(<$500) convention MATCH the
--     sibling chord_donor_brackets_for_official RPC so the chord and treemap
--     donor-size views agree.
--   * entity_type='individual' only — PAC / corporation / union money renders
--     as its own named cells or industry groups upstream.
--
-- Single jsonb return (NOT SETOF — the 1000-row PostgREST max_rows cap rule).
--
-- Reads via the existing partial covering index
-- financial_relationships_donor_rollup_idx
--   (to_id, relationship_type, from_id) INCLUDE (amount_cents)
--   WHERE relationship_type IN (donation,ie_support,ie_oppose)
--         AND from_type='financial_entity'
-- so the FR scan is index-only for the recipient side; the financial_entities
-- join is a PK lookup per donor. No new index — the sibling chord bracket RPC
-- runs the same shape at ~2-3s cold on the whale / ms warm, and this route's
-- response is CDN-cached (s-maxage=86400).
--
-- Route-gated: createAdminClient() (service_role) is the only caller. Supabase
-- default-grants anon+authenticated EXECUTE on every new public function, so
-- revoke it (FIX-834/695 posture) — otherwise it is POST /rest/v1/rpc/-callable
-- with the publishable key, bypassing the treemap route's allow-list.
CREATE OR REPLACE FUNCTION public.treemap_individual_brackets_for_official(
  p_official uuid
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH per_donor AS (
    SELECT fe.id AS donor_id, SUM(fr.amount_cents) AS donor_cents
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe
      ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type           = 'official'
      AND fr.to_id             = p_official
      AND fr.amount_cents > 0
      AND fe.entity_type       = 'individual'
    GROUP BY fe.id
  ),
  bucketed AS (
    SELECT
      donor_cents,
      CASE
        WHEN donor_cents >= 1000000 THEN 'mega'   -- $10k+
        WHEN donor_cents >=  250000 THEN 'major'  -- $2.5k-$10k
        WHEN donor_cents >=   50000 THEN 'mid'    -- $500-$2.5k
        ELSE                             'small'  -- < $500 (catch-all)
      END AS bracket
    FROM per_donor
  ),
  per_tier AS (
    SELECT bracket,
           SUM(donor_cents)::bigint AS total_cents,
           COUNT(*)::bigint         AS donor_count
    FROM bucketed
    GROUP BY bracket
  )
  SELECT jsonb_build_object(
    'tiers', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
                'tier',        bracket,
                'total_cents', total_cents,
                'donor_count', donor_count))
       FROM per_tier),
      '[]'::jsonb),
    'total_cents', COALESCE((SELECT SUM(total_cents) FROM per_tier), 0)::bigint,
    'donor_count', COALESCE((SELECT SUM(donor_count) FROM per_tier), 0)::bigint
  );
$$;

REVOKE ALL ON FUNCTION public.treemap_individual_brackets_for_official(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.treemap_individual_brackets_for_official(uuid)
  TO service_role;
