-- FIX-1296 — refresh_group_donor_rollup() at 64MB + parallel 0: B8, the one
-- allowance body cc-211's R5 STOPped, landed on Craig's call (a), 2026-10-10
-- 15:33 PDT: "land 64MB and take the ~2 s".
--
-- Census of record: docs/audits/2026-10-09-work-mem-allowance-census.md §1.1 /
-- §7; the R5 measurement is restated in 20261010020000 (M3)'s header.
--
-- THE MEASUREMENT (R5, local prod-clone, cc-205's recipe: 256MB vs 64MB,
-- parallel 0 both, each top statement cold, RssAnon per second).
--   The function whole: 42.7 -> 43.3 s; RssAnon 196 -> 88 MB.
--   _gdr_agg (HashAgg 2.07M -> 539k rows, B1 188 MB) becomes an external-merge
--   Sort + GroupAggregate (225 MB) at 64MB and at 128MB: 2.30 / 2.35 -> 4.61 s
--   (2.0x) — over R5's 1.5x bar for that statement, which is why it stopped.
--   That statement is ~5 % of the function. Craig's (a): take the ~2 s on a
--   weekly ~43 s function for the ~108 MB of RssAnon it gives back.
--
-- WHAT THIS DOES. CREATE OR REPLACE with the 20261004070000 body (= prod's
-- prosrc byte-for-byte: md5 c75a956afa5a12cb7b418face3353d76, 5,513 chars,
-- read 2026-10-13 00:4xZ) and EXACTLY two lines changed:
--     SET LOCAL work_mem = '256MB';   ->   SET LOCAL work_mem = '64MB';
--   + SET LOCAL max_parallel_workers_per_gather = 0;   (the next line)
-- SET LOCAL, not M2/M3's plain SET: this is a FUNCTION, it cannot COMMIT, and
-- its wrapper run_group_donor_rollup_refresh() is atomic (it carries a
-- search_path proconfig), so SET LOCAL lasts exactly the CALL — the B6
-- rebuild_entity_search_index shape (20261009030000). work-mem-allowances.test.ts
-- proves the two-line diff.
--
-- fix1128: the header is restated unchanged — SECURITY DEFINER SET search_path
-- TO 'public', 'pg_temp', its only SET. No memory GUC in proconfig; the
-- allowance stays a body statement. Grants restated as last stated
-- (20261004070000): service_role EXECUTE, nothing for PUBLIC / anon /
-- authenticated (prod proacl 2026-10-13: postgres + service_role).
--
-- RECEIPT. Wed 10-14 03:10Z, jobid 49 group-donor-rollup-refresh (Wed 03:10Z,
-- active; walls 101.4 / 109.7 / 101.5 s on 09-23 / 09-30 / 10-07, max 294.2 s
-- on 09-16): in band 0–442 s (docs/receipts/bands.json), expected ~100 s + ~2 s.
--
-- ROLLBACK refresh_group_donor_rollup: re-apply from 20261004070000 (SET LOCAL 256MB), never RESET.
--
-- NOT TOUCHED: the wrapper run_group_donor_rollup_refresh(), the schedule,
-- the function's COMMENT (CREATE OR REPLACE keeps it).

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
  SET LOCAL work_mem = '64MB';
  SET LOCAL max_parallel_workers_per_gather = 0;

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
