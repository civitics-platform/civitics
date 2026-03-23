-- =============================================================================
-- Migration 0014: Graph search RPC function + treemap data function
--
-- search_graph_entities(): fuzzy multi-entity search for the graph entity
--   selector. Queries officials (active only), agencies, proposals, and
--   financial_entities in one call. Uses pg_trgm similarity (already enabled
--   via migration 0008) for typo tolerance + ILIKE for substring matching.
--
-- treemap_officials_by_donations(): aggregates financial_relationships per
--   official for the treemap "Officials by PAC donations received" view.
--   Groups by party → state. Returns top N officials by total received.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- search_graph_entities
-- Returns up to `lim` results per entity type. Ordered by trigram similarity
-- desc within each type so best matches float to the top.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_graph_entities(q TEXT, lim INT DEFAULT 5)
RETURNS TABLE(
  id          UUID,
  label       TEXT,
  entity_type TEXT,
  subtitle    TEXT,
  party       TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  -- Officials: active only, fuzzy name match via trigram + ILIKE
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      o.id::UUID,
      o.full_name                                                    AS label,
      'official'::TEXT                                               AS entity_type,
      NULLIF(CONCAT_WS(' · ', o.metadata->>'state', o.role_title), '') AS subtitle,
      o.party::TEXT                                                  AS party,
      similarity(o.full_name, q)                                    AS sim
    FROM officials o
    WHERE o.is_active = true
      AND (
        o.full_name ILIKE '%' || q || '%'
        OR similarity(o.full_name, q) > 0.3
      )
    ORDER BY sim DESC, o.full_name
    LIMIT lim
  ) sub

  UNION ALL

  -- Agencies: name or acronym ILIKE
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      a.id::UUID,
      a.name                  AS label,
      'agency'::TEXT          AS entity_type,
      a.acronym               AS subtitle,
      NULL::TEXT              AS party,
      1.0::REAL               AS sim
    FROM agencies a
    WHERE a.name ILIKE '%' || q || '%'
       OR a.acronym ILIKE '%' || q || '%'
    ORDER BY a.name
    LIMIT lim
  ) sub

  UNION ALL

  -- Proposals: title ILIKE
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      p.id::UUID,
      p.title                AS label,
      'proposal'::TEXT       AS entity_type,
      p.status::TEXT         AS subtitle,
      NULL::TEXT             AS party,
      1.0::REAL              AS sim
    FROM proposals p
    WHERE p.title ILIKE '%' || q || '%'
    ORDER BY p.title
    LIMIT lim
  ) sub

  UNION ALL

  -- Financial entities (PACs, corporations, individuals): name fuzzy match
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      f.id::UUID,
      f.name                                                          AS label,
      'financial_entity'::TEXT                                        AS entity_type,
      NULLIF(CONCAT_WS(' · ', f.entity_type, f.industry), '')        AS subtitle,
      NULL::TEXT                                                      AS party,
      similarity(f.name, q)                                          AS sim
    FROM financial_entities f
    WHERE f.name ILIKE '%' || q || '%'
       OR similarity(f.name, q) > 0.3
    ORDER BY sim DESC, f.total_donated_cents DESC
    LIMIT lim
  ) sub
$$;

-- Grant anonymous access (RLS still applies to underlying tables via
-- SECURITY DEFINER — but the tables already have public SELECT policies)
GRANT EXECUTE ON FUNCTION search_graph_entities(TEXT, INT) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- treemap_officials_by_donations
-- Aggregates financial_relationships received per official.
-- Returns only officials who have received at least 1 donation (HAVING > 0).
-- Top `lim` officials by total received (default 200).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION treemap_officials_by_donations(lim INT DEFAULT 200)
RETURNS TABLE(
  official_id         UUID,
  official_name       TEXT,
  party               TEXT,
  state               TEXT,
  total_donated_cents BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    o.id::UUID                                              AS official_id,
    o.full_name                                             AS official_name,
    COALESCE(o.party, 'nonpartisan')                       AS party,
    COALESCE(o.metadata->>'state', 'Unknown')              AS state,
    COALESCE(SUM(fr.amount_cents), 0)::BIGINT              AS total_donated_cents
  FROM officials o
  LEFT JOIN financial_relationships fr ON fr.official_id = o.id
  WHERE o.is_active = true
  GROUP BY o.id, o.full_name, o.party, o.metadata->>'state'
  HAVING COALESCE(SUM(fr.amount_cents), 0) > 0
  ORDER BY total_donated_cents DESC
  LIMIT lim
$$;

GRANT EXECUTE ON FUNCTION treemap_officials_by_donations(INT) TO anon, authenticated;
