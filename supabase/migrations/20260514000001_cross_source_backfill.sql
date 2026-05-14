-- 20260514000001_cross_source_backfill.sql
-- FIX-271 — One-shot destructive backfill that merges cross-source duplicate
-- financial_entities rows. Foundation for Strategy D from
-- docs/CROSS_SOURCE_RESOLUTION_INVESTIGATION.md §5.4.
--
-- Pattern is identical to FIX-239 Layer 1 (20260510000006). Single transaction;
-- statement_timeout disabled so the DO block runs uninterrupted on Pro.
--
-- Merge plan — two scopes, picked conservatively per investigation §5.4:
--
--   Individuals (single-FEC clusters only):
--     For each canonical_name where entity_type='individual':
--       count(*) FILTER (donor_fingerprint IS NOT NULL) = 1
--       count(*) FILTER (donor_fingerprint IS NULL)     >= 1
--     The single FEC row wins (preserves donor_fingerprint UNIQUE per §7.2).
--     All non-FEC sibling rows merge into it.
--     Multi-FEC-row clusters (multi-ZIP fragmentation) are deferred to
--     FIX-239 Layer 2; not touched here.
--
--   Organizations (non-FEC-PAC clusters with at least one external binding):
--     For each canonical_name where entity_type<>'individual'
--                                AND fec_committee_id IS NULL (FEC PACs stay
--                                    distinct via fec_committee_id UNIQUE):
--       count(*) >= 2
--       count(*) FILTER (has binding in external_source_refs for any of
--                        littlesis | irs_990 | sec_edgar |
--                        usaspending_recipient) >= 1
--     Winner = row with most non-FEC bindings;
--     tiebreak by total_donated_cents DESC, then created_at ASC.
--
-- Execution sequence (so the relcycle UNIQUE on financial_relationships and
-- the (source, external_id) UNIQUE on external_source_refs never trip):
--
--   1. _indiv_merge   — temp table: winner_id + loser_ids per qualifying
--                       individual canonical.
--   2. _org_merge     — temp table: winner_id + loser_ids per qualifying
--                       org canonical.
--   3. _loser_remap   — flat (loser_id -> winner_id) UNION of indiv + org.
--   4. financial_relationships rewrite — set-based DELETE+INSERT covering
--      ANY row with from_id or to_id in the loser-or-winner set. Aggregates
--      by (type, new_from_id, to_type, new_to_id, cycle_year), summing
--      amount/tx_count, taking max temporal fields, preserving the
--      highest-amount source's metadata + URL. Avoids
--      financial_relationships_relcycle_unique collisions
--      (investigation §6 risk 3).
--   5. external_relationships rewrite — straight UPDATEs (UNIQUE there is
--      (source, source_id), not the polymorphic from/to tuple, so collisions
--      cannot happen).
--   6. external_source_refs.entity_id — straight UPDATE. UNIQUE (source,
--      external_id) cannot collide because each external_id can only point
--      at one entity_id by definition.
--   7. Hard-FK rewrites — edgar_companies / edgar_executive_officers /
--      edgar_major_shareholders / irs990_filings / irs990_officers /
--      irs990_grants_out / financial_entities.parent_entity_id.
--   8. Entity merge — sum total_donated_cents + total_received_cents into
--      winner; pick longest display_name; pick best metadata jsonb.
--   9. DELETE losers — donor_fingerprint UNIQUE stays clean (we never
--      touched FEC indiv winners' fingerprints).
--  10. TRUNCATE entity_connections — derived table; FIX-263's
--      rebuild_entity_connections_*() chunks repopulate it post-migration.
--  11. ANALYZE the affected tables so the planner picks up the new shape.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

DO $$
DECLARE
  t0                timestamptz := clock_timestamp();
  t_step            timestamptz;
  indiv_clusters    bigint;
  org_clusters      bigint;
  losers_count      bigint;
  fr_deleted        bigint;
  fr_inserted       bigint;
  ext_rel_updated   bigint;
  ext_src_updated   bigint;
  hard_fk_updated   bigint;
  entities_merged   bigint;
  losers_deleted    bigint;
BEGIN
  RAISE NOTICE '[FIX-271] Cross-source backfill start: %', t0;

  -- ── 1. _indiv_merge ─────────────────────────────────────────────────────
  -- Single-FEC + >=1 non-FEC indiv canonicals. Winner = the FEC row.
  t_step := clock_timestamp();
  CREATE TEMP TABLE _indiv_merge ON COMMIT DROP AS
  WITH per_canonical AS (
    SELECT
      canonical_name,
      array_agg(id ORDER BY (donor_fingerprint IS NOT NULL) DESC,
                            total_donated_cents DESC NULLS LAST,
                            created_at ASC)                                AS all_ids,
      array_agg(id) FILTER (WHERE donor_fingerprint IS NOT NULL)           AS fec_ids,
      array_agg(id) FILTER (WHERE donor_fingerprint IS NULL)               AS non_fec_ids
    FROM public.financial_entities
    WHERE entity_type = 'individual'
    GROUP BY canonical_name
  )
  SELECT
    canonical_name,
    fec_ids[1]                                  AS winner_id,
    non_fec_ids                                 AS loser_ids
  FROM per_canonical
  WHERE coalesce(array_length(fec_ids, 1), 0)     = 1
    AND coalesce(array_length(non_fec_ids, 1), 0) >= 1;

  CREATE INDEX _indiv_merge_winner ON _indiv_merge(winner_id);

  SELECT count(*) INTO indiv_clusters FROM _indiv_merge;
  RAISE NOTICE '[FIX-271] step 1 (_indiv_merge): % indiv clusters in % ms',
    indiv_clusters,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 2. _org_merge ───────────────────────────────────────────────────────
  -- Non-individual canonical clusters with >=2 mergeable rows
  -- (fec_committee_id IS NULL — FEC PACs stay distinct) and >=1 carries an
  -- external binding. Winner picked by binding count, tiebreak by total
  -- donated cents, tiebreak by created_at.
  t_step := clock_timestamp();
  CREATE TEMP TABLE _org_merge ON COMMIT DROP AS
  WITH mergeable AS (
    SELECT
      fe.id,
      fe.canonical_name,
      fe.total_donated_cents,
      fe.created_at,
      (SELECT count(*) FROM public.external_source_refs r
        WHERE r.entity_type = 'financial_entity'
          AND r.entity_id   = fe.id
          AND r.source IN ('littlesis','irs_990','sec_edgar','usaspending_recipient'))
            AS non_fec_binding_count
    FROM public.financial_entities fe
    WHERE fe.entity_type      <> 'individual'
      AND fe.fec_committee_id IS NULL
  ),
  per_canonical AS (
    SELECT
      canonical_name,
      array_agg(id ORDER BY non_fec_binding_count DESC,
                            total_donated_cents   DESC NULLS LAST,
                            created_at            ASC)                       AS all_ids,
      count(*)                                                                AS row_count,
      count(*) FILTER (WHERE non_fec_binding_count > 0)                       AS rows_with_binding
    FROM mergeable
    GROUP BY canonical_name
  )
  SELECT
    canonical_name,
    all_ids[1]                                              AS winner_id,
    all_ids[2:array_length(all_ids, 1)]                     AS loser_ids
  FROM per_canonical
  WHERE row_count        >= 2
    AND rows_with_binding >= 1;

  CREATE INDEX _org_merge_winner ON _org_merge(winner_id);

  SELECT count(*) INTO org_clusters FROM _org_merge;
  RAISE NOTICE '[FIX-271] step 2 (_org_merge): % org clusters in % ms',
    org_clusters,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 3. _loser_remap ─────────────────────────────────────────────────────
  -- Flat loser -> winner mapping. UNION of indiv + org. Each loser_id is
  -- unique (a row cannot be in two canonical clusters at once).
  t_step := clock_timestamp();
  CREATE TEMP TABLE _loser_remap ON COMMIT DROP AS
  SELECT unnest(loser_ids) AS loser_id, winner_id FROM _indiv_merge
  UNION ALL
  SELECT unnest(loser_ids) AS loser_id, winner_id FROM _org_merge;

  CREATE UNIQUE INDEX _loser_remap_loser ON _loser_remap(loser_id);
  CREATE INDEX        _loser_remap_winner ON _loser_remap(winner_id);

  SELECT count(*) INTO losers_count FROM _loser_remap;
  RAISE NOTICE '[FIX-271] step 3 (_loser_remap): % total losers in % ms',
    losers_count,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 4. financial_relationships rewrite ─────────────────────────────────
  -- Any row with from_id OR to_id in loser-or-winner set is in scope. After
  -- redirecting both sides through _loser_remap, aggregate by the
  -- post-redirect arbiter (rel_type, new_from, to_type, new_to, cycle_year)
  -- so any collisions between a loser's row and a winner's existing row
  -- merge into a single survivor.
  t_step := clock_timestamp();

  CREATE TEMP TABLE _fr_merged ON COMMIT DROP AS
  WITH affected_ids AS (
    SELECT loser_id  AS id FROM _loser_remap
    UNION
    SELECT winner_id AS id FROM _loser_remap
  ),
  scope AS (
    SELECT fr.*
    FROM public.financial_relationships fr
    WHERE (fr.from_type = 'financial_entity'
           AND EXISTS (SELECT 1 FROM affected_ids a WHERE a.id = fr.from_id))
       OR (fr.to_type   = 'financial_entity'
           AND EXISTS (SELECT 1 FROM affected_ids a WHERE a.id = fr.to_id))
  ),
  redirected AS (
    SELECT
      s.relationship_type,
      s.from_type,
      CASE WHEN s.from_type = 'financial_entity'
           THEN COALESCE(rl.winner_id, s.from_id)
           ELSE s.from_id END                                  AS new_from_id,
      s.to_type,
      CASE WHEN s.to_type = 'financial_entity'
           THEN COALESCE(rt.winner_id, s.to_id)
           ELSE s.to_id END                                    AS new_to_id,
      s.cycle_year,
      s.amount_cents,
      s.occurred_at,
      s.started_at,
      s.ended_at,
      s.is_in_kind,
      s.is_bundled,
      s.fec_filing_id,
      s.usaspending_award_id,
      s.disclosure_form_id,
      s.source_url,
      COALESCE(s.metadata, '{}'::jsonb)                        AS metadata,
      COALESCE((s.metadata->>'tx_count')::int, 0)              AS tx_count
    FROM scope s
    LEFT JOIN _loser_remap rl ON s.from_type = 'financial_entity' AND rl.loser_id = s.from_id
    LEFT JOIN _loser_remap rt ON s.to_type   = 'financial_entity' AND rt.loser_id = s.to_id
  )
  SELECT
    relationship_type,
    from_type,
    new_from_id                                                AS from_id,
    to_type,
    new_to_id                                                  AS to_id,
    cycle_year,
    sum(amount_cents)::bigint                                  AS amount_cents,
    max(occurred_at)                                           AS occurred_at,
    max(started_at)                                            AS started_at,
    max(ended_at)                                              AS ended_at,
    bool_or(is_in_kind)                                        AS is_in_kind,
    bool_or(is_bundled)                                        AS is_bundled,
    -- Per-source external IDs: keep the first non-null seen, ordered by
    -- amount (the largest contributor row is most likely the canonical one).
    -- Each of these has a partial UNIQUE so the post-aggregate set must not
    -- carry duplicates within a single (rel_type, from, to, cycle) bucket;
    -- since the source pipelines write distinct external_ids per cycle, this
    -- holds in practice (verified in FIX-239 Layer 1 backfill).
    (array_agg(fec_filing_id        ORDER BY amount_cents DESC NULLS LAST) FILTER (WHERE fec_filing_id        IS NOT NULL))[1] AS fec_filing_id,
    (array_agg(usaspending_award_id ORDER BY amount_cents DESC NULLS LAST) FILTER (WHERE usaspending_award_id IS NOT NULL))[1] AS usaspending_award_id,
    (array_agg(disclosure_form_id   ORDER BY amount_cents DESC NULLS LAST) FILTER (WHERE disclosure_form_id   IS NOT NULL))[1] AS disclosure_form_id,
    (array_agg(source_url           ORDER BY amount_cents DESC NULLS LAST))[1] AS source_url,
    (array_agg(metadata             ORDER BY amount_cents DESC NULLS LAST))[1]
      || jsonb_build_object('tx_count', sum(tx_count))         AS metadata
  FROM redirected
  GROUP BY relationship_type, from_type, new_from_id, to_type, new_to_id, cycle_year;

  SELECT count(*) INTO fr_inserted FROM _fr_merged;

  -- Delete the originals (covers both sides — any row in scope, by the same
  -- predicate as the CTE above).
  DELETE FROM public.financial_relationships fr
  USING (
    SELECT loser_id AS id FROM _loser_remap
    UNION
    SELECT winner_id AS id FROM _loser_remap
  ) ai
  WHERE (fr.from_type = 'financial_entity' AND fr.from_id = ai.id)
     OR (fr.to_type   = 'financial_entity' AND fr.to_id   = ai.id);
  GET DIAGNOSTICS fr_deleted = ROW_COUNT;

  -- Re-insert the aggregated rows.
  INSERT INTO public.financial_relationships (
    relationship_type, from_type, from_id, to_type, to_id,
    cycle_year, amount_cents,
    occurred_at, started_at, ended_at,
    is_in_kind, is_bundled,
    fec_filing_id, usaspending_award_id, disclosure_form_id,
    source_url, metadata
  )
  SELECT
    relationship_type, from_type, from_id, to_type, to_id,
    cycle_year, amount_cents,
    occurred_at, started_at, ended_at,
    is_in_kind, is_bundled,
    fec_filing_id, usaspending_award_id, disclosure_form_id,
    source_url, metadata
  FROM _fr_merged;

  RAISE NOTICE '[FIX-271] step 4 (financial_relationships): % deleted, % inserted in % ms',
    fr_deleted, fr_inserted,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 5. external_relationships rewrite ──────────────────────────────────
  -- Straight UPDATE on both sides. UNIQUE here is (source, source_id) — each
  -- LittleSis edge has its own source_id, so post-rewrite collisions on the
  -- polymorphic from/to tuple are not constraint violations.
  t_step := clock_timestamp();

  UPDATE public.external_relationships er
  SET from_id = rl.winner_id
  FROM _loser_remap rl
  WHERE er.from_type = 'financial_entity'
    AND er.from_id   = rl.loser_id;
  GET DIAGNOSTICS ext_rel_updated = ROW_COUNT;

  UPDATE public.external_relationships er
  SET to_id = rl.winner_id
  FROM _loser_remap rl
  WHERE er.to_type = 'financial_entity'
    AND er.to_id   = rl.loser_id;

  RAISE NOTICE '[FIX-271] step 5 (external_relationships): % from-side updates (+to-side update) in % ms',
    ext_rel_updated,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 6. external_source_refs.entity_id ──────────────────────────────────
  -- Straight UPDATE. UNIQUE (source, external_id) cannot collide because
  -- each external_id is bound to exactly one entity_id by construction.
  t_step := clock_timestamp();

  UPDATE public.external_source_refs r
  SET entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE r.entity_type = 'financial_entity'
    AND r.entity_id   = rl.loser_id;
  GET DIAGNOSTICS ext_src_updated = ROW_COUNT;

  RAISE NOTICE '[FIX-271] step 6 (external_source_refs): % rows in % ms',
    ext_src_updated,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 7. Hard-FK rewrites ────────────────────────────────────────────────
  -- All other columns that point at financial_entities.id (declared FKs +
  -- polymorphic columns on the IRS 990 sidecars). Straight UPDATEs.
  t_step := clock_timestamp();

  UPDATE public.edgar_companies ec
  SET financial_entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE ec.financial_entity_id = rl.loser_id;
  GET DIAGNOSTICS hard_fk_updated = ROW_COUNT;

  UPDATE public.edgar_executive_officers eo
  SET financial_entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE eo.financial_entity_id = rl.loser_id;

  UPDATE public.edgar_major_shareholders es
  SET financial_entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE es.financial_entity_id = rl.loser_id;

  UPDATE public.irs990_filings f
  SET financial_entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE f.financial_entity_id = rl.loser_id;

  UPDATE public.irs990_officers o
  SET matched_entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE o.matched_entity_type = 'financial_entity'
    AND o.matched_entity_id   = rl.loser_id;

  UPDATE public.irs990_grants_out g
  SET matched_entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE g.matched_entity_type = 'financial_entity'
    AND g.matched_entity_id   = rl.loser_id;

  UPDATE public.financial_entities fe
  SET parent_entity_id = rl.winner_id
  FROM _loser_remap rl
  WHERE fe.parent_entity_id = rl.loser_id;

  RAISE NOTICE '[FIX-271] step 7 (hard FKs, sample edgar_companies = %): in % ms',
    hard_fk_updated,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 8. Entity merge — roll loser totals into winner ────────────────────
  -- Sum total_donated_cents + total_received_cents across each cluster.
  -- Pick the longest display_name (preserves the most-informative casing —
  -- e.g. "Elon Musk Revocable Trust" beats "ELON MUSK REVOCABLE TRUST" by
  -- one char... so favor longest; ties fall back to NULL-ordered).
  -- Pick the metadata jsonb of the highest-total row (preserves the
  -- numerically dominant source's profile fields).
  t_step := clock_timestamp();

  WITH cluster_agg AS (
    SELECT
      rl.winner_id,
      sum(fe.total_donated_cents)::bigint                                              AS total_donated_cents,
      sum(fe.total_received_cents)::bigint                                             AS total_received_cents,
      (array_agg(fe.display_name ORDER BY length(fe.display_name) DESC NULLS LAST))[1] AS best_display_name,
      (array_agg(fe.metadata     ORDER BY fe.total_donated_cents DESC NULLS LAST))[1]  AS best_metadata
    FROM _loser_remap rl
    JOIN public.financial_entities fe ON fe.id IN (rl.loser_id, rl.winner_id)
    GROUP BY rl.winner_id
  )
  UPDATE public.financial_entities fe
  SET total_donated_cents  = ca.total_donated_cents,
      total_received_cents = ca.total_received_cents,
      display_name         = COALESCE(ca.best_display_name, fe.display_name),
      metadata             = COALESCE(ca.best_metadata,     fe.metadata),
      updated_at           = now()
  FROM cluster_agg ca
  WHERE fe.id = ca.winner_id;
  GET DIAGNOSTICS entities_merged = ROW_COUNT;

  RAISE NOTICE '[FIX-271] step 8 (entity merge): % winners updated in % ms',
    entities_merged,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 9. DELETE losers ───────────────────────────────────────────────────
  t_step := clock_timestamp();

  DELETE FROM public.financial_entities
  WHERE id IN (SELECT loser_id FROM _loser_remap);
  GET DIAGNOSTICS losers_deleted = ROW_COUNT;

  RAISE NOTICE '[FIX-271] step 9 (delete losers): % rows in % ms',
    losers_deleted,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 10. TRUNCATE entity_connections ────────────────────────────────────
  -- Derived table; FIX-263's rebuild_entity_connections_*() chunks
  -- repopulate it from the merged source rows post-migration. Truncating
  -- here avoids serving stale edges that reference deleted UUIDs in the gap.
  t_step := clock_timestamp();
  TRUNCATE TABLE public.entity_connections;
  RAISE NOTICE '[FIX-271] step 10 (truncate entity_connections) in % ms',
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  RAISE NOTICE '[FIX-271] DONE in % ms total. indiv_clusters=% org_clusters=% losers=% fr_deleted=% fr_inserted=% ext_src_updated=% entities_merged=% losers_deleted=%',
    extract(milliseconds FROM clock_timestamp() - t0)::int,
    indiv_clusters, org_clusters, losers_count,
    fr_deleted, fr_inserted, ext_src_updated,
    entities_merged, losers_deleted;
END $$;

-- ── 11. Refresh planner stats on the affected tables ────────────────────
ANALYZE public.financial_entities;
ANALYZE public.financial_relationships;
ANALYZE public.external_relationships;
ANALYZE public.external_source_refs;
