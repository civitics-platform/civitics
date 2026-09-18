-- FIX-1195 clone test for promote_candidate_to_elected().
-- Runs inside db-query.mjs's single transaction; nothing is committed.
DO $test$
DECLARE
  v_jur   uuid;
  v_e     uuid;
  v_c     uuid;
  v_res   jsonb;
  v_src   jsonb;
BEGIN
  SELECT id INTO v_jur FROM jurisdictions LIMIT 1;

  -- ── CASE 1: elected holds a DIFFERENT id from the candidate ──────────────
  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case One', 'Representative', 'elected',
          '{"congress_gov":"X000001","fec_candidate_id":"H4XX08066"}'::jsonb)
  RETURNING id INTO v_e;

  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case One', 'Candidate for Representative', 'candidate',
          '{"fec_candidate_id":"H6XX09200"}'::jsonb)
  RETURNING id INTO v_c;

  v_res := promote_candidate_to_elected(v_e, v_c);
  SELECT source_ids INTO v_src FROM officials WHERE id = v_c;

  ASSERT v_src->>'fec_candidate_id' = 'H6XX09200',
    'CASE1: candidate id must WIN, got ' || coalesce(v_src->>'fec_candidate_id','<null>');
  ASSERT v_src->'prior_fec_candidate_ids' @> '["H4XX08066"]'::jsonb,
    'CASE1: elected id must be filed as prior, got ' || coalesce(v_src->>'prior_fec_candidate_ids','<null>');
  ASSERT v_src->>'congress_gov' = 'X000001',
    'CASE1: congress_gov must survive';
  ASSERT NOT EXISTS (SELECT 1 FROM officials WHERE id = v_e),
    'CASE1: elected row must be deleted';
  ASSERT v_src->'merged_fec_candidate_ids' IS NULL,
    'CASE1: nothing may be filed as RETIRED';
  RAISE NOTICE 'CASE1 ok: %', v_src::text;

  -- ── CASE 2: elected holds NO fec_candidate_id — nothing appended ─────────
  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case Two', 'Senator', 'elected',
          '{"congress_gov":"X000002"}'::jsonb)
  RETURNING id INTO v_e;

  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case Two', 'Candidate for Senator', 'candidate',
          '{"fec_candidate_id":"S4XX00555"}'::jsonb)
  RETURNING id INTO v_c;

  PERFORM promote_candidate_to_elected(v_e, v_c);
  SELECT source_ids INTO v_src FROM officials WHERE id = v_c;

  ASSERT v_src->>'fec_candidate_id' = 'S4XX00555', 'CASE2: candidate id kept';
  ASSERT v_src->'prior_fec_candidate_ids' IS NULL,
    'CASE2: nothing may be appended, got ' || coalesce(v_src->>'prior_fec_candidate_ids','<null>');
  ASSERT v_src->>'congress_gov' = 'X000002', 'CASE2: congress_gov must survive';
  RAISE NOTICE 'CASE2 ok: %', v_src::text;

  -- ── CASE 3: both rows hold the SAME id — no self-append ──────────────────
  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case Three', 'Senator', 'elected',
          '{"congress_gov":"X000003","fec_candidate_id":"S0XX00137"}'::jsonb)
  RETURNING id INTO v_e;

  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case Three', 'Candidate for Senator', 'candidate',
          '{"fec_candidate_id":"S0XX00137"}'::jsonb)
  RETURNING id INTO v_c;

  PERFORM promote_candidate_to_elected(v_e, v_c);
  SELECT source_ids INTO v_src FROM officials WHERE id = v_c;

  ASSERT v_src->>'fec_candidate_id' = 'S0XX00137', 'CASE3: id kept';
  ASSERT v_src->'prior_fec_candidate_ids' IS NULL,
    'CASE3: an identical id must NOT be appended to itself';
  RAISE NOTICE 'CASE3 ok: %', v_src::text;

  -- ── CASE 4: the elected row carries prior ids of its own ─────────────────
  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case Four', 'Senator', 'elected',
          '{"congress_gov":"X000004","fec_candidate_id":"H8XX03238","prior_fec_candidate_ids":["H0XX27085"]}'::jsonb)
  RETURNING id INTO v_e;

  INSERT INTO officials (jurisdiction_id, full_name, role_title, tier, source_ids)
  VALUES (v_jur, 'FIX1195 Case Four', 'Candidate for Senator', 'candidate',
          '{"fec_candidate_id":"S4XX00282","prior_fec_candidate_ids":["S8XX00210"]}'::jsonb)
  RETURNING id INTO v_c;

  PERFORM promote_candidate_to_elected(v_e, v_c);
  SELECT source_ids INTO v_src FROM officials WHERE id = v_c;

  ASSERT v_src->>'fec_candidate_id' = 'S4XX00282', 'CASE4: candidate id wins';
  ASSERT v_src->'prior_fec_candidate_ids' @> '["S8XX00210"]'::jsonb,
    'CASE4: candidate own prior kept';
  ASSERT v_src->'prior_fec_candidate_ids' @> '["H0XX27085"]'::jsonb,
    'CASE4: elected prior must not be dropped by the concatenation';
  ASSERT v_src->'prior_fec_candidate_ids' @> '["H8XX03238"]'::jsonb,
    'CASE4: elected live id must be filed as prior';
  ASSERT jsonb_array_length(v_src->'prior_fec_candidate_ids') = 3,
    'CASE4: exactly three priors, got ' || v_src->>'prior_fec_candidate_ids';
  RAISE NOTICE 'CASE4 ok: %', v_src::text;

  RAISE NOTICE 'FIX-1195 clone test: ALL 4 CASES PASS';
END
$test$;
ROLLBACK;
