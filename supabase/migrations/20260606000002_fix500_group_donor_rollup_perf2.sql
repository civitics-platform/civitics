-- FIX-500 (follow-up to 20260606000001) — eliminate the request the prior version
-- spent most of its wall-clock on: the final INSERT's join against the 2.8M-row
-- financial_entities table.
--
-- 20260606000001 pre-filtered to institutional edges (good) but still resolved the
-- donor DISPLAY fields (display_name, entity_type) with a `JOIN financial_entities`
-- inside the INSERT, over the ~520k aggregated cohort-donor rows. Under prod IOWait
-- that inlined agg-subquery + 2.8M-row hash join ran >10min (cancelled).
--
-- This version:
--   1. Carries donor_name / donor_entity_type INTO `_gdr_base` — financial_entities
--      is ALREADY joined there for the institutional filter, so the display fields
--      come for free, before the fan-out. No second pass over financial_entities.
--   2. Materializes `_gdr_agg` as a temp table (ANALYZEd) so the planner has real
--      stats — deterministic hash-join + hash-aggregate, no inlined-subquery
--      misestimate. (Prod-measured: the membership×base aggregate is ~9.5s.)
--   3. The final INSERT then touches only `_gdr_agg` LEFT JOIN the tiny `_gdr_ind`
--      (17,582 industry tags) — no big-table join at write time.
--
-- Net: the heaviest steps are the one `entity_connections`+`financial_entities`
-- institutional scan (~282k rows) and the cohort aggregate — both seconds when prod
-- is not IOWait-saturated. In the GHA rebuild hook the calling session carries a
-- 90-min statement_timeout (the chunk loop sets it), so a slow run still completes;
-- the function proconfig timeout is belt-and-braces for non-pooler callers.

CREATE OR REPLACE FUNCTION public.refresh_group_donor_rollup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cohorts    bigint;
  v_donor_rows bigint;
BEGIN
  SET LOCAL work_mem = '256MB';

  -- Institutional donation edges + donor display fields, resolved once (individuals
  -- and the PAC/Committee placeholder excluded HERE, ahead of the membership fan-out).
  CREATE TEMP TABLE _gdr_base ON COMMIT DROP AS
    SELECT ec.to_id        AS official_id,
           ec.from_id      AS donor_id,
           ec.amount_cents,
           fe.display_name AS donor_name,
           fe.entity_type  AS donor_entity_type
    FROM public.entity_connections ec
    JOIN public.financial_entities fe ON fe.id = ec.from_id
    WHERE ec.connection_type = 'donation'
      AND ec.to_type         = 'official'
      AND ec.from_type       = 'financial_entity'
      AND fe.entity_type    <> 'individual'
      AND fe.display_name NOT ILIKE '%PAC/Committee%';
  CREATE INDEX ON _gdr_base (official_id);
  ANALYZE _gdr_base;

  -- Membership: one row per (gb_id, party_key, official_id). Non-committee members
  -- appear under 'all' AND their own party; committee members under 'all' only (the
  -- route never party-filters committee membership — FIX-139). FIX-470 roster
  -- predicate for non-committee gbs.
  CREATE TEMP TABLE _gdr_membership ON COMMIT DROP AS
    SELECT o.governing_body_id AS gb_id, 'all'::text AS party_key, o.id AS official_id
    FROM public.officials o
    JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
    WHERE gb.type <> 'committee'
      AND o.is_active = true
      AND o.tier = 'elected'
      AND o.governing_body_id IS NOT NULL
    UNION ALL
    SELECT o.governing_body_id, o.party::text, o.id
    FROM public.officials o
    JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
    WHERE gb.type <> 'committee'
      AND o.is_active = true
      AND o.tier = 'elected'
      AND o.governing_body_id IS NOT NULL
      AND o.party IS NOT NULL
    UNION ALL
    SELECT ocm.committee_id, 'all'::text, ocm.official_id
    FROM public.official_committee_memberships ocm
    JOIN public.governing_bodies gb
      ON gb.id = ocm.committee_id AND gb.type = 'committee'
    WHERE ocm.ended_at IS NULL;
  CREATE INDEX ON _gdr_membership (official_id);
  ANALYZE _gdr_membership;

  -- Representative industry label per donor (tiny financial_entity industry set).
  CREATE TEMP TABLE _gdr_ind ON COMMIT DROP AS
    SELECT et.entity_id, MIN(et.display_label) AS sector
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    GROUP BY et.entity_id;
  CREATE INDEX ON _gdr_ind (entity_id);
  ANALYZE _gdr_ind;

  -- Per-(cohort, donor) institutional totals. donor_name / donor_entity_type are
  -- constant per donor_id, carried through with min() so no financial_entities
  -- re-join is needed at insert time.
  CREATE TEMP TABLE _gdr_agg ON COMMIT DROP AS
    SELECT m.gb_id,
           m.party_key,
           b.donor_id,
           min(b.donor_name)        AS donor_name,
           min(b.donor_entity_type) AS donor_entity_type,
           SUM(b.amount_cents)::bigint AS total_cents,
           COUNT(*)::bigint            AS member_count
    FROM _gdr_membership m
    JOIN _gdr_base b ON b.official_id = m.official_id
    GROUP BY m.gb_id, m.party_key, b.donor_id;
  ANALYZE _gdr_agg;

  -- DELETE (not TRUNCATE) so concurrent request-path reads keep the prior snapshot
  -- until commit — no ACCESS EXCLUSIVE lock on the read path during refresh.
  DELETE FROM public.group_donor_rollup;
  DELETE FROM public.group_donor_rollup_summary;

  INSERT INTO public.group_donor_rollup
    (gb_id, party_key, financial_entity_id, donor_name, donor_entity_type, sector,
     total_cents, member_count)
  SELECT a.gb_id,
         a.party_key,
         a.donor_id,
         a.donor_name,
         a.donor_entity_type,
         ind.sector,
         a.total_cents,
         a.member_count
  FROM _gdr_agg a
  LEFT JOIN _gdr_ind ind ON ind.entity_id = a.donor_id;

  -- Summary: ONE row per DISTINCT cohort in the membership set (zero-donor state
  -- gbs included, donor_count=0 — the route's materialized-vs-not disambiguator).
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
    'cohorts',      v_cohorts,
    'donor_rows',   v_donor_rows,
    'refreshed_at', now()
  );
END;
$fn$;

ALTER FUNCTION public.refresh_group_donor_rollup() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.refresh_group_donor_rollup() TO service_role;

COMMENT ON FUNCTION public.refresh_group_donor_rollup() IS
  'FIX-500 — full re-aggregate of the per-cohort donor rollup. Institutional filter '
  'and donor display fields resolved once in _gdr_base ahead of the fan-out; final '
  'INSERT touches no big table. Called at the tail of the twice-weekly '
  'rebuild-entity-connections workflow. Returns {cohorts, donor_rows, refreshed_at}.';
