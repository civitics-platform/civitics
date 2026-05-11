-- 20260510000006_backfill_donor_fingerprint_v2.sql
-- FIX-239 Layer 1 + FIX-244. Backfill the existing individual-donor rows to
-- the canonical fingerprint shape (see 20260510000005). Investigation §5.2.
--
-- One-shot migration in a single transaction. Estimated wall-time at 930K
-- local indiv rows: 1-3 min. Pro (~540K rows): 30-90s. If anything looks
-- off, PITR rolls back (Pro has 7-day continuous PITR).
--
-- Execution sequence (so the donor_fingerprint UNIQUE constraint never trips
-- mid-transaction):
--   1. _fp_calc       — per-row {old_fp, new_fp} for every individual entity.
--   2. _merge_plan    — group rows by new_fp; pick winner per cluster.
--   3. _donor_remap   — flat loser_id -> winner_id mapping for the merged
--                       clusters (cluster_size > 1).
--   4. relationships  — set-based DELETE + INSERT to remap from_id losers
--                       into winners, summing amount/tx_count and merging
--                       metadata. Avoids the relcycle UNIQUE collision risk
--                       (investigation §6 risk 2).
--   5. entities       — merge totals/display_name/metadata into each winner.
--   6. delete losers  — donor_fingerprint UNIQUE is now collision-free at
--                       the winner-set; losers vacate the surface.
--   7. fp rewrite     — UPDATE donor_fingerprint + canonical_name on the
--                       surviving rows whose new_fp differs from old_fp.

DO $$
DECLARE
  t0                timestamptz := clock_timestamp();
  t_step            timestamptz;
  individual_rows   bigint;
  merge_clusters    bigint;
  losers_count      bigint;
  rels_replaced     bigint;
  rels_inserted     bigint;
  entities_merged   bigint;
  fp_rewritten      bigint;
BEGIN
  RAISE NOTICE '[FIX-239] Starting donor_fingerprint backfill at %', t0;

  -- ── 1. _fp_calc ──────────────────────────────────────────────────────────
  t_step := clock_timestamp();
  CREATE TEMP TABLE _fp_calc ON COMMIT DROP AS
  SELECT
    id,
    donor_fingerprint AS old_fp,
    public.canonical_donor_fingerprint(display_name, metadata->>'zip5') AS new_fp,
    total_donated_cents,
    total_received_cents,
    metadata,
    display_name,
    created_at
  FROM public.financial_entities
  WHERE entity_type = 'individual';

  CREATE INDEX _fp_calc_new_fp ON _fp_calc(new_fp);
  CREATE INDEX _fp_calc_id     ON _fp_calc(id);

  SELECT count(*) INTO individual_rows FROM _fp_calc;
  RAISE NOTICE '[FIX-239] step 1 (_fp_calc): % rows in % ms',
    individual_rows,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 2. _merge_plan ──────────────────────────────────────────────────────
  t_step := clock_timestamp();
  CREATE TEMP TABLE _merge_plan ON COMMIT DROP AS
  SELECT
    new_fp,
    (array_agg(id ORDER BY total_donated_cents DESC NULLS LAST, created_at ASC))[1] AS winner_id,
    array_agg(id ORDER BY total_donated_cents DESC NULLS LAST, created_at ASC)      AS all_ids,
    count(*)                                                                          AS cluster_size
  FROM _fp_calc
  WHERE new_fp IS NOT NULL AND new_fp <> ''
  GROUP BY new_fp;

  CREATE INDEX _merge_plan_winner ON _merge_plan(winner_id);

  SELECT count(*) INTO merge_clusters FROM _merge_plan WHERE cluster_size > 1;
  RAISE NOTICE '[FIX-239] step 2 (_merge_plan): % multi-row clusters in % ms',
    merge_clusters,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 3. _donor_remap ─────────────────────────────────────────────────────
  t_step := clock_timestamp();
  CREATE TEMP TABLE _donor_remap ON COMMIT DROP AS
  SELECT unnest(all_ids[2:array_length(all_ids, 1)]) AS loser_id,
         winner_id
  FROM _merge_plan
  WHERE cluster_size > 1;

  CREATE INDEX _donor_remap_loser  ON _donor_remap(loser_id);
  CREATE INDEX _donor_remap_winner ON _donor_remap(winner_id);

  SELECT count(*) INTO losers_count FROM _donor_remap;
  RAISE NOTICE '[FIX-239] step 3 (_donor_remap): % losers in % ms',
    losers_count,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 4. Relationship merge (set-based DELETE + INSERT) ───────────────────
  -- Identify every relationship row whose from_id is either a loser (must be
  -- redirected) or a winner of a merged cluster (may have to absorb a
  -- redirected sibling). Aggregate by the post-redirect arbiter so any
  -- (winner, to_id, cycle_year, type) collision merges into a single row.
  --
  -- Metadata: keep the highest-amount source row's metadata as the base, then
  -- overlay an aggregated tx_count summed across the cluster — preserves the
  -- writer.ts convention without losing the bundled count signal.
  t_step := clock_timestamp();

  CREATE TEMP TABLE _merged_relationships ON COMMIT DROP AS
  WITH affected_from_ids AS (
    SELECT loser_id  AS from_id FROM _donor_remap
    UNION
    SELECT winner_id AS from_id FROM _donor_remap
  ),
  redirected AS (
    SELECT
      fr.relationship_type,
      fr.from_type,
      COALESCE(dr.winner_id, fr.from_id)                AS new_from_id,
      fr.to_type,
      fr.to_id,
      fr.cycle_year,
      fr.amount_cents,
      fr.occurred_at,
      fr.started_at,
      fr.ended_at,
      fr.is_in_kind,
      fr.is_bundled,
      fr.source_url,
      COALESCE(fr.metadata, '{}'::jsonb)                AS metadata,
      COALESCE((fr.metadata->>'tx_count')::int, 0)      AS tx_count
    FROM public.financial_relationships fr
    JOIN affected_from_ids af ON af.from_id = fr.from_id
    LEFT JOIN _donor_remap dr ON dr.loser_id = fr.from_id
  )
  SELECT
    relationship_type,
    from_type,
    new_from_id                                                    AS from_id,
    to_type,
    to_id,
    cycle_year,
    sum(amount_cents)::bigint                                      AS amount_cents,
    max(occurred_at)                                               AS occurred_at,
    -- started_at/ended_at: donor rows always set occurred_at and leave
    -- started_at/ended_at NULL (per the CHECK constraint), so a max() across
    -- the cluster preserves NULL.
    max(started_at)                                                AS started_at,
    max(ended_at)                                                  AS ended_at,
    bool_or(is_in_kind)                                            AS is_in_kind,
    bool_or(is_bundled)                                            AS is_bundled,
    (array_agg(source_url ORDER BY amount_cents DESC NULLS LAST))[1] AS source_url,
    -- metadata: highest-amount row's metadata, then overlay tx_count = sum.
    (array_agg(metadata    ORDER BY amount_cents DESC NULLS LAST))[1]
      || jsonb_build_object('tx_count', sum(tx_count))             AS metadata
  FROM redirected
  GROUP BY relationship_type, from_type, new_from_id, to_type, to_id, cycle_year;

  SELECT count(*) INTO rels_inserted FROM _merged_relationships;

  DELETE FROM public.financial_relationships fr
  WHERE fr.from_id IN (SELECT loser_id  FROM _donor_remap)
     OR fr.from_id IN (SELECT winner_id FROM _donor_remap);
  GET DIAGNOSTICS rels_replaced = ROW_COUNT;

  INSERT INTO public.financial_relationships (
    relationship_type, from_type, from_id, to_type, to_id,
    cycle_year, amount_cents,
    occurred_at, started_at, ended_at,
    is_in_kind, is_bundled,
    source_url, metadata
  )
  SELECT
    relationship_type, from_type, from_id, to_type, to_id,
    cycle_year, amount_cents,
    occurred_at, started_at, ended_at,
    is_in_kind, is_bundled,
    source_url, metadata
  FROM _merged_relationships;

  RAISE NOTICE '[FIX-239] step 4 (relationships): % deleted, % inserted in % ms',
    rels_replaced, rels_inserted,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 5. Entity merge: roll loser totals + best metadata into the winner ──
  t_step := clock_timestamp();
  WITH cluster_agg AS (
    SELECT
      mp.winner_id,
      sum(fc.total_donated_cents)::bigint                                              AS total_donated_cents,
      sum(fc.total_received_cents)::bigint                                             AS total_received_cents,
      (array_agg(fc.display_name ORDER BY length(fc.display_name) DESC NULLS LAST))[1] AS best_display_name,
      (array_agg(fc.metadata     ORDER BY fc.total_donated_cents DESC NULLS LAST))[1]  AS best_metadata
    FROM _merge_plan mp
    JOIN _fp_calc fc ON fc.new_fp = mp.new_fp
    WHERE mp.cluster_size > 1
    GROUP BY mp.winner_id
  )
  UPDATE public.financial_entities fe
  SET total_donated_cents  = ca.total_donated_cents,
      total_received_cents = ca.total_received_cents,
      display_name         = ca.best_display_name,
      metadata             = ca.best_metadata
  FROM cluster_agg ca
  WHERE fe.id = ca.winner_id;
  GET DIAGNOSTICS entities_merged = ROW_COUNT;

  RAISE NOTICE '[FIX-239] step 5 (entity merge): % winners updated in % ms',
    entities_merged,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 6. Delete losers ────────────────────────────────────────────────────
  t_step := clock_timestamp();
  DELETE FROM public.financial_entities
  WHERE id IN (SELECT loser_id FROM _donor_remap);
  GET DIAGNOSTICS losers_count = ROW_COUNT;

  RAISE NOTICE '[FIX-239] step 6 (delete losers): % rows in % ms',
    losers_count,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 7. Rewrite donor_fingerprint + canonical_name on survivors ──────────
  -- After steps 5-6 the surviving rows are 1:1 with new_fp (cluster merges
  -- guaranteed it). BUT the UNIQUE index still trips during a single-pass
  -- UPDATE when new_fp[A] equals old_fp[B] for rows A, B in *different*
  -- clusters — Postgres checks uniqueness row-by-row, so if A is processed
  -- before B, A's target value collides with B's not-yet-updated old value.
  -- Concrete local hit: `MURROW JIMMIE L MR PH D|65807` (MR stripped)
  -- collides with `MURROW JIMMIE L PH D|65807` (PH.D. → PHD → noise → drop).
  --
  -- Two-pass rewrite: null out all changing rows first (UNIQUE permits
  -- multiple NULLs under default NULL-distinct semantics), then set to the
  -- new value. After the null pass nobody holds the conflicting values so
  -- the repopulate pass cannot collide.
  t_step := clock_timestamp();

  UPDATE public.financial_entities fe
  SET donor_fingerprint = NULL
  FROM _fp_calc fc
  WHERE fe.id = fc.id
    AND fc.new_fp IS NOT NULL
    AND fc.new_fp <> ''
    AND fe.donor_fingerprint IS DISTINCT FROM fc.new_fp;
  GET DIAGNOSTICS fp_rewritten = ROW_COUNT;

  UPDATE public.financial_entities fe
  SET donor_fingerprint = fc.new_fp,
      canonical_name    = split_part(fc.new_fp, '|', 1)
  FROM _fp_calc fc
  WHERE fe.id = fc.id
    AND fc.new_fp IS NOT NULL
    AND fc.new_fp <> ''
    AND fe.donor_fingerprint IS NULL
    AND fe.entity_type = 'individual';

  RAISE NOTICE '[FIX-239] step 7 (fp rewrite, two-pass): % rows in % ms',
    fp_rewritten,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  RAISE NOTICE '[FIX-239] DONE in % ms total. individuals=% clusters_merged=% losers=% rels_replaced=% rels_inserted=% entities_merged=% fp_rewritten=%',
    extract(milliseconds FROM clock_timestamp() - t0)::int,
    individual_rows, merge_clusters, losers_count,
    rels_replaced, rels_inserted, entities_merged, fp_rewritten;
END $$;

-- Refresh planner stats after a large data-shape change.
ANALYZE public.financial_entities;
ANALYZE public.financial_relationships;
