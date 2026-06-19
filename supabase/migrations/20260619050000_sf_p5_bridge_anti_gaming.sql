-- FIX-612 / SF-P5 — bridge-score anti-gaming (rater trust + cross-stance independence).
--
-- state-of-franklin-bible §11.1 F10 ("bridge gaming"), §12.
--
-- THE ATTACK (proven by the SF-P3 harness F10 fixture). bridge_score =
-- valuable_rate × map_y. A balanced fake cross-vote — a small ring of throwaway
-- accounts splitting their stances evenly and all marking valuable=+1 — yields
-- pos=neg → map_y=1, valuable_up=all → valuable_rate=1 → bridge_score=1.0, with
-- ZERO genuine disagreement. A perfect farmed "bridge".
--
-- WHY SF-P1 / SF-P4 DON'T COVER IT.
--   - SF-P1 (FIX-572) excludes *synthetic* raters, but the F10 ring is
--     *non-synthetic* throwaway/new accounts. Synthetic-exclusion alone misses it.
--   - SF-P4 (FIX-608) detect_brigade_candidates() clusters *same-direction*
--     (agree,valuable) sign with csize≥5; F10 splits stance into two size-3
--     direction-groups, so SF-P4 structurally never fires on the balanced farm.
--   SF-P5 therefore STANDS ALONE. (SF-P4 remains complementary — it catches the
--   same-direction pile-on SF-P5's per-side floor does not target.)
--
-- THE LEVER (and why the obvious one fails). map_y and valuable_rate are both
-- RATIOS, so a uniform per-rater trust weight CANCELS — proportional weighting
-- changes nothing. The discriminator that actually flips F10 is an ABSOLUTE
-- trusted-mass FLOOR per stance side: each side of the cross-stance endorsement
-- must be backed by real, established raters, not a ring of accounts minted an
-- hour ago. We weight each endorser by account-age trust (the only rater-trust
-- signal the platform stores — no IP/device/verified-constituent flag exists,
-- per the SF-P4 signal inventory), sum it per side as tw_pos / tw_neg, and
-- require least(tw_pos, tw_neg) >= 1.0 trusted-equivalent endorsers before a
-- comment qualifies for a score. map_x / map_y are recomputed from the
-- trust-weighted sides.
--   - F10 ring (all created ~now, trust=0 on both sides): least(0,0)=0 < 1.0 →
--     does NOT qualify → bridge_score NULL. The farm is denied.
--   - A genuine cross-bloc moment (aged, varied accounts on each side): tw_pos,
--     tw_neg ≥ 1.0 → qualifies → still scores high. The positive control.
--
-- CONSERVATIVE / FP-AWARE (the SF-P4 lesson). A null score is NOT a penalty — it
-- is the scorer's existing "not enough honest signal yet" state (most comments
-- are unscored and that is correct). A false "this is gamed" that tanks a real
-- comment's bridge is the worse error, so the bar is deliberately low: ONE
-- trusted-equivalent endorser per side. Note also that a real bridge by
-- definition needs both sides — a one-sided comment already scored map_y≈0 — so
-- the per-side floor costs no genuine bridge. The only behavior change for real
-- content is that a cross-bloc comment endorsed ONLY by brand-new accounts now
-- stays NULL instead of high; that population is indistinguishable from a farm.
--
-- Trust ramp: account age < 7d → 0 (throwaway window); linear to 1.0 at 30d;
-- ≥30d → 1.0. Same age-based discriminator SF-P4 uses for its FP guard.
--
-- Writes ONLY bridge_score/map_x/map_y (never rating_summary — the C0 trigger
-- owns that). Same (text, uuid) signature, so every existing caller
-- (data:score-comments, the nightly enrichment phase, lib/heavy-rebuild.ts
-- ALLOWED_REBUILDS) is unchanged. Authored synthetic seed scores are display-only
-- and excluded from this scorer via author_excluded_from_standing() — unaffected.
-- Replay-safe: CREATE OR REPLACE; the UPDATE over 0 rows scores 0 with no error.

CREATE OR REPLACE FUNCTION public.recompute_comment_bridge_scores(
  p_entity_type text DEFAULT NULL::text,
  p_entity_id   uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count integer;
  -- SF-P5 trust constants. Account-age → rater trust; per-side trusted-mass floor.
  c_new_days         constant int     := 7;    -- below this age: zero trust (throwaway window)
  c_established_days constant int     := 30;   -- at/above this age: full trust (=1.0)
  c_trust_floor      constant numeric := 1.0;  -- min trusted-equivalent endorsers REQUIRED per side
BEGIN
  WITH scope AS (
    SELECT c.id, c.entity_type, c.entity_id
    FROM public.entity_comments c
    WHERE c.status IN ('visible','needs_review')
      AND (p_entity_type IS NULL OR c.entity_type = p_entity_type)
      AND (p_entity_id   IS NULL OR c.entity_id   = p_entity_id)
      -- SF-P1 quarantine: no computed standing on synthetic/abuse authors or synthetic entities.
      AND NOT public.author_excluded_from_standing(c.author_id)
      AND NOT public.is_synthetic_entity(c.entity_type, c.entity_id)
  ),
  totals AS (
    SELECT
      s.id                                      AS comment_id,
      count(*)                                  AS total_raters,
      count(*) FILTER (WHERE cr.valuable = 1)   AS valuable_up,
      count(*) FILTER (WHERE cr.valuable = -1)  AS valuable_down
    FROM scope s
    JOIN public.comment_ratings cr ON cr.comment_id = s.id
      -- SF-P1 quarantine: synthetic/abuse raters confer no standing.
      AND NOT public.author_excluded_from_standing(cr.rater_id)
    GROUP BY s.id
  ),
  endorsers AS (
    -- one row per (comment, endorser): resolve the endorser's side AND its SF-P5
    -- account-age trust weight in [0,1].
    SELECT
      s.id AS comment_id,
      CASE
        WHEN ep.stance IS NOT NULL THEN sign(ep.stance)::int
        WHEN cr.agree  IS NOT NULL THEN sign(cr.agree)::int
        ELSE 0
      END AS side,
      -- SF-P5 rater trust: 0 under c_new_days, linear ramp, 1.0 at/after
      -- c_established_days. A ring of accounts minted ~now contributes 0 mass, so
      -- it cannot fabricate the cross-stance balance that drives map_y.
      GREATEST(0.0, LEAST(1.0,
        (EXTRACT(epoch FROM (now() - u.created_at)) / 86400.0 - c_new_days)::numeric
        / NULLIF(c_established_days - c_new_days, 0)
      )) AS trust
    FROM scope s
    JOIN public.comment_ratings cr
      ON cr.comment_id = s.id AND cr.valuable = 1
      -- SF-P1 quarantine: synthetic/abuse raters confer no standing.
      AND NOT public.author_excluded_from_standing(cr.rater_id)
    JOIN public.users u ON u.id = cr.rater_id
    LEFT JOIN public.entity_positions ep
      ON ep.user_id     = cr.rater_id
     AND ep.entity_type = s.entity_type
     AND ep.entity_id   = s.entity_id
  ),
  sides AS (
    SELECT
      comment_id,
      count(*) FILTER (WHERE side > 0)                AS pos,
      count(*) FILTER (WHERE side < 0)                AS neg,
      -- SF-P5: trust-weighted mass per side.
      COALESCE(sum(trust) FILTER (WHERE side > 0), 0) AS tw_pos,
      COALESCE(sum(trust) FILTER (WHERE side < 0), 0) AS tw_neg
    FROM endorsers
    GROUP BY comment_id
  ),
  computed AS (
    SELECT
      s.id                       AS comment_id,
      t.total_raters,
      t.valuable_up,
      t.valuable_down,
      COALESCE(sd.pos, 0)        AS pos,
      COALESCE(sd.neg, 0)        AS neg,
      COALESCE(sd.tw_pos, 0)     AS tw_pos,
      COALESCE(sd.tw_neg, 0)     AS tw_neg
    FROM scope s
    LEFT JOIN totals t ON t.comment_id = s.id
    LEFT JOIN sides  sd ON sd.comment_id = s.id
  ),
  final AS (
    SELECT
      comment_id,
      CASE WHEN qualifies THEN map_x        END AS map_x,
      CASE WHEN qualifies THEN map_y        END AS map_y,
      CASE WHEN qualifies THEN bridge_score END AS bridge_score
    FROM (
      SELECT
        comment_id,
        -- SF-P5 qualification: (a) volume (>=5 raters) AND (b) BOTH stance sides
        -- backed by real trusted endorsers (the per-side trusted-mass floor). The
        -- floor is what a balanced throwaway farm (F10) cannot clear while a
        -- genuine cross-bloc endorsement by aged accounts does. Replaces the old
        -- raw `pos + neg >= 2` count, which the farm trivially satisfied.
        (COALESCE(total_raters, 0) >= 5
           AND least(tw_pos, tw_neg) >= c_trust_floor) AS qualifies,
        -- map_x / map_y from the trust-weighted sides (qualification guarantees
        -- tw_pos + tw_neg > 0 here).
        CASE WHEN (tw_pos + tw_neg) > 0
             THEN (tw_pos - tw_neg) / (tw_pos + tw_neg) END AS map_x,
        CASE WHEN (tw_pos + tw_neg) > 0
             THEN 2.0 * least(tw_pos, tw_neg) / (tw_pos + tw_neg) END AS map_y,
        CASE WHEN (tw_pos + tw_neg) > 0
             THEN greatest(0, least(1,
                    (valuable_up - valuable_down)::numeric / NULLIF(total_raters, 0)))
                  * (2.0 * least(tw_pos, tw_neg) / (tw_pos + tw_neg))
             END AS bridge_score
      FROM computed
    ) z
  )
  UPDATE public.entity_comments ec
  SET bridge_score = f.bridge_score,
      map_x        = f.map_x,
      map_y        = f.map_y
  FROM final f
  WHERE ec.id = f.comment_id
    AND (ec.bridge_score IS DISTINCT FROM f.bridge_score
      OR ec.map_x        IS DISTINCT FROM f.map_x
      OR ec.map_y        IS DISTINCT FROM f.map_y);

  -- "rows scored" = comments in scope that now carry a non-NULL score. Stable
  -- across idempotent re-runs. Same quarantine predicate as scope.
  SELECT count(*) INTO v_count
  FROM public.entity_comments ec
  WHERE ec.bridge_score IS NOT NULL
    AND ec.status IN ('visible','needs_review')
    AND (p_entity_type IS NULL OR ec.entity_type = p_entity_type)
    AND (p_entity_id   IS NULL OR ec.entity_id   = p_entity_id)
    AND NOT public.author_excluded_from_standing(ec.author_id)
    AND NOT public.is_synthetic_entity(ec.entity_type, ec.entity_id);

  RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.recompute_comment_bridge_scores(text, uuid) IS
  'SF-P5 (FIX-612): nightly set-based bridge scorer with anti-gaming. bridge_score = valuable_rate * map_y over trust-weighted cross-stance sides. Requires total_raters>=5 AND least(tw_pos,tw_neg)>=1.0 (per-side account-age trusted-mass floor) so a balanced fake cross-vote by fresh throwaway accounts (harness F10) cannot farm a high score; a genuine cross-bloc endorsement by aged accounts still scores. Excludes synthetic/abuse authors+raters+entities (SF-P1). Writes only bridge_score/map_x/map_y. Called via direct pg.Client (lib/heavy-rebuild.ts).';
