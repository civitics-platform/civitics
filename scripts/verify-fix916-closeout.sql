-- verify-fix916-closeout.sql — Phase 0 gate for the industry-tag remediation
-- (FIX-910 / FIX-916 / FIX-917).
--
-- READ ONLY. Run with:
--   node scripts/db-query.mjs --prod  --file scripts/verify-fix916-closeout.sql
--   node scripts/db-query.mjs --local --file scripts/verify-fix916-closeout.sql
--
-- WHY THIS EXISTS: those three FIXes shipped `Verified: local` because their
-- effect is produced by a RUNTIME action (the nightly `tag_rules` phase plus a
-- rollup rebuild), not by the migration that shipped with them. Schema reaching
-- prod says nothing about whether prod's DERIVED data moved. This batch is the
-- evidence that it did.
--
-- C2 IS THE SUBTLE ONE. official_sector_affinity_rollup is normally refreshed
-- INCREMENTALLY off the FIX-704/832 donor dirty set, which keys off
-- financial_relationships.updated_at. A curated industry override changes
-- entity_tags ONLY — no financial_relationships row is touched — so an
-- overridden donor never enters the dirty set and the incremental path is a
-- no-op for exactly the change we are trying to verify. Only a FULL
-- backfill_official_sector_affinity_rollup() re-buckets the dollars. If C2
-- fails, the officials' industry pills on prod are still showing the PRE-audit
-- buckets and Phase 0 has NOT passed.

\pset pager off

-- ---------------------------------------------------------------------------
-- C0 — is a nightly in flight right now?
-- A mid-flight tagger DELETEs then re-inserts, so a read taken inside that
-- window can show a legitimately-empty table.
--
-- FIX-989 — this gate used to be `data_sync_log.status = 'running'` within 12h,
-- which is not liveness (playbook D2). It is wrong in BOTH directions: a dead
-- process leaves the row set (false positive), and a process that never wrote a
-- start row is invisible (false negative). The expensive direction here is the
-- FALSE POSITIVE — this is a gate on a prod close-out, and a guard that refuses
-- because a corpse says 'running' is a self-inflicted outage (playbook C3).
--
-- Liveness now comes from pg_stat_activity, which cannot go stale: a backend
-- disappears from it when it dies, by construction. pg_cron job executors show
-- up there too, so one probe covers both GHA-launched (pooled) and pg_cron work.
-- The data_sync_log read is KEPT below but demoted to advisory context, and
-- C0-verdict prints WHICH case it found so a hold is never mysterious.
-- ---------------------------------------------------------------------------
SELECT 'C0a LIVE backends — the gate (expect 0 rows)' AS check,
       pid,
       usename,
       application_name,
       state,
       now() - xact_start  AS xact_age,
       now() - query_start AS query_age,
       wait_event_type,
       left(regexp_replace(coalesce(query, ''), '\s+', ' ', 'g'), 140) AS query
  FROM pg_stat_activity
 WHERE datname       = current_database()
   AND pid          <> pg_backend_pid()
   AND backend_type  = 'client backend'
   AND state IS DISTINCT FROM 'idle'
 ORDER BY xact_start NULLS LAST;

-- Advisory ONLY — never the gate. A `running` row with no live backend behind
-- it is an orphan (the reaper has not been by yet), not work in flight.
SELECT 'C0b data_sync_log running rows (ADVISORY, not liveness)' AS check,
       pipeline,
       status,
       started_at,
       now() - started_at AS age,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_stat_activity a
               WHERE a.datname       = current_database()
                 AND a.pid          <> pg_backend_pid()
                 AND a.backend_type  = 'client backend'
                 AND a.state IS DISTINCT FROM 'idle')
            THEN 'a backend IS alive — this row may be real'
            ELSE 'NO live backend — this row is a STALE ORPHAN, ignore it'
       END AS interpretation
  FROM public.data_sync_log
 WHERE status IN ('running')
   AND started_at > now() - interval '12 hours'
 ORDER BY started_at DESC;

SELECT 'C0 verdict' AS check,
       live.n                                       AS live_backends,
       stale.n                                      AS running_rows,
       CASE
         WHEN live.n > 0
           THEN 'HOLD — ' || live.n || ' live backend(s); real work is in flight'
         WHEN stale.n > 0
           THEN 'PROCEED — no live backend; the ' || stale.n ||
                ' running row(s) above are stale orphans, NOT a reason to hold (FIX-989)'
         ELSE 'PROCEED — quiet: no live backends and no running rows'
       END                                          AS verdict
  FROM (SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname       = current_database()
           AND pid          <> pg_backend_pid()
           AND backend_type  = 'client backend'
           AND state IS DISTINCT FROM 'idle') live,
       (SELECT count(*) AS n FROM public.data_sync_log
         WHERE status = 'running'
           AND started_at > now() - interval '12 hours') stale;

-- ---------------------------------------------------------------------------
-- C1 — did the nightly rule tagger complete green?
-- ---------------------------------------------------------------------------
SELECT 'C1 tag_rules runs (last 48h)' AS check,
       pipeline,
       status,
       started_at,
       completed_at,
       rows_inserted,
       error_message
  FROM public.data_sync_log
 WHERE pipeline IN ('tag_rules', 'tags_rules', 'rule_tags')
   AND started_at > now() - interval '48 hours'
 ORDER BY started_at DESC;

-- ---------------------------------------------------------------------------
-- C2 — did a FULL sector-affinity backfill run, and did it run AFTER the
-- tagger? Ordering matters: a backfill that predates the tag rewrite bucketed
-- the OLD tags.
-- ---------------------------------------------------------------------------
SELECT 'C2 sector-affinity FULL backfills (last 7d)' AS check,
       pipeline,
       status,
       completed_at,
       rows_inserted,
       metadata
  FROM public.data_sync_log
 WHERE pipeline = 'sector_affinity_rollup_backfill'
   AND started_at > now() - interval '7 days'
 ORDER BY started_at DESC;

SELECT 'C2 verdict' AS check,
       (SELECT max(completed_at)
          FROM public.data_sync_log
         WHERE pipeline = 'sector_affinity_rollup_backfill'
           AND status = 'complete')                       AS last_full_backfill,
       (SELECT max(completed_at)
          FROM public.data_sync_log
         WHERE pipeline IN ('tag_rules', 'tags_rules', 'rule_tags')
           AND status = 'complete')                       AS last_tag_rules,
       (SELECT min(updated_at) FROM public.official_sector_affinity_rollup)
                                                          AS rollup_oldest_row,
       CASE
         WHEN (SELECT max(completed_at) FROM public.data_sync_log
                WHERE pipeline = 'sector_affinity_rollup_backfill'
                  AND status = 'complete') IS NULL
           THEN 'FAIL — no full backfill has ever completed'
         WHEN (SELECT max(completed_at) FROM public.data_sync_log
                WHERE pipeline = 'sector_affinity_rollup_backfill'
                  AND status = 'complete')
              < (SELECT max(completed_at) FROM public.data_sync_log
                  WHERE pipeline IN ('tag_rules', 'tags_rules', 'rule_tags')
                    AND status = 'complete')
           THEN 'FAIL — last full backfill PREDATES the last tag_rules run'
         ELSE 'PASS'
       END                                                AS verdict;

-- C2 blast radius — if the verdict above is FAIL, this is how much of it is
-- still wrong. Officials that received money from at least one curated-override
-- donor, split by whether their rollup has been rebuilt since the override
-- landed. A stale row here is an official whose industry pills are STILL the
-- pre-audit buckets.
WITH overridden AS (
  SELECT fe.id
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe ON fe.fec_committee_id = o.fec_committee_id
),
affected AS (
  SELECT DISTINCT fr.to_id AS official_id
    FROM public.financial_relationships fr
    JOIN overridden ov ON ov.id = fr.from_id
   WHERE fr.relationship_type = 'donation'
     AND fr.to_type = 'official'
     AND fr.amount_cents > 0
),
freshness AS (
  SELECT r.official_id, max(r.updated_at) AS refreshed
    FROM public.official_sector_affinity_rollup r
   GROUP BY r.official_id
),
cutoff AS (SELECT '2026-07-28 02:44:00+00'::timestamptz AS t)  -- FIX-916 landed (663aa865)
SELECT 'C2 blast radius' AS check,
       count(*)                                                    AS officials_touched_by_an_override,
       count(*) FILTER (WHERE f.refreshed >= c.t)                  AS rollup_rebuilt_since,
       count(*) FILTER (WHERE f.refreshed <  c.t)                  AS stale_showing_preaudit_pills,
       count(*) FILTER (WHERE f.refreshed IS NULL)                 AS no_rollup_row
  FROM affected a
  CROSS JOIN cutoff c
  LEFT JOIN freshness f ON f.official_id = a.official_id;

-- Rollup freshness histogram — a FULL backfill stamps every row with now(), so
-- more than one distinct day here is itself proof that only the incremental ran.
SELECT 'C2 rollup freshness histogram' AS check,
       date_trunc('day', updated_at) AS day,
       count(*)                      AS rows,
       count(DISTINCT official_id)   AS officials
  FROM public.official_sector_affinity_rollup
 GROUP BY 2
 ORDER BY 2 DESC;

-- ---------------------------------------------------------------------------
-- C3 — override fidelity. Every non-NULL override donor carries EXACTLY ONE
-- industry tag and it is the curated one; every NULL override donor carries
-- NONE. Expect 380 / 0 / 0 / 362 / 0.
-- ---------------------------------------------------------------------------
WITH ov AS (
  SELECT o.fec_committee_id, o.industry, fe.id AS entity_id
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe
      ON fe.fec_committee_id = o.fec_committee_id
),
tags AS (
  SELECT ov.fec_committee_id,
         ov.industry                       AS want,
         count(et.tag)                     AS n_tags,
         min(et.tag)                       AS got
    FROM ov
    LEFT JOIN public.entity_tags et
           ON et.entity_type  = 'financial_entity'
          AND et.tag_category = 'industry'
          AND et.entity_id    = ov.entity_id
   GROUP BY ov.fec_committee_id, ov.industry
)
SELECT 'C3 override fidelity' AS check,
       count(*) FILTER (WHERE want IS NOT NULL AND n_tags = 1 AND got = want) AS reassigned_ok,
       count(*) FILTER (WHERE want IS NOT NULL AND n_tags <> 1)               AS reassigned_wrong_count,
       count(*) FILTER (WHERE want IS NOT NULL AND n_tags = 1 AND got <> want) AS reassigned_wrong_tag,
       count(*) FILTER (WHERE want IS NULL AND n_tags = 0)                    AS detagged_ok,
       count(*) FILTER (WHERE want IS NULL AND n_tags > 0)                    AS detagged_leaked
  FROM tags;

-- Any C3 offender, named.
WITH ov AS (
  SELECT o.fec_committee_id, o.industry, o.display_name_at_audit, fe.id AS entity_id
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe
      ON fe.fec_committee_id = o.fec_committee_id
)
SELECT 'C3 offenders (expect 0 rows)' AS check,
       ov.fec_committee_id,
       ov.display_name_at_audit,
       ov.industry                             AS want,
       string_agg(et.tag || '/' || et.generated_by, ', ' ORDER BY et.tag) AS got
  FROM ov
  LEFT JOIN public.entity_tags et
         ON et.entity_type  = 'financial_entity'
        AND et.tag_category = 'industry'
        AND et.entity_id    = ov.entity_id
 GROUP BY ov.fec_committee_id, ov.display_name_at_audit, ov.industry
HAVING (ov.industry IS NOT NULL AND (count(et.tag) <> 1 OR min(et.tag) IS DISTINCT FROM ov.industry))
    OR (ov.industry IS NULL     AND count(et.tag) > 0)
 ORDER BY 2
 LIMIT 40;

-- ---------------------------------------------------------------------------
-- C4 — dollar conservation. Re-bucketing donors between industries moves money
-- BETWEEN buckets; it must not create or destroy any.
--
-- THE AUTHORITATIVE CHECK IS C4-live BELOW: the rollup against the LIVE
-- donation ledger. Run it after any full backfill.
--
-- The cheaper C4-proxy that follows compares the rollup against
-- official_donor_totals (FIX-836) — two materializations of the same flow
-- maintained by different code paths. That comparison is ONLY meaningful when
-- the two tables are EQUALLY FRESH, and this is exactly how it misled once:
-- before the 2026-07-29 backfill both were stale in the same way and agreed to
-- the cent (487,148,409,800), which read as conservation. After the backfill
-- the rollup was current and official_donor_totals was not (its own oldest row
-- dated 2026-07-15 — it has the same dirty-set limitation), so the proxy showed
-- a $107.9M "loss" that was purely the OTHER table's staleness. The live check
-- returned an exact match at 497,940,464,700 both sides.
--
-- Keep the proxy as a cheap smoke test; trust C4-live when they disagree.
-- ---------------------------------------------------------------------------
SELECT 'C4-live conservation (AUTHORITATIVE)' AS check,
       (SELECT COALESCE(sum(total_cents), 0)
          FROM public.official_sector_affinity_rollup)  AS rollup_cents,
       (SELECT COALESCE(sum(fr.amount_cents), 0)
          FROM public.financial_relationships fr
         WHERE fr.relationship_type = 'donation'
           AND fr.from_type = 'financial_entity'
           AND fr.to_type   = 'official'
           AND fr.amount_cents > 0
           AND fr.to_id IN (SELECT official_id FROM public.official_donor_totals))
                                                       AS live_cents;

SELECT 'C4 freshness of BOTH materializations' AS check,
       (SELECT min(updated_at) FROM public.official_sector_affinity_rollup) AS rollup_oldest,
       (SELECT max(updated_at) FROM public.official_sector_affinity_rollup) AS rollup_newest,
       (SELECT min(updated_at) FROM public.official_donor_totals)           AS donor_totals_oldest,
       (SELECT max(updated_at) FROM public.official_donor_totals)           AS donor_totals_newest;

SELECT 'C4-proxy (valid only at equal freshness)' AS check,
       (SELECT COALESCE(sum(total_cents), 0)
          FROM public.official_sector_affinity_rollup)  AS rollup_cents,
       (SELECT COALESCE(sum(total_cents), 0)
          FROM public.official_donor_totals)            AS donor_totals_cents,
       (SELECT COALESCE(sum(total_cents), 0)
          FROM public.official_sector_affinity_rollup)
       - (SELECT COALESCE(sum(total_cents), 0)
            FROM public.official_donor_totals)          AS delta_cents,
       (SELECT count(*) FROM public.official_sector_affinity_rollup) AS rollup_rows,
       (SELECT count(*) FROM public.official_donor_totals)           AS donor_total_rows;

-- The exact size of the two scope predicates that separate the tables above, so
-- a non-zero C4 delta can be attributed rather than guessed at. Bounded to the
-- non-donation-shaped tail, so it is an index-scoped read, not a full scan.
SELECT 'C4 scope-difference accounting' AS check,
       COALESCE(sum(fr.amount_cents) FILTER (WHERE fr.from_type <> 'financial_entity'), 0)
         AS non_fe_donor_cents,
       COALESCE(sum(fr.amount_cents) FILTER (WHERE fr.amount_cents <= 0), 0)
         AS non_positive_cents,
       count(*) FILTER (WHERE fr.from_type <> 'financial_entity' OR fr.amount_cents <= 0)
         AS excluded_rows
  FROM public.financial_relationships fr
 WHERE fr.relationship_type = 'donation'
   AND fr.to_type = 'official'
   AND (fr.from_type <> 'financial_entity' OR fr.amount_cents <= 0);

-- ---------------------------------------------------------------------------
-- C5 — the four keys FIX-908/916 added must actually carry rows on BOTH the
-- donor side (entity_tags) and the official side (the rollup). A key that
-- exists in the vocabulary but nowhere in the data means the override pass
-- never landed.
-- ---------------------------------------------------------------------------
SELECT 'C5 new keys — donor side' AS check,
       et.tag,
       count(*)                                    AS donors,
       count(*) FILTER (WHERE et.generated_by = 'rule') AS via_rule
  FROM public.entity_tags et
 WHERE et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
   AND et.tag IN ('utilities', 'manufacturing', 'mining', 'media')
 GROUP BY et.tag
 ORDER BY et.tag;

SELECT 'C5 new keys — official side' AS check,
       r.industry,
       count(DISTINCT r.official_id) AS officials,
       sum(r.total_cents)            AS cents
  FROM public.official_sector_affinity_rollup r
 WHERE r.industry IN ('utilities', 'manufacturing', 'mining', 'media')
 GROUP BY r.industry
 ORDER BY r.industry;

-- ---------------------------------------------------------------------------
-- C6 — the out-of-vocabulary census that FIX-920 is about. Any industry value
-- in the rollup that is NOT in VALID_INDUSTRIES (and is not the 'Untagged'
-- sentinel) can reach assertIndustryVocabulary() and halt tagOfficials().
-- Reported at rank<=3 because that is the only band tagOfficials() reads.
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT r.official_id,
         r.industry,
         r.total_cents,
         row_number() OVER (PARTITION BY r.official_id
                            ORDER BY r.total_cents DESC, r.industry) AS rank
    FROM public.official_sector_affinity_rollup r
    JOIN public.officials o ON o.id = r.official_id
   WHERE o.is_active
     AND r.industry <> 'Untagged'
     AND r.total_cents > 0
)
SELECT 'C6 out-of-vocab in rollup' AS check,
       industry,
       count(*) FILTER (WHERE rank <= 3) AS rows_at_rank_le_3,
       count(*)                          AS rows_any_rank
  FROM ranked
 WHERE industry <> ALL (ARRAY['health','oil_gas','finance','tech','defense',
                              'real_estate','labor','agriculture','legal',
                              'retail','transportation','lobby','utilities',
                              'manufacturing','mining','media'])
 GROUP BY industry
 ORDER BY 3 DESC;

-- The 8 `other` rows FIX-920/911 deletes, named.
SELECT 'C6 donor-side `other` rows' AS check,
       fe.display_name,
       fe.fec_committee_id,
       et.generated_by,
       et.confidence,
       fe.total_donated_cents
  FROM public.entity_tags et
  JOIN public.financial_entities fe ON fe.id = et.entity_id
 WHERE et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
   AND et.tag          = 'other'
 ORDER BY fe.total_donated_cents DESC NULLS LAST;
