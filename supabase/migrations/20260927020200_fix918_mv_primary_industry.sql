-- =============================================================================
-- FIX-918 (2 of 2) — official_sector_dollars_mv + chord_industry_flows_mv read
-- primary_industry_tag() (20260927020000)
-- =============================================================================
--
-- The two MVs' donor_industry CTE was the alphabetical DISTINCT ON pick; it is now
-- the ranked pick from its one home. Everything else in each definition is the
-- FIX-875 text unchanged.
--
-- WHY A SEPARATE FILE, AND WHY THE TWO SETs. This swap first rode inside
-- 20260927020000. On prod (2026-09-27 09:18 UTC, gate open, census pass) the
-- official_sector_dollars_mv twin populated in ~1:45, then the
-- chord_industry_flows_mv twin ran 19.5 min on CPU while the front door lost 12
-- renders in 60 min (6.06x baseline) and 10 of 637 requests 5xx'd in the 09:15
-- bucket. The populate was cancelled by hand at 09:39:40 and the whole migration
-- rolled back. The clone did the same populate in 33.5 s.
--
-- The difference is parallelism. refresh_derived_mvs('weekly'), which refreshes
-- these two MVs every Tuesday 00:47 UTC, runs with max_parallel_workers_per_gather
-- = 0 and work_mem = 128MB (FIX-1109 finding 2 / FIX-1129): both units hash the
-- whole of financial_entities, and under a Parallel Hash Join that build lives in
-- dynamic shared memory, which has failed on prod ("could not resize shared
-- memory segment ... No space left on device", 2026-08-25). The migration session
-- ran with prod's defaults (1 worker, 256MB). The two SETs below are the weekly
-- unit's own, so this populate runs the plan the weekly refresh runs, measured on
-- prod at 236-775 s (chord) and 103-162 s (sector dollars) as CONCURRENT refreshes
-- over the last four weeks; a non-concurrent populate does the same scan without
-- the diff.
--
-- THE SWAP (FIX-1134 recipe, rule 10): build <name>_new WITH NO DATA, unique
-- index, grants, reloptions; populate non-concurrently (no lock on the live MVs);
-- then DROP + RENAME both in one DO block at the very end, so the live MVs'
-- ACCESS EXCLUSIVE is held for the cutover and commit only. pg_depend on prod
-- shows no dependents beyond each MV's own index. The COMMENTs and
-- chord_industry_flows_mv's autovacuum reloptions do not survive a DROP and are
-- re-stated.
--
-- CONSERVATION. Clone, one REPEATABLE READ snapshot: the new
-- official_sector_dollars_mv sums to the tagged donations ledger
-- (174,170,410,600 = 174,170,410,600) and chord_industry_flows_mv to the
-- congressional donations ledger (365,808,833,900 = 365,808,833,900). Per-tag
-- deltas against the old definition net to zero and move only the 44 re-ranked
-- donors' dollars. Both MVs REFRESH CONCURRENTLY on the new definitions (clone
-- 4.4 s / 102.8 s).
-- =============================================================================

SET statement_timeout = '30min';
SET max_parallel_workers_per_gather = 0;
SET work_mem = '128MB';

-- ── 1. The two MVs: build + populate the twins (no lock on the live MVs) ──────
CREATE MATERIALIZED VIEW public.official_sector_dollars_mv_new AS
WITH donor_industry AS (
  -- FIX-918: the donor's primary industry, from its one home.
  SELECT pit.entity_id, pit.tag, pit.display_label, pit.display_icon
  FROM public.primary_industry_tag(NULL) pit
)
SELECT
  fr.to_id                                AS official_id,
  di.tag                                  AS sector_tag,
  MIN(COALESCE(di.display_label, di.tag)) AS sector_label,
  MIN(COALESCE(di.display_icon, ''))      AS display_icon,
  SUM(fr.amount_cents)::BIGINT            AS total_cents,
  COUNT(DISTINCT fe.id)::BIGINT           AS donor_count
FROM public.financial_relationships fr
JOIN public.financial_entities fe
  ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
JOIN donor_industry di
  ON di.entity_id = fe.id
WHERE fr.relationship_type = 'donation'
  AND fr.to_type           = 'official'
  AND fr.amount_cents > 0
GROUP BY fr.to_id, di.tag
WITH NO DATA;

CREATE UNIQUE INDEX official_sector_dollars_mv_new_pk
  ON public.official_sector_dollars_mv_new (official_id, sector_tag);
GRANT SELECT ON public.official_sector_dollars_mv_new TO anon, authenticated, service_role;

CREATE MATERIALIZED VIEW public.chord_industry_flows_mv_new AS
WITH donor_industry AS (
  -- FIX-918: the donor's primary industry, from its one home.
  SELECT pit.entity_id, pit.tag, pit.display_label, pit.display_icon
  FROM public.primary_industry_tag(NULL) pit
)
SELECT
  COALESCE(di.tag, 'untagged')                AS industry,
  MIN(COALESCE(di.display_label, 'Untagged')) AS display_label,
  MIN(COALESCE(di.display_icon, ''))          AS display_icon,
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )                                           AS party_chamber,
  SUM(fr.amount_cents)::BIGINT                AS total_cents,
  COUNT(DISTINCT fr.to_id)::BIGINT            AS official_count,
  COUNT(DISTINCT fe.id)::BIGINT              AS donor_count
FROM public.financial_relationships fr
JOIN public.officials          o  ON o.id  = fr.to_id   AND fr.to_type   = 'official'
JOIN public.financial_entities fe ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
LEFT JOIN donor_industry di
  ON di.entity_id = fe.id
WHERE fr.relationship_type = 'donation'
  AND fr.amount_cents > 0
  AND o.source_ids->>'congress_gov' IS NOT NULL
GROUP BY
  COALESCE(di.tag, 'untagged'),
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )
WITH NO DATA;

CREATE UNIQUE INDEX chord_industry_flows_mv_new_pk
  ON public.chord_industry_flows_mv_new (industry, party_chamber);
GRANT SELECT ON public.chord_industry_flows_mv_new TO anon, authenticated, service_role;
ALTER MATERIALIZED VIEW public.chord_industry_flows_mv_new SET (
  autovacuum_vacuum_threshold = 20,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 20,
  autovacuum_analyze_scale_factor = 0.02
);

REFRESH MATERIALIZED VIEW public.official_sector_dollars_mv_new;
REFRESH MATERIALIZED VIEW public.chord_industry_flows_mv_new;

-- ── 2. Cutover: both swaps in one statement, last thing before commit ─────────
DO $swap_cutover$
DECLARE
  v_osd_old bigint; v_osd_new bigint;
  v_cif_old bigint; v_cif_new bigint;
BEGIN
  SELECT count(*) INTO v_osd_old FROM public.official_sector_dollars_mv;
  SELECT count(*) INTO v_osd_new FROM public.official_sector_dollars_mv_new;
  SELECT count(*) INTO v_cif_old FROM public.chord_industry_flows_mv;
  SELECT count(*) INTO v_cif_new FROM public.chord_industry_flows_mv_new;
  RAISE NOTICE 'FIX-918 pre-swap rows: official_sector_dollars_mv % -> %, chord_industry_flows_mv % -> %',
    v_osd_old, v_osd_new, v_cif_old, v_cif_new;

  -- A structural break, not staleness: the twins are fresh and the live MVs
  -- are up to a week old, so only an empty twin is refused here. The exact
  -- conservation proof is the clone's one-snapshot check (header).
  IF v_osd_new = 0 OR v_cif_new = 0 THEN
    RAISE EXCEPTION 'FIX-918: a populated twin is empty (osd %, cif %) — refusing the swap',
      v_osd_new, v_cif_new;
  END IF;

  DROP MATERIALIZED VIEW public.official_sector_dollars_mv;
  ALTER MATERIALIZED VIEW public.official_sector_dollars_mv_new RENAME TO official_sector_dollars_mv;
  ALTER INDEX public.official_sector_dollars_mv_new_pk RENAME TO official_sector_dollars_mv_pk;

  DROP MATERIALIZED VIEW public.chord_industry_flows_mv;
  ALTER MATERIALIZED VIEW public.chord_industry_flows_mv_new RENAME TO chord_industry_flows_mv;
  ALTER INDEX public.chord_industry_flows_mv_new_pk RENAME TO chord_industry_flows_mv_pk;
END
$swap_cutover$;

COMMENT ON MATERIALIZED VIEW public.official_sector_dollars_mv IS
  'FIX-506/FIX-875/FIX-918 — per-official × industry-sector donation-dollar rollup. '
  'One industry per donor: its primary industry from primary_industry_tag() '
  '(FIX-918; was the alphabetical DISTINCT ON pick of FIX-875 — the pre-875 '
  'fan-out double-counted a multi-tag donor into every sector). Untagged donors '
  'excluded (INNER JOIN, unchanged display choice). Refreshed CONCURRENTLY by '
  'refresh_derived_mvs(weekly). Read by get_group_sector_totals / '
  'get_crossgroup_sector_totals / chord_sector_vote_for_officials.';

COMMENT ON MATERIALIZED VIEW public.chord_industry_flows_mv IS
  'FIX-207/FIX-875/FIX-918 — platform-wide industry × party_chamber donation '
  'chord. One industry per donor: its primary industry from '
  'primary_industry_tag() (FIX-918; was the alphabetical DISTINCT ON pick of '
  'FIX-875). Untagged bucket preserved (LEFT JOIN + COALESCE). Refreshed '
  'CONCURRENTLY by refresh_derived_mvs(weekly). Read by chord_industry_flows() '
  '(/api/graph/chord).';

RESET work_mem;
RESET max_parallel_workers_per_gather;
RESET statement_timeout;
