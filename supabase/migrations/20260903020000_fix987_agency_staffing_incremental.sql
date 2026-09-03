-- ============================================================================
-- FIX-987 — agency staffing rebuilds only what changed
--
-- `refresh_agency_staffing_rollup` (pg_cron jobid 25,
-- `agency-staffing-rollup-refresh`) had NO dirty set and NO watermark. Every
-- weekly firing enumerated ALL agencies and re-aggregated the entire agency
-- contract/grant slice of `financial_relationships` — measured on prod
-- 2026-09-03 at **3,908,902 rows** — to produce **128 output rows / 72 kB**
-- against `agencies` = 133. Recorded runtimes: 196 s, 547 s, 1,183 s
-- (19m43s). Per FIX-987 the correctly-normalised reading is 0.31 ms per INPUT
-- row: the job is not slow, it is doing too much work, and the only lever is
-- reading fewer rows. Its input grows with every ingest while its output is
-- pinned at the number of agencies, so the ratio of work-done to work-needed
-- gets strictly worse forever (playbook E8, pointing at the INPUT side).
--
-- THE SHAPE, which is exactly its siblings' shape.
--
-- New `pipeline_state` key `agency_staffing_watermark`:
--     { "fr_last_indexed_at": <ts>, "ec_last_indexed_at": <ts> }
--
-- TWO watermarks because the rollup has two independent inputs and they are
-- stamped by different writers:
--   * `appointment_count` ← entity_connections (connection_type='appointment',
--     to_type='agency'), keyed on `ec.to_id`, stamped by `derived_at`;
--   * `contract_cents` / `grant_cents` ← financial_relationships
--     (from_type='agency', relationship_type IN ('contract','grant')), keyed on
--     `fr.from_id`, stamped by `updated_at`.
--
-- Per run:
--     v_h := public.fr_watermark_horizon()                          -- FIX-983
--     FR-dirty = DISTINCT fr.from_id  WHERE updated_at  >  w_fr AND <= v_h
--     EC-dirty = DISTINCT ec.to_id    WHERE derived_at  >  w_ec AND <= v_h
--     rebuild  = (FR-dirty ∪ EC-dirty) ∩ agencies.id
--                ∪ {agencies with no rollup row yet}
--
-- WHY A PER-AGENCY RECOMPUTE IS EXACT (the FIX-1112 argument):
-- `agency_staffing_rebuild_agencies(uuid[])` DELETEs and re-INSERTs each named
-- agency's row from FULL history — both halves, every time. So a dirty-set
-- rebuild is not an increment applied to a stale number, it is a complete
-- recomputation of exactly the rows that could have changed. That makes it
-- order-independent, idempotent, and byte-identical to what a full pass would
-- have written for those agencies. Nothing here needs the dirty set to be
-- ordered, deduplicated against earlier runs, or replayed exactly once.
--
-- WHY THE HORIZON BOUNDS **BOTH** SIDES (and this is not over-application):
-- `financial_relationships.updated_at` is stamped by a BEFORE trigger with
-- NOW() = transaction start (FIX-983). `entity_connections.derived_at` has
-- DEFAULT now() — the same transaction-start value — and the appointments
-- writer (`packages/data/src/pipelines/agency-leadership`, `plum-book`) sets it
-- explicitly from the CLIENT's wall clock at row-build time, inside a batch
-- that commits later still. Both stamps therefore precede their own commit, so
-- both need the same head lag. There is no separate knob: one horizon, one
-- meaning.
--
-- SAME-RUN ATOMICITY: both watermarks are written AFTER the loop and ONLY when
-- the run was not cancelled. A cancelled run leaves them unmoved and the next
-- firing redoes the same dirty set. At 133 agencies that redo is trivial, so
-- there are deliberately NO per-chunk watermarks here — the FIX-1112 rule says
-- a watermark advance must be durable together with the work it covers, and the
-- cheapest way to satisfy it at this size is not to split the advance at all.
--
-- FULL PATH IS THE BOOTSTRAP, kept verbatim: no watermark row, or
-- `v_h - w_fr > 14 days`, takes today's all-agencies loop and then seeds both
-- watermarks. The first prod run after this ships takes it (the table was last
-- written 2026-08-04, ~29 days) and re-baselines all 133 agencies — including
-- the 5 that have no rollup row today.
--
-- THE MISSING-ROW SOURCE is a third dirty input, not in the original sketch: a
-- newly-inserted agency with no contracts, grants or appointments would
-- otherwise never enter any dirty set and never get its (all-zero) row, so
-- incremental mode would diverge from full mode forever. Measured on prod
-- today: `agencies` 133, `agency_staffing_rollup` 128 — the hole is already
-- five rows wide. It is a 133-row anti-join; it costs nothing.
--
-- WHAT IS NOT CHANGED HERE: the schedule (jobid 25 is `0 13 * * 2`; its four
-- consecutive failures are `job startup timeout`, not budget or statement
-- timeouts — a separate cause, tracked under FIX-1138), the 3,600 s
-- `cron_job_budget` row, `agency_staffing_rebuild_agencies` itself, the
-- advisory lock, the FIX-1028/1108 `query_canceled` handler, the terminal
-- `data_sync_log` row's shape, or its `pg_cron/backfill` source value.
--
-- Fixes: FIX-987
-- ============================================================================

BEGIN;

CREATE OR REPLACE PROCEDURE public.refresh_agency_staffing_rollup()
LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint   := hashtext('agency_staffing_rollup_refresh')::bigint;
  c_chunk    int      := 50;
  -- Past this lag the dirty set stops being a saving and the full pass is the
  -- simpler, bounded answer. Mirrors donor-party's full_rebuild_lag_days.
  c_full_lag interval := interval '14 days';
  v_state    jsonb;
  v_w_fr     timestamptz;
  v_w_ec     timestamptz;
  v_h        timestamptz;
  v_mode     text;
  v_fr_dirty uuid[];
  v_ec_dirty uuid[];
  v_n_fr     int := 0;
  v_n_ec     int := 0;
  v_agencies uuid[];
  v_chunk    uuid[];
  v_n        int;
  v_i        int := 1;
  v_chunk_no int := 0;
  v_rows     bigint := 0;
  v_n_ins    bigint;
  -- FIX-979: survives the per-chunk COMMITs; now() would not.
  v_started  timestamptz := clock_timestamp();
  -- FIX-1028/1108: non-NULL once a query_canceled (57014) has been caught.
  v_canceled text := NULL;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[agency-staffing refresh] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  -- ── Mode, O(1) ─────────────────────────────────────────────────────────────
  SELECT value INTO v_state
    FROM public.pipeline_state WHERE key = 'agency_staffing_watermark';

  v_w_fr := (v_state->>'fr_last_indexed_at')::timestamptz;
  v_w_ec := (v_state->>'ec_last_indexed_at')::timestamptz;

  -- FIX-983 — the head-lag horizon. Nothing stamped inside the last
  -- civitics.watermark_lag_seconds is read yet, on either side.
  v_h := public.fr_watermark_horizon();

  v_mode := CASE
              WHEN v_w_fr IS NULL OR v_w_ec IS NULL THEN 'full'
              WHEN v_h - v_w_fr > c_full_lag        THEN 'full'
              ELSE                                       'incremental'
            END;

  IF v_mode = 'full' THEN
    -- ═══ FULL / BOOTSTRAP — today's behaviour, unchanged ═════════════════════
    SELECT array_agg(id ORDER BY id) INTO v_agencies FROM public.agencies;
  ELSE
    -- ═══ INCREMENTAL ═════════════════════════════════════════════════════════
    -- Never let the horizon pull a watermark backwards (FIX-983 invariant (c)).
    -- When it would, the two predicates below collapse to empty and the run is
    -- a clean no-op that rewrites the SAME watermark.
    v_h := GREATEST(v_h, v_w_fr, v_w_ec);

    -- FR side. `from_type = 'agency'` is deliberately NOT in this predicate:
    -- with it the planner BitmapANDs financial_relationships_from
    -- (from_type='agency' → 3.9M rows, 1.9 s, 7,083 buffers) against the range,
    -- for no gain. Without it the range rides
    -- financial_relationships_contract_grant_updated_at alone and the
    -- ∩ agencies below removes anything that is not an agency. Dropping a
    -- filter can only WIDEN a dirty set, and a wider dirty set is still exact
    -- here because the worker recomputes each agency from full history.
    SELECT array_agg(DISTINCT fr.from_id) INTO v_fr_dirty
      FROM public.financial_relationships fr
     WHERE fr.relationship_type IN ('contract', 'grant')
       AND fr.updated_at >  v_w_fr
       AND fr.updated_at <= v_h;

    -- EC side. 8,081 appointment→agency edges in total, so this stays cheap
    -- however the planner drives it.
    SELECT array_agg(DISTINCT ec.to_id) INTO v_ec_dirty
      FROM public.entity_connections ec
     WHERE ec.connection_type = 'appointment'
       AND ec.to_type         = 'agency'
       AND ec.derived_at >  v_w_ec
       AND ec.derived_at <= v_h;

    v_n_fr := COALESCE(array_length(v_fr_dirty, 1), 0);
    v_n_ec := COALESCE(array_length(v_ec_dirty, 1), 0);

    -- (FR ∪ EC) ∩ agencies, plus any agency that has no rollup row yet — the
    -- latter is what keeps incremental mode's output identical to full mode's.
    SELECT array_agg(a.id ORDER BY a.id) INTO v_agencies
      FROM public.agencies a
     WHERE a.id = ANY (COALESCE(v_fr_dirty, ARRAY[]::uuid[]))
        OR a.id = ANY (COALESCE(v_ec_dirty, ARRAY[]::uuid[]))
        OR NOT EXISTS (SELECT 1 FROM public.agency_staffing_rollup r
                        WHERE r.agency_id = a.id);
  END IF;

  v_n := COALESCE(array_length(v_agencies, 1), 0);

  RAISE NOTICE '[agency-staffing refresh] mode=% — % agencies to rebuild (fr-dirty %, ec-dirty %)',
    v_mode, v_n, v_n_fr, v_n_ec;

  WHILE v_i <= v_n LOOP
    v_chunk    := v_agencies[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    BEGIN
      v_n_ins := public.agency_staffing_rebuild_agencies(v_chunk);
      v_rows  := v_rows + v_n_ins;
    EXCEPTION
    -- ONLY query_canceled. No WHEN OTHERS — this loop had no handler at all
    -- before, and every other error must keep propagating out of the procedure
    -- exactly as it does today.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (agencies %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n), SQLERRM);
      RAISE WARNING '[agency-staffing refresh] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
    EXIT WHEN v_canceled IS NOT NULL;
    v_i := v_i + c_chunk;
  END LOOP;

  -- ── The watermarks, once, for the whole run ────────────────────────────────
  -- Advanced ONLY on a run that reached the end of its dirty set. A cancelled
  -- run has NOT covered its set, so advancing here would permanently skip every
  -- agency it did not reach — the FIX-1028 rule. Both sides move to the same
  -- horizon: they were computed against it, together.
  IF v_canceled IS NULL THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES ('agency_staffing_watermark',
            jsonb_build_object('fr_last_indexed_at', v_h::text,
                               'ec_last_indexed_at', v_h::text))
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  -- Reached on a cancel now, instead of being jumped over. Every chunk that
  -- COMMITted is real work and is reported; the rollup is per-agency, so a
  -- partial pass leaves the un-reached agencies on their PRIOR rows
  -- (complete-if-stale) and the next firing redoes the whole dirty set.
  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, error_message, metadata)
  VALUES ('agency_staffing_rollup_refresh',
          CASE WHEN v_canceled IS NOT NULL THEN 'partial' ELSE 'complete' END,
          v_started, clock_timestamp(), v_rows,
          CASE WHEN v_canceled IS NOT NULL
               THEN left(format('canceled — %s', v_canceled), 1000) ELSE NULL END,
          jsonb_build_object(
            'agencies', v_n, 'chunks', v_chunk_no, 'source', 'pg_cron/backfill',
            'mode', v_mode,                       -- FIX-987
            'dirty_fr', v_n_fr,                   -- FIX-987
            'dirty_ec', v_n_ec,                   -- FIX-987
            'agencies_rebuilt', v_rows,           -- FIX-987
            'watermark_before_fr', v_w_fr,        -- FIX-987
            'watermark_before_ec', v_w_ec,        -- FIX-987
            'horizon', v_h,                       -- FIX-983/987
            'canceled', v_canceled IS NOT NULL,
            'cancel_detail', v_canceled,
            'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int));

  RAISE NOTICE '[agency-staffing refresh] % (mode=%) — % agencies in % chunks',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED' ELSE 'complete' END,
    v_mode, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_agency_staffing_rollup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_agency_staffing_rollup() TO service_role;

COMMENT ON PROCEDURE public.refresh_agency_staffing_rollup() IS
  'FIX-987 — jobid 25 (agency-staffing-rollup-refresh). Dirty-set incremental '
  'over TWO watermarks in pipeline_state.agency_staffing_watermark: '
  'fr_last_indexed_at (financial_relationships.updated_at, contract/grant) and '
  'ec_last_indexed_at (entity_connections.derived_at, appointment→agency). '
  'Rebuild set = (FR-dirty ∪ EC-dirty) ∩ agencies, plus any agency with no '
  'rollup row, chunked 50 through agency_staffing_rebuild_agencies(), which '
  'recomputes BOTH halves of each row from full history — so the dirty-set '
  'result is byte-identical to a full pass for those agencies (FIX-1112). '
  'Falls back to the all-agencies full pass when either watermark is missing or '
  'the FR lag exceeds 14 days; that path is also the bootstrap. Both watermarks '
  'advance to the FIX-983 horizon once, after the loop, and only when the run '
  'was not cancelled. Was: re-aggregating 3.9M FR rows every week to write 128 '
  'rows, at up to 19m43s.';

COMMIT;
