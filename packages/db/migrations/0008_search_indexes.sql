-- Migration 0008: Search indexes for full-text and trigram search
-- Requires: pg_trgm extension (already enabled)
--
-- Run: apply via Supabase SQL editor
-- Rollback: DROP INDEX IF EXISTS idx_officials_fts, idx_officials_name_trgm,
--   idx_proposals_fts, idx_proposals_title_trgm,
--   idx_agencies_name_trgm, idx_agencies_acronym_trgm;

-- ── Officials ──────────────────────────────────────────────────────────────────

-- Full-text search on name + role + state
CREATE INDEX IF NOT EXISTS idx_officials_fts
  ON officials
  USING GIN (
    to_tsvector('english',
      full_name || ' ' ||
      COALESCE(role_title, '') || ' ' ||
      COALESCE(metadata->>'state', '')
    )
  );

-- Trigram for partial-match ILIKE on name (e.g. "Mitch", "McConn")
CREATE INDEX IF NOT EXISTS idx_officials_name_trgm
  ON officials
  USING GIN (full_name gin_trgm_ops);

-- ── Proposals ─────────────────────────────────────────────────────────────────

-- Full-text search on title + plain summary
CREATE INDEX IF NOT EXISTS idx_proposals_fts
  ON proposals
  USING GIN (
    to_tsvector('english',
      title || ' ' ||
      COALESCE(summary_plain, '')
    )
  );

-- Trigram for partial-match ILIKE on title
CREATE INDEX IF NOT EXISTS idx_proposals_title_trgm
  ON proposals
  USING GIN (title gin_trgm_ops);

-- ── Agencies ──────────────────────────────────────────────────────────────────

-- Trigram on name (e.g. "Environmental", "Food and Drug")
CREATE INDEX IF NOT EXISTS idx_agencies_name_trgm
  ON agencies
  USING GIN (name gin_trgm_ops);

-- Trigram on acronym (e.g. "EPA", "FAA")
CREATE INDEX IF NOT EXISTS idx_agencies_acronym_trgm
  ON agencies
  USING GIN (acronym gin_trgm_ops);
