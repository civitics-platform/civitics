-- FIX-217 — Federal House Representatives → congressional district link.
--
-- The existing link_officials_to_districts() (FIX-163) handles state
-- legislators by joining metadata.org_classification ('upper'/'lower') to
-- jurisdictions.metadata.chamber. House Reps don't carry org_classification —
-- they're loaded by the Congress.gov pipeline with role_title='Representative'
-- and district_name='District N' (or NULL for at-large states).
--
-- This RPC complements the existing one with a federal-specific path. It
-- writes to the same metadata.district_jurisdiction_id field so the
-- choropleth and any downstream consumer treat all linked officials
-- uniformly.

CREATE OR REPLACE FUNCTION public.link_federal_reps_to_districts()
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
    JOIN public.jurisdictions s
      ON s.id = o.jurisdiction_id  -- Reps' jurisdiction_id points at the state
     AND s.type = 'state'
    JOIN public.jurisdictions d
      ON d.type = 'district'
     AND d.metadata->>'source' = 'tiger'
     AND d.metadata->>'chamber' = 'congressional'
     AND d.metadata->>'state_abbr' = s.short_name
     AND (
       -- Non-at-large: match the digit(s) after "District " against
       -- TIGER's CD119FP, normalising leading zeros on both sides.
       (
         o.district_name IS NOT NULL
         AND ltrim(d.metadata->>'district_id', '0') =
             ltrim(regexp_replace(o.district_name, '^District\s+', '', 'i'), '0')
       )
       OR
       -- At-large: TIGER stores district_id='00'; the rep's district_name
       -- is NULL (Congress.gov pipeline writes NULL when member.district
       -- is null, which is the at-large convention).
       (
         o.district_name IS NULL
         AND d.metadata->>'district_id' = '00'
       )
     )
    WHERE o.role_title = 'Representative'
      AND o.is_active = true
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

REVOKE ALL ON FUNCTION public.link_federal_reps_to_districts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_federal_reps_to_districts() TO service_role;
