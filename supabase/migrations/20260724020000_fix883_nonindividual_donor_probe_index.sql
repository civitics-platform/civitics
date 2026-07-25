-- =============================================================================
-- FIX-883 (follow-up) — make the institutional-donor filter an index-only probe.
--
-- 20260724010000 added get_cohort_top_donors(). It is 256 ms on local for the
-- TX-senators whale cohort but measured **55.6 s / 56.7 s on PROD** for the same
-- cohort shape — far past the 8 s service_role statement cap, i.e. it would have
-- fail-closed on every whale cohort it was written to fix. Prod EXPLAIN:
--
--   Nested Loop
--     -> HashAggregate  (group by ec.from_id)
--          -> Index Only Scan  entity_connections_donation_to_official_idx   <- fine
--     -> Index Scan using financial_entities_pkey on financial_entities fe   <- the cost
--          Index Cond: (id = ec.from_id)
--          Filter: (entity_type <> 'individual' AND COALESCE(display_name,'') !~* '...')
--
-- The aggregate emits one row per DISTINCT donor — ~34k for this cohort, ~87% of
-- them individuals — and each becomes a random primary-key probe into
-- financial_entities: 2,897,003 rows / 2,671,445 of them individual on prod.
-- Local absorbs that in cache; prod is cache-starved (256 MB shared_buffers,
-- ~54% hit — project_prod_buffer_churn_baseline), so ~34k random heap fetches go
-- to disk. That is the entire 55 s, and it is exactly the work the filter then
-- throws away.
--
-- Fix: a partial covering index over ONLY the non-individual entities, so the
-- probe never touches the individual heap at all. 225,538 rows on prod
-- (161,458 corporation + 53,626 other + 7,214 pac + union/super_pac/party/
-- nonprofit) out of 2.9M — a small, hot, fully cacheable index. The partial
-- predicate matches the query's `entity_type <> 'individual'` exactly, so the
-- planner can use it directly, and INCLUDE carries the two columns the projection
-- needs so the probe stays index-only (no heap fetch even for the survivors).
--
-- Existing financial_entities partial indexes (FIX-236 lineage) are all on
-- canonical_name / display_name / total_donated_cents — none is keyed on `id`,
-- so none serves an id-equality probe. This is additive; nothing is replaced.
--
-- Build strategy: plain transactional CREATE INDEX IF NOT EXISTS, matching repo
-- precedent (FIX-195 / FIX-335 / FIX-504 / FIX-745). financial_entities is
-- read-heavy with pipeline-driven, off-peak writes; the build-time SHARE lock
-- blocks only writers (the FEC/USASpending pipelines), never live site reads.
-- To apply with zero write lock, pre-build CONCURRENTLY against prod BEFORE
-- pushing this migration — the IF NOT EXISTS then makes the push a no-op:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_entities_nonindividual_id
--     ON public.financial_entities (id) INCLUDE (display_name, entity_type)
--     WHERE entity_type <> 'individual';
-- =============================================================================

CREATE INDEX IF NOT EXISTS financial_entities_nonindividual_id
  ON public.financial_entities (id)
  INCLUDE (display_name, entity_type)
  WHERE entity_type <> 'individual';

COMMENT ON INDEX public.financial_entities_nonindividual_id IS
  'FIX-883 — partial covering index over non-individual financial entities '
  '(~225k of 2.9M rows), keyed on id with display_name/entity_type INCLUDEd. '
  'Turns get_cohort_top_donors()''s per-donor institutional filter into an '
  'index-only probe instead of a random primary-key probe into the '
  'individual-dominated heap (prod: 55.6s -> sub-second for a whale cohort). '
  'Any id-keyed lookup that also filters entity_type <> ''individual'' benefits.';

ANALYZE public.financial_entities;
