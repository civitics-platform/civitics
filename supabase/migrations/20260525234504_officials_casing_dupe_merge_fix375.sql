-- 20260525234504_officials_casing_dupe_merge_fix375.sql
-- FIX-375: Merge officials casing-dupe clusters identified by FIX-325
-- investigation (docs/audits/2026-05-25-officials-casing-dupes.md).
--
-- Cluster scope (lower(trim(full_name)) > 1 active row):
--   - prod baseline: 1,967 clusters / 4,466 rows
--   - local baseline: 1,829 clusters / 4,108 rows
--
-- Carve-outs (NOT merged):
--   1. Mixed elected+candidate tiers → the FIX-248 promote_candidate_to_elected
--      path handles those specifically.
--   2. Pure FEC cross-cycle clusters → all rows have source_ids consisting of
--      only fec_candidate_id AND each row has a distinct fec_candidate_id
--      value. Different cycle IDs per cycle is the FEC norm, not a bug.
--
-- Merge gates (cluster qualifies if at least one matches):
--   (a) Two or more rows in the cluster share a source_ids[key] = value pair
--       (strong same-person signal: e.g. matching congress_gov bioguide IDs).
--   (c) All rows share jurisdiction_id (non-NULL) AND all role_titles
--       normalize to the same family ("Candidate for X" → "X").
--   (b) external_relationships neighborhood overlap — SKIPPED this pass per
--       FIX-375 bullet ("too expensive for first pass; SKIP unless cheap").
--
-- Winner pick per cluster (deterministic):
--   1. Most external_source_refs bindings.
--   2. Longest first_name || last_name (richer detail preserved).
--   3. Lowest UUID (deterministic tiebreak).
--
-- Sanity bounds — abort transaction with descriptive error if exceeded:
--   - qualifying_clusters > 500
--   - losers_count        > 1500
--
-- FK rewrite surface — mirrors FIX-248 Block C
-- (supabase/migrations/20260525051720_executive_seed_and_delegate_jurisdictions.sql)
-- extended with the FIX-381 entity_tags / enrichment_queue / ai_summary_cache
-- additions (see packages/db/CLAUDE.md "Cross-source merge surface").

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

DO $$
DECLARE
  t0                  timestamptz := clock_timestamp();
  total_clusters      bigint;
  mixed_tier_clusters bigint;
  pure_fec_clusters   bigint;
  candidate_clusters  bigint;
  qualifying_clusters bigint;
  losers_count        bigint;
  fr_dedup_deletes    bigint := 0;
  step_rows           bigint;
  total_fks_moved     bigint := 0;
BEGIN
  RAISE NOTICE '[FIX-375] Officials casing-dupe merge start: %', t0;

  -- ── 1. Raw clusters ────────────────────────────────────────────────────
  CREATE TEMP TABLE _all_clusters ON COMMIT DROP AS
  SELECT
    lower(trim(full_name))                              AS cluster_key,
    array_agg(id ORDER BY created_at ASC)               AS all_ids,
    array_agg(DISTINCT COALESCE(tier, '<null>'))        AS tiers,
    COUNT(*)::bigint                                    AS n
  FROM public.officials
  WHERE is_active = true
  GROUP BY 1
  HAVING COUNT(*) > 1;

  SELECT COUNT(*) INTO total_clusters FROM _all_clusters;
  RAISE NOTICE '[FIX-375] step 1: % raw casing-dupe clusters', total_clusters;

  -- ── 2. Carve out mixed elected+candidate clusters ──────────────────────
  CREATE TEMP TABLE _mixed_tier_clusters ON COMMIT DROP AS
  SELECT cluster_key FROM _all_clusters
   WHERE 'elected' = ANY(tiers) AND 'candidate' = ANY(tiers);

  SELECT COUNT(*) INTO mixed_tier_clusters FROM _mixed_tier_clusters;
  RAISE NOTICE '[FIX-375] step 2: % mixed elected+candidate clusters (carved out)',
               mixed_tier_clusters;

  -- ── 3. Carve out pure FEC cross-cycle clusters ─────────────────────────
  -- "Pure FEC cross-cycle" = every row in the cluster has source_ids with
  -- exactly one key ('fec_candidate_id') AND all fec_candidate_id values
  -- across the cluster are distinct.
  CREATE TEMP TABLE _pure_fec_clusters ON COMMIT DROP AS
  SELECT c.cluster_key
    FROM _all_clusters c
   WHERE c.cluster_key NOT IN (SELECT cluster_key FROM _mixed_tier_clusters)
     AND (
       SELECT bool_and(
         o.source_ids IS NOT NULL
         AND o.source_ids ? 'fec_candidate_id'
         AND (SELECT COUNT(*) FROM jsonb_object_keys(o.source_ids)) = 1
       )
       FROM public.officials o
       WHERE o.id = ANY(c.all_ids)
     )
     AND (
       SELECT COUNT(DISTINCT o.source_ids->>'fec_candidate_id') = c.n
       FROM public.officials o
       WHERE o.id = ANY(c.all_ids)
     );

  SELECT COUNT(*) INTO pure_fec_clusters FROM _pure_fec_clusters;
  RAISE NOTICE '[FIX-375] step 3: % pure FEC cross-cycle clusters (carved out)',
               pure_fec_clusters;

  -- ── 4. Candidate clusters ──────────────────────────────────────────────
  CREATE TEMP TABLE _candidate_clusters ON COMMIT DROP AS
  SELECT * FROM _all_clusters
   WHERE cluster_key NOT IN (SELECT cluster_key FROM _mixed_tier_clusters)
     AND cluster_key NOT IN (SELECT cluster_key FROM _pure_fec_clusters);

  SELECT COUNT(*) INTO candidate_clusters FROM _candidate_clusters;
  RAISE NOTICE '[FIX-375] step 4: % candidate clusters after carve-outs',
               candidate_clusters;

  -- ── 5. Gate (a) shared source_ids[key]=value pair ──────────────────────
  CREATE TEMP TABLE _gate_a_clusters ON COMMIT DROP AS
  SELECT DISTINCT cc.cluster_key
    FROM _candidate_clusters cc
   WHERE EXISTS (
     SELECT 1 FROM (
       SELECT o.id, k, o.source_ids->>k AS v
         FROM public.officials o,
              LATERAL jsonb_object_keys(coalesce(o.source_ids, '{}'::jsonb)) AS k
        WHERE o.id = ANY(cc.all_ids)
          AND o.source_ids->>k IS NOT NULL
     ) flat
     GROUP BY k, v
     HAVING COUNT(DISTINCT id) > 1
   );

  -- ── 6. Gate (c) matching jurisdiction + role family ────────────────────
  -- Role family normalization: strip "Candidate for " prefix so
  -- "Candidate for Senator" and "Senator" normalize to the same family.
  CREATE TEMP TABLE _gate_c_clusters ON COMMIT DROP AS
  SELECT cc.cluster_key
    FROM _candidate_clusters cc
   WHERE (
     SELECT COUNT(DISTINCT o.jurisdiction_id) = 1
        AND COUNT(*) FILTER (WHERE o.jurisdiction_id IS NULL) = 0
        AND COUNT(DISTINCT lower(regexp_replace(
              coalesce(o.role_title, ''),
              '^Candidate for ', ''))) = 1
       FROM public.officials o
      WHERE o.id = ANY(cc.all_ids)
   );

  -- ── 7. Qualifying clusters = gate (a) ∪ gate (c) ───────────────────────
  CREATE TEMP TABLE _qualifying_clusters ON COMMIT DROP AS
  SELECT * FROM _candidate_clusters
   WHERE cluster_key IN (SELECT cluster_key FROM _gate_a_clusters)
      OR cluster_key IN (SELECT cluster_key FROM _gate_c_clusters);

  SELECT COUNT(*) INTO qualifying_clusters FROM _qualifying_clusters;
  RAISE NOTICE '[FIX-375] step 7: % qualifying clusters (gate a OR gate c)',
               qualifying_clusters;

  IF qualifying_clusters > 500 THEN
    RAISE EXCEPTION '[FIX-375] qualifying_clusters=% exceeds 500 sanity bound — re-run with explicit authorization or tighten gates',
                    qualifying_clusters;
  END IF;

  -- ── 8. Build _merge_plan (winner pick per cluster) ─────────────────────
  CREATE TEMP TABLE _merge_plan ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      qc.cluster_key,
      o.id AS oid,
      ROW_NUMBER() OVER (
        PARTITION BY qc.cluster_key
        ORDER BY
          (SELECT COUNT(*) FROM public.external_source_refs r
            WHERE r.entity_type='official' AND r.entity_id = o.id) DESC,
          length(coalesce(o.first_name, '') || coalesce(o.last_name, '')) DESC,
          o.id ASC
      ) AS rn
    FROM _qualifying_clusters qc
    JOIN public.officials o ON o.id = ANY(qc.all_ids)
  ),
  winners AS (SELECT cluster_key, oid AS winner_id FROM ranked WHERE rn = 1),
  losers  AS (SELECT cluster_key, oid AS loser_id  FROM ranked WHERE rn > 1)
  SELECT w.cluster_key, w.winner_id, l.loser_id
    FROM winners w
    JOIN losers  l USING (cluster_key);

  SELECT COUNT(*) INTO losers_count FROM _merge_plan;
  RAISE NOTICE '[FIX-375] step 8: merge plan has % loser rows across % clusters',
               losers_count, qualifying_clusters;

  IF losers_count > 1500 THEN
    RAISE EXCEPTION '[FIX-375] losers_count=% exceeds 1500 sanity bound — re-run with explicit authorization',
                    losers_count;
  END IF;

  -- _loser_remap = flat (loser_id → winner_id)
  CREATE TEMP TABLE _loser_remap ON COMMIT DROP AS
  SELECT loser_id, winner_id FROM _merge_plan;
  CREATE INDEX ON _loser_remap (loser_id);
  CREATE INDEX ON _loser_remap (winner_id);

  -- ── 9. Declared-FK rewrites (with UNIQUE-collision pre-deletes) ────────
  -- 9a. votes — UNIQUE (roll_call_id, official_id) (post-cutover schema)
  DELETE FROM public.votes e
   USING public.votes c, _loser_remap lr
   WHERE e.official_id = lr.loser_id
     AND c.official_id = lr.winner_id
     AND c.roll_call_id = e.roll_call_id;

  UPDATE public.votes v
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE v.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9b. proposal_cosponsors — UNIQUE (proposal_id, official_id)
  DELETE FROM public.proposal_cosponsors e
   USING public.proposal_cosponsors c, _loser_remap lr
   WHERE e.official_id = lr.loser_id
     AND c.official_id = lr.winner_id
     AND c.proposal_id = e.proposal_id;

  UPDATE public.proposal_cosponsors pc
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE pc.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9c. proposal_actions.performed_by_id — no UNIQUE on performed_by_id
  UPDATE public.proposal_actions pa
     SET performed_by_id = lr.winner_id
    FROM _loser_remap lr
   WHERE pa.performed_by_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9d. bill_details.primary_sponsor_id — no UNIQUE on primary_sponsor_id
  UPDATE public.bill_details bd
     SET primary_sponsor_id = lr.winner_id
    FROM _loser_remap lr
   WHERE bd.primary_sponsor_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9e. official_committee_memberships — UNIQUE (official_id, committee_id, COALESCE(started_at, '0001-01-01'))
  DELETE FROM public.official_committee_memberships e
   USING public.official_committee_memberships c, _loser_remap lr
   WHERE e.official_id = lr.loser_id
     AND c.official_id = lr.winner_id
     AND c.committee_id = e.committee_id
     AND COALESCE(c.started_at, '0001-01-01'::date)
         IS NOT DISTINCT FROM COALESCE(e.started_at, '0001-01-01'::date);

  UPDATE public.official_committee_memberships ocm
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE ocm.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9f. promises.official_id — no UNIQUE (promise records are 1:N)
  UPDATE public.promises p
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE p.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9g. civic_initiative_responses — UNIQUE(initiative_id, official_id)
  DELETE FROM public.civic_initiative_responses e
   USING public.civic_initiative_responses c, _loser_remap lr
   WHERE e.official_id = lr.loser_id
     AND c.official_id = lr.winner_id
     AND c.initiative_id = e.initiative_id;

  UPDATE public.civic_initiative_responses cir
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE cir.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9h. official_community_comments — no UNIQUE (1:N)
  UPDATE public.official_community_comments occ
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE occ.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9i. lobbying_disclosures — no UNIQUE on official_id
  UPDATE public.lobbying_disclosures ld
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE ld.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 9j. career_history — no UNIQUE on official_id (1:N positions)
  UPDATE public.career_history ch
     SET official_id = lr.winner_id
    FROM _loser_remap lr
   WHERE ch.official_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- ── 10. Polymorphic FK rewrites ────────────────────────────────────────
  -- 10a. financial_relationships — UNIQUE (rel_type, from_id, to_id, cycle_year)
  DELETE FROM public.financial_relationships e
   USING public.financial_relationships c, _loser_remap lr
   WHERE e.from_type = 'official' AND e.from_id = lr.loser_id
     AND c.relationship_type = e.relationship_type
     AND c.from_id            = lr.winner_id
     AND c.from_type          = e.from_type
     AND c.to_type            = e.to_type
     AND c.to_id IS NOT DISTINCT FROM e.to_id
     AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year;
  GET DIAGNOSTICS step_rows = ROW_COUNT; fr_dedup_deletes := fr_dedup_deletes + step_rows;

  UPDATE public.financial_relationships fr
     SET from_id = lr.winner_id
    FROM _loser_remap lr
   WHERE fr.from_type = 'official' AND fr.from_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  DELETE FROM public.financial_relationships e
   USING public.financial_relationships c, _loser_remap lr
   WHERE e.to_type = 'official' AND e.to_id = lr.loser_id
     AND c.relationship_type = e.relationship_type
     AND c.from_id IS NOT DISTINCT FROM e.from_id
     AND c.from_type          = e.from_type
     AND c.to_type            = e.to_type
     AND c.to_id              = lr.winner_id
     AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year;
  GET DIAGNOSTICS step_rows = ROW_COUNT; fr_dedup_deletes := fr_dedup_deletes + step_rows;

  UPDATE public.financial_relationships fr
     SET to_id = lr.winner_id
    FROM _loser_remap lr
   WHERE fr.to_type = 'official' AND fr.to_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 10b. external_relationships from_id/to_id — no UNIQUE on poly cols
  UPDATE public.external_relationships er
     SET from_id = lr.winner_id
    FROM _loser_remap lr
   WHERE er.from_type = 'official' AND er.from_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  UPDATE public.external_relationships er
     SET to_id = lr.winner_id
    FROM _loser_remap lr
   WHERE er.to_type = 'official' AND er.to_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 10c. external_source_refs.entity_id — UNIQUE (source, external_id)
  DELETE FROM public.external_source_refs e
   USING public.external_source_refs c, _loser_remap lr
   WHERE e.entity_type = 'official' AND e.entity_id = lr.loser_id
     AND c.entity_type = 'official' AND c.entity_id = lr.winner_id
     AND c.source      = e.source
     AND c.external_id = e.external_id;

  UPDATE public.external_source_refs esr
     SET entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE esr.entity_type = 'official' AND esr.entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 10d. irs990_officers.matched_entity_id — UNIQUE (filing_id, name_canonical, role_title)
  -- on matched_entity_id collision the loser's row dropped; winner's stays.
  -- The constraint isn't on matched_entity_id directly, so no collision risk
  -- on the matched_entity_id update itself.
  UPDATE public.irs990_officers iof
     SET matched_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE iof.matched_entity_type = 'official' AND iof.matched_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 10e. entity_tags — UNIQUE (entity_type, entity_id, tag, tag_category)
  DELETE FROM public.entity_tags e
   USING public.entity_tags c, _loser_remap lr
   WHERE e.entity_type  = 'official' AND e.entity_id = lr.loser_id
     AND c.entity_type  = 'official' AND c.entity_id = lr.winner_id
     AND c.tag          = e.tag
     AND c.tag_category = e.tag_category;

  UPDATE public.entity_tags et
     SET entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE et.entity_type = 'official' AND et.entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 10f. enrichment_queue (FIX-381 extension) — UNIQUE (entity_id, entity_type, task_type)
  -- entity_id is TEXT; cast UUIDs.
  DELETE FROM public.enrichment_queue e
   USING public.enrichment_queue c, _loser_remap lr
   WHERE e.entity_type = 'official' AND e.entity_id = lr.loser_id::text
     AND c.entity_type = 'official' AND c.entity_id = lr.winner_id::text
     AND c.task_type   = e.task_type;

  UPDATE public.enrichment_queue eq
     SET entity_id = lr.winner_id::text
    FROM _loser_remap lr
   WHERE eq.entity_type = 'official' AND eq.entity_id = lr.loser_id::text;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 10g. ai_summary_cache — UNIQUE (entity_type, entity_id, summary_type)
  DELETE FROM public.ai_summary_cache e
   USING public.ai_summary_cache c, _loser_remap lr
   WHERE e.entity_type  = 'official' AND e.entity_id = lr.loser_id
     AND c.entity_type  = 'official' AND c.entity_id = lr.winner_id
     AND c.summary_type = e.summary_type;

  UPDATE public.ai_summary_cache aic
     SET entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE aic.entity_type = 'official' AND aic.entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  RAISE NOTICE '[FIX-375] step 10: % FKs moved, % financial_relationships dedup-deletes',
               total_fks_moved, fr_dedup_deletes;

  -- ── 11. Winner merge: union source_ids + metadata across cluster ───────
  UPDATE public.officials w
     SET source_ids = (
       SELECT jsonb_object_agg(k, v)
         FROM (
           SELECT key AS k, value AS v
             FROM jsonb_each(coalesce(w.source_ids, '{}'::jsonb))
           UNION
           SELECT key, value
             FROM public.officials l, jsonb_each(coalesce(l.source_ids, '{}'::jsonb))
            WHERE l.id IN (SELECT loser_id FROM _loser_remap WHERE winner_id = w.id)
         ) merged
     ),
     metadata = (
       SELECT jsonb_object_agg(k, v)
         FROM (
           SELECT key AS k, value AS v
             FROM jsonb_each(coalesce(w.metadata, '{}'::jsonb))
           UNION
           SELECT key, value
             FROM public.officials l, jsonb_each(coalesce(l.metadata, '{}'::jsonb))
            WHERE l.id IN (SELECT loser_id FROM _loser_remap WHERE winner_id = w.id)
         ) merged
     ),
     updated_at = now()
   WHERE w.id IN (SELECT winner_id FROM _loser_remap);

  -- ── 12. DELETE losers ──────────────────────────────────────────────────
  DELETE FROM public.officials
   WHERE id IN (SELECT loser_id FROM _loser_remap);
  GET DIAGNOSTICS step_rows = ROW_COUNT;
  RAISE NOTICE '[FIX-375] step 12: deleted % loser officials', step_rows;

  -- ── 13. TRUNCATE entity_connections — derived; rebuild repopulates ─────
  TRUNCATE public.entity_connections;
  RAISE NOTICE '[FIX-375] step 13: truncated entity_connections (rebuild repopulates)';

  -- ── 14. ANALYZE affected tables ────────────────────────────────────────
  ANALYZE public.officials;
  ANALYZE public.votes;
  ANALYZE public.financial_relationships;
  ANALYZE public.external_relationships;
  ANALYZE public.external_source_refs;
  ANALYZE public.entity_tags;

  RAISE NOTICE '[FIX-375] DONE. Wall time: % s. Qualifying clusters: %. Losers deleted: %. Total FKs moved: %.',
               EXTRACT(EPOCH FROM clock_timestamp() - t0)::numeric(10,2),
               qualifying_clusters, losers_count, total_fks_moved;
END $$;
