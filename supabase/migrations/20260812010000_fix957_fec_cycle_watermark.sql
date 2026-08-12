-- FIX-957 — per-cycle "last full FEC pass" watermark, readable from SQL.
--
-- THE QUESTION EVERY FEC ATTRIBUTION AUDIT WANTS TO ASK is "was this row
-- written by the most recent full pass for its cycle?" — a row the current
-- binding no longer produces is by definition mis-bound. Three ways to derive
-- an answer were measured and rejected on the local clone 2026-08-01:
--
--   1. max(updated_at) per cycle — marked 1,622,392 of 1,734,219 cycle-2024
--      rows stale, because the recent runs were not full passes (the last full
--      one was 2026-07-13 at 2,040,556 rows; 2026-07-19 wrote 251,902 and
--      2026-08-01 wrote 302,538). Useless as a boundary.
--   2. data_sync_log — carries a pipeline='fec_bulk' row per run but records NO
--      cycle scope at all (metadata is just {peak_rss_mb}), and its history is
--      not clean (repeated 'failed' rows through July, plus a row stuck at
--      status='running' from 2026-07-27).
--   3. Row timestamps as a proxy for pipeline writes — invalid: the
--      financial_relationships BEFORE UPDATE trigger set_updated_at() stamps
--      ANY maintenance UPDATE, so FIX-955's 30,564-row `SET to_id = …` repair is
--      indistinguishable from a pipeline write afterwards.
--
-- Consequence: FIX-954's absolute-staleness gate had to be re-expressed RELATIVE
-- to the holder's own rows ("does this official have rows newer than its
-- contaminated set?"). Sound, and it shipped, but strictly weaker — it needs the
-- holder to still be actively written, so it cannot decide an official whose
-- binding is legitimately dormant, and it cannot tell "this cycle was never
-- re-run" apart from "this official stopped receiving".
--
-- THIS MIGRATION is the read half of the fix. The write half is in
-- packages/data/src/pipelines/fec-bulk/run-state.ts + index.ts: each indiv
-- sub-stage stamps pipeline_state.fec_bulk_cycle_watermarks on SUCCESSFUL
-- completion, at the same call site that marks the stage complete for resume.
-- A killed or partial stage never reaches it, so a stamp can never claim work
-- that did not finish — the opposite failure mode from (1) above.
--
-- WHY A SEPARATE pipeline_state KEY from fec_bulk_run_state (which the bullet
-- proposed extending): that row is RESUME state and is DELETEd the moment a
-- cycle completes, discarded when FEC publishes a new drop, and dropped on a
-- version bump. It is destroyed at exactly the moment a watermark becomes
-- valuable. Keeping a residual row alive to carry stamps is worse — a non-null
-- run state is the pipeline's own signal that a resume is PENDING and it drives
-- the FIX-754 cycle-narrowing self-guard. Full reasoning in run-state.ts.
--
-- DELIBERATELY NOT IN THIS MIGRATION (they stay open on the FIX-957 bullet):
--   * the updated_at-trigger-suppression / last_pipeline_write_at question;
--   * reconciling the stuck 'running' data_sync_log row from 2026-07-27 and
--     guarding against future abandoned runs.
--
-- Stored shape (JSONB), mirroring the fec_indiv_watermark convention:
--   {"2026": {"donor-entities":      {"completed_at": "<iso>",
--                                     "fec_last_modified": "<rfc1123|null>"},
--             "indiv-to-candidate":  {...}, ...}}

-- ── 1. Per-stage watermark rows for one cycle ────────────────────────────────
-- Set-returning so an audit can join per stage. Five rows max — nowhere near
-- PostgREST's 1,000-row set-returning cap, and the intended callers are SQL
-- audits joining server-side anyway.

CREATE OR REPLACE FUNCTION public.fec_cycle_watermark(p_cycle int)
RETURNS TABLE (
  stage             text,
  completed_at      timestamptz,
  fec_last_modified text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    s.key                                        AS stage,
    (s.value->>'completed_at')::timestamptz       AS completed_at,
    s.value->>'fec_last_modified'                 AS fec_last_modified
  FROM public.pipeline_state ps
  CROSS JOIN LATERAL jsonb_each(
    COALESCE(ps.value->(p_cycle::text), '{}'::jsonb)
  ) AS s(key, value)
  WHERE ps.key = 'fec_bulk_cycle_watermarks'
    AND jsonb_typeof(COALESCE(ps.value->(p_cycle::text), 'null'::jsonb)) = 'object'
    AND s.value ? 'completed_at';
$$;

COMMENT ON FUNCTION public.fec_cycle_watermark(int) IS
  'FIX-957 — per-stage completion timestamps for one FEC cycle, from '
  'pipeline_state.fec_bulk_cycle_watermarks. Success-only: a killed or partial '
  'stage never advances its stamp. Zero rows = no pass has ever completed for '
  'that cycle (or every pass was scoped / ran with an unverifiable FEC HEAD, '
  'both of which deliberately do not stamp).';

-- ── 2. The scalar audits actually join against ───────────────────────────────
-- "When did this cycle last have a pass that completed EVERY indiv writer
-- stage?" = MIN over the four writer stages, NULL if any has never completed.
--
-- MIN, not MAX: the cycle is only fully re-derived once the SLOWEST of the four
-- finished, and the four can legitimately complete on different nights via the
-- FIX-754 resume path. Taking MAX would let one fast stage vouch for three that
-- never ran.
--
-- 'independent-expenditures' is excluded on purpose — it writes ie_support /
-- ie_oppose, not 'donation', and the pipeline explicitly tolerates its failure
-- ("the cycle still wraps up with PAC + indiv data already landed"). Folding it
-- in would let a flaky Schedule-E download suppress the donation-side watermark.
--
-- Usage in an attribution audit — "rows this cycle's current binding no longer
-- endorses":
--   SELECT fr.* FROM financial_relationships fr
--   WHERE fr.cycle_year = 2024
--     AND fr.metadata->>'source' LIKE 'fec_bulk%'
--     AND fr.updated_at < public.fec_cycle_full_pass_at(2024);
-- (NULL short-circuits the predicate to no rows, which is the correct
-- "cannot answer yet" behaviour — never "everything is stale".)

CREATE OR REPLACE FUNCTION public.fec_cycle_full_pass_at(p_cycle int)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
           WHEN COUNT(*) FILTER (
                  WHERE w.stage IN ('donor-entities', 'indiv-to-candidate',
                                    'recipient-entities', 'indiv-to-committee')
                ) = 4
           THEN MIN(w.completed_at) FILTER (
                  WHERE w.stage IN ('donor-entities', 'indiv-to-candidate',
                                    'recipient-entities', 'indiv-to-committee')
                )
           ELSE NULL
         END
  FROM public.fec_cycle_watermark(p_cycle) w;
$$;

COMMENT ON FUNCTION public.fec_cycle_full_pass_at(int) IS
  'FIX-957 — timestamp of the last pass that completed ALL FOUR indiv writer '
  'stages for this cycle (MIN across them), or NULL if any has never completed. '
  'The IE stage is excluded: it writes ie_support/ie_oppose and is allowed to '
  'fail without failing the cycle.';

-- ── 3. Grants ────────────────────────────────────────────────────────────────
-- Audit surface, not a request-path RPC. service_role only; anon/authenticated
-- get nothing (FIX-834 — Supabase default-grants EXECUTE on new functions to
-- anon/authenticated, so the REVOKE is required, not decorative).

REVOKE ALL ON FUNCTION public.fec_cycle_watermark(int)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fec_cycle_full_pass_at(int)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fec_cycle_watermark(int)    TO service_role;
GRANT EXECUTE ON FUNCTION public.fec_cycle_full_pass_at(int) TO service_role;
