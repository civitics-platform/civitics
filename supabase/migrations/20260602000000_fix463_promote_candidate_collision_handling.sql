-- FIX-463 (Stage A) — promote_candidate_to_elected() unique-collision handling.
--
-- Investigation (prod, 2026-06-02) of the ~27-min/run congress pipeline timeout
-- sink found the promote-candidates stage was NOT merely slow: the RPC fails
-- with a UNIQUE-constraint *data error*, not (only) a statement timeout.
--
--   ERROR: duplicate key value violates unique constraint
--          "entity_tags_entity_type_entity_id_tag_tag_category_key"
--   CONTEXT: UPDATE entity_tags SET entity_id = p_candidate_id
--            WHERE entity_type = 'official' AND entity_id = p_elected_id
--
-- Both the elected (congress-side) and candidate (FEC-side) rows carry the same
-- *derived* tags, so the plain `UPDATE entity_tags SET entity_id = candidate`
-- collides with the candidate row's pre-existing identical tag. The original
-- RPC had pre-delete collision handling for votes / proposal_cosponsors /
-- financial_relationships / entity_connections, but NOT for entity_tags — so
-- every pair with a colliding derived tag aborted and rolled back. Only 2 of
-- 258 detected pairs had ever promoted (merged_both_keys=2 on prod).
--
-- A single rolled-back call took 17.3s, which independently exceeds the prod
-- PostgREST role's ~8s statement_timeout — so in the nightly the call fails as a
-- timeout *before* even reaching the entity_tags statement. The pipeline-side
-- fix (route the per-pair call through a direct pg.Client with a raised SESSION
-- statement_timeout, mirroring lib/heavy-rebuild.ts) lifts the 8s cap; this
-- migration fixes the underlying collision so the now-completing call actually
-- commits.
--
-- Two changes:
--   1. entity_tags — add the missing pre-delete (candidate side wins; derived
--      tags are regenerable, so dropping the duplicate elected-side row is safe).
--   2. enrichment_queue + ai_summary_cache — the original RPC never moved these
--      at all, so their entity_id rows were silently ORPHANED when the elected
--      row was deleted (line 406). Add proper moves WITH pre-delete collision
--      handling (both carry UNIQUE on (entity_type/entity_id, …)).
--
-- All four collision keys (tag, tag_category, task_type, summary_type) are
-- NOT NULL, so plain `=` matches the unique-constraint semantics exactly (no
-- IS NOT DISTINCT FROM needed). Cross-ref [[FIX-248]] (original RPC),
-- [[FIX-444]] (direct-pg raised-timeout precedent), [[FIX-462]] (sibling
-- timeout-sink fix that surfaced this).
--
-- FIX-516 (2026-06-11): enumerated in the FIX-516 seed-dependent set but
-- deliberately NOT guarded. This file is a pure CREATE OR REPLACE FUNCTION —
-- plpgsql bodies are not resolved against data at definition time, so it
-- cannot fail on an empty DB. A seed guard here would be actively harmful: a
-- from-zero replay would skip the upgrade and leave promote_candidate_to_elected
-- at the FIX-248 definition (from 20260525051720 Block C), reintroducing the
-- entity_tags collision bug this migration fixes. Replays must always run it.

BEGIN;

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
