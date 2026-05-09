-- FIX-217 — Strengthen link_officials_to_districts() district_name parsing.
--
-- The original (FIX-163) only stripped leading zeros:
--   ltrim(d.metadata->>'district_id', '0') = ltrim(o.district_name, '0')
-- That misses ~95% of state legislators because OpenStates returns
-- district names in many shapes per state:
--   "12"          (most numeric states — works)
--   "District 12" (some states — leading zeros wouldn't help)
--   "House District 12" / "Senate District 12" (long form)
--   "A" / "B"     (Alaska — works because no leading zeros to strip)
--   "1A"          (a few states for sub-districts)
-- TIGER's district_id is always the bare CD119FP / SLDUST / SLDLST code,
-- e.g. "012" or "A". Normalising both sides via regex_replace + ltrim
-- recovers the link.

CREATE OR REPLACE FUNCTION public.link_officials_to_districts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH matches AS (
    SELECT o.id AS official_id, d.id AS district_id
    FROM public.officials o
    JOIN public.jurisdictions d
      ON d.type = 'district'
     AND d.metadata->>'source' = 'tiger'
     AND d.metadata->>'state_abbr'  = o.metadata->>'state'
     AND d.metadata->>'chamber'     = o.metadata->>'org_classification'
     AND ltrim(d.metadata->>'district_id', '0') =
         ltrim(
           regexp_replace(
             o.district_name,
             '^(House|Senate|Assembly|Legislative)?\s*District\s+',
             '',
             'i'
           ),
           '0'
         )
    WHERE o.district_name IS NOT NULL
      AND o.metadata->>'state' IS NOT NULL
      AND o.metadata->>'org_classification' IN ('upper', 'lower')
      AND (
        o.metadata->>'district_jurisdiction_id' IS NULL
        OR o.metadata->>'district_jurisdiction_id' <> d.id::text
      )
  )
  UPDATE public.officials o
     SET metadata = COALESCE(o.metadata, '{}'::jsonb)
                  || jsonb_build_object('district_jurisdiction_id', m.district_id::text)
    FROM matches m
   WHERE o.id = m.official_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
