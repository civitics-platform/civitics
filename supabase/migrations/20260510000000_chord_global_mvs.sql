-- =============================================================================
-- Materialize the three global-aggregate chord RPCs introduced in
-- 20260509000003. The base joins scan financial_relationships (~2.2M rows on
-- prod) ± entity_tags / financial_entities / officials and consistently
-- exceed the 5s withDbTimeout ceiling on Pro.
--
-- Same pattern as FIX-207 (chord_industry_flows_mv): pre-aggregate nightly,
-- replace the no-arg path of each function to read from the MV, keep the
-- cohort-scoped path running the live query (already fast — bounded by
-- to_id index when an officials cohort is supplied).
--
-- Three MVs:
--   chord_donor_type_party_flows_mv     donor entity_type × party_chamber
--   chord_donor_state_party_flows_mv    donor home state × party_chamber
--   chord_subject_party_flows_mv        bill topic × party_chamber by yes-vote
--
-- Output is small (≤ ~80 rows each), refreshes nightly inside
-- runNightlySync() after the existing chord MV refresh.
-- =============================================================================


-- ── 1. donor_type × party_chamber ────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.chord_donor_type_party_flows_mv AS
SELECT
  COALESCE(fe.entity_type, 'other')      AS donor_type,
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )                                      AS party_chamber,
  (SUM(fr.amount_cents) / 100.0)::NUMERIC AS total_usd
FROM public.financial_relationships fr
JOIN public.officials o
  ON o.id = fr.to_id
 AND fr.to_type = 'official'
LEFT JOIN public.financial_entities fe
  ON fe.id = fr.from_id
 AND fr.from_type = 'financial_entity'
WHERE fr.relationship_type = 'donation'
  AND fr.amount_cents > 0
  AND o.source_ids->>'congress_gov' IS NOT NULL
GROUP BY donor_type, party_chamber;

CREATE UNIQUE INDEX IF NOT EXISTS chord_donor_type_party_flows_mv_pk
  ON public.chord_donor_type_party_flows_mv (donor_type, party_chamber);

GRANT SELECT ON public.chord_donor_type_party_flows_mv
  TO anon, authenticated, service_role;


-- ── 2. donor_state × party_chamber ───────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.chord_donor_state_party_flows_mv AS
SELECT
  UPPER(fe.metadata->>'state')           AS donor_state,
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )                                      AS party_chamber,
  (SUM(fr.amount_cents) / 100.0)::NUMERIC AS total_usd
FROM public.financial_relationships fr
JOIN public.officials o
  ON o.id = fr.to_id
 AND fr.to_type = 'official'
JOIN public.financial_entities fe
  ON fe.id = fr.from_id
 AND fr.from_type = 'financial_entity'
WHERE fr.relationship_type = 'donation'
  AND fr.amount_cents > 0
  AND o.source_ids->>'congress_gov' IS NOT NULL
  AND fe.metadata->>'state' IS NOT NULL
  AND fe.metadata->>'state' != ''
  AND LENGTH(fe.metadata->>'state') = 2
GROUP BY UPPER(fe.metadata->>'state'), party_chamber;

CREATE UNIQUE INDEX IF NOT EXISTS chord_donor_state_party_flows_mv_pk
  ON public.chord_donor_state_party_flows_mv (donor_state, party_chamber);

GRANT SELECT ON public.chord_donor_state_party_flows_mv
  TO anon, authenticated, service_role;


-- ── 3. subject × party_chamber (yes-vote weighted) ───────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.chord_subject_party_flows_mv AS
SELECT
  COALESCE(et.tag,           'untagged') AS subject,
  COALESCE(et.display_label, 'Untagged') AS display_label,
  COALESCE(et.display_icon,  '')         AS display_icon,
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )                                      AS party_chamber,
  COUNT(*)::BIGINT                       AS vote_count
FROM public.votes v
JOIN public.officials o
  ON o.id = v.official_id
JOIN public.entity_tags et
  ON et.entity_id    = v.bill_proposal_id
 AND et.entity_type  = 'proposal'
 AND et.tag_category = 'topic'
WHERE v.vote IN ('yes', 'paired_yes')
  AND o.source_ids->>'congress_gov' IS NOT NULL
GROUP BY et.tag, et.display_label, et.display_icon, party_chamber;

CREATE UNIQUE INDEX IF NOT EXISTS chord_subject_party_flows_mv_pk
  ON public.chord_subject_party_flows_mv (subject, party_chamber);

GRANT SELECT ON public.chord_subject_party_flows_mv
  TO anon, authenticated, service_role;


-- ── Function rewrites: serve from MV when no cohort is provided ───────────────
-- Keeps the same signatures so existing callers (route handler, tests) need
-- no changes. The cohort path runs the live aggregation; passing NULL hits
-- the MV directly.

CREATE OR REPLACE FUNCTION public.chord_donor_type_party_flows(
  p_official_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(
  donor_type    TEXT,
  party_chamber TEXT,
  total_usd     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT donor_type, party_chamber, total_usd
  FROM public.chord_donor_type_party_flows_mv
  WHERE p_official_ids IS NULL
  UNION ALL
  SELECT
    COALESCE(fe.entity_type, 'other')      AS donor_type,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )                                      AS party_chamber,
    (SUM(fr.amount_cents) / 100.0)::NUMERIC AS total_usd
  FROM public.financial_relationships fr
  JOIN public.officials o
    ON o.id = fr.to_id
   AND fr.to_type = 'official'
  LEFT JOIN public.financial_entities fe
    ON fe.id = fr.from_id
   AND fr.from_type = 'financial_entity'
  WHERE p_official_ids IS NOT NULL
    AND fr.relationship_type = 'donation'
    AND fr.amount_cents > 0
    AND o.source_ids->>'congress_gov' IS NOT NULL
    AND fr.to_id = ANY(p_official_ids)
  GROUP BY donor_type, party_chamber
  ORDER BY total_usd DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.chord_donor_type_party_flows(UUID[])
  TO anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.chord_donor_state_party_flows(
  p_official_id UUID DEFAULT NULL
)
RETURNS TABLE(
  donor_state   TEXT,
  party_chamber TEXT,
  total_usd     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT donor_state, party_chamber, total_usd
  FROM public.chord_donor_state_party_flows_mv
  WHERE p_official_id IS NULL
  UNION ALL
  SELECT
    UPPER(fe.metadata->>'state')           AS donor_state,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )                                      AS party_chamber,
    (SUM(fr.amount_cents) / 100.0)::NUMERIC AS total_usd
  FROM public.financial_relationships fr
  JOIN public.officials o
    ON o.id = fr.to_id
   AND fr.to_type = 'official'
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id
   AND fr.from_type = 'financial_entity'
  WHERE p_official_id IS NOT NULL
    AND fr.relationship_type = 'donation'
    AND fr.amount_cents > 0
    AND o.source_ids->>'congress_gov' IS NOT NULL
    AND fe.metadata->>'state' IS NOT NULL
    AND fe.metadata->>'state' != ''
    AND LENGTH(fe.metadata->>'state') = 2
    AND fr.to_id = p_official_id
  GROUP BY UPPER(fe.metadata->>'state'), party_chamber
  ORDER BY total_usd DESC
  LIMIT 60;
$$;

GRANT EXECUTE ON FUNCTION public.chord_donor_state_party_flows(UUID)
  TO anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.chord_subject_party_flows(
  p_official_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(
  subject       TEXT,
  display_label TEXT,
  display_icon  TEXT,
  party_chamber TEXT,
  vote_count    BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT subject, display_label, display_icon, party_chamber, vote_count
  FROM public.chord_subject_party_flows_mv
  WHERE p_official_ids IS NULL
  UNION ALL
  SELECT
    COALESCE(et.tag,           'untagged') AS subject,
    COALESCE(et.display_label, 'Untagged') AS display_label,
    COALESCE(et.display_icon,  '')         AS display_icon,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )                                      AS party_chamber,
    COUNT(*)::BIGINT                       AS vote_count
  FROM public.votes v
  JOIN public.officials o
    ON o.id = v.official_id
  JOIN public.entity_tags et
    ON et.entity_id    = v.bill_proposal_id
   AND et.entity_type  = 'proposal'
   AND et.tag_category = 'topic'
  WHERE p_official_ids IS NOT NULL
    AND v.vote IN ('yes', 'paired_yes')
    AND o.source_ids->>'congress_gov' IS NOT NULL
    AND v.official_id = ANY(p_official_ids)
  GROUP BY et.tag, et.display_label, et.display_icon, party_chamber
  ORDER BY vote_count DESC
  LIMIT 60;
$$;

GRANT EXECUTE ON FUNCTION public.chord_subject_party_flows(UUID[])
  TO anon, authenticated, service_role;


-- ── Refresh helpers ──────────────────────────────────────────────────────────
-- Each REFRESH MATERIALIZED VIEW CONCURRENTLY needs a unique index (declared
-- above) and an already-populated MV. The CREATE MATERIALIZED VIEW above
-- populates on creation, so subsequent refreshes are CONCURRENTLY-safe.

CREATE OR REPLACE FUNCTION public.refresh_chord_donor_type_party_flows_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_type_party_flows_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_chord_donor_type_party_flows_mv()
  TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.refresh_chord_donor_state_party_flows_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_state_party_flows_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_chord_donor_state_party_flows_mv()
  TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.refresh_chord_subject_party_flows_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_subject_party_flows_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_chord_subject_party_flows_mv()
  TO authenticated, service_role;
