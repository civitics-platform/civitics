-- FIX-608 / SF-P4 — brigade / coordinated-abuse detector (shadow, detection-only).
--
-- state-of-franklin-bible §11.1 (F8 coordinated pile-on, F9 slow-burn brigade), §12.
--
-- DETECTION ≠ PUNISHMENT. This ships a SQL scorer + an append-only candidate log
-- and NOTHING ELSE. It confers no consequence: it never flags, collapses, hides,
-- scores, or mutates any content. Enforcement is a deliberate, human-gated
-- follow-up (a separate FIX), out of scope here. Bridge-ranking already
-- de-amplifies low-quality pile-ons; this adds a *signal* for review, not a
-- penalty.
--
-- CONSERVATIVE + FP-AWARE. On a civic platform, coordination is often exactly
-- what we want — an initiative's signature drive, a neighborhood mobilizing for a
-- comment period, a union turning out members. Those look identical to a "brigade"
-- to a naive detector, and flagging them would chill the engagement Civitics
-- exists to enable. The discriminator is therefore about *how* accounts
-- coordinate (brand-new accounts, tight timing, low content diversity, the same
-- small set hitting many unrelated targets) — NOT merely *that* they do. When in
-- doubt, do not flag.
--
-- SIGNAL INVENTORY (verified against the live schema, FIX-608 investigation):
--   AVAILABLE   comment_ratings(rater_id, agree/valuable direction, created_at),
--               entity_comments(author_id, body, created_at), users.created_at
--               (account age), the SF-P1 synthetic/abuse predicate.
--   NOT LOGGED  IP / device / fingerprint (never stored — "No cookies. No
--               fingerprinting. No IP storage."), a persisted verified-constituent
--               flag (only voluntary user_preferences.home_jurisdiction_id + the
--               per-comment constituent snapshot). Designed around what exists;
--               the IP/device substrate is tracked as future work (cf FIX-571).
--
-- SYNTHETIC EXCLUSION. Real/prod evaluation excludes synthetic + confirmed-abuse
-- authors via the canonical SF-P1 predicate public.author_excluded_from_standing()
-- so the State of Franklin seed — which is coordinated *by design* — is never
-- surfaced as a brigade candidate.

-- ---------------------------------------------------------------------------
-- a. brigade_candidates — append-only shadow log (the ONLY thing this writes)
-- ---------------------------------------------------------------------------
-- Modeled on moderation_audit (20260619000000) and investigation_edge_audit:
-- BIGSERIAL, append-only, service_role-only, never UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS public.brigade_candidates (
  id           BIGSERIAL PRIMARY KEY,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  sha          text,                         -- git sha of the detector code that scored
  mode         text NOT NULL CHECK (mode IN ('fast','slow')),
  -- fast: the single piled-on comment. slow: NULL (the signal is cross-target).
  target_id    uuid,
  cluster_size int NOT NULL,
  account_ids  uuid[] NOT NULL,              -- the candidate cluster (for review only)
  score        numeric NOT NULL,             -- coordination score in [0,1]
  signals      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the contributing signal breakdown
  notes        text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS brigade_candidates_detected_idx
  ON public.brigade_candidates (detected_at DESC);
CREATE INDEX IF NOT EXISTS brigade_candidates_mode_idx
  ON public.brigade_candidates (mode, detected_at DESC);
CREATE INDEX IF NOT EXISTS brigade_candidates_accounts_idx
  ON public.brigade_candidates USING gin (account_ids);

ALTER TABLE public.brigade_candidates ENABLE ROW LEVEL SECURITY;
-- No client policies: the log is service_role-only (admin review surfaces read via
-- the admin client). Append-only — never updated or deleted.
GRANT SELECT, INSERT ON public.brigade_candidates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.brigade_candidates_id_seq TO service_role;

COMMENT ON TABLE public.brigade_candidates IS
  'SF-P4 (FIX-608): append-only shadow log of candidate coordinated-abuse clusters from public.detect_brigade_candidates(). Detection-only — confers NO consequence (no flag/collapse/score/hide). Excludes synthetic authors. Enforcement is a separate human-gated follow-up. Never mutated.';

-- ---------------------------------------------------------------------------
-- b. detect_brigade_candidates() — the conservative, FP-aware scorer
-- ---------------------------------------------------------------------------
-- Read-only (STABLE; writes nothing). Two modes over a shared cross-target
-- co-occurrence core:
--
--   fast (F8): per target comment, the largest SAME-DIRECTION rating cluster that
--     falls entirely within p_window_minutes. Scores UP on tight timing, a high
--     brand-new-account ratio, the cluster dominating the target's ratings, and
--     the same set co-occurring on other targets. Scores DOWN (strong damping) on
--     established accounts — the FP guard that keeps an organic surge of real,
--     aged accounts below threshold.
--
--   slow (F9): the same account SET co-occurring same-direction across
--     >= p_min_cooccur_targets distinct targets over p_horizon_days, with NO
--     burst-window requirement — the low-and-slow pattern a rate limiter misses.
--     Connected components over the co-occurrence graph define each cluster.
--
-- The probe in the SF-P3 harness (pg_proc name ILIKE '%brigade%'/'%coordinat%'/
-- '%cluster%'/'%temporal%') resolves to this function; the F8/F9 fixtures call it
-- directly for a real verdict.
CREATE OR REPLACE FUNCTION public.detect_brigade_candidates(
  p_mode                 text    DEFAULT 'fast',   -- 'fast' (F8) | 'slow' (F9)
  p_target_ids           uuid[]  DEFAULT NULL,     -- NULL = scan all recent; else restrict
  p_window_minutes       int     DEFAULT 60,       -- fast: same-direction burst window
  p_horizon_days         int     DEFAULT 14,       -- lookback for both modes
  p_min_cluster          int     DEFAULT 5,        -- min accounts to consider a cluster
  p_min_cooccur_targets  int     DEFAULT 3,        -- slow: min shared targets per account pair
  p_new_account_days     int     DEFAULT 7,        -- "brand new" threshold
  p_established_days      int     DEFAULT 30,       -- "established" threshold (FP damping)
  p_score_threshold      numeric DEFAULT 0.6       -- candidate iff score >= this
)
RETURNS TABLE (
  mode         text,
  target_id    uuid,
  cluster_size int,
  account_ids  uuid[],
  score        numeric,
  signals      jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_mode NOT IN ('fast','slow') THEN
    RAISE EXCEPTION 'detect_brigade_candidates: p_mode must be ''fast'' or ''slow'', got %', p_mode;
  END IF;

  -- The shared base (_bc_base, below) is same-direction POSITIVE rating activity
  -- within the horizon, with synthetic/abuse authors excluded via the canonical
  -- SF-P1 predicate author_excluded_from_standing(). "Direction" = sign on each
  -- axis; coordination reads as a bloc, so we cluster on identical (agree,valuable)
  -- sign. Restricted to positive ratings (the pile-on / boost pattern F8/F9 model).
  -- It is inlined as a CTE in each branch (no temp table) to keep the function
  -- cleanly read-only.

  IF p_mode = 'fast' THEN
    RETURN QUERY
    WITH _bc_base AS (
      SELECT cr.comment_id              AS tgt,
             cr.rater_id                AS acct,
             cr.created_at              AS rated_at,
             u.created_at               AS acct_created,
             sign(coalesce(cr.agree, 0))    AS dir_agree,
             sign(coalesce(cr.valuable, 0)) AS dir_valuable
      FROM public.comment_ratings cr
      JOIN public.users u ON u.id = cr.rater_id
      WHERE (cr.agree = 1 OR cr.valuable = 1)
        AND NOT public.author_excluded_from_standing(cr.rater_id)
        AND cr.created_at >= now() - make_interval(days => p_horizon_days)
        AND (p_target_ids IS NULL OR cr.comment_id = ANY(p_target_ids))
    ),
    grp AS (
      -- One same-direction group per (target, direction).
      SELECT b.tgt,
             b.dir_agree, b.dir_valuable,
             count(*)                                   AS csize,
             array_agg(b.acct ORDER BY b.acct)          AS accts,
             min(b.rated_at)                            AS first_rated,
             max(b.rated_at)                            AS last_rated,
             count(*) FILTER (
               WHERE b.acct_created >= now() - make_interval(days => p_new_account_days)
             )                                          AS n_new,
             count(*) FILTER (
               WHERE b.acct_created <  now() - make_interval(days => p_established_days)
             )                                          AS n_established
      FROM _bc_base b
      GROUP BY b.tgt, b.dir_agree, b.dir_valuable
    ),
    totals AS (
      SELECT comment_id AS tgt, count(*) AS total_raters
      FROM public.comment_ratings
      WHERE (p_target_ids IS NULL OR comment_id = ANY(p_target_ids))
        AND created_at >= now() - make_interval(days => p_horizon_days)
      GROUP BY comment_id
    ),
    -- Does this cluster's account set also co-occur on OTHER targets? (Same small
    -- set hitting unrelated targets is the strongest non-organic signal.)
    cross_tgt AS (
      SELECT g.tgt,
             count(DISTINCT b2.tgt) AS other_targets
      FROM grp g
      JOIN _bc_base b2
        ON b2.acct = ANY(g.accts)
       AND b2.tgt <> g.tgt
      GROUP BY g.tgt
    ),
    scored AS (
      SELECT g.tgt, g.csize, g.accts, g.first_rated, g.last_rated,
             g.dir_agree, g.dir_valuable,
             EXTRACT(epoch FROM (g.last_rated - g.first_rated)) / 60.0           AS span_min,
             g.n_new::numeric / g.csize                                          AS new_ratio,
             g.n_established::numeric / g.csize                                  AS est_ratio,
             g.csize::numeric / NULLIF(t.total_raters, 0)                        AS concentration,
             LEAST(1.0, coalesce(x.other_targets, 0)::numeric / 3.0)             AS cross_target
      FROM grp g
      LEFT JOIN totals t   ON t.tgt = g.tgt
      LEFT JOIN cross_tgt x ON x.tgt = g.tgt
      WHERE g.csize >= p_min_cluster
        -- The whole same-direction group must fall inside the burst window;
        -- spread-out coordination is the slow mode's job, not fast's.
        AND EXTRACT(epoch FROM (g.last_rated - g.first_rated)) <= p_window_minutes * 60
    ),
    final AS (
      SELECT s.*,
             GREATEST(0.0, 1.0 - (s.span_min / NULLIF(p_window_minutes, 0)))     AS timing_tightness
      FROM scored s
    )
    SELECT 'fast'::text,
           f.tgt,
           f.csize::int,
           f.accts,
           round(
             GREATEST(0.0, LEAST(1.0,
                 0.30 * f.timing_tightness
               + 0.30 * f.new_ratio
               + 0.20 * f.cross_target
               + 0.20 * coalesce(f.concentration, 0)
               - 0.40 * f.est_ratio
             )), 4)                                                              AS score,
           jsonb_build_object(
             'timing_tightness',   round(f.timing_tightness, 4),
             'window_minutes',     round(f.span_min, 2),
             'new_account_ratio',  round(f.new_ratio, 4),
             'established_ratio',  round(f.est_ratio, 4),
             'concentration',      round(coalesce(f.concentration, 0), 4),
             'cross_target',       round(f.cross_target, 4),
             'direction',          jsonb_build_object('agree', f.dir_agree, 'valuable', f.dir_valuable)
           )
    FROM final f
    WHERE GREATEST(0.0, LEAST(1.0,
              0.30 * f.timing_tightness
            + 0.30 * f.new_ratio
            + 0.20 * f.cross_target
            + 0.20 * coalesce(f.concentration, 0)
            - 0.40 * f.est_ratio
          )) >= p_score_threshold
    ORDER BY score DESC;

  ELSE  -- p_mode = 'slow'
    RETURN QUERY
    WITH RECURSIVE _bc_base AS (
      SELECT cr.comment_id              AS tgt,
             cr.rater_id                AS acct,
             cr.created_at              AS rated_at,
             u.created_at               AS acct_created,
             sign(coalesce(cr.agree, 0))    AS dir_agree,
             sign(coalesce(cr.valuable, 0)) AS dir_valuable
      FROM public.comment_ratings cr
      JOIN public.users u ON u.id = cr.rater_id
      WHERE (cr.agree = 1 OR cr.valuable = 1)
        AND NOT public.author_excluded_from_standing(cr.rater_id)
        AND cr.created_at >= now() - make_interval(days => p_horizon_days)
        AND (p_target_ids IS NULL OR cr.comment_id = ANY(p_target_ids))
    ),
    pairs AS (
      -- Account pairs that co-rated the SAME direction on >= N distinct targets.
      -- The count of shared targets — not any per-window rate — is the signal.
      SELECT a.acct AS u1, b.acct AS u2,
             count(DISTINCT a.tgt) AS shared_targets
      FROM _bc_base a
      JOIN _bc_base b
        ON a.tgt = b.tgt
       AND a.acct < b.acct
       AND a.dir_agree = b.dir_agree
       AND a.dir_valuable = b.dir_valuable
      GROUP BY a.acct, b.acct
      HAVING count(DISTINCT a.tgt) >= p_min_cooccur_targets
    ),
    edges AS (
      SELECT u1 AS a, u2 AS b FROM pairs
      UNION
      SELECT u2 AS a, u1 AS b FROM pairs
    ),
    nodes AS (
      SELECT u1 AS id FROM pairs UNION SELECT u2 AS id FROM pairs
    ),
    -- Connected components via reachability: each node's component = the min node
    -- id reachable from it (edges are symmetric, so this is canonical per blob).
    reach AS (
      SELECT n.id AS node, n.id AS root FROM nodes n
      UNION
      SELECT e.b AS node, r.root
      FROM reach r
      JOIN edges e ON e.a = r.node
    ),
    comp AS (
      -- min(uuid) has no aggregate; the text form sorts identically for same-shape
      -- uuids, so min(root::text)::uuid is a stable canonical component id.
      SELECT node, min(root::text)::uuid AS cid FROM reach GROUP BY node
    ),
    cluster AS (
      SELECT c.cid,
             count(*)                              AS csize,
             array_agg(c.node ORDER BY c.node)     AS accts
      FROM comp c
      GROUP BY c.cid
      HAVING count(*) >= p_min_cluster
    ),
    enriched AS (
      SELECT cl.cid, cl.csize, cl.accts,
             -- depth: how many shared targets the strongest internal pair reaches.
             (SELECT max(p.shared_targets)
                FROM pairs p
               WHERE p.u1 = ANY(cl.accts) AND p.u2 = ANY(cl.accts)) AS max_shared,
             (SELECT count(*) FILTER (
                 WHERE u.created_at >= now() - make_interval(days => p_new_account_days))::numeric
                / NULLIF(count(*), 0)
                FROM public.users u WHERE u.id = ANY(cl.accts))      AS new_ratio,
             (SELECT count(*) FILTER (
                 WHERE u.created_at <  now() - make_interval(days => p_established_days))::numeric
                / NULLIF(count(*), 0)
                FROM public.users u WHERE u.id = ANY(cl.accts))      AS est_ratio
      FROM cluster cl
    ),
    final AS (
      SELECT e.*,
             LEAST(1.0, e.max_shared::numeric / NULLIF(2 * p_min_cooccur_targets, 0)) AS cooccur_strength,
             LEAST(1.0, e.csize::numeric / NULLIF(2 * p_min_cluster, 0))              AS size_factor
      FROM enriched e
    )
    SELECT 'slow'::text,
           NULL::uuid,
           f.csize::int,
           f.accts,
           round(
             GREATEST(0.0, LEAST(1.0,
                 0.40 * f.cooccur_strength
               + 0.30 * coalesce(f.new_ratio, 0)
               + 0.30 * f.size_factor
               - 0.40 * coalesce(f.est_ratio, 0)
             )), 4)                                                              AS score,
           jsonb_build_object(
             'max_shared_targets', f.max_shared,
             'cooccur_strength',   round(f.cooccur_strength, 4),
             'new_account_ratio',  round(coalesce(f.new_ratio, 0), 4),
             'established_ratio',  round(coalesce(f.est_ratio, 0), 4),
             'size_factor',        round(f.size_factor, 4)
           )
    FROM final f
    WHERE GREATEST(0.0, LEAST(1.0,
              0.40 * f.cooccur_strength
            + 0.30 * coalesce(f.new_ratio, 0)
            + 0.30 * f.size_factor
            - 0.40 * coalesce(f.est_ratio, 0)
          )) >= p_score_threshold
    ORDER BY score DESC;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.detect_brigade_candidates(text, uuid[], int, int, int, int, int, int, numeric) IS
  'SF-P4 (FIX-608): conservative, FP-aware brigade detector. Read-only (STABLE; writes nothing). Returns candidate coordinated-abuse clusters with a coordination score in [0,1]. mode=fast (F8 pile-on) | slow (F9 cross-target co-occurrence). Excludes synthetic/abuse authors. Detection-only — confers no consequence; enforcement is a separate human-gated follow-up.';

GRANT EXECUTE ON FUNCTION public.detect_brigade_candidates(text, uuid[], int, int, int, int, int, int, numeric)
  TO service_role;
