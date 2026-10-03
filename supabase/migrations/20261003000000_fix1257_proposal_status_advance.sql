-- FIX-1257 — a proposal's status never goes backwards.
--
-- WHY. The recent-bills sync (packages/data/src/pipelines/congress/votes.ts
-- Step 1 → bills.ts upsertBillProposalsBatch Step 3) upserted `status` from
-- mapBillStatus(latestAction.text) on every existing bill in its top-50 window.
-- That mapper reads ONE text, and a procedural action that follows a passage
-- ("Motion to reconsider laid on the table…", "Received in the Senate.",
-- "Held at the desk.") fell through to the `introduced` default. So a bill that
-- passed the House was shown as introduced or in_committee once anything
-- happened after the vote. Prod, 2026-10-03 01:58 UTC (cc-181 read 2): 166
-- federal bills with a Passed House passage roll sat below passed_chamber
-- (69 introduced, 97 in_committee), HR 4795 among the cases found first.
--
-- WHAT THIS ADDS. Three functions; no table changes:
--
--   proposal_status_rank(status)           — an explicit lifecycle rank. The
--     enum's declaration order is NOT one (failed/withdrawn/tabled sort after
--     enacted; the regulation states sit mid-list).
--   proposal_status_advances(from, to)     — THE rule: may `from` become `to`?
--   proposals_advance_status(ids, statuses) — set-based: move each row whose
--     rule says yes, return (id, from_status, to_status) for the rows moved.
--
-- The TS twin is packages/data/src/pipelines/congress/status-rank.ts; its test
-- parses THIS file (the newest migration defining the two functions), so the
-- SQL and TS ranks and sets cannot drift.
--
-- THE RULE. `to` advances `from` when they differ and ONE of:
--   (a) rank(to) > rank(from)                          — forward progress
--   (b) `to` is terminal (vetoed, failed, withdrawn, tabled) and `from` is not
--       a HIGHER-ranked terminal                       — a real outcome is
--       accepted from any stage (a failed after passed_chamber is news; an
--       introduced after failed is noise, and (a) already refuses it)
--   (c) `from` is failed / withdrawn / tabled and `to` is signed,
--       veto_overridden or enacted                     — law beats a negative
--       terminal. Craig, 2026-10-02 (cc-181): every `failed` on a federal bill
--       on prod (174, read 02:0x UTC 2026-10-03) was set at MINT from a failed
--       FIRST roll — 88 recommit motions, 36 amendments, 6+3 suspensions, 3
--       commit motions — and 6 of those bills now read `enacted` only because
--       the old Step 3 overwrote them. Without (c) the next such bill would
--       read `failed` forever.
-- A NULL `to` never advances; a NULL `from` (no row value) always does.
--
-- WHO CALLS proposals_advance_status. The sync's Step 3 (the status column
-- is no longer in its upsert), the vote path after a passage roll lands
-- (passed_chamber, roll evidence), and scripts/fix1257-backfill-passed-
-- status.mjs. service_role only.
--
-- TRIGGERS on proposals (prod, read 2026-10-03, cc-181 read 5): the
-- updated_at trigger and the search-vector trigger, nothing on status. The
-- RPC's UPDATE fires both, as any status write always has.
--
-- IDEMPOTENT: CREATE OR REPLACE throughout; the coverage assertion holds on an
-- already-migrated env.

BEGIN;

-- ── 1. The rank ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.proposal_status_rank(p_status public.proposal_status)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE p_status
    WHEN 'introduced'           THEN 10
    WHEN 'in_committee'         THEN 20
    WHEN 'passed_committee'     THEN 30
    WHEN 'floor_vote'           THEN 40
    WHEN 'passed_chamber'       THEN 50
    WHEN 'passed_both_chambers' THEN 60
    WHEN 'vetoed'               THEN 65
    WHEN 'signed'               THEN 70
    WHEN 'veto_overridden'      THEN 75
    WHEN 'enacted'              THEN 80
    WHEN 'failed'               THEN 90
    WHEN 'withdrawn'            THEN 90
    WHEN 'tabled'               THEN 90
    WHEN 'open_comment'         THEN 20
    WHEN 'comment_closed'       THEN 30
    WHEN 'final_rule'           THEN 80
  END
$$;

COMMENT ON FUNCTION public.proposal_status_rank(public.proposal_status) IS
  'FIX-1257 — the lifecycle rank of a proposal_status (the enum''s declaration '
  'order is not one). veto_overridden (75) follows vetoed (65) and precedes '
  'enacted (80); failed/withdrawn/tabled (90) are terminal. The regulation '
  'states are ranked for completeness. TS twin: packages/data/src/pipelines/'
  'congress/status-rank.ts.';

-- ── 2. The rule ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.proposal_status_advances(
  p_from public.proposal_status,
  p_to   public.proposal_status
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_to IS NOT NULL
     AND p_to IS DISTINCT FROM p_from
     AND (
          p_from IS NULL
       OR public.proposal_status_rank(p_to) > public.proposal_status_rank(p_from)
       OR (p_to IN ('vetoed', 'failed', 'withdrawn', 'tabled')
           AND NOT (p_from IN ('vetoed', 'failed', 'withdrawn', 'tabled')
                    AND public.proposal_status_rank(p_from) > public.proposal_status_rank(p_to)))
       OR (p_from IN ('failed', 'withdrawn', 'tabled')
           AND p_to IN ('signed', 'veto_overridden', 'enacted'))
     )
$$;

COMMENT ON FUNCTION public.proposal_status_advances(public.proposal_status, public.proposal_status) IS
  'FIX-1257 — may a proposal at p_from move to p_to? Forward by rank; a '
  'terminal (vetoed/failed/withdrawn/tabled) from any stage unless the current '
  'status is a higher terminal; and signed/veto_overridden/enacted beat '
  'failed/withdrawn/tabled. NULL p_to never advances.';

-- ── 3. The set-based writer ─────────────────────────────────────────────────
-- One statement: lock the named rows, move each whose rule says yes, return
-- the moved rows with their old status. A duplicate id in the input keeps its
-- highest-ranked status (callers dedupe; this is the tie-break, not a feature).
-- The rule is re-evaluated against the row as locked, so a row another writer
-- advanced in the meantime is a no-op, never a regression.
CREATE OR REPLACE FUNCTION public.proposals_advance_status(
  p_ids      uuid[],
  p_statuses public.proposal_status[]
)
RETURNS TABLE (id uuid, from_status public.proposal_status, to_status public.proposal_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF cardinality(p_ids) IS DISTINCT FROM cardinality(p_statuses) THEN
    RAISE EXCEPTION 'proposals_advance_status: % id(s) but % status(es)',
      cardinality(p_ids), cardinality(p_statuses)
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH wanted AS (
    SELECT DISTINCT ON (x.pid) x.pid, x.st
      FROM unnest(p_ids, p_statuses) AS x(pid, st)
     WHERE x.pid IS NOT NULL AND x.st IS NOT NULL
     ORDER BY x.pid, public.proposal_status_rank(x.st) DESC
  ),
  locked AS (
    SELECT p.id AS pid, p.status AS was
      FROM public.proposals p
      JOIN wanted w ON w.pid = p.id
     ORDER BY p.id
       FOR UPDATE OF p
  )
  UPDATE public.proposals p
     SET status = w.st
    FROM wanted w
    JOIN locked l ON l.pid = w.pid
   WHERE p.id = w.pid
     AND public.proposal_status_advances(p.status, w.st)
  RETURNING p.id, l.was, p.status;
END;
$$;

COMMENT ON FUNCTION public.proposals_advance_status(uuid[], public.proposal_status[]) IS
  'FIX-1257 — set-based status advance: for each (id, status) pair, move the '
  'proposal only when proposal_status_advances(current, status). Returns the '
  'moved rows (id, from_status, to_status); a pair the rule refuses is simply '
  'absent. Callers: the congress sync''s Step 3, the vote path after a passage '
  'roll, scripts/fix1257-backfill-passed-status.mjs. service_role only.';

REVOKE ALL ON FUNCTION public.proposals_advance_status(uuid[], public.proposal_status[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.proposals_advance_status(uuid[], public.proposal_status[])
  TO service_role;

-- ── 4. Coverage: every enum value has a rank ────────────────────────────────
-- A value added to proposal_status without a rank would make the rule NULL
-- for it — i.e. silently "never advance". Fail the migration instead.
DO $do$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(s::text, ', ') INTO v_missing
    FROM unnest(enum_range(NULL::public.proposal_status)) AS s
   WHERE public.proposal_status_rank(s) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1257: proposal_status value(s) with no rank: %', v_missing;
  END IF;
END
$do$;

COMMIT;
