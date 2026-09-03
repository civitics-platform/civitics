-- ============================================================================
-- FIX-983 — the FR watermark HEAD-LAG HORIZON
--
-- `financial_relationships.updated_at` is stamped by a BEFORE trigger with
-- NOW() = transaction START. Every incremental rollup reads a watermark w,
-- takes its dirty set as `updated_at > w`, and advances w to
-- MAX(fr.updated_at) (or now()). A writer whose transaction STARTED before that
-- read and COMMITTED after it leaves rows stamped BELOW the new watermark that
-- were invisible at read time — so no run ever sees them. The loss is permanent
-- and silent. Measured exposure: the dominant FR writer runs 631 calls, mean
-- 4.1 s, max 19.5 s; FIX-933-class manual scripts held ~12 min in one
-- transaction.
--
-- THE FIX IS A HEAD LAG, NOT A TAIL RE-RECOMPUTE. No watermark, slice_end,
-- target or cycle target_at may advance past
--
--     horizon = clock_timestamp() - civitics.watermark_lag_seconds (default 1 h)
--
-- Rows younger than the lag are simply not read yet; by the time they are older
-- than it, every transaction that stamped them has committed. Zero recompute.
-- The only cost is L of extra staleness against 12 h–7 d cadences and a crawl
-- philosophy that already accepts days.
--
-- REJECTED: `dirty = updated_at > w - 1h` (FIX-983 bullet option (a)). For the
-- */15 ec-crawl and */30 fe-crawl grinding a weeks-deep backlog that re-does an
-- hour of rows on EVERY slice. The head lag costs nothing per slice.
-- NOT TOUCHED: the trigger `set_updated_at()` (clock_timestamp() there is
-- necessary-not-sufficient — the commit still lands later — and it changes
-- semantics for every reader), and no xid/commit-timestamp machinery
-- (track_commit_timestamp is off).
--
-- THE INVARIANT, applied at every site in the census below:
--   (a) any value that becomes a watermark / slice_end / target / cycle
--       target_at is LEAST(<what it is today>, fr_watermark_horizon());
--   (b) every dirty-set predicate that today reads only `updated_at > w` gains
--       `AND updated_at <= <that clamped value>` — index-friendly on both
--       financial_relationships_updated_at and the partial
--       financial_relationships_donor_rollup_dirty_idx;
--   (c) if the clamped target is <= w the routine no-ops CLEANLY and does NOT
--       move the watermark backwards (the first minutes after a write burst, or
--       after L is raised).
--
-- CENSUS (live prod pg_proc, 2026-09-03; md5 of every body below matched its
-- latest migration text exactly — zero drift). 13 clamp sites:
--
--   routine                                       read site            write site
--   refresh_fe_totals_slice                       v_target             slice_end -> watermark
--   refresh_donor_party_rollup_slice              v_target             slice_end -> watermark
--   refresh_donor_party_rollup_incremental        v_target (mode gate) full path -> watermark
--   refresh_donor_party_rollup_mv                 v_new_max            watermark
--   refresh_official_donor_rollup_incremental     v_new_max            sweep_target + watermark
--   refresh_official_donor_rollup_mv              v_new_max            watermark
--   refresh_financial_entity_totals_incremental   v_new_max            watermark        (PAUSED, jobid 13)
--   donor_rollup_rebuild_bulk                     v_sweep_tgt          sweep_target + watermark (manual)
--   rebuild_entity_connections_donations          v_new_max_updated_at watermark        (break-glass)
--   rebuild_entity_connections_donations_full     -                    NOW() -> watermark
--   rebuild_ec_donations_incr_prepare             v_target             cycle target_at  (FIX-1069)
--   rebuild_ec_donations_full_prepare             -                    NOW() -> watermark
--   run_fe_totals_crawl                           max(updated_at)      bootstrap watermark seed
--
-- The last two were NOT in the staged census and are added here: both write a
-- watermark derived from NOW()/max(updated_at) on a bootstrap/full path.
--
-- DELIBERATELY NOT CLAMPED, so this is a decision and not an omission:
--   get_ec_crawl_health          — applies the watermark to a COUNT only; it is
--                                  a metric, and a metric should report the
--                                  whole backlog including the head.
--   rebuild_ec_donations_incr_window / _incr_close
--                                — consume p_target, already clamped by
--                                  _incr_prepare; the window aggregation is
--                                  deliberately NOT filtered by updated_at.
--   run_entity_connections_rebuild — delegates; owns no watermark of its own.
--   check_rollup_freshness       — freshness metric.
--   reconcile_* sweeps           — anti-joins on existence, no updated_at
--                                  predicate (they cover the FIX-705 hard-delete
--                                  blind spot, a different leak).
--   promote_candidate_to_elected — an FR WRITER; "watermark" appears only in a
--                                  comment.
--   refresh_sector_affinity_from_tag_changes, run_rule_taggers
--                                — content md5 / string signatures, not
--                                  time predicates.
--   refresh_treemap_individuals_global — integer chunk cursor.
--   rebuild_entity_connections_votes / _votes_full
--                                — the SAME defect on votes.updated_at. Filed
--                                  separately; not fixed here.
--
-- Every routine below is recreated from its LIVE prod body with only the edits
-- described in its own comment, and re-REVOKEs anon/authenticated EXECUTE in
-- this same file.
--
-- Fixes: FIX-983
-- ============================================================================

BEGIN;

-- ── The one helper, the one knob ────────────────────────────────────────────
-- clock_timestamp(), NOT now(): several callers COMMIT in a loop, and now()
-- would be the CURRENT chunk's transaction start — acceptable, but needlessly
-- early, which is exactly the class of mistake this fix exists to remove
-- (cf. FIX-972, FIX-981).
--
-- VOLATILE because it reads the clock: it must be re-evaluated per call and
-- must never be folded into a plan-time constant or pushed into an index
-- condition on the wrong side of a per-chunk COMMIT.
--
-- The knob is `civitics.watermark_lag_seconds` (default 3600). It is the
-- sibling of `civitics.derived_mvs_budget_seconds`: a session/role-settable
-- GUC with an in-body default, no config table, no migration needed to change
-- it for one session. Raise it when a landing is known to hold long
-- transactions; see the FIX-1074 convention paragraph beside the FIX-943
-- vacuum rule in the root CLAUDE.md.
CREATE OR REPLACE FUNCTION public.fr_watermark_horizon()
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT clock_timestamp() - make_interval(secs => COALESCE(
           NULLIF(current_setting('civitics.watermark_lag_seconds', true), '')::int,
           3600));
$fn$;

REVOKE ALL ON FUNCTION public.fr_watermark_horizon() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fr_watermark_horizon() TO service_role;

COMMENT ON FUNCTION public.fr_watermark_horizon() IS
  'FIX-983 — the head-lag horizon for every financial_relationships.updated_at '
  'watermark. Returns clock_timestamp() - civitics.watermark_lag_seconds '
  '(default 3600). NO watermark, slice_end, sweep target or cycle target_at may '
  'advance past it, and every dirty-set predicate is bounded above by the same '
  'clamped value. Rationale: updated_at is stamped by a BEFORE trigger with '
  'NOW() = transaction START, so a writer that starts before a watermark read '
  'and commits after it leaves rows stamped BELOW the new watermark that no run '
  'will ever see. Waiting L before reading the head closes that hole with zero '
  'recompute. VOLATILE deliberately: callers COMMIT in loops and must re-read '
  'the clock. Raise the GUC (session or role) for a landing known to hold long '
  'transactions.';


-- ── 1/13 · refresh_fe_totals_slice() — the fe-crawl slice (jobid 46, */30) ───
-- ONE edit: v_target is clamped to the horizon. Everything downstream already
-- rides it — slice_end is picked from `updated_at > v_w AND <= v_target`, both
-- dirty sets are bounded by slice_end, and the existing
-- `v_target IS NULL OR v_target <= v_w` branch IS invariant (c): a clamped
-- target that has not yet cleared the watermark returns caught_up and writes
-- nothing.

CREATE OR REPLACE FUNCTION public.refresh_fe_totals_slice()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_cfg       jsonb;
  v_slice_rows int;
  v_chunk     int;
  v_w         timestamptz;
  v_target    timestamptz;
  v_slice_end timestamptz;
  v_from      uuid[];
  v_to        uuid[];
  v_n_from    int;
  v_n_to      int;
  v_i         int;
  v_ids       uuid[];
  v_rows      bigint := 0;
  v_rc        bigint := 0;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'fe_crawl';
  v_cfg        := COALESCE(v_cfg, '{}'::jsonb);
  v_slice_rows := GREATEST(COALESCE((v_cfg->>'slice_rows')::int, 50000), 1000);
  v_chunk      := GREATEST(COALESCE((v_cfg->>'chunk_ids')::int, 500), 50);

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_w
    FROM public.pipeline_state WHERE key = 'financial_entity_totals_watermark';

  IF v_w IS NULL THEN
    -- A NULL watermark is the bootstrap case and CANNOT be served by slices:
    -- the incremental path only touches entities present in its dirty set, so
    -- it can never zero an entity whose last FR row vanished. The caller drives
    -- the 16-window bootstrap instead. Defined behaviour, not an accident.
    RETURN jsonb_build_object('bootstrap_required', true);
  END IF;

  -- O(1) via financial_relationships_updated_at, backward.
  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  -- FIX-983 — the head-lag horizon. Rows stamped inside the last
  -- civitics.watermark_lag_seconds may still belong to a transaction that has
  -- not committed, so they are not read yet. LEAST ignores NULLs, so an empty
  -- table yields the horizon and falls through to the caught_up return below on
  -- a NULL slice_end — same outcome, one fewer branch.
  v_target := LEAST(v_target, public.fr_watermark_horizon());

  IF v_target IS NULL OR v_target <= v_w THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w, 'fr_rows', 0,
                              'donors', 0, 'recipients', 0, 'rows_written', 0);
  END IF;

  -- ── the bound, established BEFORE any work ───────────────────────────────
  -- An index scan of exactly v_slice_rows entries. If a single timestamp is
  -- shared by more rows than that, slice_end lands on it and the slice is larger
  -- than nominal — but it is still strictly greater than the watermark, so the
  -- crawl can never fail to advance. That is the property that matters.
  SELECT max(s.updated_at) INTO v_slice_end
    FROM (SELECT fr.updated_at
            FROM public.financial_relationships fr
           WHERE fr.updated_at > v_w
             AND fr.updated_at <= v_target
           ORDER BY fr.updated_at
           LIMIT v_slice_rows) s;

  IF v_slice_end IS NULL THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w, 'fr_rows', 0,
                              'donors', 0, 'recipients', 0, 'rows_written', 0);
  END IF;

  -- ── the dirty sets, scoped to this slice AND to donations ────────────────
  -- Same predicates as refresh_financial_entity_totals_incremental(); only the
  -- upper time bound is new. This is a pacing change, not a semantics change.
  SELECT array_agg(DISTINCT fr.from_id) INTO v_from
    FROM public.financial_relationships fr
   WHERE fr.relationship_type = 'donation'
     AND fr.from_type = 'financial_entity'
     AND fr.updated_at >  v_w
     AND fr.updated_at <= v_slice_end;

  SELECT array_agg(DISTINCT fr.to_id) INTO v_to
    FROM public.financial_relationships fr
   WHERE fr.relationship_type = 'donation'
     AND fr.to_type = 'financial_entity'
     AND fr.updated_at >  v_w
     AND fr.updated_at <= v_slice_end;

  v_n_from := COALESCE(array_length(v_from, 1), 0);
  v_n_to   := COALESCE(array_length(v_to, 1), 0);

  v_i := 1;
  WHILE v_i <= v_n_from LOOP
    v_ids  := v_from[v_i : LEAST(v_i + v_chunk - 1, v_n_from)];
    v_rows := v_rows + public.financial_entity_donation_totals_rebuild(v_ids);
    v_rc   := v_rc   + public.financial_entity_recipient_count_rebuild(v_ids);
    v_i    := v_i + v_chunk;
  END LOOP;

  v_i := 1;
  WHILE v_i <= v_n_to LOOP
    v_ids  := v_to[v_i : LEAST(v_i + v_chunk - 1, v_n_to)];
    v_rows := v_rows + public.financial_entity_received_totals_rebuild(v_ids);
    v_i    := v_i + v_chunk;
  END LOOP;

  -- ── the watermark, in this same transaction ──────────────────────────────
  -- No COMMIT above and none here. Either every row this slice wrote AND this
  -- advance are durable, or neither is. FIX-1112's rule, enforced by the
  -- language: this is a FUNCTION, so it cannot COMMIT even if a future edit
  -- wanted it to.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('financial_entity_totals_watermark',
          jsonb_build_object('last_indexed_at', v_slice_end::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  RETURN jsonb_build_object(
    'caught_up',    v_slice_end >= v_target,
    'watermark',    v_slice_end,
    'from',         v_w,
    'donors',       v_n_from,
    'recipients',   v_n_to,
    'rows_written', v_rows + v_rc,
    'totals_rows',  v_rows,
    'rc_rows',      v_rc);
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_fe_totals_slice() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_fe_totals_slice() TO service_role;


-- ── 2/13 · refresh_donor_party_rollup_slice() — the donor-party crawl unit ───
-- Same one-line edit and the same reasoning as 1/13.

CREATE OR REPLACE FUNCTION public.refresh_donor_party_rollup_slice()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
 SET work_mem TO '256MB'
AS $function$
DECLARE
  v_cfg        jsonb;
  v_slice_rows int;
  v_chunk      int;
  v_w          timestamptz;
  v_target     timestamptz;
  v_slice_end  timestamptz;
  v_dirty      uuid[];
  v_n          int;
  v_i          int;
  v_ids        uuid[];
  v_rows       bigint := 0;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  v_cfg        := COALESCE(v_cfg, '{}'::jsonb);
  v_slice_rows := GREATEST(COALESCE((v_cfg->>'slice_rows')::int, 50000), 1000);
  v_chunk      := GREATEST(COALESCE((v_cfg->>'chunk_ids')::int,  5000),  100);

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_w
    FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  IF v_w IS NULL THEN
    -- A NULL watermark is the bootstrap case and cannot be served by slices:
    -- the incremental path only touches donors present in its dirty set, so it
    -- can never DELETE a rollup row whose last qualifying FR vanished. The
    -- caller drives the staged full rebuild instead. Defined behaviour.
    RETURN jsonb_build_object('bootstrap_required', true);
  END IF;

  -- O(1) via financial_relationships_updated_at, backward.
  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  -- FIX-983 — the head-lag horizon (see fr_watermark_horizon()). slice_end is
  -- chosen from `updated_at > v_w AND <= v_target` and the dirty set from
  -- `> v_w AND <= slice_end`, so clamping v_target bounds both.
  v_target := LEAST(v_target, public.fr_watermark_horizon());

  IF v_target IS NULL OR v_target <= v_w THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w,
                              'donors', 0, 'rows_written', 0);
  END IF;

  -- ── the bound, established BEFORE any work ───────────────────────────────
  -- An index scan of exactly v_slice_rows entries. If a single timestamp is
  -- shared by more rows than that, slice_end lands on it and the slice is
  -- larger than nominal — but it is still strictly greater than the watermark,
  -- so the crawl can never fail to advance. That is the property that matters.
  SELECT max(s.updated_at) INTO v_slice_end
    FROM (SELECT fr.updated_at
            FROM public.financial_relationships fr
           WHERE fr.updated_at >  v_w
             AND fr.updated_at <= v_target
           ORDER BY fr.updated_at
           LIMIT v_slice_rows) s;

  IF v_slice_end IS NULL THEN
    RETURN jsonb_build_object('caught_up', true, 'watermark', v_w,
                              'donors', 0, 'rows_written', 0);
  END IF;

  -- ── the dirty set, scoped to this slice ──────────────────────────────────
  -- Byte-for-byte the predicates refresh_donor_party_rollup_incremental() has
  -- always used; only the upper time bound is new. This is a pacing change,
  -- not a semantics change.
  SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty
    FROM public.financial_relationships fr
   WHERE fr.relationship_type = 'donation'
     AND fr.from_type = 'financial_entity'
     AND fr.to_type   = 'official'
     AND fr.updated_at >  v_w
     AND fr.updated_at <= v_slice_end;

  v_n := COALESCE(array_length(v_dirty, 1), 0);
  v_i := 1;
  WHILE v_i <= v_n LOOP
    v_ids  := v_dirty[v_i : LEAST(v_i + v_chunk - 1, v_n)];
    v_rows := v_rows + public.donor_party_rollup_rebuild_donors(v_ids);
    v_i    := v_i + v_chunk;
  END LOOP;

  -- ── the watermark, in this same transaction ──────────────────────────────
  -- No COMMIT above and none here. Either every row this slice wrote AND this
  -- advance are durable, or neither is. FIX-1112's rule, enforced by the
  -- language: this is a FUNCTION, so it cannot COMMIT even if a future edit
  -- wanted it to.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_party_rollup_watermark',
          jsonb_build_object('last_indexed_at', v_slice_end::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = clock_timestamp();

  RETURN jsonb_build_object(
    'caught_up',    v_slice_end >= v_target,
    'watermark',    v_slice_end,
    'from',         v_w,
    'donors',       v_n,
    'rows_written', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_donor_party_rollup_slice() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_donor_party_rollup_slice() TO service_role;


-- ── 3/13 · refresh_donor_party_rollup_incremental() — jobid 17 driver ────────
-- TWO edits. (i) v_target — the O(1) mode gate — is clamped, which bounds both
-- the bootstrap/full path's watermark write and the lag that chooses the mode.
-- (ii) its NULL fallback becomes the horizon rather than clock_timestamp().
-- The full path scans EVERY donor with no updated_at predicate and then jumps
-- the watermark to v_target; clamping v_target means the next crawl re-checks
-- the last hour. That is the point, not a cost.
-- Invariant (c) needs no new branch here: a clamped target at or below the
-- watermark yields mode 'crawl', and refresh_donor_party_rollup_slice() returns
-- caught_up.

CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('donor_party_rollup_refresh')::bigint;
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_cfg        jsonb;
  v_budget     interval;
  v_max_units  int;
  v_full_lag   interval;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_target     timestamptz;
  v_lag        interval;
  v_mode       text;
  v_i          int;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint := 0;
  v_n          bigint;
  v_units      int     := 0;
  v_donors     bigint  := 0;
  v_capped     boolean := false;
  v_caught_up  boolean := false;
  v_failures   text[]  := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text    := NULL;
  -- FIX-979 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
  v_res        jsonb;
  i            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-party-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-party-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Plain SET (not SET LOCAL) survives the per-unit COMMITs. NOTE (FIX-703):
  -- the CALL's statement_timeout is the postgres role default (6h) armed at
  -- CALL start — nothing in this body can change it. The budget guard below and
  -- the FIX-1063 watchdog are the real stops.
  SET work_mem = '256MB';

  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  v_cfg       := COALESCE(v_cfg, '{}'::jsonb);
  v_budget    := make_interval(secs => GREATEST(
                   COALESCE((v_cfg->>'unit_budget_seconds')::numeric, 1500), 60));
  v_max_units := GREATEST(COALESCE((v_cfg->>'max_units')::int, 40), 1);
  v_full_lag  := make_interval(days => GREATEST(
                   COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));

  -- ── the mode decision, O(1) ──────────────────────────────────────────────
  -- Two index probes and a subtraction. The old body materialised
  -- array_agg(DISTINCT from_id) over the whole backlog — 3.3M uuids on
  -- 2026-09-02 — purely to compare its length against a threshold, then
  -- discarded it. That array build IS the 1,814 s that the watchdog killed on
  -- 2026-09-01. It is gone.
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  -- FIX-983 — the head-lag horizon. Bounds the lag that picks the mode AND the
  -- watermark the full path writes below.
  v_target := LEAST(v_target, public.fr_watermark_horizon());

  v_lag  := CASE WHEN v_watermark IS NULL OR v_target IS NULL
                 THEN NULL ELSE v_target - v_watermark END;
  v_mode := CASE
              WHEN v_watermark IS NULL     THEN 'bootstrap'
              WHEN v_lag > v_full_lag      THEN 'full'
              ELSE                              'crawl'
            END;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_refresh', 'running', v_started,
          jsonb_build_object('mode', v_mode, 'source', 'pg_cron',
                             'watermark_before', v_watermark,
                             'lag', v_lag::text,
                             'full_rebuild_lag', v_full_lag::text,
                             'max_units', v_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_mode IN ('bootstrap', 'full') THEN
    -- ═══ Staged full rebuild ═══════════════════════════════════════════════
    -- ONE set-based scan (the FIX-734 lesson) into a session temp stage, then
    -- 16 donor-id-windowed DELETE+INSERT applies with per-window COMMIT
    -- (FIX-703 bounded-txn discipline). Readers keep prior rows per un-applied
    -- window (complete-if-stale, never missing).
    --
    -- Cost is independent of the lag: ~350-420 s on prod regardless of how far
    -- behind the watermark is. That is why it is the right answer once the lag
    -- is large, and why a cancelled full rebuild does not ratchet — the next
    -- firing redoes the same ~350 s, not a bigger one.
    BEGIN
      DROP TABLE IF EXISTS dpr_stage;
      CREATE TEMP TABLE dpr_stage AS
      WITH agg AS MATERIALIZED (
        SELECT
          fr.from_id                          AS donor_id,
          COALESCE(o.party::text, 'unknown')  AS party_key,
          SUM(fr.amount_cents)::bigint        AS total_cents,
          COUNT(*)::bigint                    AS tx_count
        FROM public.financial_relationships fr
        JOIN public.officials o
          ON o.id = fr.to_id AND fr.to_type = 'official'
        WHERE fr.relationship_type = 'donation'
          AND fr.from_type = 'financial_entity'
        GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
      ),
      ind AS (
        SELECT DISTINCT ON (et.entity_id)
          et.entity_id,
          et.tag           AS industry_tag,
          et.display_label AS industry_label
        FROM public.entity_tags et
        WHERE et.entity_type  = 'financial_entity'
          AND et.tag_category = 'industry'
        ORDER BY et.entity_id, et.tag
      )
      SELECT
        a.donor_id, a.party_key, fe.display_name AS donor_name,
        fe.entity_type, ind.industry_tag, ind.industry_label,
        a.total_cents, a.tx_count
      FROM agg a
      LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id
      LEFT JOIN ind                          ON ind.entity_id = a.donor_id;

      CREATE INDEX dpr_stage_idx ON dpr_stage (donor_id);
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('stage build: %s', SQLERRM);
      RAISE WARNING '[donor-party-rollup] stage build CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('stage build: %s', SQLERRM);
      RAISE WARNING '[donor-party-rollup] stage build FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level (temp table persists across COMMIT for the session)

    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
        BEGIN
          DELETE FROM public.donor_party_rollup_mv
           WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
          INSERT INTO public.donor_party_rollup_mv (
            donor_id, party_key, donor_name, entity_type, industry_tag,
            industry_label, total_cents, tx_count
          )
          SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
                 industry_label, total_cents, tx_count
          FROM dpr_stage
          WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_rows := v_rows + v_n;
          RAISE NOTICE '  [donor-party-rollup] window %/16 — % rows', i, v_n;
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('window %s: %s', i, SQLERRM);
          RAISE WARNING '  [donor-party-rollup] window %/16 CANCELED: %', i, SQLERRM;
        WHEN OTHERS THEN
          v_failures := v_failures || format('window %s: %s', i, SQLERRM);
          RAISE WARNING '  [donor-party-rollup] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;  -- top level, outside the EXCEPTION subtransaction
        -- FIX-1028 — the box has just proven it cannot finish one window; the
        -- remaining ones would each re-arm the same axe.
        EXIT WHEN v_canceled IS NOT NULL;
      END LOOP;
      v_units := 1;
    END IF;

    DROP TABLE IF EXISTS dpr_stage;
    COMMIT;

    -- The full rebuild recomputed EVERY donor, so on a clean finish the
    -- watermark can jump straight to the target captured before it started.
    -- FR writes that landed during the rebuild are strictly after v_target and
    -- are re-processed by the next firing's crawl, never silently consumed.
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_party_rollup_watermark',
              jsonb_build_object('last_indexed_at',
                COALESCE(v_target, public.fr_watermark_horizon())::text))   -- FIX-983
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = clock_timestamp();
      v_caught_up := true;
      COMMIT;
    END IF;

  ELSE
    -- ═══ CRAWL PATH — the normal one ═══════════════════════════════════════
    WHILE v_units < v_max_units LOOP
      IF clock_timestamp() - v_started >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] BUDGET EXHAUSTED before slice %; stopping cleanly', v_units + 1;
        EXIT;
      END IF;

      v_res := NULL;
      BEGIN
        v_res    := public.refresh_donor_party_rollup_slice();
        v_rows   := v_rows   + COALESCE((v_res->>'rows_written')::bigint, 0);
        v_donors := v_donors + COALESCE((v_res->>'donors')::bigint, 0);
      EXCEPTION
      -- FIX-1028 — by name. The slice is atomic, so a cancel here has already
      -- rolled back BOTH its rows and its watermark advance. Nothing is
      -- stranded and nothing is skipped; the next firing retries the same
      -- slice. That is the whole point of FIX-1112.
      WHEN query_canceled THEN
        v_canceled := format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % CANCELED (rolled back whole — watermark unmoved): %',
          v_units + 1, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % FAILED: %', v_units + 1, SQLERRM;
      END;
      COMMIT;

      IF v_res IS NOT NULL AND COALESCE((v_res->>'bootstrap_required')::boolean, false) THEN
        RAISE WARNING '  [donor-party-rollup] watermark vanished mid-run — bootstrap required; stopping';
        EXIT;
      END IF;

      EXIT WHEN v_canceled IS NOT NULL;
      EXIT WHEN COALESCE(array_length(v_failures, 1), 0) > 0;

      v_units := v_units + 1;

      IF v_res IS NOT NULL THEN
        RAISE NOTICE '  [donor-party-rollup] slice -> % — % donors, % rows',
          v_res->>'watermark', v_res->>'donors', v_res->>'rows_written';
        IF COALESCE((v_res->>'caught_up')::boolean, false) THEN
          v_caught_up := true;
          RAISE NOTICE '  [donor-party-rollup] CAUGHT UP — watermark is at the newest FR write';
          EXIT;
        END IF;
      END IF;
    END LOOP;

    IF v_units >= v_max_units AND NOT v_caught_up AND v_canceled IS NULL
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      v_capped := true;
    END IF;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        WHEN v_capped                        THEN 'partial'
                        ELSE 'complete'
                      END,
      -- FIX-979/981: clock_timestamp(), not now() — this transaction began
      -- after the last unit's COMMIT.
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; every COMMITTED slice kept its watermark, the next firing resumes from it', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_capped
                          THEN left(format('%s — %s unit(s) run, resumable',
                                 CASE WHEN v_units >= v_max_units THEN 'unit cap reached'
                                      ELSE 'wall-clock budget reached' END, v_units), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode',            v_mode,
                        'units_run',       v_units,
                        'unit_capped',     v_capped,
                        'caught_up',       v_caught_up,
                        'dirty_donors',    v_donors,
                        'rollup_rows',     v_rows,
                        'failures',        COALESCE(array_length(v_failures, 1), 0),
                        'canceled',        v_canceled IS NOT NULL,
                        'cancel_detail',   v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- Where the next firing picks up. On the old code this
                        -- was always the same value as watermark_before, which
                        -- is what the ratchet looked like in the log.
                        'next_slice_from', (SELECT value->>'last_indexed_at'
                                              FROM public.pipeline_state
                                             WHERE key = 'donor_party_rollup_watermark'))
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-party-rollup] % (mode=%) — % unit(s), % donors, % rows, watermark now %',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'FAILED'
         WHEN v_caught_up THEN 'CAUGHT UP'
         WHEN v_capped THEN 'UNIT CAP' ELSE 'complete' END,
    v_mode, v_units, v_donors, v_rows,
    (SELECT value->>'last_indexed_at' FROM public.pipeline_state
      WHERE key = 'donor_party_rollup_watermark');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_donor_party_rollup_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_donor_party_rollup_incremental() TO service_role;


-- ── 4/13 · refresh_donor_party_rollup_mv() — manual / seed path ──────────────
-- A max-capture routine: clamp the capture, bound the dirty set by it, and
-- add the invariant-(c) caught-up return so a clamped target at or below the
-- watermark can never write the watermark BACKWARDS.

CREATE OR REPLACE FUNCTION public.refresh_donor_party_rollup_mv()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_watermark timestamptz;
  v_new_max   timestamptz;
  v_horizon   timestamptz;   -- FIX-983
  v_dirty     uuid[];
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  IF v_watermark IS NULL THEN
    RAISE WARNING 'refresh_donor_party_rollup_mv: no donor_party_rollup_watermark — '
      'run CALL public.refresh_donor_party_rollup_incremental() (staged bootstrap) instead';
    RETURN;
  END IF;

  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  -- FIX-983 — the head-lag horizon.
  v_horizon := public.fr_watermark_horizon();
  v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);

  -- Invariant (c): nothing is old enough to read yet. Returning here is what
  -- keeps the watermark from moving BACKWARDS in the first minutes after a
  -- write burst, or after the lag GUC is raised.
  IF v_new_max <= v_watermark THEN
    RAISE NOTICE 'refresh_donor_party_rollup_mv: caught up — horizon % is at or '
      'before the watermark %; nothing read, watermark unmoved', v_new_max, v_watermark;
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation'
    AND fr.from_type = 'financial_entity'
    AND fr.to_type   = 'official'
    AND fr.updated_at >  v_watermark
    AND fr.updated_at <= v_new_max;   -- FIX-983

  IF COALESCE(array_length(v_dirty, 1), 0) > 0 THEN
    PERFORM public.donor_party_rollup_rebuild_donors(v_dirty);
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_party_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_new_max, v_horizon)::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_donor_party_rollup_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_donor_party_rollup_mv() TO service_role;


-- ── 5/13 · refresh_official_donor_rollup_mv() — manual / seed path ───────────
-- Same shape as 4/13.

CREATE OR REPLACE FUNCTION public.refresh_official_donor_rollup_mv()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_watermark timestamptz;
  v_new_max   timestamptz;
  v_horizon   timestamptz;   -- FIX-983
  v_dirty     uuid[];
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

  IF v_watermark IS NULL THEN
    -- Bootstrap belongs to the chunked procedure — an all-recipients rebuild in
    -- one transaction through PostgREST is exactly the shape FIX-704 removes.
    RAISE WARNING 'refresh_official_donor_rollup_mv: no donor_rollup_watermark — '
      'run CALL public.refresh_official_donor_rollup_incremental() (chunked bootstrap) instead';
    RETURN;
  END IF;

  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

  -- FIX-983 — the head-lag horizon.
  v_horizon := public.fr_watermark_horizon();
  v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);

  -- Invariant (c): nothing old enough to read yet — no-op, watermark unmoved.
  IF v_new_max <= v_watermark THEN
    RAISE NOTICE 'refresh_official_donor_rollup_mv: caught up — horizon % is at '
      'or before the watermark %; nothing read, watermark unmoved', v_new_max, v_watermark;
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND fr.from_type = 'financial_entity'
    AND fr.to_type = 'official'                                       -- FIX-1018
    AND fr.updated_at >  v_watermark
    AND fr.updated_at <= v_new_max;                                   -- FIX-983

  IF COALESCE(array_length(v_dirty, 1), 0) > 0 THEN
    PERFORM public.donor_rollup_rebuild_recipients(v_dirty);
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_new_max, v_horizon)::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_official_donor_rollup_mv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_official_donor_rollup_mv() TO service_role;


-- ── 6/13 · refresh_financial_entity_totals_incremental() — PAUSED (jobid 13) ─
-- Superseded by the fe-crawl (jobid 46) and parked `active = false`. It is
-- clamped anyway and stays paused: this is still a live body on prod, and a
-- future un-pause must not reintroduce the hole. Nothing here re-activates it.

CREATE OR REPLACE PROCEDURE public.refresh_financial_entity_totals_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key  bigint := hashtext('financial_entity_totals_refresh')::bigint;
  c_chunk     int    := 500;
  c_bounds    uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id    uuid;
  v_watermark timestamptz;
  v_new_max   timestamptz;
  v_horizon   timestamptz;   -- FIX-983
  v_dirty_from uuid[];
  v_dirty_to   uuid[];
  v_chunk     uuid[];
  v_n_from    int;
  v_n_to      int;
  v_i         int;
  v_lo        uuid;
  v_hi        uuid;
  v_rows      bigint := 0;
  v_rc        bigint := 0;   -- FIX-736: recipient_count rows written
  v_n         bigint;
  v_failures  text[] := ARRAY[]::text[];
  v_mode      text;
  i           int;
  v_canceled  text := NULL;                            -- FIX-1028
  v_started   timestamptz := clock_timestamp();        -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent financial-entity-totals refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[fe-totals] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
  FROM public.pipeline_state WHERE key = 'financial_entity_totals_watermark';

  -- Capture the new watermark BEFORE building the dirty set so FR writes that
  -- land mid-refresh are re-processed next run, never silently consumed.
  SELECT MAX(fr.updated_at) INTO v_new_max
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation';

  -- FIX-983 — the head-lag horizon, applied to the target BEFORE the dirty set
  -- is built (which is where this routine already captures it, for the sibling
  -- reason stated just above).
  v_horizon := public.fr_watermark_horizon();
  v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);

  v_mode := CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END;

  -- Invariant (c): the horizon has not yet cleared the watermark, so there is
  -- nothing old enough to read and advancing would move the watermark
  -- BACKWARDS. Log the skip and release the lock — same shape as the advisory-
  -- lock refusal above.
  IF v_watermark IS NOT NULL AND v_new_max <= v_watermark THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'skip_reason', format('caught up at the FIX-983 horizon — %s is at or before the watermark %s',
                                    v_new_max, v_watermark),
              'horizon', v_new_max, 'watermark', v_watermark, 'source', 'pg_cron'));
    RAISE NOTICE '[fe-totals] caught up at the horizon (% <= %) — skipping', v_new_max, v_watermark;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  IF v_watermark IS NOT NULL THEN
    SELECT array_agg(DISTINCT fr.from_id) INTO v_dirty_from
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type = 'financial_entity'
      AND fr.updated_at >  v_watermark
      AND fr.updated_at <= v_new_max;   -- FIX-983

    SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty_to
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type = 'financial_entity'
      AND fr.updated_at >  v_watermark
      AND fr.updated_at <= v_new_max;   -- FIX-983
  END IF;

  v_n_from := COALESCE(array_length(v_dirty_from, 1), 0);
  v_n_to   := COALESCE(array_length(v_dirty_to, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_refresh', 'running', v_started,
          jsonb_build_object('mode', v_mode,
                             'dirty_donors', v_n_from,
                             'dirty_recipients', v_n_to,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_watermark IS NULL THEN
    -- Bootstrap: 16-window full pass over both totals sides + recipient_count.
    FOR i IN 1..16 LOOP
      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_rows := v_rows + public.financial_entity_donation_totals_window(v_lo, v_hi);
        v_rows := v_rows + public.financial_entity_received_totals_window(v_lo, v_hi);
        v_rc   := v_rc   + public.financial_entity_recipient_count_window(v_lo, v_hi);  -- FIX-736
        RAISE NOTICE '  [fe-totals] bootstrap window %/16 — % totals rows, % rc rows so far', i, v_rows, v_rc;
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 CANCELED: %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-totals] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level (outside the EXCEPTION subtransaction)
      EXIT WHEN v_canceled IS NOT NULL;
    END LOOP;
  ELSE
    -- Incremental: chunk the dirty donor set (totals + recipient_count together),
    -- then the dirty recipient set (received totals).
    v_i := 1;
    WHILE v_i <= v_n_from LOOP
      v_chunk := v_dirty_from[v_i : LEAST(v_i + c_chunk - 1, v_n_from)];
      BEGIN
        v_n := public.financial_entity_donation_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
        v_n := public.financial_entity_recipient_count_rebuild(v_chunk);  -- FIX-736
        v_rc := v_rc + v_n;
      EXCEPTION
      WHEN query_canceled THEN                         -- FIX-1028, by name, first
        v_canceled := format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donation chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] donation chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;

    v_i := 1;
    WHILE v_i <= v_n_to AND v_canceled IS NULL LOOP
      v_chunk := v_dirty_to[v_i : LEAST(v_i + c_chunk - 1, v_n_to)];
      BEGIN
        v_n := public.financial_entity_received_totals_rebuild(v_chunk);
        v_rows := v_rows + v_n;
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% CANCELED: %', v_i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('received chunk @%s: %s', v_i, SQLERRM);
        RAISE WARNING '  [fe-totals] received chunk @% FAILED: %', v_i, SQLERRM;
      END;
      COMMIT;
      EXIT WHEN v_canceled IS NOT NULL;
      v_i := v_i + c_chunk;
    END LOOP;
  END IF;

  -- Advance the watermark only on a clean run — a failed chunk/window's keys
  -- must stay in the next run's dirty set. FIX-1028 adds the cancel arm: a
  -- cancelled run has NOT covered its dirty set, so advancing here would
  -- permanently skip every key it did not reach.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('financial_entity_totals_watermark',
            jsonb_build_object('last_indexed_at', COALESCE(v_new_max, v_horizon)::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows + v_rc,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; watermark unmoved, the whole dirty set is retried next run', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'rows_updated', v_rows,
                        'recipient_count_updated', v_rc,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals] % (mode=%) — % totals rows, % recipient_count rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_mode, v_rows, v_rc, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_financial_entity_totals_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_financial_entity_totals_incremental() TO service_role;


-- ── 7/13 · refresh_official_donor_rollup_incremental() — jobid 24 ────────────
-- The fresh-sweep capture is clamped; the RESUMING branch reads sweep_target,
-- which was already clamped when the sweep opened, so a resume needs no edit
-- (and must not get one — FIX-704's invariant is that a resumed sweep keeps its
-- original target).

CREATE OR REPLACE PROCEDURE public.refresh_official_donor_rollup_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;

  -- FIX-1002 — wall-clock budget for ONE run. See the header for the sizing:
  -- 3h between firings, pg_cron queues rather than skips, one healthy full
  -- sweep measured 2h00m43s. Overridable via civitics.donor_rollup_budget_seconds.
  c_budget     interval := interval '2 hours';

  -- What one chunk SHOULD cost. The guard can only act between chunks, so this
  -- is also the granularity of every control decision in the loop and the blast
  -- radius of a mid-chunk cancel by the outer 6h timeout. 300 s over a 2 h
  -- budget gives the guard ~24 evaluation points per run; FIX-972's regime gave
  -- it 3. Overridable via civitics.donor_rollup_chunk_target_seconds.
  c_chunk_secs int := 300;

  -- Hard caps on one chunk, so a mis-calibrated rows-per-second cannot build a
  -- monster. c_weight_max is ~450 s at the healthy measured rate of 448 rows/s.
  c_weight_max     bigint := 200000;   -- FR rows
  c_recipients_max int    := 500;      -- recipients (also the meaning of the
                                       -- pre-existing donor_rollup_chunk_size GUC)

  -- Cold-start rows-per-second, used only when pipeline_state carries no
  -- calibration. Deliberately pessimistic: prod's WORST measured incremental
  -- rate was 28.7 rows/s (08-07, un-vacuumed arms) against 448 rows/s healthy.
  -- Starting low costs one short first chunk; starting high costs an outage.
  c_rps_seed   double precision := 30.0;

  -- Weight assumed for a recipient with no official_donor_totals row yet.
  -- p90 of the live distribution (1,389), rounded up — being wrong-small here
  -- is what builds an oversized chunk, so this errs pessimistic.
  c_weight_default bigint := 1500;

  -- Latest UTC hour at which a firing may START. The 12:00 backstop exists for
  -- the case where 09:00 was starved at startup; it must not turn into a second
  -- full window chained onto an overrunning first one (measured 08-06/07/08).
  -- Overridable two ways: civitics.donor_rollup_ignore_start_window for
  -- break-glass, and civitics.donor_rollup_latest_start_hour to move the cutoff
  -- (0 refuses always, 24 never refuses). The second exists so the refusal is
  -- TESTABLE without waiting for a wall clock — a guard that can only be
  -- observed by getting unlucky is the same class of defect as the one this
  -- migration is fixing.
  c_latest_hour int := 13;

  -- FIX-1018 — fraction of the budget the PRE-LOOP dirty-set build may consume
  -- before the run refuses to enter the loop at all.
  --
  -- Sizing, one line: the healthy build is 52.8 s against a 7,200 s budget
  -- (0.7%) and should be well under that once the index below is in place, so
  -- anything past 50% is two orders of magnitude off-nominal and means the box
  -- is in the contention regime this run must not add to; below 50% there is
  -- still a full c_chunk_secs target of window left with headroom, so entering
  -- the loop is still worth it. This guard exists for the ~176x case, not the
  -- healthy one. Overridable via
  -- civitics.donor_rollup_dirty_set_budget_fraction (which is also how the
  -- refusal is exercised in test — playbook C3).
  c_dirty_frac double precision := 0.5;

  v_state      jsonb;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_new_max    timestamptz;
  v_horizon    timestamptz;   -- FIX-983
  v_cursor     uuid;
  v_resumed    boolean := false;
  v_dirty      uuid[];
  v_weights    bigint[];
  v_chunk      uuid[];
  v_n_recips   int;
  v_i          int := 1;
  v_j          int;
  v_chunk_end  int;
  v_chunk_w    bigint;
  v_target_w   bigint;
  v_fit_w      bigint;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  v_prior_fail int := 0;
  v_budget_cfg int;
  v_chunk_cfg  int;
  v_secs_cfg   int;
  v_hour_cfg   int;
  v_frac_cfg   double precision;   -- FIX-1018
  v_ignore_win boolean;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_dirty_secs double precision;   -- FIX-1018
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_stop_why   text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- Routed into the EXISTING v_budget_hit 'partial' branch below rather than a
  -- new terminal path: a cancelled sweep and a budget-stopped sweep are the same
  -- thing to a reader (resumable, cursor intact), so they get the same shape.
  v_canceled   text := NULL;
  v_blocked    uuid := NULL;
  v_elapsed    double precision;
  v_remaining  double precision;
  v_rps_seed   double precision;
  v_rps_run    double precision := NULL;
  v_rps        double precision;
  v_yield      double precision;
  v_budget_s   double precision;
BEGIN
  -- ── Start-window refusal (FIX-1002) ───────────────────────────────────────
  -- BEFORE the advisory lock, so a firing pg_cron queued behind an overrunning
  -- run exits immediately instead of waiting on a lock it would then hold for
  -- another full budget. This is the job stopping ITSELF; nothing here depends
  -- on an operator noticing (FIX-965's lesson — a cancelled long CALL wedged
  -- prod for ~7 h on 08-05, so cancellation is not a control path).
  v_ignore_win := COALESCE(
    NULLIF(current_setting('civitics.donor_rollup_ignore_start_window', true), '')::boolean,
    false);
  v_hour_cfg := NULLIF(current_setting('civitics.donor_rollup_latest_start_hour', true), '')::int;
  IF v_hour_cfg IS NOT NULL THEN
    c_latest_hour := GREATEST(0, LEAST(v_hour_cfg, 24));
  END IF;
  IF NOT v_ignore_win
     AND EXTRACT(hour FROM (clock_timestamp() AT TIME ZONE 'UTC')) >= c_latest_hour THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] start window closed (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;

  -- Session advisory lock (survives the COMMITs below). Stampede protection.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] advisory lock held — skipping';
    RETURN;
  END IF;

  -- Bounded per-chunk memory. Plain SET (not SET LOCAL) survives the per-chunk
  -- COMMITs. NOTE (FIX-703/FIX-944): the CALL's statement_timeout is the
  -- postgres role default (6h) armed at CALL start — nothing in this body can
  -- change it, which is exactly why the c_budget loop guard below exists.
  SET work_mem = '128MB';

  SELECT value INTO v_state
  FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

  v_watermark := (v_state->>'last_indexed_at')::timestamptz;
  v_cursor    := NULLIF(v_state->>'sweep_cursor', '')::uuid;

  -- FIX-1002 — cross-run calibration. The previous run's measured (pessimistic)
  -- rows-per-second sizes THIS run's first chunk, which is the one FIX-972's
  -- guard could never protect. Persisted alongside the cursor and carried
  -- across sweep completion.
  v_rps_seed := COALESCE(
    NULLIF(v_state->>'rows_per_second', '')::double precision, c_rps_seed);
  IF v_rps_seed <= 0 THEN v_rps_seed := c_rps_seed; END IF;

  -- Optional operator overrides, all SESSION GUCs rather than shared state
  -- (FIX-944 decision 6): a pipeline_state override would have to be restored
  -- afterwards, and a run that died before restoring would silently re-widen
  -- every subsequent pg_cron run. A GUC dies with the connection.
  --     SET civitics.donor_rollup_budget_seconds              = '72000';
  --     SET civitics.donor_rollup_chunk_target_seconds        = '600';
  --     SET civitics.donor_rollup_chunk_size                  = '250';
  --     SET civitics.donor_rollup_ignore_start_window         = 'on';
  --     SET civitics.donor_rollup_dirty_set_budget_fraction   = '0.5';
  v_budget_cfg := NULLIF(current_setting('civitics.donor_rollup_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_budget_cfg);
  END IF;

  v_secs_cfg := NULLIF(current_setting('civitics.donor_rollup_chunk_target_seconds', true), '')::int;
  IF COALESCE(v_secs_cfg, 0) > 0 THEN
    c_chunk_secs := LEAST(v_secs_cfg, 3600);
  END IF;

  -- Pre-existing GUC, repurposed: it now caps RECIPIENTS per chunk rather than
  -- fixing them. Clamped to [1, 5000] — 0 or negative would make the inner
  -- accumulator never advance v_i, i.e. an infinite loop holding an advisory
  -- lock (the FIX-972 hazard, preserved).
  v_chunk_cfg := NULLIF(current_setting('civitics.donor_rollup_chunk_size', true), '')::int;
  IF COALESCE(v_chunk_cfg, 0) > 0 THEN
    c_recipients_max := LEAST(v_chunk_cfg, 5000);
  END IF;

  -- FIX-1018 — clamped to (0, 1]. A value of 0 or below would make the pre-loop
  -- refusal fire on every run including healthy ones, permanently parking the
  -- sweep; above 1 it could never fire at all.
  v_frac_cfg := NULLIF(current_setting('civitics.donor_rollup_dirty_set_budget_fraction', true), '')::double precision;
  IF COALESCE(v_frac_cfg, 0) > 0 THEN
    c_dirty_frac := LEAST(v_frac_cfg, 1.0);
  END IF;

  v_budget_s   := EXTRACT(epoch FROM c_budget);
  v_prior_fail := COALESCE((v_state->>'sweep_failures')::int, 0);

  IF v_cursor IS NOT NULL AND (v_state ? 'sweep_target') THEN
    -- RESUMING an interrupted sweep. Reuse the target captured at sweep start
    -- so mid-sweep FR writes stay for the NEXT sweep (FIX-704 invariant).
    v_resumed := true;
    v_new_max := (v_state->>'sweep_target')::timestamptz;
  ELSE
    -- Capture the new watermark BEFORE building the dirty set so FR writes that
    -- land mid-refresh are re-processed by the next run, never silently consumed.
    v_cursor     := NULL;
    v_prior_fail := 0;
    SELECT MAX(fr.updated_at) INTO v_new_max
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    -- FIX-983 — the head-lag horizon, applied to the sweep target the moment it
    -- is captured, so every downstream use (the dirty-set bound below, the
    -- per-chunk sweep_target, and the terminal watermark) inherits it.
    v_horizon := public.fr_watermark_horizon();
    v_new_max := LEAST(COALESCE(v_new_max, v_horizon), v_horizon);
  END IF;

  v_horizon := COALESCE(v_horizon, public.fr_watermark_horizon());

  -- Invariant (c): a fresh sweep whose clamped target has not cleared the
  -- watermark has nothing to do, and advancing would move the watermark
  -- BACKWARDS. Skip cleanly, releasing the lock the same way the start-window
  -- and advisory-lock refusals above do.
  IF NOT v_resumed AND v_watermark IS NOT NULL AND v_new_max <= v_watermark THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', format('caught up at the FIX-983 horizon — %s is at or before the watermark %s',
                                    v_new_max, v_watermark),
              'horizon', v_new_max, 'watermark', v_watermark, 'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup] caught up at the horizon (% <= %) — skipping', v_new_max, v_watermark;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Dirty set, now carrying a per-recipient cost weight (FIX-1002) ────────
  -- ORDER BY is load-bearing: the cursor resumes on uuid order, so the dirty
  -- set must be built the same way on every resuming run, and v_dirty/v_weights
  -- must be built in ONE aggregate so the two arrays stay index-aligned.
  --
  -- The weight is official_donor_totals.donor_count — COUNT(*) of that
  -- official's donation FR rows, already maintained by the odt arm of
  -- donor_rollup_rebuild_recipients(). 6,782 rows / 117 pages, so reading it is
  -- free next to the scan it is sizing. Two known imprecisions, both tolerable
  -- because the loop RE-MEASURES rows-per-second empirically after every chunk:
  --   * it counts only 'donation', not ie_support/ie_oppose, so an IE-heavy
  --     recipient is under-weighted;
  --   * it is itself one run stale for recipients in the current dirty set.
  --
  -- FIX-1018 — `to_type = 'official'` is REQUIRED, not an optimisation. Without
  -- it 57% of the enumerated recipients are financial_entities that the arms
  -- cannot roll up, 54% of the dirty weight is c_weight_default fabricated for
  -- them, and the uuid-ordered cursor parks on whichever PAC sorts first. It is
  -- also what lets the planner use
  -- financial_relationships_donor_rollup_dirty_idx above; the two changes are
  -- one fix, not alternatives (see the header's measurement B).
  IF v_watermark IS NULL THEN
    -- Bootstrap: every recipient, same chunked loop.
    SELECT array_agg(d.to_id ORDER BY d.to_id),
           array_agg(COALESCE(odt.donor_count, c_weight_default) ORDER BY d.to_id)
      INTO v_dirty, v_weights
    FROM (
      SELECT DISTINCT fr.to_id
      FROM public.financial_relationships fr
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_type = 'official'                                   -- FIX-1018
        AND (v_cursor IS NULL OR fr.to_id > v_cursor)
    ) d
    LEFT JOIN public.official_donor_totals odt ON odt.official_id = d.to_id;
  ELSE
    SELECT array_agg(d.to_id ORDER BY d.to_id),
           array_agg(COALESCE(odt.donor_count, c_weight_default) ORDER BY d.to_id)
      INTO v_dirty, v_weights
    FROM (
      SELECT DISTINCT fr.to_id
      FROM public.financial_relationships fr
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_type = 'official'                                   -- FIX-1018
        AND fr.updated_at >  v_watermark
        AND fr.updated_at <= v_new_max                                -- FIX-983
        AND (v_cursor IS NULL OR fr.to_id > v_cursor)
    ) d
    LEFT JOIN public.official_donor_totals odt ON odt.official_id = d.to_id;
  END IF;

  -- FIX-1018 — stamp the pre-loop cost. This is the ONLY place it can be
  -- measured: v_started is procedure entry and the next thing that happens is
  -- the loop. Recorded on EVERY run, success or refusal, because its absence
  -- from the logs is what made FIX-1018 take a day to find.
  v_dirty_secs := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  v_n_recips := COALESCE(array_length(v_dirty, 1), 0);

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_refresh', 'running', now(),
          jsonb_build_object(
            'mode', CASE WHEN v_watermark IS NULL THEN 'bootstrap' ELSE 'incremental' END,
            'dirty_recipients', v_n_recips,
            'dirty_weight', COALESCE((SELECT SUM(w) FROM unnest(v_weights) w), 0),
            -- 3 dp, not 1: a healthy post-index build is sub-second, and a
            -- value that rounds to "0.0" reads as "not measured" — which is
            -- the exact failure mode this key exists to end.
            'dirty_set_build_seconds', round(v_dirty_secs::numeric, 3),   -- FIX-1018
            'resumed', v_resumed,
            'resume_cursor', v_cursor,
            'sweep_failures_before', v_prior_fail,
            'budget_seconds', v_budget_s,
            'chunk_target_seconds', c_chunk_secs,
            'rows_per_second_seed', round(v_rps_seed::numeric, 2),
            'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  -- ── The PRE-LOOP budget refusal (FIX-1018) ────────────────────────────────
  -- FIX-1002's guard is armed from chunk 1, which is correct and still leaves
  -- everything before iteration 1 unguarded. On 2026-08-10 that unguarded
  -- region was 9,292 of 9,367 seconds. Refuse here rather than enter a loop
  -- that has no window left, so the run stops evicting a 256 MB buffer pool on
  -- behalf of work it cannot finish.
  --
  -- Skipped when v_n_recips = 0: an empty dirty set means there is nothing to
  -- refuse and the run should COMPLETE and advance the watermark, however long
  -- the build took.
  IF v_n_recips > 0 AND v_dirty_secs > c_dirty_frac * v_budget_s THEN
    v_budget_hit := true;
    v_stop_why   := 'dirty_set_build_exhausted_budget';
    RAISE NOTICE '[donor-rollup] dirty-set build took %s of a %s budget (limit fraction %) — refusing to enter the loop',
      round(v_dirty_secs)::int, round(v_budget_s)::int, c_dirty_frac;
  END IF;

  WHILE NOT v_budget_hit AND v_i <= v_n_recips LOOP
    v_elapsed   := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    v_remaining := v_budget_s - v_elapsed;
    v_rps       := COALESCE(v_rps_run, v_rps_seed);

    -- Out of window entirely. Distinct from the per-chunk refusal below so the
    -- log says which one stopped the run.
    IF v_chunk_no > 0 AND v_remaining <= 0 THEN
      v_budget_hit := true;
      v_stop_why   := 'budget_exhausted';
      RAISE NOTICE '[donor-rollup] budget exhausted after chunk % (elapsed %s)',
        v_chunk_no, round(v_elapsed)::int;
      EXIT;
    END IF;

    -- ── Size this chunk (FIX-1002) ──────────────────────────────────────────
    -- Target the configured per-chunk duration at the measured rate, then
    -- shrink to fit what is actually left of the budget (with 25% headroom).
    -- Shrinking BEFORE the guard has to refuse is what turns the budget from a
    -- cliff into a taper: a run near its limit does small chunks rather than
    -- gambling one big one.
    v_target_w := GREATEST(1, LEAST(c_weight_max, (c_chunk_secs * v_rps)::bigint));
    v_fit_w    := GREATEST(1, (GREATEST(v_remaining, 0) * v_rps / 1.25)::bigint);
    v_target_w := LEAST(v_target_w, v_fit_w);

    -- Accumulate recipients until the weight target or the recipient cap is
    -- hit. A chunk is ALWAYS at least one recipient, so a single whale heavier
    -- than the whole target forms its own chunk and the loop still advances.
    v_chunk_end := v_i;
    v_chunk_w   := COALESCE(v_weights[v_i], c_weight_default);
    v_j         := v_i + 1;
    WHILE v_j <= v_n_recips
          AND v_chunk_end - v_i + 1 < c_recipients_max
          AND v_chunk_w + COALESCE(v_weights[v_j], c_weight_default) <= v_target_w
    LOOP
      v_chunk_w   := v_chunk_w + COALESCE(v_weights[v_j], c_weight_default);
      v_chunk_end := v_j;
      v_j         := v_j + 1;
    END LOOP;

    -- ── The guard, ARMED FROM CHUNK 1 (FIX-1002) ────────────────────────────
    -- FIX-972's version reserved 1.25 × the slowest chunk SEEN, which is a
    -- high-water mark of the past and says nothing about the chunk in hand.
    -- This projects the cost of THIS chunk from its own weight, so a whale is
    -- refused on its own merits.
    --
    -- The `v_chunk_no > 0` exception is deliberate and is about LIVENESS, not
    -- convenience: a lone recipient whose projected cost exceeds an entire
    -- budget would otherwise be refused by every future run forever and park
    -- the sweep permanently. The first chunk of a run always attempts, with the
    -- full window ahead of it and the 6h role timeout as the backstop. It is
    -- bounded by v_target_w (one recipient), not by a blind 50.
    IF v_chunk_no > 0
       AND (v_chunk_w / v_rps) * 1.25 > v_remaining THEN
      v_budget_hit := true;
      v_stop_why   := 'chunk_would_not_fit';
      IF v_chunk_end = v_i THEN
        v_blocked := v_dirty[v_i];
      END IF;
      RAISE NOTICE '[donor-rollup] budget guard — refusing chunk % (weight %, projected %s, remaining %s)',
        v_chunk_no + 1, v_chunk_w, round((v_chunk_w / v_rps) * 1.25)::int, round(v_remaining)::int;
      EXIT;
    END IF;

    v_chunk     := v_dirty[v_i : v_chunk_end];
    v_chunk_no  := v_chunk_no + 1;
    v_chunk_beg := clock_timestamp();
    BEGIN
      v_n    := public.donor_rollup_rebuild_recipients(v_chunk);
      v_rows := v_rows + v_n;
      IF v_chunk_no % 10 = 0 THEN
        RAISE NOTICE '[donor-rollup] chunk % — % recipients done, % rows so far',
          v_chunk_no, v_chunk_end, v_rows;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name. EXCEPTION WHEN OTHERS does not match query_canceled,
    -- so the 6h statement_timeout used to blow through this handler and out of
    -- the procedure, leaving the data_sync_log row stranded 'running' until the
    -- reaper found it up to 60 minutes later. This procedure is one of the two
    -- that actually get cancelled in practice.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, v_chunk_end, SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its recipients keep their PRIOR
      -- rollup rows (complete-if-stale). The cursor still advances so the sweep
      -- terminates, but sweep_failures blocks the watermark advance at the end,
      -- so the whole set is retried by the next sweep.
      v_failures := v_failures || format('chunk %s (recipients %s..%s): %s',
        v_chunk_no, v_i, v_chunk_end, SQLERRM);
      RAISE WARNING '[donor-rollup] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;

    -- FIX-944 — persist the cursor in the SAME transaction as the chunk's work.
    -- A run cancelled by the 6h statement_timeout keeps every committed chunk.
    -- FIX-972 — clock_timestamp(), NOT NOW(): NOW() is transaction_timestamp()
    -- and this transaction began right after the previous chunk's COMMIT, so it
    -- would stamp the moment this chunk STARTED.
    -- FIX-1002 — the calibration rides along, so the next run's first chunk is
    -- sized by the last run's measured rate.
    -- FIX-1028 — do NOT advance the cursor past a CANCELLED chunk. A failed
    -- chunk may advance (sweep_failures blocks the watermark, so the whole set
    -- is retried), but a cancel routes to the 'partial' branch which does NOT
    -- set sweep_failures — so an advanced cursor there would silently skip the
    -- recipients whose work was just rolled back. Leaving it un-advanced makes
    -- the next run redo exactly this chunk.
    IF v_canceled IS NULL THEN
    v_cursor := v_dirty[v_chunk_end];
    UPDATE public.pipeline_state
       SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object(
                     'sweep_cursor',    v_cursor::text,
                     'sweep_target',    v_new_max::text,
                     'sweep_failures',  v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                     'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)),
           updated_at = clock_timestamp()
     WHERE key = 'donor_rollup_watermark';
    IF NOT FOUND THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark', jsonb_build_object(
                'sweep_cursor',    v_cursor::text,
                'sweep_target',    v_new_max::text,
                'sweep_failures',  v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = public.pipeline_state.value || EXCLUDED.value, updated_at = clock_timestamp();
    END IF;
    END IF;  -- FIX-1028 cursor guard

    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Bounds txn size + advances xmin between chunks.
    COMMIT;

    -- FIX-1028 — end the sweep on a cancel, reusing the budget-stop path so the
    -- run closes its own row as 'partial' and stays resumable at v_i.
    IF v_canceled IS NOT NULL THEN
      v_budget_hit := true;
      v_stop_why   := 'canceled';
      EXIT;
    END IF;

    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;

    -- ── Re-measure the rate, pessimistically (FIX-1002) ─────────────────────
    -- Rolling MINIMUM within the run, so one expensive chunk immediately makes
    -- every subsequent chunk smaller. It resets each run rather than ratcheting
    -- down forever: a bad day pins the seed for exactly one following run, and
    -- a good run restores it.
    IF v_chunk_secs > 0 THEN
      v_rps_run := LEAST(COALESCE(v_rps_run, 1e18), v_chunk_w / v_chunk_secs);
    END IF;

    -- ── Pace (FIX-1002) ─────────────────────────────────────────────────────
    -- The saturation mechanism is shared-buffer eviction on a 256 MB pool, not
    -- disk throughput (Disk IO 3–5% while the site was down). Yielding gives
    -- the request path an unobstructed window to re-warm its own pages. Costs
    -- ~5% of the window at the default 300 s chunk. That trade is the point:
    -- a rollup that takes longer but leaves the site up is strictly better than
    -- one that converges fast and makes the platform unreachable. Do not
    -- "optimise" this away.
    v_yield := LEAST(v_chunk_secs * 0.10, 15.0);
    IF v_yield > 0 THEN PERFORM pg_sleep(v_yield); END IF;

    v_i := v_chunk_end + 1;
  END LOOP;

  IF v_budget_hit THEN
    -- Partial, resumable. Distinct from both 'complete' and 'failed'.
    UPDATE public.data_sync_log
    SET status        = 'partial',
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        -- FIX-1018 — say WHICH budget ran out. The pre-loop refusal and the
        -- in-loop exhaustion are different failures with different remedies,
        -- and a message that calls both "budget exhausted" hides the one this
        -- FIX exists to make visible.
        error_message = CASE
          -- FIX-1028 — name the cancel; it is not a budget stop and the remedy
          -- differs (the box could not finish one chunk, not "ran out of time").
          WHEN v_stop_why = 'canceled' THEN
            format('canceled — %s; resumable at recipient %s of %s (cursor %s)',
                   v_canceled, v_i, v_n_recips, v_cursor)
          WHEN v_stop_why = 'dirty_set_build_exhausted_budget' THEN
            format('dirty-set build consumed %ss of a %ss budget (limit %s%%) — loop not entered; resumable at recipient 1 of %s',
                   round(v_dirty_secs)::int, round(v_budget_s)::int,
                   round((c_dirty_frac * 100)::numeric, 1), v_n_recips)
          ELSE
            format('budget exhausted — resumable at recipient %s of %s (cursor %s)',
                   v_i, v_n_recips, v_cursor)
          END,
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'recipients_done', v_i - 1,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'resumable', true,
                          'resume_at_chunk', v_chunk_no + 1,
                          -- Which of the stop paths ended the run. Without
                          -- this, 'partial' cannot be told apart from 'partial'
                          -- and the guard is unfalsifiable from the log alone.
                          'stop_reason', v_stop_why,
                          'canceled', v_canceled IS NOT NULL,
                          'cancel_detail', v_canceled,
                          'remaining_recipients', GREATEST(v_n_recips - v_i + 1, 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3),
                          -- FIX-1002 — "no silent caps": a single recipient the
                          -- guard refuses because it cannot fit a whole budget
                          -- is a stuck sweep, not a paced one. Name it.
                          'blocked_recipient', v_blocked,
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] PARTIAL (%) — % of % recipients this run, resumable at chunk %',
      v_stop_why, v_i - 1, v_n_recips, v_chunk_no + 1;
  ELSE
    -- Sweep finished. Advance the durable watermark only if NO chunk failed
    -- anywhere in the sweep (including earlier, interrupted runs of it), then
    -- clear the cursor so the next run starts a fresh sweep.
    IF v_prior_fail + COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1002 — this branch REPLACES the whole jsonb (that is how the sweep
      -- keys get cleared), so the calibration must be re-stated here or it is
      -- silently dropped every time a sweep completes. Same class of bug as the
      -- entity_comments rating trigger clobbering denormalized keys.
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('donor_rollup_watermark',
              jsonb_build_object(
                'last_indexed_at', COALESCE(v_new_max, v_horizon)::text,
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object(
                      'last_indexed_at', COALESCE(v_new_max, v_horizon)::text,
                      'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)),
            updated_at = NOW();
    ELSE
      UPDATE public.pipeline_state
         SET value = (value - 'sweep_cursor' - 'sweep_target' - 'sweep_failures'),
             updated_at = NOW()
       WHERE key = 'donor_rollup_watermark';
    END IF;

    UPDATE public.data_sync_log
    SET status        = CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0
                             THEN 'failed' ELSE 'complete' END,
        completed_at  = now(),
        rows_inserted = v_rows,
        rows_failed   = COALESCE(array_length(v_failures, 1), 0),
        error_message = CASE WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                             ELSE NULL END,
        metadata      = metadata || jsonb_build_object(
                          'rollup_rows', v_rows,
                          'chunks', v_chunk_no,
                          'recipients_done', v_n_recips,
                          'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                          'sweep_failures_total', v_prior_fail + COALESCE(array_length(v_failures, 1), 0),
                          'slowest_chunk_seconds', round(v_max_chunk)::int,
                          'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3),
                          'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
    WHERE id = v_log_id;

    RAISE NOTICE '[donor-rollup] % — % recipients in % chunks, % rows (% failures this run)',
      CASE WHEN v_prior_fail + COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'PARTIAL' ELSE 'complete' END,
      v_n_recips, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);
  END IF;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_official_donor_rollup_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_official_donor_rollup_incremental() TO service_role;


-- ── 8/13 · donor_rollup_rebuild_bulk() — manual break-glass ──────────────────
-- Manual, but clamped: a break-glass bulk sweep is EXACTLY the
-- long-single-transaction shape the horizon exists for.
-- Invariant (c) is expressed as GREATEST rather than an early return, because
-- this procedure has no natural exit between its target capture and its chunk
-- loop: pinning the target to the watermark makes the dirty predicate
-- `> v_watermark AND <= v_watermark` empty, so the sweep is a clean no-op that
-- rewrites the SAME watermark instead of a lower one.

CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_state_key  text   := 'donor_rollup_bulk_sweep';
  c_global     uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks     int    := 32;      -- must divide 256 (uuid first-byte ranges)
  c_budget     interval := interval '4 hours 30 minutes';
  c_max_sweep  interval := interval '48 hours';

  v_state      jsonb;
  v_cursor     int;
  v_mode       text;
  v_resumed    boolean := false;
  v_restarted  text    := NULL;
  v_sweep_beg  timestamptz;
  v_sweep_tgt  timestamptz;
  v_horizon    timestamptz;   -- FIX-983
  v_watermark  timestamptz;
  v_log_id     uuid;
  v_cfg        int;
  v_cfg_txt    text;
  v_step       int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- This is the manual break-glass bulk path, so the axe here is normally an
  -- operator cancel or the 6h role default rather than a cron budget — the
  -- stranding is identical either way.
  v_canceled   text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_n_targets  int := 0;
  v_n_offic    int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_done       int := 0;
  k            int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_bulk', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason',
              'advisory lock held by a concurrent donor-rollup refresh (incremental or bulk)'));
    RAISE NOTICE '[donor-rollup bulk] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_budget_seconds', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_cfg);
  END IF;

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunks', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    IF v_cfg NOT IN (16, 32, 64, 128, 256) THEN
      PERFORM pg_advisory_unlock(c_lock_key);
      RAISE EXCEPTION 'civitics.donor_rollup_bulk_chunks must be one of 16/32/64/128/256 (got %)', v_cfg;
    END IF;
    c_chunks := v_cfg;
  END IF;
  v_step := 256 / c_chunks;

  v_cfg_txt := NULLIF(current_setting('civitics.donor_rollup_bulk_mode', true), '');
  v_mode := COALESCE(v_cfg_txt, 'dirty');
  IF v_mode NOT IN ('dirty', 'full') THEN
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE EXCEPTION 'civitics.donor_rollup_bulk_mode must be ''dirty'' or ''full'' (got %)', v_mode;
  END IF;

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);
  v_sweep_beg := (v_state->>'sweep_started_at')::timestamptz;
  v_sweep_tgt := (v_state->>'sweep_target')::timestamptz;

  IF v_cursor >= 0 THEN
    v_resumed := true;
    IF (v_state->>'mode') IS DISTINCT FROM v_mode THEN
      v_restarted := format('mode changed %s -> %s', v_state->>'mode', v_mode);
    ELSIF COALESCE((v_state->>'chunks')::int, -1) <> c_chunks THEN
      v_restarted := format('chunk count changed %s -> %s', v_state->>'chunks', c_chunks);
    ELSIF v_sweep_beg IS NULL OR clock_timestamp() - v_sweep_beg > c_max_sweep THEN
      v_restarted := format('sweep started %s exceeds the %s staleness bound', v_sweep_beg, c_max_sweep);
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_targets LIMIT 1) THEN
      v_restarted := 'target staging empty (crash recovery truncates UNLOGGED tables)';
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_fe LIMIT 1) THEN
      v_restarted := 'donor-dimension staging empty (crash recovery truncates UNLOGGED tables)';
    END IF;
    IF v_restarted IS NOT NULL THEN
      RAISE NOTICE '[donor-rollup bulk] discarding in-flight sweep: %', v_restarted;
      v_cursor  := -1;
      v_resumed := false;
    END IF;
  END IF;

  IF v_cursor < 0 THEN
    -- FIX-974 follow-up: assert the from_type invariant BEFORE anything is
    -- written, so a violating sweep publishes nothing at all.
    PERFORM public.donor_rollup_bulk_assert_invariants();

    SELECT MAX(fr.updated_at) INTO v_sweep_tgt
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

    -- FIX-983 — the head-lag horizon, then the never-go-backwards floor.
    v_horizon   := public.fr_watermark_horizon();
    v_sweep_tgt := LEAST(COALESCE(v_sweep_tgt, v_horizon), v_horizon);
    v_sweep_tgt := GREATEST(v_sweep_tgt, v_watermark);

    TRUNCATE public._drb_targets;
    IF v_mode = 'full' OR v_watermark IS NULL THEN
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    ELSE
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
          AND fr.updated_at >  v_watermark
          AND fr.updated_at <= v_sweep_tgt                             -- FIX-983
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    END IF;

    TRUNCATE public._drb_fe;
    INSERT INTO public._drb_fe (id, display_name, entity_type, state, industry_tag, industry_label)
    SELECT fe.id, fe.display_name, fe.entity_type, fe.metadata->>'state',
           t.tag, t.display_label
    FROM public.financial_entities fe
    LEFT JOIN (
      SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag, et.display_label
      FROM public.entity_tags et
      WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
      ORDER BY et.entity_id, et.tag
    ) t ON t.entity_id = fe.id;

    ANALYZE public._drb_targets;
    ANALYZE public._drb_fe;

    v_sweep_beg := clock_timestamp();   -- FIX-981: the instant, not the txn start
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks),
          updated_at = clock_timestamp();
  END IF;

  SELECT count(*), count(*) FILTER (WHERE is_official) INTO v_n_targets, v_n_offic
  FROM public._drb_targets;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_bulk', 'running', v_started,
          jsonb_build_object(
            'shape', 'to_id-range chunks, one FR scan per chunk, six arms derived',
            'mode', v_mode, 'chunks', c_chunks,
            'targets', v_n_targets, 'target_officials', v_n_offic,
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'sweep_target', v_sweep_tgt,
            'budget_seconds', EXTRACT(epoch FROM c_budget)))
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_chunk > 0
       AND v_elapsed + (v_max_chunk * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[donor-rollup bulk] budget guard — stopping before chunk % (elapsed %s, slowest %s)',
        k, round(v_elapsed)::int, round(v_max_chunk)::int;
      EXIT;
    END IF;

    v_lo := (lpad(to_hex(k * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid;
    v_hi := CASE WHEN k < c_chunks - 1
                 THEN (lpad(to_hex((k + 1) * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid
                 ELSE NULL END;
    v_chunk_beg := clock_timestamp();

    BEGIN
      TRUNCATE public._drb_donor;
      INSERT INTO public._drb_donor
        (to_id, relationship_type, from_id, total_cents, total_cents0, tx_count,
         small_cents, small_count, pos_cents, pos_count)
      SELECT
        fr.to_id,
        fr.relationship_type::text,
        fr.from_id,
        SUM(fr.amount_cents)::bigint,
        SUM(COALESCE(fr.amount_cents, 0))::bigint,
        COUNT(*)::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0))::bigint
      FROM public.financial_relationships fr
      JOIN public._drb_targets t ON t.to_id = fr.to_id
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_id >= v_lo
        AND (v_hi IS NULL OR fr.to_id < v_hi)
      GROUP BY fr.to_id, fr.relationship_type, fr.from_id;

      TRUNCATE public._drb_chunk_fe;
      INSERT INTO public._drb_chunk_fe (id, display_name, entity_type, state, industry_tag, industry_label)
      SELECT f.id, f.display_name, f.entity_type, f.state, f.industry_tag, f.industry_label
      FROM public._drb_fe f
      WHERE f.id IN (SELECT DISTINCT d.from_id FROM public._drb_donor d);

      ANALYZE public._drb_donor;
      ANALYZE public._drb_chunk_fe;

      DELETE FROM public.official_donor_rollup_mv m
       WHERE m.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH ranked AS (
        SELECT d.to_id AS official_id, d.relationship_type, d.from_id AS donor_id,
               d.total_cents, d.tx_count,
               ROW_NUMBER() OVER (PARTITION BY d.to_id, d.relationship_type
                                  ORDER BY d.total_cents DESC, d.from_id) AS rn
        FROM public._drb_donor d
      ),
      top_rows AS (
        SELECT r.official_id, r.relationship_type, r.rn::int AS rank, r.donor_id,
               fe.display_name, fe.entity_type, fe.industry_tag, fe.industry_label,
               r.total_cents, r.tx_count, NULL::bigint AS tail_donor_count
        FROM ranked r
        LEFT JOIN public._drb_chunk_fe fe ON fe.id = r.donor_id
        WHERE r.rn <= 200
      ),
      tail_rows AS (
        SELECT r.official_id, r.relationship_type, 201 AS rank, NULL::uuid, NULL::text,
               NULL::text, NULL::text, NULL::text,
               SUM(r.total_cents)::bigint, SUM(r.tx_count)::bigint, COUNT(*)::bigint
        FROM ranked r WHERE r.rn > 200
        GROUP BY r.official_id, r.relationship_type
      ),
      ins AS (
        INSERT INTO public.official_donor_rollup_mv (
          official_id, relationship_type, rank, donor_id, donor_name, entity_type,
          industry_tag, industry_label, total_cents, tx_count, tail_donor_count)
        SELECT * FROM top_rows UNION ALL SELECT * FROM tail_rows
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_n FROM ins;
      v_rows := v_rows + v_n;

      DELETE FROM public.official_donor_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_donor_totals
        (official_id, total_cents, pac_cents, individual_cents, donor_count, updated_at)
      SELECT d.to_id,
             SUM(d.total_cents0)::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
             SUM(d.tx_count)::bigint,
             -- FIX-981: was the column DEFAULT now(), i.e. the START of this
             -- chunk's transaction, N COMMITs into the sweep.
             clock_timestamp()
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_small_dollar_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_small_dollar_rollup
        (official_id, small_dollar_cents, small_dollar_count, updated_at)
      SELECT d.to_id, SUM(d.small_cents)::bigint, SUM(d.small_count)::bigint, clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_sector_affinity_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_sector_affinity_rollup
        (official_id, industry, total_cents, donor_count, updated_at)
      SELECT d.to_id,
             COALESCE(fe.industry_tag, 'Untagged'),
             SUM(d.pos_cents)::bigint,
             COUNT(*)::bigint,
             clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
        AND d.pos_cents > 0
      GROUP BY d.to_id, COALESCE(fe.industry_tag, 'Untagged');

      DELETE FROM public.treemap_individuals_rollup x
       WHERE x.scope_id <> c_global
         AND x.scope_id IN (
           SELECT t.to_id FROM public._drb_targets t
            WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH per_name AS (
        SELECT d.to_id AS scope_id,
               COALESCE(fe.state, '??') AS state,
               fe.display_name          AS donor_name,
               SUM(d.pos_cents)::bigint AS total_cents,
               SUM(d.pos_count)::bigint AS donation_count
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
        GROUP BY d.to_id, COALESCE(fe.state, '??'), fe.display_name
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY scope_id, state
                                     ORDER BY total_cents DESC, donor_name) AS rank
        FROM per_name
      )
      INSERT INTO public.treemap_individuals_rollup
        (scope_id, state, rank, donor_name, total_cents, donation_count)
      SELECT scope_id, state, rank::int, donor_name, total_cents, donation_count
      FROM ranked WHERE rank <= 50;

      DELETE FROM public.official_donor_bracket_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH bucketed AS (
        SELECT d.to_id AS official_id, d.pos_cents AS donor_cents,
               CASE WHEN d.pos_cents >= 1000000 THEN 'mega'
                    WHEN d.pos_cents >=  250000 THEN 'major'
                    WHEN d.pos_cents >=   50000 THEN 'mid'
                    ELSE                              'small' END AS tier
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
      )
      INSERT INTO public.official_donor_bracket_totals (official_id, tier, total_cents, donor_count)
      SELECT official_id, tier, SUM(donor_cents)::bigint, COUNT(*)::bigint
      FROM bucketed GROUP BY official_id, tier;

      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object('chunk_cursor', k),
             updated_at = clock_timestamp()
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. The cursor is written INSIDE this chunk's
    -- transaction, so a cancelled chunk rolls back together with its cursor
    -- advance and the next CALL resumes at exactly k.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % CANCELED (statement_timeout or operator cancel): %', k, SQLERRM;
    WHEN OTHERS THEN
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_canceled IS NOT NULL;
    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;

    v_done := v_done + 1;
    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    RAISE NOTICE '[donor-rollup bulk] chunk %/% done (%s, % arm-1 rows so far)',
      k + 1, c_chunks, round(v_chunk_secs)::int, v_rows;
  END LOOP;

  -- FIX-1028 — cancelled is PARTIAL and RESUMABLE. The bulk path's watermark
  -- write is at the very end and stays there (this is the manual, re-runnable
  -- path — a re-CALL resumes from the committed cursor), but the ROW now closes
  -- itself instead of sitting 'running' until the reaper.
  IF v_canceled IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = left(format('canceled — %s; resumable at chunk %s of %s', v_canceled,
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks), 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'canceled', true, 'cancel_detail', v_canceled,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE WARNING '[donor-rollup bulk] CANCELED — partial, resumable; re-CALL to continue';
    RETURN;
  END IF;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  IF v_budget_hit THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[donor-rollup bulk] PARTIAL — resumable; re-CALL to continue';
    RETURN;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text),
        updated_at = clock_timestamp();

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', clock_timestamp()::text,   -- FIX-981
                                    'mode', v_mode, 'chunks', c_chunks,
                                    'targets', v_n_targets),
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  TRUNCATE public._drb_donor;
  TRUNCATE public._drb_chunk_fe;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'chunks_done_this_run', v_done,
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
           'watermark_advanced_to', v_sweep_tgt)
   WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup bulk] complete — % targets, % arm-1 rows', v_n_targets, v_rows;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.donor_rollup_rebuild_bulk() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.donor_rollup_rebuild_bulk() TO service_role;


-- ── 9/13 · rebuild_entity_connections_donations() — break-glass single-shot ──
-- Two structural notes.
--  * The max capture MOVES ABOVE the dirty temp table. It has to: the dirty set
--    must be bounded by the target, and the target must therefore exist first.
--    This is the "capture the new watermark BEFORE building the dirty set"
--    ordering every sibling routine already documents; here it was inverted.
--  * The no-op short-circuit gains invariant (c): when the clamped target has
--    not cleared the watermark, return the two zero rows WITHOUT writing the
--    watermark, rather than writing a lower one.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count                BIGINT;
  v_opp                  BIGINT;
  v_last_indexed_at      TIMESTAMPTZ;
  v_new_max_updated_at   TIMESTAMPTZ;
  v_horizon              TIMESTAMPTZ;   -- FIX-983
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz
    INTO v_last_indexed_at
  FROM public.pipeline_state
  WHERE key = 'entity_connections_donations';

  IF v_last_indexed_at IS NULL THEN
    -- Bootstrap: delegate to _full(), which sets the watermark itself and now
    -- returns BOTH ('donation', …) and ('opposition', …) rows (FIX-747).
    RETURN QUERY SELECT * FROM public.rebuild_entity_connections_donations_full();
    RETURN;
  END IF;

  -- FIX-983 — capture the target BEFORE the dirty set (the ordering every
  -- sibling routine already states) and clamp it to the head-lag horizon, so
  -- the dirty set can be bounded above by it.
  SELECT MAX(fr.updated_at) INTO v_new_max_updated_at
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

  v_horizon            := public.fr_watermark_horizon();
  v_new_max_updated_at := LEAST(COALESCE(v_new_max_updated_at, v_horizon), v_horizon);

  -- Invariant (c): nothing old enough to read yet. Report zero and leave the
  -- watermark exactly where it is; writing v_new_max_updated_at here would move
  -- it BACKWARDS.
  IF v_new_max_updated_at <= v_last_indexed_at THEN
    connection_type := 'donation';   edges_upserted := 0; RETURN NEXT;
    connection_type := 'opposition'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  -- FIX-747: the dirty set now spans ie_oppose too, so a weekend of opposition
  -- spend dirties its donor and gets re-derived on the next incremental.
  CREATE TEMP TABLE _dirty_from_ids ON COMMIT DROP AS
  SELECT DISTINCT fr.from_type, fr.from_id
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND fr.updated_at >  v_last_indexed_at
    AND fr.updated_at <= v_new_max_updated_at;   -- FIX-983

  -- No-op short-circuit when nothing changed.
  IF NOT EXISTS (SELECT 1 FROM _dirty_from_ids) THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (
      'entity_connections_donations',
      jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();

    connection_type := 'donation';   edges_upserted := 0; RETURN NEXT;
    connection_type := 'opposition'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  -- FIX-747: clear both derived classes for the dirty donors (was 'donation' only).
  DELETE FROM public.entity_connections ec
  USING _dirty_from_ids d
  WHERE ec.connection_type IN ('donation', 'opposition')
    AND ec.from_type = d.from_type
    AND ec.from_id = d.from_id;

  -- donation + ie_support → 'donation'
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN _dirty_from_ids d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type IN ('donation', 'ie_support')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'donation'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  -- FIX-747: ie_oppose → 'opposition' (same dirty set)
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN _dirty_from_ids d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type = 'ie_oppose'
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'opposition'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_opp FROM inserted;

  -- Advance watermark.
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'donation';   edges_upserted := v_count; RETURN NEXT;
  connection_type := 'opposition'; edges_upserted := v_opp;   RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_donations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations() TO service_role;


-- ── 10/13 · rebuild_entity_connections_donations_full() — bootstrap ──────────
-- A full pass at time T followed by a watermark of T-L means the next
-- incremental re-checks the last hour. THAT IS THE POINT: the full pass read
-- the head under exactly the same uncommitted-writer exposure as an incremental
-- one, so its watermark gets the same clamp.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_donations_full()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count BIGINT;
  v_opp   BIGINT;
BEGIN
  -- FIX-747: clear both derived classes (was 'donation' only).
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type IN ('donation', 'opposition');

  -- donation + ie_support → 'donation'
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'donation'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  -- FIX-747: ie_oppose → 'opposition'
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'ie_oppose'
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'opposition'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_opp FROM inserted;

  -- Advance watermark so the next incremental run picks up from the horizon.
  -- FIX-983: NOT NOW() — a full pass reads the head under the same
  -- uncommitted-writer exposure as an incremental one.
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', public.fr_watermark_horizon()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'donation';   edges_upserted := v_count; RETURN NEXT;
  connection_type := 'opposition'; edges_upserted := v_opp;   RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_donations_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_donations_full() TO service_role;


-- ── 11/13 · rebuild_ec_donations_incr_prepare() — FIX-1069 cycle target ──────
-- The clamp lands on v_target BEFORE the existing `IF v_target < v_since`
-- floor, so a cycle whose windows already sit past the horizon still opens (and
-- stages an empty dirty set), exactly as it does today when the target is below
-- the oldest window. Order matters: clamping AFTER the floor could pull the
-- target below a window's own watermark and strand it.

CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_prepare()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
AS $function$
DECLARE
  c_key           CONSTANT text     := 'entity_connections_donations';
  c_cycle_max_age CONSTANT interval := interval '7 days';
  v_state    jsonb;
  v_scalar   timestamptz;
  v_windows  jsonb;
  v_target   timestamptz;
  v_staged   timestamptz;
  v_since    timestamptz;
  v_rows     bigint;
  i          int;
BEGIN
  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_key;

  v_scalar := (v_state->>'last_indexed_at')::timestamptz;

  -- No watermark at all => never bootstrapped. The incremental path cannot
  -- clean up EC rows whose donor has vanished from FR (it only touches donors
  -- present in the dirty set), so a true bootstrap must go through the full
  -- windowed path, which range-DELETEs. Signal that to the caller.
  IF v_scalar IS NULL THEN
    RETURN NULL;
  END IF;

  v_windows := v_state->'windows';

  -- First run after this migration: seed all 16 windows from the existing
  -- scalar. Every window therefore starts level, which is what lets a window's
  -- watermark double as its own "already done this cycle" flag.
  IF v_windows IS NULL OR jsonb_typeof(v_windows) <> 'object' THEN
    v_windows := '{}'::jsonb;
    FOR i IN 0..15 LOOP
      v_windows := jsonb_set(v_windows, ARRAY[i::text], to_jsonb(v_scalar::text));
    END LOOP;
  END IF;

  v_staged := (v_state->'cycle'->>'staged_at')::timestamptz;
  v_target := (v_state->'cycle'->>'target_at')::timestamptz;

  -- ── Resume an open cycle ───────────────────────────────────────────────────
  -- Reuse iff the cycle is young AND the staging table still holds its rows.
  -- The EXISTS check is what makes an UNLOGGED table safe here: a crash-
  -- truncated staging table falls through and is rebuilt rather than silently
  -- producing a no-op cycle that advances watermarks over unprocessed donors.
  IF v_staged IS NOT NULL
     AND v_target IS NOT NULL
     AND v_staged > now() - c_cycle_max_age
     AND EXISTS (SELECT 1 FROM public.ec_donations_incr_dirty)
  THEN
    -- Persist the (possibly newly seeded) windows without disturbing the cycle.
    UPDATE public.pipeline_state
       SET value      = value || jsonb_build_object('windows', v_windows),
           updated_at = now()
     WHERE key = c_key;
    RAISE NOTICE '[donations/incr] resuming cycle target=% staged=% (% dirty donors already staged)',
      v_target, v_staged, (SELECT count(*) FROM public.ec_donations_incr_dirty);
    RETURN v_target;
  END IF;

  -- ── Open a fresh cycle ─────────────────────────────────────────────────────
  -- Start from the OLDEST window, so no window can be handed a dirty set that
  -- begins after its own watermark (which would leave a gap for that window).
  SELECT min((e.value)::timestamptz) INTO v_since
    FROM jsonb_each_text(v_windows) AS e(key, value);
  v_since := COALESCE(v_since, v_scalar);

  SELECT MAX(fr.updated_at) INTO v_target
    FROM public.financial_relationships fr
   WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

  -- FIX-983 — the head-lag horizon, applied BEFORE the `< v_since` floor below.
  v_target := LEAST(COALESCE(v_target, public.fr_watermark_horizon()), public.fr_watermark_horizon());

  -- A target at or before the oldest window is a genuine no-op cycle; still
  -- open it so the windows can level up and the arm can bank.
  IF v_target < v_since THEN
    v_target := v_since;
  END IF;

  TRUNCATE public.ec_donations_incr_dirty;

  INSERT INTO public.ec_donations_incr_dirty (from_id, from_type)
  SELECT DISTINCT fr.from_id, fr.from_type
    FROM public.financial_relationships fr
   WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
     AND fr.updated_at > v_since
     AND fr.updated_at <= v_target;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.pipeline_state (key, value)
  VALUES (c_key, COALESCE(v_state, '{}'::jsonb)
                 || jsonb_build_object(
                      'windows', v_windows,
                      'cycle', jsonb_build_object(
                        'since_at',  v_since,
                        'target_at', v_target,
                        'staged_at', now(),
                        'dirty_donors', v_rows)))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  RAISE NOTICE '[donations/incr] opened cycle since=% target=% — % dirty donors staged',
    v_since, v_target, v_rows;

  RETURN v_target;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_incr_prepare() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_incr_prepare() TO service_role;


-- ── 12/13 · rebuild_ec_donations_full_prepare() — NOT in the staged census ───
-- Found by walking pg_proc for watermark WRITES rather than reads. It pushes
-- the donations watermark up front so a concurrent FR write during the
-- multi-commit windowed rebuild is caught by the next incremental — the same
-- intent as the horizon, one clock-tick short of it. Clamped.

CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_full_prepare()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- FIX-703: no global DELETE here anymore — each window range-scopes its own
  -- delete+insert so per-window COMMIT never leaves a gap. Keep only the
  -- non-destructive watermark advance (push it up front so a concurrent FR write
  -- during the multi-commit rebuild is caught by the next incremental).
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_donations',
    jsonb_build_object('last_indexed_at', public.fr_watermark_horizon()::text)   -- FIX-983
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_full_prepare() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_full_prepare() TO service_role;


-- ── 13/13 · run_fe_totals_crawl(int) — bootstrap seed, NOT in staged census ──
-- The staged census listed this as "reads the key without a predicate". It also
-- WRITES one: after all sixteen bootstrap windows land it seeds
-- financial_entity_totals_watermark from max(updated_at). Clamped, for the same
-- reason as 10/13 — the bootstrap read the head too.

CREATE OR REPLACE PROCEDURE public.run_fe_totals_crawl(IN p_max_units integer DEFAULT 1)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key  bigint := hashtext('financial_entity_totals_refresh')::bigint;
  c_boot_key  text   := 'fe_crawl_bootstrap_progress';
  c_bounds    uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id     uuid;
  v_started    timestamptz := clock_timestamp();
  v_gate       jsonb;
  v_interlock  jsonb;
  v_cfg        jsonb;
  v_budget     interval;
  v_units      int     := 0;
  v_capped     boolean := false;
  v_caught_up  boolean := false;
  v_canceled   text    := NULL;
  v_failures   text[]  := ARRAY[]::text[];
  v_rows       bigint  := 0;
  v_backoff    boolean := false;
  v_unit_log   jsonb   := '[]'::jsonb;
  v_res        jsonb;
  v_rec        jsonb;
  v_t0         timestamptz;
  v_secs       numeric;
  v_boot       jsonb;
  v_boot_done  int[]   := ARRAY[]::int[];
  v_lo         uuid;
  v_hi         uuid;
  v_n          bigint;
  i            int;
BEGIN
  IF p_max_units < 1 THEN
    RAISE EXCEPTION 'run_fe_totals_crawl: p_max_units must be >= 1 (got %)', p_max_units;
  END IF;

  -- Shares jobid 13's advisory lock key on purpose: the old procedure and this
  -- one must never run together against the same watermark.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent financial-entity-totals refresh',
                               'source', 'pg_cron', 'crawl', true));
    RAISE NOTICE '[fe-crawl] advisory lock held — skipping';
    RETURN;
  END IF;

  -- ── the gate, including the EC crawl's backoff ───────────────────────────
  v_gate := public.crawl_gate('fe_crawl', NULL, NULL, 'ec_crawl');
  IF NOT (v_gate->>'run')::boolean THEN
    IF v_gate->>'reason' IN ('backoff', 'peer_backoff') THEN
      INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
      VALUES ('financial_entity_totals_refresh', 'skipped', v_started, clock_timestamp(),
              jsonb_build_object('source', 'pg_cron', 'crawl', true,
                                 'skip_reason', v_gate->>'detail', 'gate', v_gate));
    END IF;
    UPDATE public.pipeline_state
       SET value = value || jsonb_build_object('skips',
                     COALESCE(value->'skips', '{}'::jsonb)
                     || jsonb_build_object(
                          v_gate->>'reason',
                          COALESCE((value->'skips'->>(v_gate->>'reason'))::int, 0) + 1,
                          'last_skip_at',     clock_timestamp(),
                          'last_skip_reason', v_gate->>'reason')),
           updated_at = now()
     WHERE key = 'fe_crawl';
    RAISE NOTICE '[fe-crawl] SKIPPED (%) — %', v_gate->>'reason', v_gate->>'detail';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── FIX-1101's FEC interlock ─────────────────────────────────────────────
  -- This crawl reads financial_relationships, which is exactly what the weekly
  -- FEC bulk replay rewrites. Deferring BEFORE the log row goes 'running' means
  -- a deferred firing leaves no state behind.
  v_interlock := public.fec_bulk_interlock_state();
  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'deferred', v_started, clock_timestamp(),
            jsonb_build_object('source', 'pg_cron', 'crawl', true,
                               'defer_reason', v_interlock->>'reason',
                               'fec_interlock', v_interlock));
    RAISE WARNING '[fe-crawl] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[fe-crawl] fec_bulk_run_state present but STALE (%) — proceeding; the marker is stranded',
      v_interlock->>'run_state_age';
  END IF;

  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'fe_crawl';
  v_budget := make_interval(secs => GREATEST(
                COALESCE((COALESCE(v_cfg, '{}'::jsonb)->>'unit_budget_seconds')::numeric, 1800), 60));

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_refresh', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'crawl', true,
                             'max_units', p_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- ═══ BOOTSTRAP PATH — only when the watermark is absent ═══════════════════
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_state
                  WHERE key = 'financial_entity_totals_watermark') THEN
    SELECT value INTO v_boot FROM public.pipeline_state WHERE key = c_boot_key;
    IF v_boot IS NOT NULL THEN
      SELECT COALESCE(array_agg(x::int), ARRAY[]::int[]) INTO v_boot_done
        FROM jsonb_array_elements_text(COALESCE(v_boot->'done', '[]'::jsonb)) x;
    END IF;

    FOR i IN 1..16 LOOP
      IF (i - 1) = ANY(v_boot_done) THEN CONTINUE; END IF;   -- no unit spent
      IF v_units >= p_max_units THEN v_capped := true; EXIT; END IF;
      IF clock_timestamp() - v_started >= v_budget THEN v_capped := true; EXIT; END IF;

      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      v_t0 := clock_timestamp();
      v_n  := 0;
      BEGIN
        v_n := public.financial_entity_donation_totals_window(v_lo, v_hi)
             + public.financial_entity_received_totals_window(v_lo, v_hi)
             + public.financial_entity_recipient_count_window(v_lo, v_hi);
        v_rows := v_rows + v_n;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_boot_key, jsonb_build_object('done', to_jsonb(v_boot_done || (i - 1))))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
        RAISE NOTICE '  [fe-crawl] bootstrap window %/16 — % rows', i, v_n;
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-crawl] bootstrap window %/16 CANCELED: %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-crawl] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;

      IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
        v_boot_done := v_boot_done || (i - 1);
      END IF;

      v_units := v_units + 1;
      v_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_t0));
      BEGIN
        v_rec := public.crawl_record_unit('fe_crawl', 'fe_bootstrap_window',
                   format('bootstrap window %s/16', i), v_secs, v_n,
                   CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                        WHEN COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'failed'
                        ELSE 'ok' END);
        IF (v_rec->>'backoff_set')::boolean THEN v_backoff := true; END IF;
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [fe-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      EXIT WHEN v_canceled IS NOT NULL;
      IF v_backoff THEN v_capped := true; EXIT; END IF;
    END LOOP;

    -- All sixteen bootstrap windows landed: seed the watermark so every later
    -- firing takes the slice path.
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0
       AND COALESCE(array_length(v_boot_done, 1), 0) = 16 THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('financial_entity_totals_watermark',
              jsonb_build_object('last_indexed_at',
                -- FIX-983 — clamp the bootstrap seed to the head-lag horizon.
                LEAST(COALESCE((SELECT max(updated_at) FROM public.financial_relationships),
                               public.fr_watermark_horizon()),
                      public.fr_watermark_horizon())::text))
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
      DELETE FROM public.pipeline_state WHERE key = c_boot_key;
      v_caught_up := true;
      COMMIT;
    END IF;

  ELSE
    -- ═══ SLICE PATH — the normal one ═══════════════════════════════════════
    WHILE v_units < p_max_units LOOP
      IF clock_timestamp() - v_started >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [fe-crawl] BUDGET EXHAUSTED before slice %; stopping cleanly', v_units + 1;
        EXIT;
      END IF;

      v_t0  := clock_timestamp();
      v_res := NULL;
      BEGIN
        v_res  := public.refresh_fe_totals_slice();
        v_rows := v_rows + COALESCE((v_res->>'rows_written')::bigint, 0);
      EXCEPTION
      -- FIX-1028 — by name. The slice is atomic, so a cancel here has already
      -- rolled back BOTH its rows and its watermark advance. Nothing to repair,
      -- nothing stranded; the next firing retries the same slice.
      WHEN query_canceled THEN
        v_canceled := format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [fe-crawl] slice % CANCELED (rolled back whole — watermark unmoved): %',
          v_units + 1, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [fe-crawl] slice % FAILED: %', v_units + 1, SQLERRM;
      END;
      COMMIT;

      IF v_res IS NOT NULL AND COALESCE((v_res->>'bootstrap_required')::boolean, false) THEN
        RAISE WARNING '  [fe-crawl] watermark vanished mid-run — bootstrap required; stopping';
        EXIT;
      END IF;

      v_units := v_units + 1;
      v_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_t0));
      BEGIN
        v_rec := public.crawl_record_unit('fe_crawl', 'fe_totals_slice',
                   format('slice -> %s', COALESCE(v_res->>'watermark', '(none)')),
                   v_secs, COALESCE((v_res->>'rows_written')::bigint, 0),
                   CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                        WHEN COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'failed'
                        ELSE 'ok' END);
        IF (v_rec->>'backoff_set')::boolean THEN v_backoff := true; END IF;
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [fe-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      EXIT WHEN v_canceled IS NOT NULL;
      EXIT WHEN COALESCE(array_length(v_failures, 1), 0) > 0;

      IF v_res IS NOT NULL THEN
        RAISE NOTICE '  [fe-crawl] slice -> % — % donors, % recipients, % rows',
          v_res->>'watermark', v_res->>'donors', v_res->>'recipients', v_res->>'rows_written';
        IF COALESCE((v_res->>'caught_up')::boolean, false) THEN
          v_caught_up := true;
          RAISE NOTICE '  [fe-crawl] CAUGHT UP — watermark is at the newest FR write';
          EXIT;
        END IF;
      END IF;

      IF v_backoff THEN v_capped := true; EXIT; END IF;
    END LOOP;

    IF v_units >= p_max_units AND NOT v_caught_up AND v_canceled IS NULL
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      v_capped := true;
    END IF;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        WHEN v_capped                        THEN 'partial'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; the slice rolled back whole, watermark unmoved, next firing retries it', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_capped
                          THEN left(format('unit cap reached — %s unit(s) run%s', v_units,
                                 CASE WHEN v_backoff THEN ' then BACKOFF tripped' ELSE '' END), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'units_run',       v_units,
                        'unit_capped',     v_capped,
                        'caught_up',       v_caught_up,
                        'canceled',        v_canceled IS NOT NULL,
                        'cancel_detail',   v_canceled,
                        'backoff_tripped', v_backoff,
                        'rows_written',    v_rows,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        'watermark_after', (SELECT value->>'last_indexed_at'
                                              FROM public.pipeline_state
                                             WHERE key = 'financial_entity_totals_watermark'),
                        'units',           v_unit_log)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-crawl] % — % unit(s), % rows, watermark now %',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'FAILED'
         WHEN v_caught_up THEN 'CAUGHT UP'
         WHEN v_capped THEN 'UNIT CAP' ELSE 'complete' END,
    v_units, v_rows,
    (SELECT value->>'last_indexed_at' FROM public.pipeline_state
      WHERE key = 'financial_entity_totals_watermark');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.run_fe_totals_crawl(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_fe_totals_crawl(integer) TO service_role;

COMMIT;
