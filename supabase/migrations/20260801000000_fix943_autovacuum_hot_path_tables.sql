-- =============================================================================
-- FIX-943 — per-table autovacuum settings on the hot-path tables, plus a
-- detector signal for "dead tuples high but BELOW the proportional threshold".
--
-- -------------------------------------------------------------------------
-- CORRECTION TO FIX-943's BULLET (measured on PROD 2026-08-01 05:02 UTC)
-- -------------------------------------------------------------------------
-- The bullet computes financial_relationships' autovacuum trigger with the
-- CLUSTER default scale factor (0.2) and concludes "1,663,805 dead tuples
-- required before autovacuum even considers the table" / "mathematically never
-- fires". That is wrong on its central number. financial_relationships already
-- carries a per-table override — presumably from the FIX-331/FIX-884 work:
--
--   financial_relationships  autovacuum_vacuum_scale_factor  = 0.05
--                            autovacuum_analyze_scale_factor = 0.02
--
-- so its real trigger is 50 + 0.05 * 8,208,155 = 410,458, NOT 1,663,805. The
-- 411,555 dead tuples measured on 07-30 were therefore ~1,100 tuples PAST the
-- line, not 1.25M short of it — and prod confirms autovacuum did fire on it
-- (last_autovacuum 2026-07-30 05:28:12, autovacuum_count 7). The table is not
-- in a "never fires" state and never was.
--
-- The defect is real but differently shaped: 410,458 is the FLOOR OF BLOAT the
-- table is permitted to accumulate before anything happens. A page loses its
-- all-visible mark if ANY tuple on it is dead, and these tables carry 4.6-60
-- tuples per page, so a few-percent dead ratio un-marks a large fraction of the
-- heap. Percent-dead is a bad proxy; pages-touched is the thing that kills
-- index-only scans. That is the FIX-884 consequence (0.9% all-visible → 34,534
-- heap fetches), reached by a different route.
--
-- -------------------------------------------------------------------------
-- WHAT THE MEASUREMENT ACTUALLY SHOWS — the class, not the one table
-- -------------------------------------------------------------------------
-- Every large public table on prod, 2026-08-01, sorted by visibility map:
--
--   table                                pct_all_visible  dead%   tuned?
--   donor_party_rollup_mv                     42.7%       19.92%    no
--   votes                                     61.1%       12.55%    no
--   external_source_refs                      63.8%       15.04%    no
--   external_relationships_review_queue       65.0%        0.42%    no
--   financial_entities                        77.3%       13.12%    no
--   proposals                                 85.4%       18.69%    no
--   external_relationships                    97.3%        0.87%    no
--   ------------------------------------------------------------------
--   financial_relationships                  100.0%        0.03%   0.05
--   entity_connections                       100.0%        0.05%   0.05
--   entity_tags                              100.0%        0.00%   0.05
--   enrichment_queue                         100.0%        0.02%   0.05
--
-- The correlation is total: all four tables carrying a scale factor are at
-- 100.0% all-visible; six of the seven untuned ones are degraded. The tuning
-- works — it was just never extended past the tables FIX-884 happened to touch.
-- This migration extends it, sized by HOT PATH rather than by row count.
--
-- -------------------------------------------------------------------------
-- PER-TABLE DERIVATION — from each table's measured write pattern
-- -------------------------------------------------------------------------
-- Vacuum cost is dominated by the index scan (every pass reads ALL indexes),
-- so the aggressiveness each table can afford is set by its index footprint,
-- and the aggressiveness it NEEDS is set by whether the request path reads it.
--
-- financial_relationships  0.05 → 0.02   trigger 410,458 → 164,213
--   8.21M rows, 2,865 MB heap / 4,296 MB across 16 indexes, 22.4 tuples/page.
--   n_tup_hot_upd = 0 of 2,949,853 updates — ZERO HOT updates, so every update
--   writes a new tuple version and touches all 16 indexes. Request path (donor
--   pages, /api/graph/connections, the donor-rollup join). Not moved to 0.01:
--   4.3 GB of indexes per pass makes 5x frequency a real standing I/O cost on
--   Pro Small. 0.02 is a 2.5x reduction and bounds peak bloat at 164k.
--   AGAINST THE 07-26/27 EVENT: that bulk rewrite produced ~411,555 dead
--   tuples. Old trigger 410,458 = eligible only at 99.7% of the way through it
--   (one pass, at the very end, after the damage). New trigger 164,213 =
--   eligible at 39.9%, i.e. ~2.5 passes spread across the event. This is the
--   specific margin FIX-934's bulk FR rewrite will land into.
--
-- financial_entities       0.2  → 0.05   trigger 582,987 → 145,784
--   2.91M rows, 1,632 MB heap / 1,323 MB across 19 indexes, 14.0 tuples/page.
--   THE HEADLINE TABLE: 382,279 dead (13.12%), 77.3% all-visible, and NO custom
--   setting at all. It is the one large table in the donor-rollup join path
--   that was never tuned, and it is what dominates that job's runtime now
--   (financial_entities_pkey — 11,780 ms of arm 1b, 21,842 loops in arm 5).
--   Churn: 2,495,242 updates (48.8% HOT) from the weekly
--   financial-entity-totals-incremental job plus the monthly ...-reconcile
--   full-table UPDATE, which alone produces ~2.9M row versions.
--   0.05 (not lower) — 19 indexes is the second-largest index count here.
--
-- votes                    0.2  → 0.05   trigger 193,681 → 48,458
--   968k rows, 571 MB heap / 484 MB across 13 indexes, 13.2 tuples/page.
--   121,465 dead (12.55%), 61.1% all-visible, and last_autovacuum IS NULL with
--   autovacuum_count = 0 — this table has NEVER been autovacuumed in its life.
--   The tell for why: autoanalyze HAS run (2026-07-29), because the analyze
--   trigger (0.1) is half the vacuum trigger (0.2), so the table crosses the
--   analyze line and never the vacuum line. Accretive churn only (17,616 ins /
--   93,055 upd / 0 del) from the nightly Congress vote ingest, so it creeps
--   upward forever. Request path: proposal detail pages, /api/officials/[id].
--
-- donor_party_rollup_mv    0.2  → 0.02   trigger 262,622 → 26,307
--   1.31M rows, 258 MB heap / 121 MB across 2 indexes, 39.8 tuples/page.
--   Worst table on the instance: 42.7% all-visible — ALREADY BELOW the
--   FIX-885 canary's 50% vm_degraded floor, undetected only because the
--   detector watches entity_connections and nothing else. 261,534 dead against
--   a 262,622 trigger is a 1,088-tuple near-miss: a textbook instance of the
--   pathology. Written wholesale weekly (1,619,948 ins / 1,605,220 del by
--   donor-party-rollup-refresh, Tue 08:45) and read on the request path by
--   /api/graph/treemap-pac. Taken to 0.02 rather than 0.05 because 2 indexes
--   and 258 MB make the pass nearly free, and a wholesale rewrite blows past
--   any of these values immediately — so it is vacuumed right after each
--   refresh, which is exactly the desired behaviour.
--
-- external_source_refs     0.2  → 0.05   trigger 114,191 → 28,585
--   571k rows, 112 MB heap / 114 MB across 5 indexes, 40.3 tuples/page.
--   86,450 dead (15.04%), 63.8% all-visible, autovacuum_count = 0 — also never
--   autovacuumed. Small and cheap to maintain. Request path: /api/attribution
--   and fetchAttributionForEntity(), i.e. every SourceBadge on every detail
--   page. Bulk-written by five nightly pipeline writers + backfill procs.
--
-- proposals                0.2  → 0.05   trigger 17,323 → 4,368
--   86k rows, 146 MB heap / 120 MB across 15 indexes, 4.6 tuples/page.
--   16,145 dead (18.69%) against a 17,323 trigger — another near-miss, at 93%.
--   The single hottest read table on the site (homepage, /proposals, every
--   detail page, dashboard). Tiny, so even 15 indexes make the pass cheap.
--
-- -------------------------------------------------------------------------
-- DELIBERATELY NOT CHANGED
-- -------------------------------------------------------------------------
-- entity_connections — stays at 0.05. 2,919 MB heap / 3,544 MB indexes and
--   100.0% all-visible today. Making autovacuum more aggressive on the largest
--   table on an I/O-bound Small instance is the one move most likely to hurt
--   the request path, and it already has two backstops: the monthly
--   ec-vacuum-analyze job (FIX-704) and the FIX-885 startup reconcile.
-- entity_tags, enrichment_queue — 0.05, 100.0% all-visible, 0 dead. Working.
-- entity_connection_stats_mv, entity_search_index, group_donor_rollup,
--   official_donor_rollup_mv, treemap_individuals_rollup — untuned but all at
--   100.0% all-visible with 0-3% dead. Each is rebuilt by deleting and
--   re-inserting 0.5M-9.5M rows, which clears even the 0.2 trigger by a wide
--   margin every single run, so they self-maintain. Tuning them would add
--   passes and fix nothing.
-- external_relationships — 97.3% all-visible, 0.87% dead. Healthy.
-- external_relationships_review_queue — 65.0% all-visible but only 0.42% dead;
--   the low mark is un-vacuumed bulk INSERTs, not bloat, and its insert-vacuum
--   trigger (92,812) will clear it. Pipeline-only: a human-review staging table
--   with RLS on and no policies, read by no request path. Per the "rewritten
--   wholesale and read only by a nightly job costs little" rule, left alone.
--
-- SAFETY: ALTER TABLE ... SET (...) is a catalog update — no rewrite, no data
-- movement. It does need a brief ACCESS EXCLUSIVE lock, which is the only real
-- risk here (a lock request queues behind a long read AND blocks new queries
-- behind it), so lock_timeout is set defensively below: better to fail the
-- migration and retry than to stall the request path.
-- =============================================================================

-- Fail fast rather than queue behind a long-running read and block the request
-- path behind our lock request.
--
-- Session-level, NOT `SET LOCAL`: the Supabase CLI does not wrap a migration in
-- a transaction (`SET LOCAL` here emits "25P01: SET LOCAL can only be used in
-- transaction blocks" and silently does nothing). Consequence: this migration
-- is NOT atomic, so a lock timeout can leave some of the six ALTERs applied and
-- the migration unrecorded. That is safe — every statement below is idempotent
-- (ALTER TABLE ... SET (...) of the same value is a no-op, CREATE OR REPLACE
-- likewise), so the correct response to a timeout is simply to re-run.
SET lock_timeout = '10s';

-- ── 1. financial_relationships — 410,458 → 164,213 ──────────────────────────
-- analyze_scale_factor deliberately left at 0.02; only the vacuum trigger moves.
ALTER TABLE public.financial_relationships
  SET (autovacuum_vacuum_scale_factor = 0.02);

-- ── 2. financial_entities — 582,987 → 145,784 (first setting on this table) ──
ALTER TABLE public.financial_entities
  SET (autovacuum_vacuum_scale_factor  = 0.05,
       autovacuum_analyze_scale_factor = 0.02);

-- ── 3. votes — 193,681 → 48,458 (never autovacuumed) ────────────────────────
ALTER TABLE public.votes
  SET (autovacuum_vacuum_scale_factor  = 0.05,
       autovacuum_analyze_scale_factor = 0.02);

-- ── 4. donor_party_rollup_mv — 262,622 → 26,307 (42.7% all-visible) ─────────
-- Named _mv for history; it is a real TABLE since the FIX-717/718 swap.
ALTER TABLE public.donor_party_rollup_mv
  SET (autovacuum_vacuum_scale_factor  = 0.02,
       autovacuum_analyze_scale_factor = 0.01);

-- ── 5. external_source_refs — 114,191 → 28,585 (never autovacuumed) ─────────
ALTER TABLE public.external_source_refs
  SET (autovacuum_vacuum_scale_factor  = 0.05,
       autovacuum_analyze_scale_factor = 0.02);

-- ── 6. proposals — 17,323 → 4,368 ───────────────────────────────────────────
ALTER TABLE public.proposals
  SET (autovacuum_vacuum_scale_factor  = 0.05,
       autovacuum_analyze_scale_factor = 0.02);

-- =============================================================================
-- 7. Detector: report "dead tuples high but below the proportional threshold"
--
-- FIX-943's bullet asks for this explicitly — the FIX-650/885 detector reports
-- "autovacuum disabled" and "visibility map collapsed" but has no way to say
-- "this table is carrying a lot of dead tuples that autovacuum will not act on
-- because it is under the line". That is the condition this migration fixes,
-- and without a signal for it the next instance goes unnoticed the same way.
--
-- Two changes, both additive:
--
--   a) The watched set widens from the single rebuild-toggled table
--      (entity_connections) to the whole tuned class. This is what let
--      donor_party_rollup_mv sit at 42.7% all-visible — below the canary's own
--      50% escalation floor — completely unseen. `stranded` semantics are
--      unaffected: only the entity_connections rebuild ever sets
--      autovacuum_enabled=false, so no other table can appear there.
--
--   b) New `bloat` (always reported) and `bloat_degraded` (the finding) keys.
--      bloat_degraded fires when a table carries >= 50,000 dead tuples AND is
--      still BELOW its own computed trigger — i.e. bloat that is going nowhere.
--      Under prod's pre-migration numbers this selects exactly the four tables
--      fixed above and nothing else; after the settings land and autovacuum
--      catches up it goes empty.
--
-- REPORT-ONLY, deliberately: bloat_degraded does NOT escalate the canary.
-- A table can legitimately sit below its trigger with tens of thousands of dead
-- tuples and no harm done. The escalating signals stay `stranded` and
-- `vm_degraded`, because the collapsed visibility map is the consequence that
-- actually changes query plans. This key exists so the CAUSE is greppable
-- before the consequence arrives.
--
-- Existing keys (tables, stranded, rebuild_active, vm, vm_degraded) keep their
-- shape and meaning, so canary-check.ts stays compatible.
-- CREATE OR REPLACE preserves the FIX-650/834 service_role-only grants.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.check_rebuild_autovacuum_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  WITH watched(relname) AS (
    -- FIX-943 — was just ('entity_connections'). Now the full set of tables
    -- carrying a deliberate per-table autovacuum setting. Add a row here
    -- whenever a table joins that class (and vice versa), so the detector and
    -- the tuning can never drift apart.
    VALUES ('entity_connections'),        -- FIX-590/591/884/885 (rebuild-toggled)
           ('financial_relationships'),   -- FIX-943
           ('financial_entities'),        -- FIX-943
           ('entity_tags'),
           ('enrichment_queue'),
           ('votes'),                     -- FIX-943
           ('donor_party_rollup_mv'),     -- FIX-943
           ('external_source_refs'),      -- FIX-943
           ('proposals')                  -- FIX-943
  ),
  state AS (
    SELECT
      t.relname,
      -- reloptions only carries 'autovacuum_enabled=false' when EXPLICITLY set;
      -- absent => the default (true). Parse it out, defaulting to true.
      COALESCE(
        (SELECT (split_part(opt, '=', 2))::boolean
           FROM unnest(c.reloptions) AS opt
          WHERE opt LIKE 'autovacuum_enabled=%'),
        true
      ) AS autovacuum_enabled,
      -- FIX-885 — the signal that actually predicts query plans. With an empty
      -- visibility map every "Index Only Scan" does a per-row heap fetch, so a
      -- covering index silently stops being one (FIX-497 / FIX-883 on prod).
      c.relallvisible,
      c.relpages,
      CASE WHEN c.relpages > 0
           THEN round(100.0 * c.relallvisible / c.relpages, 1)
           ELSE 100.0 END AS pct_all_visible,
      -- FIX-943 — the CAUSE side. Recompute the daemon's own trigger from this
      -- table's effective settings: per-table override if present, else the
      -- cluster default. Same arithmetic autovacuum uses.
      s.n_dead_tup,
      ( COALESCE(
          (SELECT (split_part(opt, '=', 2))::numeric
             FROM unnest(c.reloptions) AS opt
            WHERE opt LIKE 'autovacuum_vacuum_threshold=%'),
          current_setting('autovacuum_vacuum_threshold')::numeric)
        + COALESCE(
          (SELECT (split_part(opt, '=', 2))::numeric
             FROM unnest(c.reloptions) AS opt
            WHERE opt LIKE 'autovacuum_vacuum_scale_factor=%'),
          current_setting('autovacuum_vacuum_scale_factor')::numeric)
          -- reltuples is -1 on a table that has never been analyzed (PG14+);
          -- clamp so the trigger cannot go negative and print nonsense. Either
          -- way the bloat_degraded filter fails SAFE (a clamped-low trigger
          -- means n_dead_tup >= trigger, so nothing is flagged).
          * GREATEST(c.reltuples, 0)
      )::bigint AS vacuum_trigger
    FROM watched t
    JOIN pg_class c            ON c.relname = t.relname
    JOIN pg_namespace n        ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_stat_user_tables s ON s.relid = c.oid
  )
  SELECT jsonb_build_object(
    'tables', COALESCE(
      jsonb_agg(jsonb_build_object(
        'relname',            s.relname,
        'autovacuum_enabled', s.autovacuum_enabled
      ) ORDER BY s.relname),
      '[]'::jsonb
    ),
    -- A full rebuild legitimately holds autovacuum off while running; don't flag
    -- that as stranded. The TS rebuild tags its backend application_name
    -- (FIX-591). FIX-885 — the pg_cron path (FIX-687/688, now the only scheduled
    -- one) runs as a plain CALL with no such tag, so match its statement too;
    -- otherwise an in-flight full rebuild would read as stranded.
    'rebuild_active', EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE state <> 'idle'
        AND (application_name LIKE 'entity_connections_rebuild%'
             OR query ILIKE '%run_entity_connections_rebuild%')
    ),
    'stranded', COALESCE(
      jsonb_agg(s.relname ORDER BY s.relname) FILTER (WHERE NOT s.autovacuum_enabled),
      '[]'::jsonb
    ),
    -- FIX-885 — per-table visibility-map health, always reported so the canary
    -- meta row carries the number even when nothing is wrong.
    'vm', COALESCE(
      jsonb_agg(jsonb_build_object(
        'relname',         s.relname,
        'relallvisible',   s.relallvisible,
        'relpages',        s.relpages,
        'pct_all_visible', s.pct_all_visible
      ) ORDER BY s.relname),
      '[]'::jsonb
    ),
    -- FIX-885 — tables whose visibility map has collapsed far enough that
    -- index-only scans are effectively dead. Threshold is deliberately loose
    -- (50%) so a legitimate post-rebuild dip never pages anyone; the failure
    -- this exists to catch measured 0.9%. relpages guard skips small tables
    -- where the ratio is noise.
    'vm_degraded', COALESCE(
      jsonb_agg(s.relname ORDER BY s.relname)
        FILTER (WHERE s.relpages > 1000 AND s.pct_all_visible < 50.0),
      '[]'::jsonb
    ),
    -- FIX-943 — always-reported dead-tuple load against each table's own
    -- computed trigger. pct_of_trigger >= 100 means autovacuum is eligible and
    -- will act; < 100 means it will not, no matter how large n_dead_tup is.
    'bloat', COALESCE(
      jsonb_agg(jsonb_build_object(
        'relname',         s.relname,
        'n_dead_tup',      s.n_dead_tup,
        'vacuum_trigger',  s.vacuum_trigger,
        'pct_of_trigger',  CASE WHEN s.vacuum_trigger > 0
                                THEN round(100.0 * s.n_dead_tup / s.vacuum_trigger, 1)
                                ELSE NULL END
      ) ORDER BY s.relname),
      '[]'::jsonb
    ),
    -- FIX-943 — the FIX-943 pathology itself: substantial dead-tuple load that
    -- autovacuum will NOT clear because the table is under its own trigger.
    -- Report-only; see the header note on why this does not escalate.
    'bloat_degraded', COALESCE(
      jsonb_agg(s.relname ORDER BY s.relname)
        FILTER (WHERE s.relpages > 1000
                  AND s.n_dead_tup >= 50000
                  AND s.n_dead_tup <  s.vacuum_trigger),
      '[]'::jsonb
    )
  )
  FROM state s;
$fn$;

COMMENT ON FUNCTION public.check_rebuild_autovacuum_status() IS
  'FIX-650/FIX-885/FIX-943 — read-only autovacuum health for the tables carrying '
  'a deliberate per-table setting: tables stranded at autovacuum_enabled=false '
  '(excluding an in-flight rebuild), visibility-map health (vm/vm_degraded), and '
  'dead-tuple load against each table''s computed trigger (bloat/bloat_degraded). '
  'Consumed by the daily sync canary, which exits non-zero on a non-empty '
  'stranded[] or vm_degraded[]; bloat_degraded[] is report-only (FIX-943).';

-- CREATE OR REPLACE preserves grants; re-assert the FIX-650/834 posture anyway.
REVOKE ALL ON FUNCTION public.check_rebuild_autovacuum_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rebuild_autovacuum_status() TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
