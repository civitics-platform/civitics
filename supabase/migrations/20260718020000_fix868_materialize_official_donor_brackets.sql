-- =============================================================================
-- FIX-868 — Materialize treemap_individual_brackets_for_official() off the
-- FIX-704/836 daily dirty set (8s PostgREST statement_timeout → ms).
--
-- [[FIX-848]]'s treemap_individual_brackets_for_official(uuid) (migration
-- 20260718010000) live-aggregates every individual donation to an official
-- (per-donor GROUP BY over financial_relationships + financial_entities, bucketed
-- mega/major/mid/small) on the /api/graph/treemap request path. Measured THROUGH
-- the HTTP route as service_role on prod 2026-07-18: PostgREST returns 57014
-- "canceling statement due to statement timeout" above the 8s authenticator/
-- service_role cap. Empirical crossover ≈19k distinct individual donors — an
-- 18.8k-donor official returns in 1.5-3.0s; 19.5k+ times out. 19 officials
-- (donation tail >19k) blow the cap, so /api/graph/treemap hits brErr, logs
-- "brackets RPC failed — single tail cell fallback", and silently reverts to the
-- FIX-845 single "Individual donors (N)" cell — FIX-848's per-bracket cells never
-- render for the highest-donor officials. s-maxage=86400 doesn't help; the origin
-- times out before the CDN can cache.
--
-- ── Fix: a tiny per-(official, tier) rollup, maintained incrementally ──────────
-- public.official_donor_bracket_totals holds {official_id, tier, total_cents,
-- donor_count} — ~4 rows per covered official (the mega/major/mid/small tiers that
-- have donors), not a per-donor scan on the request path. It is maintained by the
-- SAME FIX-704 machinery that maintains official_donor_rollup_mv / official_donor_
-- totals / the FIX-776/777/779 rollups: donor_rollup_rebuild_recipients() gains a
-- 6th additive PERFORM, so brackets ride the existing daily watermark / dirty-set /
-- chunked-COMMIT / advisory-lock refresh (FIX-832 daily) with NO new pg_cron and NO
-- new watermark. The brackets are the same donation rows the proc already scans per
-- recipient, just bucketed by per-donor total.
--
-- ── Read path: per-entity coverage, live-compute fallback (FIX-779 pattern) ────
-- treemap_individual_brackets_for_official() is rewritten to read the rollup when
-- the official has bracket rows, else fall through to the pre-FIX-868 live body
-- (preserved verbatim as treemap_individual_brackets_for_official_live()). This is
-- FIX-779's per-scope-miss fallback, NOT the FIX-836 whole-table bootstrap flag: an
-- uncovered official (pre-backfill, or a genuinely zero-individual-donor official)
-- live-computes. Route unchanged, so nothing breaks pre-backfill — a heavy-but-not-
-- yet-covered official still times out at 8s and falls to today's graceful single-
-- cell path; once backfilled it reads the rollup in <1s.
--
-- ── Backfill: explicit, chunked, per-chunk COMMIT (run supervised, no-txn CALL) ─
-- backfill_official_donor_brackets() chunks over all officials-with-individual-
-- donations (300/chunk, COMMIT each, advisory-locked) calling the rebuild helper —
-- same shape as FIX-779 backfill_treemap_individuals_focused(). It runs as postgres
-- (2min role timeout; raise session statement_timeout for the supervised one-shot),
-- so the 19 heavy officials that fail at 8s via PostgREST complete fine. Run it once
-- per env after apply so brackets light up TODAY rather than at the next 09:00 cron.
--
-- Promotion (FIX-761 official-FK-surface contract): official_donor_bracket_totals
-- .official_id references officials, so a promoted (deleted) elected official is
-- cleaned by an AFTER DELETE trigger (mirrors FIX-836/779; candidate side re-
-- aggregates on the next daily refresh). See [[FIX-848]] [[FIX-836]] [[FIX-779]]
-- [[FIX-704]] [[FIX-832]] [[FIX-761]].
-- =============================================================================

-- ── 1. Rollup table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.official_donor_bracket_totals (
  official_id uuid   NOT NULL,   -- to_type='official' recipient
  tier        text   NOT NULL,   -- 'mega' | 'major' | 'mid' | 'small'
  total_cents bigint NOT NULL,
  donor_count bigint NOT NULL,
  PRIMARY KEY (official_id, tier)
);

COMMENT ON TABLE public.official_donor_bracket_totals IS
  'FIX-868 — per-(official, size tier) INDIVIDUAL-donor totals {total_cents, '
  'donor_count} for the /api/graph/treemap "Individual donors" bracket cells. '
  'Per-DONOR-total bucketed (mega>=$10k / major>=$2.5k / mid>=$500 / small<$500, '
  'catch-all), byte-identical to treemap_individual_brackets_for_official_live(). '
  '~4 rows per official with >=1 individual donor. Maintained incrementally by '
  'donor_rollup_rebuild_recipients() on the FIX-704 donor_rollup_watermark (daily, '
  'FIX-832); full backfill via backfill_official_donor_brackets(). Derived + self-'
  'healing (candidate side re-aggregates next refresh; elected side cleaned by the '
  'officials AFTER DELETE trigger).';

-- Read only by the SECURITY DEFINER RPC (owner=postgres, bypasses RLS); no anon/
-- authenticated surface (FIX-834/695). RLS on with no policy = deny non-owner.
ALTER TABLE public.official_donor_bracket_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_donor_bracket_totals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_donor_bracket_totals TO service_role;

-- ── 2. Focused per-official rebuild helper (single txn, no COMMIT) ────────────
-- Per-tier individual-donor totals for a set of officials. Bucketing is the RPC's
-- CASE verbatim: sum a donor's donations to the official, THEN bucket by that
-- per-donor total (NOT per-row). p_officials may include financial_entity
-- recipients (super PACs); the to_type='official' + entity_type='individual'
-- filters yield no rows for them, and the DELETE only matches official rows.
CREATE OR REPLACE FUNCTION public.treemap_individual_brackets_rebuild_officials(p_officials uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_donor_bracket_totals
   WHERE official_id = ANY (p_officials);

  WITH per_donor AS (
    SELECT
      fr.to_id                     AS official_id,
      fe.id                        AS donor_id,
      SUM(fr.amount_cents)::bigint AS donor_cents
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe
      ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type           = 'official'
      AND fr.amount_cents > 0
      AND fe.entity_type       = 'individual'
      AND fr.to_id = ANY (p_officials)
    GROUP BY fr.to_id, fe.id
  ),
  bucketed AS (
    SELECT
      official_id,
      donor_cents,
      CASE
        WHEN donor_cents >= 1000000 THEN 'mega'   -- $10k+
        WHEN donor_cents >=  250000 THEN 'major'  -- $2.5k-$10k
        WHEN donor_cents >=   50000 THEN 'mid'    -- $500-$2.5k
        ELSE                             'small'  -- < $500 (catch-all)
      END AS tier
    FROM per_donor
  ),
  ins AS (
    INSERT INTO public.official_donor_bracket_totals
      (official_id, tier, total_cents, donor_count)
    SELECT official_id, tier, SUM(donor_cents)::bigint, COUNT(*)::bigint
    FROM bucketed
    GROUP BY official_id, tier
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.treemap_individual_brackets_rebuild_officials(uuid[]) TO service_role;

COMMENT ON FUNCTION public.treemap_individual_brackets_rebuild_officials(uuid[]) IS
  'FIX-868 — delete + re-aggregate official_donor_bracket_totals (per-tier '
  'individual-donor totals) for a set of officials. No COMMIT: the chunked backfill '
  '/ donor_rollup_rebuild_recipients() own the txn.';

-- ── 3. Extend donor_rollup_rebuild_recipients() — 6th additive block ──────────
--     Body is the live FIX-704/836/776/777/779 helper VERBATIM + one PERFORM
--     before RETURN. The five existing blocks are untouched.
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

  -- FIX-836: exact per-official donation summary (feeds get_official_donor_rollup()).
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

  -- FIX-776: per-official small-dollar summary (feeds /api/graph/small-dollar).
  PERFORM public.small_dollar_rebuild_officials(p_recipients);

  -- FIX-777: per-(official, industry) sector-affinity summary (feeds /api/graph/sector-affinity).
  PERFORM public.sector_affinity_rebuild_officials(p_recipients);

  -- FIX-779: focused individual-donor treemap (top-50/state) (feeds
  -- /api/graph/treemap-individuals focused mode).
  PERFORM public.treemap_individuals_rebuild_officials(p_recipients);

  -- FIX-868: per-(official, tier) individual-donor bracket totals (feeds the
  -- /api/graph/treemap "Individual donors" bracket cells). Additive; own DELETE+INSERT.
  PERFORM public.treemap_individual_brackets_rebuild_officials(p_recipients);

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.donor_rollup_rebuild_recipients(uuid[]) TO service_role;

-- ── 4. Break-glass / live-compute fallback: the pre-FIX-868 RPC body, verbatim ─
--     The per-donor-total bucketed aggregation from migration 20260718010000.
--     Used when an official has no rollup rows (uncovered → live compute). NOT
--     given a raised statement_timeout: a heavy-but-uncovered official SHOULD
--     fast-fail at the role cap so the route falls to its graceful single-cell
--     path (today's behavior), until the backfill covers it.
CREATE OR REPLACE FUNCTION public.treemap_individual_brackets_for_official_live(
  p_official uuid
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH per_donor AS (
    SELECT fe.id AS donor_id, SUM(fr.amount_cents) AS donor_cents
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe
      ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type           = 'official'
      AND fr.to_id             = p_official
      AND fr.amount_cents > 0
      AND fe.entity_type       = 'individual'
    GROUP BY fe.id
  ),
  bucketed AS (
    SELECT
      donor_cents,
      CASE
        WHEN donor_cents >= 1000000 THEN 'mega'
        WHEN donor_cents >=  250000 THEN 'major'
        WHEN donor_cents >=   50000 THEN 'mid'
        ELSE                             'small'
      END AS bracket
    FROM per_donor
  ),
  per_tier AS (
    SELECT bracket,
           SUM(donor_cents)::bigint AS total_cents,
           COUNT(*)::bigint         AS donor_count
    FROM bucketed
    GROUP BY bracket
  )
  SELECT jsonb_build_object(
    'tiers', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
                'tier',        bracket,
                'total_cents', total_cents,
                'donor_count', donor_count))
       FROM per_tier),
      '[]'::jsonb),
    'total_cents', COALESCE((SELECT SUM(total_cents) FROM per_tier), 0)::bigint,
    'donor_count', COALESCE((SELECT SUM(donor_count) FROM per_tier), 0)::bigint
  );
$$;

COMMENT ON FUNCTION public.treemap_individual_brackets_for_official_live(uuid) IS
  'FIX-868 — the pre-FIX-868 live per-donor bucketed aggregation (migration '
  '20260718010000). Times out >8s above ~19k individual donors; used only as the '
  'uncovered-official fallback for treemap_individual_brackets_for_official().';

-- ── 5. Fast path: read the rollup when covered, else live-compute (FIX-779) ───
--     Per-entity coverage: an official with >=1 bracket row reads the rollup;
--     absent (pre-backfill, or genuinely zero individual donors) → live body.
--     Output shape identical to the pre-FIX-868 RPC ({tiers, total_cents,
--     donor_count}); the route needs no change.
CREATE OR REPLACE FUNCTION public.treemap_individual_brackets_for_official(
  p_official uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.official_donor_bracket_totals
              WHERE official_id = p_official) THEN
    SELECT jsonb_build_object(
      'tiers', COALESCE(
        jsonb_agg(jsonb_build_object(
          'tier',        tier,
          'total_cents', total_cents,
          'donor_count', donor_count)),
        '[]'::jsonb),
      'total_cents', COALESCE(SUM(total_cents), 0)::bigint,
      'donor_count', COALESCE(SUM(donor_count), 0)::bigint
    ) INTO v
    FROM public.official_donor_bracket_totals
    WHERE official_id = p_official;
    RETURN v;
  END IF;
  -- Uncovered → live-compute (matches today; heavy-uncovered fast-fails to the
  -- route's graceful single-cell path until the backfill lands).
  RETURN public.treemap_individual_brackets_for_official_live(p_official);
END;
$$;

COMMENT ON FUNCTION public.treemap_individual_brackets_for_official(uuid) IS
  'FIX-868 — reads the official_donor_bracket_totals rollup (was a live per-donor '
  'aggregation that timed out >8s above ~19k individual donors). Per-entity '
  'coverage: uncovered officials fall back to treemap_individual_brackets_for_'
  'official_live() (FIX-779 pattern). Output shape unchanged.';

-- ── 6. Explicit chunked backfill (per-chunk COMMIT) — run supervised per env ──
--     Mirrors FIX-779 backfill_treemap_individuals_focused(). Run once after apply
--     via the no-txn CALL path (bare psql local / supervised prod wrapper with a
--     raised session statement_timeout — FIX-791) so brackets light up today.
CREATE OR REPLACE PROCEDURE public.backfill_official_donor_brackets()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('official_donor_brackets_backfill')::bigint;
  c_chunk    int    := 300;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donor-brackets backfill] advisory lock held — skipping';
    RETURN;
  END IF;
  SET work_mem = '256MB';

  SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe ON fe.id = fr.from_id AND fe.entity_type = 'individual'
  WHERE fr.relationship_type = 'donation'
    AND fr.from_type         = 'financial_entity'
    AND fr.to_type           = 'official'
    AND fr.amount_cents > 0;

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.treemap_individual_brackets_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('official_donor_brackets_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));
  RAISE NOTICE '[donor-brackets backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.backfill_official_donor_brackets() TO service_role;

COMMENT ON PROCEDURE public.backfill_official_donor_brackets() IS
  'FIX-868 — chunked (300 officials/chunk, COMMIT each) one-shot bootstrap of '
  'official_donor_bracket_totals. Advisory-locked, idempotent. Run as postgres '
  '(raise session statement_timeout for the heavy officials); the incremental '
  'donor_rollup_rebuild_recipients() block keeps it fresh thereafter.';

-- ── 7. Derived-cleanup trigger (FIX-761 official-FK-surface contract) ─────────
CREATE OR REPLACE FUNCTION public.official_donor_bracket_totals_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.official_donor_bracket_totals WHERE official_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS official_donor_bracket_totals_cleanup_del ON public.officials;
CREATE TRIGGER official_donor_bracket_totals_cleanup_del
  AFTER DELETE ON public.officials
  FOR EACH ROW
  EXECUTE FUNCTION public.official_donor_bracket_totals_cleanup();

-- ── 8. Function-grant hygiene (FIX-695/834) ──────────────────────────────────
REVOKE ALL ON FUNCTION public.treemap_individual_brackets_for_official(uuid)      FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.treemap_individual_brackets_for_official(uuid)      TO service_role;
REVOKE ALL ON FUNCTION public.treemap_individual_brackets_for_official_live(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.treemap_individual_brackets_for_official_live(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.treemap_individual_brackets_rebuild_officials(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.treemap_individual_brackets_rebuild_officials(uuid[]) TO service_role;
REVOKE ALL ON PROCEDURE public.backfill_official_donor_brackets()                FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_official_donor_brackets()                TO service_role;

-- PostgREST: new table + changed function signature → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
