-- 20261006010000_fix1278_official_redirects.sql
--
-- FIX-1278 — a retired official UUID 404s. promote_candidate_to_elected()
-- deletes the elected row and leaves no forwarding address, so every link,
-- bookmark and search-engine entry for the old /officials/<uuid> lands on the
-- not-found UI.
--
-- THE BUG, MEASURED. cc-194 W1 (prod, 2026-10-05 00:03:22-00:04:20 UTC)
-- promoted eleven sitting members by dataset key (FIX-1189 Table E1,
-- docs/audits/2026-10-05-fix1189-promotion-landing-plan.md). Their old
-- addresses have answered the not-found UI since. Read 2026-10-06 04:07Z:
-- /officials/88b9e155-... (Austin Scott's old id) is HTTP 200, title
-- "Official | Civitics", body "Not Found". It is 200, not 404, because
-- officials/[id]/loading.tsx puts the page under Suspense, and a page-level
-- notFound() then degrades to a 200 (FIX-418/433/439; middleware.ts).
--
-- TWO CORRECTIONS TO THE BULLET (read, not assumed):
--   (i)  "merge-same-person-official-dupes retires a dup the same way" — it
--        does not. That script's header says NO officials ROW IS DELETED; its
--        DELETEs hit financial_relationships / official_donor_totals /
--        entity_connections only, and a retired stub is an UPDATE to
--        merged_fec_candidate_ids. It deletes nothing addressable, so it needs
--        no hook here.
--   (ii) the live body is 20261005200000_fix1279 (not the FIX-1195 file); its
--        DELETE FROM officials is the only live path that retires an id.
--   And it is ELEVEN, not thirteen: cc-194 W2 (set 3, shape B) deleted
--   nothing; Cisneros and Self kept their elected rows.
--
-- THE FIX, THREE PARTS.
--   1. public.official_redirects (old_id -> new_id). Single-hop by
--      construction: the RPC collapses chains at write time (part 2), so a
--      reader does ONE lookup and never walks. Public-read (anon SELECT), the
--      FIX-1217 idiom: the edge middleware reads it through PostgREST with the
--      publishable key and answers 308 (apps/civitics/src/lib/
--      official-redirects.ts). The redirect must happen in middleware, not the
--      page — loading.tsx would degrade a page-level permanentRedirect() to a
--      200 + meta-refresh, the same root cause as above.
--      NO FOREIGN KEY on either column. old_id's officials row is gone by
--      definition. A FK on new_id would have to be re-pointed inside the RPC
--      before its own DELETE of a row that is an earlier redirect's target —
--      the UPDATE in part 2 does exactly that without the constraint — and it
--      would make every other delete of a target (the synthetic franklin
--      reset, a hand cleanup) fail on a table nothing else reads.
--   2. promote_candidate_to_elected(): the FIX-1279 body VERBATIM plus two
--      statements immediately before DELETE FROM officials — re-point every
--      redirect whose target is the row being deleted, then record the
--      deleted id. The function writes no other audit trail, so this row is
--      the durable record of a promotion's retired id. Signature unchanged,
--      no SET clause (FIX-1128): CREATE OR REPLACE keeps the FIX-834 ACL
--      (EXECUTE for postgres + service_role only) and the body stays
--      transaction-control-compatible.
--   3. Backfill the eleven, env-portably: a row lands only where the survivor
--      EXISTS and the old id does NOT. The second guard is the table's
--      invariant (never redirect an id that still answers). It matters on the
--      local prod-clone, where the promotion never ran and all eleven old ids
--      are still live rows (read 2026-10-06), so the clone's count is 0 and
--      prod's is 11. The DO block asserts 0..11 and prints the count; the
--      prod read-back asserts the 11.
--
-- Prod's live body was read first (2026-10-06 04:06Z): md5(prosrc)
-- 648fe21532c52397701e207fec1edd1f, length 20,522 — byte-equal to the
-- 20261005200000 file, so this CREATE OR REPLACE reverts nothing.

BEGIN;

-- ── 1. The table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.official_redirects (
  old_id    uuid        PRIMARY KEY,
  new_id    uuid        NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  reason    text        NOT NULL,
  CONSTRAINT official_redirects_not_self CHECK (old_id <> new_id)
);

-- The chain-collapse UPDATE's key.
CREATE INDEX IF NOT EXISTS official_redirects_new_id_idx
  ON public.official_redirects (new_id);

ALTER TABLE public.official_redirects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS official_redirects_read ON public.official_redirects;
CREATE POLICY official_redirects_read
  ON public.official_redirects FOR SELECT USING (true);
GRANT SELECT ON public.official_redirects TO anon, authenticated, service_role;

-- ── 2. The RPC records the id it deletes ────────────────────────────────────

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
  --
  -- FIX-1279: except the six identity fields, which read the ELECTED row
  -- first. For a sitting member congress.gov is authoritative, and the
  -- candidate stub carries the FEC legal name ("ASHLEY ARENHOLZ", district
  -- "02"). full_name was never written at all before. party and the term
  -- dates stay candidate-first.
  UPDATE officials AS c SET
    tier              = 'elected',
    source_ids        = v_merged_source_ids,
    role_title        = e.role_title,
    governing_body_id = e.governing_body_id,
    jurisdiction_id   = e.jurisdiction_id,
    full_name         = COALESCE(e.full_name,     c.full_name),
    first_name        = COALESCE(e.first_name,    c.first_name),
    last_name         = COALESCE(e.last_name,     c.last_name),
    party             = COALESCE(c.party,         e.party),
    district_name     = COALESCE(e.district_name, c.district_name),
    photo_url         = COALESCE(e.photo_url,     c.photo_url),
    term_start        = COALESCE(c.term_start,    e.term_start),
    term_end          = COALESCE(c.term_end,      e.term_end),
    website_url       = COALESCE(e.website_url,   c.website_url),
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

  -- FIX-1278: leave a forwarding address. Re-point every redirect whose target
  -- is the row being deleted (the chain collapses at write time, so the table
  -- stays single-hop), then record the deleted id itself.
  UPDATE public.official_redirects SET new_id = p_candidate_id, merged_at = now()
    WHERE new_id = p_elected_id;
  INSERT INTO public.official_redirects (old_id, new_id, reason)
    VALUES (p_elected_id, p_candidate_id, 'promotion')
    ON CONFLICT (old_id) DO UPDATE
      SET new_id = EXCLUDED.new_id, merged_at = now(), reason = EXCLUDED.reason;

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

-- ── 3. Backfill: the eleven cc-194 W1 promoted (FIX-1189 Table E1) ──────────
-- old = the elected row cc-194 deleted; new = the candidate stub that survived.
INSERT INTO public.official_redirects (old_id, new_id, reason)
SELECT v.old_id, v.new_id, 'promotion:cc-194-W1-2026-10-05'
FROM (VALUES
  ('3ba56de6-f313-4f1f-afbe-c4e360f459db'::uuid, '8ab73c89-3703-43f3-9ed4-1023bf465527'::uuid),  -- McClain Delaney
  ('1fcd4ca1-8598-476e-a469-d0abdf604863'::uuid, '369bd6b6-2e5c-409d-82fd-bb426b7a66aa'::uuid),  -- Hinson
  ('e1824501-eb21-4c20-8596-b8a86b543ccd'::uuid, '439f33bb-0ed0-4a27-aedd-3d1e1c8fa8a2'::uuid),  -- Radewagen
  ('88b9e155-0d06-48f3-94e5-bec952869441'::uuid, '893a581e-4fc0-4190-b43f-6afafc7aa917'::uuid),  -- Austin Scott
  ('eadbf1fd-e245-44ff-91ec-794407411f69'::uuid, '93a6040f-402c-4f85-8d0d-55cf1b0350b2'::uuid),  -- Luján
  ('6a01a39b-8283-40a8-9017-a1eb5d6a340c'::uuid, 'eb6e7f4c-dc9c-47c5-a016-5d499dccd0ac'::uuid),  -- Watson Coleman
  ('42d07b67-ae64-4276-ac92-3b40fc4a46a3'::uuid, '71c5b1c0-7436-499f-a2e1-61f2e2f681a2'::uuid),  -- García
  ('e899cac1-7982-4a3b-96a0-eb25e39553dc'::uuid, '29714b2c-42bf-4b43-a82d-60785caa4af7'::uuid),  -- Sánchez
  ('380c47ba-e2b2-4008-8847-1c405343ffc2'::uuid, '499e1266-e4cd-4188-b9b8-4ff321e9863f'::uuid),  -- Barragán
  ('838ab3f3-760f-4e65-9f3a-08bb474a8692'::uuid, 'cd949887-7a4e-4c1d-827d-501ad06522de'::uuid),  -- Velázquez
  ('cccaae0a-35fd-48ad-a365-c005da9c12b4'::uuid, '02942ed7-fec5-4384-b0cb-d94775ba7d26'::uuid)   -- Hernández
) AS v(old_id, new_id)
WHERE EXISTS     (SELECT 1 FROM public.officials o WHERE o.id = v.new_id)
  AND NOT EXISTS (SELECT 1 FROM public.officials o WHERE o.id = v.old_id)
ON CONFLICT (old_id) DO NOTHING;

DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.official_redirects;
  -- The migration cannot know its host: prod is 11, the clone (where the
  -- promotion never ran) is 0. The prod read-back asserts the 11.
  ASSERT v_n BETWEEN 0 AND 11, 'official_redirects: expected 0..11 rows, got ' || v_n;
  RAISE NOTICE 'FIX-1278 official_redirects backfill: % row(s)', v_n;
END $$;

COMMIT;
