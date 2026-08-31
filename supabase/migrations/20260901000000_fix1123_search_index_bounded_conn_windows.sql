-- 20260901000000_fix1123_search_index_bounded_conn_windows.sql
--
-- FIX-1123 — the entity-search-index stage build becomes 16 memory-bounded
-- windows, inheriting the FIX-1115 pattern.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT HAPPENED (2026-08-31, the second kill in 48 hours)
--
-- jobid 9 `refresh-derived-mvs-daily` fired at 06:00:00 UTC. Units 1-8 finished
-- in 274.8 s — `official_homepage_stats_mv` took 253.9 s, which is INSIDE its
-- normal 178-383 s envelope and FASTER than the 337.5 s it took the day before.
-- Unit 9, `rebuild_entity_search_index`, then ran for 21,638.3 s — six hours and
-- thirty-eight seconds — and was ended not by any guard but by the `postgres`
-- role's `statement_timeout=6h`. Per-unit timings are from the run's own
-- data_sync_log row (refresh_derived_mvs writes `unit_seconds` for every
-- outcome, FIX-1021); the envelope is the same field over the preceding 18 days.
--
-- The unit's normal cost is 118-287 s. 21,638 s is 75-180x that, and
-- entity_connections grew 0.6% (10,435,594 -> 10,503,011 reltuples) between the
-- 08-29 kill and this one. Volume growth does not explain it. Two defects do.
--
-- DEFECT 1 — the stage build's group estimate is the no-statistics fallback.
-- `EXPLAIN` of the `_conn` build on prod:
--
--     Partial HashAggregate  (cost=994411.68..994413.68 rows=200 width=24)
--       Group Key: entity_connections.from_id
--       ->  Parallel Append  (cost=0.00..932629.26 rows=12356484 width=16)
--
-- `rows=200` is the planner's default when it cannot estimate a group count —
-- the GROUP BY sits over a UNION ALL of two different columns, so neither
-- column's n_distinct is reachable. The true count is 3,225,903 (measured on the
-- clone). The node is therefore planned as if it were free and sized for
-- nothing, and what it actually does at runtime depends on whether the real
-- millions of groups happen to fit. That is why this unit is BIMODAL rather than
-- trending: 118-287 s when it fits, 1013 s on 08-18, hung on 08-29, 21,638 s
-- here. It is not a curve anyone could have watched.
--
-- DEFECT 2 — nothing bounded it. Prod carries work_mem=256MB and
-- hash_mem_multiplier=2, so that ONE node is permitted 512MB per process, and
-- with max_parallel_workers_per_gather=1 that is leader plus one worker: 1024MB
-- for a single hash aggregate, against a ~2.18GB commit limit with
-- shared_buffers already holding 256MB. Measured on the clone at 62% of prod's
-- row count, one worker's HashAggregate peaked at 270,369kB — already ABOVE the
-- 256MB work_mem, because hash_mem_multiplier permits it — with a 201,889kB Sort
-- stacked on top in the same process.
--
-- The function's own `SET statement_timeout = '1200s'` did not fire, and could
-- not have. A function-level proconfig timeout is INERT: the timer is armed once
-- when the top-level statement begins and changing the GUC mid-statement does
-- not re-arm it. Verified on this PG 17:
--
--     CREATE FUNCTION _t() RETURNS int LANGUAGE plpgsql
--       SET statement_timeout = '1s'
--       AS $x$ BEGIN PERFORM pg_sleep(3); RETURN 1; END; $x$;
--     SET statement_timeout = '60s';
--     SELECT _t();            -- returns 1. Does not error.
--     -- and current_setting('statement_timeout') INSIDE the body reads '1s'.
--
-- The value is applied; the timer is not. This is the same PG 17 behaviour
-- FIX-703 recorded for procedures, which had never been generalised to
-- functions. work_mem is different in kind — it is read per-node at execution
-- time, not armed once — which is why the bound below is a REAL bound where the
-- timeout was decorative. The 1200s proconfig is left in place and labelled
-- rather than removed: 89 public functions carry the same inert pattern and
-- sweeping them is FIX-1128, not this commit.
--
-- FIX-1030's per-unit watchdog could not save it either. It succeeded at
-- 06:00:00, 06:02:00 and 06:04:00, then every firing from 06:06:00 to 12:05:08
-- failed with `job startup timeout` — pg_cron unable to fork a worker on a box
-- with no memory to give it. The guard was starved out ninety seconds after the
-- unit it exists to cancel began. That is FIX-1125 and it stays open.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIX — the FIX-1115 pattern, applied to the same table by the same indexes.
--
-- entity_search_conn_window() aggregates ONE uuid range. Both branches are
-- covered by (from_id, connection_type) and (to_id, connection_type), so each is
-- an Index Only Scan; the range predicate bounds the group count to roughly a
-- sixteenth; and the function's proconfig pins work_mem to 64MB and
-- max_parallel_workers_per_gather to 0, so the node runs in exactly ONE process
-- with a hard ceiling of 64MB x hash_mem_multiplier 2 = 128MB. Against the
-- 1024MB the old shape was permitted, that is an 8x reduction, and it is a
-- single number rather than a number multiplied by however many workers the
-- planner chose that morning.
--
-- The windows partition the group key itself: an entity_id belongs to exactly
-- one range, and within that range the window sees ALL of its from_id rows and
-- ALL of its to_id rows. So each entity is emitted once, with its complete
-- count, by exactly one window — the union of the sixteen is row-for-row the old
-- single aggregate. Bounds are the canonical 16 from FIX-687.
--
-- A SQL function carrying a SET clause cannot be inlined, so the proconfig
-- cannot be optimised away.
--
-- Also here:
--   * the ~2.4M-row comment FIX-748 shipped in 2026-07 is corrected to the live
--     figure it has been wrong about by 4.4x since;
--   * refresh-derived-mvs-daily gets the cron_job_budget row it has never had.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The bounded window.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.entity_search_conn_window(
  p_lo uuid,
  p_hi uuid                      -- NULL = open-ended (the last window)
)
RETURNS TABLE (entity_id uuid, c int)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
SET work_mem = '64MB'
SET max_parallel_workers_per_gather = 0
AS $$
  SELECT sub.id, count(*)::int
    FROM (
      -- Covered by (from_id, connection_type) and (to_id, connection_type)
      -- respectively, so both branches are Index Only Scans.
      SELECT from_id AS id
        FROM public.entity_connections
       WHERE from_id >= p_lo AND (p_hi IS NULL OR from_id < p_hi)
      UNION ALL
      SELECT to_id   AS id
        FROM public.entity_connections
       WHERE to_id   >= p_lo AND (p_hi IS NULL OR to_id   < p_hi)
    ) sub
   GROUP BY sub.id;
$$;

REVOKE ALL ON FUNCTION public.entity_search_conn_window(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.entity_search_conn_window(uuid, uuid) IS
  'FIX-1123 — per-entity connection degree for ONE uuid window, for '
  'rebuild_entity_search_index''s _conn stage table. Replaces a whole-table '
  'HashAggregate whose group estimate was the planner''s no-statistics fallback '
  '(rows=200 against 3,225,903 actual) and which prod permitted 1024MB across '
  'leader and worker at work_mem=256MB with hash_mem_multiplier=2. That node ran '
  '21,638 s on 2026-08-31 and was ended by the role''s 6h statement_timeout, not '
  'by any guard. Windowing lets both branches use the covering (from_id, '
  'connection_type) and (to_id, connection_type) indexes and bounds the group '
  'count to ~1/16; work_mem=64MB with max_parallel_workers_per_gather=0 makes the '
  'ceiling one process x 128MB. Windows partition the group key, so the union of '
  'the sixteen is row-for-row identical to the single aggregate it replaces.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. rebuild_entity_search_index() — stage build windowed; everything else
--    byte-identical to FIX-748 / FIX-667 / FIX-699 as it stands today.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_entity_search_index()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
-- INERT — kept for the record, not as a guard. A function-level
-- statement_timeout does not re-arm the timer armed when the top-level statement
-- began, so this has never bounded anything; on 2026-08-31 this function ran
-- 21,638 s under it. The real bound is now the per-window memory ceiling below,
-- plus FIX-1030's external watchdog. Sweeping the 89 functions that carry this
-- pattern is FIX-1128.
SET statement_timeout = '1200s'
AS $$
DECLARE
  v_count integer;
  -- FIX-687's canonical 16. uuid v4 keys distribute evenly across them.
  c_bounds uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  i    int;
  v_lo uuid;
  v_hi uuid;
BEGIN
  -- Per-statement memory for the GIN builds on the INSERTs below. The _conn
  -- stage no longer runs under this: entity_search_conn_window() carries its own
  -- 64MB proconfig, which is what actually bounds the aggregate (FIX-1123).
  SET LOCAL work_mem = '256MB';

  -- ── Shared derivations (built once) ──
  --
  -- FIX-1123 — sixteen bounded windows instead of one whole-table
  -- HashAggregate over a UNION ALL of both id columns. Each window is its own
  -- statement, so the memory ceiling is per-window and a future cardinality
  -- spills one window's worth rather than the box. entity_connections is
  -- 10,503,011 rows / 7,473 MB on prod as of 2026-08-31 — the ~2.4M in FIX-748's
  -- header was true when it shipped 2026-07-06 and has been 4.4x wrong since.
  CREATE TEMP TABLE _conn (entity_id uuid, c int) ON COMMIT DROP;
  FOR i IN 1 .. 16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    INSERT INTO _conn (entity_id, c)
    SELECT w.entity_id, w.c
      FROM public.entity_search_conn_window(v_lo, v_hi) w;
  END LOOP;
  CREATE UNIQUE INDEX ON _conn (entity_id);
  -- The old build was a CTAS, which leaves no statistics behind either; the
  -- INSERT path is the same. ANALYZE so the eight INSERTs below join against a
  -- real row count rather than a default guess.
  ANALYZE _conn;

  CREATE TEMP TABLE _off_committees ON COMMIT DROP AS
    SELECT official_id, array_agg(DISTINCT committee_id) AS committee_ids
    FROM public.official_committee_memberships
    WHERE ended_at IS NULL
    GROUP BY official_id;
  CREATE UNIQUE INDEX ON _off_committees (official_id);

  -- one primary industry slug per financial entity (deterministic pick)
  CREATE TEMP TABLE _fe_industry ON COMMIT DROP AS
    SELECT DISTINCT ON (entity_id) entity_id, tag
    FROM public.entity_tags
    WHERE entity_type = 'financial_entity' AND tag_category = 'industry'
    ORDER BY entity_id, tag;
  CREATE UNIQUE INDEX ON _fe_industry (entity_id);

  TRUNCATE public.entity_search_index;

  -- ── official ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, photo_url, search_tsv, is_synthetic,
    jurisdiction_level, state, party, chamber, status, committee_ids,
    amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'official', o.id, o.full_name, o.role_title, o.photo_url,
    to_tsvector('english', coalesce(o.full_name,'') || ' ' || coalesce(o.role_title,'')),
    coalesce(o.is_synthetic, false),
    CASE lower(coalesce(j.type::text, oj.type::text))
      WHEN 'country' THEN 'federal'
      WHEN 'state'   THEN 'state'
      WHEN 'county'  THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL
    END,
    o.metadata->>'state',
    o.party::text,
    CASE WHEN o.role_title = 'Senator' THEN 'senate'
         WHEN o.role_title ILIKE 'Representative%' THEN 'house' ELSE NULL END,
    'active',
    oc.committee_ids,
    o.total_received_cents,
    CASE WHEN o.total_received_cents IS NOT NULL THEN 'received' ELSE NULL END,
    coalesce(cn.c, 0),
    o.updated_at,
    CASE WHEN o.source_ids ? 'congress_gov' OR o.source_ids ? 'bioguide_id' THEN 'congress.gov'
         WHEN o.source_ids ? 'openstates' THEN 'openstates' ELSE NULL END,
    now()
  FROM public.officials o
  LEFT JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
  LEFT JOIN public.jurisdictions j     ON j.id = gb.jurisdiction_id
  LEFT JOIN public.jurisdictions oj    ON oj.id = o.jurisdiction_id
  LEFT JOIN _conn cn                    ON cn.entity_id = o.id
  LEFT JOIN _off_committees oc          ON oc.official_id = o.id
  WHERE o.is_active;

  -- ── proposal (non-initiative) ───────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, proposal_type, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'proposal', p.id, p.title, p.type::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.type::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, p.type::text,
    NULL, NULL, coalesce(cn.c, 0),
    p.introduced_at::timestamptz,
    CASE WHEN p.type::text = 'regulation' THEN 'regulations.gov' ELSE 'congress.gov' END,
    now()
  FROM public.proposals p
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type <> 'initiative';

  -- ── initiative ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, initiative_stage, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'initiative', p.id, p.title, id2.stage::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(id2.stage::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, id2.stage::text,
    coalesce(cn.c, 0), p.created_at, 'civitics', now()
  FROM public.proposals p
  LEFT JOIN public.initiative_details id2 ON id2.proposal_id = p.id
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type = 'initiative';

  -- ── agency ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    agency_type, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'agency', a.id, a.name, a.acronym,
    to_tsvector('english', coalesce(a.name,'') || ' ' || coalesce(a.acronym,'')),
    coalesce(a.is_synthetic, false),
    a.agency_type, 'active', coalesce(cn.c, 0), a.updated_at, NULL, now()
  FROM public.agencies a
  LEFT JOIN _conn cn ON cn.entity_id = a.id
  WHERE a.is_active;

  -- ── financial (non-individual) — FIX-667 amount precedence ──────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    financial_type, industry, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'financial', f.id, f.display_name, f.entity_type,
    to_tsvector('english', coalesce(f.display_name,'') || ' ' || coalesce(f.entity_type,'')),
    coalesce(f.is_synthetic, false),
    f.entity_type, fi.tag,
    amt.amount_cents, amt.amount_label,
    coalesce(cn.c, 0),
    f.created_at,   -- FIX-699: updated_at is stale (lost trigger) — created_at is the defensible column
    CASE WHEN amt.amount_label IN ('contract','grant') THEN 'usaspending' ELSE 'fec' END,
    now()
  FROM public.financial_entities f
  LEFT JOIN _conn cn ON cn.entity_id = f.id
  LEFT JOIN _fe_industry fi ON fi.entity_id = f.id
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN ie > 0 THEN ie
           WHEN spend > 0 AND f.entity_type IN ('corporation','organization') THEN spend
           ELSE don END AS amount_cents,
      CASE WHEN ie > 0 THEN 'independent_expenditure'
           WHEN spend > 0 AND f.entity_type IN ('corporation','organization')
             THEN CASE WHEN contract_c >= grant_c THEN 'contract' ELSE 'grant' END
           ELSE 'donation' END AS amount_label
    FROM (SELECT
            coalesce(f.total_ie_support_cents,0) + coalesce(f.total_ie_oppose_cents,0) AS ie,
            coalesce(f.total_contract_cents,0)   + coalesce(f.total_grant_cents,0)     AS spend,
            coalesce(f.total_contract_cents,0)   AS contract_c,
            coalesce(f.total_grant_cents,0)      AS grant_c,
            coalesce(f.total_donated_cents,0)    AS don) v
  ) amt
  WHERE f.entity_type <> 'individual';

  -- ── jurisdiction ────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'jurisdiction', jr.id, jr.name, jr.type::text,
    to_tsvector('english', coalesce(jr.name,'') || ' ' || coalesce(jr.short_name,'')),
    coalesce(jr.is_synthetic, false),
    CASE lower(jr.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    'active', coalesce(cn.c, 0), jr.updated_at, 'census', now()
  FROM public.jurisdictions jr
  LEFT JOIN _conn cn ON cn.entity_id = jr.id
  WHERE jr.is_active;

  -- ── institution (governing bodies) ──────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, institution_type, status, connection_count, activity_at, refreshed_at)
  SELECT
    'institution', g.id, g.name, g.type::text,
    to_tsvector('english', coalesce(g.name,'') || ' ' || coalesce(g.short_name,'')),
    coalesce(g.is_synthetic, false),
    CASE lower(gj.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    g.type::text, 'active', coalesce(cn.c, 0), g.updated_at, now()
  FROM public.governing_bodies g
  LEFT JOIN public.jurisdictions gj ON gj.id = g.jurisdiction_id
  LEFT JOIN _conn cn ON cn.entity_id = g.id
  WHERE g.is_active;

  -- ── meeting ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, connection_count, activity_at, refreshed_at)
  SELECT
    'meeting', m.id, m.title, m.meeting_type,
    to_tsvector('english', coalesce(m.title,'') || ' ' || coalesce(m.meeting_type,'')),
    false,  -- meetings have no is_synthetic column
    m.status, coalesce(cn.c, 0), m.scheduled_at, now()
  FROM public.meetings m
  LEFT JOIN _conn cn ON cn.entity_id = m.id
  WHERE m.title IS NOT NULL;

  -- ── facet rollup ──
  PERFORM public.rebuild_browse_facet_counts();

  SELECT count(*) INTO v_count FROM public.entity_search_index;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.rebuild_entity_search_index() IS
  'Full idempotent rebuild of entity_search_index. FIX-1123: the _conn stage is '
  'built by 16 bounded entity_search_conn_window() calls instead of one '
  'whole-table HashAggregate — that node was permitted 1024MB across leader and '
  'worker on prod and ran 21,638 s on 2026-08-31 before the role''s 6h '
  'statement_timeout ended it, taking the REST API down for the day. NOTE the '
  'function-level statement_timeout=1200s is INERT (a proconfig cannot re-arm a '
  'timer already armed by the top-level statement; verified on PG 17) and is not '
  'a guard — see FIX-1128.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The budget row refresh-derived-mvs-daily has never had.
--
--    HONEST SCOPE: enforce_cron_job_budgets() runs as its own pg_cron job, so it
--    needs to FORK to act. On 2026-08-31 it could not — every firing from
--    06:06:00 to 12:05:08 failed with `job startup timeout`, which is the same
--    starvation the budget exists to end. This row covers the slow-degradation
--    case (a job drifting past its envelope while the box can still fork) and
--    does NOT cover the case that actually happened. FIX-1125 stays open.
--
--    5400s sits above refresh_derived_mvs' own 3300s predictive budget — which
--    is checked BETWEEN units and so cannot bound a single unit, exactly the hole
--    unit 9 fell through — and far below the 6h that was the only real ceiling.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES (
  'refresh-derived-mvs-daily',
  5400,
  'FIX-1123. Healthy elapsed 360-810s over 08-13..08-30; 1350s on 08-18. '
  'Backstop ABOVE the procedure''s own 3300s predictive budget, which is checked '
  'between units and cannot bound one. 2026-08-31: 21,920s elapsed, 21,638s of it '
  'in unit 9 rebuild_entity_search_index, ended by the role''s 6h '
  'statement_timeout. Cannot fire under fork starvation — see FIX-1125.'
)
ON CONFLICT (jobname) DO UPDATE
  SET budget_seconds = EXCLUDED.budget_seconds,
      note           = EXCLUDED.note,
      updated_at     = now();

COMMIT;
