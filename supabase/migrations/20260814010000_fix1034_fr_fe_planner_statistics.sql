-- =============================================================================
-- FIX-1034 — correct the two planner-statistics defects on financial_entities
-- and financial_relationships that priced the incident plan below the safe one.
--
-- DEFECT 1 — expression selectivity. LENGTH(metadata->>'state') = 2 on
-- financial_entities is an expression that no index and no statistics object
-- covered, so the planner fell back to its hardcoded DEFAULT_EQ_SEL of 0.005.
-- Measured on prod 2026-08-14: 3,198,178 of 3,671,799 rows match — 87.10%. The
-- planner estimated 18,330. That is what made a nested loop's inner side look
-- ~174x smaller than it is.
--
-- DEFECT 2 — n_distinct. pg_stats reported n_distinct = 42,267 for
-- financial_relationships.from_id. Measured TABLE-WIDE on prod 2026-08-14:
-- 2,810,356 distinct values over 10,478,133 rows — a 66.5x underestimate. (The
-- FIX-1034 bullet carried 1,745,921, which was the donation-subset figure; the
-- bullet flagged that gap itself and asked for the table-wide number. This is
-- it.) An underestimated n_distinct is what makes Memoize look nearly free:
-- the planner believes from_id repeats constantly, so it prices a cache that in
-- reality almost always misses.
--
-- Together, at prod's random_page_cost of 1.1, these two made a Memoize-backed
-- nested loop price BELOW the hash join. That plan wedged prod for 14h22m on
-- 2026-08-11 and crashed it on 2026-08-13. FIX-1030 fixed the symptom for ONE
-- query with a CTE AS MATERIALIZED optimiser fence; the statistics stayed wrong,
-- so any other FR/FE consumer could still flip the same way.
--
-- ── WHY n_distinct IS NEGATIVE ──────────────────────────────────────────────
-- Postgres reads a negative n_distinct as a FRACTION of reltuples, so
-- -0.268211 (= 2,810,356 / 10,478,133) stays correct as the table grows. A
-- positive absolute would go stale exactly the way the sampled value did — that
-- staleness is the defect, and hardcoding a different constant would only reset
-- its clock.
--
-- ── WHY TWO STATISTICS OBJECTS ──────────────────────────────────────────────
-- length(metadata->>'state') and metadata->>'state' are DIFFERENT expressions
-- to the planner; statistics on one do nothing for the other. The length form is
-- what the chord query filters on today; the bare form is what any future
-- state-equality predicate will use.
--
-- ── ANALYZE IS PART OF THIS MIGRATION, DELIBERATELY ─────────────────────────
-- Neither change does anything until the stats are rebuilt: the n_distinct
-- attoption is consumed BY ANALYZE, which writes the override into
-- pg_statistic. Normally data-state work is kept out of migrations (CLAUDE.md),
-- but here the ANALYZE is not data-state — it is what makes the DDL take
-- effect, and splitting them would leave both environments in a state where the
-- migration claims a fix that is not live. Measured cost on prod: 8.1s for
-- financial_entities, 9.0s for financial_relationships. ANALYZE takes SHARE
-- UPDATE EXCLUSIVE and does not block reads or writes. (The FIX-1034 bullet
-- warned this would be full-scan-class against a 3,036 MB and 8,550 MB heap and
-- to schedule it off-peak per FIX-1032; the measurement says it is seconds, not
-- minutes, so the warm-box rule is satisfied by any normal deploy window.)
--
-- ── GATE EVIDENCE ───────────────────────────────────────────────────────────
-- FIX-1034 required before/after EXPLAIN diffs on the main FR/FE consumers and
-- landing only if none regresses. Run on prod 2026-08-14 via
-- scripts/fix1034-stats-ab.mjs, which executes BOTH passes inside one
-- transaction it then ROLLS BACK (CREATE STATISTICS / ALTER TABLE SET / ANALYZE
-- are all transactional, unlike VACUUM), so the gate cost production nothing.
-- Ten queries, extracted verbatim from the live function bodies:
--
--   Q1  chord unit 3, FIX-1030 fenced (the MV as it ships)   shape improved
--   Q2  chord unit 3 UNFENCED (the shape that wedged prod)   NestedLoop+Memoize -> Hash Join
--   Q3  donor_party_rollup_rebuild_donors agg                same shape, -27.3%
--   Q4  donor_rollup arm 1 per_donor                         same shape,  -5.1%
--   Q5  donor_rollup arm 2 official_donor_totals             Memoize DROPPED, parallelised
--   Q6  treemap_individuals_rebuild_officials                Memoize DROPPED, parallelised
--   Q7  rebuild_entity_connections_donations                 same shape, -95.6%
--   Q8  chord_industry_flows_for_official (request path)     unchanged, 0.0%
--   Q9  unrestricted FR x FE join                            NestedLoop+Memoize -> Hash Join
--   Q10 FR x FE + the FE state expression                    Nested Loop      -> Hash Join
--
-- READING THE COSTS. Several "after" costs are HIGHER, and that is not a
-- regression: estimated costs computed under two different sets of statistics
-- are not commensurable. The old numbers were cheap because they were wrong. The
-- direct check is estimate-vs-truth on the defect itself — the donor_states CTE
-- went from an estimated 18,330 rows to 3,201,038 against a measured 3,198,178,
-- i.e. from 174x wrong to 0.09% off. Every shape change is in the intended
-- direction: three Memoize-backed nested loops became hash joins, two useless
-- Memoize nodes were dropped, and none of the ten acquired a nested loop or a
-- Memoize it did not already have.
--
-- ONE THING TO WATCH. Q1's donor_states CTE loses a 1-worker parallel seq scan
-- and goes serial, because a 3.2M-row scan no longer looks like an 18k-row one
-- and Gather's transfer cost stops paying for itself. The join order also flips
-- to hash the 37k-row officials side first instead of the 3.2M-row donor side,
-- which is the better order for the real data. Net expected to be a win, but
-- chord_donor_state_party_flows_mv is the unit that took prod down twice, so its
-- first unsupervised weekly firing (pg_cron jobid 10, Tue 07:00 UTC) is the
-- place to confirm it — now watched by FIX-1030's budget and FIX-1035's
-- liveness-first close.
--
-- Cross-ref FIX-1030, FIX-1018, FIX-1032, FIX-884, FIX-443.
-- =============================================================================

CREATE STATISTICS IF NOT EXISTS public.fe_state_len_stats
  ON (length(metadata->>'state')) FROM public.financial_entities;

CREATE STATISTICS IF NOT EXISTS public.fe_state_value_stats
  ON (metadata->>'state') FROM public.financial_entities;

COMMENT ON STATISTICS public.fe_state_len_stats IS
  'FIX-1034 — expression statistics for length(metadata->>''state''), the '
  'predicate chord_donor_state_party_flows_mv filters on. Without it the '
  'planner used DEFAULT_EQ_SEL 0.005 against an 87.10% truth (18,330 estimated '
  'vs 3,198,178 actual on prod), which is half of what priced the incident '
  'plan below the hash join.';

COMMENT ON STATISTICS public.fe_state_value_stats IS
  'FIX-1034 — expression statistics for the BARE metadata->>''state''. Separate '
  'object on purpose: length(expr) and expr are different expressions to the '
  'planner, so stats on one do nothing for the other. This one covers future '
  'state-equality predicates rather than any query shipping today.';

-- NEGATIVE = fraction of reltuples, so it survives table growth.
-- 2,810,356 distinct / 10,478,133 rows, measured table-wide on prod 2026-08-14.
ALTER TABLE public.financial_relationships
  ALTER COLUMN from_id SET (n_distinct = -0.268211);

-- Required: the attoption is consumed by ANALYZE, and the statistics objects
-- hold no data until ANALYZE populates them.
ANALYZE public.financial_entities;
ANALYZE public.financial_relationships;
