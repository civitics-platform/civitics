-- =============================================================================
-- FIX-251 · Extend public.connection_type for LittleSis-derived edges.
--
-- LittleSis category → connection_type mapping (set in
-- packages/data/src/pipelines/littlesis/util.ts):
--   cat 1  Position       → appointment      (existing)
--   cat 3  Membership     → member_of        (new)
--   cat 5  Donation       → DROPPED          (FEC authoritative)
--   cat 6  Transaction    → business_partner (existing)
--   cat 7  Lobbying       → lobbying         (existing)
--   cat 10 Ownership      → owns             (new)
--   cat 11 Hierarchy      → parent_of        (new) — entity1 owns/controls entity2
--   cat 12 Generic        → affiliated_with  (new)
--
-- Must commit before 20260511000002_rebuild_entity_connections_external.sql,
-- which references these values in a CAST inside the RPC body.
-- =============================================================================

ALTER TYPE public.connection_type ADD VALUE IF NOT EXISTS 'member_of';
ALTER TYPE public.connection_type ADD VALUE IF NOT EXISTS 'owns';
ALTER TYPE public.connection_type ADD VALUE IF NOT EXISTS 'parent_of';
ALTER TYPE public.connection_type ADD VALUE IF NOT EXISTS 'affiliated_with';
