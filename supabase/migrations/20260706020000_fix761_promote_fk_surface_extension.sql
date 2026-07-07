-- FIX-761 — promote_candidate_to_elected() FK-rewrite surface extension.
--
-- The RPC's rewrite list was FIX-248-era, last extended by FIX-463
-- (entity_tags / enrichment_queue / ai_summary_cache). A live-DB audit
-- (pg_constraint FKs on officials(id) + every polymorphic
-- entity_type/from_type/to_type/target_type/kind='official' convention,
-- 2026-07-06) found FOURTEEN surfaces that landed after it and are NOT
-- rewritten — promotion DELETEs the elected row with no old→new UUID map
-- kept, so every one of them orphans rows on every promotion. With the
-- FIX-755 88-pair drain in progress (25/night) this must land before more
-- drain nights run.
--
-- Moved (elected → candidate), with pre-delete collision handling where a
-- unique constraint could collide (candidate side wins, matching the
-- FIX-463 entity_tags precedent):
--   entity_comments          (entity_type, entity_id)          FIX-519
--   entity_positions         PK (user_id, entity_type, entity_id)  FIX-523
--   position_events          (entity_type, entity_id)          FIX-523
--   entity_statements        (entity_type, entity_id)
--   evidence_cards           (from_type/from_id, to_type/to_id)
--   citations                (target_type, target_id)
--   entity_grants            UNIQUE(user_id, role, target_type, target_id)
--                            WHERE status='active'              FIX-610
--   user_follows             UNIQUE(user_id, entity_type, entity_id)
--   notifications            (entity_type enum incl. 'official', entity_id)
--   entity_activity_state    PK (entity_type, entity_id)
--   page_views               (entity_type, entity_id) partial idx
--   irs990_grants_out        (matched_entity_type, matched_entity_id) —
--                            CHECK allows 'official'; mirrors irs990_officers
--
-- Deleted (derived, self-healing — recomputed by their own machinery):
--   official_donor_rollup_mv  incremental pg_cron recompute picks up the
--                             candidate id (the FR rewrite bumps updated_at
--                             via trigger → rows go dirty)          FIX-704
--   entity_search_index       nightly rebuild_entity_search_index() re-adds
--                             the candidate row; the elected row would 404
--                             from search until then                FIX-748
--
-- Audited and deliberately NOT rewritten:
--   official_content_ids      declared FK ON DELETE CASCADE (cache watermark,
--                             regenerates on next refresh)
--   user_preferences.followed_officials  uuid[] — legacy column, no code
--                             reads it outside its own migration + db types
--   franklin_seed_map         synthetic-seed ledger; congress promotion never
--                             touches seeded rows
--   brigade_candidates        append-only detection artifact — historical
--                             snapshot semantics (SF-P4)
--   moderation_audit          fixture-based, no entity uuid refs (SF-P3)
--   synthetic_position_rollup derived + synthetic-only officials
--   group_donor_rollup        gb/financial_entity refs only
--   civic_credit_transactions related_entity_type has no official convention
--   external_relationships_review_queue.candidate_matches  jsonb matcher
--                             payload, tolerant of stale ids at review time
--   browse_facet_counts       aggregate counts, no entity ids
--
-- Cross-ref [[FIX-248]] [[FIX-463]] [[FIX-755]] [[FIX-519]] [[FIX-523]].
-- Like 20260602000000: pure CREATE OR REPLACE FUNCTION — must always run on
-- replays (a seed guard would resurrect the narrower rewrite list).

BEGIN;

-- entity_comments carries a pin trigger (entity_comments_pin_immutable) that
-- rejects ANY change to author_id / entity_type / entity_id / kind /
-- constituent_jurisdiction_id. The promotion rewrite legitimately moves
-- entity_id (elected → candidate), so unpin ONLY entity_id, ONLY under the
-- transaction-scoped GUC the promotion function sets below. Every other pin
-- stays enforced unconditionally.
CREATE OR REPLACE FUNCTION public.entity_comments_pin_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF NEW.author_id                   IS DISTINCT FROM OLD.author_id
     OR NEW.entity_type              IS DISTINCT FROM OLD.entity_type
     OR (NEW.entity_id               IS DISTINCT FROM OLD.entity_id
         AND COALESCE(current_setting('civitics.promotion_rewrite', true), '') <> 'on')
     OR NEW.kind                     IS DISTINCT FROM OLD.kind
     OR NEW.constituent_jurisdiction_id IS DISTINCT FROM OLD.constituent_jurisdiction_id THEN
    RAISE EXCEPTION 'entity_comments immutable column changed (author_id / entity_type / entity_id / kind / constituent_jurisdiction_id are pinned)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

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
    'merged_source_ids', v_merged_source_ids
  );
END $$;

COMMIT;
