-- =============================================================================
-- FIX-506 — per-official sector-dollar rollup MV (unblocks FIX-512 on prod)
--
-- FIX-512 rewrote get_group_sector_totals / get_crossgroup_sector_totals onto
-- entity_tags (migration 20260606000004). That fix is correct but on prod the
-- live aggregate over financial_relationships (2.2M rows) × financial_entities
-- × entity_tags for a chamber-sized cohort runs ~87s on the cache-starved Pro
-- Small instance (256MB shared_buffers, ~54% hit ratio). PostgREST kills it at
-- the 8s authenticator-role statement_timeout, so the chord group/cross-group
-- and sunburst donation_industries endpoints still returned []. (NOTE: a
-- function-level `ALTER FUNCTION ... SET statement_timeout` does NOT help here
-- — for a top-level LANGUAGE sql RPC the cancel-timer is armed from the
-- session/role value before the function body's SET takes effect; verified
-- empirically. The durable fix is materialization, not a per-function timeout.)
--
-- This is the FIX-506 per-entity MV (per packages/db/CLAUDE.md "Materialization
-- pattern", per-entity-MV shape): aggregate donation dollars per
-- (official, industry-sector) once, then serve the group/cross-group/sector-vote
-- RPCs as indexed point reads. Tiny output: ~13k rows over ~2k officials.
--
-- Conventions (match the existing chord views — consistency beats local
-- perfection):
--   * Sector = entity_tags(tag_category='industry') on the donor financial
--     entity, same source as chord_industry_flows_mv and
--     chord_sector_vote_for_officials.
--   * Multi-tag donors are NOT deduped — a 2-tag donor's dollars count under
--     each sector (matches chord_industry_flows_mv).
--   * Untagged donors excluded (INNER JOIN entity_tags).
--   * GROUP BY the tag slug; MIN(display_label/display_icon) collapses label
--     variants for one tag (same trick chord_industry_flows_mv uses).
--   * The old '%PAC/Committee%' junk-rollup display_name exclusion from the
--     pre-cutover RPCs is DROPPED — it matches 0 financial_entities rows on
--     prod and local (the pac-classify naming that produced it was removed in
--     FIX-111). Dropping it lets this one MV serve chord_sector_vote_for_officials
--     too, which never had that filter.
-- =============================================================================

-- ── per-official × sector rollup ─────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.official_sector_dollars_mv AS
SELECT
  fr.to_id                                AS official_id,
  et.tag                                  AS sector_tag,
  MIN(COALESCE(et.display_label, et.tag)) AS sector_label,
  MIN(COALESCE(et.display_icon, ''))      AS display_icon,
  SUM(fr.amount_cents)::BIGINT            AS total_cents,
  COUNT(DISTINCT fe.id)::BIGINT           AS donor_count
FROM public.financial_relationships fr
JOIN public.financial_entities fe
  ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
JOIN public.entity_tags et
  ON et.entity_id    = fe.id
 AND et.entity_type  = 'financial_entity'
 AND et.tag_category = 'industry'
WHERE fr.relationship_type = 'donation'
  AND fr.to_type           = 'official'
  AND fr.amount_cents > 0
GROUP BY fr.to_id, et.tag;

-- (official_id, sector_tag) is the natural PK and is required for
-- REFRESH MATERIALIZED VIEW CONCURRENTLY. The same index serves the
-- official_id-prefix point reads the RPCs below issue.
CREATE UNIQUE INDEX IF NOT EXISTS official_sector_dollars_mv_pk
  ON public.official_sector_dollars_mv (official_id, sector_tag);

GRANT SELECT ON public.official_sector_dollars_mv TO anon, authenticated, service_role;

-- Refresh helper, invoked from runNightlySync() after the tagging steps,
-- alongside refresh_chord_industry_flows_mv (same source data).
CREATE OR REPLACE FUNCTION public.refresh_official_sector_dollars_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_sector_dollars_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_official_sector_dollars_mv() TO authenticated, service_role;

-- ── get_group_sector_totals(uuid[], numeric) — now reads the MV ──────────────
-- Indexed point reads on official_sector_dollars_mv(official_id) instead of the
-- 87s live aggregate. Same return shape, same LIMIT/HAVING semantics as FIX-512.
CREATE OR REPLACE FUNCTION public.get_group_sector_totals(
  p_member_ids UUID[],
  p_min_usd    NUMERIC DEFAULT 0
)
RETURNS TABLE(sector TEXT, total_usd NUMERIC)
LANGUAGE sql STABLE
AS $$
  SELECT
    MIN(m.sector_label)         AS sector,
    SUM(m.total_cents) / 100.0  AS total_usd
  FROM public.official_sector_dollars_mv m
  WHERE m.official_id = ANY(p_member_ids)
  GROUP BY m.sector_tag
  HAVING SUM(m.total_cents) / 100.0 >= p_min_usd
  ORDER BY total_usd DESC
  LIMIT 12;
$$;

GRANT EXECUTE ON FUNCTION public.get_group_sector_totals(UUID[], NUMERIC) TO anon, authenticated, service_role;

-- ── get_crossgroup_sector_totals(uuid[], uuid[]) — now reads the MV ──────────
CREATE OR REPLACE FUNCTION public.get_crossgroup_sector_totals(
  p_group1_ids UUID[],
  p_group2_ids UUID[]
)
RETURNS TABLE(sector TEXT, group1_usd NUMERIC, group2_usd NUMERIC)
LANGUAGE sql STABLE
AS $$
  WITH agg AS (
    SELECT
      m.sector_tag,
      MIN(m.sector_label) AS sector_label,
      SUM(CASE WHEN m.official_id = ANY(p_group1_ids) THEN m.total_cents / 100.0 ELSE 0 END) AS group1_usd,
      SUM(CASE WHEN m.official_id = ANY(p_group2_ids) THEN m.total_cents / 100.0 ELSE 0 END) AS group2_usd
    FROM public.official_sector_dollars_mv m
    WHERE m.official_id = ANY(p_group1_ids) OR m.official_id = ANY(p_group2_ids)
    GROUP BY m.sector_tag
  )
  SELECT sector_label AS sector, group1_usd, group2_usd
  FROM agg
  ORDER BY (group1_usd + group2_usd) DESC
  LIMIT 12;
$$;

GRANT EXECUTE ON FUNCTION public.get_crossgroup_sector_totals(UUID[], UUID[]) TO anon, authenticated, service_role;

-- ── chord_sector_vote_for_officials(uuid[], numeric) — sector CTE reads MV ───
-- Was recomputing the same per-official × sector aggregate inline
-- (20260509000003). Now reads official_sector_dollars_mv; vote-outcome
-- weighting logic is unchanged. Untagged was already excluded
-- (`WHERE s.sector != 'untagged'`); the MV excludes untagged at source, so the
-- result is identical.
CREATE OR REPLACE FUNCTION public.chord_sector_vote_for_officials(
  p_official_ids UUID[],
  p_min_usd      NUMERIC DEFAULT 0
)
RETURNS TABLE(
  sector        TEXT,
  display_label TEXT,
  display_icon  TEXT,
  vote_outcome  TEXT,
  total_usd     NUMERIC,
  vote_count    BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH official_vote_breakdown AS (
    SELECT
      v.official_id,
      CASE
        WHEN v.vote IN ('yes', 'paired_yes') THEN 'yes'
        WHEN v.vote IN ('no',  'paired_no')  THEN 'no'
        ELSE 'other'
      END                                AS vote_outcome,
      COUNT(*)::NUMERIC                  AS outcome_count
    FROM public.votes v
    WHERE v.official_id = ANY(p_official_ids)
    GROUP BY v.official_id,
             CASE
               WHEN v.vote IN ('yes', 'paired_yes') THEN 'yes'
               WHEN v.vote IN ('no',  'paired_no')  THEN 'no'
               ELSE 'other'
             END
  ),
  official_total_votes AS (
    SELECT official_id, SUM(outcome_count) AS total_votes
    FROM official_vote_breakdown
    GROUP BY official_id
  ),
  official_sector_dollars AS (
    SELECT
      m.official_id,
      m.sector_tag      AS sector,
      m.sector_label    AS display_label,
      m.display_icon    AS display_icon,
      m.total_cents / 100.0 AS sector_usd
    FROM public.official_sector_dollars_mv m
    WHERE m.official_id = ANY(p_official_ids)
  )
  SELECT
    s.sector,
    MIN(s.display_label) AS display_label,
    MIN(s.display_icon)  AS display_icon,
    b.vote_outcome,
    SUM(s.sector_usd * b.outcome_count / NULLIF(t.total_votes, 0))::NUMERIC AS total_usd,
    SUM(b.outcome_count)::BIGINT AS vote_count
  FROM official_sector_dollars s
  JOIN official_vote_breakdown  b ON b.official_id = s.official_id
  JOIN official_total_votes     t ON t.official_id = s.official_id
  GROUP BY s.sector, b.vote_outcome
  HAVING SUM(s.sector_usd * b.outcome_count / NULLIF(t.total_votes, 0)) >= p_min_usd
  ORDER BY total_usd DESC NULLS LAST
  LIMIT 36;
$$;

GRANT EXECUTE ON FUNCTION public.chord_sector_vote_for_officials(UUID[], NUMERIC)
  TO anon, authenticated, service_role;
