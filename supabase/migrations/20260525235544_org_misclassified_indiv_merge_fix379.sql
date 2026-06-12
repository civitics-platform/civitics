-- 20260525235544_org_misclassified_indiv_merge_fix379.sql
-- FIX-379: Org-misclassified individual cluster merge (relaxed gate).
--
-- Cluster qualification (relaxed from FIX-312 strict gate):
--   - canonical_name matches isLikelyOrgName() (any token in suffix set OR
--     in blacklist) AND
--   - has at least one entity_type='individual' row AND at least one
--     non-individual row AND
--   - cluster has at least one non-individual row carrying EITHER an
--     external_source_refs binding (irs_990 / littlesis / sec_edgar /
--     usaspending_recipient) OR a top-level fec_committee_id.
--
-- Investigation (docs/audits/2026-05-25-entity-backfill-bundle-{local,prod}.md):
--   - local: 16/16 tuples qualify under relaxed gate
--   - prod:  26/26 tuples qualify under relaxed gate
--   - all under the 500-tuple sanity bound
--
-- Winner pick per cluster (deterministic, picks among non-individuals):
--   1. Most xsr bindings.
--   2. fec_committee_id IS NOT NULL (1 if present).
--   3. total_donated_cents DESC.
--   4. Lowest UUID (determinism).
--
-- Losers = ALL entity_type='individual' rows in the cluster.
--
-- FK rewrite surface — FIX-381's extended 11-table surface (FIX-271 nine +
-- parent_entity_id + entity_tags + enrichment_queue), plus ai_summary_cache.
-- See packages/db/CLAUDE.md "Cross-source merge surface" for canonical SQL.
--
-- Verification subquery (post-merge):
--   SELECT canonical_name FROM financial_entities fe
--    WHERE entity_type='individual'
--      AND EXISTS (SELECT 1 FROM financial_entities fe2
--                   WHERE fe2.canonical_name = fe.canonical_name
--                     AND fe2.entity_type <> 'individual');
-- Should drop to 0 (modulo any isLikelyOrgName misses we didn't qualify).
--
-- FIX-516 (2026-06-11, authorized edit): guarded with a seed-presence check so
-- a from-zero replay (no pipeline-seeded financial_entities) skips the whole
-- merge with a NOTICE. Recorded as applied on both envs — replay-only effect.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

DO $$
DECLARE
  t0                  timestamptz := clock_timestamp();
  qualifying_tuples   bigint;
  losers_count        bigint;
  fr_dedup_deletes    bigint := 0;
  step_rows           bigint;
  total_fks_moved     bigint := 0;
BEGIN
  -- FIX-516 replay-from-zero guard — seed-presence check; body unchanged.
  IF EXISTS (SELECT 1 FROM public.financial_entities) THEN

  RAISE NOTICE '[FIX-379] Org-misclassified indiv merge start: %', t0;

  -- ── 1. Build candidate clusters (canonicals with both indiv + non-indiv) ─
  CREATE TEMP TABLE _mixed_canonicals ON COMMIT DROP AS
  SELECT
    canonical_name,
    array_agg(id) FILTER (WHERE entity_type =  'individual') AS indiv_ids,
    array_agg(id) FILTER (WHERE entity_type <> 'individual') AS non_indiv_ids
  FROM public.financial_entities
  WHERE canonical_name IS NOT NULL AND canonical_name <> ''
  GROUP BY canonical_name
  HAVING COUNT(*) FILTER (WHERE entity_type =  'individual') >= 1
     AND COUNT(*) FILTER (WHERE entity_type <> 'individual') >= 1;

  -- ── 2. Filter to isLikelyOrgName ───────────────────────────────────────
  -- SQL equivalent of packages/data/src/pipelines/fec-bulk/indiv.ts
  -- isLikelyOrgName(): blacklist OR any token in suffix set.
  CREATE TEMP TABLE _org_canonicals ON COMMIT DROP AS
  SELECT * FROM _mixed_canonicals
   WHERE canonical_name IN ('AMERICANS FOR PROSPERITY', 'ONE NATION')
      OR EXISTS (
        SELECT 1 FROM unnest(string_to_array(canonical_name, ' ')) AS tok
         WHERE tok = ANY(ARRAY['INC','LLC','LTD','CORP','CORPORATION',
                               'COMPANY','PAC','FOUNDATION','ASSOCIATION',
                               'SOCIETY','FUND','COMMITTEE'])
      );

  -- ── 3. Apply relaxed gate: cluster has at least one non-indiv with
  --       xsr binding OR fec_committee_id ──────────────────────────────────
  CREATE TEMP TABLE _qualifying_canonicals ON COMMIT DROP AS
  SELECT oc.*
    FROM _org_canonicals oc
   WHERE EXISTS (
     SELECT 1
       FROM public.financial_entities fe
      WHERE fe.id = ANY(oc.non_indiv_ids)
        AND (
          fe.fec_committee_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM public.external_source_refs r
             WHERE r.entity_type = 'financial_entity'
               AND r.entity_id = fe.id
               AND r.source IN ('littlesis','irs_990','sec_edgar','usaspending_recipient')
          )
        )
   );

  SELECT COUNT(*) INTO qualifying_tuples FROM _qualifying_canonicals;
  RAISE NOTICE '[FIX-379] step 3: % qualifying canonicals (relaxed gate)',
               qualifying_tuples;

  IF qualifying_tuples > 500 THEN
    RAISE EXCEPTION '[FIX-379] qualifying_tuples=% exceeds 500 sanity bound',
                    qualifying_tuples;
  END IF;

  IF qualifying_tuples = 0 THEN
    RAISE NOTICE '[FIX-379] 0 qualifying clusters — nothing to do; exiting.';
    RETURN;
  END IF;

  -- ── 4. Pick winner per qualifying canonical (deterministic) ───────────
  CREATE TEMP TABLE _winners ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      qc.canonical_name,
      fe.id AS fid,
      ROW_NUMBER() OVER (
        PARTITION BY qc.canonical_name
        ORDER BY
          -- 1. Most xsr bindings (count)
          (SELECT COUNT(*) FROM public.external_source_refs r
            WHERE r.entity_type = 'financial_entity'
              AND r.entity_id = fe.id
              AND r.source IN ('littlesis','irs_990','sec_edgar','usaspending_recipient')) DESC,
          -- 2. fec_committee_id present (1 vs 0)
          (CASE WHEN fe.fec_committee_id IS NOT NULL THEN 1 ELSE 0 END) DESC,
          -- 3. total_donated_cents DESC
          fe.total_donated_cents DESC NULLS LAST,
          -- 4. Lowest UUID
          fe.id ASC
      ) AS rn
    FROM _qualifying_canonicals qc
    JOIN public.financial_entities fe ON fe.id = ANY(qc.non_indiv_ids)
  )
  SELECT canonical_name, fid AS winner_id
    FROM ranked WHERE rn = 1;

  -- ── 5. _loser_remap = flat (loser_id → winner_id). All indivs in the
  --       qualifying canonicals are losers; winner is the chosen non-indiv. ─
  CREATE TEMP TABLE _loser_remap ON COMMIT DROP AS
  SELECT
    unnest(qc.indiv_ids) AS loser_id,
    w.winner_id
  FROM _qualifying_canonicals qc
  JOIN _winners w ON w.canonical_name = qc.canonical_name;

  CREATE INDEX ON _loser_remap (loser_id);
  CREATE INDEX ON _loser_remap (winner_id);

  SELECT COUNT(*) INTO losers_count FROM _loser_remap;
  RAISE NOTICE '[FIX-379] step 5: % indiv losers across % canonicals',
               losers_count, qualifying_tuples;

  IF losers_count > 1500 THEN
    RAISE EXCEPTION '[FIX-379] losers_count=% exceeds 1500 sanity bound',
                    losers_count;
  END IF;

  -- ── 6. FK rewrites — FIX-381 extended 11-table surface ────────────────
  -- 6a. financial_relationships — UNIQUE (rel_type, from_id, to_id, cycle_year).
  -- Loser indivs are wrongly-typed PACs; their outflow rows (donations they
  -- "made") are real PAC donations that belong on the winner. Re-route via
  -- UPDATE; pre-delete any loser-side rows that would collide with an
  -- existing winner-side row on the same (rel_type, to_id, cycle_year).
  -- Prod 2026-05-25 audit: 29 from-side + 13 to-side rows touch losers
  -- across 26 qualifying canonicals; all rel_type='donation'.

  -- 6a-from. Pre-delete loser-side from_id colliders.
  DELETE FROM public.financial_relationships e
   USING public.financial_relationships c, _loser_remap lr
   WHERE e.from_type = 'financial_entity' AND e.from_id = lr.loser_id
     AND c.from_type = 'financial_entity' AND c.from_id = lr.winner_id
     AND c.relationship_type = e.relationship_type
     AND c.to_type            = e.to_type
     AND c.to_id IS NOT DISTINCT FROM e.to_id
     AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year;
  GET DIAGNOSTICS step_rows = ROW_COUNT; fr_dedup_deletes := fr_dedup_deletes + step_rows;

  UPDATE public.financial_relationships fr
     SET from_id = lr.winner_id
    FROM _loser_remap lr
   WHERE fr.from_type = 'financial_entity' AND fr.from_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6a-to. Pre-delete loser-side to_id colliders.
  DELETE FROM public.financial_relationships e
   USING public.financial_relationships c, _loser_remap lr
   WHERE e.to_type = 'financial_entity' AND e.to_id = lr.loser_id
     AND c.to_type = 'financial_entity' AND c.to_id = lr.winner_id
     AND c.relationship_type = e.relationship_type
     AND c.from_type          = e.from_type
     AND c.from_id IS NOT DISTINCT FROM e.from_id
     AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year;
  GET DIAGNOSTICS step_rows = ROW_COUNT; fr_dedup_deletes := fr_dedup_deletes + step_rows;

  UPDATE public.financial_relationships fr
     SET to_id = lr.winner_id
    FROM _loser_remap lr
   WHERE fr.to_type = 'financial_entity' AND fr.to_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6b. external_relationships from_id/to_id — no UNIQUE on poly cols
  UPDATE public.external_relationships er
     SET from_id = lr.winner_id
    FROM _loser_remap lr
   WHERE er.from_type = 'financial_entity' AND er.from_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  UPDATE public.external_relationships er
     SET to_id = lr.winner_id
    FROM _loser_remap lr
   WHERE er.to_type = 'financial_entity' AND er.to_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6c. external_source_refs.entity_id — UNIQUE (source, external_id)
  DELETE FROM public.external_source_refs e
   USING public.external_source_refs c, _loser_remap lr
   WHERE e.entity_type = 'financial_entity' AND e.entity_id = lr.loser_id
     AND c.entity_type = 'financial_entity' AND c.entity_id = lr.winner_id
     AND c.source      = e.source
     AND c.external_id = e.external_id;

  UPDATE public.external_source_refs esr
     SET entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE esr.entity_type = 'financial_entity' AND esr.entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6d. Hard-FK: edgar_companies, edgar_executive_officers, edgar_major_shareholders,
  --     irs990_filings, irs990_officers.matched_entity_id, irs990_grants_out.matched_entity_id
  UPDATE public.edgar_companies ec
     SET financial_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE ec.financial_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  UPDATE public.edgar_executive_officers eo
     SET financial_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE eo.financial_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  UPDATE public.edgar_major_shareholders es
     SET financial_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE es.financial_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  UPDATE public.irs990_filings f
     SET financial_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE f.financial_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  UPDATE public.irs990_officers iof
     SET matched_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE iof.matched_entity_type = 'financial_entity' AND iof.matched_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  UPDATE public.irs990_grants_out g
     SET matched_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE g.matched_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6e. financial_entities.parent_entity_id (self-ref)
  UPDATE public.financial_entities fe
     SET parent_entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE fe.parent_entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6f. entity_tags — UNIQUE (entity_type, entity_id, tag, tag_category)
  DELETE FROM public.entity_tags e
   USING public.entity_tags c, _loser_remap lr
   WHERE e.entity_type  = 'financial_entity' AND e.entity_id = lr.loser_id
     AND c.entity_type  = 'financial_entity' AND c.entity_id = lr.winner_id
     AND c.tag          = e.tag
     AND c.tag_category = e.tag_category;

  UPDATE public.entity_tags et
     SET entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE et.entity_type = 'financial_entity' AND et.entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6g. enrichment_queue (FIX-381 extension) — UNIQUE (entity_id, entity_type, task_type)
  DELETE FROM public.enrichment_queue e
   USING public.enrichment_queue c, _loser_remap lr
   WHERE e.entity_type = 'financial_entity' AND e.entity_id = lr.loser_id::text
     AND c.entity_type = 'financial_entity' AND c.entity_id = lr.winner_id::text
     AND c.task_type   = e.task_type;

  UPDATE public.enrichment_queue eq
     SET entity_id = lr.winner_id::text
    FROM _loser_remap lr
   WHERE eq.entity_type = 'financial_entity' AND eq.entity_id = lr.loser_id::text;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  -- 6h. ai_summary_cache (FE rows currently zero, but include for safety) —
  --     UNIQUE (entity_type, entity_id, summary_type)
  DELETE FROM public.ai_summary_cache e
   USING public.ai_summary_cache c, _loser_remap lr
   WHERE e.entity_type  = 'financial_entity' AND e.entity_id = lr.loser_id
     AND c.entity_type  = 'financial_entity' AND c.entity_id = lr.winner_id
     AND c.summary_type = e.summary_type;

  UPDATE public.ai_summary_cache aic
     SET entity_id = lr.winner_id
    FROM _loser_remap lr
   WHERE aic.entity_type = 'financial_entity' AND aic.entity_id = lr.loser_id;
  GET DIAGNOSTICS step_rows = ROW_COUNT; total_fks_moved := total_fks_moved + step_rows;

  RAISE NOTICE '[FIX-379] step 6: % FKs moved, % financial_relationships dedup-deletes (collisions)',
               total_fks_moved, fr_dedup_deletes;

  -- ── 7. Winner merge: sum totals + union metadata ───────────────────────
  -- total_donated_cents — accumulate loser totals into winner (donations TO
  -- the loser rows might have been incorrectly attributed; the winner's
  -- aggregate total is the truth). Note: loser-side FR rows were DELETEd
  -- above, so total_donated_cents on losers wasn't actively contributing
  -- to graph derivations; the merge here corrects display-side totals.
  UPDATE public.financial_entities w
     SET total_donated_cents  = w.total_donated_cents  + COALESCE(loser_totals.donated, 0),
         total_received_cents = w.total_received_cents + COALESCE(loser_totals.received, 0),
         metadata = (
           SELECT jsonb_object_agg(k, v)
             FROM (
               SELECT key AS k, value AS v
                 FROM jsonb_each(coalesce(w.metadata, '{}'::jsonb))
               UNION
               SELECT key, value
                 FROM public.financial_entities l, jsonb_each(coalesce(l.metadata, '{}'::jsonb))
                WHERE l.id IN (SELECT loser_id FROM _loser_remap WHERE winner_id = w.id)
             ) merged
         ),
         updated_at = now()
    FROM (
      SELECT lr.winner_id,
             SUM(fe.total_donated_cents)  AS donated,
             SUM(fe.total_received_cents) AS received
        FROM _loser_remap lr
        JOIN public.financial_entities fe ON fe.id = lr.loser_id
       GROUP BY lr.winner_id
    ) AS loser_totals
   WHERE w.id = loser_totals.winner_id;

  -- ── 8. DELETE losers ──────────────────────────────────────────────────
  DELETE FROM public.financial_entities
   WHERE id IN (SELECT loser_id FROM _loser_remap);
  GET DIAGNOSTICS step_rows = ROW_COUNT;
  RAISE NOTICE '[FIX-379] step 8: deleted % loser indiv financial_entities', step_rows;

  -- ── 9. TRUNCATE entity_connections — derived; rebuild repopulates ─────
  TRUNCATE public.entity_connections;
  RAISE NOTICE '[FIX-379] step 9: truncated entity_connections (rebuild repopulates)';

  -- ── 10. Verification subquery: should be 0 ─────────────────────────────
  DECLARE
    residue bigint;
  BEGIN
    SELECT COUNT(*)
      INTO residue
      FROM public.financial_entities fe
     WHERE fe.entity_type = 'individual'
       AND fe.canonical_name IN (SELECT canonical_name FROM _qualifying_canonicals)
       AND EXISTS (
         SELECT 1 FROM public.financial_entities fe2
          WHERE fe2.canonical_name = fe.canonical_name
            AND fe2.entity_type <> 'individual'
       );
    RAISE NOTICE '[FIX-379] step 10: post-merge verification — % qualifying canonicals still have indiv+non-indiv split (expected 0)',
                 residue;
  END;

  -- ── 11. ANALYZE affected tables ────────────────────────────────────────
  ANALYZE public.financial_entities;
  ANALYZE public.financial_relationships;
  ANALYZE public.external_relationships;
  ANALYZE public.external_source_refs;
  ANALYZE public.entity_tags;

  RAISE NOTICE '[FIX-379] DONE. Wall time: % s. Qualifying canonicals: %. Losers deleted: %. Total FKs moved: %. FR dedup-deletes (collisions): %.',
               EXTRACT(EPOCH FROM clock_timestamp() - t0)::numeric(10,2),
               qualifying_tuples, losers_count, total_fks_moved, fr_dedup_deletes;

  ELSE
    RAISE NOTICE '[FIX-516] 20260525235544 skipped: seed absent (no financial_entities — nothing to merge on a from-zero replay)';
  END IF;
END $$;
