-- =============================================================================
-- Migration 0022: data_sync_log + graph_snapshots
--
-- data_sync_log: records every pipeline run — source, status, counts, errors.
--   Powers the pipeline activity section of the accountability dashboard.
--
-- graph_snapshots: share codes for the connection graph. A short code maps to
--   a full serialized graph state so users can share a specific view.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- data_sync_log
-- Every data pipeline run is recorded here: source, status, record counts.
-- Column names match the prod schema (rows_inserted/updated/failed, estimated_mb).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_sync_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline       TEXT        NOT NULL,   -- 'congress_members', 'fec_bulk', 'usaspending', etc.
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  rows_inserted  INTEGER     NOT NULL DEFAULT 0,
  rows_updated   INTEGER     NOT NULL DEFAULT 0,
  rows_failed    INTEGER     NOT NULL DEFAULT 0,
  estimated_mb   NUMERIC(10, 3),        -- approximate data volume processed
  status         TEXT        NOT NULL,   -- 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted'
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata       JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_data_sync_log_pipeline
  ON data_sync_log (pipeline, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_sync_log_status
  ON data_sync_log (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_sync_log_started_at
  ON data_sync_log (started_at DESC);

-- RLS: publicly readable (dashboard transparency), writes via service role only
ALTER TABLE data_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_data_sync_log"
  ON data_sync_log FOR SELECT
  TO anon, authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- graph_snapshots
-- Share codes for the D3 connection graph. A short alphanumeric code maps to
-- a serialized graph state (nodes, edges, config, viewport). view_count tracks
-- how many times a share link has been opened.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS graph_snapshots (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT        UNIQUE NOT NULL,   -- short share code: e.g. 'a1b2c3'
  state       JSONB       NOT NULL,          -- serialized graph: {nodes, edges, config, viewport}
  title       TEXT,                          -- optional human-readable description
  created_by  UUID,                          -- user who created it (null for anonymous)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count  INTEGER     NOT NULL DEFAULT 0,
  is_public   BOOLEAN     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_graph_snapshots_code
  ON graph_snapshots (code);

CREATE INDEX IF NOT EXISTS idx_graph_snapshots_created_at
  ON graph_snapshots (created_at DESC);

-- RLS: publicly readable (share links are public by design)
ALTER TABLE graph_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_graph_snapshots"
  ON graph_snapshots FOR SELECT
  TO anon, authenticated
  USING (is_public = true);

-- DOWN:
-- DROP TABLE IF EXISTS graph_snapshots;
-- DROP TABLE IF EXISTS data_sync_log;
