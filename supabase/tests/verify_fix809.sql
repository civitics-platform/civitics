-- FIX-809 verification — officials that have financial_entity donor rows in
-- financial_relationships but ZERO rows in official_donor_rollup_mv.
--
-- Expected 0 immediately after refresh_official_donor_rollup_incremental() runs.
-- A small non-zero residue is acceptable and self-heals on the next run: FEC can
-- write new donation rows for an official between the moment the refresh
-- snapshots its dirty set and the moment it finishes (those rows carry
-- updated_at > the just-advanced watermark, so the next run picks them up).
-- Environment-agnostic — no hard-coded uuids (prod uuids != local uuids).
WITH recips AS (
  SELECT DISTINCT to_id
  FROM public.financial_relationships
  WHERE relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND from_type = 'financial_entity'
)
SELECT COUNT(*) AS missing_officials
FROM recips r
JOIN public.officials o ON o.id = r.to_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.official_donor_rollup_mv m WHERE m.official_id = r.to_id
);
