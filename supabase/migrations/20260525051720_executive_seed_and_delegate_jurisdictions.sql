-- 20260525051720_executive_seed_and_delegate_jurisdictions.sql
-- FIX-321: officials integrity bundle.
--
--   Block A — seed sitting POTUS/VPOTUS rows so the FIX-318 audit checks
--             (officials.president_count, officials.vp_count) flip from
--             error → info. Mirrors packages/data/src/pipelines/executive/seed.ts
--             so prod gets these on `supabase db push --linked` without
--             waiting for the next nightly cron.
--
--   Block B — create the 5 missing territorial jurisdictions (AS/GU/MP/PR/VI)
--             with type='district' (mirroring DC's existing shape — the
--             jurisdiction_type enum has no 'territory' value) and re-route
--             the 5 misrouted House delegates from the 'United States'
--             umbrella jurisdiction to their territorial jurisdictions.
--             Norton (DC, N000147) is NOT in scope — she's already correctly
--             routed to the DC jurisdiction.
--
-- One-shot inline DML; no functions, no triggers. statement_timeout is left
-- at the session default (5min for the migrations role on Pro) — both blocks
-- touch <10 rows.

BEGIN;

-- ── Block A: executive seed ────────────────────────────────────────────────
-- Resolve federal jurisdiction + Office of the President governing body
-- inline. INSERT-or-UPDATE on source_ids->>'official_seed_id'.

DO $$
DECLARE
  v_federal_id    uuid;
  v_presidency_id uuid;
  v_potus_id      uuid;
  v_vpotus_id     uuid;
BEGIN
  SELECT id INTO v_federal_id
    FROM jurisdictions
   WHERE fips_code = '00' AND type = 'country';
  IF v_federal_id IS NULL THEN
    RAISE EXCEPTION '[FIX-321] federal jurisdiction (fips_code=00, type=country) not found';
  END IF;

  SELECT id INTO v_presidency_id
    FROM governing_bodies
   WHERE name = 'Office of the President of the United States'
     AND type = 'executive';
  IF v_presidency_id IS NULL THEN
    RAISE EXCEPTION '[FIX-321] Office of the President governing body not found — run seedGoverningBodies first';
  END IF;

  -- POTUS
  SELECT id INTO v_potus_id
    FROM officials
   WHERE source_ids->>'official_seed_id' = 'potus_current';
  IF v_potus_id IS NULL THEN
    INSERT INTO officials (
      full_name, first_name, last_name, role_title,
      governing_body_id, jurisdiction_id, party,
      term_start, term_end,
      is_active, is_verified, website_url,
      tier, source_ids, metadata
    ) VALUES (
      'Donald J. Trump', 'Donald', 'Trump', 'President of the United States',
      v_presidency_id, v_federal_id, 'republican',
      '2025-01-20'::date, '2029-01-20'::date,
      TRUE, TRUE, 'https://www.whitehouse.gov/administration/donald-j-trump/',
      'elected',
      jsonb_build_object('official_seed_id', 'potus_current'),
      jsonb_build_object('source', 'executive_seed')
    );
    RAISE NOTICE '[FIX-321] inserted POTUS row (potus_current)';
  ELSE
    UPDATE officials
       SET full_name         = 'Donald J. Trump',
           first_name        = 'Donald',
           last_name         = 'Trump',
           role_title        = 'President of the United States',
           governing_body_id = v_presidency_id,
           jurisdiction_id   = v_federal_id,
           party             = 'republican',
           term_start        = '2025-01-20'::date,
           term_end          = '2029-01-20'::date,
           is_active         = TRUE,
           is_verified       = TRUE,
           website_url       = 'https://www.whitehouse.gov/administration/donald-j-trump/',
           tier              = 'elected',
           updated_at        = now()
     WHERE id = v_potus_id;
    RAISE NOTICE '[FIX-321] updated existing POTUS row (potus_current)';
  END IF;

  -- VPOTUS
  SELECT id INTO v_vpotus_id
    FROM officials
   WHERE source_ids->>'official_seed_id' = 'vpotus_current';
  IF v_vpotus_id IS NULL THEN
    INSERT INTO officials (
      full_name, first_name, last_name, role_title,
      governing_body_id, jurisdiction_id, party,
      term_start, term_end,
      is_active, is_verified, website_url,
      tier, source_ids, metadata
    ) VALUES (
      'J.D. Vance', 'J.D.', 'Vance', 'Vice President of the United States',
      v_presidency_id, v_federal_id, 'republican',
      '2025-01-20'::date, '2029-01-20'::date,
      TRUE, TRUE, 'https://www.whitehouse.gov/administration/jd-vance/',
      'elected',
      jsonb_build_object('official_seed_id', 'vpotus_current'),
      jsonb_build_object('source', 'executive_seed')
    );
    RAISE NOTICE '[FIX-321] inserted VPOTUS row (vpotus_current)';
  ELSE
    UPDATE officials
       SET full_name         = 'J.D. Vance',
           first_name        = 'J.D.',
           last_name         = 'Vance',
           role_title        = 'Vice President of the United States',
           governing_body_id = v_presidency_id,
           jurisdiction_id   = v_federal_id,
           party             = 'republican',
           term_start        = '2025-01-20'::date,
           term_end          = '2029-01-20'::date,
           is_active         = TRUE,
           is_verified       = TRUE,
           website_url       = 'https://www.whitehouse.gov/administration/jd-vance/',
           tier              = 'elected',
           updated_at        = now()
     WHERE id = v_vpotus_id;
    RAISE NOTICE '[FIX-321] updated existing VPOTUS row (vpotus_current)';
  END IF;
END $$;

-- ── Block B: territorial jurisdictions + delegate re-routing ───────────────
-- Locally-investigated set (2026-05-24): 5 active House delegates are
-- mapped to the 'United States' umbrella jurisdiction. Their bioguide IDs
-- and intended territorial jurisdictions are hardcoded here. The 5
-- jurisdictions are created with type='district' to mirror DC's shape
-- (no 'territory' value in the jurisdiction_type enum).

DO $$
DECLARE
  v_federal_id  uuid;
  v_as_id       uuid;
  v_gu_id       uuid;
  v_mp_id       uuid;
  v_pr_id       uuid;
  v_vi_id       uuid;
  v_updated     int;
BEGIN
  SELECT id INTO v_federal_id
    FROM jurisdictions
   WHERE fips_code = '00' AND type = 'country';
  IF v_federal_id IS NULL THEN
    RAISE EXCEPTION '[FIX-321] federal jurisdiction (fips_code=00, type=country) not found';
  END IF;

  -- American Samoa (AS, fips=60)
  SELECT id INTO v_as_id FROM jurisdictions WHERE fips_code = '60' AND type = 'district';
  IF v_as_id IS NULL THEN
    INSERT INTO jurisdictions (name, short_name, type, country_code, fips_code, timezone, parent_id, is_active)
    VALUES ('American Samoa', 'AS', 'district', 'US', '60', 'Pacific/Pago_Pago', v_federal_id, TRUE)
    RETURNING id INTO v_as_id;
  END IF;

  -- Guam (GU, fips=66)
  SELECT id INTO v_gu_id FROM jurisdictions WHERE fips_code = '66' AND type = 'district';
  IF v_gu_id IS NULL THEN
    INSERT INTO jurisdictions (name, short_name, type, country_code, fips_code, timezone, parent_id, is_active)
    VALUES ('Guam', 'GU', 'district', 'US', '66', 'Pacific/Guam', v_federal_id, TRUE)
    RETURNING id INTO v_gu_id;
  END IF;

  -- Northern Mariana Islands (MP, fips=69)
  SELECT id INTO v_mp_id FROM jurisdictions WHERE fips_code = '69' AND type = 'district';
  IF v_mp_id IS NULL THEN
    INSERT INTO jurisdictions (name, short_name, type, country_code, fips_code, timezone, parent_id, is_active)
    VALUES ('Northern Mariana Islands', 'MP', 'district', 'US', '69', 'Pacific/Saipan', v_federal_id, TRUE)
    RETURNING id INTO v_mp_id;
  END IF;

  -- Puerto Rico (PR, fips=72)
  SELECT id INTO v_pr_id FROM jurisdictions WHERE fips_code = '72' AND type = 'district';
  IF v_pr_id IS NULL THEN
    INSERT INTO jurisdictions (name, short_name, type, country_code, fips_code, timezone, parent_id, is_active)
    VALUES ('Puerto Rico', 'PR', 'district', 'US', '72', 'America/Puerto_Rico', v_federal_id, TRUE)
    RETURNING id INTO v_pr_id;
  END IF;

  -- U.S. Virgin Islands (VI, fips=78)
  SELECT id INTO v_vi_id FROM jurisdictions WHERE fips_code = '78' AND type = 'district';
  IF v_vi_id IS NULL THEN
    INSERT INTO jurisdictions (name, short_name, type, country_code, fips_code, timezone, parent_id, is_active)
    VALUES ('U.S. Virgin Islands', 'VI', 'district', 'US', '78', 'America/St_Thomas', v_federal_id, TRUE)
    RETURNING id INTO v_vi_id;
  END IF;

  -- Re-route the 5 delegate officials by bioguide_id. Only flips rows that
  -- are currently mapped to the federal umbrella (defensive — leaves any
  -- already-corrected row alone if this migration is re-run after future
  -- ingest already fixed it).
  v_updated := 0;

  UPDATE officials SET jurisdiction_id = v_as_id, updated_at = now()
   WHERE source_ids->>'congress_gov' = 'R000600'
     AND jurisdiction_id = v_federal_id;
  IF FOUND THEN v_updated := v_updated + 1; END IF;

  UPDATE officials SET jurisdiction_id = v_gu_id, updated_at = now()
   WHERE source_ids->>'congress_gov' = 'M001219'
     AND jurisdiction_id = v_federal_id;
  IF FOUND THEN v_updated := v_updated + 1; END IF;

  UPDATE officials SET jurisdiction_id = v_mp_id, updated_at = now()
   WHERE source_ids->>'congress_gov' = 'K000404'
     AND jurisdiction_id = v_federal_id;
  IF FOUND THEN v_updated := v_updated + 1; END IF;

  UPDATE officials SET jurisdiction_id = v_pr_id, updated_at = now()
   WHERE source_ids->>'congress_gov' = 'H001103'
     AND jurisdiction_id = v_federal_id;
  IF FOUND THEN v_updated := v_updated + 1; END IF;

  UPDATE officials SET jurisdiction_id = v_vi_id, updated_at = now()
   WHERE source_ids->>'congress_gov' = 'P000610'
     AND jurisdiction_id = v_federal_id;
  IF FOUND THEN v_updated := v_updated + 1; END IF;

  RAISE NOTICE '[FIX-321] re-routed % of 5 territorial delegate(s)', v_updated;
END $$;

-- ── Block C: promote_candidate_to_elected() RPC (FIX-248) ──────────────────
-- Transactional FK-rewrite-then-delete that unifies a freshly-created
-- congress-side tier='elected' row with the existing FEC cn{yy}.zip
-- tier='candidate' row when the same person wins their race. Candidate row
-- wins UUID-wise: it carries fec_candidate_id and is bound to FEC IE
-- attribution via FIX-240. The just-created elected row's FK references
-- (votes, proposals, etc.) get rewritten to point at the candidate's UUID,
-- and the elected row is deleted.
--
-- Called per-pair from runCandidateToElectedPromotion (TS) which detects
-- pairs by (lower(trim(full_name)), state, role_title_family).

CREATE OR REPLACE FUNCTION promote_candidate_to_elected(
  p_elected_id   uuid,
  p_candidate_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_merged_source_ids jsonb;
  v_votes_moved       int := 0;
  v_total_fks_moved   int := 0;
  v_step_rows         int;
BEGIN
  IF p_elected_id = p_candidate_id THEN
    RAISE EXCEPTION 'promote_candidate_to_elected: elected and candidate IDs are identical (%)', p_elected_id;
  END IF;

  -- Lock both rows for the duration of the transaction so a concurrent
  -- congress sync re-running doesn't race the FK rewrite.
  PERFORM 1 FROM officials WHERE id = p_elected_id   FOR UPDATE;
  PERFORM 1 FROM officials WHERE id = p_candidate_id FOR UPDATE;

  -- Merge source_ids: jsonb || jsonb keeps the right operand on key conflict,
  -- so we want (candidate || elected) — candidate's fec_candidate_id is
  -- preserved, elected's congress_gov is appended.
  SELECT (c.source_ids || e.source_ids)
    INTO v_merged_source_ids
    FROM officials c, officials e
   WHERE c.id = p_candidate_id AND e.id = p_elected_id;

  -- Promote the candidate row in-place: tier→elected, merge source_ids,
  -- adopt elected's role/jurisdiction/governing-body, copy any field that's
  -- NULL on candidate from elected.
  UPDATE officials AS c SET
    tier              = 'elected',
    source_ids        = v_merged_source_ids,
    role_title        = e.role_title,
    governing_body_id = e.governing_body_id,
    jurisdiction_id   = e.jurisdiction_id,
    first_name        = COALESCE(c.first_name,    e.first_name),
    last_name         = COALESCE(c.last_name,     e.last_name),
    party             = COALESCE(c.party,         e.party),
    district_name     = COALESCE(c.district_name, e.district_name),
    photo_url         = COALESCE(c.photo_url,     e.photo_url),
    term_start        = COALESCE(c.term_start,    e.term_start),
    term_end          = COALESCE(c.term_end,      e.term_end),
    website_url       = COALESCE(c.website_url,   e.website_url),
    is_active         = TRUE,
    updated_at        = now()
  FROM officials AS e
  WHERE c.id = p_candidate_id AND e.id = p_elected_id;

  -- ── FK rewrites: elected_id → candidate_id ───────────────────────────
  -- Declared FKs first:
  UPDATE votes                         SET official_id     = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_votes_moved = ROW_COUNT;
  v_total_fks_moved := v_total_fks_moved + v_votes_moved;

  UPDATE proposal_cosponsors           SET official_id     = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE proposal_actions              SET performed_by_id = p_candidate_id WHERE performed_by_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE bill_details                  SET primary_sponsor_id = p_candidate_id WHERE primary_sponsor_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE official_committee_memberships SET official_id    = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE promises                      SET official_id     = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE civic_initiative_responses    SET official_id     = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE official_community_comments   SET official_id     = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE lobbying_disclosures          SET official_id     = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE career_history                SET official_id     = p_candidate_id WHERE official_id     = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- Polymorphic columns:
  -- financial_relationships has UNIQUE (rel_type, from_id, to_id, cycle_year).
  -- If both elected + candidate rows already carry "same donor → them in same
  -- cycle" rows (common for sitting members who are also active candidates),
  -- the UPDATE would collide. Pre-delete the elected-side colliders; the
  -- candidate-side row is at least as informative (FEC IE attribution path).
  DELETE FROM financial_relationships e
   USING financial_relationships c
   WHERE e.from_type = 'official' AND e.from_id = p_elected_id
     AND c.relationship_type = e.relationship_type
     AND c.from_id            = p_candidate_id
     AND c.from_type          = e.from_type
     AND c.to_type            = e.to_type
     AND c.to_id IS NOT DISTINCT FROM e.to_id
     AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year;

  UPDATE financial_relationships SET from_id = p_candidate_id
    WHERE from_type = 'official' AND from_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  DELETE FROM financial_relationships e
   USING financial_relationships c
   WHERE e.to_type = 'official' AND e.to_id = p_elected_id
     AND c.relationship_type = e.relationship_type
     AND c.from_id IS NOT DISTINCT FROM e.from_id
     AND c.from_type          = e.from_type
     AND c.to_type            = e.to_type
     AND c.to_id              = p_candidate_id
     AND c.cycle_year IS NOT DISTINCT FROM e.cycle_year;

  UPDATE financial_relationships SET to_id = p_candidate_id
    WHERE to_type   = 'official' AND to_id   = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- entity_connections has UNIQUE (from_type, from_id, to_type, to_id,
  -- connection_type). Same collision handling as above.
  DELETE FROM entity_connections e
   USING entity_connections c
   WHERE e.from_type = 'official' AND e.from_id = p_elected_id
     AND c.from_type = e.from_type AND c.from_id = p_candidate_id
     AND c.to_type   = e.to_type   AND c.to_id IS NOT DISTINCT FROM e.to_id
     AND c.connection_type = e.connection_type;

  UPDATE entity_connections SET from_id = p_candidate_id
    WHERE from_type = 'official' AND from_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  DELETE FROM entity_connections e
   USING entity_connections c
   WHERE e.to_type = 'official' AND e.to_id = p_elected_id
     AND c.from_type = e.from_type AND c.from_id IS NOT DISTINCT FROM e.from_id
     AND c.to_type   = e.to_type   AND c.to_id   = p_candidate_id
     AND c.connection_type = e.connection_type;

  UPDATE entity_connections SET to_id = p_candidate_id
    WHERE to_type   = 'official' AND to_id   = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE external_relationships SET from_id = p_candidate_id
    WHERE from_type = 'official' AND from_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE external_relationships SET to_id = p_candidate_id
    WHERE to_type   = 'official' AND to_id   = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE external_source_refs SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE irs990_officers SET matched_entity_id = p_candidate_id
    WHERE matched_entity_type = 'official' AND matched_entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE entity_tags SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- Delete the (now FK-free) elected row.
  DELETE FROM officials WHERE id = p_elected_id;

  RETURN jsonb_build_object(
    'promoted_id',      p_candidate_id,
    'deleted_id',       p_elected_id,
    'votes_moved',      v_votes_moved,
    'total_fks_moved',  v_total_fks_moved,
    'merged_source_ids', v_merged_source_ids
  );
END $$;

COMMIT;
