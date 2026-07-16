-- =============================================================================
-- FIX-779 — Materialize /api/graph/treemap-individuals (FIX-775 #3), FIXING the
-- global coverage gap (FIX-809 class).
--
-- The route builds the individual-donor treemap in two modes:
--   * focused (entityId) — individual donors to that official, grouped by
--     (state, donor display_NAME), top-50 states × top-50 donors.
--   * global — the same across ALL officials.
-- Both paged financial_relationships live per request and aggregated in JS. WORSE,
-- both applied hard SCAN CAPS by id order — focused 100k rows, GLOBAL 20k rows.
-- The global cap is a severe coverage gap: it saw ~20k of ~2.38M individual->
-- official donation rows (<1%), so the global treemap showed an arbitrary sliver.
--
-- ── Fix: a pre-capped per-(scope, state) rollup + a cap-proof assembly RPC ─────
-- public.treemap_individuals_rollup keeps, per scope, the TOP-50 donors per state
-- (ranked) — bounded (<= ~56 states x 50). scope_id = the official id (focused) or
-- the nil-UUID GLOBAL sentinel. The route's per-state total is the SUM of the
-- SHOWN top-50 (not the true state total), so top-50/state is loss-free for what
-- the treemap displays; no tail bucket needed. get_treemap_individuals(scope)
-- assembles the final `children` jsonb (top-50 states by shown-50 sum, per-state
-- leaves) in ONE jsonb value — cap-proof (the route's .select() would trip the
-- 1000-row PostgREST cap on a whale). The route keeps its live JS aggregation as
-- the per-scope miss fallback.
--
-- GLOBAL now materializes the TRUE, UNCAPPED aggregate (approved fix — it changes
-- the displayed global treemap from the <1% sliver to the real top donors).
-- Focused also uncaps (1 local official already exceeded 100k).
--
-- Aggregation matches the route exactly (below the removed caps): individual
-- donors only (financial_entities.entity_type='individual'), grouped by
-- (state = metadata->>'state' COALESCE '??', donor display_name — merging
-- same-name donors), value = SUM(amount_cents), count = donation-row COUNT.
--
-- ── Refresh: focused rides the daily donor dirty set; global is weekly ────────
-- Focused: a 5th additive block in donor_rollup_rebuild_recipients() re-caps a
-- dirty official's top-50/state (rides the FIX-704/832 daily dirty set — no new
-- cron/watermark, decision 2). Global is NOT per-recipient (it aggregates
-- everything), so it gets a dedicated WEEKLY pg_cron (treemap-individuals-global-
-- refresh, Tue 08:15 UTC — after the Sunday FEC ingest) running a single
-- MEMORY-BOUNDED pass: the (state, name) aggregate is ~1.14M groups x <100B
-- (~60-90MB, fits work_mem — NOT the FIX-704 REFRESH-CONCURRENTLY multi-GB OOM
-- class), built into a temp table, then top-50/state inserted. Donations change
-- only on the weekly FEC ingest, so weekly-global / daily-focused is the right
-- cadence. Backfill = two chunked/bounded procedures run per env over direct-pg.
--
-- Promotion: officials AFTER DELETE trigger drops the focused scope (FIX-761).
-- =============================================================================

-- ── 1. Rollup table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.treemap_individuals_rollup (
  scope_id       uuid   NOT NULL,   -- official_id (focused) OR nil-UUID (global sentinel)
  state          text   NOT NULL,   -- donor state (metadata->>'state' or '??')
  rank           int    NOT NULL,   -- 1..50 within (scope_id, state), by total_cents desc, name
  donor_name     text   NOT NULL,   -- financial_entities.display_name (merges same-name donors)
  total_cents    bigint NOT NULL,
  donation_count bigint NOT NULL,
  PRIMARY KEY (scope_id, state, rank)
);

COMMENT ON TABLE public.treemap_individuals_rollup IS
  'FIX-779 — per-(scope, state) TOP-50 individual donors (by total_cents) for '
  '/api/graph/treemap-individuals. scope_id = official id (focused) OR '
  'the nil-UUID GLOBAL sentinel. Read via get_treemap_individuals(scope) → one '
  'jsonb (cap-proof); the route keeps its live JS aggregation as the per-scope '
  'miss fallback. Focused maintained by donor_rollup_rebuild_recipients() (FIX-704 '
  'daily dirty set); global by refresh_treemap_individuals_global() (weekly cron). '
  'GLOBAL is the TRUE uncapped aggregate (FIX-779 fixed the route''s 20k-row '
  'scan cap, a FIX-809-class coverage gap).';

ALTER TABLE public.treemap_individuals_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.treemap_individuals_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.treemap_individuals_rollup TO service_role;

-- ── 2. Focused per-official rebuild helper (single txn, no COMMIT) ────────────
-- Top-50 individual donors per state for a set of officials. p_officials may
-- include financial_entity recipients (super PACs); the to_type='official' filter
-- yields no rows for them, and the DELETE only matches focused scopes (never the
-- global sentinel, which is never a recipient id).
CREATE OR REPLACE FUNCTION public.treemap_individuals_rebuild_officials(p_officials uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.treemap_individuals_rollup
   WHERE scope_id = ANY (p_officials);

  WITH per_donor AS (
    SELECT
      fr.to_id                                 AS scope_id,
      COALESCE(fe.metadata->>'state', '??')    AS state,
      fe.display_name                          AS donor_name,
      SUM(fr.amount_cents)::bigint             AS total_cents,
      COUNT(*)::bigint                         AS donation_count
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe
      ON fe.id = fr.from_id AND fe.entity_type = 'individual'
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'
      AND fr.to_type           = 'official'
      AND fr.amount_cents > 0
      AND fr.to_id = ANY (p_officials)
    GROUP BY fr.to_id, COALESCE(fe.metadata->>'state', '??'), fe.display_name
  ),
  ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY scope_id, state ORDER BY total_cents DESC, donor_name) AS rank
    FROM per_donor
  ),
  ins AS (
    INSERT INTO public.treemap_individuals_rollup
      (scope_id, state, rank, donor_name, total_cents, donation_count)
    SELECT scope_id, state, rank::int, donor_name, total_cents, donation_count
    FROM ranked WHERE rank <= 50
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.treemap_individuals_rebuild_officials(uuid[]) TO service_role;

COMMENT ON FUNCTION public.treemap_individuals_rebuild_officials(uuid[]) IS
  'FIX-779 — delete + re-cap the focused treemap rollup (top-50 individual donors '
  'per state) for a set of officials. No COMMIT: the chunked backfill / '
  'donor_rollup_rebuild_recipients() own the txn.';

-- ── 3. Extend donor_rollup_rebuild_recipients() — 5th additive block (focused) ─
--     Body is the live FIX-704/836/776/777 helper VERBATIM + one PERFORM before
--     RETURN. The four existing blocks are untouched.
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
  -- /api/graph/treemap-individuals focused mode). Additive; own DELETE+INSERT.
  PERFORM public.treemap_individuals_rebuild_officials(p_recipients);

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.donor_rollup_rebuild_recipients(uuid[]) TO service_role;

-- ── 4. Focused one-shot chunked backfill (per-chunk COMMIT) ──────────────────
CREATE OR REPLACE PROCEDURE public.backfill_treemap_individuals_focused()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('treemap_individuals_focused_backfill')::bigint;
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
    RAISE NOTICE '[treemap-focused backfill] advisory lock held — skipping';
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
    v_n_ins    := public.treemap_individuals_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('treemap_individuals_focused_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));
  RAISE NOTICE '[treemap-focused backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.backfill_treemap_individuals_focused() TO service_role;

COMMENT ON PROCEDURE public.backfill_treemap_individuals_focused() IS
  'FIX-779 — chunked (300 officials/chunk, COMMIT each) one-shot bootstrap of the '
  'FOCUSED treemap_individuals_rollup scopes. Memory-bounded. Idempotent. The '
  'incremental refresh (donor_rollup_rebuild_recipients block) keeps it fresh.';

-- ── 5. Global refresh (weekly cron + backfill) — single MEMORY-BOUNDED pass ──
--     The (state, donor_name) aggregate is ~1.14M groups x <100B (~60-90MB, fits
--     work_mem — NOT the FIX-704 REFRESH-CONCURRENTLY multi-GB OOM class), so a
--     single hash aggregate into a temp table is bounded. Then top-50/state is
--     inserted for the global sentinel. One bounded txn (weekly, off-peak).
CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('treemap_individuals_global_refresh')::bigint;
  c_global   uuid   := '00000000-0000-0000-0000-000000000000';
  v_rows     bigint;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[treemap-global refresh] advisory lock held — skipping';
    RETURN;
  END IF;
  SET work_mem = '256MB';

  DROP TABLE IF EXISTS _tin_global;
  CREATE TEMP TABLE _tin_global AS
    SELECT
      COALESCE(fe.metadata->>'state', '??') AS state,
      fe.display_name                       AS donor_name,
      SUM(fr.amount_cents)::bigint          AS total_cents,
      COUNT(*)::bigint                      AS donation_count
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe ON fe.id = fr.from_id AND fe.entity_type = 'individual'
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'
      AND fr.to_type           = 'official'
      AND fr.amount_cents > 0
    GROUP BY 1, 2;

  DELETE FROM public.treemap_individuals_rollup WHERE scope_id = c_global;

  WITH ranked AS (
    SELECT state, donor_name, total_cents, donation_count,
      ROW_NUMBER() OVER (PARTITION BY state ORDER BY total_cents DESC, donor_name) AS rank
    FROM _tin_global
  ),
  ins AS (
    INSERT INTO public.treemap_individuals_rollup
      (scope_id, state, rank, donor_name, total_cents, donation_count)
    SELECT c_global, state, rank::int, donor_name, total_cents, donation_count
    FROM ranked WHERE rank <= 50
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_rows FROM ins;

  DROP TABLE IF EXISTS _tin_global;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('treemap_individuals_global_refresh', 'complete', now(), now(), v_rows,
          jsonb_build_object('scope', 'global'));
  RAISE NOTICE '[treemap-global refresh] complete — % rows', v_rows;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_treemap_individuals_global() TO service_role;

COMMENT ON PROCEDURE public.refresh_treemap_individuals_global() IS
  'FIX-779 — recompute the GLOBAL treemap_individuals_rollup scope (the TRUE '
  'uncapped top-50 individual donors per state across all officials). Single '
  'memory-bounded hash aggregate (~60-90MB) into a temp table, then top-50/state. '
  'Weekly pg_cron (treemap-individuals-global-refresh) + the per-env backfill.';

-- ── 6. Cap-proof assembly RPC — one jsonb `children` array for the route ─────
-- Mirrors the route's shape: per-state total = SUM of the shown top-50 leaves;
-- top-50 states by that total. Reads the pre-capped rollup (<= ~56x50 rows for a
-- scope) — cheap. SECURITY INVOKER; the route calls it as service_role.
CREATE OR REPLACE FUNCTION public.get_treemap_individuals(p_scope uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH src AS (
    SELECT state, donor_name, total_cents, donation_count, rank
    FROM public.treemap_individuals_rollup
    WHERE scope_id = p_scope
  ),
  per_state AS (
    SELECT
      state,
      round(SUM(total_cents) / 100.0, 2) AS total_usd,
      jsonb_agg(
        jsonb_build_object(
          'name',  donor_name,
          'value', round(total_cents / 100.0, 2),
          'count', donation_count,
          'state', state
        ) ORDER BY rank
      ) AS children
    FROM src
    GROUP BY state
  ),
  top_states AS (
    SELECT state, total_usd, children
    FROM per_state
    ORDER BY total_usd DESC
    LIMIT 50
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('name', state, 'totalUsd', total_usd, 'children', children)
      ORDER BY total_usd DESC
    ),
    '[]'::jsonb
  )
  FROM top_states;
$$;
REVOKE ALL ON FUNCTION public.get_treemap_individuals(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_treemap_individuals(uuid) TO service_role;

COMMENT ON FUNCTION public.get_treemap_individuals(uuid) IS
  'FIX-779 — assemble the treemap-individuals `children` jsonb for a scope '
  '(official id, or nil-UUID global sentinel) from treemap_individuals_rollup: '
  'top-50 states by shown-50 total, per-state top-50 leaves. One jsonb value '
  '(cap-proof). The route wraps it with the title.';

-- ── 7. Derived-cleanup trigger (focused scope only; global sentinel is safe) ──
CREATE OR REPLACE FUNCTION public.treemap_individuals_rollup_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.treemap_individuals_rollup WHERE scope_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS treemap_individuals_rollup_cleanup_del ON public.officials;
CREATE TRIGGER treemap_individuals_rollup_cleanup_del
  AFTER DELETE ON public.officials
  FOR EACH ROW
  EXECUTE FUNCTION public.treemap_individuals_rollup_cleanup();

-- ── 8. Weekly pg_cron for the global scope — Tue 08:15 UTC (after Sun FEC) ────
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname = 'treemap-individuals-global-refresh';

SELECT cron.schedule(
  'treemap-individuals-global-refresh',
  '15 8 * * 2',
  $$CALL public.refresh_treemap_individuals_global();$$
);

-- ── 9. Function-grant hygiene (FIX-695/834) ──────────────────────────────────
REVOKE ALL ON FUNCTION public.treemap_individuals_rebuild_officials(uuid[])  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.treemap_individuals_rebuild_officials(uuid[])  TO service_role;
REVOKE ALL ON PROCEDURE public.backfill_treemap_individuals_focused()        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_treemap_individuals_focused()        TO service_role;
REVOKE ALL ON PROCEDURE public.refresh_treemap_individuals_global()          FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.refresh_treemap_individuals_global()          TO service_role;

-- PostgREST: new table + RPC + changed function signature → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
