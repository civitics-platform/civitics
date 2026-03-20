-- =============================================================================
-- 0009_users_table.sql
-- Clean Supabase-auth users table. Replaces the Privy-era schema (0 rows lost).
-- Linked to Supabase Auth UUID as primary key — Auth manages identity,
-- this table extends it with profile data.
-- =============================================================================

-- Drop Privy-era table (0 rows — safe)
DROP TABLE IF EXISTS users CASCADE;

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id                    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                 TEXT,
  display_name          TEXT,
  avatar_url            TEXT,
  auth_provider         TEXT,                        -- 'email' | 'google' | 'github'
  civic_credits_balance INTEGER      DEFAULT 0,      -- Phase 4 will migrate on-chain
  is_active             BOOLEAN      DEFAULT true,
  last_seen             TIMESTAMPTZ  DEFAULT now(),
  created_at            TIMESTAMPTZ  DEFAULT now(),
  updated_at            TIMESTAMPTZ  DEFAULT now(),
  metadata              JSONB        DEFAULT '{}'    -- Phase 4: wallet_address, wallet_chain
);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Read own row
CREATE POLICY "users_select_own" ON users
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- Insert own row (first sign-in)
CREATE POLICY "users_insert_own" ON users
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

-- Update own row
CREATE POLICY "users_update_own" ON users
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX idx_users_email   ON users(email);
CREATE INDEX idx_users_created ON users(created_at DESC);

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- DOWN: DROP TABLE IF EXISTS users CASCADE;
--       DROP FUNCTION IF EXISTS update_updated_at_column();
