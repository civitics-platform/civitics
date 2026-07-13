-- FIX-699: restore the updated_at trigger on public.financial_entities.
--
-- Migration 0004 created:
--   CREATE TRIGGER financial_entities_updated_at BEFORE UPDATE ON financial_entities
--     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- The shadow->public promotion (20260422000000) recreated public.financial_entities
-- WITHOUT re-creating the trigger, so updated_at has been set only at INSERT
-- (column DEFAULT now()) and never bumped on UPDATE since the 2026-04-22 cutover.
-- Confirmed on prod + local 2026-07-12: pg_trigger shows ZERO non-internal
-- triggers on public.financial_entities, while public.set_updated_at() (arg-less,
-- RETURNS trigger) still exists. Additive + idempotent re-create.
--
-- Scope (verified prod 2026-07-12): only financial_entities lost the trigger —
-- financial_relationships, votes, proposals, officials, agencies, career_history
-- all RETAIN their set_updated_at trigger, so the incremental entity_connections
-- rebuild (keys on financial_relationships.updated_at / votes.updated_at dirty
-- sets) is NOT affected. entity_connections also lacks the trigger but is
-- TRUNCATE-rebuilt wholesale, so its updated_at is cosmetic and left as-is.

DROP TRIGGER IF EXISTS financial_entities_updated_at ON public.financial_entities;

CREATE TRIGGER financial_entities_updated_at
  BEFORE UPDATE ON public.financial_entities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
