-- FIX-1195 - promote_candidate_to_elected() destroyed the promoted candidate's
-- own fec_candidate_id, and dropped the elected row's id with the row.
--
-- THE BUG, in one line: jsonb concatenation keeps the RIGHT operand on key
-- conflict, and the function wrote (c.source_ids || e.source_ids) under a
-- comment that said the opposite. The elected row's keys won every conflict, so
-- the candidate row - the row that SURVIVES the promotion - came out holding the
-- deleted row's fec_candidate_id and not its own.
--
-- THE DAMAGE, measured on prod 2026-09-17: three CAND_IDs with zero holders on
-- any surface (live / prior / merged / fec_id) - H6NC09200, H2NJ13075,
-- S0KS00315. An unheld CAND_ID is not cosmetic: the cn{yy} stage of the weekly
-- FEC drop mints a fresh candidate stub for any id no officials row claims, so
-- each would have returned on Sunday 2026-09-20 as a NEW stub carrying NEW
-- money and the repair would have tripled. The data restore is a separate,
-- keyed, 3-row write; this migration is the code fix that stops the recurrence.
--
-- THIS MIGRATION: swap the operands, and file the losing id into
-- prior_fec_candidate_ids instead of dropping it. Signature unchanged, so the
-- FIX-834 grant matrix (service_role only) carries over untouched by
-- CREATE OR REPLACE. No SET clause is added - the function stays
-- transaction-control-compatible and check:proconfig-clean (FIX-1128).
--
-- WHY prior AND NOT merged, including for a same-chamber loser. cc-131's design
-- filed a same-office loser into merged_fec_candidate_ids. Reading the parsers
-- (packages/data/src/pipelines/fec-bulk/claims.ts) says that array cannot carry
-- this: authoritativeClaims() FILTERS retired ids out, and it is what both
-- buildMatchIndex pass 1 and loadOfficialsByFecIds consult, so an id filed as
-- retired is claimed by nobody and the cn stage re-mints it. That is the same
-- zero-holder state this migration exists to prevent, reached one indirection
-- later. Retirement is only safe where a merge puts it - on a stub, while the
-- survivor holds the id live. Here the other row is deleted.
--
-- NOTE ON REACHABILITY: FIX-1196 stops the nightly promotion from feeding this
-- function any elected row that holds an fec_candidate_id at all, so the new
-- branch should be cold in the nightly. It is still the correct behaviour for
-- any other caller, and for an elected row carrying only prior ids.

BEGIN;

CREATE OR REPLACE FUNCTION promote_candidate_to_elected(
  p_elected_id   uuid,
  p_candidate_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_merged_source_ids jsonb;
  v_elected_fec_id    text;
  v_candidate_fec_id  text;
  v_prior_ids         jsonb;
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

  -- FIX-1195 — Merge source_ids. jsonb concatenation keeps the RIGHT operand on
  -- key conflict, so the operand whose keys must WIN goes on the right. That is
  -- the candidate: it is the row that survives, and its fec_candidate_id is the
  -- FEC binding every IE relationship already hangs off (FIX-240).
  --
  -- The comment that stood here stated that rule correctly and the code then
  -- wrote (c || e), which keeps the ELECTED row's keys. So every promotion
  -- silently destroyed the promoted candidate's own fec_candidate_id. On
  -- 2026-09-17 three went that way on prod - H6NC09200 (Harris), H2NJ13075
  -- (Menendez) and S0KS00315 (Marshall) - each left with ZERO holders anywhere,
  -- which is a fresh stub carrying fresh money at the next weekly FEC drop.
  SELECT (e.source_ids || c.source_ids),
         NULLIF(e.source_ids->>'fec_candidate_id', ''),
         NULLIF(c.source_ids->>'fec_candidate_id', '')
    INTO v_merged_source_ids, v_elected_fec_id, v_candidate_fec_id
    FROM officials c, officials e
   WHERE c.id = p_candidate_id AND e.id = p_elected_id;

  -- FIX-1195 — and NEVER DROP THE LOSER. The elected row is DELETED at the end
  -- of this function, so any CAND_ID it held that the merge did not keep has no
  -- holder left anywhere in the table.
  --
  -- The loser goes to prior_fec_candidate_ids, whatever its office prefix. That
  -- array is the only one that KEEPS A CLAIM: authoritativeClaims() returns
  -- fec_candidate_id plus the prior ids, and that is what both buildMatchIndex
  -- pass 1 and loadOfficialsByFecIds read, so a prior id resolves to this row
  -- and blocks the cn{yy} stage from re-minting a stub for it.
  -- merged_fec_candidate_ids is the opposite - a RETIRED claim, filtered OUT of
  -- authoritativeClaims by design (FIX-955). Retiring is safe on a merge stub
  -- only because the survivor holds the id live; here nothing else holds it, so
  -- filing the loser as retired would leave it unclaimed and re-mintable. Same
  -- outcome as dropping it, one indirection later.
  --
  -- prior_fec_candidate_ids is not role-gated (see claims.ts), so a same-chamber
  -- loser is a legitimate entry: H4NC08066 and H6NC09200 are NC-08 and NC-09,
  -- two different seats.
  v_prior_ids := CASE
    WHEN jsonb_typeof(v_merged_source_ids->'prior_fec_candidate_ids') = 'array'
      THEN v_merged_source_ids->'prior_fec_candidate_ids'
    ELSE '[]'::jsonb
  END;

  -- The elected row's OWN prior ids lose their holder for the same reason, and
  -- the concatenation above drops them whenever the candidate also has an array.
  SELECT COALESCE(v_prior_ids || jsonb_agg(x), v_prior_ids)
    INTO v_prior_ids
    FROM officials e,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(e.source_ids->'prior_fec_candidate_ids') = 'array'
                THEN e.source_ids->'prior_fec_candidate_ids'
                ELSE '[]'::jsonb END) AS x
   WHERE e.id = p_elected_id
     AND jsonb_typeof(x) = 'string'
     AND x <> '""'::jsonb
     AND NOT (v_prior_ids @> x)
     AND (v_candidate_fec_id IS NULL OR x <> to_jsonb(v_candidate_fec_id));

  IF v_elected_fec_id IS NOT NULL
     AND v_elected_fec_id IS DISTINCT FROM v_candidate_fec_id
     AND NOT (v_prior_ids @> to_jsonb(v_elected_fec_id))
  THEN
    v_prior_ids := v_prior_ids || to_jsonb(v_elected_fec_id);
  END IF;

  IF jsonb_array_length(v_prior_ids) > 0 THEN
    v_merged_source_ids := jsonb_set(
      v_merged_source_ids, '{prior_fec_candidate_ids}', v_prior_ids, true);
  END IF;

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

  -- (official_content_ids is a declared FK too, but ON DELETE CASCADE — it is
  -- a per-official cache watermark that regenerates; deliberately not moved.)

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

  -- entity_tags has UNIQUE (entity_type, entity_id, tag, tag_category). Both the
  -- elected and candidate rows carry the same DERIVED tags (rule + AI taggers
  -- run on both), so a plain UPDATE collides. FIX-463: pre-delete the
  -- elected-side duplicates (candidate side wins; tags are regenerable), then
  -- move the rest. (tag + tag_category are NOT NULL → plain `=`.)
  DELETE FROM entity_tags e
   USING entity_tags c
   WHERE e.entity_type = 'official' AND e.entity_id = p_elected_id
     AND c.entity_type = 'official' AND c.entity_id = p_candidate_id
     AND c.tag          = e.tag
     AND c.tag_category = e.tag_category;

  UPDATE entity_tags SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- enrichment_queue has UNIQUE (entity_id, entity_type, task_type). FIX-463:
  -- the original RPC never moved these, so they were left ORPHANED when the
  -- elected row was deleted below. Move them with pre-delete collision handling.
  -- NOTE: enrichment_queue.entity_id is TEXT (it stores the uuid as a string),
  -- unlike the uuid entity_id on entity_tags / ai_summary_cache — so the uuid
  -- params must be cast to ::text or the comparison raises "operator does not
  -- exist: text = uuid". (task_type is NOT NULL → plain `=`.)
  DELETE FROM enrichment_queue e
   USING enrichment_queue c
   WHERE e.entity_type = 'official' AND e.entity_id = p_elected_id::text
     AND c.entity_type = 'official' AND c.entity_id = p_candidate_id::text
     AND c.task_type   = e.task_type;

  UPDATE enrichment_queue SET entity_id = p_candidate_id::text
    WHERE entity_type = 'official' AND entity_id = p_elected_id::text;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- ai_summary_cache has UNIQUE (entity_type, entity_id, summary_type). FIX-463:
  -- same orphan fix as enrichment_queue. (summary_type is NOT NULL → plain `=`.)
  DELETE FROM ai_summary_cache e
   USING ai_summary_cache c
   WHERE e.entity_type = 'official' AND e.entity_id = p_elected_id
     AND c.entity_type = 'official' AND c.entity_id = p_candidate_id
     AND c.summary_type = e.summary_type;

  UPDATE ai_summary_cache SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- ── FIX-761: post-FIX-463 surfaces (see migration header) ──────────────

  -- Unpin entity_comments.entity_id for the rest of this transaction (the
  -- pin trigger rejects entity_id changes otherwise; see the trigger above).
  PERFORM set_config('civitics.promotion_rewrite', 'on', true);

  -- entity_comments (FIX-519): no unique on the entity ref — plain move.
  UPDATE entity_comments SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- entity_positions (FIX-523): PK (user_id, entity_type, entity_id) — a user
  -- with a stance on BOTH rows would collide; candidate side wins.
  DELETE FROM entity_positions e
   USING entity_positions c
   WHERE e.entity_type = 'official' AND e.entity_id = p_elected_id
     AND c.entity_type = 'official' AND c.entity_id = p_candidate_id
     AND c.user_id = e.user_id;

  UPDATE entity_positions SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- position_events (FIX-523): append-only stance journal, no unique.
  UPDATE position_events SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- entity_statements: only unique is source_comment_id (not the entity ref).
  UPDATE entity_statements SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- evidence_cards: from/to polymorphic pair, no unique — plain moves.
  UPDATE evidence_cards SET from_id = p_candidate_id
    WHERE from_type = 'official' AND from_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  UPDATE evidence_cards SET to_id = p_candidate_id
    WHERE to_type = 'official' AND to_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- citations: evidence-card citations targeting the official.
  UPDATE citations SET target_id = p_candidate_id
    WHERE target_type = 'official' AND target_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- entity_grants (FIX-610 answerer grants): UNIQUE (user_id, role,
  -- target_type, target_id) WHERE status='active' — pre-delete elected-side
  -- grants whose (user, role) already has an active candidate-side grant.
  DELETE FROM entity_grants e
   USING entity_grants c
   WHERE e.target_type = 'official' AND e.target_id = p_elected_id
     AND e.status = 'active'
     AND c.target_type = 'official' AND c.target_id = p_candidate_id
     AND c.status = 'active'
     AND c.user_id = e.user_id
     AND c.role    = e.role;

  UPDATE entity_grants SET target_id = p_candidate_id
    WHERE target_type = 'official' AND target_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- user_follows: UNIQUE (user_id, entity_type, entity_id) — a user following
  -- both rows would collide; candidate side wins.
  DELETE FROM user_follows e
   USING user_follows c
   WHERE e.entity_type = 'official' AND e.entity_id = p_elected_id
     AND c.entity_type = 'official' AND c.entity_id = p_candidate_id
     AND c.user_id = e.user_id;

  UPDATE user_follows SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- notifications: entity_type enum includes 'official'; link continuity.
  UPDATE notifications SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- entity_activity_state: PK (entity_type, entity_id) — slow-mode window
  -- state; candidate side wins on collision (state is transient).
  DELETE FROM entity_activity_state e
   USING entity_activity_state c
   WHERE e.entity_type = 'official' AND e.entity_id = p_elected_id
     AND c.entity_type = 'official' AND c.entity_id = p_candidate_id;

  UPDATE entity_activity_state SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- page_views: analytics attribution continuity (partial idx
  -- (entity_type, entity_id) WHERE entity_id IS NOT NULL matches this WHERE).
  UPDATE page_views SET entity_id = p_candidate_id
    WHERE entity_type = 'official' AND entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- irs990_grants_out: CHECK allows matched_entity_type='official' even though
  -- today's matcher only binds financial_entity/agency — mirror irs990_officers.
  UPDATE irs990_grants_out SET matched_entity_id = p_candidate_id
    WHERE matched_entity_type = 'official' AND matched_entity_id = p_elected_id;
  GET DIAGNOSTICS v_step_rows = ROW_COUNT; v_total_fks_moved := v_total_fks_moved + v_step_rows;

  -- Derived, self-healing surfaces: drop the elected-side rows; their own
  -- rebuild machinery re-emits the candidate side (see migration header).
  DELETE FROM official_donor_rollup_mv WHERE official_id = p_elected_id;
  DELETE FROM entity_search_index WHERE kind = 'official' AND entity_id = p_elected_id;

  -- Delete the (now FK-free) elected row.
  DELETE FROM officials WHERE id = p_elected_id;

  RETURN jsonb_build_object(
    'promoted_id',      p_candidate_id,
    'deleted_id',       p_elected_id,
    'votes_moved',      v_votes_moved,
    'total_fks_moved',  v_total_fks_moved,
    'merged_source_ids', v_merged_source_ids,
    'prior_fec_candidate_ids', v_prior_ids
  );
END $$;


COMMIT;
