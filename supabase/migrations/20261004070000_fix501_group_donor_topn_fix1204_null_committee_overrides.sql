-- 20261004070000_fix501_group_donor_topn_fix1204_null_committee_overrides.sql
--
-- ONE FILE, TWO CONCERNS (cc-187 M2 — one gated prod push, both small):
--   §A  FIX-501  — refresh_group_donor_rollup() stores the top 200 donors per
--                  (gb_id, party_key); the summary keeps the TRUE totals.
--   §B  FIX-1204 — PCMA and NRA PVF join the industry overrides on the uuid
--                  arm (806 → 808); the two synthetic rows are excluded.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §A  FIX-501 — top-N storage for group_donor_rollup
-- ═══════════════════════════════════════════════════════════════════════════
-- The only reader of the stored donor rows is /api/graph/group
-- (readGroupDonorRollup): `.order("total_cents", desc).limit(limit)` with
-- limit clamped to ≤ 100 (default 25). The route's donor COUNT and TOTAL come
-- from group_donor_rollup_summary. Every other reference by grep (rule 122) is a
-- writer — merge-cross-source-fe-collisions DELETEs by financial_entity_id,
-- merge-unicameral-legislatures re-keys gb_id — and no view depends on the table
-- (pg_depend, prod 2026-10-04 01:48 UTC). So nothing reads past rank 100.
--
-- Prod 2026-10-04 01:48 UTC: 543,815 rows across 238 donor-bearing cohorts
-- (581 summary rows; the rest are zero-donor cohorts), max 5,999 per cohort,
-- p50 2,264, p95 3,387; 236 cohorts hold more than 200. Σ total_cents
-- 2,672,434,174,177 in both tables. Top 200 per cohort = 47,208 rows (−91%).
-- Weekly walls (group-donor-rollup-refresh, 10 3 * * 3): 09-09 56 s, 09-16
-- 4 m 54 s, 09-23 1 m 41 s, 09-30 1 m 50 s.
--
-- THE TREE CONTRADICTED ONE PREMISE (cc-187 report §4): the summary was NOT
-- independent of the stored rows — it aggregated public.group_donor_rollup.
-- Cutting the stored rows alone would have cut the route's "N donors / $X"
-- to the top 200. So the summary now aggregates _gdr_agg, the full per-donor
-- set it was always a function of; today the two are row-for-row identical, so
-- every summary value is unchanged (the clone rehearsal checks all 581).
--
-- rule 34 — prod's body (0 lines differ from 20260927020000_fix918), +12/−3 by
-- diff (5 of the 12 are comments), two edits and nothing else: the
-- group_donor_rollup INSERT reads _gdr_agg through a
-- ROW_NUMBER() window (ORDER BY total_cents DESC, donor_id — the id is the
-- deterministic tiebreak) kept to rn ≤ 200, and the summary's inner aggregate
-- reads _gdr_agg instead of public.group_donor_rollup. Header unchanged:
-- plpgsql, SECURITY DEFINER, SET search_path TO 'public', 'pg_temp' (its only
-- SET; the body's SET LOCAL work_mem is a statement, not proconfig — FIX-1128).
-- Grants re-stated: postgres + service_role only (prod proacl 01:49 UTC). The
-- return shape {cohorts, donor_rows, refreshed_at} is unchanged, so
-- run_group_donor_rollup_refresh() (pg_cron jobid 49, Wed 03:10 UTC) logs
-- rows_inserted = the stored rows, as before.

BEGIN;

CREATE OR REPLACE FUNCTION public.refresh_group_donor_rollup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- FIX-918: the label of the donor's primary industry, from its one home — was
  -- MIN(display_label), alphabetical by LABEL.
  CREATE TEMP TABLE _gdr_ind ON COMMIT DROP AS
    SELECT pit.entity_id, pit.display_label AS sector
    FROM public.primary_industry_tag(NULL) pit;
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

  -- FIX-501: only the top 200 donors per cohort are stored — the route reads at
  -- most 100 (/api/graph/group clamps limit ≤ 100). donor_id breaks ties so the
  -- cut is deterministic.
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
  FROM (SELECT ag.*,
               row_number() OVER (PARTITION BY ag.gb_id, ag.party_key
                                  ORDER BY ag.total_cents DESC, ag.donor_id) AS rn
        FROM _gdr_agg ag) a
  LEFT JOIN _gdr_ind ind ON ind.entity_id = a.donor_id
  WHERE a.rn <= 200;

  -- Summary: ONE row per DISTINCT cohort in the membership set (zero-donor state
  -- gbs included, donor_count=0 — the route's materialized-vs-not disambiguator).
  -- FIX-501: aggregated from _gdr_agg (every donor), NOT the stored top-200 rows,
  -- so donor_count / total_cents stay the cohort's true totals.
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
    FROM _gdr_agg
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
$function$;

REVOKE ALL ON FUNCTION public.refresh_group_donor_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_group_donor_rollup() TO service_role;

COMMENT ON FUNCTION public.refresh_group_donor_rollup() IS
  'FIX-500 — full re-aggregate of the per-cohort donor rollup. Institutional filter '
  'and donor display fields resolved once in _gdr_base ahead of the fan-out; final '
  'INSERT touches no big table. FIX-501 — stores the top 200 donors per (gb_id, '
  'party_key) by total_cents DESC, donor id; group_donor_rollup_summary carries the '
  'cohort''s true donor_count and total_cents from the full aggregate. pg_cron '
  'group-donor-rollup-refresh (Wed 03:10 UTC) via run_group_donor_rollup_refresh(). '
  'Returns {cohorts, donor_rows, refreshed_at}.';


-- ═══════════════════════════════════════════════════════════════════════════
-- §B  FIX-1204 — two NULL-committee industry overrides (cohort 2; 806 → 808)
-- ═══════════════════════════════════════════════════════════════════════════
-- THE ROWS come from docs/audits/2026-10-03-fix1204-null-committee-overrides.tsv
-- (prod read cc-187, 2026-10-04 01:49 UTC): both `other` entities with
-- is_synthetic false, fec_committee_id NULL, no override row, and one
-- industry/rule 0.80 tag each — PCMA health ($15,000 donated), NRA PVF lobby
-- ($1,500). Craig, 2026-10-03: PCMA → health; NRA PVF → lobby with the note
-- "single-issue advocacy: firearms"; NO second tag axis.
--
-- THE OTHER TWO the 09-20 selection named are dropped: Ridge Coal Legacy Trust
-- (a222d616-…) and Cumberland Energy Action Fund (8a1e3c6f-…) are is_synthetic
-- Franklin seed rows (cc-186 R8) — that selection never excluded is_synthetic.
-- The pre-check below adds that gate, so a synthetic id can never be curated
-- here.
--
-- WHAT THE NIGHTLY DOES WITH THEM: tagFinancialEntities() clears its rule +
-- curated rows, applies the override through the FIX-922 uuid arm, and writes
-- health / lobby with generated_by 'curated' in place of the rule rows. The
-- industry does not change; the provenance and the audit trail do.
--
-- IDEMPOTENT: the insert upserts on the synthetic key, and the assertions hold
-- on an already-migrated env.

-- ── B1. Pre-check ──────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_ids   uuid[] := ARRAY['ae4d58df-917c-47ef-80c9-0ebf8d096189',
                          'dac6b3f9-aebc-406d-a587-01998408f03b']::uuid[];
  v_found int;
  v_bad   text;
BEGIN
  SELECT count(*) INTO v_found FROM public.financial_entities WHERE id = ANY (v_ids);
  IF v_found <> 2 THEN
    RAISE EXCEPTION 'FIX-1204: % of 2 ids resolve to financial_entities rows. Refusing to seed.', v_found;
  END IF;

  -- The gate the 09-20 selection lacked: never curate a synthetic (Franklin) row.
  SELECT string_agg(fe.display_name || ' [' || fe.id || ']', '; ') INTO v_bad
    FROM public.financial_entities fe
   WHERE fe.id = ANY (v_ids) AND COALESCE(fe.is_synthetic, false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1204: synthetic rows are never curated: %', v_bad;
  END IF;

  SELECT string_agg(fe.display_name || ' [' || fe.fec_committee_id || ']', '; ') INTO v_bad
    FROM public.financial_entities fe
   WHERE fe.id = ANY (v_ids) AND fe.fec_committee_id IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1204: these carry an fec_committee_id and belong on the committee arm: %', v_bad;
  END IF;

  SELECT string_agg(o.fec_committee_id || ' (' || o.source || ')', '; ') INTO v_bad
    FROM public.financial_entity_industry_overrides o
   WHERE o.financial_entity_id = ANY (v_ids)
     AND o.source <> 'fix1204-null-committee-2026-10-03';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1204: already curated by another cohort: %', v_bad;
  END IF;
END
$do$;

-- ── B2. The override rows (uuid arm: key = 'fe:' || financial_entity_id) ───
INSERT INTO public.financial_entity_industry_overrides
  (fec_committee_id, financial_entity_id, industry, display_name_at_audit, audited_sector, source, note)
VALUES
  ('fe:ae4d58df-917c-47ef-80c9-0ebf8d096189', 'ae4d58df-917c-47ef-80c9-0ebf8d096189', 'health', 'Pharmaceutical Care Management Association', 'null_committee_donor', 'fix1204-null-committee-2026-10-03', 'FIX-1204: pharmacy-benefit managers trade association -> health (Craig 2026-10-03)'),
  ('fe:dac6b3f9-aebc-406d-a587-01998408f03b', 'dac6b3f9-aebc-406d-a587-01998408f03b', 'lobby', 'National Rifle Association of America Political Victory Fund', 'null_committee_donor', 'fix1204-null-committee-2026-10-03', 'FIX-1204: single-issue advocacy: firearms (Craig 2026-10-03); lobby is the industry — no secondary axis')
ON CONFLICT (fec_committee_id) DO UPDATE
  SET industry              = EXCLUDED.industry,
      display_name_at_audit = EXCLUDED.display_name_at_audit,
      audited_sector        = EXCLUDED.audited_sector,
      source                = EXCLUDED.source,
      note                  = EXCLUDED.note;

-- ── B3. Cohort + total assertions ──────────────────────────────────────────
DO $do$
DECLARE
  v_cohort int;
  v_total  int;
BEGIN
  SELECT count(*) INTO v_cohort
    FROM public.financial_entity_industry_overrides o
    JOIN public.financial_entities fe ON fe.id = o.financial_entity_id
   WHERE o.source = 'fix1204-null-committee-2026-10-03'
     AND o.fec_committee_id = 'fe:' || o.financial_entity_id::text
     AND NOT COALESCE(fe.is_synthetic, false);
  IF v_cohort <> 2 THEN
    RAISE EXCEPTION 'FIX-1204: expected 2 resolved non-synthetic rows in the cohort, found %.', v_cohort;
  END IF;

  -- 742 (FIX-916) + 50 (FIX-921) + 1 (FIX-923) + 13 (FIX-1255) + 2 (this) = 808.
  SELECT count(*) INTO v_total FROM public.financial_entity_industry_overrides;
  IF v_total <> 808 THEN
    RAISE EXCEPTION
      'FIX-1204: override table should hold 808 rows (742 + 50 + 1 + 13 + 2 FIX-1204), holds %.', v_total;
  END IF;

  RAISE NOTICE 'FIX-1204 OK — PCMA and NRA PVF seeded on the uuid arm (cohort %, table % rows).', v_cohort, v_total;
END
$do$;

COMMIT;
