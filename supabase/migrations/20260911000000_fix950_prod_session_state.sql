-- FIX-950 — a supervised prod session the scheduled writers can see.
--
-- THE PROBLEM (FIX-950, filed 2026-07-30). There is no way for a human working
-- on prod to tell the scheduled writers to stand down, and no way for them to
-- know a supervised session is in progress. The only lever that has ever
-- existed is "cancel the nightly GHA run", used twice; the first of those is
-- what corrupted tag_rules on 2026-07-30 (FIX-945 / FIX-949). FIX-1165's set-2
-- apply is the same collision from the other side: a supervised session and the
-- platform's own arms contending for one disk, 202 statement cancellations in
-- 97 minutes against a baseline of 1.
--
-- WHAT THIS IS. The sibling of public.fec_bulk_interlock_state(), with the
-- widest scope: one advisory lock that a supervised session holds, and one
-- reader every scheduled heavy writer consults. Nothing here is new machinery.
-- FIX-1067 established the lock shape — a SESSION-level pg_try_advisory_lock on
-- a dedicated connection, released by Postgres when the holder's backend goes
-- away, so there is no TTL to tune and no stranded-lock mode — and the heavy
-- procedures already know how to write a `skipped` row with a `skip_reason`
-- when they cannot take their own lock. This connects the two.
--
-- ── D1: THE LOCK IS THE TRUTH; THE pipeline_state ROW IS THE LABEL ──────────
-- `held` is read from pg_locks and cannot be stale: it is a fact about a live
-- backend. pipeline_state.prod_session carries WHY — reason, who, when, how
-- long it is expected to take — and CAN be stale, because the label write is
-- best-effort and a process can die between the unlock and the DELETE. So the
-- label never decides anything. A label with no lock is `label_stale`: reported
-- by the canary, cleaned by the next claim, and NOT a reason to defer. Mirrors
-- fec_bulk_interlock_state's `run_state_stale` exactly.
--
-- ── D2: ONE READER, ONE VOCABULARY ─────────────────────────────────────────
-- Every consumer calls this and nothing else. `defer` is the whole contract,
-- and `defer = held`. The FEC interlock stays as it is and is NOT merged into
-- this one: it answers a different question ("is the FEC writer live"), and
-- this function reports the FEC lock only as one entry in `live_writers`.
--
-- ── live_writers: THE OTHER DIRECTION ──────────────────────────────────────
-- The interlock is symmetric. A session that claims the box while a six-hour
-- rollup is already mid-flight has coordinated nothing — it has added a second
-- writer, which is the shape FIX-1165 measured. So the same function reports
-- which heavy writers are live RIGHT NOW, and session:claim-prod REFUSES over
-- them (D4). The list is a literal because an advisory key is hashtext(name)
-- and hashing is one-way: the names cannot be recovered from pg_locks. It is
-- the census of every pg_try_advisory_lock / pg_try_advisory_xact_lock key in a
-- scheduled heavy procedure, read from the local prod-clone on 2026-09-11 and
-- md5-verified byte-identical to prod for all 20 procedures.
--
-- NOTE ON THE XACT-LOCK MEMBERS (official_vote_stats_rebuild,
-- contract_flow_rollups_rebuild, group_donor_rollup_refresh): a
-- transaction-scoped advisory lock appears in pg_locks only while its
-- transaction is open. That is not a gap in the census — it is the correct
-- reading. Those three hold their lock for exactly as long as they are running,
-- so "present in pg_locks" and "live" are the same statement for them.
--
-- All advisory keys in this schema are taken with the ONE-ARGUMENT form
-- (pg_try_advisory_lock(bigint)), which records objsubid = 1. The two-argument
-- form records objsubid = 2 and is used nowhere here; filtering on 1 is what
-- stops an unrelated two-int lock from reading as one of ours.
--
-- ── COST ───────────────────────────────────────────────────────────────────
-- Called once per firing by every guarded procedure, so it has to stay cheap:
-- two pg_locks scans (a session-local in-memory structure), one single-row
-- pipeline_state read, and one data_sync_log read covered by
-- idx_data_sync_log_pipeline (pipeline, started_at DESC) over 4,077 rows.
--
-- Cross-ref: FIX-1067 (the lock shape), FIX-998 (the nightly's `held` input),
-- FIX-1011 (the census that counts `skipped` as skipped, not missing),
-- FIX-1137 (the re-fire that will one day recover a skipped firing),
-- FIX-462 (the phase-tagged `running` row this reads for the nightly).

CREATE OR REPLACE FUNCTION public.prod_session_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_lock_name    CONSTANT text     := 'prod_supervised_session';
  -- A nightly phase row older than this is not evidence of a live run. The
  -- longest phase budget in nightly.yml is 150 minutes, and 6 h is the ceiling
  -- reap_stale_sync_log/mark-killed already treat as orphaned, so the two agree
  -- on what "still running" means.
  c_nightly_age  CONSTANT interval := interval '6 hours';
  -- Every advisory-lock key held by a scheduled heavy writer, plus the FEC
  -- pipeline's. Keep in step with the guarded set in the two guard migrations;
  -- docs/ops/prod-holds.md carries the table with each one's jobid.
  c_writer_locks CONSTANT text[] := ARRAY[
    'refresh_derived_mvs',
    'entity_connections_rebuild',
    'financial_entity_totals_refresh',
    'run_rule_taggers',
    'official_donor_rollup_refresh',
    'donor_party_rollup_refresh',
    'sector_affinity_tag_refresh',
    'treemap_individuals_global_refresh',
    'entity_connection_stats_rebuild',
    'agency_staffing_rollup_refresh',
    'group_donor_rollup_refresh',
    'official_vote_stats_rebuild',
    'contract_flow_rollups_rebuild',
    'reconcile_donation_edge_orphans',
    'reconcile_donor_party_rollup_orphans',
    'reconcile_donor_rollup_orphans',
    'reconcile_entity_connection_stats_orphans',
    'reconcile_financial_entity_totals',
    'fec_bulk_pipeline'
  ]::text[];

  v_key       bigint;
  v_held      boolean;
  v_label     jsonb;
  v_updated   timestamptz;
  v_claimed   timestamptz;
  v_age       int;
  v_expected  int;
  v_stale     boolean := false;
  v_writers   text[]  := ARRAY[]::text[];
  v_detail    jsonb   := '[]'::jsonb;
BEGIN
  v_key := hashtext(c_lock_name)::bigint;

  SELECT EXISTS (
    SELECT 1 FROM pg_locks l
     WHERE l.locktype = 'advisory'
       AND l.granted
       AND l.objsubid = 1
       AND l.classid  = ((v_key >> 32) & 4294967295)::bigint::oid
       AND l.objid    = (v_key & 4294967295)::bigint::oid
  ) INTO v_held;

  SELECT value, updated_at INTO v_label, v_updated
    FROM public.pipeline_state WHERE key = 'prod_session';

  IF v_label IS NOT NULL THEN
    v_claimed  := COALESCE((v_label->>'claimed_at')::timestamptz, v_updated);
    v_age      := round(EXTRACT(epoch FROM (clock_timestamp() - v_claimed)))::int;
    v_expected := NULLIF(v_label->>'expected_minutes', '')::int;
    -- A label with no lock is a dead session: the holder died between the
    -- unlock and the DELETE, or someone wrote the row by hand.
    v_stale := NOT v_held;
  END IF;

  -- ── the other direction: who is writing right now ────────────────────────
  -- pg_stat_activity supplies the age, which pg_locks alone cannot: a lock row
  -- carries a pid, not a start time, and "a rollup is live" without "for how
  -- long" is not enough for an operator to decide whether to wait or to
  -- --force. xact_start first (an xact-scoped lock is exactly its transaction),
  -- then query_start, then backend_start as a floor.
  SELECT COALESCE(array_agg(w.name ORDER BY w.name), ARRAY[]::text[]),
         COALESCE(jsonb_agg(jsonb_build_object(
                    'name',        w.name,
                    'pid',         w.pid,
                    'age_seconds', w.age_seconds,
                    'source',      'advisory_lock'
                  ) ORDER BY w.name), '[]'::jsonb)
    INTO v_writers, v_detail
    FROM (
      SELECT n.name,
             l.pid,
             round(EXTRACT(epoch FROM (clock_timestamp()
               - COALESCE(a.xact_start, a.query_start, a.backend_start))))::int AS age_seconds
        FROM unnest(c_writer_locks) AS n(name)
        JOIN pg_locks l
          ON l.locktype = 'advisory'
         AND l.granted
         AND l.objsubid = 1
         AND l.classid = ((hashtext(n.name)::bigint >> 32) & 4294967295)::bigint::oid
         AND l.objid   = (hashtext(n.name)::bigint & 4294967295)::bigint::oid
        LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    ) w;

  -- The nightly is GHA-launched, holds no advisory lock of its own, and the
  -- FIX-462 phase-tagged `running` row is its only DB-visible trace. A phase
  -- that is mid-flight is a live heavy writer for preflight purposes even
  -- though nothing in pg_locks says so.
  SELECT v_writers || COALESCE(array_agg(s.tag ORDER BY s.tag), ARRAY[]::text[]),
         v_detail  || COALESCE(jsonb_agg(jsonb_build_object(
                        'name',        s.tag,
                        'pid',         NULL,
                        'age_seconds', s.age_seconds,
                        'source',      'data_sync_log'
                      ) ORDER BY s.tag), '[]'::jsonb)
    INTO v_writers, v_detail
    FROM (
      SELECT 'nightly_cron:' || COALESCE(d.metadata->>'phase', 'all')            AS tag,
             round(EXTRACT(epoch FROM (clock_timestamp() - d.started_at)))::int  AS age_seconds
        FROM public.data_sync_log d
       WHERE d.pipeline = 'nightly_cron'
         AND d.status   = 'running'
         AND d.started_at > clock_timestamp() - c_nightly_age
    ) s;

  RETURN jsonb_build_object(
    'held',             v_held,
    -- defer IS held. Stated as its own key so every consumer reads the same
    -- word the FEC interlock uses and no caller has to know that the two are
    -- the same thing today.
    'defer',            v_held,
    'label_present',    v_label IS NOT NULL,
    'label_stale',      v_stale,
    -- The human-supplied half. Guards interpolate this into their skip_reason,
    -- so it is the string an operator reads six weeks later in data_sync_log.
    'reason',           v_label->>'reason',
    'claimed_by',       v_label->>'claimed_by',
    'claimed_at',       CASE WHEN v_label IS NOT NULL THEN v_claimed END,
    'age_seconds',      v_age,
    'expected_minutes', v_expected,
    'pid',              NULLIF(v_label->>'pid', '')::int,
    'live_writers',     v_writers,
    'live_writer_detail', v_detail,
    -- The operator-facing one-liner, the slot fec_bulk_interlock_state calls
    -- `reason`. Named differently here because `reason` above is already spoken
    -- for by the label's own text.
    'reason_text',      CASE
                          WHEN v_held AND v_label IS NOT NULL
                            THEN 'prod session held: ' || COALESCE(v_label->>'reason', '(no reason given)')
                          WHEN v_held
                            THEN 'prod session lock held with no label row'
                          WHEN v_stale
                            THEN 'stale prod_session label with no lock — a dead session; the next claim clears it'
                          ELSE 'clear'
                        END);
END;
$function$;

COMMENT ON FUNCTION public.prod_session_state() IS
  'FIX-950 — is a supervised prod session holding the box? {held, defer, reason, '
  'claimed_by, age_seconds, label_stale, live_writers, ...}. defer = held; the '
  'advisory lock decides and the pipeline_state.prod_session label only explains. '
  'Sibling of fec_bulk_interlock_state().';

-- Supabase default-grants EXECUTE on public functions to anon/authenticated.
-- This one reads pg_stat_activity and names the operator holding the box; it is
-- an operator instrument, not a public read.
REVOKE EXECUTE ON FUNCTION public.prod_session_state() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prod_session_state() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prod_session_state() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.prod_session_state() TO service_role;
GRANT  EXECUTE ON FUNCTION public.prod_session_state() TO postgres;
