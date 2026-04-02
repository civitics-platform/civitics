CREATE OR REPLACE FUNCTION get_officials_by_filter(
  p_chamber TEXT DEFAULT NULL,
  p_party   TEXT DEFAULT NULL,
  p_state   TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID)
AS $$
  SELECT o.id
  FROM officials o
  WHERE o.is_active = true
    AND (p_chamber IS NULL OR
      CASE p_chamber
        WHEN 'senate' THEN o.role_title = 'Senator'
        WHEN 'house'  THEN o.role_title = 'Representative'
        ELSE true
      END)
    AND (p_party IS NULL OR o.party::TEXT = p_party)
    AND (p_state IS NULL
         OR o.metadata->>'state'      = p_state
         OR o.metadata->>'state_abbr' = p_state)
  LIMIT 1000;
$$ LANGUAGE SQL STABLE;
