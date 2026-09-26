-- FIX-1217 / FIX-1225 — the financial-entity inbound rollup (design B) and the
-- partial spending index (cc-158 audit docs/audits/2026-09-25-fix1217-whale-
-- donor-page.md §0 + §4.4; cc-159 D4).
--
-- WHAT THE DONOR PAGE READ, AND WHY IT WAS WRONG AS WELL AS SLOW. The page's
-- `donors:inbound` read took the top 1,000 inbound donation ROWS by amount and
-- summed them per donor in JS; `donors:donor-count` counted every inbound row.
-- For a whale (the RNC: 337,058 inbound donation rows on prod) both scan the
-- whole range and time out under anon's 3 s, and even when they finish the
-- top-50 is a sum over a sample: wrong for 94 of the 328 clone recipients over
-- 1,000 rows, and "Donors" = the sample's distinct count (the RNC showed 837
-- against 125,567 on the clone).
--
-- B stores, per financial-entity recipient, the true top 200 donors by
-- sum(amount_cents) plus one summary row (donor_count, tx_total, sum_total), so
-- the page reads O(50) rows of it instead. Read 3 of cc-159: every inbound
-- donation row to an FE has from_type = 'financial_entity' (prod 0 / clone 0
-- otherwise), so B's range — financial_relationships_donor_rollup_idx,
-- (to_id, relationship_type, from_id) INCLUDE (amount_cents) — is exactly the
-- page's population.
--
-- IN THIS FILE, in order:
--   1. financial_relationships_fe_spending_idx — IF NOT EXISTS: built on prod
--      out-of-band by scripts/fix1217-build-fr-spending-index.mjs (CIC), so a
--      no-op there; the real build on local. A guard refuses an INVALID one.
--   2. the two tables, public-read.
--   3. refresh_fe_inbound_rollup_unit(uuid[]) — per-recipient DELETE + INSERT.
--   4. run_fe_inbound_rollup(p_max_units) — the pg_cron procedure: a keyset
--      BOOTSTRAP while its cursor row exists, then a FR.updated_at WATERMARK.
--   5. privileges.
--   6. the job 'fe-inbound-rollup-refresh' (daily 02:13 UTC) + its budget row
--      + the FIX-1141/1129/1146 placement guard.
--   7. the FIX-1150 first-seen ledger row, and the bootstrap's cursor row.
--
-- OWNER (rule 59): this migration creates both tables and the job that
-- maintains them; nothing else writes them. Not jobid 24 (FIX-1018's
-- to_type='official' scope is required) and not fe-crawl (221 s of headroom on
-- its worst unit; cc-158 read 7). A manifest-scoped remediation that DELETEs FR
-- donation rows must call refresh_fe_inbound_rollup_unit(<recipients>) in its
-- tail: a deleted row leaves no updated_at for the watermark to see (the FIX-372
-- / FIX-704 hard-delete limitation, shared with the FE totals family).


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The spending index.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The donor page's spending read is `to_type='financial_entity' AND to_id=$1
-- AND relationship_type IN ('contract','grant') ORDER BY amount_cents DESC
-- LIMIT 50`. The enum sits in the PREDICATE: enum_eq is not leakproof, so under
-- RLS a key-column enum equality cannot become an equivalence-class constant and
-- the index's order would be lost (cc-158 §2 A, 1.5 → 5.6 s). cc-159 D1 chose
-- this over partial-A (to_type in the key) on the clone: 111,951,872 B against
-- 178,782,208 B, with `Limit <- Index Scan`, no Sort, for both the RNC and
-- AmerisourceBergen. Read 6: every contract/grant row on prod is
-- to_type='financial_entity', so moving to_type into the predicate loses none.
--
-- A plain CREATE INDEX here would hold a SHARE lock on financial_relationships
-- for the build (rule 67); on prod the CIC landed first, so this is a no-op.

DO $$
DECLARE
  v_valid boolean;
BEGIN
  SELECT i.indisvalid INTO v_valid
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'financial_relationships_fe_spending_idx'
     AND c.relnamespace = 'public'::regnamespace;
  IF v_valid IS FALSE THEN
    RAISE EXCEPTION '[fix1217] financial_relationships_fe_spending_idx exists but is INVALID — '
      'IF NOT EXISTS would keep it. DROP INDEX CONCURRENTLY it and rebuild with '
      'scripts/fix1217-build-fr-spending-index.mjs before pushing this migration.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS financial_relationships_fe_spending_idx
  ON public.financial_relationships (to_id, amount_cents DESC)
  WHERE relationship_type IN ('contract', 'grant')
    AND to_type = 'financial_entity';

COMMENT ON INDEX public.financial_relationships_fe_spending_idx IS
  'FIX-1217 — partial index over the ~3.9M contract/grant rows of '
  'financial_relationships, keyed (to_id, amount_cents DESC). Bounds the donor '
  'page''s spending read (to_type=financial_entity, to_id, relationship_type IN '
  '(contract, grant) ORDER BY amount_cents DESC LIMIT 50) to Limit <- Index Scan as '
  'anon. The enum is in the predicate, not the key: enum_eq is not leakproof, so '
  'under RLS a key-column enum cannot give up its order (cc-158 §2). Built '
  'CONCURRENTLY out-of-band by scripts/fix1217-build-fr-spending-index.mjs.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The tables.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- No FK to financial_entities, as official_donor_rollup_mv has none: these are
-- derived rows, rebuilt whole per recipient, and an FK would put a lookup on
-- every FE merge's DELETE for no correctness the rebuild does not already give.

CREATE TABLE IF NOT EXISTS public.financial_entity_inbound_rollup (
  recipient_id uuid     NOT NULL,
  from_id      uuid     NOT NULL,
  rank         smallint NOT NULL,
  total_cents  bigint   NOT NULL,
  tx_count     integer  NOT NULL,
  PRIMARY KEY (recipient_id, rank)
);

CREATE TABLE IF NOT EXISTS public.financial_entity_inbound_totals (
  recipient_id uuid        PRIMARY KEY,
  donor_count  integer     NOT NULL,
  tx_total     integer     NOT NULL,
  sum_total    bigint      NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.financial_entity_inbound_rollup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_entity_inbound_rollup_read ON public.financial_entity_inbound_rollup;
CREATE POLICY financial_entity_inbound_rollup_read
  ON public.financial_entity_inbound_rollup FOR SELECT USING (true);
GRANT SELECT ON public.financial_entity_inbound_rollup TO anon, authenticated, service_role;

ALTER TABLE public.financial_entity_inbound_totals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_entity_inbound_totals_read ON public.financial_entity_inbound_totals;
CREATE POLICY financial_entity_inbound_totals_read
  ON public.financial_entity_inbound_totals FOR SELECT USING (true);
GRANT SELECT ON public.financial_entity_inbound_totals TO anon, authenticated, service_role;

COMMENT ON TABLE public.financial_entity_inbound_rollup IS
  'FIX-1217 — per financial-entity recipient, its top 200 donors by '
  'sum(amount_cents) over every inbound donation row (rank 1..200; ties by '
  'from_id ascending). Rebuilt whole per recipient by '
  'refresh_fe_inbound_rollup_unit(); maintained by run_fe_inbound_rollup() '
  '(pg_cron fe-inbound-rollup-refresh). Figures past rank 200 come from '
  'financial_entity_inbound_totals, never from a tail row here. Serves the donor '
  'page''s Top donors list.';

COMMENT ON TABLE public.financial_entity_inbound_totals IS
  'FIX-1217 / FIX-1225 — per financial-entity recipient, over the SAME range as '
  'financial_entity_inbound_rollup: donor_count (distinct donors), tx_total '
  '(donation rows), sum_total (their sum). sum_total is the donor page''s "Total '
  'received" when a row exists (financial_entities.total_received_cents is the '
  'fallback; FIX-1226). A recipient with no row renders 0 donors until its first '
  'refresh — at most one daily cycle for a brand-new recipient.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The unit — one batch of recipients, whole-key, no COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Per recipient: DELETE its rows from both tables, then one statement that
-- aggregates its range ONCE (a MATERIALIZED CTE: GroupAggregate over the
-- index-only scan of financial_relationships_donor_rollup_idx, which returns
-- from_id-ordered rows, so no hash table), inserts the top 200 from it and the
-- summary from it. cc-159 read 4(b): the RNC (151,406 rows, 125,567 donors on the
-- clone) in 600 ms cold, 1,630 buffer reads, no temp I/O, the top-N sort 48 kB.
-- A recipient with no rows left gets a zero summary row, which is the truth.
--
-- SET list, in full (rule 34): search_path public, pg_catalog; work_mem 64MB —
-- the CTE tuplestore for the largest recipient (~284k donors on prod) sits well
-- inside it. No statement_timeout here (FIX-1128: it would bound nothing); the
-- caller's statement and the job's cron_job_budget row bound it.

CREATE OR REPLACE FUNCTION public.refresh_fe_inbound_rollup_unit(p_recipients uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_r       uuid;
  v_t0      timestamptz;
  v_ms      numeric;
  v_max_ms  numeric := 0;
  v_max_r   uuid;
  v_dc      integer;
  v_rows    bigint := 0;
  v_n       integer := 0;
BEGIN
  IF p_recipients IS NULL OR cardinality(p_recipients) = 0 THEN
    RETURN jsonb_build_object('recipients', 0, 'rows_written', 0, 'max_recipient_ms', 0);
  END IF;

  FOREACH v_r IN ARRAY p_recipients LOOP
    v_t0 := clock_timestamp();

    DELETE FROM public.financial_entity_inbound_rollup WHERE recipient_id = v_r;
    DELETE FROM public.financial_entity_inbound_totals WHERE recipient_id = v_r;

    WITH agg AS MATERIALIZED (
      SELECT f.from_id,
             sum(f.amount_cents)::bigint AS total_cents,
             count(*)::integer           AS tx_count
        FROM public.financial_relationships f
       WHERE f.to_id = v_r
         AND f.relationship_type = 'donation'
         AND f.from_type = 'financial_entity'
       GROUP BY f.from_id
    ), top AS (
      INSERT INTO public.financial_entity_inbound_rollup
             (recipient_id, from_id, rank, total_cents, tx_count)
      SELECT v_r, t.from_id,
             row_number() OVER (ORDER BY t.total_cents DESC, t.from_id)::smallint,
             t.total_cents, t.tx_count
        FROM (SELECT a.from_id, a.total_cents, a.tx_count
                FROM agg a
               ORDER BY a.total_cents DESC, a.from_id
               LIMIT 200) t
      RETURNING 1
    )
    INSERT INTO public.financial_entity_inbound_totals
           (recipient_id, donor_count, tx_total, sum_total, refreshed_at)
    SELECT v_r,
           count(*)::integer,
           COALESCE(sum(a.tx_count), 0)::integer,
           COALESCE(sum(a.total_cents), 0)::bigint,
           now()
      FROM agg a
    RETURNING donor_count INTO v_dc;

    -- The top-200 CTE runs to completion whether or not it is read; its row
    -- count is LEAST(donor_count, 200) by construction.
    v_rows := v_rows + 1 + LEAST(v_dc, 200);
    v_n    := v_n + 1;
    v_ms   := EXTRACT(epoch FROM (clock_timestamp() - v_t0)) * 1000;
    IF v_ms > v_max_ms THEN v_max_ms := v_ms; v_max_r := v_r; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'recipients',       v_n,
    'rows_written',     v_rows,
    'max_recipient_ms', round(v_max_ms, 1),
    'max_recipient_id', v_max_r);
END;
$function$;

COMMENT ON FUNCTION public.refresh_fe_inbound_rollup_unit(uuid[]) IS
  'FIX-1217 — rebuild financial_entity_inbound_rollup (top 200 donors by sum) and '
  'financial_entity_inbound_totals for each recipient in the array, whole-key, '
  'from its inbound donation rows (to_id = r, relationship_type = donation, '
  'from_type = financial_entity). No COMMIT — the caller owns the transaction. '
  'Returns {recipients, rows_written, max_recipient_ms, max_recipient_id}. Also '
  'the manifest-scoped entry point for a remediation that deletes FR donation rows.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. The procedure — pg_cron's entry point, and the bootstrap's.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Modelled on run_fe_totals_crawl (20260911000200:1282-1566): an advisory lock;
-- the FIX-950 guard (a supervised prod session defers it — `skipped` with a
-- skip_reason; the claimant's own CALL runs, FIX-1213); FIX-1101's FEC interlock
-- (`deferred`, as fe-crawl); a `running` data_sync_log row closed as
-- complete | partial | failed. Each batch is its own transaction.
--
-- BOOTSTRAP — while pipeline_state.financial_entity_inbound_rollup_cursor
-- exists (this migration inserts it). The first CALL captures
-- target = LEAST(now(), watermark_horizon()) ONCE and stores it in the cursor
-- row. Each unit takes the next 200 recipients after the cursor by a
-- LOOSE-INDEX-SCAN keyset over financial_relationships_donor_rollup_idx — one
-- index descent per distinct to_id, index-only — filtered to financial_entities
-- (cc-159 read 4(a): the first 200 in 119 ms, all 15,325 donation to_ids on the
-- clone in 4.2 s; the prompt's GROUP BY keyset over `_to` early-terminated too,
-- but walked every inbound row of every recipient through the heap, 16.2 s for
-- the first 200 cold). It runs the unit, advances the cursor in the same
-- transaction, and COMMITs. An empty batch is caught_up: the cursor row goes
-- and the watermark is written at the captured target.
--
-- WATERMARK — otherwise. target = LEAST(now(), watermark_horizon()) (FIX-983 /
-- FIX-1139), dirty = DISTINCT to_id of inbound FE donation rows with
-- updated_at in (watermark, target] — refresh_fe_totals_slice()'s to-side read.
-- Batches of 200, COMMIT per batch; the watermark advances to target only when
-- the whole window is done (FIX-704). A run the unit cap stops is `partial`
-- (rule 137) and records its window's target and the last recipient done in the
-- watermark row, so the next firing RESUMES that window instead of restarting it
-- — a drop larger than one run's cap cannot livelock the job. When the clamped
-- target has not passed the watermark, or nothing is dirty, the run logs
-- `complete` with rows_written 0 (FIX-1140: a `skipped` would freeze the
-- freshness clock) and leaves the watermark alone.
--
-- No statement_timeout proconfig (it COMMITs; FIX-1128). The bound is the
-- cron_job_budget row below; a cancel is caught per unit (FIX-1028), the unit
-- rolled back whole, the run closed `partial`, and the cursor or resume point
-- holds the progress.

CREATE OR REPLACE PROCEDURE public.run_fe_inbound_rollup(IN p_max_units integer DEFAULT 1)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('financial_entity_inbound_rollup')::bigint;
  c_cursor_key text   := 'financial_entity_inbound_rollup_cursor';
  c_wm_key     text   := 'financial_entity_inbound_rollup_watermark';
  c_zero       uuid   := '00000000-0000-0000-0000-000000000000';
  c_batch      int    := 200;
  v_log_id     uuid;
  v_started    timestamptz := clock_timestamp();
  v_source     text := COALESCE(NULLIF(current_setting('application_name', true), ''), 'unknown');
  v_interlock  jsonb;
  v_cur        jsonb;
  v_wm         jsonb;
  v_mode       text;
  v_cursor     uuid;
  v_resume     uuid;
  v_target     timestamptz;
  v_w          timestamptz;
  v_batch      uuid[];
  v_dirty      uuid[];
  v_n_dirty    int := 0;
  v_i          int := 1;
  v_units      int := 0;
  v_recips     bigint := 0;
  v_rows       bigint := 0;
  v_max_ms     numeric := 0;
  v_capped     boolean := false;
  v_caught_up  boolean := false;
  v_canceled   text := NULL;
  v_failures   text[] := ARRAY[]::text[];
  v_res        jsonb;
BEGIN
  IF p_max_units < 1 THEN
    RAISE EXCEPTION 'run_fe_inbound_rollup: p_max_units must be >= 1 (got %)', p_max_units;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_inbound_rollup', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent financial_entity_inbound_rollup run',
                               'source', v_source));
    RAISE NOTICE '[fe-inbound] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- After our own advisory lock and before any write, so the skip is free.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_inbound_rollup', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', v_source,
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[fe-inbound] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- FIX-1101's FEC interlock: this reads the rows the weekly FEC replay
  -- rewrites. Deferring BEFORE the log row goes 'running' leaves no state.
  v_interlock := public.fec_bulk_interlock_state();
  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_inbound_rollup', 'deferred', v_started, clock_timestamp(),
            jsonb_build_object('source', v_source,
                               'defer_reason', v_interlock->>'reason',
                               'fec_interlock', v_interlock));
    RAISE WARNING '[fe-inbound] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[fe-inbound] fec_bulk_run_state present but STALE (%) — proceeding; the marker is stranded',
      v_interlock->>'run_state_age';
  END IF;

  SELECT value INTO v_cur FROM public.pipeline_state WHERE key = c_cursor_key;
  SELECT value INTO v_wm  FROM public.pipeline_state WHERE key = c_wm_key;
  -- Neither a cursor nor a watermark is a lost state, not a finished one:
  -- re-arm the bootstrap rather than read an unbounded dirty set.
  IF v_cur IS NULL AND (v_wm IS NULL OR v_wm->>'last_indexed_at' IS NULL) THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_cursor_key, jsonb_build_object('cursor', c_zero, 'rearmed_at', now()))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    SELECT value INTO v_cur FROM public.pipeline_state WHERE key = c_cursor_key;
    RAISE WARNING '[fe-inbound] no cursor and no watermark — bootstrap re-armed';
  END IF;
  v_mode := CASE WHEN v_cur IS NOT NULL THEN 'bootstrap' ELSE 'watermark' END;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_inbound_rollup', 'running', now(),
          jsonb_build_object('source', v_source, 'mode', v_mode,
                             'max_units', p_max_units, 'batch_recipients', c_batch))
  RETURNING id INTO v_log_id;
  COMMIT;

  IF v_mode = 'bootstrap' THEN
    -- ═══ BOOTSTRAP ═══════════════════════════════════════════════════════════
    v_cursor := COALESCE((v_cur->>'cursor')::uuid, c_zero);
    v_target := (v_cur->>'target')::timestamptz;
    IF v_target IS NULL THEN
      v_target := LEAST(now(), public.watermark_horizon());
      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object('target', v_target, 'bootstrap_started_at', v_started),
             updated_at = now()
       WHERE key = c_cursor_key;
      COMMIT;
    END IF;

    LOOP
      IF v_units >= p_max_units THEN v_capped := true; EXIT; END IF;
      v_batch := NULL;
      v_res   := NULL;
      BEGIN
        -- The next 200 FE recipients after the cursor: a loose index scan (one
        -- descent per distinct to_id), then the financial_entities filter.
        WITH RECURSIVE r(to_id) AS (
          SELECT (SELECT f.to_id FROM public.financial_relationships f
                   WHERE f.to_id > v_cursor
                     AND f.relationship_type = 'donation'
                     AND f.from_type = 'financial_entity'
                   ORDER BY f.to_id LIMIT 1)
          UNION ALL
          SELECT (SELECT f.to_id FROM public.financial_relationships f
                   WHERE f.to_id > r.to_id
                     AND f.relationship_type = 'donation'
                     AND f.from_type = 'financial_entity'
                   ORDER BY f.to_id LIMIT 1)
            FROM r WHERE r.to_id IS NOT NULL
        )
        SELECT array_agg(s.to_id ORDER BY s.to_id) INTO v_batch
          FROM (SELECT r.to_id FROM r
                 WHERE r.to_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM public.financial_entities fe WHERE fe.id = r.to_id)
                 LIMIT c_batch) s;

        IF v_batch IS NULL THEN
          -- caught_up: the watermark takes over at the target captured when the
          -- bootstrap began, so every row written since is seen exactly once more.
          INSERT INTO public.pipeline_state (key, value)
          VALUES (c_wm_key, jsonb_build_object('last_indexed_at', v_target::text))
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
          DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
          v_caught_up := true;
        ELSE
          v_res := public.refresh_fe_inbound_rollup_unit(v_batch);
          v_cursor := v_batch[cardinality(v_batch)];
          UPDATE public.pipeline_state
             SET value = value || jsonb_build_object(
                   'cursor', v_cursor,
                   'batches_done', COALESCE((value->>'batches_done')::int, 0) + 1,
                   'recipients_done', COALESCE((value->>'recipients_done')::int, 0) + cardinality(v_batch)),
                 updated_at = now()
           WHERE key = c_cursor_key;
        END IF;
      EXCEPTION
      -- FIX-1028 — by name. The unit and its cursor advance roll back together;
      -- nothing is stranded and the next firing retries the same batch.
      WHEN query_canceled THEN
        v_canceled := format('bootstrap batch %s after %s: %s', v_units + 1, v_cursor, SQLERRM);
        RAISE WARNING '  [fe-inbound] bootstrap batch % CANCELED (rolled back whole — cursor unmoved): %',
          v_units + 1, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap batch %s after %s: %s', v_units + 1, v_cursor, SQLERRM);
        RAISE WARNING '  [fe-inbound] bootstrap batch % FAILED: %', v_units + 1, SQLERRM;
      END;
      COMMIT;

      EXIT WHEN v_canceled IS NOT NULL OR cardinality(v_failures) > 0 OR v_caught_up;
      v_units  := v_units + 1;
      v_recips := v_recips + COALESCE((v_res->>'recipients')::bigint, 0);
      v_rows   := v_rows + COALESCE((v_res->>'rows_written')::bigint, 0);
      v_max_ms := GREATEST(v_max_ms, COALESCE((v_res->>'max_recipient_ms')::numeric, 0));
    END LOOP;

  ELSE
    -- ═══ WATERMARK ═══════════════════════════════════════════════════════════
    v_w      := (v_wm->>'last_indexed_at')::timestamptz;
    v_resume := (v_wm->>'resume_after')::uuid;
    -- A window a capped run left half-done keeps ITS target; otherwise clamp to
    -- the head-lag horizon (FIX-983 / FIX-1139).
    v_target := COALESCE((v_wm->>'resume_target')::timestamptz,
                         LEAST(now(), public.watermark_horizon()));

    IF v_target <= v_w THEN
      -- FIX-1140 — the clamped target has not passed the watermark: nothing can
      -- be read yet. A `complete` with rows 0, and the watermark stays put.
      v_caught_up := true;
    ELSE
      BEGIN
        SELECT array_agg(DISTINCT fr.to_id) INTO v_dirty
          FROM public.financial_relationships fr
         WHERE fr.to_type = 'financial_entity'
           AND fr.relationship_type = 'donation'
           AND fr.updated_at >  v_w
           AND fr.updated_at <= v_target
           AND (v_resume IS NULL OR fr.to_id > v_resume);
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('dirty-set read (%s, %s]: %s', v_w, v_target, SQLERRM);
      WHEN OTHERS THEN
        v_failures := v_failures || format('dirty-set read (%s, %s]: %s', v_w, v_target, SQLERRM);
      END;
      v_n_dirty := COALESCE(cardinality(v_dirty), 0);

      WHILE v_canceled IS NULL AND cardinality(v_failures) = 0 AND v_i <= v_n_dirty LOOP
        IF v_units >= p_max_units THEN v_capped := true; EXIT; END IF;
        v_batch := v_dirty[v_i : LEAST(v_i + c_batch - 1, v_n_dirty)];
        v_res   := NULL;
        BEGIN
          v_res := public.refresh_fe_inbound_rollup_unit(v_batch);
          -- The resume point rides the unit's transaction: a capped or cancelled
          -- run leaves it exactly at the last batch that committed.
          UPDATE public.pipeline_state
             SET value = value || jsonb_build_object(
                   'resume_target', v_target::text,
                   'resume_after',  v_batch[cardinality(v_batch)]),
                 updated_at = now()
           WHERE key = c_wm_key;
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('batch %s of %s dirty: %s', v_units + 1, v_n_dirty, SQLERRM);
          RAISE WARNING '  [fe-inbound] batch % CANCELED (rolled back whole): %', v_units + 1, SQLERRM;
        WHEN OTHERS THEN
          v_failures := v_failures || format('batch %s of %s dirty: %s', v_units + 1, v_n_dirty, SQLERRM);
          RAISE WARNING '  [fe-inbound] batch % FAILED: %', v_units + 1, SQLERRM;
        END;
        COMMIT;
        EXIT WHEN v_canceled IS NOT NULL OR cardinality(v_failures) > 0;
        v_units  := v_units + 1;
        v_recips := v_recips + COALESCE((v_res->>'recipients')::bigint, 0);
        v_rows   := v_rows + COALESCE((v_res->>'rows_written')::bigint, 0);
        v_max_ms := GREATEST(v_max_ms, COALESCE((v_res->>'max_recipient_ms')::numeric, 0));
        v_i      := v_i + c_batch;
      END LOOP;

      -- The whole window is done: the watermark moves to its target and the
      -- resume fields go. Only on a clean run (FIX-704).
      IF NOT v_capped AND v_canceled IS NULL AND cardinality(v_failures) = 0 THEN
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_wm_key, jsonb_build_object('last_indexed_at', v_target::text))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
        v_caught_up := true;
        COMMIT;
      END IF;
    END IF;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL     THEN 'partial'
                        WHEN cardinality(v_failures) > 0 THEN 'failed'
                        WHEN v_capped                   THEN 'partial'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = cardinality(v_failures),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; the unit rolled back whole, the next firing retries it', v_canceled), 1000)
                        WHEN cardinality(v_failures) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_capped
                          THEN left(format('unit cap reached — %s unit(s) of %s recipients run', v_units, c_batch), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode',             v_mode,
                        'units_run',        v_units,
                        'unit_capped',      v_capped,
                        'caught_up',        v_caught_up,
                        'canceled',         v_canceled IS NOT NULL,
                        'cancel_detail',    v_canceled,
                        'recipients',       v_recips,
                        'dirty_recipients', CASE WHEN v_mode = 'watermark' THEN v_n_dirty END,
                        'rows_written',     v_rows,
                        'max_recipient_ms', round(v_max_ms, 1),
                        'target',           v_target,
                        'elapsed_seconds',  round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        'cursor_after',     (SELECT value->>'cursor' FROM public.pipeline_state
                                              WHERE key = c_cursor_key),
                        'watermark_after',  (SELECT value->>'last_indexed_at' FROM public.pipeline_state
                                              WHERE key = c_wm_key))
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-inbound] % (%) — % unit(s), % recipients, % rows',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN cardinality(v_failures) > 0 THEN 'FAILED'
         WHEN v_caught_up THEN 'CAUGHT UP'
         WHEN v_capped THEN 'UNIT CAP' ELSE 'complete' END,
    v_mode, v_units, v_recips, v_rows;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

COMMENT ON PROCEDURE public.run_fe_inbound_rollup(integer) IS
  'FIX-1217 — maintains financial_entity_inbound_rollup / _totals. BOOTSTRAP while '
  'pipeline_state.financial_entity_inbound_rollup_cursor exists (a keyset over '
  'recipients, 200 per unit, target captured once), then WATERMARK on FR.updated_at '
  '(pipeline_state.financial_entity_inbound_rollup_watermark), clamped to '
  'watermark_horizon(); a capped window resumes (resume_target / resume_after). '
  'data_sync_log pipeline financial_entity_inbound_rollup. Guarded (FIX-950), '
  'FEC-interlocked (FIX-1101). pg_cron: fe-inbound-rollup-refresh.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Privileges.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE ALL ON PROCEDURE public.run_fe_inbound_rollup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_fe_inbound_rollup(integer) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_fe_inbound_rollup_unit(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_fe_inbound_rollup_unit(uuid[]) TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. The job — fe-inbound-rollup-refresh, daily 02:13 UTC.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Slot (cc-159 read 7, prod cron.job ⟕ cron_job_budget at 01:46 UTC): hour 2 is
-- inside the 18–05 quiet band; minute 13 is odd (clear of the */2 watchdogs)
-- and not a multiple of 15 (clear of ec-crawl / fe-crawl starts); no active job
-- holds '13 2 * * *'; it starts after the evening prod-op window and 47 min
-- before fr-vacuum-analyze (03:00, 30-day max 227 s), and Monday's firing sees
-- Sunday's drop past the 1 h horizon. Budget 1,800 s ends by 02:43 at worst.
-- Sizing (read 5): 660 recipients dirty since the 09-20 drop, 7 of them over
-- 10k rows — 4 units of 200, inside p_max_units 10. BY NAME (playbook D3):
-- cron.schedule with a name upserts, so a re-run re-points the same jobid.

DO $$
DECLARE
  c_jobname  CONSTANT text := 'fe-inbound-rollup-refresh';
  c_sched    CONSTANT text := '13 2 * * *';
  v_id       bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE WARNING '[fix1217] pg_cron not installed — job not scheduled';
    RETURN;
  END IF;

  SELECT cron.schedule(c_jobname, c_sched,
           $job$CALL public.run_fe_inbound_rollup(p_max_units := 10)$job$)
    INTO v_id;
  RAISE NOTICE '[fix1217] scheduled % (jobid %) at %', c_jobname, v_id, c_sched;
END $$;

-- Budget (rule 120): the outside bound the FIX-1063 watchdog cancels on, and the
-- only per-job bound a COMMITting pg_cron procedure has (FIX-1128). A cancel is
-- SAFE: each unit is its own transaction and the unit in flight rolls back
-- whole; the cursor (bootstrap) or resume point (watermark) holds the progress.
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES (
  'fe-inbound-rollup-refresh',
  1800,
  'FIX-1217 (cc-159). Daily 02:13 UTC CALL run_fe_inbound_rollup(p_max_units := 10): '
  'up to 10 units of 200 FE recipients. Clone walls (cold): one RNC-sized recipient '
  '600 ms; the 26 recipients over 10k rows 13.6 s; the full 8,483-recipient build 27 s '
  '(cc-158 §3). Post-drop daily set on prod 660 recipients, 7 over 10k (cc-159 read 5). '
  'A cancel is SAFE: the unit in flight rolls back whole; the cursor or resume point '
  'holds the progress.')
ON CONFLICT (jobname) DO UPDATE
  SET budget_seconds = EXCLUDED.budget_seconds,
      note           = EXCLUDED.note,
      updated_at     = NOW();

-- Guard: fail the migration rather than land the job in a slot the placement
-- rules refuse (the FIX-1141 / FIX-1129 / FIX-1146 checks, restated).
DO $$
DECLARE
  c_jobname CONSTANT text := 'fe-inbound-rollup-refresh';
  v_sched   text;
  v_cmd     text;
  v_min     int;
  v_hour    int;
  v_clash   int;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE '[fix1217] pg_cron absent — placement guard skipped';
    RETURN;
  END IF;

  SELECT schedule, command INTO v_sched, v_cmd FROM cron.job WHERE jobname = c_jobname;
  IF v_sched IS NULL THEN
    RAISE EXCEPTION '[fix1217] % was not scheduled', c_jobname;
  END IF;

  v_min  := split_part(v_sched, ' ', 1)::int;
  v_hour := split_part(v_sched, ' ', 2)::int;

  IF NOT (v_hour >= 18 OR v_hour <= 5) THEN
    RAISE EXCEPTION '[fix1217] % lands at hour % — outside the measured quiet band (18-05 UTC)', c_jobname, v_hour;
  END IF;
  IF v_min % 2 = 0 THEN
    RAISE EXCEPTION '[fix1217] % lands on even minute % — collides with the */2 watchdogs', c_jobname, v_min;
  END IF;
  IF v_min % 15 = 0 THEN
    RAISE EXCEPTION '[fix1217] % lands on minute % — collides with ec-crawl/fe-crawl', c_jobname, v_min;
  END IF;
  SELECT count(*) INTO v_clash FROM cron.job
   WHERE active AND jobname <> c_jobname AND schedule = v_sched;
  IF v_clash > 0 THEN
    RAISE EXCEPTION '[fix1217] % active job(s) already hold schedule %', v_clash, v_sched;
  END IF;
  IF position(';' IN v_cmd) > 0 THEN
    RAISE EXCEPTION '[fix1217] % command is not one statement: %', c_jobname, v_cmd;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cron_job_budget WHERE jobname = c_jobname) THEN
    RAISE EXCEPTION '[fix1217] % has no cron_job_budget row', c_jobname;
  END IF;

  RAISE NOTICE '[fix1217] placement guard passed — % at % (hour %, minute %)', c_jobname, v_sched, v_hour, v_min;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. The first-seen ledger row, and the bootstrap's cursor.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FIX-1150: record_cron_jobs_seen() would add the row on the canary's next
-- tick, but declaring it here closes the gap (FIX-1165's precedent) — absent a
-- row the missing_daily exemption defaults to '-infinity', i.e. NOT exempt.

INSERT INTO public.cron_job_first_seen (jobname, first_seen_at)
VALUES ('fe-inbound-rollup-refresh', now())
ON CONFLICT (jobname) DO NOTHING;

-- The first firing, scheduled or CALLed, bootstraps. Only when neither state
-- row exists: a re-run of this file must not rewind a finished bootstrap.
INSERT INTO public.pipeline_state (key, value)
SELECT 'financial_entity_inbound_rollup_cursor',
       jsonb_build_object('cursor', '00000000-0000-0000-0000-000000000000')
 WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_state
                    WHERE key IN ('financial_entity_inbound_rollup_cursor',
                                  'financial_entity_inbound_rollup_watermark'))
ON CONFLICT (key) DO NOTHING;
