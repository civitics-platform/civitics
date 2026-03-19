-- =============================================================================
-- 0009_users_table.sql
-- User profile table — extends Supabase auth.users with civic engagement fields.
-- Linked to Supabase Auth UUID as primary key.
-- Created automatically on first sign-in via the auth callback route.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email          TEXT,
  auth_provider  TEXT DEFAULT 'email',
  created_at     TIMESTAMPTZ DEFAULT now(),
  last_seen      TIMESTAMPTZ DEFAULT now(),
  metadata       JSONB DEFAULT '{}'
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Users can only read and write their own row
CREATE POLICY "users_select_own" ON users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "users_insert_own" ON users
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (auth.uid() = id);

-- DOWN: DROP TABLE IF EXISTS users;
