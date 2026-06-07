-- Reconcile drift between local and prod schemas.
-- Prod baseline was established via direct SQL (the 18 March timestamped migrations
-- previously in prod's schema_migrations history, now marked reverted). That
-- baseline matches local 0001-0023 for the most part but skipped: the platform
-- usage/limits tables (0024), search financial indexes (0030), graph_snapshots and
-- data_sync_log indexes (0022 created tables but prod squash lost indexes), search
-- indexes (0008), and 10 function bodies across 0021-0032. This migration recreates
-- those missing objects idempotently.
--
-- Two variants of treemap_officials_by_donations need DROP first because the old
-- prod signature returns 5 columns and the new one returns 6. CREATE OR REPLACE
-- cannot change return type.

-- Extension: pg_trgm (required for the trigram GIN indexes below; prod missing it).
-- FIX-515: the trigram index DDL below references "extensions"."gin_trgm_ops", so the
-- extension must live in the "extensions" schema. The original "public" declaration
-- made fresh replays fail ("operator class extensions.gin_trgm_ops does not exist")
-- because 0001 lands pg_trgm in public. Prod already has this migration recorded as
-- applied and never re-runs it, so this is replay-only in effect.
CREATE EXTENSION IF NOT EXISTS "pg_trgm" SCHEMA "extensions";

DROP FUNCTION IF EXISTS "public"."treemap_officials_by_donations"(integer) CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Tables: platform_limits + platform_usage (originally from 0024)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS platform_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  metric TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  included_limit NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  overage_unit_cost NUMERIC DEFAULT NULL,
  overage_unit TEXT DEFAULT NULL,
  overage_cap NUMERIC DEFAULT NULL,
  display_label TEXT,
  display_group TEXT,
  warning_pct INTEGER DEFAULT 80,
  critical_pct INTEGER DEFAULT 95,
  billing_cycle TEXT DEFAULT 'monthly_reset',
  sort_order INTEGER DEFAULT 0,
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(service, metric, plan)
);

CREATE TABLE IF NOT EXISTS platform_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  metric TEXT NOT NULL,
  value NUMERIC NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'manual',
  verified_at TIMESTAMPTZ DEFAULT NULL,
  verified_by TEXT DEFAULT NULL,
  stale_after_days INTEGER DEFAULT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(service, metric, period_start)
);

ALTER TABLE platform_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read limits" ON platform_limits;
CREATE POLICY "public read limits" ON platform_limits FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read usage" ON platform_usage;
CREATE POLICY "public read usage" ON platform_usage FOR SELECT USING (true);

GRANT ALL ON TABLE platform_limits TO anon, authenticated, service_role;
GRANT ALL ON TABLE platform_usage TO anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Indexes: search trigram + data_sync_log + graph_snapshots (from 0008/0022/0030)
-- ═══════════════════════════════════════════════════════════════════════════════

-- FIX-515: belt-and-braces — if a prior migration (0001) put pg_trgm in a schema
-- other than "extensions", relocate it so the "extensions"."gin_trgm_ops" operator
-- class below resolves regardless of where the extension originally landed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_trgm' AND n.nspname <> 'extensions') THEN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "agencies_name_trgm" ON "public"."agencies" USING "gin" ("name" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "financial_relationships_donor_name_trgm" ON "public"."financial_relationships" USING "gin" ("donor_name" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "idx_agencies_acronym_trgm" ON "public"."agencies" USING "gin" ("acronym" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "idx_agencies_name_trgm" ON "public"."agencies" USING "gin" ("name" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "idx_data_sync_log_pipeline" ON "public"."data_sync_log" USING "btree" ("pipeline", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_data_sync_log_started_at" ON "public"."data_sync_log" USING "btree" ("started_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_data_sync_log_status" ON "public"."data_sync_log" USING "btree" ("status", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_financial_entities_name_trgm" ON "public"."financial_entities" USING "gin" ("name" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "idx_graph_snapshots_code" ON "public"."graph_snapshots" USING "btree" ("code");
CREATE INDEX IF NOT EXISTS "idx_graph_snapshots_created_at" ON "public"."graph_snapshots" USING "btree" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_officials_name_trgm" ON "public"."officials" USING "gin" ("full_name" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "idx_proposals_title_trgm" ON "public"."proposals" USING "gin" ("title" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "officials_full_name_trgm" ON "public"."officials" USING "gin" ("full_name" "extensions"."gin_trgm_ops");
CREATE INDEX IF NOT EXISTS "proposals_title_trgm" ON "public"."proposals" USING "gin" ("title" "extensions"."gin_trgm_ops");

-- ═══════════════════════════════════════════════════════════════════════════════
-- Functions (from 0021, 0023, 0024, 0025, 0026, 0027, 0028, 0029, 0031, 0032)
-- ═══════════════════════════════════════════════════════════════════════════════


CREATE OR REPLACE FUNCTION "public"."get_connection_counts"("entity_ids" "uuid"[]) RETURNS TABLE("entity_id" "uuid", "connection_count" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT id AS entity_id, COUNT(*) AS connection_count
  FROM (
    SELECT from_id AS id FROM entity_connections WHERE from_id = ANY(entity_ids)
    UNION ALL
    SELECT to_id   AS id FROM entity_connections WHERE to_id   = ANY(entity_ids)
  ) sub
  GROUP BY id;
$$;

ALTER FUNCTION "public"."get_connection_counts"("entity_ids" "uuid"[]) OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_connection_counts"("entity_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_connection_counts"("entity_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_connection_counts"("entity_ids" "uuid"[]) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_crossgroup_sector_totals"("p_group1_ids" "uuid"[], "p_group2_ids" "uuid"[]) RETURNS TABLE("sector" "text", "group1_usd" numeric, "group2_usd" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  WITH agg AS (
    SELECT
      fr.metadata->>'sector' AS sector,
      SUM(CASE WHEN fr.official_id = ANY(p_group1_ids) THEN fr.amount_cents / 100.0 ELSE 0 END) AS group1_usd,
      SUM(CASE WHEN fr.official_id = ANY(p_group2_ids) THEN fr.amount_cents / 100.0 ELSE 0 END) AS group2_usd
    FROM financial_relationships fr
    WHERE (
      fr.official_id = ANY(p_group1_ids)
      OR fr.official_id = ANY(p_group2_ids)
    )
      AND fr.metadata->>'sector' IS NOT NULL
      AND fr.metadata->>'sector' != 'Other'
      AND fr.donor_name NOT ILIKE '%PAC/Committee%'
    GROUP BY fr.metadata->>'sector'
  )
  SELECT sector, group1_usd, group2_usd
  FROM agg
  ORDER BY (group1_usd + group2_usd) DESC
  LIMIT 12
$$;

ALTER FUNCTION "public"."get_crossgroup_sector_totals"("p_group1_ids" "uuid"[], "p_group2_ids" "uuid"[]) OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_crossgroup_sector_totals"("p_group1_ids" "uuid"[], "p_group2_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_crossgroup_sector_totals"("p_group1_ids" "uuid"[], "p_group2_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_crossgroup_sector_totals"("p_group1_ids" "uuid"[], "p_group2_ids" "uuid"[]) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_current_usage"("p_service" "text", "p_metric" "text") RETURNS TABLE("value" numeric, "source" "text", "verified_at" timestamp with time zone, "recorded_at" timestamp with time zone, "stale_after_days" integer)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    value, source, verified_at, recorded_at, stale_after_days
  FROM platform_usage
  WHERE service = p_service
    AND metric = p_metric
    AND period_start = date_trunc('month', NOW())
  ORDER BY recorded_at DESC
  LIMIT 1;
$$;

ALTER FUNCTION "public"."get_current_usage"("p_service" "text", "p_metric" "text") OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_current_usage"("p_service" "text", "p_metric" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_usage"("p_service" "text", "p_metric" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_usage"("p_service" "text", "p_metric" "text") TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_group_connections"("p_member_ids" "uuid"[], "p_limit" integer DEFAULT 500) RETURNS TABLE("connection_type" "text", "to_id" "uuid", "strength" numeric, "amount_cents" bigint, "from_id" "uuid")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    ec.connection_type,
    ec.to_id,
    ec.strength,
    ec.amount_cents,
    ec.from_id
  FROM entity_connections ec
  WHERE ec.from_id = ANY(p_member_ids)
  ORDER BY
    ec.amount_cents DESC NULLS LAST,
    ec.strength DESC
  LIMIT p_limit
$$;

ALTER FUNCTION "public"."get_group_connections"("p_member_ids" "uuid"[], "p_limit" integer) OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_group_connections"("p_member_ids" "uuid"[], "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_group_connections"("p_member_ids" "uuid"[], "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_group_connections"("p_member_ids" "uuid"[], "p_limit" integer) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_group_sector_totals"("p_member_ids" "uuid"[], "p_min_usd" numeric DEFAULT 0) RETURNS TABLE("sector" "text", "total_usd" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    fr.metadata->>'sector'          AS sector,
    SUM(fr.amount_cents) / 100.0    AS total_usd
  FROM financial_relationships fr
  WHERE fr.official_id = ANY(p_member_ids)
    AND fr.metadata->>'sector' IS NOT NULL
    AND fr.metadata->>'sector' != 'Other'
    AND fr.donor_name NOT ILIKE '%PAC/Committee%'
  GROUP BY fr.metadata->>'sector'
  HAVING SUM(fr.amount_cents) / 100.0 >= p_min_usd
  ORDER BY total_usd DESC
  LIMIT 12
$$;

ALTER FUNCTION "public"."get_group_sector_totals"("p_member_ids" "uuid"[], "p_min_usd" numeric) OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_group_sector_totals"("p_member_ids" "uuid"[], "p_min_usd" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."get_group_sector_totals"("p_member_ids" "uuid"[], "p_min_usd" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_group_sector_totals"("p_member_ids" "uuid"[], "p_min_usd" numeric) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_official_donors"("p_official_id" "uuid") RETURNS TABLE("financial_entity_id" "uuid", "entity_name" "text", "entity_type" "text", "industry_category" "text", "total_amount_usd" numeric, "transaction_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT
    (array_agg(fe.id) FILTER (WHERE fe.id IS NOT NULL))[1]        AS financial_entity_id,
    fr.donor_name                                                  AS entity_name,
    fr.donor_type::TEXT                                            AS entity_type,
    COALESCE(fr.industry, (array_agg(fe.industry) FILTER (WHERE fe.industry IS NOT NULL))[1], 'Other') AS industry_category,
    SUM(fr.amount_cents) / 100.0                                   AS total_amount_usd,
    COUNT(*)::BIGINT                                               AS transaction_count
  FROM financial_relationships fr
  LEFT JOIN financial_entities fe ON fe.name = fr.donor_name
  WHERE fr.official_id = p_official_id
  GROUP BY
    fr.donor_name,
    fr.donor_type,
    fr.industry
  ORDER BY total_amount_usd DESC
  LIMIT 100
$$;

ALTER FUNCTION "public"."get_official_donors"("p_official_id" "uuid") OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_official_donors"("p_official_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_official_donors"("p_official_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_official_donors"("p_official_id" "uuid") TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_officials_by_filter"("p_chamber" "text" DEFAULT NULL::"text", "p_party" "text" DEFAULT NULL::"text", "p_state" "text" DEFAULT NULL::"text") RETURNS TABLE("id" "uuid")
    LANGUAGE "sql" STABLE
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
$$;

ALTER FUNCTION "public"."get_officials_by_filter"("p_chamber" "text", "p_party" "text", "p_state" "text") OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_officials_by_filter"("p_chamber" "text", "p_party" "text", "p_state" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_officials_by_filter"("p_chamber" "text", "p_party" "text", "p_state" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_officials_by_filter"("p_chamber" "text", "p_party" "text", "p_state" "text") TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_pac_donations_by_party"() RETURNS TABLE("party" "text", "donor_name" "text", "total_usd" numeric, "donation_count" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    COALESCE(o.party::TEXT, 'other') AS party,
    fr.donor_name,
    SUM(fr.amount_cents) / 100.0 AS total_usd,
    COUNT(*) AS donation_count
  FROM financial_relationships fr
  JOIN officials o ON fr.official_id = o.id
  WHERE fr.donor_type IN ('pac', 'party_committee')
  GROUP BY o.party, fr.donor_name
  ORDER BY total_usd DESC
$$;

ALTER FUNCTION "public"."get_pac_donations_by_party"() OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."get_pac_donations_by_party"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_pac_donations_by_party"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pac_donations_by_party"() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."treemap_officials_by_donations"("lim" integer DEFAULT 200) RETURNS TABLE("official_id" "uuid", "official_name" "text", "party" "text", "state" "text", "chamber" "text", "total_donated_cents" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT
    sub.official_id,
    sub.official_name,
    sub.party,
    sub.state,
    sub.chamber,
    COALESCE(SUM(fr.amount_cents), 0)::BIGINT AS total_donated_cents
  FROM (
    SELECT
      o.id::UUID                                AS official_id,
      o.full_name                               AS official_name,
      COALESCE(o.party::TEXT, 'nonpartisan')    AS party,
      COALESCE(
        NULLIF(o.metadata->>'state', ''),
        NULLIF(o.metadata->>'state_abbr', ''),
        CASE
          WHEN (o.source_ids->>'fec_candidate_id') ~ '^[SH][0-9][A-Z]{2}'
            AND SUBSTRING(o.source_ids->>'fec_candidate_id' FROM 3 FOR 2)
                  = ANY(ARRAY[
                      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                      'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                      'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                      'WI','WY'
                    ])
            THEN SUBSTRING(o.source_ids->>'fec_candidate_id' FROM 3 FOR 2)
          ELSE NULL
        END,
        CASE
          WHEN (o.source_ids->>'fec_id') ~ '^[SH][0-9][A-Z]{2}'
            AND SUBSTRING(o.source_ids->>'fec_id' FROM 3 FOR 2)
                  = ANY(ARRAY[
                      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                      'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                      'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                      'WI','WY'
                    ])
            THEN SUBSTRING(o.source_ids->>'fec_id' FROM 3 FOR 2)
          ELSE NULL
        END,
        'Unknown'
      )                                         AS state,
      -- chamber: derived from fec_candidate_id first char, then fec_id, then role_title
      CASE
        WHEN LEFT(o.source_ids->>'fec_candidate_id', 1) = 'S' THEN 'senate'
        WHEN LEFT(o.source_ids->>'fec_candidate_id', 1) = 'H' THEN 'house'
        WHEN LEFT(o.source_ids->>'fec_id', 1) = 'S'           THEN 'senate'
        WHEN LEFT(o.source_ids->>'fec_id', 1) = 'H'           THEN 'house'
        WHEN o.role_title ILIKE '%senator%'                    THEN 'senate'
        WHEN o.role_title ILIKE '%representative%'             THEN 'house'
        ELSE 'unknown'
      END                                       AS chamber
    FROM officials o
    WHERE o.is_active = true
  ) sub
  LEFT JOIN financial_relationships fr ON fr.official_id = sub.official_id
  GROUP BY sub.official_id, sub.official_name, sub.party, sub.state, sub.chamber
  HAVING COALESCE(SUM(fr.amount_cents), 0) > 0
  ORDER BY total_donated_cents DESC
  LIMIT lim
$$;

CREATE OR REPLACE FUNCTION "public"."treemap_officials_by_donations"("lim" integer DEFAULT 200, "p_chamber" "text" DEFAULT NULL::"text", "p_party" "text" DEFAULT NULL::"text", "p_state" "text" DEFAULT NULL::"text") RETURNS TABLE("official_id" "uuid", "official_name" "text", "party" "text", "state" "text", "chamber" "text", "total_donated_cents" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT
    sub.official_id,
    sub.official_name,
    sub.party,
    sub.state,
    sub.chamber,
    COALESCE(SUM(fr.amount_cents), 0)::BIGINT AS total_donated_cents
  FROM (
    SELECT
      o.id::UUID                                AS official_id,
      o.full_name                               AS official_name,
      COALESCE(o.party::TEXT, 'nonpartisan')    AS party,
      COALESCE(
        NULLIF(o.metadata->>'state', ''),
        NULLIF(o.metadata->>'state_abbr', ''),
        CASE
          WHEN (o.source_ids->>'fec_candidate_id') ~ '^[SH][0-9][A-Z]{2}'
            AND SUBSTRING(o.source_ids->>'fec_candidate_id' FROM 3 FOR 2)
                  = ANY(ARRAY[
                      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                      'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                      'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                      'WI','WY'
                    ])
            THEN SUBSTRING(o.source_ids->>'fec_candidate_id' FROM 3 FOR 2)
          ELSE NULL
        END,
        CASE
          WHEN (o.source_ids->>'fec_id') ~ '^[SH][0-9][A-Z]{2}'
            AND SUBSTRING(o.source_ids->>'fec_id' FROM 3 FOR 2)
                  = ANY(ARRAY[
                      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                      'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                      'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                      'WI','WY'
                    ])
            THEN SUBSTRING(o.source_ids->>'fec_id' FROM 3 FOR 2)
          ELSE NULL
        END,
        'Unknown'
      )                                         AS state,
      CASE
        WHEN LEFT(o.source_ids->>'fec_candidate_id', 1) = 'S' THEN 'senate'
        WHEN LEFT(o.source_ids->>'fec_candidate_id', 1) = 'H' THEN 'house'
        WHEN LEFT(o.source_ids->>'fec_id', 1) = 'S'           THEN 'senate'
        WHEN LEFT(o.source_ids->>'fec_id', 1) = 'H'           THEN 'house'
        WHEN o.role_title ILIKE '%senator%'                    THEN 'senate'
        WHEN o.role_title ILIKE '%representative%'             THEN 'house'
        ELSE 'unknown'
      END                                       AS chamber
    FROM officials o
    WHERE o.is_active = true
      -- Early filter on role_title / party — much cheaper than filtering after the JOIN
      AND (
        p_chamber IS NULL
        OR (p_chamber = 'senate'  AND (
              LEFT(o.source_ids->>'fec_candidate_id', 1) = 'S'
              OR LEFT(o.source_ids->>'fec_id', 1) = 'S'
              OR o.role_title ILIKE '%senator%'
           ))
        OR (p_chamber = 'house'   AND (
              LEFT(o.source_ids->>'fec_candidate_id', 1) = 'H'
              OR LEFT(o.source_ids->>'fec_id', 1) = 'H'
              OR o.role_title ILIKE '%representative%'
           ))
      )
      AND (p_party IS NULL OR o.party::TEXT = p_party)
      AND (
        p_state IS NULL
        OR o.metadata->>'state'      = p_state
        OR o.metadata->>'state_abbr' = p_state
      )
  ) sub
  LEFT JOIN financial_relationships fr ON fr.official_id = sub.official_id
  GROUP BY sub.official_id, sub.official_name, sub.party, sub.state, sub.chamber
  HAVING COALESCE(SUM(fr.amount_cents), 0) > 0
  ORDER BY total_donated_cents DESC
  LIMIT lim
$$;

ALTER FUNCTION "public"."treemap_officials_by_donations"("lim" integer) OWNER TO "postgres";
ALTER FUNCTION "public"."treemap_officials_by_donations"("lim" integer, "p_chamber" "text", "p_party" "text", "p_state" "text") OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."treemap_officials_by_donations"("lim" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."treemap_officials_by_donations"("lim" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."treemap_officials_by_donations"("lim" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."treemap_officials_by_donations"("lim" integer, "p_chamber" "text", "p_party" "text", "p_state" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."treemap_officials_by_donations"("lim" integer, "p_chamber" "text", "p_party" "text", "p_state" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."treemap_officials_by_donations"("lim" integer, "p_chamber" "text", "p_party" "text", "p_state" "text") TO "service_role";

-- ═══════════════════════════════════════════════════════════════════════════════
-- Seed: platform_limits (originally from 0024)
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO platform_limits (
  service, metric, plan, included_limit, unit,
  overage_unit_cost, overage_unit,
  display_label, display_group, sort_order, notes
) VALUES
('vercel','fluid_cpu_seconds','free', 14400, 'seconds', NULL, NULL, 'Fluid Active CPU', 'Compute', 1, '4 hours = 14,400 seconds. Hard limit.'),
('vercel','function_invocations','free', 1000000, 'requests', NULL, NULL, 'Function Invocations', 'Compute', 2, NULL),
('vercel','origin_transfer_bytes','free', 10737418240, 'bytes', NULL, NULL, 'Fast Origin Transfer', 'Networking', 3, '10 GB hard limit'),
('vercel','edge_requests','free', 1000000, 'requests', NULL, NULL, 'Edge Requests', 'Networking', 4, NULL),
('vercel','edge_cpu_ms','free', 3600000, 'ms', NULL, NULL, 'Edge Request CPU', 'Compute', 5, '1 hour = 3,600,000ms'),
('vercel','build_minutes','free', 6000, 'minutes', NULL, NULL, 'Build Minutes', 'Build', 6, NULL),
('vercel','web_analytics_events','free', 50000, 'events', NULL, NULL, 'Web Analytics Events', 'Analytics', 7, NULL),
('vercel','isr_reads','free', 1000000, 'reads', NULL, NULL, 'ISR Reads', 'Edge Cache', 8, NULL),
('vercel','fluid_memory_gb_hrs','free', 360, 'gb_hours', NULL, NULL, 'Fluid Provisioned Memory', 'Compute', 9, '360 GB-Hrs'),
('vercel','fluid_cpu_seconds','pro', 3600000, 'seconds', NULL, NULL, 'Fluid Active CPU', 'Compute', 1, '1000 hours'),
('vercel','function_invocations','pro', -1, 'requests', NULL, NULL, 'Function Invocations', 'Compute', 2, 'Unlimited (-1)'),
('vercel','origin_transfer_bytes','pro', 1099511627776, 'bytes', 0.15, 'per_gb', 'Fast Origin Transfer', 'Networking', 3, '1 TB included, $0.15/GB over'),
('supabase','egress_bytes','free', 5368709120, 'bytes', NULL, NULL, 'Database Egress', 'Networking', 1, '5 GB hard limit'),
('supabase','db_size_bytes','free', 524288000, 'bytes', NULL, NULL, 'Database Size', 'Storage', 2, '500 MB hard limit'),
('supabase','storage_bytes','free', 1073741824, 'bytes', NULL, NULL, 'File Storage', 'Storage', 3, '1 GB hard limit'),
('supabase','egress_bytes','pro', 268435456000, 'bytes', 0.09, 'per_gb', 'Database Egress', 'Networking', 1, '250 GB included, $0.09/GB over'),
('supabase','db_size_bytes','pro', 8589934592, 'bytes', 0.125, 'per_gb', 'Database Size', 'Storage', 2, '8 GB included, $0.125/GB over'),
('anthropic','monthly_spend_usd','free', 3.50, 'usd', 1.00, 'per_usd', 'Monthly AI Spend', 'AI', 1, 'Self-imposed budget. Overage = actual cost.'),
('cloudflare','storage_bytes','free', 10737418240, 'bytes', 0.015, 'per_gb', 'R2 Storage', 'Storage', 1, '10 GB free, $0.015/GB over'),
('cloudflare','class_a_ops','free', 1000000, 'requests', 0.0045, 'per_1m', 'R2 Write Operations', 'Storage', 2, '1M free, $0.0045/1M over'),
('cloudflare','class_b_ops','free', 10000000, 'requests', 0.00036, 'per_1m', 'R2 Read Operations', 'Storage', 3, '10M free, $0.00036/1M over'),
('mapbox','map_loads','free', 50000, 'requests', 0.0005, 'per_request', 'Monthly Map Loads', 'Maps', 1, '50K free, $0.50/1K over')
ON CONFLICT (service, metric, plan) DO NOTHING;
