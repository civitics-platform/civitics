CREATE OR REPLACE FUNCTION get_officials_breakdown()
RETURNS TABLE(category TEXT, count BIGINT) AS $$
  SELECT
    CASE
      WHEN source_ids ? 'courtlistener_person_id' THEN 'judges'
      WHEN source_ids ? 'openstates_id' THEN 'state'
      ELSE 'federal'
    END AS category,
    COUNT(*) AS count
  FROM officials
  WHERE is_active = true
  GROUP BY category;
$$ LANGUAGE SQL STABLE;
