-- =============================================================================
-- FIX-837 — Materialize get_official_bipartisan_stats() into official_vote_stats.
--
-- get_official_bipartisan_stats() live-aggregates the ENTIRE votes table on every
-- rule-tagger run: it scans public.votes twice (a yes-only party-join pass for
-- the per-proposal distinct-party count → bipartisan_yes, plus a full totals pass
-- for total_votes / yes_votes) and GROUP BYs by official → one jsonb array.
-- Measured ~114s on prod (FIX-651 direct-pg timing). Pipeline-only (not
-- user-facing), but a two-minute whole-table scan on every tagger run. One
-- consumer path, via rollupJsonbDirect (packages/data/src/lib/heavy-rebuild.ts):
--   • tags/rules.ts tagOfficials()                → bipartisan / party-line tags
--   • enrichment/queue.ts aggregateOfficialStats() → per-official vote counts
--
-- ── Fix: a small per-official summary, rebuilt nightly ────────────────────────
-- public.official_vote_stats holds exactly what the consumers read
-- {official_id, total_votes, yes_votes, bipartisan_yes} — one row per official
-- with ≥1 vote (≈601 local, low-thousands prod), not a whole-votes-table scan.
-- get_official_bipartisan_stats() is rewritten to read the summary behind a
-- pipeline_state bootstrap flag; its pre-FIX-837 whole-table body is preserved
-- VERBATIM as get_official_bipartisan_stats_full() (break-glass + the live-compute
-- fallback used until the summary is first built, so a tagger run in that window
-- never sees [] and wipes tags — the FIX-426/427 contract). Output shape is
-- byte-identical: [{official_id,total_votes,yes_votes,bipartisan_yes}, ...] with
-- bipartisan_yes coalesced to 0, so the rollupJsonbDirect callers need no change.
--
-- ── Why a nightly FULL REBUILD, not a votes-watermark incremental ─────────────
-- Deliberate deviation from the FIXES.md sketch (which proposed a votes-watermark
-- incremental). The full aggregation is ~2 min as the postgres role off the
-- request path — cheap enough to run nightly. An incremental would be both harder
-- and structurally worse here:
--   (a) bipartisan_yes is PROPOSAL-scoped — a single changed yes-vote on proposal
--       P dirties EVERY official who yes-voted on P, so the dirty set fans out far
--       beyond the changed rows.
--   (b) nightly congress upserts bump votes.updated_at broadly (the unconditional
--       set_updated_at trigger), so a votes-watermark dirty set degenerates toward
--       the full set most nights anyway.
--   (c) a full rebuild self-heals officials.party changes and vote DELETIONS,
--       which a watermark structurally misses (no updated_at bump on a delete).
-- The rebuild replaces the table's contents atomically in one transaction; readers
-- are snapshot-isolated, so a concurrent DELETE-then-INSERT is never observed as
-- an empty/partial set. See [[FIX-836]] (the donor-rollup materialization this
-- mirrors) and [[FIX-651]] (the bipartisan cost measurement).
--
-- ── Bootstrap-flag gate, not an EXISTS gate ──────────────────────────────────
-- The read path switches to the summary only once pipeline_state
-- 'official_vote_stats_state' has {bootstrapped:true}, which the rebuild flips in
-- the SAME txn as the first complete write. An EXISTS/non-empty gate would serve a
-- partial set if it ever raced a half-finished write; the flag covers the whole
-- pre-bootstrap window with the _full() fallback (see the FIX-836 migration §3).
--
-- ── Promotion (FIX-761 official-FK-surface contract) ─────────────────────────
-- official_vote_stats.official_id references officials, so a promoted (deleted)
-- official must not leave a stale row. Derived + self-healing: the nightly rebuild
-- drops vanished officials; the elected side is also cleaned immediately by an
-- AFTER DELETE trigger on officials (a second, tiny trigger fn — the FIX-836
-- rationale: avoid re-CREATE-ing the 320-line promote_candidate_to_elected() just
-- to add one derived-cleanup line). See [[FIX-761]] [[FIX-836]].
-- =============================================================================

-- ── 1. Summary table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.official_vote_stats (
  official_id    uuid        NOT NULL PRIMARY KEY,  -- one row per official with ≥1 vote
  total_votes    bigint      NOT NULL,
  yes_votes      bigint      NOT NULL,
  bipartisan_yes bigint      NOT NULL,              -- coalesced to 0 (matches the read fn)
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.official_vote_stats IS
  'FIX-837 — exact per-official vote summary {total_votes,yes_votes,bipartisan_yes} '
  'that get_official_bipartisan_stats() reads instead of scanning the whole votes '
  'table (~114s, FIX-651). One row per official with ≥1 vote. Rebuilt in full '
  'nightly by rebuild_official_vote_stats() (pg_cron vote-stats-refresh, 03:30 UTC). '
  'Derived + self-healing (nightly rebuild drops vanished officials; the officials '
  'AFTER DELETE trigger cleans the elected side immediately). Byte-identical to the '
  'pre-FIX-837 get_official_bipartisan_stats() output (kept as _full()).';

-- Read only by the SECURITY DEFINER get_official_bipartisan_stats() (owner=postgres,
-- bypasses RLS); no anon/authenticated surface (FIX-834/695 hygiene). RLS on with
-- no policy = deny direct non-owner access. service_role gets DML for the case
-- where the rebuild is invoked as service_role. Mirrors official_donor_totals.
ALTER TABLE public.official_vote_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_vote_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_vote_stats TO service_role;

-- ── 2. Break-glass: the pre-FIX-837 whole-table aggregation, preserved VERBATIM.
--     Also the live-compute fallback below. ~114s on prod. Body is byte-for-byte
--     the migration-time live definition of get_official_bipartisan_stats().
CREATE OR REPLACE FUNCTION public.get_official_bipartisan_stats_full()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '300s'
AS $$
  WITH yes_party_votes AS (
    SELECT v.official_id, v.bill_proposal_id, o.party
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE v.vote = 'yes' AND o.party IS NOT NULL
  ),
  proposal_party_counts AS (
    SELECT bill_proposal_id, COUNT(DISTINCT party) AS distinct_parties
    FROM yes_party_votes
    GROUP BY bill_proposal_id
  ),
  bipartisan AS (
    SELECT ypv.official_id,
           COUNT(*) FILTER (WHERE ppc.distinct_parties >= 2) AS bipartisan_yes
    FROM yes_party_votes ypv
    JOIN proposal_party_counts ppc ON ppc.bill_proposal_id = ypv.bill_proposal_id
    GROUP BY ypv.official_id
  ),
  totals AS (
    SELECT v.official_id,
           COUNT(*)                               AS total_votes,
           COUNT(*) FILTER (WHERE v.vote = 'yes') AS yes_votes
    FROM public.votes v
    GROUP BY v.official_id
  )
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  FROM (
    SELECT
      to2.official_id,
      to2.total_votes::BIGINT                 AS total_votes,
      to2.yes_votes::BIGINT                   AS yes_votes,
      COALESCE(b.bipartisan_yes, 0)::BIGINT   AS bipartisan_yes
    FROM totals to2
    LEFT JOIN bipartisan b ON b.official_id = to2.official_id
  ) t;
$$;

COMMENT ON FUNCTION public.get_official_bipartisan_stats_full() IS
  'FIX-837 — the pre-FIX-837 whole-table bipartisan aggregation (two votes-table '
  'passes → jsonb). ~114s on prod (FIX-651). Break-glass + the live-compute '
  'fallback for get_official_bipartisan_stats() before official_vote_stats is '
  'first built.';

-- ── 3. Fast path: read the nightly-rebuilt summary once bootstrapped; else ─────
--     live-compute via _full(). Gate is the pipeline_state flag, NOT "table is
--     non-empty" (partial-set hazard). Output shape unchanged.
CREATE OR REPLACE FUNCTION public.get_official_bipartisan_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v              jsonb;
  v_bootstrapped boolean;
BEGIN
  SELECT (value->>'bootstrapped')::boolean INTO v_bootstrapped
  FROM public.pipeline_state WHERE key = 'official_vote_stats_state';

  IF COALESCE(v_bootstrapped, false) THEN
    SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v
    FROM (
      SELECT official_id, total_votes, yes_votes, bipartisan_yes
      FROM public.official_vote_stats
    ) t;
    RETURN v;
  END IF;
  -- Not yet built → live-compute so a tagger run never sees a partial/[] set
  -- (would wipe bipartisan tags). Self-healing: once built, the fast path wins.
  RETURN public.get_official_bipartisan_stats_full();
END;
$$;

COMMENT ON FUNCTION public.get_official_bipartisan_stats() IS
  'FIX-837 — reads the official_vote_stats summary (was a ~114s whole-votes-table '
  'aggregation, FIX-651). Live-compute fallback to get_official_bipartisan_stats_full() '
  'until the nightly rebuild first bootstraps the summary. Output shape unchanged '
  '(rollupJsonbDirect callers tagOfficials + aggregateOfficialStats need no change).';

-- ── 4. Rebuild proc: full atomic rebuild of official_vote_stats. Same aggregation
--     as _full(), written to the table in one txn (DELETE + INSERT + flag), guarded
--     by a transaction-scoped advisory lock (auto-released on commit/rollback; no
--     COMMIT in this proc, so no session-lock leak on error). CALLed nightly by
--     pg_cron and once per-env to bootstrap.
CREATE OR REPLACE PROCEDURE public.rebuild_official_vote_stats()
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('official_vote_stats_rebuild')::bigint) THEN
    RAISE NOTICE '[vote-stats rebuild] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  -- Atomic swap: readers are snapshot-isolated, so DELETE + INSERT in one txn is
  -- never observed as an empty set. Aggregation is byte-identical to _full().
  DELETE FROM public.official_vote_stats;

  WITH yes_party_votes AS (
    SELECT v.official_id, v.bill_proposal_id, o.party
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE v.vote = 'yes' AND o.party IS NOT NULL
  ),
  proposal_party_counts AS (
    SELECT bill_proposal_id, COUNT(DISTINCT party) AS distinct_parties
    FROM yes_party_votes
    GROUP BY bill_proposal_id
  ),
  bipartisan AS (
    SELECT ypv.official_id,
           COUNT(*) FILTER (WHERE ppc.distinct_parties >= 2) AS bipartisan_yes
    FROM yes_party_votes ypv
    JOIN proposal_party_counts ppc ON ppc.bill_proposal_id = ypv.bill_proposal_id
    GROUP BY ypv.official_id
  ),
  totals AS (
    SELECT v.official_id,
           COUNT(*)                               AS total_votes,
           COUNT(*) FILTER (WHERE v.vote = 'yes') AS yes_votes
    FROM public.votes v
    GROUP BY v.official_id
  )
  INSERT INTO public.official_vote_stats (official_id, total_votes, yes_votes, bipartisan_yes)
  SELECT
    to2.official_id,
    to2.total_votes::BIGINT,
    to2.yes_votes::BIGINT,
    COALESCE(b.bipartisan_yes, 0)::BIGINT
  FROM totals to2
  LEFT JOIN bipartisan b ON b.official_id = to2.official_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the full write, so the read fn only
  -- leaves the _full() fallback once the complete set is committed.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('official_vote_stats_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text, 'rows', v_count))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('official_vote_stats_rebuild', 'complete', now(), now(), v_count,
          jsonb_build_object('rows', v_count));

  RAISE NOTICE '[vote-stats rebuild] complete — % officials', v_count;
END;
$$;

COMMENT ON PROCEDURE public.rebuild_official_vote_stats() IS
  'FIX-837 — full atomic rebuild of official_vote_stats (byte-identical aggregation '
  'to get_official_bipartisan_stats_full()). Nightly via pg_cron vote-stats-refresh; '
  'also the one-shot per-env bootstrap. ~2 min as the postgres role. Run over '
  'direct-pg with a raised session statement_timeout when bootstrapping (the ~2-min '
  'agg can exceed a 2-min pooler default).';

-- ── 5. pg_cron: nightly full rebuild. 03:30 UTC — after the 02:00 nightly ingest
--     that lands votes, and clear of every other job (refresh-derived-mvs 06:00,
--     rule-taggers 06:30, fec_bulk ~05:30+, rebuild-ec 08:00, donor-rollup 09:00).
--     Idempotent (FIX-688): unschedule by name, then schedule. Plain CALL — matches
--     all existing jobs; the cron role (postgres) has no statement_timeout and the
--     database default is generous, so the ~2-min single statement completes.
SELECT cron.unschedule(jobname)
  FROM cron.job WHERE jobname = 'vote-stats-refresh';

SELECT cron.schedule(
  'vote-stats-refresh',
  '30 3 * * *',
  $$CALL public.rebuild_official_vote_stats();$$
);

-- ── 6. Derived-cleanup trigger: drop an official's summary row when the official
--     is deleted (promotion via promote_candidate_to_elected(), or any officials
--     delete). Mirrors official_donor_totals_cleanup without re-CREATE-ing the
--     promote function. See the FIX-761 note in the header.
CREATE OR REPLACE FUNCTION public.official_vote_stats_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.official_vote_stats WHERE official_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS official_vote_stats_cleanup_del ON public.officials;
CREATE TRIGGER official_vote_stats_cleanup_del
  AFTER DELETE ON public.officials
  FOR EACH ROW
  EXECUTE FUNCTION public.official_vote_stats_cleanup();

-- ── 7. Function grants (Supabase default-grants EXECUTE to anon/authenticated on
--     every new function — FIX-695/834 — so route-gated DEFINER RPCs need an
--     explicit REVOKE). Both stats fns are service_role-only (direct-pg tag
--     pipeline). The rebuild proc is a supervised bootstrap + cron target.
REVOKE ALL ON FUNCTION public.get_official_bipartisan_stats()      FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_official_bipartisan_stats()      TO service_role;
REVOKE ALL ON FUNCTION public.get_official_bipartisan_stats_full() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_official_bipartisan_stats_full() TO service_role;
REVOKE ALL ON PROCEDURE public.rebuild_official_vote_stats()       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.rebuild_official_vote_stats()       TO service_role;

-- PostgREST: new table + changed function signature → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
