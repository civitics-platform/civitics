-- FIX-1213 — prod_session_state() honours a claimant GUC: a guarded procedure
-- CALLed from the claimant's own session RUNS instead of deferring.
--
-- THE DEFECT (FIX-1213, cc-146 §4). `defer = held`, and `held` is whether ANY
-- backend holds the prod_supervised_session advisory lock. It never asks which
-- backend. So the FIX-950 recipe for a supervised run — claim, then CALL the
-- guarded procedure — deferred the claimant's own CALL. Measured on local
-- 2026-09-23: the lock held, then a CALL of
-- refresh_donor_party_rollup_incremental() from the SAME backend logged
-- `skipped`, skip_reason 'prod session held: (no label)'. A pid match would not
-- fix it: the lock lives on a PRIVATE pg.Client inside acquireNamedSessionLock()
-- (packages/data/src/lib/session-lock.ts), and the CALL runs on its own
-- connection. What the CALL's backend CAN carry is a session GUC.
--
-- THE CHANGE (Craig's decision 2026-09-23 ~02:45 UTC). A session-level custom
-- GUC, `civitics.prod_session_claimant`, set on the CALL's connection:
--
--   defer            = held AND the GUC is unset/empty      (was: held)
--   held             = UNCHANGED — the lock, bare. The claim preflight
--                      (prod-session.ts classifyPreflight) reads `held`, so a
--                      second claim is still REFUSED from a backend with the
--                      GUC set. The opt-in bypasses the DEFER, never the claim.
--   claimant         = the GUC value, or null            (new key)
--   claimant_bypass  = held AND the GUC is set           (new key)
--   reason_text      = 'prod session held by this claimant: <value>' when
--                      bypassing (new branch, first). That is the skip
--                      vocabulary Craig asked for: the string a guard would have
--                      written, so a bypassed defer is visible to whoever reads
--                      the reader. Every other branch is unchanged.
--
-- Nothing else moves. The twenty guards' predicate
--   IF (public.prod_session_state()->>'defer')::boolean THEN
-- is untouched; they get the new behaviour through this one reader (FIX-950 D2:
-- one reader, one vocabulary). No later migration redefines this function.
--
-- WHO CAN SET IT — AN OPERATOR AFFORDANCE, NOT A SECURITY BOUNDARY. Any role can
-- SET a custom `civitics.*` placeholder GUC in its own session. That is fine:
-- EXECUTE on every guarded procedure is {postgres, service_role} only, and only
-- `postgres` opens direct-pg sessions (service_role reaches Postgres through
-- PostgREST, which cannot CALL a procedure). The same role that could set the
-- GUC can already run an UNCLAIMED CALL, which is strictly worse — it collides
-- with every other guarded job instead of holding them. The GUC gives that role
-- nothing it did not have; it makes the supervised path possible.
--
-- WHO KEEPS DEFERRING. Every backend that did not set the GUC: every pg_cron
-- firing (a fresh bgworker session), the nightly (pipelines/index.ts reads
-- `defer === true` on its OWN connection and never sets it), a second operator.
--
-- ── THE OPERATOR RECIPE ────────────────────────────────────────────────────
-- 1. Claim: `pnpm --filter @civitics/data session:claim-prod` (or
--    withProdSession() in code). The claim's `reason` is the value to use.
-- 2. On the connection that will CALL, as its OWN statement:
--        SET civitics.prod_session_claimant = '<the claim reason>';
--    then, as a separate statement:
--        CALL public.<guarded procedure>();
--    `node scripts/db-query.mjs --prod --call --yes-i-mean-prod --claimant
--    "<reason>" "CALL …"` emits exactly this.
--    NOT in one multi-statement string: a multi-statement simple query is an
--    implicit transaction block, and a procedure that COMMITs dies at its first
--    COMMIT with `invalid transaction termination` (FIX-1128, measured cc-125).
--    The SET must also be in FRONT of the CALL (rule 109): the guard reads it
--    when the procedure starts.
-- 3. Read `SELECT public.prod_session_state()` on that connection first if in
--    doubt: `defer=false, claimant_bypass=true` means the CALL will run.
--
-- The SET search_path clause is restated (rule 34); this body is the prod body
-- (pg_get_functiondef, 2026-09-23 04:13 UTC — byte-identical to
-- 20260911000000) plus the lines marked FIX-1213. Cross-refs: FIX-950, FIX-1212,
-- FIX-1128, FIX-1215 (the unattended runner that uses it).

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
  -- FIX-1213 — the claimant's opt-in. NULLIF: a SET then RESET reads '' not NULL.
  v_claimant  text;
BEGIN
  v_key := hashtext(c_lock_name)::bigint;
  v_claimant := NULLIF(current_setting('civitics.prod_session_claimant', true), '');

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
    -- FIX-1213 — …except on the claimant's own backend, which opts in with
    -- SET civitics.prod_session_claimant. `held` above stays the bare lock.
    'defer',            v_held AND v_claimant IS NULL,
    'claimant',         v_claimant,
    'claimant_bypass',  v_held AND v_claimant IS NOT NULL,
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
                          -- FIX-1213 — first, so a bypassed defer says so.
                          WHEN v_held AND v_claimant IS NOT NULL
                            THEN 'prod session held by this claimant: ' || v_claimant
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
  'FIX-950 / FIX-1213 — is a supervised prod session holding the box? {held, defer, '
  'claimant, claimant_bypass, reason, claimed_by, age_seconds, label_stale, '
  'live_writers, ...}. defer = held AND civitics.prod_session_claimant unset: the '
  'claimant''s own backend opts in with SET civitics.prod_session_claimant and its '
  'guarded CALL runs; every other backend defers. held is the bare lock. The '
  'advisory lock decides and the pipeline_state.prod_session label only explains. '
  'Sibling of fec_bulk_interlock_state().';

-- Restated (rule 34): an operator instrument, not a public read.
REVOKE EXECUTE ON FUNCTION public.prod_session_state() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prod_session_state() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prod_session_state() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.prod_session_state() TO service_role;
GRANT  EXECUTE ON FUNCTION public.prod_session_state() TO postgres;
