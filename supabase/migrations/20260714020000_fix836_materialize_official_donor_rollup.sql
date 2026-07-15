-- =============================================================================
-- FIX-836 — Materialize get_official_donor_rollup() off the FIX-704 dirty set.
--
-- get_official_donor_rollup() (migration 20260529130000) live-aggregates the
-- ENTIRE donation set on every rule-tagger run:
--   financial_relationships WHERE to_type='official' AND relationship_type='donation'
--   LEFT JOIN financial_entities, GROUP BY to_id  →  one jsonb array.
-- It has grown with the FR population: ~16s (May) → 34.6s (FIX-651 direct-pg) →
-- ~1239s / ~16min now (pg_stat_statements, ~4.39M donation rows post-FIX-672/677).
-- Pipeline-only (not user-facing), but a 16-min IOWait load on the enrichment tail
-- and a whole-table scan on every tagger run. Two consumers, both via
-- rollupJsonbDirect (packages/data/src/lib/heavy-rebuild.ts):
--   • tags/rules.ts tagOfficials()        → pac_heavy / grassroots / large_donor_funded
--   • enrichment/queue.ts aggregateOfficialStats() → the user-facing
--                                          "PAC x%, individual y% of $z raised" string
--
-- ── Fix: a small per-official summary, maintained incrementally ───────────────
-- public.official_donor_totals holds exactly what the two consumers need
-- {official_id, total_cents, pac_cents, individual_cents, donor_count} — ~4.2k
-- rows (one per official with ≥1 donation), not a 4.39M-row scan. It is
-- maintained by the SAME FIX-704 machinery that maintains official_donor_rollup_mv:
-- donor_rollup_rebuild_recipients() gains a second, additive DELETE+INSERT for
-- the chunk's official recipients, so the summary rides the existing daily
-- watermark / dirty-set / chunked-COMMIT / advisory-lock refresh
-- (refresh_official_donor_rollup_incremental, daily since FIX-832) with NO new
-- pg_cron job and NO new watermark. get_official_donor_rollup() is rewritten to
-- read the summary; its pre-FIX-836 whole-table body is preserved verbatim as
-- get_official_donor_rollup_full() (break-glass + the live-compute fallback used
-- until the summary is backfilled, so a tagger run in that window never sees []
-- and wipes tags — the FIX-426/427 contract).
--
-- ── Why NOT aggregate official_donor_rollup_mv (the existing rollup) ──────────
-- The MV keeps only the top-200 donors per recipient with entity_type, plus one
-- entity_type-BLIND tail bucket (rank 201). Aggregating it reproduces total_cents
-- and donor_count EXACTLY (measured: 0 mismatches over 4,207 officials) — so
-- grassroots and large_donor_funded (which use only total+count) are safe — but
-- it loses the pac/individual split on the tail. Measured on local (2.85M
-- donation FRs): pac_cents differs for 1,049 officials (up to 42.9% of total
-- lost), individual_cents for 1,386 (up to 98.7% lost), which FLIPS the pac_heavy
-- tag for 154 officials and shifts the enrichment individual-% by >5 points for
-- 1,222 officials (29%). Since PACs are large (top-200) and small individual
-- donors dominate the tail, the tail's individual money is precisely what the MV
-- drops. So the summary keeps the FULL entity_type split — byte-identical to the
-- old whole-table fn (from_type is 100% financial_entity for donation→official,
-- so the MV's from_type filter is a no-op difference here).
--
-- ── Promotion (FIX-761 official-FK-surface contract) ─────────────────────────
-- official_donor_totals.official_id references officials, so a promoted (deleted)
-- elected official must not leave a stale row. It is DERIVED + self-healing: the
-- candidate side re-aggregates on the next daily refresh (the promotion FR
-- rewrite bumps updated_at → the recipient goes dirty, exactly as for the MV).
-- The elected side is cleaned by an AFTER DELETE trigger on officials (below) —
-- chosen over the MV's explicit DELETE-in-promote_candidate_to_elected() so this
-- migration does not have to re-CREATE that 320-line FK-rewrite function to add
-- one derived-cleanup line, and over a FK ON DELETE CASCADE because a FK would
-- couple the shared MV/summary refresh's health to a condition the MV tolerates
-- (an orphaned donation FR would wedge the chunk). See [[FIX-761]] [[FIX-704]].
-- =============================================================================

-- ── 1. Summary table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.official_donor_totals (
  official_id      uuid   NOT NULL PRIMARY KEY,  -- to_type='official' recipient
  total_cents      bigint NOT NULL,
  pac_cents        bigint,          -- NULL when no pac/super_pac donors (mirrors SUM FILTER)
  individual_cents bigint,          -- NULL when no individual donors
  donor_count      bigint NOT NULL, -- COUNT(*) of donation FR rows (matches old fn)
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.official_donor_totals IS
  'FIX-836 — exact per-official donation summary {total,pac,individual,count} '
  'that get_official_donor_rollup() reads instead of scanning the whole donation '
  'table. One row per official with ≥1 donation FR. Maintained incrementally by '
  'donor_rollup_rebuild_recipients() on the FIX-704 donor_rollup_watermark '
  '(daily, FIX-832); full backfill via official_donor_totals_backfill(). Derived '
  '+ self-healing (candidate side re-aggregates next refresh; elected side cleaned '
  'by the officials AFTER DELETE trigger). Byte-identical to the pre-FIX-836 '
  'get_official_donor_rollup() output (kept as get_official_donor_rollup_full()).';

-- Read only by the SECURITY DEFINER get_official_donor_rollup() (owner=postgres,
-- bypasses RLS); no anon/authenticated surface (FIX-834/695 hygiene). RLS on with
-- no policy = deny direct non-owner access. service_role gets DML for the case
-- where refresh_official_donor_rollup_incremental() is invoked as service_role.
ALTER TABLE public.official_donor_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_donor_totals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_donor_totals TO service_role;

-- ── 2. Break-glass: the pre-FIX-836 whole-table aggregation, preserved verbatim.
--     Also the live-compute fallback below. ~16min on prod at 4.39M donation rows.
CREATE OR REPLACE FUNCTION public.get_official_donor_rollup_full()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  FROM (
    SELECT
      fr.to_id                                                                                AS official_id,
      SUM(COALESCE(fr.amount_cents, 0))::BIGINT                                                AS total_cents,
      (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::BIGINT AS pac_cents,
      (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type = 'individual'))::BIGINT AS individual_cents,
      COUNT(*)::BIGINT                                                                         AS donor_count
    FROM public.financial_relationships fr
    LEFT JOIN public.financial_entities fe ON fe.id = fr.from_id
    WHERE fr.to_type = 'official'
      AND fr.relationship_type = 'donation'
    GROUP BY fr.to_id
  ) t;
$$;
ALTER FUNCTION public.get_official_donor_rollup_full() SET statement_timeout = '300s';

COMMENT ON FUNCTION public.get_official_donor_rollup_full() IS
  'FIX-836 — the pre-FIX-836 whole-table donor rollup (financial_relationships '
  'donation→official, LEFT JOIN financial_entities, GROUP BY to_id → jsonb). '
  '~16min on prod at 4.39M rows. Break-glass + the live-compute fallback for '
  'get_official_donor_rollup() before the summary table is backfilled.';

-- ── 3. Fast path: read the incrementally-maintained summary once it is fully ───
--     bootstrapped; else live-compute via _full(). The gate is a pipeline_state
--     FLAG set atomically by the backfill — NOT "table is non-empty". Rollout
--     ordering matters: after this migration applies but before the backfill runs,
--     the daily donor-rollup cron / an incremental refresh can write a PARTIAL
--     summary (dirty recipients only). An EXISTS gate would then serve that
--     incomplete set and the tagger would under-tag every official not yet in it.
--     The flag stays false until official_donor_totals_backfill() has written the
--     FULL set (same txn), so the fallback covers the whole pre-backfill window.
--     Output shape unchanged: [{official_id,total_cents,pac_cents,individual_cents,
--     donor_count}, ...] with pac/individual NULL when absent (consumers `?? 0`).
CREATE OR REPLACE FUNCTION public.get_official_donor_rollup()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v            jsonb;
  v_bootstrapped boolean;
BEGIN
  SELECT (value->>'bootstrapped')::boolean INTO v_bootstrapped
  FROM public.pipeline_state WHERE key = 'official_donor_totals_state';

  IF COALESCE(v_bootstrapped, false) THEN
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v
    FROM (
      SELECT official_id, total_cents, pac_cents, individual_cents, donor_count
      FROM public.official_donor_totals
    ) t;
    RETURN v;
  END IF;
  -- Not yet backfilled → live-compute so a tagger run never sees a partial/[] set
  -- (would wipe donor tags). Self-healing: once backfilled, the fast path wins.
  RETURN public.get_official_donor_rollup_full();
END;
$$;

COMMENT ON FUNCTION public.get_official_donor_rollup() IS
  'FIX-836 — reads the official_donor_totals summary (was a ~16min whole-table '
  'aggregation). Live-compute fallback to get_official_donor_rollup_full() while '
  'the summary is empty. Output shape unchanged (rollupJsonbDirect callers '
  'tagOfficials + aggregateOfficialStats need no change).';

-- ── 4. Extend donor_rollup_rebuild_recipients() to ALSO maintain the summary ──
--     Body below is the live FIX-704 helper VERBATIM, with one additive block
--     appended before RETURN (the MV DELETE+INSERT above is untouched — the
--     summary write is independent). The summary aggregation is byte-identical to
--     get_official_donor_rollup_full(), scoped to this chunk's recipients; it
--     keeps the FULL entity_type split (no top-200 truncation) because that split
--     is exactly what the tagger's pac_heavy and the enrichment individual-% need.
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
  -- recipients (feeds get_official_donor_rollup()). Additive to the MV build
  -- above. donation-only + to_type='official' + full entity_type split =
  -- byte-identical to get_official_donor_rollup_full() scoped to the chunk.
  -- p_recipients may include financial_entity recipients (super PACs); the
  -- to_type='official' filter drops them from the INSERT, and the DELETE only
  -- matches official rows (FE ids are never in official_donor_totals).
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

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.donor_rollup_rebuild_recipients(uuid[]) TO service_role;

-- ── 5. Backfill: full one-shot (TRUNCATE + whole-table agg). Run per-env via ──
--     direct-pg with a session statement_timeout raised past the ~16min cost
--     (runHeavyRebuild sets it; the ALTER-FUNCTION GUC would be a no-op, FIX-703).
CREATE OR REPLACE FUNCTION public.official_donor_totals_backfill()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count bigint;
BEGIN
  TRUNCATE public.official_donor_totals;
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
  GROUP BY fr.to_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the full write, so
  -- get_official_donor_rollup() only leaves the _full() fallback once the
  -- complete set is committed (never a partial-summary window).
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('official_donor_totals_state',
          jsonb_build_object('bootstrapped', true, 'backfilled_at', now()::text, 'rows', v_count))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.official_donor_totals_backfill() IS
  'FIX-836 — full rebuild of official_donor_totals (TRUNCATE + whole-table '
  'donation aggregation, byte-identical to get_official_donor_rollup_full()). '
  'One-shot per-env bootstrap; the incremental daily refresh keeps it fresh '
  'thereafter. Run over direct-pg with a raised statement_timeout (~16min prod).';

-- ── 6. Derived-cleanup trigger: drop an official''s summary row when the ──────
--     official is deleted (promotion via promote_candidate_to_elected(), or any
--     other officials delete). Mirrors the MV''s derived-surface cleanup without
--     re-CREATE-ing the promote function. See the FIX-761 note in the header.
CREATE OR REPLACE FUNCTION public.official_donor_totals_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.official_donor_totals WHERE official_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS official_donor_totals_cleanup_del ON public.officials;
CREATE TRIGGER official_donor_totals_cleanup_del
  AFTER DELETE ON public.officials
  FOR EACH ROW
  EXECUTE FUNCTION public.official_donor_totals_cleanup();

-- ── 7. Function grants (Supabase default-grants EXECUTE to anon/authenticated on
--     every new function — FIX-695/834 — so route-gated DEFINER RPCs need an
--     explicit REVOKE). Both rollup fns are service_role-only (direct-pg tag
--     pipeline); the backfill is a supervised bootstrap.
REVOKE ALL ON FUNCTION public.get_official_donor_rollup()      FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_official_donor_rollup()      TO service_role;
REVOKE ALL ON FUNCTION public.get_official_donor_rollup_full() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_official_donor_rollup_full() TO service_role;
REVOKE ALL ON FUNCTION public.official_donor_totals_backfill() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.official_donor_totals_backfill() TO service_role;

-- PostgREST: new table + changed function signature → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
