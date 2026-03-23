-- Migration 0020: Add nomination_vote_yes and nomination_vote_no to connection_type enum
--
-- These types were referenced by the connections pipeline but missing from the enum,
-- causing all nomination vote upserts to fail silently (invalid enum value).
-- Run the connections pipeline after applying this migration.

ALTER TYPE connection_type ADD VALUE IF NOT EXISTS 'nomination_vote_yes';
ALTER TYPE connection_type ADD VALUE IF NOT EXISTS 'nomination_vote_no';
