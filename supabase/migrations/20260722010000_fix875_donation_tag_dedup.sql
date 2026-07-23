-- =============================================================================
-- FIX-875 — Dedupe multi-industry-tag DONORS across the graph money surfaces.
--
-- Donation-side counterpart to FIX-873 (which fixed the contract-RECIPIENT side).
-- Five surfaces JOIN entity_tags(industry) on the DONOR (financial_entity) and
-- aggregate money WITHOUT a single-tag-per-entity pick, so a donor carrying >1
-- industry tag has its dollars counted under EVERY tag (per-sector aggregates)
-- or is emitted as N duplicate donor rows (per-donor lists). Measured at filing:
-- 1,058 local / 1,654 prod multi-tag financial_entities; 478 local are donation
-- donors. There are ZERO same-(entity_id,tag) metadata splits for
-- financial_entity/industry (checked local 2026-07-22), so the smallest-tag
-- DISTINCT-ON pick is already deterministic.
--
-- ── Fix (decision 1): one deterministic industry per donor ────────────────────
-- A `DISTINCT ON (et.entity_id) ... ORDER BY et.entity_id, et.tag` CTE — the
-- smallest-tag pick, byte-identical to the FIX-873 `recipient_industry` /
-- FIX-836 `ind` / FIX-777 `donor_tag` shape — applied at every site, carrying
-- the picked row's display_label + display_icon so the display columns come from
-- the SAME row as the chosen tag. Each donor now lands in exactly ONE sector;
-- each donor/PAC appears ONCE in the per-donor lists.
--
-- ── Base bodies = the LIVE definitions (decision 5) ───────────────────────────
-- All CREATE OR REPLACEs are the LIVE pg_get_functiondef bodies (captured local
-- 2026-07-22) — the fn bodies already include FIX-854's same-tag display
-- collapse; rebuilding from an older migration would silently revert it (the
-- stale-body-revert class). ONLY the entity_tags join is swapped for the
-- donor_industry pick; signatures, volatility, SECURITY DEFINER, row shapes and
-- grants are unchanged.
--
-- ── Display-semantics boundaries that DO NOT change (decision 3) ──────────────
--   * official_sector_dollars_mv keeps its INNER JOIN → untagged donors stay
--     excluded (a display choice; we dedup only, we do NOT add an Untagged
--     bucket here).
--   * chord_industry_flows_mv keeps its COALESCE('untagged') bucket (LEFT JOIN).
--   * chord_industry_flows_for_official / chord_top_pacs_for_official /
--     get_official_donors keep their untagged/'Other' handling (LEFT JOIN).
--
-- ── MV mechanics (decision 4) ─────────────────────────────────────────────────
-- MVs cannot be CREATE-OR-REPLACEd → DROP + CREATE ... WITH NO DATA (a WITH DATA
-- create can blow the pooler's 2-min apply window on prod), unique index
-- recreated (required for the nightly REFRESH ... CONCURRENTLY in
-- refresh_derived_mvs('weekly')). A supervised NON-CONCURRENT
-- `REFRESH MATERIALIZED VIEW` follows immediately per env (the first refresh
-- after WITH NO DATA must be non-concurrent). Neither MV has any dependent
-- object (checked local 2026-07-22) so the plain DROP is clean.
--
-- Conservation anchor (decision 6), sampled multi-tag-donor official Brian K.
-- Fitzpatrick (52c0344c-…): pre-fix per-official chord SUM across industries
-- (incl. untagged) = 1,417,310,500¢; official_donor_totals.total_cents =
-- 1,223,203,300¢; post-fix the chord SUM collapses to == total_cents (the
-- 194,107,200¢ delta IS the removed double-count).
--
-- Cross-ref FIX-873 FIX-506 FIX-854 FIX-207 FIX-836 FIX-777.
-- =============================================================================

-- ── SURFACE 1: official_sector_dollars_mv (FIX-506) ──────────────────────────
-- INNER JOIN the single-tag pick → a multi-tag donor's dollars land in ONE
-- sector; untagged donors stay excluded (INNER JOIN preserved).
DROP MATERIALIZED VIEW IF EXISTS public.official_sector_dollars_mv;
CREATE MATERIALIZED VIEW public.official_sector_dollars_mv AS
WITH donor_industry AS (
  SELECT DISTINCT ON (et.entity_id)
    et.entity_id, et.tag, et.display_label, et.display_icon
  FROM public.entity_tags et
  WHERE et.entity_type  = 'financial_entity'
    AND et.tag_category = 'industry'
  ORDER BY et.entity_id, et.tag
)
SELECT
  fr.to_id                                AS official_id,
  di.tag                                  AS sector_tag,
  MIN(COALESCE(di.display_label, di.tag)) AS sector_label,
  MIN(COALESCE(di.display_icon, ''))      AS display_icon,
  SUM(fr.amount_cents)::BIGINT            AS total_cents,
  COUNT(DISTINCT fe.id)::BIGINT           AS donor_count
FROM public.financial_relationships fr
JOIN public.financial_entities fe
  ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
JOIN donor_industry di
  ON di.entity_id = fe.id
WHERE fr.relationship_type = 'donation'
  AND fr.to_type           = 'official'
  AND fr.amount_cents > 0
GROUP BY fr.to_id, di.tag
WITH NO DATA;

CREATE UNIQUE INDEX official_sector_dollars_mv_pk
  ON public.official_sector_dollars_mv (official_id, sector_tag);
GRANT SELECT ON public.official_sector_dollars_mv TO anon, authenticated, service_role;
COMMENT ON MATERIALIZED VIEW public.official_sector_dollars_mv IS
  'FIX-506/FIX-875 — per-official × industry-sector donation-dollar rollup. One '
  'deterministic industry per donor (smallest-tag DISTINCT ON pick, FIX-875 — the '
  'pre-875 fan-out double-counted a multi-tag donor into every sector). Untagged '
  'donors excluded (INNER JOIN, unchanged display choice). Refreshed CONCURRENTLY '
  'by refresh_derived_mvs(weekly). Read by get_group_sector_totals / '
  'get_crossgroup_sector_totals / chord_sector_vote_for_officials.';

-- ── SURFACE 2: chord_industry_flows_mv (FIX-207/222) ─────────────────────────
-- LEFT JOIN the single-tag pick → multi-tag donors counted once; the
-- COALESCE('untagged') bucket is preserved (donors with no industry tag).
DROP MATERIALIZED VIEW IF EXISTS public.chord_industry_flows_mv;
CREATE MATERIALIZED VIEW public.chord_industry_flows_mv AS
WITH donor_industry AS (
  SELECT DISTINCT ON (et.entity_id)
    et.entity_id, et.tag, et.display_label, et.display_icon
  FROM public.entity_tags et
  WHERE et.entity_type  = 'financial_entity'
    AND et.tag_category = 'industry'
  ORDER BY et.entity_id, et.tag
)
SELECT
  COALESCE(di.tag, 'untagged')                AS industry,
  MIN(COALESCE(di.display_label, 'Untagged')) AS display_label,
  MIN(COALESCE(di.display_icon, ''))          AS display_icon,
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )                                           AS party_chamber,
  SUM(fr.amount_cents)::BIGINT                AS total_cents,
  COUNT(DISTINCT fr.to_id)::BIGINT            AS official_count,
  COUNT(DISTINCT fe.id)::BIGINT              AS donor_count
FROM public.financial_relationships fr
JOIN public.officials          o  ON o.id  = fr.to_id   AND fr.to_type   = 'official'
JOIN public.financial_entities fe ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
LEFT JOIN donor_industry di
  ON di.entity_id = fe.id
WHERE fr.relationship_type = 'donation'
  AND fr.amount_cents > 0
  AND o.source_ids->>'congress_gov' IS NOT NULL
GROUP BY
  COALESCE(di.tag, 'untagged'),
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )
WITH NO DATA;

CREATE UNIQUE INDEX chord_industry_flows_mv_pk
  ON public.chord_industry_flows_mv (industry, party_chamber);
GRANT SELECT ON public.chord_industry_flows_mv TO anon, authenticated, service_role;
COMMENT ON MATERIALIZED VIEW public.chord_industry_flows_mv IS
  'FIX-207/FIX-875 — platform-wide industry × party_chamber donation chord. One '
  'deterministic industry per donor (smallest-tag DISTINCT ON pick, FIX-875). '
  'Untagged bucket preserved (LEFT JOIN + COALESCE). Refreshed CONCURRENTLY by '
  'refresh_derived_mvs(weekly). Read by chord_industry_flows() (/api/graph/chord).';

-- ── SURFACE 3: chord_industry_flows_for_official(uuid) (FIX-854) ─────────────
-- LEFT JOIN the single-tag pick. FIX-854's MAX() display collapse is retained
-- (now trivially one row per donor per bucket); untagged bucket preserved.
CREATE OR REPLACE FUNCTION public.chord_industry_flows_for_official(p_official_id uuid)
 RETURNS TABLE(industry text, display_label text, display_icon text, total_cents bigint, donor_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH donor_industry AS (
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id, et.tag, et.display_label, et.display_icon
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  )
  SELECT
    COALESCE(di.tag, 'untagged')                    AS industry,
    -- FIX-854 display collapse retained; with one row per donor it is a no-op
    -- collapse but keeps the exact output shape.
    COALESCE(MAX(di.display_label), 'Untagged')     AS display_label,
    COALESCE(MAX(NULLIF(di.display_icon, '')), '')  AS display_icon,
    SUM(fr.amount_cents)::BIGINT                     AS total_cents,
    COUNT(DISTINCT fe.id)::BIGINT                    AS donor_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN donor_industry di
    ON di.entity_id = fe.id
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
    AND fr.amount_cents > 0
  GROUP BY COALESCE(di.tag, 'untagged')
  ORDER BY total_cents DESC;
$function$;

-- ── SURFACE 4: chord_top_pacs_for_official(uuid,integer) ─────────────────────
-- LEFT JOIN the single-tag pick → each PAC appears ONCE (one industry); the
-- LIMIT is no longer consumed by duplicate rows of the same PAC.
CREATE OR REPLACE FUNCTION public.chord_top_pacs_for_official(p_official_id uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(pac_id uuid, pac_name text, industry text, display_label text, display_icon text, total_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH donor_industry AS (
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id, et.tag, et.display_label, et.display_icon
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  )
  SELECT
    fe.id                                  AS pac_id,
    fe.display_name                        AS pac_name,
    COALESCE(di.tag,           'untagged') AS industry,
    COALESCE(di.display_label, 'Untagged') AS display_label,
    COALESCE(di.display_icon,  '')         AS display_icon,
    SUM(fr.amount_cents)::BIGINT           AS total_cents
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN donor_industry di
    ON di.entity_id = fe.id
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
    AND fr.amount_cents > 0
    AND fe.entity_type IN ('pac', 'super_pac', 'party_committee', 'union', 'corporation')
  GROUP BY fe.id, fe.display_name,
           COALESCE(di.tag,           'untagged'),
           COALESCE(di.display_label, 'Untagged'),
           COALESCE(di.display_icon,  '')
  ORDER BY total_cents DESC
  LIMIT p_limit;
$function$;

-- ── SURFACE 5: get_official_donors(uuid) ─────────────────────────────────────
-- LEFT JOIN the single-tag pick → each donor appears ONCE. NOTE: this fn has
-- ZERO app callers (FIX-835 audit; only database.ts types reference it). Fixed
-- for correctness anyway — a known-wrong fn invites misuse — and flagged as a
-- retirement candidate; NOT retired here (no-deletion/soak rules).
CREATE OR REPLACE FUNCTION public.get_official_donors(p_official_id uuid)
 RETURNS TABLE(financial_entity_id uuid, entity_name text, entity_type text, industry_category text, total_amount_usd numeric, transaction_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH donor_industry AS (
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id, et.tag, et.display_label, et.display_icon
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  )
  SELECT
    fe.id                                                  AS financial_entity_id,
    fe.display_name                                        AS entity_name,
    fe.entity_type                                         AS entity_type,
    COALESCE(di.display_label, di.tag, 'Other')            AS industry_category,
    SUM(fr.amount_cents) / 100.0                           AS total_amount_usd,
    COUNT(*)::BIGINT                                       AS transaction_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities      fe ON fe.id = fr.from_id
  LEFT JOIN donor_industry di
    ON di.entity_id = fe.id
  WHERE fr.relationship_type = 'donation'
    AND fr.from_type         = 'financial_entity'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
  GROUP BY fe.id, fe.display_name, fe.entity_type, di.display_label, di.tag
  ORDER BY total_amount_usd DESC
  LIMIT 100;
$function$;

-- ── Grants (FIX-834/835 route-gated posture, belt-and-braces) ────────────────
-- CREATE OR REPLACE preserves ACLs; re-assert the service_role-only posture. The
-- two MV-reading fns (get_group_sector_totals / chord_sector_vote_for_officials)
-- are UNCHANGED and keep their grants.
REVOKE ALL ON FUNCTION public.chord_industry_flows_for_official(uuid)          FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.chord_industry_flows_for_official(uuid)          TO service_role;
REVOKE ALL ON FUNCTION public.chord_top_pacs_for_official(uuid, integer)       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.chord_top_pacs_for_official(uuid, integer)       TO service_role;
REVOKE ALL ON FUNCTION public.get_official_donors(uuid)                        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_official_donors(uuid)                        TO service_role;

-- PostgREST: MVs recreated + function bodies changed → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
