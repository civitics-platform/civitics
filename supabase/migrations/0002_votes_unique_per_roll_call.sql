-- Migration 0002: Fix votes unique constraint to allow multiple roll calls per bill
--
-- The original constraint UNIQUE(official_id, proposal_id) assumed one vote per
-- member per proposal. In practice, a single bill has multiple roll calls:
-- ordering the previous question, recommit, amendment votes, final passage, etc.
-- Each roll call is a distinct recorded vote and all should be stored.
--
-- New constraint: UNIQUE(official_id, proposal_id, roll_call_number, chamber, session)
-- This allows one row per member per roll call, while still preventing duplicate
-- ingestion of the same roll call on re-runs.

-- Drop the overly-restrictive constraint
ALTER TABLE votes DROP CONSTRAINT votes_official_id_proposal_id_key;

-- Add the correct constraint (roll_call_number may be NULL for legacy data;
-- NULLS are distinct in PostgreSQL unique constraints, so NULLs won't conflict)
ALTER TABLE votes
  ADD CONSTRAINT votes_official_roll_call_key
  UNIQUE (official_id, proposal_id, roll_call_number, chamber, session);
