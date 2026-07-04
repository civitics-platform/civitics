-- FIX-715 — relocate the enrichment MV-refresh tail to pg_cron (PR2).
--
-- Problem: the nightly GHA `enrichment` phase (packages/data/src/pipelines/
-- index.ts steps 3b / 3b-ii / step 7) refreshes ~13 small MVs + runs
-- refresh_spending_totals + rebuild_all_primary_sources + the retention prunes
-- at the TAIL of a 120-min budget, over the capped PostgREST admin.rpc() path
-- (~8s service_role / ~100s gateway). When source ingests eat the budget the
-- tail never runs and the MVs go dark — 2026-06-29: the phase SIGTERMd at
-- 120 min and zero MV refreshes ran. The PostgREST caps also silently stale any
-- refresh that runs long (it is cancelled at the gateway before it completes).
--
-- Fix: move the tail onto cadence-matched pg_cron procedures, reusing the
-- FIX-687/703/704 pg_cron-procedure pattern — a PROCEDURE invoked via CALL, a
-- COMMIT between each unit (so each REFRESH … CONCURRENTLY runs in its own
-- committed transaction), a per-unit `EXCEPTION WHEN OTHERS` so one failure does
-- not abort the rest, a session advisory lock, data_sync_log observability, and
-- the postgres role-default 6h statement_timeout armed at CALL start (FIX-703 —
-- an in-procedure SET / COMMIT / proconfig cannot re-arm it, so we do not try).
--
-- These stay FULL REFRESHes (rebuild-from-scratch), NOT the FIX-704 incremental
-- table shape — so they have no hard-delete blind spot and need no orphan sweep
-- (FIX-705 is irrelevant here). The FIX-641 loop comment already established the
-- other MVs "are small enough to refresh fine"; the investigation gate confirmed
-- it (row counts below).
--
-- ── Investigation gate — per-MV row counts / size on the local prod clone ─────
-- (2026-07-03; the two DEFERRED MVs are the only large ones.)
--   proposal_trending_24h              78k /  29 MB   20.2s CONCURRENTLY (local)
--   official_homepage_stats_mv         29k / 6.5 MB
--   official_sector_dollars_mv         13k / 1.7 MB
--   chord_donor_state_party_flows_mv  395 /  80 kB
--   homepage_agency_counts_mv          94 /  72 kB
--   chord_industry_flows_mv            97 /  48 kB
--   pipeline_runtime_stats_mv          27 /  40 kB
--   chord_subject_party_flows_mv       92 /  40 kB
--   chord_donor_type_party_flows_mv    30 /  40 kB
--   entity_engagement_rollup_mv         6 /  40 kB
--   commons_active_threads             50 /  80 kB   (NOTE: no _mv suffix)
--   proposal_popularity_24h             ~ /  16 kB
--   homepage_stats_mv                   1 /  16 kB   (plain REFRESH — no unique idx)
--   ── DEFERRED (kept on the GHA path; follow-ups filed) ──
--   entity_connection_stats_mv       2.42M / 264 MB  3m25s CONCURRENTLY (local)
--   donor_party_rollup_mv            1.29M / 186 MB  1m48s CONCURRENTLY (local)
-- Both DEFERRED MVs sit at the size that OOM-restarted Micro in FIX-704
-- (official_donor_rollup was 276 MB / 770k). On the PostgREST nightly path a
-- too-heavy refresh is CUT OFF at the ~100s gateway (stales safely); on pg_cron's
-- 6h budget it runs to COMPLETION — exactly when the FIX-704 OOM happened.
-- Relocating them as full CONCURRENTLY REFRESHes would re-introduce that OOM, so
-- they stay on the GHA path until converted to the FIX-704 incremental shape
-- (follow-up FIXes). Everything relocated here is ≤ 78k rows / 29 MB.
--
-- ── Co-located maintenance ───────────────────────────────────────────────────
-- The removed step-7 loop also carried non-MV maintenance that has the same
-- "does not belong on the 120-min budget" property; it rides along in the same
-- cadence procedure (each is a committed, exception-guarded unit, so an MV
-- failure and a prune failure are independent):
--   daily : rebuild_all_primary_sources (safety-net re-derive from xsr),
--           prune_platform_usage_snapshot / prune_kill_switch_events /
--           prune_status_snapshot (retention).
--   weekly: refresh_spending_totals (contract+grant totals — was step 3b-ii,
--           already a direct-pg heavy rebuild; here it is a plain committed unit
--           under the 6h budget).
--
-- Cadence is matched to each unit's source (INVESTIGATION GATE, decision 3):
--   daily  — proposal/vote/comment/engagement-derived MVs (change from the nightly
--            ingest + continuous user activity).
--   weekly — donation-derived MVs (donations only change on the Sunday FEC bulk):
--            the 4 chord MVs + official_sector_dollars_mv + refresh_spending_totals.
--
-- The rule taggers (size-tags weekly + pre-vote daily) get their OWN procedure /
-- jobs in the companion migration (FIX-716) so a tagger failure and an MV failure
-- stay independent.

-- ── refresh_derived_mvs(p_cadence) ───────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_derived_mvs(p_cadence text)
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('refresh_derived_mvs')::bigint;  -- shared by both cadences: never two at once
  v_log_id   uuid;
  v_units    text[];   -- SQL command per unit
  v_labels   text[];   -- human label per unit (data_sync_log / NOTICE)
  v_cmd      text;
  v_label    text;
  v_ok       int := 0;
  v_failures text[] := ARRAY[]::text[];
  i          int;
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'refresh_derived_mvs: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

  -- Session advisory lock (survives the per-unit COMMITs below). Stampede guard.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('refresh_derived_mvs', 'skipped', now(), now(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent refresh_derived_mvs',
                               'source', 'pg_cron'));
    RAISE NOTICE '[derived-mvs] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;

  -- Bounded per-unit memory. Plain SET (not SET LOCAL) survives the COMMITs.
  -- Every unit here is small (≤ 78k rows); the memory-risky MVs are DEFERRED, so
  -- 128MB is a comfortable ceiling that never becomes pressure. NOTE (FIX-703):
  -- the CALL's statement_timeout is the postgres role default (6h) armed at CALL
  -- start — nothing in this body can change it.
  SET work_mem = '128MB';

  IF p_cadence = 'daily' THEN
    -- proposal/vote/comment/engagement-derived. All CONCURRENTLY except
    -- homepage_stats_mv (single row, no unique index → plain REFRESH; the brief
    -- ACCESS EXCLUSIVE lock on a 1-row MV is trivial). commons_active_threads has
    -- NO _mv suffix (the refresh_commons_active_threads_mv() wrapper targets
    -- `commons_active_threads`). Tail: co-located daily maintenance.
    v_labels := ARRAY[
      'proposal_trending_24h', 'proposal_popularity_24h', 'homepage_stats_mv',
      'official_homepage_stats_mv', 'entity_engagement_rollup_mv',
      'homepage_agency_counts_mv', 'commons_active_threads', 'pipeline_runtime_stats_mv',
      'rebuild_all_primary_sources', 'prune_platform_usage_snapshot',
      'prune_kill_switch_events', 'prune_status_snapshot'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_trending_24h',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.proposal_popularity_24h',
      'REFRESH MATERIALIZED VIEW public.homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.entity_engagement_rollup_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_agency_counts_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.commons_active_threads',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.pipeline_runtime_stats_mv',
      'SELECT public.rebuild_all_primary_sources()',
      'SELECT public.prune_platform_usage_snapshot()',
      'SELECT public.prune_kill_switch_events()',
      'SELECT public.prune_status_snapshot()'
    ];
  ELSE  -- weekly (donation-derived)
    v_labels := ARRAY[
      'chord_industry_flows_mv', 'chord_donor_type_party_flows_mv',
      'chord_donor_state_party_flows_mv', 'chord_subject_party_flows_mv',
      'official_sector_dollars_mv', 'refresh_spending_totals'
    ];
    v_units := ARRAY[
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_industry_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_type_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_donor_state_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.chord_subject_party_flows_mv',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_sector_dollars_mv',
      'SELECT public.refresh_spending_totals()'
    ];
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('refresh_derived_mvs', 'running', now(),
          jsonb_build_object('cadence', p_cadence,
                             'units', array_length(v_units, 1),
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  FOR i IN 1 .. array_length(v_units, 1) LOOP
    v_cmd   := v_units[i];
    v_label := v_labels[i];
    BEGIN
      EXECUTE v_cmd;
      v_ok := v_ok + 1;
      RAISE NOTICE '  [derived-mvs] % — ok', v_label;
    EXCEPTION WHEN OTHERS THEN
      -- One bad unit must not abort the rest; its MV/table keeps its PRIOR
      -- contents (complete-if-stale). Run is reported `failed`.
      v_failures := v_failures || format('%s: %s', v_label, SQLERRM);
      RAISE WARNING '  [derived-mvs] % — FAILED: %', v_label, SQLERRM;
    END;
    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Each REFRESH … CONCURRENTLY thus commits in its own txn.
    COMMIT;
  END LOOP;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
      completed_at  = now(),
      rows_inserted = v_ok,   -- units succeeded (not a row count — these are refreshes)
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN array_length(v_failures, 1) > 0
                           THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL END,
      metadata      = metadata || jsonb_build_object(
                        'units_ok', v_ok,
                        'unit_failures', COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[derived-mvs] % (cadence=%) — %/% units ok (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_ok, array_length(v_units, 1), COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_derived_mvs(text) TO service_role;

COMMENT ON PROCEDURE public.refresh_derived_mvs(text) IS
  'FIX-715 — pg_cron refresh of the enrichment MV tail, cadence-matched to source '
  '(daily = proposal/vote/comment/engagement MVs + primary-source re-derive + '
  'retention prunes; weekly = donation-derived chord/sector MVs + spending totals). '
  'FIX-704 pattern: session advisory lock, per-unit COMMIT + EXCEPTION-continue, '
  'data_sync_log, work_mem bounded, 6h role-default budget armed at CALL start. '
  'Full REFRESHes (no hard-delete blind spot). entity_connection_stats_mv and '
  'donor_party_rollup_mv are DEFERRED (too large for a full REFRESH on Micro — '
  'FIX-704 OOM class) and stay on the GHA path pending incremental conversion. '
  'CALL with ''daily'' or ''weekly''.';

-- ── pg_cron jobs — created PAUSED (FIX-704 discipline) ───────────────────────
-- Registered but inactive. The FIX-715 runbook (supervised, off-peak) runs a
-- one-off CALL refresh_derived_mvs('daily') then ('weekly') on prod to confirm
-- the small MVs refresh with no memory spike, THEN enables the two jobs:
--   SELECT cron.alter_job(jobid, active := true)
--     FROM cron.job WHERE jobname LIKE 'refresh-derived-mvs-%';
--
-- Off-peak slots (UTC), clear of the 02:00 nightly and the existing 08:00
-- Mon/Tue/Wed rebuild+rollup jobs:
--   refresh-derived-mvs-daily   06:00 daily   — after the nightly ingest window.
--   refresh-derived-mvs-weekly  07:00 Tue     — after the Sunday FEC bulk; the
--     units are tiny (chord MVs + a spending-total UPDATE), done in seconds, so
--     no overlap concern with donor-rollup-refresh at Tue 08:00.
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('refresh-derived-mvs-daily', 'refresh-derived-mvs-weekly');

SELECT cron.schedule(
  'refresh-derived-mvs-daily',
  '0 6 * * *',
  $$CALL public.refresh_derived_mvs('daily');$$
);

SELECT cron.schedule(
  'refresh-derived-mvs-weekly',
  '0 7 * * 2',
  $$CALL public.refresh_derived_mvs('weekly');$$
);

SELECT cron.alter_job(job_id := jobid, active := false)
  FROM cron.job
 WHERE jobname IN ('refresh-derived-mvs-daily', 'refresh-derived-mvs-weekly');
