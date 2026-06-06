-- FIX-500 (follow-up to 20260606000000) — make refresh_group_donor_rollup() fast.
--
-- The first cut aggregated `_gdr_membership JOIN entity_connections` with
-- `agg AS MATERIALIZED` and applied the institutional filter AFTER the SUM —
-- i.e. it fanned the membership set out over ALL 1,728,158 donation-to-official
-- edges (individuals included; ~540k individual donors dominate that set) before
-- discarding them. On the Pro-Small tier that blew the 300s function timeout and
-- rolled back (cleanly — DELETE+INSERT in one txn, so no partial state).
--
-- Result-identical fix: filter to institutional donors FIRST. An individual /
-- PAC-Committee-placeholder donor contributes nothing to any institutional cohort
-- total whether dropped before or after the SUM, so pre-filtering is exact, not
-- approximate. Prod measured (2026-06-06):
--   donation-to-official edges (all donors): 1,728,158
--   institutional-only edges:                  282,449   (6x smaller)
-- With a `_base` temp of just the 282k institutional edges (indexed + ANALYZEd so
-- the planner hash-joins), the whole refresh runs in ~15-25s end-to-end:
--   _base build 2s · membership 0.4s · cohort aggregate (→519,886 rows) 9.5s · the
--   financial_entities display join + insert a few s more.
--
-- Shape notes:
--   * Institutional filter (entity_type <> 'individual' AND display_name NOT ILIKE
--     '%PAC/Committee%') is applied once, building `_base` — identical predicate to
--     the route's JS skips, just hoisted ahead of the fan-out.
--   * `_ind` precomputes the representative industry label per donor from the tiny
--     financial_entity industry-tag set (17,582 rows on prod) — one scan, not a
--     per-row lookup.
--   * SET LOCAL work_mem keeps the cohort hash-aggregate in memory.
--   * CREATE OR REPLACE FUNCTION reassigns ALL function properties, so the inline
--     `SET search_path` must be restated and the statement_timeout GUC re-applied
--     via ALTER FUNCTION below (proconfig would otherwise reset to default).

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
  -- Keep the cohort hash-aggregate (≈520k rows) in memory rather than spilling.
  SET LOCAL work_mem = '256MB';

  -- _base: institutional donation edges only (individuals + the PAC/Committee
  -- placeholder excluded HERE, ahead of the membership fan-out). One scan.
  CREATE TEMP TABLE _gdr_base ON COMMIT DROP AS
    SELECT ec.to_id   AS official_id,
           ec.from_id AS donor_id,
           ec.amount_cents
    FROM public.entity_connections ec
    JOIN public.financial_entities fe ON fe.id = ec.from_id
    WHERE ec.connection_type = 'donation'
      AND ec.to_type         = 'official'
      AND ec.from_type       = 'financial_entity'
      AND fe.entity_type    <> 'individual'
      AND fe.display_name NOT ILIKE '%PAC/Committee%';
  CREATE INDEX ON _gdr_base (official_id);
  ANALYZE _gdr_base;

  -- Membership: one row per (gb_id, party_key, official_id). Each non-committee
  -- member appears under 'all' AND under their own party (Senate-Dems-type presets);
  -- committee members under 'all' only (the route never party-filters committee
  -- membership — FIX-139). FIX-470 roster predicate for non-committee gbs.
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

  -- Representative industry label per donor (entity_tags industry set is tiny).
  CREATE TEMP TABLE _gdr_ind ON COMMIT DROP AS
    SELECT et.entity_id, MIN(et.display_label) AS sector
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    GROUP BY et.entity_id;
  CREATE INDEX ON _gdr_ind (entity_id);
  ANALYZE _gdr_ind;

  -- DELETE (not TRUNCATE) so concurrent request-path reads keep the prior snapshot
  -- until this transaction commits — no ACCESS EXCLUSIVE lock on the read path.
  DELETE FROM public.group_donor_rollup;
  DELETE FROM public.group_donor_rollup_summary;

  -- Per-(cohort, donor) institutional totals, then join financial_entities for the
  -- stored display fields (no further filtering — _base is already institutional).
  INSERT INTO public.group_donor_rollup
    (gb_id, party_key, financial_entity_id, donor_name, donor_entity_type, sector,
     total_cents, member_count)
  SELECT a.gb_id,
         a.party_key,
         a.donor_id,
         fe.display_name,
         fe.entity_type,
         ind.sector,
         a.total_cents,
         a.member_count
  FROM (
    SELECT m.gb_id,
           m.party_key,
           b.donor_id,
           SUM(b.amount_cents)::bigint AS total_cents,
           COUNT(*)::bigint            AS member_count
    FROM _gdr_membership m
    JOIN _gdr_base b ON b.official_id = m.official_id
    GROUP BY m.gb_id, m.party_key, b.donor_id
  ) a
  JOIN public.financial_entities fe ON fe.id = a.donor_id
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

-- Re-apply the function-level statement_timeout GUC (CREATE OR REPLACE reset the
-- function's proconfig to only the inline SET search_path above). 300s mirrors
-- get_official_donor_rollup(); the measured refresh is ~15-25s, so this is headroom.
ALTER FUNCTION public.refresh_group_donor_rollup() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.refresh_group_donor_rollup() TO service_role;

COMMENT ON FUNCTION public.refresh_group_donor_rollup() IS
  'FIX-500 — full re-aggregate of the per-cohort donor rollup. Filters to '
  'institutional donors BEFORE the membership fan-out (result-identical, ~6x less '
  'work than post-filtering). Called at the tail of the twice-weekly '
  'rebuild-entity-connections workflow. Returns {cohorts, donor_rows, refreshed_at}.';
