-- FIX-500 — per-cohort donor rollup materialization for the graph group route.
--
-- Closes the reopened FIX-499. FIX-497 made the group route fail closed and
-- added the covering index; FIX-499 proved the residual is row VOLUME (keyset
-- 73x worse; the live aggregate get_group_donor_totals() runs 0.7-4.5s warm but
-- spikes 12-25s+ cold/under load on the IOWait-bound Pro-Small tier — over the
-- route's 8s budget). That is the project's "materialize when a request-path
-- aggregation can't hold p95" trigger (packages/db/CLAUDE.md). This pre-aggregates
-- donor totals per cohort OFF the request path so the read is a single indexed
-- select.
--
-- Cohorts materialized = exactly the UI's materializable shapes (FIX-500 decision 1):
--   * a governing body                → party_key = 'all'
--   * a gb + party preset (Senate Dems…) → party_key = <officials.party enum value>
--   * a committee (FIX-139 membership)  → party_key = 'all' (the route never filters
--                                         committee membership by party)
-- Custom/state-filter/PAC-industry cohorts are NOT materialized — they stay on the
-- live OFFSET path (decision 6), which is adequate for their smaller volumes.
--
-- TABLE, not MATERIALIZED VIEW (decision 2 left this to implementation): the cohort
-- set is a UNION of two different membership predicates (roster vs committee join)
-- and we must persist a SUMMARY ROW for every cohort — including zero-donor state
-- gbs — as the route's "materialized vs not" disambiguator. A refresh function
-- writing per-cohort rows expresses that cleanly; one giant MV cannot emit a
-- present-but-empty summary row for a cohort that aggregated to zero donor rows.
--
-- Shape decisions mirror the FIX-499 RPC's load-bearing choices so the refresh
-- numbers match the route's prior live JS filter EXACTLY:
--   * agg AS MATERIALIZED — reduce to per-donor rows BEFORE the financial_entities
--     join (inlined CTE timed out at 25s on prod; MATERIALIZED ~1s).
--   * fe.entity_type <> 'individual' (NOT NULL on prod) and
--     fe.display_name NOT ILIKE '%PAC/Committee%' applied AFTER the aggregation —
--     identical to the route's `info.entityType === 'individual'` /
--     `/PAC\/Committee/i` JS skips.
--
-- Refresh cadence: hooked at the TAIL of the twice-weekly (Sun+Wed 08:00 UTC)
-- rebuild-entity-connections workflow — donation edges only change when
-- rebuild_entity_connections runs, so there is no value refreshing more often and
-- no new cron. Incremental recurring cost ≈ ONE aggregation pass over the donation
-- edges twice a week (Craig is cost-sensitive about recurring compute).

-- ── Relations ────────────────────────────────────────────────────────────────

-- Per-donor rollup rows. The read path is a zero-join, zero-sort indexed select:
--   WHERE gb_id=? AND party_key=? ORDER BY total_cents DESC LIMIT n
CREATE TABLE IF NOT EXISTS public.group_donor_rollup (
  gb_id               UUID    NOT NULL,
  party_key           TEXT    NOT NULL,   -- 'all' or an officials.party enum value
  financial_entity_id UUID    NOT NULL,
  donor_name          TEXT,
  donor_entity_type   TEXT,
  sector              TEXT,               -- representative industry label (entity_tags)
  total_cents         BIGINT  NOT NULL,
  member_count        BIGINT  NOT NULL,   -- # of cohort members this donor gave to
  PRIMARY KEY (gb_id, party_key, financial_entity_id)
);

-- Drives the request-path read: leading (gb_id, party_key) equality + total_cents
-- DESC means the top-N read is an index-only range scan, no Sort node.
CREATE INDEX IF NOT EXISTS group_donor_rollup_read_idx
  ON public.group_donor_rollup (gb_id, party_key, total_cents DESC);

-- Per-cohort summary. ONE row per materialized cohort — its PRESENCE is the
-- route's disambiguator: row present + donor_count=0 → genuine zero donors (state
-- gbs; FEC is federal-only); row ABSENT → cohort not materialized → route falls
-- back to the live OFFSET path. "Not materialized" must NEVER render as "no donors".
-- donor_count is the TRUE count (what the FIX-499 1000-row SETOF cap broke);
-- total_cents is the full-cohort institutional total; refreshed_at is the staleness
-- signal.
CREATE TABLE IF NOT EXISTS public.group_donor_rollup_summary (
  gb_id        UUID        NOT NULL,
  party_key    TEXT        NOT NULL,
  donor_count  BIGINT      NOT NULL,
  total_cents  BIGINT      NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gb_id, party_key)
);

-- RLS posture (decision 9): service-role only. The graph group route reads via
-- createAdminClient (service_role, which BYPASSRLS). RLS is enabled with NO
-- policies so anon / publishable-key reads return an empty set BY DESIGN — these
-- are internal aggregation surfaces, not a public anon endpoint. This is the known
-- project trap (publishable-key reads silently zero under RLS-no-policy) used here
-- DELIBERATELY to keep the rollup service-role-only without a per-row grant dance.
ALTER TABLE public.group_donor_rollup         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_donor_rollup_summary ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON public.group_donor_rollup         TO service_role;
GRANT SELECT, INSERT, DELETE ON public.group_donor_rollup_summary TO service_role;

COMMENT ON TABLE public.group_donor_rollup IS
  'FIX-500 — per-cohort institutional donor rollup for the graph group route. One '
  'row per (gb_id, party_key, financial_entity_id). Refreshed by '
  'refresh_group_donor_rollup() at the tail of the twice-weekly '
  'rebuild-entity-connections workflow. Read path: indexed top-N by total_cents.';
COMMENT ON TABLE public.group_donor_rollup_summary IS
  'FIX-500 — per-cohort summary. Row PRESENCE = "cohort is materialized"; '
  'donor_count=0 with a present row = genuine zero (state gbs). Row ABSENT = route '
  'falls back to the live OFFSET path. donor_count is the TRUE count the FIX-499 '
  '1000-row SETOF cap could not return.';

-- ── Refresh function ─────────────────────────────────────────────────────────
-- Full re-aggregate per call (decision: incremental is out of scope at this scale).
-- plpgsql so the temp-table build + multi-statement body compose; SECURITY DEFINER
-- + 300s statement_timeout mirror get_official_donor_rollup() (the precedent for an
-- aggregation RPC over a >1M-row table on the Pro-Small tier).
CREATE OR REPLACE FUNCTION public.refresh_group_donor_rollup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cohorts   bigint;
  v_donor_rows bigint;
BEGIN
  -- Membership set: one row per (gb_id, party_key, official_id). Each non-committee
  -- member appears under 'all' AND under their own party (so Senate-Dems-type
  -- presets get a party_key cohort). Committee members appear under 'all' only —
  -- the route's committee branch never filters membership by party (FIX-139).
  CREATE TEMP TABLE _gdr_membership ON COMMIT DROP AS
    -- non-committee gbs, party_key='all' — FIX-470 roster predicate
    SELECT o.governing_body_id AS gb_id, 'all'::text AS party_key, o.id AS official_id
    FROM public.officials o
    JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
    WHERE gb.type <> 'committee'
      AND o.is_active = true
      AND o.tier = 'elected'
      AND o.governing_body_id IS NOT NULL
    UNION ALL
    -- non-committee gbs, per-party — party_key = the officials.party enum text,
    -- exactly what the route matches via .eq("party", <url param>)
    SELECT o.governing_body_id, o.party::text, o.id
    FROM public.officials o
    JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
    WHERE gb.type <> 'committee'
      AND o.is_active = true
      AND o.tier = 'elected'
      AND o.governing_body_id IS NOT NULL
      AND o.party IS NOT NULL
    UNION ALL
    -- committee gbs, party_key='all' — active-membership join (ended_at IS NULL)
    SELECT ocm.committee_id, 'all'::text, ocm.official_id
    FROM public.official_committee_memberships ocm
    JOIN public.governing_bodies gb
      ON gb.id = ocm.committee_id AND gb.type = 'committee'
    WHERE ocm.ended_at IS NULL;

  CREATE INDEX ON _gdr_membership (official_id);
  ANALYZE _gdr_membership;

  -- DELETE (not TRUNCATE) so concurrent request-path reads keep seeing the prior
  -- snapshot until this function's transaction commits — no ACCESS EXCLUSIVE lock
  -- on the read path during the refresh.
  DELETE FROM public.group_donor_rollup;
  DELETE FROM public.group_donor_rollup_summary;

  -- Per-donor rollup rows. agg AS MATERIALIZED reduces to per-(cohort,donor) rows
  -- BEFORE the financial_entities join (load-bearing; see header). Institutional-only
  -- filter applied AFTER the aggregate, mirroring the route's JS skips exactly.
  WITH agg AS MATERIALIZED (
    SELECT m.gb_id,
           m.party_key,
           ec.from_id           AS fid,
           SUM(ec.amount_cents) AS total_cents,
           COUNT(*)             AS member_ct
    FROM _gdr_membership m
    JOIN public.entity_connections ec
      ON ec.to_id           = m.official_id
     AND ec.to_type         = 'official'
     AND ec.from_type       = 'financial_entity'
     AND ec.connection_type = 'donation'
    GROUP BY m.gb_id, m.party_key, ec.from_id
  ),
  ind AS (
    -- One representative industry label per donor (matches chord_industry_flows_mv's
    -- MIN(display_label) collapse — a donor can carry multiple industry tags).
    SELECT et.entity_id, MIN(et.display_label) AS sector
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    GROUP BY et.entity_id
  )
  INSERT INTO public.group_donor_rollup
    (gb_id, party_key, financial_entity_id, donor_name, donor_entity_type, sector,
     total_cents, member_count)
  SELECT a.gb_id,
         a.party_key,
         a.fid,
         fe.display_name,
         fe.entity_type,
         ind.sector,
         a.total_cents::bigint,
         a.member_ct::bigint
  FROM agg a
  JOIN public.financial_entities fe ON fe.id = a.fid
  LEFT JOIN ind ON ind.entity_id = a.fid
  WHERE fe.entity_type <> 'individual'
    AND fe.display_name NOT ILIKE '%PAC/Committee%';

  -- Summary: ONE row per DISTINCT cohort in the membership set (so zero-donor state
  -- gbs get a present row with donor_count=0 — the disambiguator). LEFT JOIN the
  -- per-cohort aggregate of the rows we just inserted; COALESCE the zero case.
  INSERT INTO public.group_donor_rollup_summary
    (gb_id, party_key, donor_count, total_cents, refreshed_at)
  SELECT c.gb_id,
         c.party_key,
         COALESCE(r.donor_count, 0),
         COALESCE(r.total_cents, 0),
         now()
  FROM (SELECT DISTINCT gb_id, party_key FROM _gdr_membership) c
  LEFT JOIN (
    SELECT gb_id, party_key,
           COUNT(*)         AS donor_count,
           SUM(total_cents) AS total_cents
    FROM public.group_donor_rollup
    GROUP BY gb_id, party_key
  ) r ON r.gb_id = c.gb_id AND r.party_key = c.party_key;

  SELECT count(*) INTO v_cohorts    FROM public.group_donor_rollup_summary;
  SELECT count(*) INTO v_donor_rows FROM public.group_donor_rollup;

  RETURN jsonb_build_object(
    'cohorts',     v_cohorts,
    'donor_rows',  v_donor_rows,
    'refreshed_at', now()
  );
END;
$fn$;

ALTER FUNCTION public.refresh_group_donor_rollup() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.refresh_group_donor_rollup() TO service_role;

COMMENT ON FUNCTION public.refresh_group_donor_rollup() IS
  'FIX-500 — full re-aggregate of the per-cohort donor rollup. Called at the tail '
  'of the twice-weekly rebuild-entity-connections workflow (donation edges only '
  'change when rebuild_entity_connections runs). Returns {cohorts, donor_rows, '
  'refreshed_at}. DELETE+INSERT in one transaction so readers never block.';
