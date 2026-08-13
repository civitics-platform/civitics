-- ─────────────────────────────────────────────────────────────────────────────
-- FIX-1030 — the one weekly unit that took prod down twice, and the bound that
-- stops any unit doing it again.
--
-- ── WHAT HAPPENED ──────────────────────────────────────────────────────────
-- `refresh_derived_mvs('weekly')` failed catastrophically on both of its last
-- two firings, and both times on the SAME unit — unit 3,
-- `chord_donor_state_party_flows_mv`:
--
--   2026-08-11 07:00  units 1-2 completed (262.6 s, 220.5 s), unit 3 never
--                     logged a completion. pg_cron could not launch a worker
--                     from 07:30; postgres stopped logging at 08:29 and stayed
--                     dark 14h22m until an administrator's fast shutdown.
--   2026-08-13 01:05  units 1-2 completed (189.4 s, 143.6 s), unit 3 began
--                     ~01:10:43 and the instance CRASHED at 01:45:27.788819
--                     (unclean: pg_stat_bgwriter.stats_reset 114 ms after
--                     pg_postmaster_start_time, no shutdown checkpoint).
--
-- Its two siblings finish in ~3 minutes every time and got FASTER after the
-- FIX-1013 vacuum, so bloat was already ruled out as the mechanism.
--
-- ── THE MECHANISM — a plan flip, evidenced by controlled comparison ─────────
-- Prod's plan for unit 3 is a Nested Loop whose inner side is
-- `Memoize → Index Scan using financial_entities_pkey`, driven by ~950k outer
-- rows. Its siblings use Parallel Hash Join. Three defects had to hold at once:
--
--  (1) A 299x UNDERESTIMATE of the financial_entities filter. The predicate
--      `LENGTH(metadata->>'state') = 2` is an expression no index and no
--      statistics object covers, so the planner falls back to its hardcoded
--      DEFAULT_EQ_SEL (0.005). Prod estimates 10,714 rows out of 3,679,374.
--      MEASURED TRUTH on the prod-scale clone: 3,198,178 — 87.13%.
--      That is what makes the nested loop's inner side look ~300x too small.
--
--  (2) A 41x UNDERESTIMATE of n_distinct(financial_relationships.from_id):
--      pg_stats says 42,267 (prod) / 42,600 (clone); MEASURED 1,745,921
--      distinct donors across 4,183,604 qualifying donation rows. That makes
--      Memoize look like it will serve ~96% of probes from cache. It cannot.
--      This is the cost discount that makes the nested loop win: with Memoize
--      forced off, prod's own planner prices the same shape at 649,291 and the
--      hash join at 756,100 — the nested loop only wins at 613,522 BECAUSE of
--      the phantom cache-hit rate.
--
--  (3) `random_page_cost = 1.1` on prod (the Supabase default; stock postgres
--      and this project's local Docker are both 4). Isolated one-at-a-time on
--      the clone, this is the SINGLE setting that flips the plan: with only
--      random_page_cost changed, local reproduces prod's Nested Loop + Memoize
--      exactly (cost 602,475 local vs 607,984 prod). It prices ~950k random
--      pkey probes + heap fetches into a 1,632 MB heap as nearly free. On a box
--      with shared_buffers = 256 MB they are real disk reads — which is exactly
--      the `wait_event_type='IO' / DataFileRead` observed for ~35 minutes.
--
-- ── WHY IT STARTED ON 08-11 AND NOT BEFORE ─────────────────────────────────
-- (1)-(3) are all long-standing. The TRIGGER was FIX-1018's partial index
-- `financial_relationships_donor_rollup_dirty_idx`, built ~03:00 UTC on
-- 2026-08-11 — FOUR HOURS before the first catastrophic firing. Its predicate
-- (to_type='official' AND from_type='financial_entity' AND relationship_type IN
-- (donation, ie_support, ie_oppose)) covers unit 3's WHERE clause almost
-- exactly, so it handed the nested loop a cheaper outer path than it had ever
-- had: bitmap startup 17,539 vs 41,217, and 953,828 estimated rows vs
-- 1,519,884. That dropped the nested loop's total 19% BELOW the hash join and
-- flipped the plan. The index is not at fault and is not touched here — it made
-- a pre-existing misestimate reachable.
--
-- The siblings are immune for a structural reason: unit 2 LEFT JOINs
-- financial_entities with NO metadata predicate, so there is no misestimated
-- filter to shrink an inner side, and it carries only entity_type (width 26)
-- instead of the whole metadata jsonb (width 163).
--
-- ── MEASURED, on the prod-scale clone with prod's random_page_cost ──────────
-- EXPLAIN (ANALYZE, BUFFERS) on the pathological plan. Every estimate above is
-- confirmed by an actual, and the Memoize line is the whole story in one row:
--
--   Memoize  Hits: 2,328,993  Misses: 1,854,611  Evictions: 869,096
--            Memory Usage: 262,145 kB
--
-- 1,854,611 misses across 4,183,604 probes is a 44.3% miss rate against a cost
-- model that assumed ~99% hits, and 869,096 evictions is the cache thrashing
-- exactly as 1.75M distinct keys guarantees it must. Note the memory: Memoize
-- sizes itself at work_mem x hash_mem_multiplier = 128MB x 2 = 256 MB, so this
-- ONE node is permitted to allocate the entire size of prod's shared_buffers.
-- That is the OOM-consistent shape; no server memory parameter is tuned here.
--
-- Row estimates vs actuals in the same plan:
--   financial_entities filter    est     10,714   actual  3,198,178   (298.5x)
--   nested-loop join output      est      4,722   actual  3,593,976   (761.1x)
--
-- Buffer accounting — the cache-independent measure, and the one that matters,
-- because on prod a `read` is a real disk read against 256 MB of shared_buffers:
--
--   BEFORE  (nested loop)  shared hit 4,846,089 + read 2,906,376 = 7,752,465
--   AFTER   (this fix)     shared hit     4,413 + read   509,591 =   514,004
--   SIBLING (unit 2, ok)                          read   498,015 =   498,015
--
-- 15.1x less buffer traffic overall, and 41.2x on the financial_entities access
-- specifically (7,418,444 -> 179,993). More important than the ratio is the
-- ACCESS PATTERN: 1.85M scattered pkey descents plus heap fetches become one
-- sequential scan. The fixed unit now sits within 3% of its healthy sibling —
-- that is what "sibling-class" means here, stated in physical work rather than
-- in a wall clock.
--
-- ⚠ WALL CLOCK ON THE CLONE IS NOT THE INSTRUMENT, and this contradicts the
-- expectation the investigation started from. The clone reproduces the PLAN
-- exactly but NOT the ~35-minute hang: it completes the original in 23.5-37 s,
-- because this box's OS page cache holds the whole 1,632 MB financial_entities
-- heap, so the probes that are physical disk reads on prod are RAM hits here.
-- The clone could therefore never have reproduced the outage by duration, only
-- by plan and by I/O demand — which is why the evidence above is buffer counts
-- and Memoize statistics rather than seconds. Prod's cache starvation is
-- separately documented (shared_buffers 256 MB, ~54% hit rate baseline).
--
-- ── THE FIX (section 1): make the plan unable to flip ──────────────────────
-- The FE filter and the state extraction are hoisted into a CTE with an
-- explicit `AS MATERIALIZED` optimiser fence. Three consequences:
--   * financial_entities is scanned ONCE, sequentially. There is no index on a
--     CTE, so no parameterised inner path exists and the nested loop is not
--     merely unattractive — it is unavailable. The fix does not depend on the
--     planner estimating anything correctly, which is the point: estimates (1)
--     and (2) are still wrong and are not fixed here.
--   * only (id, 2-char state) crosses the join — width 48 instead of 163. The
--     hash table drops from ~520 MB (which spills against work_mem=128MB) to
--     ~154 MB.
--   * `metadata->>'state'` is extracted ONCE per FE row instead of four times
--     per row (it appeared in SELECT, GROUP BY, and three WHERE quals).
--
-- Output is IDENTICAL. `LENGTH(x) = 2` already subsumes `x IS NOT NULL` (
-- LENGTH(NULL) is NULL, so NULL = 2 is not true) and `x <> ''` (LENGTH('') = 0),
-- so collapsing the three quals to one is a no-op on the result set, verified
-- by full-outer-join parity against the pre-change contents.
--
-- ── THE BOUND (sections 2-4): why NOT `SET LOCAL statement_timeout` ─────────
-- The obvious per-unit bound does not work, and this was re-verified on PG 17
-- this session rather than taken on trust:
--
--   NOTICE:  B: statement_timeout after SET LOCAL = 2s
--   NOTICE:  C: pg_sleep(8) COMPLETED — SET LOCAL did NOT bound the unit
--   NOTICE:  D: statement_timeout after plain SET = 2s
--   NOTICE:  E: pg_sleep(8) COMPLETED — plain SET did NOT bound the unit
--
-- `statement_timeout` is armed ONCE, in start_xact_command(), from the value in
-- force when the CALL arrives. A procedure's internal COMMIT goes through
-- SPI/_SPI_commit, which never re-arms it. `current_setting()` dutifully
-- reports the new value while the actual timer keeps the old deadline. This is
-- the same finding FIX-703 paid for in 2026-07 and it still holds. pg_cron
-- cannot work around it either: `SET …; CALL …` fails with "invalid transaction
-- termination" because pg_cron wraps a multi-statement command in one implicit
-- transaction, making the procedure's COMMIT illegal.
--
-- So the only thing that CAN interrupt a running unit is a cancel from OUTSIDE
-- the backend. That is what sections 2-4 build, and it lands on machinery that
-- already exists: `pg_cancel_backend` raises query_canceled (57014), which is
-- precisely what FIX-1021's by-name handler already catches — it records which
-- unit died, EXITs the loop, and lets the trailing UPDATE close the row
-- `partial`. Nothing about that path is new or unproven here; this migration
-- only supplies the signal it was already waiting for.
--
--   section 2  refresh_derived_mvs() publishes (current_unit, started_at, pid)
--              and COMMITs it BEFORE each unit, so an outside observer can see
--              which unit is running and for how long. Also strips those keys
--              on completion so a finished row never looks mid-unit.
--   section 3  enforce_derived_mvs_unit_budget() — reads the open row, and if
--              the current unit has outlived its budget AND that pid is still
--              the backend running this procedure, cancels it once.
--   section 4  a 2-minute pg_cron job that calls it.
--
-- ── THE BUDGET VALUE: 900 s ────────────────────────────────────────────────
-- Sized from MEASURED per-unit times, not from the cron expression (playbook
-- D2). The slowest healthy unit ever observed on prod is 262.6 s (unit 1,
-- 08-11, recovered from auto_explain); the 08-12 band for the same unit was
-- 185-198 s.
--
-- Units 4-6 had never been measured at all — the FIX-1021 instrumentation
-- shipped on 08-13 and the run that would have recorded them died. A full
-- post-fix weekly cadence on the prod-scale clone supplies them, and it is the
-- reason this budget can be chosen rather than guessed:
--
--   chord_industry_flows_mv           26.5 s      (sibling, healthy)
--   chord_donor_type_party_flows_mv   20.0 s      (sibling, healthy)
--   chord_donor_state_party_flows_mv  18.7 s      <- was unbounded; now 3rd fastest
--   chord_subject_party_flows_mv       1.2 s
--   official_sector_dollars_mv         3.2 s
--   refresh_spending_totals           15.7 s
--   ---------------------------------------------
--   6/6 units, status 'complete', 85 s total
--
-- The clone runs ~7x faster than prod on these units (prod 189/143 s where the
-- clone is 26.5/20.0 s), so the prod-equivalent worst unit stays ~263 s and no
-- weekly unit comes within an order of magnitude of 900 s. 900 s is therefore
-- ~3.4x the slowest healthy unit — deliberately generous, because FIX-1021's
-- own header warns that "a breaker that trips every Tuesday is a breaker nobody
-- should have shipped" — while still firing ~20 minutes before the point at
-- which this unit crashed the instance on 08-13, and ~35 minutes before pg_cron
-- worker starvation began on 08-11. The daily cadence's 13 units are lighter
-- still (healthy daily totals are 354-816 s across all of them).
--
-- GUC-overridable via civitics.derived_mvs_unit_budget_seconds. The procedure
-- writes the value it is running under into metadata.unit_budget_seconds, and
-- the watchdog reads it FROM THERE first — so a supervised manual CALL that
-- sets the GUC is honoured by a watchdog running in a different session.
--
-- Cross-ref FIX-1021 (the budget + the query_canceled handler this reuses),
-- FIX-1018 (the index that triggered the flip), FIX-1013 (the vacuum owners
-- that ruled bloat out), FIX-1028 (the same handler idiom), FIX-1003b (the
-- matview autovacuum settings re-applied in section 1), FIX-443 / FIX-884.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FIX-1030 — chord_donor_state_party_flows_mv: fence the plan.
--
--    A materialised view's definition cannot be replaced in place, so this is a
--    DROP + CREATE. Unlike the rest of this migration, that DOES execute the
--    (fixed) query once, to repopulate — there is no way to change an MV's
--    definition without either running it or leaving it unscannable, and
--    leaving it unscannable would break the /graph chord read path until the
--    next weekly refresh. Apply off-peak against a quiet box.
--
--    Nothing depends on this MV (pg_depend: 0 dependent rewrite rules). The
--    reader `chord_donor_state_party_flows(UUID)` resolves it by name at plan
--    time and needs no change; its cohort branch is deliberately left alone,
--    because there the driving filter is a single official and a nested loop is
--    both correct and fast.
-- ─────────────────────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS public.chord_donor_state_party_flows_mv;

CREATE MATERIALIZED VIEW public.chord_donor_state_party_flows_mv AS
WITH donor_states AS MATERIALIZED (
  -- The fence. financial_entities is scanned once and projected narrow BEFORE
  -- it reaches the join, so no parameterised inner path exists for a nested
  -- loop to use. LENGTH(x) = 2 subsumes the original IS NOT NULL / <> '' quals.
  SELECT fe.id                        AS fe_id,
         UPPER(fe.metadata->>'state') AS donor_state
  FROM public.financial_entities fe
  WHERE LENGTH(fe.metadata->>'state') = 2
)
SELECT
  ds.donor_state,
  CONCAT_WS(' ',
    INITCAP(COALESCE(o.party::TEXT, 'other')),
    CASE
      WHEN o.role_title ILIKE '%representative%' THEN 'House'
      ELSE 'Senate'
    END
  )                                       AS party_chamber,
  (SUM(fr.amount_cents) / 100.0)::NUMERIC AS total_usd
FROM public.financial_relationships fr
JOIN public.officials o
  ON o.id = fr.to_id
 AND fr.to_type = 'official'
JOIN donor_states ds
  ON ds.fe_id = fr.from_id
 AND fr.from_type = 'financial_entity'
WHERE fr.relationship_type = 'donation'
  AND fr.amount_cents > 0
  AND o.source_ids->>'congress_gov' IS NOT NULL
GROUP BY ds.donor_state, party_chamber;

-- Required for REFRESH … CONCURRENTLY, which is how the weekly unit runs it.
CREATE UNIQUE INDEX chord_donor_state_party_flows_mv_pk
  ON public.chord_donor_state_party_flows_mv (donor_state, party_chamber);

GRANT SELECT ON public.chord_donor_state_party_flows_mv
  TO anon, authenticated, service_role;

-- Re-apply the FIX-1003b autovacuum override that the DROP discarded. Without
-- this the MV reverts to cluster defaults and a tiny relation never reaches its
-- autovacuum trigger — the FIX-884 shape at small scale.
ALTER MATERIALIZED VIEW public.chord_donor_state_party_flows_mv
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

COMMENT ON MATERIALIZED VIEW public.chord_donor_state_party_flows_mv IS
  'Donor home state x party/chamber donation totals. FIX-1030: the donor-state '
  'filter is hoisted into a CTE AS MATERIALIZED fence. Do NOT inline it — the '
  'planner underestimates LENGTH(metadata->>''state'')=2 by ~299x and '
  'n_distinct(from_id) by ~41x, and at random_page_cost=1.1 those two errors '
  'together make a Memoize-backed nested loop over financial_entities look 19% '
  'cheaper than the hash join. That plan took prod down on 2026-08-11 and '
  'crashed it on 2026-08-13.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FIX-1030 — refresh_derived_mvs(): publish the in-flight unit.
--
--    Unit list, order, budget, and the FIX-1021 handler are UNCHANGED. The only
--    behavioural additions are the per-unit publish + COMMIT before each unit,
--    the unit_budget_seconds recorded at run start, and stripping the publish
--    keys in the terminal UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_derived_mvs(p_cadence text)
LANGUAGE plpgsql
AS $procedure$
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
  -- FIX-1021 additions
  c_budget     double precision;         -- seconds; per-cadence, GUC-overridable
  v_budget_cfg int;
  v_started    timestamptz := clock_timestamp();
  v_unit_beg   timestamptz;
  v_unit_secs  double precision;
  v_max_unit   double precision := 0;
  v_elapsed    double precision := 0;
  v_unit_times jsonb := '{}'::jsonb;     -- label -> seconds, ALWAYS written
  v_skipped    text[] := ARRAY[]::text[];
  v_budget_hit boolean := false;
  v_canceled   text := NULL;             -- non-NULL = query_canceled caught
  v_status     text;
  -- FIX-1030 addition
  c_unit_budget int;                     -- seconds; per-UNIT, enforced externally
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
  SET work_mem = '128MB';

  -- FIX-1021: per-cadence budget. Measured 2026-08-12: work_mem is NOT the
  -- lever here (unit 1 measured 185 s at 256MB vs 198 s at 128MB, identical
  -- plan), so this stays as FIX-748 set it.
  c_budget := CASE p_cadence WHEN 'weekly' THEN 4200 ELSE 3300 END;
  v_budget_cfg := NULLIF(current_setting('civitics.derived_mvs_budget_seconds', true), '')::int;
  IF COALESCE(v_budget_cfg, 0) > 0 THEN
    c_budget := v_budget_cfg;
  END IF;

  -- FIX-1030: per-UNIT budget. Published for enforce_derived_mvs_unit_budget(),
  -- which runs in a different session and cannot read this session's GUC.
  -- NOTE: this procedure cannot enforce it itself — statement_timeout is armed
  -- once at CALL time and neither SET nor SET LOCAL re-arms it across a
  -- procedure's COMMIT (verified on PG 17; see the header and FIX-703).
  c_unit_budget := COALESCE(
    NULLIF(current_setting('civitics.derived_mvs_unit_budget_seconds', true), '')::int, 900);

  IF p_cadence = 'daily' THEN
    -- proposal/vote/comment/engagement-derived + co-located daily maintenance.
    -- FIX-748: rebuild_entity_search_index appended (daily superset — new
    -- entities land on the nightly ingest; TRUNCATE+INSERT is atomic per unit).
    v_labels := ARRAY[
      'proposal_trending_24h', 'proposal_popularity_24h', 'homepage_stats_mv',
      'official_homepage_stats_mv', 'entity_engagement_rollup_mv',
      'homepage_agency_counts_mv', 'commons_active_threads', 'pipeline_runtime_stats_mv',
      'rebuild_entity_search_index',
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
      'SELECT public.rebuild_entity_search_index()',
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
                             'budget_seconds', c_budget,
                             'unit_budget_seconds', c_unit_budget,
                             'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  FOR i IN 1 .. array_length(v_units, 1) LOOP
    v_cmd   := v_units[i];
    v_label := v_labels[i];

    -- FIX-1021 PREDICTIVE budget check (FIX-944 idiom): stop when the slowest
    -- unit observed so far, plus 25% headroom, would not fit in what remains.
    -- Deliberately BETWEEN units — playbook C3, a REFRESH cannot be interrupted
    -- from inside.
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    IF v_max_unit > 0 AND v_elapsed + (v_max_unit * 1.25) > c_budget THEN
      v_budget_hit := true;
      -- Everything from here on is skipped; name each one so the log says what
      -- is stale rather than just that something is.
      v_skipped := v_skipped || v_labels[i : array_length(v_labels, 1)];
      RAISE WARNING '[derived-mvs] budget guard — stopping before % (elapsed %s of %s budget, slowest unit %s); % unit(s) skipped',
        v_label, round(v_elapsed)::int, round(c_budget)::int, round(v_max_unit)::int,
        array_length(v_skipped, 1);
      EXIT;
    END IF;

    v_unit_beg := clock_timestamp();

    -- FIX-1030: publish the in-flight unit and COMMIT, so
    -- enforce_derived_mvs_unit_budget() — running in another session, on its
    -- own pg_cron cadence — can see WHICH unit is running, since when, and in
    -- which backend. Without this commit the watchdog sees nothing: everything
    -- this transaction writes is invisible to it until the unit ends, which is
    -- exactly the case it exists to handle.
    UPDATE public.data_sync_log
    SET metadata = metadata || jsonb_build_object(
                     'current_unit',            v_label,
                     'current_unit_index',      i,
                     'current_unit_started_at', v_unit_beg,
                     'backend_pid',             pg_backend_pid())
    WHERE id = v_log_id;
    COMMIT;

    BEGIN
      EXECUTE v_cmd;
      v_ok := v_ok + 1;
      RAISE NOTICE '  [derived-mvs] % — ok', v_label;
    EXCEPTION
      -- FIX-1021: query_canceled is NOT matched by OTHERS (PL/pgSQL trapping
      -- rules), and statement_timeout raises exactly that. Trapping it by name
      -- is the only way this procedure can close its own row. The docs' caution
      -- about swallowing user cancels is answered by the EXIT below: we stop the
      -- whole loop immediately and do nothing but bookkeeping afterwards, so a
      -- deliberate pg_cancel_backend still ends the run — it just ends it
      -- tidily instead of leaving a stranded 'running' row behind.
      -- FIX-1030: this is now also the landing point for the unit watchdog's
      -- cancel, which is why that watchdog needs no error path of its own.
      WHEN query_canceled THEN
        v_canceled := format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — CANCELED (statement_timeout, unit watchdog, or operator cancel): %', v_label, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('%s: %s', v_label, SQLERRM);
        RAISE WARNING '  [derived-mvs] % — FAILED: %', v_label, SQLERRM;
    END;

    -- Timing is recorded for EVERY outcome (ok, failed, canceled) — a unit that
    -- died at 6 h is the single most interesting number in the run.
    v_unit_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_unit_beg));
    v_unit_times := v_unit_times || jsonb_build_object(v_label, round(v_unit_secs::numeric, 1));
    IF v_unit_secs > v_max_unit THEN
      v_max_unit := v_unit_secs;
    END IF;

    COMMIT;

    IF v_canceled IS NOT NULL THEN
      -- The timer that fired is disarmed once it has thrown, so the bookkeeping
      -- UPDATE below still runs. Continuing the loop would not: the next unit
      -- would be starting on a box that has already proven it cannot finish one.
      IF i < array_length(v_units, 1) THEN
        v_skipped := v_skipped || v_labels[i + 1 : array_length(v_labels, 1)];
      END IF;
      EXIT;
    END IF;
  END LOOP;

  v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  v_status := CASE
                WHEN v_canceled IS NOT NULL THEN 'partial'
                WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                WHEN v_budget_hit THEN 'partial'
                ELSE 'complete'
              END;

  UPDATE public.data_sync_log
  SET status        = v_status,
      completed_at  = now(),
      rows_inserted = v_ok,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled mid-unit — %s; %s unit(s) skipped',
                                           v_canceled, COALESCE(array_length(v_skipped, 1), 0)), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_budget_hit
                          THEN left(format('budget exhausted after %ss of %ss — %s unit(s) skipped: %s',
                                           round(v_elapsed)::int, round(c_budget)::int,
                                           COALESCE(array_length(v_skipped, 1), 0),
                                           array_to_string(v_skipped, ', ')), 1000)
                        ELSE NULL
                      END,
      -- FIX-1030: strip the in-flight publish keys, so a terminal row never
      -- looks like it is mid-unit to the watchdog or to a human reading it.
      metadata      = (metadata
                        - 'current_unit' - 'current_unit_index'
                        - 'current_unit_started_at' - 'backend_pid')
                      || jsonb_build_object(
                        'units_ok', v_ok,
                        'unit_failures', COALESCE(array_length(v_failures, 1), 0),
                        'unit_seconds', v_unit_times,
                        'elapsed_seconds', round(v_elapsed::numeric, 1),
                        'slowest_unit_seconds', round(v_max_unit::numeric, 1),
                        'budget_hit', v_budget_hit,
                        'canceled', v_canceled IS NOT NULL,
                        'skipped_units', to_jsonb(v_skipped))
  WHERE id = v_log_id;

  RAISE NOTICE '[derived-mvs] % (cadence=%) — %/% units ok (% failures, % skipped, %ss elapsed)',
    upper(v_status), p_cadence, v_ok, array_length(v_units, 1),
    COALESCE(array_length(v_failures, 1), 0), COALESCE(array_length(v_skipped, 1), 0),
    round(v_elapsed)::int;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

COMMENT ON PROCEDURE public.refresh_derived_mvs(text) IS
  'Refreshes the daily (13-unit) or weekly (6-unit) derived-MV set under a '
  'predictive between-unit wall-clock budget (daily 3300s, weekly 4200s; GUC '
  'civitics.derived_mvs_budget_seconds overrides). FIX-1021: budget EXIT and a '
  'by-name query_canceled handler both close the data_sync_log row as partial '
  'rather than stranding it running, and per-unit durations are always written '
  'to metadata.unit_seconds. FIX-1030: the in-flight unit, its start time and '
  'the backend pid are published and COMMITted before each unit so '
  'enforce_derived_mvs_unit_budget() can bound a single unit from outside — '
  'this procedure cannot bound one itself, because statement_timeout is armed '
  'once at CALL time and no in-procedure SET re-arms it. Cadences share one '
  'advisory lock.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FIX-1030 — enforce_derived_mvs_unit_budget(): the per-unit bound.
--
--    SECURITY INVOKER on purpose. pg_cancel_backend against a postgres-owned
--    backend needs superuser or pg_signal_backend; the pg_cron job runs as
--    postgres and therefore has it. Making this SECURITY DEFINER would create a
--    "cancel any backend" primitive reachable by whoever holds EXECUTE, for no
--    benefit. EXECUTE is revoked from PUBLIC/anon/authenticated regardless
--    (FIX-834: Supabase default-grants EXECUTE on new functions).
--
--    Every early return is a REFUSAL to cancel. The dangerous failure direction
--    is cancelling something that should not be cancelled, so every check that
--    cannot be satisfied resolves to 'none'.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_derived_mvs_unit_budget(
  p_budget_seconds int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  r          record;
  c_budget   int;
  v_age      numeric;
  v_signaled boolean;
BEGIN
  SELECT l.id,
         l.metadata->>'cadence'                            AS cadence,
         l.metadata->>'current_unit'                       AS unit,
         (l.metadata->>'current_unit_started_at')::timestamptz AS unit_started,
         (l.metadata->>'backend_pid')::int                 AS pid,
         (l.metadata->>'unit_budget_seconds')::int         AS row_budget,
         (l.metadata ? 'watchdog_canceled_at')             AS already_acted
    INTO r
  FROM public.data_sync_log l
  WHERE l.pipeline = 'refresh_derived_mvs'
    AND l.status   = 'running'
  ORDER BY l.started_at DESC
  LIMIT 1;

  IF r.id IS NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'no running refresh_derived_mvs');
  END IF;

  -- Cancel at most once per run. Without this the watchdog would fire again two
  -- minutes later and cancel the procedure's own bookkeeping UPDATE — turning a
  -- clean 'partial' close back into the stranded 'running' row this whole line
  -- of work exists to eliminate.
  IF r.already_acted THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'already cancelled this run', 'log_id', r.id);
  END IF;

  -- A run that has not published a unit yet (or was written by a pre-FIX-1030
  -- procedure) is not something this function can reason about.
  IF r.unit IS NULL OR r.unit_started IS NULL OR r.pid IS NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'no in-flight unit published', 'log_id', r.id);
  END IF;

  c_budget := COALESCE(
    p_budget_seconds,
    r.row_budget,
    NULLIF(current_setting('civitics.derived_mvs_unit_budget_seconds', true), '')::int,
    900);

  v_age := EXTRACT(epoch FROM (clock_timestamp() - r.unit_started));
  IF v_age <= c_budget THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'within budget',
                              'unit', r.unit, 'unit_age_seconds', round(v_age, 1),
                              'budget_seconds', c_budget);
  END IF;

  -- Confirm the published pid is STILL a live backend running this procedure.
  -- After the 08-13 crash the row sat 'running' with a pid that no longer
  -- existed; pids are recycled, so cancelling on a stale pid alone could hit an
  -- unrelated backend. This is the guard against that.
  PERFORM 1
  FROM pg_stat_activity a
  WHERE a.pid     = r.pid
    AND a.datname = current_database()
    AND a.state  <> 'idle'
    AND a.query ILIKE '%refresh_derived_mvs%';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'none',
                              'reason', 'published pid is not a live refresh_derived_mvs backend',
                              'unit', r.unit, 'pid', r.pid, 'unit_age_seconds', round(v_age, 1));
  END IF;

  -- The cancel lands in the procedure's FIX-1021 `WHEN query_canceled` handler,
  -- which names the unit, EXITs the loop and closes the row 'partial'.
  v_signaled := pg_cancel_backend(r.pid);

  UPDATE public.data_sync_log
  SET metadata = metadata || jsonb_build_object(
                   'watchdog_canceled_at',   clock_timestamp(),
                   'watchdog_canceled_unit', r.unit,
                   'watchdog_unit_age_seconds', round(v_age, 1),
                   'watchdog_budget_seconds', c_budget)
  WHERE id = r.id;

  RAISE WARNING '[derived-mvs watchdog] cancelled unit % after %s (budget %s, cadence %, pid %)',
    r.unit, round(v_age)::int, c_budget, r.cadence, r.pid;

  RETURN jsonb_build_object('action', 'canceled', 'signaled', v_signaled,
                            'unit', r.unit, 'cadence', r.cadence, 'pid', r.pid,
                            'unit_age_seconds', round(v_age, 1),
                            'budget_seconds', c_budget, 'log_id', r.id);
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_derived_mvs_unit_budget(int) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_derived_mvs_unit_budget(int) IS
  'FIX-1030 — bounds a SINGLE refresh_derived_mvs unit from outside the '
  'backend running it. Cancels the published backend once if the in-flight '
  'unit has outlived metadata.unit_budget_seconds (default 900s); the cancel '
  'lands in the procedure''s FIX-1021 query_canceled handler, which names the '
  'unit and closes the row partial. Exists because statement_timeout is armed '
  'once at CALL time and no in-procedure SET re-arms it across a COMMIT, so a '
  'unit cannot bound itself. Every unsatisfied check refuses to cancel.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. FIX-1030 — the watchdog cadence.
--
--    Every 2 minutes, unconditionally, NOT windowed to the cron schedules. The
--    firing that crashed prod on 2026-08-13 was a supervised MANUAL call at
--    01:05 UTC — a watchdog that only ran during the 06:00/07:00 cron windows
--    would not have been running for it. Worst-case detection lag is therefore
--    one interval: a unit is cancelled at most 900 + 120 s after it starts.
--
--    The cost of a firing when nothing is running is one indexed lookup on
--    data_sync_log (1,604 rows, 1 MB, idx_data_sync_log_pipeline) and a return.
--    The background-worker pressure this project watches (FIX-1022,
--    max_worker_processes = 12) comes from jobs that HOLD a worker for hours;
--    this one holds it for milliseconds, a ~0.01% duty cycle.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('derived-mvs-unit-watchdog');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

SELECT cron.schedule(
  'derived-mvs-unit-watchdog',
  '*/2 * * * *',
  'SELECT public.enforce_derived_mvs_unit_budget();'
);
