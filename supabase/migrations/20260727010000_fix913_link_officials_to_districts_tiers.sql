-- FIX-913 — fold the FIX-859 backfill's five-tier match ladder into
-- link_officials_to_districts(), so the SLD district cross-link survives the
-- nightly instead of needing a one-shot repair script.
--
-- BACKGROUND
-- The OpenStates writer replaces officials.metadata wholesale on every upsert,
-- so district_jurisdiction_id is destroyed and must be re-derived. FIX-915
-- stops that destruction at source (client-side metadata merge in the writer);
-- this function is the remaining safety net — it links genuinely NEW
-- legislators and corrects a genuinely CHANGED district.
--
-- The prior body (FIX-217, migration 20260509000002) only did numeric
-- normalisation, so it re-linked 6,530 of 7,373 state legislators and left the
-- same 843-row tail unlinked forever: NH lower 393 ('Belknap 1' vs 'New
-- Hampshire State House District Belknap 01'), MA lower 158 ('10th Bristol'),
-- VT lower 150 ('Addison-1'), ID lower 70 ('10A'/'10B' multi-member), MA upper
-- 40 ('Berkshire, Hampden, Franklin and Hampshire' vs hyphenated), VT upper 30
-- ('Chittenden Southeast' vs 'Chittenden South East'), ME lower 2 (tribal).
--
-- KEY-FAMILY SWAP — measured, not assumed. The old body keyed on
-- officials.metadata->>'state' + ->>'org_classification' against
-- jurisdictions.metadata->>'source'='tiger' / state_abbr / chamber /
-- district_id. This body keys on governing_bodies.jurisdiction_id →
-- jurisdictions.parent_id + short_name prefix + normalised core, which is the
-- backfill script's key. Those are two independent key families for the same
-- link, and the `<> current` clause below means a disagreement would silently
-- RELOCATE a working link rather than skip it — so parity was verified on
-- BOTH environments before this shipped (2026-07-27, all 7,373 active
-- non-synthetic state legislators, identical on local and prod):
--
--   both keys match, same district id     6,530
--   both match, DIFFERENT district id         0
--   script-key only / RPC-key only          0/0
--   either ambiguous                          0
--   neither (the known tail)                843
--
-- FIVE MATCH TIERS, strongest first. A link is written ONLY where the
-- strongest tier that produced any match produced EXACTLY ONE match; 0 or >1
-- is skipped, never guessed. A nightly job that guesses is worse than one that
-- skips.
--
--   1  numeric      zero-pad-normalised district number. jurisdictions key on
--                   metadata->>'district_id' ('066') / short_name ('HD 066');
--                   officials carry the raw form ('66'). ltrim(…,'0') both.
--   2  multi-member Idaho-style '10A'/'10B' — two House seats inside one
--                   geographic district. Strip the trailing letter, redo tier
--                   1. Two officials CORRECTLY sharing one
--                   district_jurisdiction_id is the expected outcome here.
--   3  exact core   Both sides reduced to a bare district "core" (state name
--                   and per-state boilerplate stripped, separators folded) and
--                   compared for EQUALITY. Equality rather than containment is
--                   what keeps 'First Essex' off 'First Essex and Middlesex'.
--   4  squashed     Same cores with separators removed, for 'Chittenden South
--                   East' vs 'Chittenden Southeast'.
--   5  containment  Anchored on '-' boundaries. Last resort; in practice it
--                   resolves nothing tiers 3–4 missed. Kept as the documented
--                   safety net — it costs nothing and it is the only tier that
--                   would catch a novel shape.
--
-- THE JOIN MUST BE SCOPED BY STATE. officials.district_name for a state
-- legislator is a bare token with no state in it — '10' appears on 99 different
-- officials across 50 states, so an unscoped join on district_name is not
-- merely lossy, it is actively wrong. State comes from
-- governing_bodies.jurisdiction_id; the district jurisdiction's parent_id
-- points at that same state row. Chamber comes from the short_name prefix —
-- 'HD' for gb.type='legislature_lower', 'SD' for 'legislature_upper'.
-- metadata->>'district_type' is NULL everywhere; it is not usable.
--
-- KNOWN PERMANENT RESIDUAL (correct to leave unlinked — 60 rows):
--   - NH floterial districts (58). NH has 164 HD jurisdiction rows for a
--     400-member House; floterial seats have no row to link to. Seeding them
--     is FIX-914. Do not invent rows here.
--   - ME tribal seats (2) — 'Passamaquoddy Tribe', 'Houlton Band of Maliseet
--     Indians'. Non-geographic representation; correctly unlinked forever.
--
-- IDEMPOTENCY. Unlike the backfill script, the candidate pool is NOT
-- restricted to district_jurisdiction_id IS NULL — the RPC must also be able
-- to correct a wrong existing link, which is what the old body's
-- `OR district_jurisdiction_id <> d.id::text` clause was for. Honesty of the
-- returned count is preserved instead by the final IS DISTINCT FROM guard: a
-- run against already-correct data updates zero rows and returns 0.
--
-- Contract is unchanged: RETURNS integer (rows updated), SECURITY DEFINER,
-- search_path pinned, service_role-only EXECUTE (FIX-834).

CREATE OR REPLACE FUNCTION public.link_officials_to_districts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH sl AS (
    -- Candidate pool: every active, non-synthetic state legislator with a
    -- district name, linked or not.
    SELECT o.id,
           gb.jurisdiction_id AS state_id,
           CASE gb.type WHEN 'legislature_lower' THEN 'HD' ELSE 'SD' END AS prefix,
           ltrim(o.district_name, '0') AS num_key,
           CASE WHEN o.district_name ~ '^[0-9]+[A-Za-z]$'
                THEN ltrim(regexp_replace(o.district_name, '[A-Za-z]$', ''), '0') END AS num_key_mm,
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(lower(o.district_name), '^' || lower(p.name) || '\s+', ''),
                     '\m(state house district|state senate district|senatorial district|house district|senate district|district)\M', ' ', 'g'),
                   '\s+and\s+', '-', 'g'),
                 '[^a-z0-9]+', '-', 'g'),
               '^-+|-+$', '', 'g'),
             '-([0-9])$', '-0\1') AS nk
    FROM public.officials o
    JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
    JOIN public.jurisdictions p ON p.id = gb.jurisdiction_id AND p.type = 'state'
    WHERE gb.type IN ('legislature_lower', 'legislature_upper')
      AND o.is_active
      AND NOT COALESCE(o.is_synthetic, false)
      AND o.district_name IS NOT NULL
      AND btrim(o.district_name) <> ''
  ),
  dj AS (
    -- District jurisdictions, keyed the same way. Same core-normalisation
    -- pipeline on both sides so the two meet in the middle:
    --   'New Hampshire State House District Belknap 01' -> 'belknap-01'
    --   'Belknap 1'                                     -> 'belknap-01'
    SELECT d.id,
           d.parent_id,
           split_part(d.short_name, ' ', 1) AS prefix,
           ltrim(coalesce(d.metadata->>'district_id', split_part(d.short_name, ' ', 2)), '0') AS num_key,
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(lower(d.name), '^' || lower(p.name) || '\s+', ''),
                     '\m(state house district|state senate district|senatorial district|house district|senate district|district)\M', ' ', 'g'),
                   '\s+and\s+', '-', 'g'),
                 '[^a-z0-9]+', '-', 'g'),
               '^-+|-+$', '', 'g'),
             '-([0-9])$', '-0\1') AS nk
    FROM public.jurisdictions d
    JOIN public.jurisdictions p ON p.id = d.parent_id AND p.type = 'state'
    WHERE d.type = 'district'
      AND split_part(d.short_name, ' ', 1) IN ('HD', 'SD')
  ),
  -- Tiers 1–4 over the full state+chamber-scoped pair set. Cheap: equality on
  -- pre-normalised text, no regex. ~700k pairs, sub-second.
  m14 AS (
    SELECT sl.id AS official_id, dj.id AS jur_id,
      CASE
        WHEN dj.num_key <> '' AND dj.num_key = sl.num_key                              THEN 1
        WHEN dj.num_key <> '' AND sl.num_key_mm IS NOT NULL
             AND dj.num_key = sl.num_key_mm                                            THEN 2
        WHEN sl.nk <> '' AND dj.nk = sl.nk                                             THEN 3
        WHEN sl.nk <> '' AND replace(dj.nk, '-', '') = replace(sl.nk, '-', '')         THEN 4
      END AS tier
    FROM sl
    JOIN dj ON dj.parent_id = sl.state_id AND dj.prefix = sl.prefix
  ),
  hit14 AS (
    SELECT official_id, jur_id, tier FROM m14 WHERE tier IS NOT NULL
  ),
  -- Tier 5 is evaluated ONLY for officials that tiers 1–4 left unmatched.
  -- min(tier) would never pick 5 over an existing 1–4 match, so this is
  -- semantically identical to scoring tier 5 across every pair — and it is the
  -- difference between ~126k regex evaluations and ~700k, on a dynamically
  -- built pattern that cannot be plan-cached.
  resid AS (
    SELECT sl.*
    FROM sl
    WHERE sl.nk <> ''
      AND NOT EXISTS (SELECT 1 FROM hit14 h WHERE h.official_id = sl.id)
  ),
  m5 AS (
    SELECT r.id AS official_id, dj.id AS jur_id, 5 AS tier
    FROM resid r
    JOIN dj ON dj.parent_id = r.state_id AND dj.prefix = r.prefix
    WHERE dj.nk ~ ('(^|-)' || r.nk || '($|-)')
  ),
  m AS (
    SELECT official_id, jur_id, tier FROM hit14
    UNION ALL
    SELECT official_id, jur_id, tier FROM m5
  ),
  -- Strongest tier per official, as a window rather than a correlated
  -- subquery. The LATERAL form this replaced rescanned the whole pair set once
  -- per official — 7,373 x 700k ≈ 5.2B row visits, >5 min and climbing. The
  -- window is a single pass over the matched pairs only.
  ranked AS (
    SELECT official_id, jur_id, tier,
           min(tier) OVER (PARTITION BY official_id) AS best_tier
    FROM m
  ),
  -- Exactly-one-match rule: count the matches AT the strongest tier that
  -- produced any. n > 1 is ambiguous and is deliberately not written.
  resolved AS (
    SELECT official_id,
           count(*)::int AS n,
           min(jur_id::text)::uuid AS jur_id
    FROM ranked
    WHERE tier = best_tier
    GROUP BY official_id
  )
  UPDATE public.officials o
     SET metadata = COALESCE(o.metadata, '{}'::jsonb)
                  || jsonb_build_object('district_jurisdiction_id', r.jur_id::text)
    FROM resolved r
   WHERE o.id = r.official_id
     AND r.n = 1
     AND o.metadata->>'district_jurisdiction_id' IS DISTINCT FROM r.jur_id::text;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- The pipelines call this as service_role, whose prod default statement_timeout
-- is 8s. The tier ladder is heavier than the old single numeric join (it
-- cross-joins each state's legislators against that state's districts and runs
-- an anchored regex on the tier-5 residue), so pin a function-level budget
-- rather than leaving a nightly linker one slow plan away from timing out.
-- Same convention as the rebuild_entity_connections_* chunks.
ALTER FUNCTION public.link_officials_to_districts() SET statement_timeout = '5min';

-- Grants unchanged (FIX-834) — re-asserted because CREATE OR REPLACE on a
-- function whose ACL was previously narrowed keeps the ACL, but restating it
-- here means this migration is self-contained if ever replayed out of order.
REVOKE ALL ON FUNCTION public.link_officials_to_districts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_officials_to_districts() TO service_role;

COMMENT ON FUNCTION public.link_officials_to_districts() IS
  'FIX-913 — derives officials.metadata->>''district_jurisdiction_id'' for state '
  'legislators via a five-tier match ladder (numeric, multi-member, exact core, '
  'squashed core, anchored containment), scoped by state and chamber. Writes only '
  'where the strongest matching tier yields exactly one district. Returns rows '
  'updated; a run against already-correct data returns 0.';
