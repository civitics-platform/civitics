-- =============================================================================
-- FIX-777 — Materialize /api/graph/sector-affinity per-official rollup (FIX-775 #2).
--
-- /api/graph/sector-affinity?entityId=X ("Sector Affinity" preset) paginates
-- financial_relationships (donation, from_type='financial_entity', to_type=
-- 'official', to_id=X) in 1000-row pages, sums per donor in JS, batches an
-- entity_tags industry lookup per donor, then aggregates dollars + distinct-donor
-- counts per industry (top 15). A live request-path aggregate over the ~2.84M-row
-- donation set + the tag join — the FIX-775 audit gap, cold-IOWait (FIX-499)
-- class on Pro Small.
--
-- ── Fix: a small per-(official, industry) rollup, maintained incrementally ─────
-- public.official_sector_affinity_rollup holds {official_id, industry,
-- total_cents, donor_count} — one row per (official, industry) where `industry`
-- is the donor's single industry-tag slug (or the literal 'Untagged'). The route
-- reads all rows for the official (a bounded ~dozen-row scan, no 1000-row cap),
-- sorts, and takes the top 15; its live per-donor aggregation stays as the
-- per-entity miss fallback.
--
-- ── Why NOT reuse official_sector_dollars_mv (FIX-506) — FIX-775 decision 4 ────
-- Evaluated and rejected: official_sector_dollars_mv has DIVERGENT grain
-- semantics that would materially change the displayed sectors —
--   • Multi-tag donors: the MV (INNER JOIN entity_tags, no dedup) counts a
--     donor's dollars under EVERY industry tag; this route assigns a donor's
--     whole amount to ONE tag. 1,056 financial-entity donors carry >1 industry
--     tag (local), so their money would double-count across sectors.
--   • Untagged donors: the MV EXCLUDES them (INNER JOIN); this route buckets them
--     as a single 'Untagged' sector. 1,197,880 distinct official-donors are
--     untagged (local) — 'Untagged' is typically the largest bucket, so reuse
--     would silently drop it from the chart.
-- Reproducing the route byte-for-byte therefore needs its own single-tag-per-
-- donor + Untagged rollup, which this migration builds.
--
-- ── Deterministic tag pick (route was non-deterministic) ─────────────────────
-- The route kept the "first tag seen" per donor across unordered .in() batches —
-- non-deterministic for the 1,056 multi-tag donors (the chosen sector could
-- differ between requests / CDN fills). Both the rollup and the route's live
-- fallback are aligned to the deterministic smallest-tag pick (DISTINCT ON
-- (entity_id) ORDER BY entity_id, tag) — the same pick official_donor_rollup_mv /
-- fetchIndustryTagsByEntityId use — so rollup == fallback exactly. This is a
-- strict improvement (non-deterministic → deterministic), not a weakening.
--
-- ── Refresh hook / backfill / promotion — same shape as FIX-776/836 ──────────
-- A fourth additive block appended to donor_rollup_rebuild_recipients() (beside
-- the MV, official_donor_totals, and small-dollar blocks) rides the FIX-704/832
-- daily donor-rollup dirty set — NO new pg_cron job, NO new watermark (decision
-- 2). One-shot bootstrap is a chunked per-COMMIT procedure, never a single
-- full-table aggregate (decision 3). An officials AFTER DELETE trigger cleans the
-- rows on promotion (FIX-761 derived-surface contract). See [[FIX-776]] [[FIX-704]].
-- =============================================================================

-- ── 1. Rollup table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.official_sector_affinity_rollup (
  official_id uuid   NOT NULL,               -- to_type='official' recipient
  industry    text   NOT NULL,               -- donor's single industry tag slug, or 'Untagged'
  total_cents bigint NOT NULL,               -- SUM of per-donor donation totals in this sector
  donor_count bigint NOT NULL,               -- distinct donors in this sector
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (official_id, industry)
);

COMMENT ON TABLE public.official_sector_affinity_rollup IS
  'FIX-777 — per-(official, industry) donor-sector summary {total_cents, '
  'donor_count}. `industry` = the donor''s single (smallest, deterministic) '
  'industry-tag slug, or the literal ''Untagged''. One row per (official, '
  'industry) for officials with >=1 donation. Serves /api/graph/sector-affinity '
  '(read all rows, sort, top 15); the route keeps its live per-donor aggregation '
  'as the per-entity miss fallback. Maintained incrementally by '
  'donor_rollup_rebuild_recipients() on the FIX-704 donor_rollup_watermark '
  '(daily, FIX-832); full backfill via backfill_official_sector_affinity_rollup(). '
  'Derived + self-healing (candidate side re-aggregates; elected side cleaned by '
  'the officials AFTER DELETE trigger).';

-- Read only by the sector-affinity route (createAdminClient → service_role,
-- BYPASSRLS). No anon/authenticated surface (FIX-834/695 hygiene).
ALTER TABLE public.official_sector_affinity_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_sector_affinity_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_sector_affinity_rollup TO service_role;

-- ── 2. Per-recipient rebuild helper (single txn, no COMMIT — callers own txns) ─
-- Byte-for-byte with the route: per-donor SUM (donation, from FE, to official,
-- amount>0), map each donor to its single smallest industry tag (or 'Untagged'),
-- aggregate dollars + distinct-donor count per industry. p_recipients may include
-- financial_entity recipients; the to_type='official' filter yields no rows for
-- them and the DELETE matches nothing.
CREATE OR REPLACE FUNCTION public.sector_affinity_rebuild_officials(p_recipients uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_sector_affinity_rollup
   WHERE official_id = ANY (p_recipients);

  WITH per_donor AS (
    SELECT
      fr.to_id                     AS official_id,
      fr.from_id                   AS donor_id,
      SUM(fr.amount_cents)::bigint  AS cents
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'
      AND fr.to_type           = 'official'
      AND fr.amount_cents > 0
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id, fr.from_id
  ),
  donor_tag AS (
    -- One deterministic (smallest) industry tag per donor — same pick as the
    -- FIX-518/704 `ind` CTE / fetchIndustryTagsByEntityId. Scoped to this chunk's
    -- donors so it stays an index probe.
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id AS donor_id,
      et.tag       AS industry
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
      AND et.entity_id IN (SELECT donor_id FROM per_donor)
    ORDER BY et.entity_id, et.tag
  ),
  by_sector AS (
    SELECT
      pd.official_id,
      COALESCE(dt.industry, 'Untagged') AS industry,
      SUM(pd.cents)::bigint             AS total_cents,
      COUNT(*)::bigint                  AS donor_count   -- per_donor is 1 row/donor → distinct donors
    FROM per_donor pd
    LEFT JOIN donor_tag dt ON dt.donor_id = pd.donor_id
    GROUP BY pd.official_id, COALESCE(dt.industry, 'Untagged')
  ),
  ins AS (
    INSERT INTO public.official_sector_affinity_rollup
      (official_id, industry, total_cents, donor_count, updated_at)
    SELECT official_id, industry, total_cents, donor_count, now() FROM by_sector
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.sector_affinity_rebuild_officials(uuid[]) TO service_role;

COMMENT ON FUNCTION public.sector_affinity_rebuild_officials(uuid[]) IS
  'FIX-777 — delete + re-aggregate official_sector_affinity_rollup for a set of '
  'recipients (per-(official, industry) dollars + distinct-donor count; single '
  'smallest tag per donor, untagged → ''Untagged''). No COMMIT: the chunked '
  'backfill commits per chunk; donor_rollup_rebuild_recipients() calls it inside '
  'its own chunk txn.';

-- ── 3. Extend donor_rollup_rebuild_recipients() to ALSO maintain the rollup ───
--     Body below is the live FIX-704/836/776 helper VERBATIM (pg_get_functiondef
--     on 2026-07-15), with one additive line appended before RETURN. The three
--     existing blocks (MV, official_donor_totals, small-dollar) are untouched.
CREATE OR REPLACE FUNCTION public.donor_rollup_rebuild_recipients(p_recipients uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_donor_rollup_mv
   WHERE official_id = ANY (p_recipients);

  WITH per_donor AS (
    SELECT
      fr.to_id                       AS official_id,
      fr.relationship_type::text     AS relationship_type,
      fr.from_id                     AS donor_id,
      SUM(fr.amount_cents)::bigint   AS total_cents,
      COUNT(*)::bigint               AS tx_count
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
      AND fr.from_type = 'financial_entity'
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id, fr.relationship_type, fr.from_id
  ),
  ranked AS (
    SELECT
      pd.*,
      ROW_NUMBER() OVER (
        PARTITION BY pd.official_id, pd.relationship_type
        ORDER BY pd.total_cents DESC, pd.donor_id
      ) AS rn
    FROM per_donor pd
  ),
  ind AS (
    -- One deterministic (tag, label) pair per donor, scoped to this chunk's
    -- ranked donors (the FIX-518 MV computed this over ALL donors once per
    -- refresh; per-chunk scoping keeps it an index probe). Same smallest-tag
    -- pick as fetchIndustryTagsByEntityId.
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id,
      et.tag           AS industry_tag,
      et.display_label AS industry_label
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
      AND et.entity_id IN (SELECT r.donor_id FROM ranked r WHERE r.rn <= 200)
    ORDER BY et.entity_id, et.tag
  ),
  top_rows AS (
    SELECT
      r.official_id,
      r.relationship_type,
      r.rn::int           AS rank,
      r.donor_id,
      fe.display_name     AS donor_name,
      fe.entity_type      AS entity_type,
      ind.industry_tag    AS industry_tag,
      ind.industry_label  AS industry_label,
      r.total_cents,
      r.tx_count,
      NULL::bigint        AS tail_donor_count
    FROM ranked r
    LEFT JOIN public.financial_entities fe ON fe.id = r.donor_id
    LEFT JOIN ind                          ON ind.entity_id = r.donor_id
    WHERE r.rn <= 200
  ),
  tail_rows AS (
    SELECT
      r.official_id,
      r.relationship_type,
      201                        AS rank,
      NULL::uuid                 AS donor_id,
      NULL::text                 AS donor_name,
      NULL::text                 AS entity_type,
      NULL::text                 AS industry_tag,
      NULL::text                 AS industry_label,
      SUM(r.total_cents)::bigint AS total_cents,
      SUM(r.tx_count)::bigint    AS tx_count,
      COUNT(*)::bigint           AS tail_donor_count
    FROM ranked r
    WHERE r.rn > 200
    GROUP BY r.official_id, r.relationship_type
  ),
  ins AS (
    INSERT INTO public.official_donor_rollup_mv (
      official_id, relationship_type, rank, donor_id, donor_name, entity_type,
      industry_tag, industry_label, total_cents, tx_count, tail_donor_count
    )
    SELECT * FROM top_rows
    UNION ALL
    SELECT * FROM tail_rows
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  -- FIX-836: exact per-official donation summary for this chunk's official
  -- recipients (feeds get_official_donor_rollup()). Additive to the MV build.
  DELETE FROM public.official_donor_totals
   WHERE official_id = ANY (p_recipients);

  INSERT INTO public.official_donor_totals
    (official_id, total_cents, pac_cents, individual_cents, donor_count)
  SELECT
    fr.to_id,
    SUM(COALESCE(fr.amount_cents, 0))::bigint,
    (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
    (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
    COUNT(*)::bigint
  FROM public.financial_relationships fr
  LEFT JOIN public.financial_entities fe ON fe.id = fr.from_id
  WHERE fr.to_type = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.to_id = ANY (p_recipients)
  GROUP BY fr.to_id;

  -- FIX-776: per-official small-dollar summary for this chunk's official
  -- recipients (feeds /api/graph/small-dollar). Additive; independent of the two
  -- blocks above. Own DELETE+INSERT (see small_dollar_rebuild_officials).
  PERFORM public.small_dollar_rebuild_officials(p_recipients);

  -- FIX-777: per-(official, industry) sector-affinity summary for this chunk's
  -- official recipients (feeds /api/graph/sector-affinity). Additive; own
  -- DELETE+INSERT (see sector_affinity_rebuild_officials).
  PERFORM public.sector_affinity_rebuild_officials(p_recipients);

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.donor_rollup_rebuild_recipients(uuid[]) TO service_role;

-- ── 4. Chunked one-shot backfill (per-chunk COMMIT — memory-bounded) ──────────
CREATE OR REPLACE PROCEDURE public.backfill_official_sector_affinity_rollup()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('official_sector_affinity_rollup_backfill')::bigint;
  c_chunk    int    := 500;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[sector-affinity backfill] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
  FROM public.financial_relationships fr
  WHERE fr.to_type           = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.from_type         = 'financial_entity';

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.sector_affinity_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('sector_affinity_rollup_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));

  RAISE NOTICE '[sector-affinity backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.backfill_official_sector_affinity_rollup() TO service_role;

COMMENT ON PROCEDURE public.backfill_official_sector_affinity_rollup() IS
  'FIX-777 — chunked (500 officials/chunk, COMMIT each) one-shot bootstrap of '
  'official_sector_affinity_rollup. Memory-bounded. Idempotent. Run over '
  'direct-pg per env; the incremental refresh (donor_rollup_rebuild_recipients '
  'block) keeps it fresh thereafter.';

-- ── 5. Derived-cleanup trigger (mirrors FIX-776/836) ─────────────────────────
CREATE OR REPLACE FUNCTION public.official_sector_affinity_rollup_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.official_sector_affinity_rollup WHERE official_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS official_sector_affinity_rollup_cleanup_del ON public.officials;
CREATE TRIGGER official_sector_affinity_rollup_cleanup_del
  AFTER DELETE ON public.officials
  FOR EACH ROW
  EXECUTE FUNCTION public.official_sector_affinity_rollup_cleanup();

-- ── 6. Function-grant hygiene (FIX-695/834) ──────────────────────────────────
REVOKE ALL ON FUNCTION public.sector_affinity_rebuild_officials(uuid[])       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.sector_affinity_rebuild_officials(uuid[])       TO service_role;
REVOKE ALL ON PROCEDURE public.backfill_official_sector_affinity_rollup()     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_official_sector_affinity_rollup()     TO service_role;

-- PostgREST: new table + changed function signature → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
