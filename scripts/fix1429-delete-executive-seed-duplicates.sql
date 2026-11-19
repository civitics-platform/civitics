-- FIX-1429 — delete the duplicate executive-seed officials rows (cc-298, cc-299).
--
-- Before FIX-1428 the nightly executive seed (packages/data/src/pipelines/
-- executive/seed.ts) inserted another President / Vice President whenever its
-- .maybeSingle() lookup failed. Two rows then made the lookup fail every
-- night. Prod read 2026-11-19 05:09Z: potus_current 4 rows, vpotus_current 43.
-- The oldest row of each (created 2026-05-25T05:34:55Z) is the keeper, and
-- the fixed seed updates it. Every other row is a victim.
--
-- ONE statement, a single DO block, so it is atomic: any RAISE or foreign-key
-- refusal rolls the whole block back and nothing is written.
--   1. Victims = every row of each official_seed_id after the oldest
--      (created_at, then id); each victim's keeper is its seed id's oldest.
--   2. RAISE unless exactly the two seed ids exist, each keeper was created
--      on 2026-05-25 (UTC), and the victim count is 1..60.
--   3. RAISE if any victim has a row in any table of the refusal list below.
--      The message names each table and its row count. The list is cc-298's
--      read-2 coverage, minus official_homepage_stats_mv (step 4), plus
--      franklin_seed_map (cc-299 D3).
--   4. RAISE if any victim's official_homepage_stats_mv row has a non-zero
--      vote_count, donor_count or total_donations_cents (cc-299 D1). Zero
--      rows are left in place: the MV is one row per official, its readers
--      key by ids read from officials, and refresh-derived-mvs-daily (06:00Z)
--      drops them. The block never touches the MV.
--   5. Re-point irs990_officers / irs990_grants_out rows matched to a victim
--      (matched_entity_type 'official') to that victim's keeper (cc-299 D2),
--      as promote_candidate_to_elected() does with the same columns.
--   6. DELETE the victims' entity_tags, entity_search_index and
--      enrichment_queue rows (scoped to officials), then the victims from
--      officials. The AFTER DELETE triggers on officials clear their own
--      rollups. The refusal in 3 means no FK cascade has rows to remove.
--   7. Read back: one row per seed id, and it is the keeper. NOTICE the
--      counts, the MV rows left, and the two surviving ids.
--
-- Read the set first: scripts/fix1429-read-executive-seed-references.sql.
-- Run ONCE on prod, under the gate, from the PRIMARY's packages/data:
--   pnpm run session:wait-for-gate:prod --expected-minutes 1 --census stop --poll-seconds 60 --max-wait-minutes 8 --reason "FIX-1429 delete duplicate executive seed rows" --then "node ../../scripts/db-query.mjs --prod --call --yes-i-mean-prod --timeout 60s --file ../../scripts/fix1429-delete-executive-seed-duplicates.sql"
-- Rehearse on local first with --local --call --file (cc-298 D3, cc-299 D4).
--
-- Not covered by 3: treemap_individuals_rollup and small_dollar_bracket_rollup
-- (the triggers clear them), and every MV's next refresh. After this runs,
-- FIX-1429's unique index on (source_ids->>'official_seed_id') turns a future
-- duplicate into a 23505, which the seed counts as failed.
DO $$
DECLARE
  v_victims     uuid[];
  v_vkeepers    uuid[];   -- v_vkeepers[i] is v_victims[i]'s keeper
  v_keepers     jsonb;
  v_per_seed    jsonb;
  v_seeds       int;
  v_bad_keepers int;
  v_hits        text[] := '{}';
  v_n           bigint;
  r             record;
  n_mv          int;
  n_mv_nonzero  int;
  v_mv_bad      text;
  n_officers    int;
  n_grants      int;
  n_tags        int;
  n_search      int;
  n_queue       int;
  n_officials   int;
  v_after       jsonb;
BEGIN
  WITH s AS (
    SELECT id, source_ids->>'official_seed_id' AS seed, created_at,
           row_number() OVER w AS rn,
           first_value(id) OVER w AS keeper
      FROM public.officials
     WHERE source_ids ? 'official_seed_id'
    WINDOW w AS (PARTITION BY source_ids->>'official_seed_id' ORDER BY created_at, id)
  )
  SELECT array_agg(id     ORDER BY seed, created_at, id) FILTER (WHERE rn > 1),
         array_agg(keeper ORDER BY seed, created_at, id) FILTER (WHERE rn > 1),
         jsonb_object_agg(seed, jsonb_build_object('id', id, 'created_at', created_at))
           FILTER (WHERE rn = 1),
         count(DISTINCT seed),
         count(*) FILTER (WHERE rn = 1
                            AND (created_at AT TIME ZONE 'UTC')::date <> DATE '2026-05-25')
    INTO v_victims, v_vkeepers, v_keepers, v_seeds, v_bad_keepers
    FROM s;

  SELECT jsonb_object_agg(seed, n) INTO v_per_seed
    FROM (SELECT source_ids->>'official_seed_id' AS seed, count(*) - 1 AS n
            FROM public.officials
           WHERE source_ids ? 'official_seed_id'
           GROUP BY 1) q;

  IF v_seeds <> 2 OR NOT (v_keepers ?& ARRAY['potus_current', 'vpotus_current']) THEN
    RAISE EXCEPTION 'FIX-1429: expected exactly the seed ids potus_current and vpotus_current, found % (%); nothing deleted',
      v_seeds, v_keepers;
  END IF;
  IF v_bad_keepers <> 0 THEN
    RAISE EXCEPTION 'FIX-1429: a keeper was not created on 2026-05-25 (%); nothing deleted', v_keepers;
  END IF;
  IF coalesce(cardinality(v_victims), 0) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'FIX-1429: victim count % is outside 1..60 (per seed id %); nothing deleted',
      coalesce(cardinality(v_victims), 0), v_per_seed;
  END IF;

  -- The refusal list. Polymorphic tables are scoped by type where their index
  -- leads with it (an unscoped financial_relationships.from_id is a seq scan).
  FOR r IN
    SELECT * FROM (VALUES
      ('votes',                           'official_id = ANY($1)'),
      ('entity_connections',              'from_type = ''official'' AND from_id = ANY($1)'),
      ('entity_connections',              'to_type = ''official'' AND to_id = ANY($1)'),
      ('financial_relationships',         'from_type = ''official'' AND from_id = ANY($1)'),
      ('financial_relationships',         'to_type = ''official'' AND to_id = ANY($1)'),
      ('official_redirects',              'old_id = ANY($1)'),
      ('official_redirects',              'new_id = ANY($1)'),
      ('data_flags',                      'entity_id = ANY($1)'),
      ('user_follows',                    'entity_id = ANY($1)'),
      ('user_preferences',                'followed_officials && $1'),
      ('entity_comments',                 'entity_id = ANY($1)'),
      ('official_community_comments',     'official_id = ANY($1)'),
      ('entity_positions',                'entity_id = ANY($1)'),
      ('position_events',                 'entity_id = ANY($1)'),
      ('civic_initiative_responses',      'official_id = ANY($1)'),
      ('notifications',                   'entity_id = ANY($1)'),
      ('entity_statements',               'entity_id = ANY($1)'),
      ('citations',                       'target_id = ANY($1)'),
      ('abuse_events',                    'target_id = ANY($1)'),
      ('entity_grants',                   'target_id = ANY($1)'),
      ('external_source_refs',            'entity_type = ''official'' AND entity_id = ANY($1)'),
      ('external_relationships',          'from_type = ''official'' AND from_id = ANY($1)'),
      ('external_relationships',          'to_type = ''official'' AND to_id = ANY($1)'),
      ('evidence_cards',                  'from_id = ANY($1) OR to_id = ANY($1)'),
      ('ai_summary_cache',                'entity_id = ANY($1)'),
      ('career_history',                  'official_id = ANY($1)'),
      ('promises',                        'official_id = ANY($1)'),
      ('lobbying_disclosures',            'official_id = ANY($1)'),
      ('proposal_cosponsors',             'official_id = ANY($1)'),
      ('official_committee_memberships',  'official_id = ANY($1)'),
      ('official_content_ids',            'official_id = ANY($1)'),
      ('bill_details',                    'primary_sponsor_id = ANY($1)'),
      ('proposal_actions',                'performed_by_id = ANY($1)'),
      ('official_vote_stats',             'official_id = ANY($1)'),
      ('official_donor_totals',           'official_id = ANY($1)'),
      ('entity_activity_state',           'entity_id = ANY($1)'),
      ('page_views',                      'entity_type = ''official'' AND entity_id = ANY($1)'),
      ('official_donor_rollup_mv',        'official_id = ANY($1)'),
      ('official_donor_bracket_totals',   'official_id = ANY($1)'),
      ('official_sector_affinity_rollup', 'official_id = ANY($1)'),
      ('official_small_dollar_rollup',    'official_id = ANY($1)'),
      ('entity_connection_stats_mv',      'entity_id = ANY($1)'),
      ('synthetic_position_rollup',       'entity_id = ANY($1)'),
      ('official_sector_dollars_mv',      'official_id = ANY($1)'),
      ('entity_engagement_rollup_mv',     'entity_id = ANY($1)'),
      ('commons_active_threads',          'entity_id = ANY($1)'),
      ('franklin_seed_map',               'row_id = ANY($1)')
    ) AS t(tbl, pred)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', r.tbl, r.pred)
      INTO v_n USING v_victims;
    IF v_n > 0 THEN
      v_hits := v_hits || format('%s [%s] %s', r.tbl, r.pred, v_n);
    END IF;
  END LOOP;

  IF cardinality(v_hits) > 0 THEN
    RAISE EXCEPTION 'FIX-1429: % victim(s) still have rows in the refusal list: %; nothing deleted',
      cardinality(v_victims), array_to_string(v_hits, '; ');
  END IF;

  -- official_homepage_stats_mv: a victim's row is allowed only with zero stats.
  SELECT count(*),
         count(*) FILTER (WHERE coalesce(vote_count, 0) <> 0
                             OR coalesce(donor_count, 0) <> 0
                             OR coalesce(total_donations_cents, 0) <> 0),
         string_agg(format('%s votes=%s donors=%s cents=%s',
                           official_id, vote_count, donor_count, total_donations_cents), '; ')
           FILTER (WHERE coalesce(vote_count, 0) <> 0
                      OR coalesce(donor_count, 0) <> 0
                      OR coalesce(total_donations_cents, 0) <> 0)
    INTO n_mv, n_mv_nonzero, v_mv_bad
    FROM public.official_homepage_stats_mv
   WHERE official_id = ANY(v_victims);
  IF n_mv_nonzero > 0 THEN
    RAISE EXCEPTION 'FIX-1429: % victim row(s) in official_homepage_stats_mv carry non-zero stats: %; nothing deleted',
      n_mv_nonzero, v_mv_bad;
  END IF;

  -- A 990 match on a victim moves to that victim's keeper.
  UPDATE public.irs990_officers o
     SET matched_entity_id = m.keeper
    FROM unnest(v_victims, v_vkeepers) AS m(victim, keeper)
   WHERE o.matched_entity_type = 'official' AND o.matched_entity_id = m.victim;
  GET DIAGNOSTICS n_officers = ROW_COUNT;

  UPDATE public.irs990_grants_out g
     SET matched_entity_id = m.keeper
    FROM unnest(v_victims, v_vkeepers) AS m(victim, keeper)
   WHERE g.matched_entity_type = 'official' AND g.matched_entity_id = m.victim;
  GET DIAGNOSTICS n_grants = ROW_COUNT;

  DELETE FROM public.entity_tags
   WHERE entity_type = 'official' AND entity_id = ANY(v_victims);
  GET DIAGNOSTICS n_tags = ROW_COUNT;

  DELETE FROM public.entity_search_index
   WHERE kind = 'official' AND entity_id = ANY(v_victims);
  GET DIAGNOSTICS n_search = ROW_COUNT;

  DELETE FROM public.enrichment_queue
   WHERE entity_type = 'official' AND entity_id = ANY(v_victims::text[]);
  GET DIAGNOSTICS n_queue = ROW_COUNT;

  DELETE FROM public.officials WHERE id = ANY(v_victims);
  GET DIAGNOSTICS n_officials = ROW_COUNT;

  IF n_officials <> cardinality(v_victims) THEN
    RAISE EXCEPTION 'FIX-1429: deleted % officials rows, expected %; rolled back',
      n_officials, cardinality(v_victims);
  END IF;

  SELECT jsonb_object_agg(seed, ids) INTO v_after
    FROM (SELECT source_ids->>'official_seed_id' AS seed, jsonb_agg(id) AS ids
            FROM public.officials
           WHERE source_ids ? 'official_seed_id'
           GROUP BY 1) q;
  IF v_after->'potus_current'  IS DISTINCT FROM jsonb_build_array(v_keepers->'potus_current'->'id')
  OR v_after->'vpotus_current' IS DISTINCT FROM jsonb_build_array(v_keepers->'vpotus_current'->'id') THEN
    RAISE EXCEPTION 'FIX-1429: after the delete the seed ids hold % — expected only the keepers %; rolled back',
      v_after, v_keepers;
  END IF;

  RAISE NOTICE 'FIX-1429: deleted officials=% (per seed id %) entity_tags=% entity_search_index=% enrichment_queue=%; re-pointed irs990_officers=% irs990_grants_out=%; left % zero-stat official_homepage_stats_mv row(s) for the 06:00Z refresh; kept potus_current % and vpotus_current %',
    n_officials, v_per_seed, n_tags, n_search, n_queue, n_officers, n_grants, n_mv,
    v_keepers->'potus_current'->>'id', v_keepers->'vpotus_current'->>'id';
END $$;
