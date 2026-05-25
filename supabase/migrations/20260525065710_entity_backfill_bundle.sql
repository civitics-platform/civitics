-- 20260525065710_entity_backfill_bundle.sql
-- Entity-backfill bundle — FIX-245 + FIX-320 ship; FIX-312 + FIX-313 deferred.
--
-- Investigation (docs/audits/2026-05-25-entity-backfill-bundle-{local,prod}.md):
--
--   FIX-312 — DEFERRED. 16 local / 26 prod (canonical, indiv, non-indiv)
--             tuples qualify, but most non-individual rows are FEC PACs whose
--             attestation is `fec_committee_id` rather than
--             `external_source_refs`. The prompt's strict gate requires every
--             tuple to carry an xsr binding; that does not hold here. Filed as
--             FIX-B follow-up to revisit with a relaxed gate that also
--             accepts a fec_committee_id binding. No block emitted in this
--             migration.
--
--   FIX-313 — DEFERRED. The public LittleSis entities dump
--             (https://littlesis.org/database/public_data/entities.json.gz)
--             has no `merged_into` shaped field — top-level keys observed
--             across 440,048 records are: aliases, blurb, end_date,
--             extensions, id, name, parent_id, primary_ext, start_date,
--             summary, tags, types, updated_at, website. Path (a) cannot
--             ship without that field; path (b) shared-edge heuristic was
--             always out of scope. Filed as FIX-A follow-up. No block
--             emitted; util.ts / matcher.ts left untouched.
--
--   FIX-245 — SHIPS. 1,457 local / 4,264 prod individual rows carry
--             space/backtick particle-prefix residue in donor_fingerprint
--             (`O `/`D `/`DE `/`ST `/`MC `). After FIX-245 ships in
--             [packages/data/src/pipelines/fec-bulk/indiv.ts], the SQL
--             function `public.canonical_donor_fingerprint` MUST stay in
--             sync (per the byte-for-byte invariant called out at
--             20260510000005's header), and the existing rows MUST be
--             rewritten — otherwise the next FEC indiv re-run would mint
--             fresh UUIDs under the new fingerprint shape and orphan the
--             old rows from new donation inflow.
--
--   FIX-320 — SHIPS path (a). 595 local / 170 prod orphan entity_tags rows
--             with `entity_type='financial_entity'`. Breakdown:
--             zero `generated_by='manual'` rows — every orphan is rule- or
--             AI-generated tag output that can be safely re-derived by the
--             next tag pipeline run. Bare DELETE is correct.
--
-- Three labeled blocks below:
--   Block A — FIX-245 SQL function update (CREATE OR REPLACE).
--   Block B — FIX-245 backfill: recompute fingerprints, merge collapsed
--             clusters, FK-rewrite + delete losers, two-pass fingerprint
--             rewrite. Mirrors 20260510000006 verbatim (same temp-table
--             shape, same FK surface — 9 tables per FIX-271 docs).
--   Block C — FIX-320 path (a) cleanup. Run AFTER Block B so any
--             newly-orphaned entity_tags from the FIX-245 loser-delete pass
--             are also cleaned. The FK surface beyond FIX-271's nine
--             (entity_tags, ai_summary_cache, enrichment_queue,
--             notifications, page_views, user_follows) is documented in
--             the post-commit report and filed as a follow-up; not folded
--             in here per the brief.
--
-- Same statement_timeout / idle_in_transaction conventions as
-- 20260510000006: disable both so the DO block runs uninterrupted on Pro.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

-- ═══════════════════════════════════════════════════════════════════════════
-- Block A — FIX-245 SQL function update.
--
-- Mirrors the TS change in [packages/data/src/pipelines/fec-bulk/indiv.ts]:
--   (1) Strip set extended from `['.]` → `[`'.]`  (backtick added).
--   (2) After the noise-token filter, if filtered[1] ∈ {O,D,DE,ST,MC} AND
--       filtered[2] matches `^[A-Z]+$`, fuse them into a single token.
--       Position-1 only (i.e. position 0 in 0-indexed terms) — matches the
--       narrow particle-joiner spec in the FIX-245 bullet.
--
-- The FEC pipeline's idempotency under `donor_fingerprint` UNIQUE depends on
-- TS output ≡ SQL output for every (name, zip5) pair (see 20260510000005's
-- header). Block B below uses this function for the backfill recompute.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.canonical_donor_fingerprint(
  raw_name TEXT,
  zip5     TEXT
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  cleaned   TEXT;
  tokens    TEXT[];
  filtered  TEXT[];
  tok       TEXT;
BEGIN
  IF raw_name IS NULL OR length(trim(raw_name)) = 0 THEN
    RETURN NULL;
  END IF;

  cleaned := upper(raw_name);

  -- FIX-244 + FIX-245: strip backtick, apostrophe, and period to EMPTY STRING.
  --   O'BRIEN -> OBRIEN ; O`BRIEN -> OBRIEN ; M.D. -> MD ; ST. CLAIR -> ST CLAIR
  cleaned := regexp_replace(cleaned, '[`''.]', '', 'g');

  cleaned := regexp_replace(cleaned, '[^A-Z0-9 ]', ' ', 'g');
  cleaned := regexp_replace(cleaned, '\s+', ' ', 'g');
  cleaned := trim(cleaned);

  IF cleaned = '' THEN
    RETURN NULL;
  END IF;

  tokens := string_to_array(cleaned, ' ');

  filtered := ARRAY[]::TEXT[];
  FOREACH tok IN ARRAY tokens LOOP
    IF tok NOT IN (
      'MR','MRS','MS','DR','MD','PHD','ESQ','REV','HON','CPA','CFP','JD','RN','DDS','DO','MBA'
    ) THEN
      filtered := array_append(filtered, tok);
    END IF;
  END LOOP;

  IF coalesce(array_length(filtered, 1), 0) = 0 THEN
    RETURN NULL;
  END IF;

  -- FIX-245: particle-join. Position-0 surname particle (`O`, `D`, `DE`,
  -- `ST`, `MC`) followed by an all-uppercase-ASCII token fuses into one
  -- token. Handles space/backtick FEC NAME residue that FIX-244 couldn't
  -- collapse via its apostrophe-strip alone (`O BRIEN MICHAEL` → `OBRIEN
  -- MICHAEL`; ``O`BRIEN HALLEY`` → already handled by backtick-strip above
  -- to `OBRIEN HALLEY`). Narrow by design — see indiv.ts header for why.
  IF coalesce(array_length(filtered, 1), 0) >= 2
     AND filtered[1] IN ('O','D','DE','ST','MC')
     AND filtered[2] ~ '^[A-Z]+$' THEN
    filtered := ARRAY[filtered[1] || filtered[2]]
                || COALESCE(filtered[3:array_length(filtered, 1)], ARRAY[]::TEXT[]);
  END IF;

  IF zip5 IS NULL OR length(trim(zip5)) = 0 THEN
    RETURN array_to_string(filtered, ' ');
  END IF;

  RETURN array_to_string(filtered, ' ') || '|' || trim(zip5);
END;
$$;

COMMENT ON FUNCTION public.canonical_donor_fingerprint(TEXT, TEXT) IS
  'FIX-239 Layer 1 + FIX-244 + FIX-245. Conservative donor fingerprint: uppercase, strip backtick/apostrophe/period to empty, strip other punctuation to whitespace, drop honorific noise tokens, preserve generational tokens (JR/SR/II-V) and middle initials, position-0 particle-join (O/D/DE/ST/MC + uppercase ASCII surname), append |zip5. Mirrors TS donorFingerprint() in packages/data/src/pipelines/fec-bulk/indiv.ts byte for byte — pipeline idempotency depends on the two staying in sync.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Block B — FIX-245 backfill.
--
-- Re-run the donor-fingerprint backfill against every individual row using
-- the just-updated SQL function. Pattern mirrors 20260510000006 (the FIX-244
-- backfill) verbatim:
--   1. _fp_calc       — per-row (id, old_fp, new_fp).
--   2. _merge_plan    — group by new_fp; pick winner per cluster.
--   3. _donor_remap   — flat loser_id -> winner_id mapping.
--   4. relationships  — set-based DELETE + INSERT, post-redirect aggregate.
--   5. entities       — roll loser totals + best metadata into winner.
--   6. delete losers  — donor_fingerprint UNIQUE stays clean.
--   7. fp two-pass    — null then set, dodges UNIQUE during partial updates.
--
-- Same FK rewrite as FIX-271 (financial_relationships, external_relationships,
-- external_source_refs, edgar_*, irs990_*, financial_entities.parent_entity_id).
-- Polymorphic surfaces beyond that nine (entity_tags / ai_summary_cache /
-- enrichment_queue / notifications / page_views / user_follows) are
-- documented as a follow-up — not folded in here per the brief.
--
-- Empirical: at 540K-620K individual rows the prior FIX-244 backfill ran
-- 30-90s on Pro and 1-3 min on local. The FIX-245 incremental should be
-- comparable; only a few thousand rows change fingerprint (the rest of the
-- recompute is a no-op `WHERE donor_fingerprint IS DISTINCT FROM new_fp`).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t0                timestamptz := clock_timestamp();
  t_step            timestamptz;
  individual_rows   bigint;
  merge_clusters    bigint;
  losers_count      bigint;
  rels_replaced     bigint;
  rels_inserted     bigint;
  ext_rel_updated   bigint;
  ext_src_updated   bigint;
  entities_merged   bigint;
  fp_rewritten      bigint;
BEGIN
  RAISE NOTICE '[FIX-245] Starting donor_fingerprint backfill at %', t0;

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
  RAISE NOTICE '[FIX-245] step 1 (_fp_calc): % rows in % ms',
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
  RAISE NOTICE '[FIX-245] step 2 (_merge_plan): % multi-row clusters in % ms',
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
  RAISE NOTICE '[FIX-245] step 3 (_donor_remap): % losers in % ms',
    losers_count,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 4. Relationship merge (set-based DELETE + INSERT) ───────────────────
  -- Same shape as 20260510000006 step 4. Aggregate by post-redirect arbiter
  -- so (winner, to_id, cycle_year, type) collisions merge into one row and
  -- the relcycle UNIQUE never trips.
  t_step := clock_timestamp();

  IF losers_count > 0 THEN
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
      max(started_at)                                                AS started_at,
      max(ended_at)                                                  AS ended_at,
      bool_or(is_in_kind)                                            AS is_in_kind,
      bool_or(is_bundled)                                            AS is_bundled,
      (array_agg(source_url ORDER BY amount_cents DESC NULLS LAST))[1] AS source_url,
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
  ELSE
    rels_replaced := 0;
    rels_inserted := 0;
  END IF;

  RAISE NOTICE '[FIX-245] step 4 (financial_relationships): % deleted, % inserted in % ms',
    rels_replaced, rels_inserted,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 4b. external_relationships rewrite (straight UPDATE per FIX-271) ────
  -- UNIQUE on (source, source_id) — no collision risk post-rewrite.
  t_step := clock_timestamp();

  IF losers_count > 0 THEN
    UPDATE public.external_relationships er
    SET from_id = rl.winner_id
    FROM _donor_remap rl
    WHERE er.from_type = 'financial_entity'
      AND er.from_id   = rl.loser_id;
    GET DIAGNOSTICS ext_rel_updated = ROW_COUNT;

    UPDATE public.external_relationships er
    SET to_id = rl.winner_id
    FROM _donor_remap rl
    WHERE er.to_type = 'financial_entity'
      AND er.to_id   = rl.loser_id;
  ELSE
    ext_rel_updated := 0;
  END IF;

  RAISE NOTICE '[FIX-245] step 4b (external_relationships): % from-side updates (+to-side) in % ms',
    ext_rel_updated,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 4c. external_source_refs.entity_id (straight UPDATE per FIX-271) ────
  t_step := clock_timestamp();

  IF losers_count > 0 THEN
    UPDATE public.external_source_refs r
    SET entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE r.entity_type = 'financial_entity'
      AND r.entity_id   = rl.loser_id;
    GET DIAGNOSTICS ext_src_updated = ROW_COUNT;
  ELSE
    ext_src_updated := 0;
  END IF;

  RAISE NOTICE '[FIX-245] step 4c (external_source_refs): % rows in % ms',
    ext_src_updated,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 4d. Hard-FK rewrites (FIX-271 surface; individual donors rarely hit
  -- these but keep parity with 20260510000006 for correctness). ───────────
  t_step := clock_timestamp();

  IF losers_count > 0 THEN
    UPDATE public.edgar_companies ec
    SET financial_entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE ec.financial_entity_id = rl.loser_id;

    UPDATE public.edgar_executive_officers eo
    SET financial_entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE eo.financial_entity_id = rl.loser_id;

    UPDATE public.edgar_major_shareholders es
    SET financial_entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE es.financial_entity_id = rl.loser_id;

    UPDATE public.irs990_filings f
    SET financial_entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE f.financial_entity_id = rl.loser_id;

    UPDATE public.irs990_officers o
    SET matched_entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE o.matched_entity_type = 'financial_entity'
      AND o.matched_entity_id   = rl.loser_id;

    UPDATE public.irs990_grants_out g
    SET matched_entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE g.matched_entity_type = 'financial_entity'
      AND g.matched_entity_id   = rl.loser_id;

    UPDATE public.financial_entities fe
    SET parent_entity_id = rl.winner_id
    FROM _donor_remap rl
    WHERE fe.parent_entity_id = rl.loser_id;
  END IF;

  RAISE NOTICE '[FIX-245] step 4d (hard FKs) in % ms',
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 5. Entity merge: roll loser totals + best metadata into the winner ──
  t_step := clock_timestamp();

  IF losers_count > 0 THEN
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
  ELSE
    entities_merged := 0;
  END IF;

  RAISE NOTICE '[FIX-245] step 5 (entity merge): % winners updated in % ms',
    entities_merged,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 6. Delete losers ────────────────────────────────────────────────────
  t_step := clock_timestamp();

  IF losers_count > 0 THEN
    DELETE FROM public.financial_entities
    WHERE id IN (SELECT loser_id FROM _donor_remap);
    GET DIAGNOSTICS losers_count = ROW_COUNT;
  END IF;

  RAISE NOTICE '[FIX-245] step 6 (delete losers): % rows in % ms',
    losers_count,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  -- ── 7. Rewrite donor_fingerprint + canonical_name on survivors ──────────
  -- Two-pass: null then set, per 20260510000006 step 7's collision-avoidance
  -- explanation (cross-cluster old_fp == new_fp collisions during partial
  -- UPDATEs trip the UNIQUE check row-by-row).
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

  RAISE NOTICE '[FIX-245] step 7 (fp rewrite, two-pass): % rows in % ms',
    fp_rewritten,
    extract(milliseconds FROM clock_timestamp() - t_step)::int;

  RAISE NOTICE '[FIX-245] DONE in % ms total. individuals=% clusters_merged=% losers=% rels_replaced=% rels_inserted=% ext_src=% entities_merged=% fp_rewritten=%',
    extract(milliseconds FROM clock_timestamp() - t0)::int,
    individual_rows, merge_clusters, losers_count,
    rels_replaced, rels_inserted, ext_src_updated, entities_merged, fp_rewritten;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Block C — FIX-320 path (a) orphan entity_tags cleanup.
--
-- Runs after Block B so any newly-orphaned tags from the FIX-245 loser
-- deletes are also swept. Path (a) is correct here because investigation
-- showed every orphan is `generated_by` ∈ {'rule','ai'} (zero 'manual'),
-- so re-derivation is idempotent under the next tag pipeline run.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t0           timestamptz := clock_timestamp();
  orphans_pre  bigint;
  orphans_del  bigint;
BEGIN
  SELECT count(*) INTO orphans_pre
    FROM public.entity_tags et
   WHERE et.entity_type = 'financial_entity'
     AND NOT EXISTS (SELECT 1 FROM public.financial_entities fe WHERE fe.id = et.entity_id);

  RAISE NOTICE '[FIX-320] Pre-cleanup orphan count: %', orphans_pre;

  DELETE FROM public.entity_tags et
   WHERE et.entity_type = 'financial_entity'
     AND NOT EXISTS (SELECT 1 FROM public.financial_entities fe WHERE fe.id = et.entity_id);
  GET DIAGNOSTICS orphans_del = ROW_COUNT;

  RAISE NOTICE '[FIX-320] DONE in % ms. deleted=% (pre=%)',
    extract(milliseconds FROM clock_timestamp() - t0)::int,
    orphans_del, orphans_pre;
END $$;

-- Refresh planner stats on tables the migration touched.
ANALYZE public.financial_entities;
ANALYZE public.financial_relationships;
ANALYZE public.external_relationships;
ANALYZE public.external_source_refs;
ANALYZE public.entity_tags;
