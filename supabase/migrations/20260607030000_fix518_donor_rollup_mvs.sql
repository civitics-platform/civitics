-- =============================================================================
-- FIX-518 — per-(official, donor) + per-(donor, party) rollup MVs
--
-- Re-files the lost donor half of FIX-506 (the sector half shipped as
-- official_sector_dollars_mv, 20260606000005). Four read paths aggregate
-- financial_relationships donor rows live per render and are slow/wrong/both:
--   * officials/[id]            — 50k-row fetchAllRows ceiling + JS aggregate
--                                 (whale official: 308,847 rows / $268M,
--                                 undercounted by the 50k ceiling today)
--   * treemap entity mode       — FIX-510 interim no-order .range() pagination
--                                 (~309 sequential pages for the whale)
--   * treemap-pac entityId mode — per-300-PAC batch scans
--   * treemap-pac global modes  — unpaged, silently capped per batch over 1.9M
--                                 donation rows → global totals wrong today
--
-- Two MVs (FIX-518 decision 1 — one can't serve both shapes):
--   #1 official_donor_rollup_mv  per (official, relationship_type) top-1000
--                                donors + one tail-bucket row → the three
--                                "one official" paths.
--   #2 donor_party_rollup_mv     per (donor, party) donation totals → the
--                                treemap-pac global sector/party modes.
--
-- Pattern mirrors 20260606000005_fix506_official_sector_dollars_mv.sql:
-- MV + unique index (for REFRESH CONCURRENTLY) + SECURITY DEFINER refresh fn
-- + grants. Refresh hooked nightly in runNightlySync() (packages/data).
-- =============================================================================

-- ── Rollup #1: per (official, relationship_type) top-1000 donors + tail ──────
-- Invariant: SUM(total_cents) over an official's rows (ranked rank 1..1000 +
-- the tail row at rank 1001) = the true total for that relationship_type. The
-- tail bucket is what preserves displayed treemap totals past the leaf cap.
--
-- relationship_type ∈ ('donation','ie_support','ie_oppose') — officials/[id]
-- renders the three as separate sections (FIX-270). Source filter mirrors the
-- page: to_type='official' AND from_type='financial_entity'.
--
-- donor_name / entity_type / industry_label are denormalized at refresh time
-- (industry from entity_tags, the canonical source — MIN(display_label) collapse
-- mirrors fetchIndustryTagsByEntityId / chord_industry_flows_mv). This deletes
-- the per-render donorInfo batching + industry fetch from the read paths.
-- Industry staleness couples to the nightly refresh — accepted (FIX-518 dec 5).
CREATE MATERIALIZED VIEW IF NOT EXISTS public.official_donor_rollup_mv AS
WITH per_donor AS (
  SELECT
    fr.to_id                       AS official_id,
    fr.relationship_type::text     AS relationship_type,
    fr.from_id                     AS donor_id,
    SUM(fr.amount_cents)::bigint   AS total_cents,
    COUNT(*)::bigint               AS tx_count
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND fr.to_type   = 'official'
    AND fr.from_type = 'financial_entity'
  GROUP BY fr.to_id, fr.relationship_type, fr.from_id
),
ranked AS (
  SELECT
    pd.*,
    ROW_NUMBER() OVER (
      PARTITION BY pd.official_id, pd.relationship_type
      ORDER BY pd.total_cents DESC, pd.donor_id
    ) AS rn
  FROM per_donor pd
),
ind AS (
  -- One representative (tag, label) pair per donor (a donor can carry multiple
  -- industry tags). DISTINCT ON picks the smallest tag deterministically and
  -- its matching label, so industry_tag and industry_label always come from the
  -- SAME row — readers filter on the tag (the canonical form the UI sends, e.g.
  -- 'finance') and display the label ('Finance'). Mirrors the single-tag pick
  -- fetchIndustryTagsByEntityId returns.
  SELECT DISTINCT ON (et.entity_id)
    et.entity_id,
    et.tag           AS industry_tag,
    et.display_label AS industry_label
  FROM public.entity_tags et
  WHERE et.entity_type  = 'financial_entity'
    AND et.tag_category = 'industry'
  ORDER BY et.entity_id, et.tag
),
top_rows AS (
  SELECT
    r.official_id,
    r.relationship_type,
    r.rn::int           AS rank,
    r.donor_id,
    fe.display_name     AS donor_name,
    fe.entity_type      AS entity_type,
    ind.industry_tag    AS industry_tag,
    ind.industry_label  AS industry_label,
    r.total_cents,
    r.tx_count,
    NULL::bigint        AS tail_donor_count
  FROM ranked r
  -- LEFT JOIN preserves the invariant even if a from_id somehow lacks an
  -- financial_entities row (should never happen for from_type='financial_entity',
  -- but a dropped row must not silently shrink the official's total).
  LEFT JOIN public.financial_entities fe ON fe.id = r.donor_id
  LEFT JOIN ind                          ON ind.entity_id = r.donor_id
  WHERE r.rn <= 1000
),
tail_rows AS (
  SELECT
    r.official_id,
    r.relationship_type,
    1001                 AS rank,          -- fixed rank for the unique index
    NULL::uuid           AS donor_id,      -- NULL donor_id ≡ tail bucket
    NULL::text           AS donor_name,
    NULL::text           AS entity_type,
    NULL::text           AS industry_tag,
    NULL::text           AS industry_label,
    SUM(r.total_cents)::bigint AS total_cents,
    SUM(r.tx_count)::bigint    AS tx_count,
    COUNT(*)::bigint           AS tail_donor_count
  FROM ranked r
  WHERE r.rn > 1000
  GROUP BY r.official_id, r.relationship_type
)
SELECT * FROM top_rows
UNION ALL
SELECT * FROM tail_rows;

-- (official_id, relationship_type, rank) is the natural PK; required for REFRESH
-- CONCURRENTLY and serves the read-path range scan (WHERE official_id=?
-- [AND relationship_type=?] ORDER BY rank — no request-time sort on big tables).
CREATE UNIQUE INDEX IF NOT EXISTS official_donor_rollup_mv_pk
  ON public.official_donor_rollup_mv (official_id, relationship_type, rank);

GRANT SELECT ON public.official_donor_rollup_mv TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_official_donor_rollup_mv()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_donor_rollup_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_official_donor_rollup_mv() TO authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.official_donor_rollup_mv IS
  'FIX-518 — per (official_id, relationship_type) top-1000 donors (rank 1..1000) '
  '+ one tail-bucket row (rank 1001, donor_id NULL, tail_donor_count set). '
  'SUM(total_cents) over an official''s rows = the true total. Serves '
  'officials/[id], treemap entity mode, treemap-pac entityId mode. Refreshed '
  'nightly by refresh_official_donor_rollup_mv().';

-- ── Rollup #2: per (donor, party) donation totals ────────────────────────────
-- Donations only; party from the recipient official (officials.party), so this
-- is to_type='official' by construction. party_key = officials.party::text,
-- normalized the same way group_donor_rollup's party_key is
-- (20260606000000_fix500_group_donor_rollup.sql); NULL party → 'unknown'.
-- ALL financial-entity donor types are included — readers filter
-- entity_type IN ('pac','party_committee') at read time so future surfaces can
-- reuse the MV (FIX-518 decision 6).
CREATE MATERIALIZED VIEW IF NOT EXISTS public.donor_party_rollup_mv AS
WITH agg AS MATERIALIZED (
  SELECT
    fr.from_id                          AS donor_id,
    COALESCE(o.party::text, 'unknown')  AS party_key,
    SUM(fr.amount_cents)::bigint        AS total_cents,
    COUNT(*)::bigint                    AS tx_count
  FROM public.financial_relationships fr
  JOIN public.officials o
    ON o.id = fr.to_id AND fr.to_type = 'official'
  WHERE fr.relationship_type = 'donation'
    AND fr.from_type = 'financial_entity'
  GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
),
ind AS (
  -- Same deterministic (tag, label) pick as rollup #1's ind CTE.
  SELECT DISTINCT ON (et.entity_id)
    et.entity_id,
    et.tag           AS industry_tag,
    et.display_label AS industry_label
  FROM public.entity_tags et
  WHERE et.entity_type  = 'financial_entity'
    AND et.tag_category = 'industry'
  ORDER BY et.entity_id, et.tag
)
SELECT
  a.donor_id,
  a.party_key,
  fe.display_name    AS donor_name,
  fe.entity_type     AS entity_type,
  ind.industry_tag   AS industry_tag,
  ind.industry_label AS industry_label,
  a.total_cents,
  a.tx_count
FROM agg a
LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id
LEFT JOIN ind                          ON ind.entity_id = a.donor_id;

-- (donor_id, party_key) is the natural PK; required for REFRESH CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS donor_party_rollup_mv_pk
  ON public.donor_party_rollup_mv (donor_id, party_key);

-- The global treemap-pac modes read only the pac/party_committee subset
-- (~7.4k donors) out of a multi-million-row MV (2.3M individual donors). A
-- partial index on that subset keeps the global RPCs off a full seq scan and
-- gives party mode an ordered scan (party_key, total_cents DESC).
CREATE INDEX IF NOT EXISTS donor_party_rollup_mv_pac_read_idx
  ON public.donor_party_rollup_mv (party_key, total_cents DESC)
  WHERE entity_type IN ('pac', 'party_committee');

GRANT SELECT ON public.donor_party_rollup_mv TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_donor_party_rollup_mv()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.donor_party_rollup_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_donor_party_rollup_mv() TO authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.donor_party_rollup_mv IS
  'FIX-518 — per (donor_id, party_key) donation totals (donations only, '
  'to_type=official). party_key = recipient officials.party::text (NULL→unknown). '
  'ALL FE donor types; readers filter entity_type IN (pac,party_committee). '
  'Serves treemap-pac global sector/party modes. Refreshed nightly.';

-- ── Global treemap-pac RPCs over rollup #2 ───────────────────────────────────
-- Set-returning reads of the ~7.4k-PAC subset would still trip the PostgREST
-- 1000-row cap (the bug we're closing), and the capped hierarchy (15 sectors ×
-- 100 PACs = 1500 leaves; 3 parties × 50 = 150) exceeds it too. Each RPC does
-- the GROUP BY + top-N cap in-DB and returns ONE jsonb value (the `children`
-- array the route wraps with a title) — cap-proof, one round-trip. The TS route
-- keeps owning only the title/meta. Caps mirror the prior in-route logic:
-- party = top 3 parties × top 50 donors; sector = top 15 sectors × top 100 PACs
-- (∞ for both when an industry filter is set). The PAC/COMMITTEE junk-name skip
-- mirrors the route's `donorUpper.includes(...)` filter.

CREATE OR REPLACE FUNCTION public.get_pac_treemap_by_party(
  p_min_cents bigint DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT party_key, donor_name, total_cents, tx_count
    FROM public.donor_party_rollup_mv
    WHERE entity_type IN ('pac', 'party_committee')
      AND total_cents >= p_min_cents
      AND donor_name IS NOT NULL
      AND upper(donor_name) NOT LIKE '%PAC/COMMITTEE%'
      AND upper(donor_name) NOT LIKE '%COMMITTEE CONTRIBUTIONS%'
  ),
  ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY party_key ORDER BY total_cents DESC, donor_name) AS rn
    FROM base
  ),
  party_tot AS (
    SELECT party_key, SUM(total_cents) FILTER (WHERE rn <= 50) AS shown_cents
    FROM ranked
    GROUP BY party_key
  ),
  top3 AS (
    SELECT party_key FROM party_tot ORDER BY shown_cents DESC NULLS LAST LIMIT 3
  ),
  groups AS (
    SELECT
      jsonb_build_object(
        'name',     CASE WHEN r.party_key = 'unknown' THEN 'Unknown' ELSE r.party_key END,
        'totalUsd', round(pt.shown_cents / 100.0, 2),
        'children', jsonb_agg(
          jsonb_build_object('name', r.donor_name, 'value', round(r.total_cents / 100.0, 2), 'count', r.tx_count)
          ORDER BY r.rn
        )
      ) AS grp,
      pt.shown_cents
    FROM ranked r
    JOIN top3      t  USING (party_key)
    JOIN party_tot pt USING (party_key)
    WHERE r.rn <= 50
    GROUP BY r.party_key, pt.shown_cents
  )
  SELECT jsonb_build_object(
    'children',
    COALESCE((SELECT jsonb_agg(grp ORDER BY shown_cents DESC) FROM groups), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_pac_treemap_by_party(bigint) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_pac_treemap_by_sector(
  p_industry text DEFAULT NULL,    -- industry canonical tag filter, e.g. 'finance' (NULL = all sectors)
  p_min_cents bigint DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH per_donor AS (
    -- One row per PAC: total donations across all parties + its industry/name.
    -- donor_name/industry_tag/industry_label are denormalized identically across
    -- a donor's party rows, so MIN() just picks the (single) value.
    SELECT
      donor_id,
      MIN(donor_name)     AS donor_name,
      MIN(industry_tag)   AS industry_tag,
      MIN(industry_label) AS industry_label,
      SUM(total_cents)    AS total_cents,
      SUM(tx_count)       AS tx_count
    FROM public.donor_party_rollup_mv
    WHERE entity_type IN ('pac', 'party_committee')
    GROUP BY donor_id
  ),
  filtered AS (
    SELECT *
    FROM per_donor
    WHERE industry_label IS NOT NULL                                   -- untagged PACs absent (FIX-179)
      AND total_cents >= p_min_cents
      AND donor_name IS NOT NULL
      AND upper(donor_name) NOT LIKE '%PAC/COMMITTEE%'
      AND upper(donor_name) NOT LIKE '%COMMITTEE CONTRIBUTIONS%'
      AND (p_industry IS NULL OR industry_tag = p_industry)           -- filter by canonical tag, display by label
  ),
  ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY industry_label ORDER BY total_cents DESC, donor_name) AS rn
    FROM filtered
  ),
  -- Per-sector cap: 100 PACs globally, unbounded when an industry filter is set.
  capped AS (
    SELECT * FROM ranked
    WHERE p_industry IS NOT NULL OR rn <= 100
  ),
  sector_tot AS (
    SELECT industry_label, SUM(total_cents) AS shown_cents
    FROM capped
    GROUP BY industry_label
  ),
  -- Sector cap: top 15 sectors globally, unbounded when an industry filter is set.
  top_sectors AS (
    SELECT industry_label
    FROM sector_tot
    ORDER BY shown_cents DESC
    LIMIT CASE WHEN p_industry IS NOT NULL THEN NULL ELSE 15 END
  ),
  groups AS (
    SELECT
      jsonb_build_object(
        'name',     c.industry_label,
        'totalUsd', round(st.shown_cents / 100.0, 2),
        'children', jsonb_agg(
          jsonb_build_object('name', c.donor_name, 'value', round(c.total_cents / 100.0, 2), 'count', c.tx_count)
          ORDER BY c.rn
        )
      ) AS grp,
      st.shown_cents
    FROM capped c
    JOIN top_sectors t  USING (industry_label)
    JOIN sector_tot  st USING (industry_label)
    GROUP BY c.industry_label, st.shown_cents
  )
  SELECT jsonb_build_object(
    'children',
    COALESCE((SELECT jsonb_agg(grp ORDER BY shown_cents DESC) FROM groups), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_pac_treemap_by_sector(text, bigint) TO anon, authenticated, service_role;
