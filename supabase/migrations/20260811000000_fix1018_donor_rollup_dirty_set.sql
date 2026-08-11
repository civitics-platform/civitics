-- =============================================================================
-- FIX-1018 — the donor rollup's cost moved one level up, outside FIX-1002's
--            guard, into the dirty-set build nobody was measuring.
--
-- ═══ The incident ═══════════════════════════════════════════════════════════
-- 2026-08-10 12:00 UTC, cron jobid 24. `data_sync_log` metadata, verbatim:
--
--   { "chunks": 1, "recipients_done": 1, "slowest_chunk_seconds": 75,
--     "elapsed_seconds": 9367, "dirty_recipients": 2889,
--     "stop_reason": "budget_exhausted", "budget_seconds": 7200 }
--
-- One chunk of 75 s inside a run of 9,367 s. `v_started` is stamped at
-- procedure entry and `v_elapsed` is read at the top of each loop iteration, so
-- **9,292 of those 9,367 seconds elapsed before the first chunk finished, and
-- 75 of them were the chunk.** 99.2% of a 2h36m window went to work that
-- happens before iteration 1 exists.
--
-- The only substantial thing between procedure entry and the loop is the
-- dirty-set build. FIX-1002 armed its budget guard from chunk 1 — correctly —
-- but a guard that can only be evaluated inside the loop cannot see the cost
-- that precedes the loop. Same blind spot as FIX-1002 and FIX-972 before it,
-- one level up. Playbook C3.
--
-- ═══ Three measured causes, all fixed here ══════════════════════════════════
--
-- (1) A `BitmapAnd` leg that reads 6.6M index entries to contribute nothing.
--     `EXPLAIN (ANALYZE, BUFFERS)` of the live dirty-set query on prod
--     2026-08-11 03:12 UTC, quiet box (nothing had fired since 08-10 14:18,
--     ~2 h uptime after the 01:08 restart):
--
--       Aggregate (actual time=52827.066..52827.069)
--         Buffers: shared hit=2 read=156677                      <- 99.998% miss
--         -> Bitmap Heap Scan on financial_relationships (rows=181616)
--              Heap Blocks: exact=78525
--            -> BitmapAnd (actual time=27609.559..27609.561)
--               -> Bitmap Index Scan financial_relationships_updated_at
--                    (actual time=118.511..118.511 rows=181717)  Buffers: read=234
--               -> Bitmap Index Scan financial_relationships_donor_rollup_idx
--                    (actual time=27480.162 rows=6628447)        Buffers: read=77918
--       Execution Time: 52841.335 ms
--
--     `donor_rollup_idx` is (to_id, relationship_type, from_id) — neither
--     `relationship_type` nor `from_type` is a leading column, so the planner
--     full-scans a 618 MB index to build one side of an AND whose other side
--     already returned in 118 ms. It "saves" heap blocks the scan then reads
--     anyway (78,525 exact). **52% of the query's runtime, for nothing.**
--
--     52.8 s against a 7,200 s budget is 0.7% — survivable. On 08-10 it ran
--     concurrently with `rebuild-ec-incremental-mon` (08:00→14:13, killed by
--     the 6 h timeout) and `entity-connection-stats-rebuild` (11:00→17:00,
--     same axe), both evicting a 256 MB shared_buffers pool. It degraded ~176x,
--     to 129% of the whole budget. Playbook C4: runtime measurements are floors.
--
-- (2) No `to_type = 'official'` filter. Measured on prod, same watermark:
--
--       to_type          | recipients | fr_rows
--       financial_entity |       1640 |   52201
--       official         |       1250 |  129415
--
--     **57% of the "recipients" are financial_entities**, which
--     `donor_rollup_rebuild_recipients()`'s official-scoped arms cannot roll up.
--     The FEC indiv stage writes donor→super-PAC/party/other-PAC rows
--     (`to_type='financial_entity'`), so after a full FEC run they are the
--     majority. Three consequences, all measured:
--       * The cursor is uuid-ordered and type-blind, so the head of the sweep
--         was `003a1690-…` = NATIONAL ASSOCIATION OF CONVENIENCE STORES PAC.
--         The run's entire window and its only chunk went to a PAC.
--       * 1,640 of them have no `official_donor_totals` row, so each is weighted
--         at `c_weight_default` = 1500: **2,460,000 of the 4,587,430 total dirty
--         weight (54%) is fabricated for rows that produce nothing**, which
--         oversizes chunks and corrupts the guard's own projections.
--       * Dropping them takes the dirty set 2,890 → 1,250 (and a `full`/
--         bootstrap enumeration 15,478 → 6,995).
--
--     Safety, checked before writing this (the FIX-704 invariant is that
--     wasteful re-enumeration is fine and a silently-skipped dirty recipient is
--     not): within the dirty window, `to_type='official'` and membership in
--     `officials` agree **exactly** — 1,250 of 1,250 in, 0 of 1,640 in. There
--     is no official reachable only via a non-'official' to_type.
--
-- (3) The pre-loop cost was invisible. Every log line this procedure writes
--     describes the loop. The only reason FIX-1018 was findable at all is the
--     `chunks` / `slowest_chunk_seconds` / `elapsed_seconds` triple visibly
--     disagreeing. That is not a diagnostic; that is a coincidence.
--
-- ═══ What this migration changes ════════════════════════════════════════════
--
--   1. `AND fr.to_type = 'official'` on EVERY site that enumerates rollup
--      recipients out of `financial_relationships`. Census by mechanism, not by
--      name (playbook E5) — `pg_get_functiondef` over every plpgsql/sql routine
--      in `public` matching the predicate shape:
--
--        refresh_official_donor_rollup_incremental()  2 branches  <- CHANGED
--        donor_rollup_rebuild_bulk()  (_drb_targets)  2 branches  <- CHANGED
--        refresh_official_donor_rollup_mv()           1 branch    <- CHANGED
--        donor_rollup_rebuild_recipients(uuid[])      takes an explicit uuid[]
--                                                     — not an enumeration site
--        reconcile_donor_rollup_orphans()             an anti-join driven BY the
--                                                     rollup table, no
--                                                     updated_at, no
--                                                     enumeration — and adding
--                                                     the filter there would
--                                                     widen a DELETE. Left alone
--                                                     deliberately.
--        rebuild_entity_connections_donations{,_full}(),
--        rebuild_ec_donations_full_window()           entity_connections, a
--                                                     different consumer with
--                                                     its own semantics. Not
--                                                     touched.
--
--      `donor_rollup_rebuild_bulk()`'s per-chunk `_drb_donor` scan is NOT
--      filtered: it joins `_drb_targets`, which is now official-only, so the
--      restriction already applies. Adding a redundant predicate to the scan
--      whose byte-identity with the per-recipient path FIX-974 proved is not
--      worth the blast radius.
--
--   2. A partial covering index matching the dirty-set predicate exactly, so
--      the planner takes the 118 ms `updated_at` leg alone. Shape below.
--
--   3. The pre-loop work is brought INSIDE the budget: elapsed is stamped
--      immediately after the dirty-set build, always recorded as
--      `dirty_set_build_seconds`, and if it already exceeds half the budget the
--      run refuses to enter the loop with
--      `stop_reason: 'dirty_set_build_exhausted_budget'`.
--
--   4. The in-flight sweep's cursor is reset (see "Cursor reset" below).
--
-- ═══ On the index shape — a deliberate deviation, with the evidence ═════════
-- The obvious minimal index is `(updated_at) WHERE <predicate>`. This ships
-- `(updated_at) INCLUDE (to_id) WHERE <predicate>` instead. Three measurements
-- on prod, same watermark, in the order they were run (playbook B3 — a
-- self-warmed EXPLAIN settles nothing, so the "before" ran first, on a box
-- with no other non-idle backend):
--
--   A. current query, as-is                       52,841 ms   read 156,677
--   B. + to_type='official', no new index         21,956 ms   read  68,996
--   C. updated_at leg alone (other predicates
--      made non-indexable, to isolate the leg)     9,247 ms   read  78,576
--
-- B is the important one: adding `to_type` **alone does not fix the plan**. The
-- planner drops `donor_rollup_idx` and immediately substitutes
-- `financial_relationships_to` — a 4.23 M-entry scan for another 2,981 ms of
-- BitmapAnd. Still an AND, still a full index leg, still 69k cold reads. The
-- predicate change and the index are not alternatives; they are one fix.
--
-- With the index, the qualifying set is 4,198,389 rows, of which the watermark
-- range selects 129,415 — ~3% of the index. `INCLUDE (to_id)` makes that an
-- index-only scan, which matters here specifically: the dirty-set query
-- projects `to_id` and nothing else, and measurement B shows 59,386 heap blocks
-- is what is left once the AND is gone. The INCLUDE costs ~16 bytes/entry
-- (~+67 MB on a table already carrying 4,870 MB of indexes, i.e. +1.4%) and
-- removes up to 59k random reads per firing, twice a day. If the visibility map
-- degrades — and `financial_relationships` is at 77.1% all-visible with zero
-- vacuum owners (FIX-1013) — the scan simply falls back to heap fetches, i.e.
-- to the cost of the plain `(updated_at)` shape. It degrades to the baseline,
-- never below it.
--
-- Playbook C7, stated honestly rather than waved at: `financial_relationships`
-- takes 0.00% HOT updates, carries 16 indexes, and this index is keyed on the
-- one column `set_updated_at` changes on every single write. Every qualifying
-- write will maintain it. Accepted because (a) it is partial, so only
-- donation/IE-to-official rows pay, (b) the read it serves was 57% of a 53 s
-- query firing twice daily against a cache-starved box, and (c) FIX-1008
-- already cut qualifying write volume ~86%.
--
-- BUILD STRATEGY: plain transactional `CREATE INDEX IF NOT EXISTS`, matching
-- repo precedent (FIX-195 / FIX-335 / FIX-504 / FIX-745 / FIX-883). Unlike
-- those, `financial_relationships` IS write-heavy (the FEC/USASpending
-- pipelines), and the build-time SHARE lock blocks writers on a 3.5 GB table
-- for the duration. **Pre-build CONCURRENTLY against prod BEFORE pushing this
-- migration** — `IF NOT EXISTS` then makes the push a no-op:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_relationships_donor_rollup_dirty_idx
--     ON public.financial_relationships (updated_at) INCLUDE (to_id)
--     WHERE to_type = 'official' AND from_type = 'financial_entity'
--       AND relationship_type IN ('donation', 'ie_support', 'ie_oppose');
--
-- No `ANALYZE public.financial_relationships` here: `CREATE INDEX` sets the new
-- index's own `pg_class` stats, the partial predicate is evaluated against
-- column statistics that already exist, and a full ANALYZE of a 3.5 GB table on
-- a 256 MB-buffer box is real I/O this migration does not need to spend.
--
-- ═══ Cursor reset — deliberate, and why this shape ══════════════════════════
-- At authoring time prod holds an in-flight sweep: `last_indexed_at`
-- 2026-08-08 22:59:39, `sweep_cursor` 003a1690-…, `sweep_target`
-- 2026-08-10 03:57:17, `sweep_failures` 0.
--
-- Resuming that cursor under the NEW predicate would enumerate
-- `to_id > 003a1690-…` only. Every dirty official whose uuid sorts below that
-- cursor — ~0.9% of uuid space, ~11 of the 1,250 — would be skipped, and they
-- were never processed: the 08-10 run committed exactly one chunk containing
-- exactly one PAC. **That is a silent skip of a recipient dirtied since
-- `last_indexed_at`, which is precisely what the FIX-704 invariant forbids.**
-- Wasteful re-enumeration is acceptable; this is not.
--
-- So the sweep is restarted, using the procedure's OWN idiom for it (the
-- "sweep finished but a chunk failed" branch): drop `sweep_cursor` /
-- `sweep_target` / `sweep_failures`, keep `last_indexed_at` and
-- `rows_per_second`. `last_indexed_at` is NOT advanced, so nothing dirtied
-- since 08-08 22:59:39 is lost; the next run captures a fresh `sweep_target`
-- ≥ the old one, so the 08-08→08-10 window is re-covered rather than dropped.
-- Cost of the restart: re-enumerating 1,250 officials, 0 of which had been
-- rolled up. Nothing is thrown away.
--
-- Note "clear the cursor but keep the target" is not a distinct option: with
-- `v_cursor` NULL the procedure takes the fresh-sweep branch and recaptures
-- `v_new_max` unconditionally, so the kept target would be overwritten anyway.
--
-- `donor_rollup_bulk_sweep` (parked at chunk 16/32) is deliberately NOT touched
-- — FIX-1007 owns it. It needs no touch here regardless: `_drb_targets` and
-- `_drb_fe` both read 0 rows on prod (UNLOGGED, crash-truncated by the 01:08
-- restart), so `donor_rollup_rebuild_bulk()`'s own guard ("target staging empty
-- (crash recovery truncates UNLOGGED tables)") discards the in-flight sweep and
-- restarts from chunk 0 under the new predicate. Self-healing.
--
-- ═══ A consequence this migration does NOT fix, filed separately ════════════
-- Arm 1 (`official_donor_rollup_mv`) is the one arm written for ALL recipients,
-- not just officials — its DELETE/INSERT pair carries no `is_official` filter
-- in either regime. Measured on prod today: **1,004,949 rows, of which 438,094
-- across 8,369 non-official ids** (6,047 pac / 1,904 super_pac / 415
-- party_committee / 3 other). This is a designed FIX-704 property, documented
-- at apps/civitics/app/api/graph/connections/route.ts:392 ("the rollup keys
-- recipients of BOTH kinds").
--
-- After this change those 438k rows stop being refreshed. They are not deleted
-- either — `reconcile_donor_rollup_orphans()` only removes recipients with NO
-- surviving qualifying FR row. So they freeze rather than disappear. The
-- request path does not appear to read them (`/api/graph/connections` gates the
-- rollup behind `isOfficialFocus`, and `/api/graph/treemap-pac` keys on an
-- official), but "does not appear to" is not "does not", and a silently-frozen
-- 438k-row set is exactly the divergence class FIX-974b exists to refuse.
-- Filed as its own FIX rather than resolved here: deleting the rows or
-- re-scoping arm 1 are both behaviour changes that need their own sign-off, and
-- the other five arms hold **zero** non-official ids, so nothing else drifts.
--
-- DELIBERATELY NOT CHANGED: the 6 h role statement_timeout; `c_budget`;
-- `c_chunk_secs`; what `donor_rollup_rebuild_recipients()` computes; the
-- cursor/watermark semantics (FIX-704 / FIX-944); the Monday cron collision
-- (FIX-969); the pg_cron startup-timeout starvation (its own FIX).
--
-- Cross-ref FIX-1002, FIX-1003, FIX-1004, FIX-1007, FIX-1008, FIX-1013,
-- FIX-704, FIX-944, FIX-972, FIX-974, FIX-990, FIX-969.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The partial covering index. See the header for the shape rationale and the
--    CONCURRENTLY pre-build recipe for prod.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS financial_relationships_donor_rollup_dirty_idx
  ON public.financial_relationships (updated_at)
  INCLUDE (to_id)
  WHERE to_type = 'official'
    AND from_type = 'financial_entity'
    AND relationship_type IN ('donation', 'ie_support', 'ie_oppose');

COMMENT ON INDEX public.financial_relationships_donor_rollup_dirty_idx IS
  'FIX-1018 — partial covering index for the donor-rollup dirty-set build. '
  'Predicate matches refresh_official_donor_rollup_incremental() / '
  'donor_rollup_rebuild_bulk() / refresh_official_donor_rollup_mv() exactly so '
  'the planner can use it directly; INCLUDE (to_id) keeps the scan index-only, '
  'which is the whole projection. Without it the planner builds a BitmapAnd '
  'whose second leg full-scans financial_relationships_donor_rollup_idx '
  '(6.6M entries, 27.5s of a 52.8s query on prod 2026-08-11) or, once '
  'to_type=''official'' is added, financial_relationships_to (4.2M entries, '
  '3.0s of 22.0s) — neither of which contributes rows the updated_at leg has '
  'not already found in 118ms.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. refresh_official_donor_rollup_incremental() — to_type filter on both
--    dirty-set branches, plus the pre-loop budget stamp and refusal.
--
--    Body derived from the FIX-1002 definition (20260809000000). Changes are
--    marked `FIX-1018`; nothing else differs.
-- ─────────────────────────────────────────────────────────────────────────────
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
        AND fr.updated_at > v_watermark
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
    EXCEPTION WHEN OTHERS THEN
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

    -- COMMIT at the TOP LEVEL (PL/pgSQL forbids COMMIT inside an EXCEPTION
    -- subtransaction). Bounds txn size + advances xmin between chunks.
    COMMIT;

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
                'last_indexed_at', COALESCE(v_new_max, NOW())::text,
                'rows_per_second', round(COALESCE(v_rps_run, v_rps_seed)::numeric, 3)))
      ON CONFLICT (key) DO UPDATE
        SET value = jsonb_build_object(
                      'last_indexed_at', COALESCE(v_new_max, NOW())::text,
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

COMMENT ON PROCEDURE public.refresh_official_donor_rollup_incremental() IS
  'FIX-704/832/944/972/1002/1018 — incremental refresh of the six per-official '
  'money rollups via donor_rollup_rebuild_recipients(). FIX-944: resumable — a '
  'cursor (pipeline_state.donor_rollup_watermark.sweep_cursor) is advanced '
  'inside each chunk transaction. FIX-1002: chunks are sized by COST (summed '
  'official_donor_totals.donor_count) rather than by recipient count; the '
  'budget guard is armed FROM CHUNK 1; the budget is 2h, below the 3h gap '
  'between firings, because pg_cron QUEUES the next firing rather than skipping '
  'it; a firing will not START at or after 13:00 UTC; the loop yields 10% of '
  'each chunk''s duration (capped 15s). FIX-1018: the dirty set is restricted '
  'to to_type=''official'' (57% of enumerated recipients were financial_'
  'entities the arms cannot roll up, contributing 54% fabricated dirty weight '
  'and parking the uuid-ordered cursor on a PAC), it is served by '
  'financial_relationships_donor_rollup_dirty_idx, and the PRE-LOOP build time '
  'is now measured as dirty_set_build_seconds on every run and refuses to enter '
  'the loop past half the budget (on 2026-08-10 that unguarded pre-loop region '
  'was 9,292 of a 9,367s run). Session GUC overrides: civitics.donor_rollup_'
  '{budget_seconds,chunk_target_seconds,chunk_size,ignore_start_window,'
  'latest_start_hour,dirty_set_budget_fraction}. Break-glass single-pass: '
  'packages/data/src/scripts/donor-rollup-sweep.ts. Converging a large backlog '
  'is donor_rollup_rebuild_bulk()''s job, not this one''s — see FIX-1004.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. refresh_official_donor_rollup_mv() — the FIX-518/704 one-shot refresher.
--
--    Same dirty-set shape, unchunked, callable over PostgREST and used by the
--    Franklin seed. Left unfiltered it would re-introduce the PAC enumeration
--    on every manual/seed invocation. One line changes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_official_donor_rollup_mv()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_watermark timestamptz;
  v_new_max   timestamptz;
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

  SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty
  FROM public.financial_relationships fr
  WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
    AND fr.from_type = 'financial_entity'
    AND fr.to_type = 'official'                                       -- FIX-1018
    AND fr.updated_at > v_watermark;

  IF COALESCE(array_length(v_dirty, 1), 0) > 0 THEN
    PERFORM public.donor_rollup_rebuild_recipients(v_dirty);
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_new_max, NOW())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. donor_rollup_rebuild_bulk() — the same filter on the _drb_targets build,
--    in BOTH the full and the dirty branch.
--
--    Body rebuilt verbatim from 20260807010000 (FIX-974b, the live definition);
--    the two marked lines are the only changes. Note the per-chunk _drb_donor
--    scan is deliberately NOT filtered — it joins _drb_targets, which these two
--    lines have already restricted (see the header).
--
--    `is_official` stays a real LEFT JOIN result rather than a constant: a
--    to_type='official' row pointing at a nonexistent officials.id would still
--    be flagged false and correctly skipped by arms 2–6. Measured 0 such rows
--    in the live dirty window, but the arms' behaviour is unchanged either way.
-- ─────────────────────────────────────────────────────────────────────────────
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
    VALUES ('donor_rollup_bulk', 'skipped', now(), now(),
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
          AND fr.updated_at > v_watermark
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

    v_sweep_beg := now();
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
  VALUES ('donor_rollup_bulk', 'running', now(),
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
        (official_id, total_cents, pac_cents, individual_cents, donor_count)
      SELECT d.to_id,
             SUM(d.total_cents0)::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
             SUM(d.tx_count)::bigint
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
      SELECT d.to_id, SUM(d.small_cents)::bigint, SUM(d.small_count)::bigint, now()
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
             now()
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
    EXCEPTION WHEN OTHERS THEN
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;

    v_done := v_done + 1;
    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    RAISE NOTICE '[donor-rollup bulk] chunk %/% done (%s, % arm-1 rows so far)',
      k + 1, c_chunks, round(v_chunk_secs)::int, v_rows;
  END LOOP;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = now(), error_message = left(v_failed, 1000),
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
       SET status = 'partial', completed_at = now(), rows_inserted = v_rows,
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
          jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, now())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, now())::text),
        updated_at = clock_timestamp();

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', now()::text,
                                    'mode', v_mode, 'chunks', c_chunks,
                                    'targets', v_n_targets),
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  TRUNCATE public._drb_donor;
  TRUNCATE public._drb_chunk_fe;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = now(), rows_inserted = v_rows,
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Reset the in-flight incremental sweep (see "Cursor reset" in the header).
--
--    Uses the procedure's own idiom for discarding a sweep: drop the three
--    sweep keys, keep last_indexed_at and rows_per_second. Guarded on the
--    cursor's presence so this is a no-op wherever no sweep is in flight.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.pipeline_state
   SET value = (value - 'sweep_cursor' - 'sweep_target' - 'sweep_failures'),
       updated_at = NOW()
 WHERE key = 'donor_rollup_watermark'
   AND value ? 'sweep_cursor';
