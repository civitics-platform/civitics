-- FIX-880 / FIX-571 PR1 — abuse-event log substrate (OBSERVE-ONLY).
--
-- state-of-franklin-bible §11 (Sybil / linkage), §12. This is PR1 of 2. The
-- CONTENT layer already exists — detect_brigade_candidates() + brigade_candidates
-- (FIX-608). What was missing is LINKAGE: two accounts writing from the same
-- machine are invisible today because IP / device are never stored. This PR adds
-- the observe-only event log + capture wiring + retention. PR2 (a separate FIX,
-- after this log soaks with real data) adds detect_sybil_clusters() + an
-- append-only sybil_candidates log + a shadow runner mirroring the
-- brigade-detector pattern — and closes FIX-571. Nothing here does any of that.
--
-- DETECTION ≠ PUNISHMENT (carries over from FIX-608). This log confers ZERO
-- consequence: no enforcement, no flags, no content judgment, no auto-anything.
-- It is an access-layer + linkage substrate and nothing else. Enforcement, if it
-- ever comes, is a deliberate human-gated follow-up. Brand rules: open
-- participation, no AI moderation, no auto-delete on suspicion.
--
-- ── What gets logged, and what NEVER does ────────────────────────────────────
-- LOG (self-bounding by the existing per-user daily caps — 60 positions / 200
-- votes / etc. — so event volume is capped by construction, NOT a per-request
-- write):
--   • authed content WRITES: position_set, statement_create, statement_vote,
--     comment_create (covers Q&A question/answer — those ARE comments),
--     flag_create (comment/statement/moderation), investigation_create,
--     evidence_write (evidence card + citation).
--   • auth_callback — sign-in landings (the highest-value, lowest-volume
--     linkage: every sign-in yields an ip_hash ↔ user_id pair).
--   • cap_hit — the four 53400 daily-cap rejections (positions, statements,
--     comments, investigations/evidence).
--   • turnstile_challenge — Turnstile outcome (pass|fail in meta) on the five
--     first-write routes (FIX-569), fired ONLY when a challenge was required.
-- NEVER: reads or page views (a per-read Postgres write is the exact IOWait-bound
-- load class rejected for the edge limiter on Pro Small). The action detail
-- (route / cap / outcome / kind) rides in `meta`, keeping the CHECK taxonomy
-- coarse and stable.
--
-- KNOWN NON-CAPTURE: the Upstash / middleware edge 429s (FIX-570) are NOT logged
-- — the edge runtime has no DB path, so there is nothing to write from. The
-- app-layer isRateLimited() 429s on the flag/rate routes are also out of scope
-- (they are not 53400 sites); only the four 53400 cap-hits are logged.
--
-- ── Hashing (done in the app, not here) ──────────────────────────────────────
-- Raw IP / UA are NEVER stored, not even transiently in meta. The app hashes them
-- HMAC-SHA256 with a stable server-only pepper (ABUSE_EVENT_PEPPER) before insert.
-- The pepper is STABLE (never rotated) — rotating would break the cross-week
-- linkage that is the entire point; the privacy control is retention + one-way
-- hashing, not rotation. Pepper unset → the app writes NULL hashes (fail-open),
-- never a raw fallback. This migration only stores the already-hashed text.

-- ---------------------------------------------------------------------------
-- 1. abuse_events — append-only, observe-only event log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.abuse_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- NO FK to auth.users on purpose: these rows outlive account deletion by
  -- design (they are hashed + retention-bounded, and a deleted account is
  -- exactly the case a Sybil review may need to reconstruct). NULLable so an
  -- auth_callback that lands without a resolvable session still records.
  user_id      uuid,
  -- HMAC-SHA256(pepper) of the client IP / User-Agent. text (hex). NULL when the
  -- pepper is unset (fail-open) or the header was absent.
  ip_hash      text,
  ua_hash      text,
  action       text NOT NULL CHECK (action IN (
                 'position_set',
                 'statement_create',
                 'statement_vote',
                 'comment_create',
                 'flag_create',
                 'investigation_create',
                 'evidence_write',
                 'auth_callback',
                 'cap_hit',
                 'turnstile_challenge'
               )),
  -- The entity acted on, where cheaply available (e.g. 'proposal', 'statement',
  -- 'comment', 'investigation'). PR2's clustering reads "same accounts hitting
  -- same targets" off these. NULL when not applicable (auth_callback).
  target_type  text,
  target_id    uuid,
  -- Minimal: route / cap name / turnstile outcome / write kind ONLY. NEVER
  -- content, NEVER raw identifiers.
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- BRIN on the append-only timestamp (cheap, retention delete + time-window
-- scans); btree covering indexes for PR2's per-account and per-network cluster
-- reads.
CREATE INDEX IF NOT EXISTS abuse_events_occurred_brin_idx
  ON public.abuse_events USING brin (occurred_at);
CREATE INDEX IF NOT EXISTS abuse_events_user_occurred_idx
  ON public.abuse_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS abuse_events_iphash_occurred_idx
  ON public.abuse_events (ip_hash, occurred_at);

-- RLS ENABLED with ZERO policies: service-role / admin writes only (the app's
-- recordAbuseEvent() uses the service client, which bypasses RLS). No anon /
-- authenticated grants — a client can never read or write this log. Append-only
-- by convention: never UPDATE/DELETE except the retention purge below.
ALTER TABLE public.abuse_events ENABLE ROW LEVEL SECURITY;
-- Supabase's platform default privileges auto-GRANT anon/authenticated ALL on
-- every new public table (they are inert under RLS-with-no-policies — an anon
-- SELECT returns zero rows — but decision-4 wants them gone, and on a
-- privacy-sensitive log defense-in-depth beats relying on RLS alone). REVOKE
-- them explicitly (FIX-695/834 revoke discipline), then grant only service_role.
REVOKE ALL ON public.abuse_events FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.abuse_events TO service_role;
-- (GENERATED ALWAYS AS IDENTITY needs no separate sequence grant — the identity
-- sequence is system-managed; table INSERT privilege is sufficient.)

COMMENT ON TABLE public.abuse_events IS
  'FIX-880 / FIX-571 PR1: append-only OBSERVE-ONLY log of authed content writes, '
  'auth-callback landings, 53400 cap-hits, and Turnstile outcomes. Network '
  'identifiers are HMAC-SHA256(pepper) hashed by the app (raw IP/UA never stored); '
  'action detail rides in meta. Confers NO consequence (DETECTION ≠ PUNISHMENT). '
  'NEVER logs reads/page-views. Edge/middleware 429s (FIX-570) are a known '
  'non-capture (no DB path from the edge runtime). No FK to auth.users — rows '
  'outlive account deletion by design. 90-day retention via purge_abuse_events(). '
  'PR2 adds detect_sybil_clusters()/sybil_candidates and closes FIX-571.';

COMMENT ON COLUMN public.abuse_events.meta IS
  'Minimal jsonb — route / cap name / turnstile outcome / write kind only. NEVER '
  'content, NEVER raw identifiers.';

-- ---------------------------------------------------------------------------
-- 2. purge_abuse_events — 90-day retention (LIMIT-batched, per-batch COMMIT)
-- ---------------------------------------------------------------------------
-- A PROCEDURE (not a function) so it can COMMIT between batches: on Pro Small a
-- backlog (e.g. after a paused cron) must never run as one long delete that pins
-- the xmin horizon and holds locks. Each batch is a short transaction; the
-- session advisory lock (survives the COMMITs — it is session-, not txn-scoped)
-- prevents two overlapping purges. Runtime is bounded by the postgres role
-- default statement_timeout armed at CALL start (FIX-703: an in-procedure SET /
-- per-COMMIT re-arm / proconfig CANNOT change it), which is exactly why the work
-- is batched rather than relying on a per-statement cap.
CREATE OR REPLACE PROCEDURE public.purge_abuse_events(
  p_retention_days int DEFAULT 90,
  p_batch          int DEFAULT 5000
)
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('purge_abuse_events')::bigint;
  v_deleted  bigint;
  v_total    bigint := 0;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[purge_abuse_events] advisory lock held — another purge is running; skipping';
    RETURN;
  END IF;

  LOOP
    DELETE FROM public.abuse_events
     WHERE id IN (
       SELECT id
         FROM public.abuse_events
        WHERE occurred_at < now() - make_interval(days => p_retention_days)
        ORDER BY id
        LIMIT p_batch
     );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_total := v_total + v_deleted;
    -- COMMIT at top level (never inside an EXCEPTION block — PL/pgSQL forbids it).
    COMMIT;
    EXIT WHEN v_deleted = 0;
  END LOOP;

  RAISE NOTICE '[purge_abuse_events] deleted % row(s) older than % days', v_total, p_retention_days;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;

GRANT EXECUTE ON PROCEDURE public.purge_abuse_events(int, int) TO service_role;

COMMENT ON PROCEDURE public.purge_abuse_events(int, int) IS
  'FIX-880 — 90-day retention for abuse_events. LIMIT-batched delete with '
  'per-batch COMMIT + session advisory lock so a backlog can never run as one '
  'long transaction on Pro Small. Daily pg_cron (abuse-events-retention). CALL '
  'form only — a SET …; CALL … cron command fails on the COMMIT (FIX-703).';

-- ---------------------------------------------------------------------------
-- 3. pg_cron — daily retention run (idempotent unschedule → schedule, FIX-688)
-- ---------------------------------------------------------------------------
-- 04:15 UTC daily: off-peak (before the US-East ramp), clear of the vote-stats
-- full rebuild (03:30, FIX-837), the 08:00 EC rebuild, and the 09:00 donor
-- rollup. The purge is tiny (one day's rows past the 90-day edge) so the slot is
-- non-critical; a plain CALL (COMMIT-ing procedure — never SET …; CALL …).
SELECT cron.unschedule(jobname)
  FROM cron.job WHERE jobname = 'abuse-events-retention';

SELECT cron.schedule(
  'abuse-events-retention',
  '15 4 * * *',
  $$CALL public.purge_abuse_events();$$
);
