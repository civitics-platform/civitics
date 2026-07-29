-- verify-fix921-oil-gas-sweep.sql — Phase 2 measurement batch for the oil_gas
-- escapee sweep. READ ONLY.
--
--   node scripts/db-query.mjs --local --file scripts/verify-fix921-oil-gas-sweep.sql
--   node scripts/db-query.mjs --prod  --file scripts/verify-fix921-oil-gas-sweep.sql
--
-- Run BEFORE the seed migration for a baseline, and again after the producer
-- (tagFinancialEntities) has re-run, to measure the move.

\pset pager off

-- ---------------------------------------------------------------------------
-- M1 — per-industry donating-donor census. `oil_gas` is the tag under audit:
-- expected to fall from 128 donors / ~$48.0M by ~50 donors and ~$4-5M, with
-- `utilities` and `mining` taking most of the difference.
--
-- "Donating donor" = a financial_entity carrying that industry tag that is the
-- from_id of at least one positive donation. total_donated_cents is the
-- FIX-269-maintained outflow column, so this needs no FR scan.
-- ---------------------------------------------------------------------------
SELECT 'M1 industry census (donating donors)' AS check,
       et.tag                                   AS industry,
       count(*)                                 AS donating_donors,
       to_char(sum(fe.total_donated_cents) / 100.0, 'FM999,999,999,990.00') AS dollars
  FROM public.entity_tags et
  JOIN public.financial_entities fe ON fe.id = et.entity_id
 WHERE et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
   AND fe.total_donated_cents > 0
 GROUP BY et.tag
 ORDER BY sum(fe.total_donated_cents) DESC;

-- ---------------------------------------------------------------------------
-- M2 — the seeded override table, by cohort. Expected after this migration:
-- 792 total = 742 (FIX-916) + 50 (this change).
-- ---------------------------------------------------------------------------
SELECT 'M2 override table by source' AS check,
       source,
       count(*)                       AS rows,
       count(industry)                AS reassigned,
       count(*) - count(industry)     AS de_tagged
  FROM public.financial_entity_industry_overrides
 GROUP BY source
 ORDER BY source;

SELECT 'M2 this sweep, by target industry' AS check,
       COALESCE(industry, '(NONE — de-tagged)') AS industry,
       count(*)                                 AS rows
  FROM public.financial_entity_industry_overrides
 WHERE source = 'audit-2026-07-28-oil-gas'
 GROUP BY COALESCE(industry, '(NONE — de-tagged)')
 ORDER BY 2 DESC, 1;

-- ---------------------------------------------------------------------------
-- M1b — the same census measured off the DONATION LEDGER rather than the
-- denormalised financial_entities.total_donated_cents column.
--
-- The two disagree, and which one you quote matters. total_donated_cents is
-- FIX-269's rebuilt outflow total and covers donations to officials AND to
-- committees; the ledger sum below is scoped to donations reaching OFFICIALS,
-- which is what the industry-influence surfaces actually render. Report both
-- rather than picking one silently.
-- ---------------------------------------------------------------------------
SELECT 'M1b industry census (donation ledger → officials)' AS check,
       et.tag                                              AS industry,
       count(DISTINCT fr.from_id)                          AS donating_donors,
       to_char(sum(fr.amount_cents) / 100.0, 'FM999,999,999,990.00') AS dollars
  FROM public.financial_relationships fr
  JOIN public.entity_tags et
    ON et.entity_id    = fr.from_id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
 WHERE fr.relationship_type = 'donation'
   AND fr.to_type = 'official'
   AND fr.amount_cents > 0
 GROUP BY et.tag
 ORDER BY sum(fr.amount_cents) DESC;

-- ---------------------------------------------------------------------------
-- M3 — decision 8: the override table's KEY BLIND SPOT.
--
-- financial_entity_industry_overrides is keyed on fec_committee_id. Any donor
-- with a NULL fec_committee_id is UNREACHABLE by the curation mechanism — it
-- cannot be re-assigned or de-tagged, no matter what an audit finds. Two known
-- cases surfaced by this sweep (Cumberland Energy Action Fund $135k, Ridge Coal
-- Legacy Trust $15k) are both oil_gas escapees the list cannot address.
--
-- This measures the size of that blind spot: industry-tagged donors that have
-- actually donated and carry no committee id.
-- ---------------------------------------------------------------------------
SELECT 'M3 NULL fec_committee_id blind spot' AS check,
       count(DISTINCT fe.id)                                          AS unreachable_donors,
       to_char(sum(DISTINCT fe.total_donated_cents) / 100.0, 'FM999,999,999,990.00') AS dollars,
       count(DISTINCT fe.id) FILTER (WHERE et.tag = 'oil_gas')        AS of_which_oil_gas
  FROM public.financial_entities fe
  JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
 WHERE fe.fec_committee_id IS NULL
   AND fe.total_donated_cents > 0;

-- Named, biggest first — so "small, leave it" vs "large, revisit the key" is a
-- judgement made against actual entities rather than a bare count.
SELECT 'M3 unreachable donors, top 25' AS check,
       fe.display_name,
       fe.entity_type,
       string_agg(et.tag, ', ' ORDER BY et.tag)                      AS industries,
       to_char(fe.total_donated_cents / 100.0, 'FM999,999,990.00')   AS dollars
  FROM public.financial_entities fe
  JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
 WHERE fe.fec_committee_id IS NULL
   AND fe.total_donated_cents > 0
 GROUP BY fe.id, fe.display_name, fe.entity_type, fe.total_donated_cents
 ORDER BY fe.total_donated_cents DESC
 LIMIT 25;

-- ---------------------------------------------------------------------------
-- M4 — THE PAYOFF. HR 26 cohort recomposition.
--
-- Pre-vote `oil_gas` dollars reaching the 191 Democrats on roll-call
-- 2025-house-035. Baseline before this change: $5,158,104 across 102 donors at
-- ~92% core fossil. The whole point of the sweep is that the ~8% that was NOT
-- fossil (Portland General Electric, NV Energy, CNG Holdings et al) stops being
-- counted as fossil money.
--
-- "Pre-vote" = donation dated before the roll-call date, which is what makes the
-- measure an influence claim rather than a correlation.
-- ---------------------------------------------------------------------------
WITH rc AS (
  SELECT v.bill_proposal_id,
         min(v.voted_at) AS voted_at
    FROM public.votes v
   WHERE v.roll_call_id = '2025-house-035'
   GROUP BY v.bill_proposal_id
),
cohort AS (
  SELECT DISTINCT v.official_id
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
   WHERE v.roll_call_id = '2025-house-035'
     AND o.party = 'democrat'
     AND v.vote IN ('yes', 'no')   -- 176 no + 15 yes = the 191-member cohort; excludes 10 not_voting
)
SELECT 'M4 HR 26 — oil_gas pre-vote money to the D cohort' AS check,
       (SELECT count(*) FROM cohort)                        AS cohort_officials,
       count(DISTINCT fr.from_id)                           AS donors,
       to_char(sum(fr.amount_cents) / 100.0, 'FM999,999,990.00') AS dollars
  FROM public.financial_relationships fr
  JOIN cohort c ON c.official_id = fr.to_id
  JOIN public.entity_tags et
    ON et.entity_id    = fr.from_id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
   AND et.tag          = 'oil_gas'
  CROSS JOIN (SELECT min(voted_at) AS voted_at FROM rc) rcv
 WHERE fr.relationship_type = 'donation'
   AND fr.to_type = 'official'
   AND fr.amount_cents > 0
   AND fr.occurred_at < rcv.voted_at;

-- The three named false positives the sweep is supposed to remove. After the
-- producer re-runs, this must return ZERO rows.
WITH rc AS (
  SELECT min(v.voted_at) AS voted_at
    FROM public.votes v
   WHERE v.roll_call_id = '2025-house-035'
),
cohort AS (
  SELECT DISTINCT v.official_id
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
   WHERE v.roll_call_id = '2025-house-035'
     AND o.party = 'democrat'
     AND v.vote IN ('yes', 'no')   -- 176 no + 15 yes = the 191-member cohort; excludes 10 not_voting
)
SELECT 'M4 named false positives (expect 0 rows after)' AS check,
       fe.display_name,
       fe.fec_committee_id,
       count(DISTINCT fr.to_id)                                  AS cohort_recipients,
       to_char(sum(fr.amount_cents) / 100.0, 'FM999,999,990.00')  AS dollars
  FROM public.financial_relationships fr
  JOIN cohort c ON c.official_id = fr.to_id
  JOIN public.financial_entities fe ON fe.id = fr.from_id
  JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
   AND et.tag          = 'oil_gas'
  CROSS JOIN rc
 WHERE fr.relationship_type = 'donation'
   AND fr.to_type = 'official'
   AND fr.amount_cents > 0
   AND fr.occurred_at < rc.voted_at
   AND fe.fec_committee_id IN ('C00381020', 'C00153379', 'C00441311')
 GROUP BY fe.display_name, fe.fec_committee_id
 ORDER BY 4 DESC;
