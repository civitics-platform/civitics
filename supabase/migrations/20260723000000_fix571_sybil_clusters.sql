-- FIX-571 PR2 of 2 — Sybil / linkage cluster detector (shadow, detection-only).
--
-- state-of-franklin-bible §11 (Sybil / linkage), §12. PR1 (FIX-880) shipped the
-- OBSERVE-ONLY public.abuse_events log — authed content writes, auth-callback
-- landings, 53400 cap-hits, and Turnstile outcomes, with HMAC-SHA256(pepper)
-- hashed network identifiers (raw IP/UA never stored). This PR builds the
-- LINKAGE-ANALYSIS layer over that log and CLOSES FIX-571.
--
-- DETECTION ≠ PUNISHMENT (carries over from FIX-608 / FIX-880). This ships a SQL
-- scorer + an append-only candidate log and NOTHING ELSE. It confers no
-- consequence: it never flags, collapses, hides, blocks, scores content, or
-- mutates any row outside its own append-only log. Enforcement — if it ever
-- comes — is a deliberate, human-gated follow-up. Brand rules stand: open
-- participation, no AI moderation, no auto-delete on suspicion.
--
-- CONSERVATIVE + FP-AWARE (carries over from FIX-608). On a civic platform,
-- shared infrastructure is normal — a household behind one router, a campus or
-- office behind CGNAT, a coffee-shop or VPN exit. Those look like "many accounts,
-- one IP" to a naive detector, and flagging them chills exactly the participation
-- Civitics exists to enable. The discriminators are therefore about the SHAPE of
-- the sharing (an exact device fingerprint reused by several accounts; tight
-- hand-off timing; a signup burst; abuse-intent events on the shared key) — NOT
-- merely that an IP is shared. When in doubt, do not flag.
--
-- DATA REALITY (2026-07-23): the log is pre-launch thin — 0 rows on prod, and the
-- Vercel pepper is still unset, so near-future rows are NULL-hash (linkage-blind)
-- until it is set. This PR ships the machinery with conservative, fully
-- parameterized FIRST-PASS thresholds; real tuning happens later against real
-- data, via call-time flags, with no migration. On the thin log the honest scan
-- result is 0 candidates — the constellation proof (supabase/tests/verify_fix571.sql)
-- is what demonstrates the scorer works.
--
-- NULL-hash rows are SKIPPED: an event whose ip_hash is NULL (pepper-unset era, or
-- a request with no forwarded-for header) carries no linkage and is invisible to
-- every signal here.
--
-- SYNTHETIC EXCLUSION. Evaluation excludes synthetic + confirmed-abuse authors via
-- the canonical SF-P1 predicate public.author_excluded_from_standing() — the same
-- guard the brigade scorer uses. abuse_events should not contain State-of-Franklin
-- seed traffic (that seed is pipeline-created, not HTTP), but the predicate is
-- cheap insurance against ever surfacing a synthetic account as a Sybil candidate.

-- ---------------------------------------------------------------------------
-- a. sybil_candidates — append-only shadow log (the ONLY thing PR2 writes)
-- ---------------------------------------------------------------------------
-- Mirrors brigade_candidates' column style (BIGSERIAL, detected_at, sha, score,
-- signals jsonb, notes, metadata) but with Sybil-specific columns (cluster_key,
-- first/last_seen, event_count) instead of brigade's content-target columns
-- (mode/target_id) — a shared-network cluster has no single "target". RLS is
-- ENABLED with ZERO policies AND an explicit REVOKE from anon/authenticated —
-- deliberately as strict as abuse_events itself (stricter than brigade_candidates,
-- which predates the FIX-695/834 revoke discipline): this log is derived from a
-- privacy-sensitive substrate, so defense-in-depth beats relying on RLS alone.
CREATE TABLE IF NOT EXISTS public.sybil_candidates (
  id           BIGSERIAL PRIMARY KEY,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  sha          text,                         -- git sha of the detector code that scored
  signal       text NOT NULL CHECK (signal IN (
                 'shared_fingerprint',        -- S1: >= N accounts on one (ip_hash|ua_hash)
                 'shared_ip',                 -- S2: >= N accounts on one ip_hash (weak alone)
                 'temporal_coupling',         -- S3: tight cross-account hand-off timing
                 'auth_burst'                 -- S4: multi-account signup burst on one ip_hash
               )),
  cluster_key  text,                          -- the shared ip_hash, or ip_hash|ua_hash (already pseudonymous)
  cluster_size int  NOT NULL,                 -- distinct accounts in the cluster
  account_ids  uuid[] NOT NULL,               -- the candidate cluster (for review only)
  event_count  int,                           -- events observed on the key within the horizon
  first_seen   timestamptz,
  last_seen    timestamptz,
  score        numeric NOT NULL,              -- Sybil score in [0,1]
  signals      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the contributing signal breakdown
  notes        text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sybil_candidates_detected_idx
  ON public.sybil_candidates (detected_at DESC);
CREATE INDEX IF NOT EXISTS sybil_candidates_signal_idx
  ON public.sybil_candidates (signal, detected_at DESC);
CREATE INDEX IF NOT EXISTS sybil_candidates_accounts_idx
  ON public.sybil_candidates USING gin (account_ids);

ALTER TABLE public.sybil_candidates ENABLE ROW LEVEL SECURITY;
-- No client policies: the log is service_role-only (admin review reads via the
-- admin client). Supabase's platform default privileges auto-GRANT anon/
-- authenticated on every new public table; REVOKE them explicitly (they are inert
-- under RLS-with-no-policies, but on a privacy-derived log defense-in-depth beats
-- trusting RLS alone — FIX-695/834 revoke discipline), then grant only service_role.
REVOKE ALL ON public.sybil_candidates FROM anon, authenticated;
GRANT SELECT, INSERT ON public.sybil_candidates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sybil_candidates_id_seq TO service_role;

COMMENT ON TABLE public.sybil_candidates IS
  'FIX-571 PR2 (SF-P4/linkage): append-only shadow log of candidate Sybil / '
  'shared-infrastructure clusters from public.detect_sybil_clusters(). '
  'Detection-only — confers NO consequence (no flag/collapse/score/hide/block). '
  'cluster_key is a pseudonymous ip_hash or ip_hash|ua_hash; account_ids are the '
  'linked accounts for HUMAN review. Excludes synthetic/abuse authors. Skips '
  'NULL-hash (linkage-blind) rows. Enforcement is a separate human-gated '
  'follow-up. Never mutated. As RLS-strict as abuse_events (service_role only).';

-- ---------------------------------------------------------------------------
-- b. detect_sybil_clusters() — the conservative, FP-aware linkage scorer
-- ---------------------------------------------------------------------------
-- Read-only (STABLE; writes nothing). Mirrors detect_brigade_candidates: plain
-- STABLE plpgsql with a locked search_path, NOT SECURITY DEFINER (it is called by
-- the service_role scan runner, which already reads everything), returning a
-- TABLE(...) with a score in [0,1] and a reviewable `signals` jsonb breakdown.
--
-- CLUSTER KEYS. Every linkable event is keyed two ways and aggregated once:
--   • fingerprint  ckey = ip_hash|ua_hash  (S1 — the strong "same machine" tell)
--   • ip           ckey = ip_hash          (S2 — "same network", weak on its own)
-- A key qualifies as a cluster iff >= p_min_accounts DISTINCT accounts share it
-- (default 3 — TWO accounts on one key is a household, never a candidate). To
-- avoid double-reporting, an ip cluster that FULLY CONTAINS a qualifying
-- fingerprint (>= p_min_accounts accounts on one ip_hash|ua_hash) is suppressed —
-- the fingerprint row represents it; the weaker ip row is dropped.
--
-- SCORE (weighted sum of normalized components, clamped to [0,1], then a
-- cardinality-dampening MULTIPLIER). FIRST-PASS weights on a thin log:
--   0.45 * fp_strength   S1  qualifying fingerprint = 1.0 (the strongest single signal)
--   0.15 * ip_strength   S2  shares the ip = 1.0 (weak: 0.15 alone is far below any threshold)
--   0.20 * coupling      S3  cross-account time-adjacency within p_couple_minutes, normalized
--   0.15 * auth_burst    S4  distinct accounts whose first auth_callback falls within p_burst_minutes
--   0.10 * abuse_intent  S5  (cap_hit + failed-turnstile count)/3, BONUS ONLY — never forms a cluster
-- INVARIANTS this shape guarantees:
--   • S2 alone CANNOT clear a 0.6 threshold at any size (0.15 max) — a shared-IP
--     cluster needs real corroboration (coupling / burst / intent) to surface.
--   • S1 alone lands a qualifying fingerprint at exactly 0.60 (fp 0.45 + ip 0.15):
--     >= 3 accounts on an identical ip+ua is inherently a candidate.
--   • abuse_intent is a bonus, absent from the qualifying HAVING — it lifts a
--     borderline cluster but never manufactures one.
-- CARDINALITY DAMPENING: suspicion is non-monotonic in size. A key shared by many
-- accounts (> p_damp_cap, default 25) is probably shared infrastructure, not a
-- farm, so the score is multiplied by (cap/n)^2 (floored at 0.1). The sweet spot
-- is small-N coordinated.
--
-- The `signal` label records the strongest CLUSTER-FORMING component by precedence
-- (shared_fingerprint > auth_burst > temporal_coupling > shared_ip); the full
-- component breakdown, raw (pre-damp) score, and damp factor ride in `signals`.
CREATE OR REPLACE FUNCTION public.detect_sybil_clusters(
  p_horizon_days    int     DEFAULT 30,   -- lookback window
  p_min_accounts    int     DEFAULT 3,    -- min distinct accounts to consider a cluster (2 = household)
  p_couple_minutes  int     DEFAULT 15,   -- S3 cross-account hand-off window
  p_burst_minutes   int     DEFAULT 60,   -- S4 signup/auth burst window
  p_damp_cap        int     DEFAULT 25,   -- cardinality dampening: > this scores down
  p_score_threshold numeric DEFAULT 0.6   -- candidate iff score >= this
)
RETURNS TABLE (
  signal        text,
  cluster_key   text,
  cluster_size  int,
  account_ids   uuid[],
  event_count   int,
  first_seen    timestamptz,
  last_seen     timestamptz,
  score         numeric,
  signals       jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  c_intent_norm    numeric := 3.0;   -- S5 normalization (in-body FIRST-PASS constant)
  c_couple_trigger numeric := 0.5;   -- signal-label trigger for 'temporal_coupling'
  c_burst_trigger  numeric := 0.5;   -- signal-label trigger for 'auth_burst'
BEGIN
  RETURN QUERY
  WITH _se_base AS (
    -- Linkable, in-horizon, real-author events. NULL-ip rows (pepper-unset era,
    -- or no forwarded-for header) are linkage-blind → skipped. Synthetic /
    -- confirmed-abuse authors excluded via the canonical SF-P1 predicate.
    SELECT ae.user_id,
           ae.ip_hash,
           ae.ua_hash,
           ae.action,
           ae.occurred_at,
           (ae.meta ->> 'outcome') AS outcome
    FROM public.abuse_events ae
    WHERE ae.ip_hash IS NOT NULL
      AND ae.occurred_at >= now() - make_interval(days => p_horizon_days)
      AND (ae.user_id IS NULL OR NOT public.author_excluded_from_standing(ae.user_id))
  ),
  -- Every event keyed two ways (fingerprint + ip), tagged by key_kind. UNION ALL
  -- doubles the base scan — acceptable at the log's bounded (daily-capped) volume.
  keyed AS (
    SELECT 'fingerprint'::text AS key_kind,
           b.ip_hash || '|' || b.ua_hash AS ckey,
           b.user_id, b.action, b.occurred_at, b.outcome
    FROM _se_base b
    WHERE b.ua_hash IS NOT NULL
    UNION ALL
    SELECT 'ip'::text AS key_kind,
           b.ip_hash AS ckey,
           b.user_id, b.action, b.occurred_at, b.outcome
    FROM _se_base b
  ),
  agg AS (
    SELECT k.key_kind,
           k.ckey,
           count(DISTINCT k.user_id) FILTER (WHERE k.user_id IS NOT NULL)      AS n_accounts,
           array_agg(DISTINCT k.user_id) FILTER (WHERE k.user_id IS NOT NULL)  AS accounts,
           count(*)                                                            AS n_events,
           min(k.occurred_at)                                                  AS first_seen,
           max(k.occurred_at)                                                  AS last_seen,
           count(*) FILTER (
             WHERE k.action = 'cap_hit'
                OR (k.action = 'turnstile_challenge' AND k.outcome = 'fail')
           )                                                                   AS intent_events
    FROM keyed k
    GROUP BY k.key_kind, k.ckey
    HAVING count(DISTINCT k.user_id) FILTER (WHERE k.user_id IS NOT NULL) >= p_min_accounts
  ),
  -- S3 temporal coupling: over events on a key ordered by time, a "cross-account
  -- adjacency" is a consecutive pair by DIFFERENT accounts within p_couple_minutes
  -- (the hand-off tell). One account acting alone → all adjacencies same-account →
  -- coupling 0; two accounts interleaving tightly → coupling → 1.
  coupled AS (
    SELECT ord.key_kind, ord.ckey,
           count(*) FILTER (
             WHERE ord.prev_user IS NOT NULL
               AND ord.prev_user <> ord.user_id
               AND ord.gap <= make_interval(mins => p_couple_minutes)
           )                                          AS cross_adj,
           count(*) FILTER (WHERE ord.prev_user IS NOT NULL) AS adj_total
    FROM (
      SELECT k.key_kind, k.ckey, k.user_id,
             lag(k.user_id)      OVER w AS prev_user,
             k.occurred_at - lag(k.occurred_at) OVER w AS gap
      FROM keyed k
      WHERE k.user_id IS NOT NULL
      WINDOW w AS (PARTITION BY k.key_kind, k.ckey ORDER BY k.occurred_at, k.user_id)
    ) ord
    GROUP BY ord.key_kind, ord.ckey
  ),
  -- S4 signup/auth burst: distinct accounts whose FIRST auth_callback on the key
  -- lands within p_burst_minutes of the earliest first-auth on that key.
  first_auth AS (
    SELECT k.key_kind, k.ckey, k.user_id, min(k.occurred_at) AS fa
    FROM keyed k
    WHERE k.action = 'auth_callback' AND k.user_id IS NOT NULL
    GROUP BY k.key_kind, k.ckey, k.user_id
  ),
  first_auth_w AS (
    SELECT fa.key_kind, fa.ckey, fa.user_id, fa.fa,
           min(fa.fa) OVER (PARTITION BY fa.key_kind, fa.ckey) AS earliest_fa
    FROM first_auth fa
  ),
  burst AS (
    SELECT fw.key_kind, fw.ckey,
           count(*) FILTER (
             WHERE fw.fa <= fw.earliest_fa + make_interval(mins => p_burst_minutes)
           ) AS burst_accounts
    FROM first_auth_w fw
    GROUP BY fw.key_kind, fw.ckey
  ),
  -- ip clusters fully explained by a qualifying fingerprint are represented by the
  -- (stronger) fingerprint row; suppress the weaker ip duplicate.
  ip_has_fp AS (
    SELECT DISTINCT split_part(a.ckey, '|', 1) AS ip
    FROM agg a
    WHERE a.key_kind = 'fingerprint'
  ),
  scored AS (
    SELECT a.key_kind, a.ckey, a.n_accounts, a.accounts, a.n_events,
           a.first_seen, a.last_seen, a.intent_events,
           (a.key_kind = 'fingerprint')::int::numeric                             AS fp_strength,
           1.0::numeric                                                           AS ip_strength,
           coalesce(c.cross_adj::numeric / NULLIF(c.adj_total, 0), 0)             AS coupling,
           LEAST(1.0, coalesce(bu.burst_accounts, 0)::numeric
                        / NULLIF(2 * p_min_accounts, 0))                          AS auth_burst,
           LEAST(1.0, a.intent_events::numeric / c_intent_norm)                   AS abuse_intent,
           CASE WHEN a.n_accounts <= p_damp_cap THEN 1.0
                ELSE GREATEST(0.1, power(p_damp_cap::numeric / a.n_accounts, 2)) END AS damp_factor
    FROM agg a
    LEFT JOIN coupled c ON c.key_kind = a.key_kind AND c.ckey = a.ckey
    LEFT JOIN burst  bu ON bu.key_kind = a.key_kind AND bu.ckey = a.ckey
    WHERE NOT (a.key_kind = 'ip' AND a.ckey IN (SELECT ip FROM ip_has_fp))
  ),
  final AS (
    SELECT s.*,
           LEAST(1.0, GREATEST(0.0,
               0.45 * s.fp_strength
             + 0.15 * s.ip_strength
             + 0.20 * s.coupling
             + 0.15 * s.auth_burst
             + 0.10 * s.abuse_intent)) AS raw_score
    FROM scored s
  )
  SELECT
    CASE
      WHEN f.fp_strength = 1               THEN 'shared_fingerprint'
      WHEN f.auth_burst >= c_burst_trigger THEN 'auth_burst'
      WHEN f.coupling   >= c_couple_trigger THEN 'temporal_coupling'
      ELSE 'shared_ip'
    END                                                       AS signal,
    f.ckey                                                    AS cluster_key,
    f.n_accounts::int                                         AS cluster_size,
    f.accounts                                                AS account_ids,
    f.n_events::int                                           AS event_count,
    f.first_seen,
    f.last_seen,
    round(f.raw_score * f.damp_factor, 4)                     AS score,
    jsonb_build_object(
      'fp_strength',   round(f.fp_strength, 4),
      'ip_strength',   round(f.ip_strength, 4),
      'coupling',      round(f.coupling, 4),
      'auth_burst',    round(f.auth_burst, 4),
      'abuse_intent',  round(f.abuse_intent, 4),
      'intent_events', f.intent_events,
      'n_accounts',    f.n_accounts,
      'damp_factor',   round(f.damp_factor, 4),
      'raw_score',     round(f.raw_score, 4)
    )                                                         AS signals
  FROM final f
  WHERE round(f.raw_score * f.damp_factor, 4) >= p_score_threshold
  ORDER BY score DESC, cluster_size DESC;
END;
$$;

COMMENT ON FUNCTION public.detect_sybil_clusters(int, int, int, int, int, numeric) IS
  'FIX-571 PR2 (SF-P4/linkage): conservative, FP-aware Sybil detector over '
  'public.abuse_events. Read-only (STABLE; writes nothing). Keys events by '
  'fingerprint (ip_hash|ua_hash, S1) and ip_hash (S2), scores coupling (S3), '
  'auth-burst (S4), and abuse-intent (S5, bonus), dampens large shared-network '
  'clusters, and returns candidates with score in [0,1] + a reviewable signals '
  'breakdown. Skips NULL-hash (linkage-blind) rows; excludes synthetic/abuse '
  'authors. FIRST-PASS thresholds on a thin log — tune later via call-time flags. '
  'Detection-only — confers no consequence; enforcement is a separate '
  'human-gated follow-up.';

-- Route-gated RPC: only the service_role scan runner may execute it. Supabase
-- default-grants EXECUTE to PUBLIC/anon/authenticated on every new function;
-- REVOKE that, then grant only service_role (FIX-695/834 revoke discipline).
REVOKE ALL ON FUNCTION public.detect_sybil_clusters(int, int, int, int, int, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_sybil_clusters(int, int, int, int, int, numeric)
  TO service_role;
