-- =============================================================================
-- 0011_page_views.sql
-- Self-hosted, privacy-first page view tracking.
-- No cookies. No fingerprinting. No IP storage. Session IDs are ephemeral
-- (sessionStorage — cleared when browser closes). Country only, never IP.
-- =============================================================================

CREATE TABLE IF NOT EXISTS page_views (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page         TEXT        NOT NULL,
  entity_type  TEXT,
  entity_id    UUID,
  referrer     TEXT,
  is_bot       BOOLEAN     DEFAULT false,
  bot_name     TEXT,
  device_type  TEXT,
  browser      TEXT,
  country_code TEXT,
  session_id   TEXT,
  viewed_at    TIMESTAMPTZ DEFAULT now()
);

-- No RLS: write-only from server, public reads are aggregate-only (via functions below)
ALTER TABLE page_views DISABLE ROW LEVEL SECURITY;

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_page_views_page       ON page_views(page);
CREATE INDEX IF NOT EXISTS idx_page_views_viewed_at  ON page_views(viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_entity     ON page_views(entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page_views_bot        ON page_views(is_bot, viewed_at);

-- ── Dashboard helper functions ────────────────────────────────────────────────
-- All return aggregates only — raw rows are never exposed publicly.

-- Summary: total / human / bot counts for current month
CREATE OR REPLACE FUNCTION get_pv_summary()
RETURNS TABLE(total_views BIGINT, human_views BIGINT, bot_views BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT
    COUNT(*)                                      AS total_views,
    COUNT(*) FILTER (WHERE is_bot = false)        AS human_views,
    COUNT(*) FILTER (WHERE is_bot = true)         AS bot_views
  FROM page_views
  WHERE viewed_at > date_trunc('month', NOW());
$$;

-- Top pages (humans only, current month)
CREATE OR REPLACE FUNCTION get_pv_top_pages(lim INT DEFAULT 10)
RETURNS TABLE(page TEXT, views BIGINT, unique_sessions BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT page, COUNT(*) AS views, COUNT(DISTINCT session_id) AS unique_sessions
  FROM page_views
  WHERE is_bot = false AND viewed_at > date_trunc('month', NOW())
  GROUP BY page
  ORDER BY views DESC
  LIMIT lim;
$$;

-- Traffic sources (humans only, current month)
CREATE OR REPLACE FUNCTION get_pv_sources()
RETURNS TABLE(referrer TEXT, visits BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT referrer, COUNT(*) AS visits
  FROM page_views
  WHERE is_bot = false AND viewed_at > date_trunc('month', NOW())
  GROUP BY referrer
  ORDER BY visits DESC;
$$;

-- Device breakdown (humans only, current month)
CREATE OR REPLACE FUNCTION get_pv_devices()
RETURNS TABLE(device_type TEXT, count BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(device_type, 'desktop') AS device_type, COUNT(*) AS count
  FROM page_views
  WHERE is_bot = false AND viewed_at > date_trunc('month', NOW())
  GROUP BY device_type
  ORDER BY count DESC;
$$;

-- Top countries (humans only, current month)
CREATE OR REPLACE FUNCTION get_pv_countries(lim INT DEFAULT 10)
RETURNS TABLE(country_code TEXT, count BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT country_code, COUNT(*) AS count
  FROM page_views
  WHERE is_bot = false
    AND viewed_at > date_trunc('month', NOW())
    AND country_code IS NOT NULL
  GROUP BY country_code
  ORDER BY count DESC
  LIMIT lim;
$$;

-- Bot breakdown (current month)
CREATE OR REPLACE FUNCTION get_pv_bots()
RETURNS TABLE(visitor_type TEXT, count BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT
    CASE WHEN is_bot THEN COALESCE(bot_name, 'Unknown bot') ELSE 'Human' END AS visitor_type,
    COUNT(*) AS count
  FROM page_views
  WHERE viewed_at > date_trunc('month', NOW())
  GROUP BY visitor_type
  ORDER BY count DESC;
$$;

-- Most viewed officials (30 days, humans only)
CREATE OR REPLACE FUNCTION get_pv_top_officials(lim INT DEFAULT 5)
RETURNS TABLE(official_id UUID, full_name TEXT, role_title TEXT, views BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT o.id AS official_id, o.full_name, o.role_title, COUNT(*) AS views
  FROM page_views pv
  JOIN officials o ON pv.entity_id = o.id
  WHERE pv.entity_type = 'official'
    AND pv.is_bot = false
    AND pv.viewed_at > NOW() - INTERVAL '30 days'
  GROUP BY o.id, o.full_name, o.role_title
  ORDER BY views DESC
  LIMIT lim;
$$;

-- Most viewed proposals (30 days, humans only)
CREATE OR REPLACE FUNCTION get_pv_top_proposals(lim INT DEFAULT 5)
RETURNS TABLE(proposal_id UUID, title TEXT, views BIGINT)
LANGUAGE SQL STABLE AS $$
  SELECT p.id AS proposal_id, p.title, COUNT(*) AS views
  FROM page_views pv
  JOIN proposals p ON pv.entity_id = p.id
  WHERE pv.entity_type = 'proposal'
    AND pv.is_bot = false
    AND pv.viewed_at > NOW() - INTERVAL '30 days'
  GROUP BY p.id, p.title
  ORDER BY views DESC
  LIMIT lim;
$$;

-- ── Data retention note ────────────────────────────────────────────────────────
-- Run monthly (manual or Supabase scheduled function):
--   DELETE FROM page_views WHERE viewed_at < NOW() - INTERVAL '90 days';
-- 90 days is enough for trend analysis. Don't hoard data we don't need.

-- DOWN:
--   DROP FUNCTION IF EXISTS get_pv_summary, get_pv_top_pages, get_pv_sources,
--     get_pv_devices, get_pv_countries, get_pv_bots, get_pv_top_officials, get_pv_top_proposals;
--   DROP TABLE IF EXISTS page_views;
