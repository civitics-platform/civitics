-- FIX-854 (P3 wave 3) — chord_industry_flows_for_official duplicate-industry fix.
--
-- The per-official chord aggregate returned DUPLICATE rows for a single industry
-- (verified local: labor and lobby each split into two rows for the top-funded
-- official) because the GROUP BY keyed on the display metadata columns
-- (display_label, display_icon) alongside the industry tag. entity_tags rows for
-- the SAME tag can carry inconsistent display_icon across donors — some 'pharma'
-- tags have '💊', others have '' — so a single industry fractured into one row
-- per distinct (label, icon) pair, each with a partial total/donor_count.
--
-- Fix: GROUP BY the industry KEY only (COALESCE(et.tag,'untagged')), and pick the
-- display label/icon deterministically — MAX() over the group, with NULLIF on the
-- icon so a non-empty emoji wins over a blank. This collapses the split rows into
-- one row per industry with the correct SUM/COUNT.
--
-- Rebuilt from the CURRENT LIVE definition (pg_get_functiondef on local, confirmed
-- identical shape on prod), NOT an older migration file — only the GROUP BY and the
-- display-field selection change; the join/filter/return signature are unchanged
-- (avoids the FIX-610/625 stale-body-revert class).
--
-- Grants: the live function is EXECUTE-granted to service_role only (route uses
-- createAdminClient); CREATE OR REPLACE preserves the ACL, and the explicit
-- REVOKE/GRANT below re-asserts the route-gated posture belt-and-braces
-- (FIX-695/834/835 lineage). No anon/authenticated exposure.

CREATE OR REPLACE FUNCTION public.chord_industry_flows_for_official(p_official_id uuid)
  RETURNS TABLE(industry text, display_label text, display_icon text, total_cents bigint, donor_count bigint)
  LANGUAGE sql
  STABLE SECURITY DEFINER
AS $function$
  SELECT
    COALESCE(et.tag, 'untagged')                    AS industry,
    -- Deterministic display fields per industry key. MAX() collapses the
    -- inconsistent-metadata variants; NULLIF('') lets a real icon win over blank.
    COALESCE(MAX(et.display_label), 'Untagged')     AS display_label,
    COALESCE(MAX(NULLIF(et.display_icon, '')), '')  AS display_icon,
    SUM(fr.amount_cents)::BIGINT                     AS total_cents,
    COUNT(DISTINCT fe.id)::BIGINT                    AS donor_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
    AND fr.amount_cents > 0
  GROUP BY COALESCE(et.tag, 'untagged')
  ORDER BY total_cents DESC;
$function$;

REVOKE ALL ON FUNCTION public.chord_industry_flows_for_official(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chord_industry_flows_for_official(uuid) TO service_role;
