-- =============================================================================
-- FIX-1031 / FIX-969 — financial_entity totals become a paced CRAWL.
--
-- ⚠⚠ SHIPS OFF. The `fe-crawl` job is created INACTIVE and nothing in this file
-- resets a watermark, unpauses jobid 13, or runs a repair. Enabling is a
-- deliberate Craig action AFTER the Monday 2026-08-31 replay read. The one
-- command that does it is at the bottom of this header.
--
-- ═══ WHAT IS ACTUALLY WRONG WITH jobid 13 ══════════════════════════════════
-- Not "it is slow". It CANNOT CONVERGE, and each failure makes the next attempt
-- strictly more expensive:
--
--   * refresh_financial_entity_totals_incremental() builds its dirty set ONCE,
--     up front, as `array_agg(DISTINCT from_id)` over every donation FR row
--     newer than the watermark — then chunks 500 ids at a time with a COMMIT
--     per chunk.
--   * The watermark is written ONCE, after both chunk loops, and only when
--     v_failures is empty.
--   * PL/pgSQL's `EXCEPTION WHEN OTHERS` does NOT match query_canceled. So a
--     watchdog or statement_timeout cancel propagates straight out of the
--     procedure, skipping the watermark write entirely.
--
-- The per-chunk COMMITs therefore preserve the DATA and none of the PROGRESS.
-- pipeline_state.financial_entity_totals_watermark has read 2026-08-07 04:41:54
-- since it was last written on 2026-08-08 02:34:35. Every firing since has
-- rebuilt the dirty set from 08-07 — today 4.65M+ financial_relationships rows —
-- and the dirty-set build ALONE has blown a 120 s statement timeout on an idle
-- box. runid 4361 (08-18, 5,539 s) died inside `array_agg(DISTINCT ...)` without
-- reaching a single UPDATE. runid 15453 (08-25) ran 8,047.8 s, wrote 775,098
-- entities, was cancelled, banked no progress — and per FIX-1107 pinned prod's
-- disk at the 3,000 IOPS cap for ~75 minutes, starving four other jobs into
-- `job startup timeout` and killing seven GitHub Actions runs.
--
-- ═══ WHY A UUID WINDOW WOULD NOT HAVE HELPED — the axis matters ════════════
-- The obvious move is to copy the EC donations arm and split by uuid range. It
-- does not work here, and it is worth saying why so nobody re-proposes it. The
-- cost is in the SCAN THAT FINDS the dirty ids, not in the UPDATE that consumes
-- them: `updated_at > watermark` is an index range over
-- financial_relationships_updated_at whose size is set by how far behind the
-- watermark is. Adding `AND from_id >= lo AND from_id < hi` does not shrink that
-- range — it filters it — so sixteen uuid windows would run the SAME 4.65M-row
-- scan sixteen times. The right axis is the one the watermark already lives on:
-- TIME.
--
-- ═══ THE UNIT: A ROW-BOUNDED TIME SLICE ════════════════════════════════════
-- One unit advances the watermark by one slice of at most `slice_rows` FR rows:
--
--   1. slice_end := the updated_at of the Nth row after the watermark, found by
--        SELECT max(updated_at) FROM (
--          SELECT updated_at FROM financial_relationships
--           WHERE updated_at > w AND updated_at <= target
--           ORDER BY updated_at LIMIT N) s
--      — an index scan of EXACTLY N entries. The unit's size is bounded before
--      any work is done, by construction rather than by hope. Fewer than N rows
--      left ⇒ slice_end = target ⇒ this is the last unit and the crawl is caught
--      up.
--   2. dirty donors + dirty recipients, scoped to (w, slice_end].
--   3. the EXISTING financial_entity_*_rebuild(uuid[]) functions, 500 ids at a
--      time. Unchanged: this is a pacing fix, not a re-derivation fix.
--   4. the watermark advances to slice_end IN THE SAME TRANSACTION.
--
-- Step 4 is the whole point. The slice is ATOMIC: rows and watermark commit
-- together or neither does. That is FIX-1112's rule in its strongest form —
-- "write the watermark in the same transaction as the chunk that earned it" —
-- and it means a cancel is not merely survivable but INVISIBLE. There is no
-- ratchet left to strand, because there is no window in which data is durable
-- and progress is not. A cancelled slice rolls back whole and the next unit
-- retries exactly it, losing at most `slice_rows` FR rows of work.
--
-- ⚠ THE BOUNDARY PROBE IS DELIBERATELY UNSCOPED while the dirty sets are scoped
-- to relationship_type='donation'. That is correct, not sloppy: the watermark's
-- contract is "every donation row at or below this timestamp is folded in", and
-- advancing past non-donation rows satisfies it vacuously. Scoping the probe
-- would force a heap fetch per index entry to check relationship_type and
-- roughly double the only part of the unit that is supposed to be free.
--
-- ═══ WHY A SIBLING CRAWL AND NOT A THIRD UNIT FAMILY IN ec_crawl ═══════════
-- Four reasons, in the order they decided it. (1) The EC crawl's state model is
-- a CYCLE — open, bank arms, close, cool down — and FE totals have no cycle:
-- they are a monotone watermark advance that is never "done", only "caught up".
-- Bolting one onto the other means either a fake cycle or two cycle concepts in
-- one 60 kB procedure. (2) A shared firing is zero-sum: every FE unit would be
-- an EC unit not run, and the EC crawl already needs ~26 units to close a cycle.
-- (3) But two independent crawls must not simply double the box's spend, which
-- is the constraint the whole FIX-1107 line of work exists to respect — so this
-- one runs at */30 rather than */15, and its gate reads ec_crawl's backoff_until
-- as well as its own. One throttle signal, two consumers: if the box told the EC
-- crawl to back off, the FE crawl is already backed off. (4) Everything else is
-- the FIX-1111 pattern instantiated on a second config key rather than
-- reimplemented — which is why section 1 below GENERALISES the gate and the
-- sensor and leaves the ec_* names as delegating wrappers, instead of copying
-- 200 lines and letting the two drift.
--
-- ═══ THE REPAIR — AND A CORRECTION TO THE BRIEF ════════════════════════════
-- The 08-25 partial run left total_donated_cents / recipient_count internally
-- inconsistent: ~775,098 entities fresh as of 08-25, the rest as of 2026-08-07.
--
-- The repair needs NO WATERMARK RESET. The watermark already reads
-- 2026-08-07 04:41:54 — exactly the point a full repair has to start from —
-- because the 08-25 run never advanced it. So the frozen watermark that is the
-- COST driver is also, unchanged, the correct repair cursor. Enabling the crawl
-- IS the repair: it walks 08-07 → now in bounded slices, re-deriving every
-- entity with an FR write in that span, which is a superset of the 775,098 the
-- 08-25 run touched. Re-deriving those is harmless — the rebuild functions
-- recompute a total from all of an entity's FR rows rather than accumulating —
-- so the inconsistency resolves itself as the crawl passes 08-25.
--
-- The enable is therefore ONE command, not two:
--
--     SELECT cron.alter_job(
--              (SELECT jobid FROM cron.job WHERE jobname = 'fe-crawl'),
--              active := true);
--
-- If a belt-and-braces FULL re-derive is ever wanted instead of a forward
-- repair, DELETE the watermark row and the crawl runs its bootstrap path — 16
-- uuid windows over both totals sides plus recipient_count, one window per unit.
-- That path exists here because a NULL watermark must be defined behaviour, not
-- because it is expected.
--
-- jobid 13 stays paused permanently: this replaces it. jobid 14
-- (financial-entity-totals-reconcile, monthly orphan zeroing) is untouched and
-- stays active.
--
-- Cross-ref FIX-1031, FIX-969, FIX-1112 (the ratchet census this closes for
-- jobid 13), FIX-1107 (the I/O fact), FIX-1111/1111b (the pattern), FIX-1063
-- (the outside watchdog), FIX-1028 (query_canceled by name), FIX-1101 (the FEC
-- interlock), FIX-702/726/736 (the rebuild functions being reused unchanged).
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Generalise the crawl gate and the throughput sensor.
--
--    ONE pattern, two consumers. The ec_* names keep their exact signatures and
--    become one-line delegations, so run_entity_connections_rebuild() is not
--    edited by this migration at all and every existing call site is unaffected.
--    The alternative — copying 200 lines under fe_* names — would have given two
--    implementations of one idea and guaranteed a drift bug later.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crawl_gate(
  p_config_key text,
  p_cursor_key text DEFAULT NULL,   -- NULL ⇒ this crawl has no cycle concept
  p_pipeline   text DEFAULT NULL,   -- data_sync_log pipeline for the cooldown
  p_peer_key   text DEFAULT NULL    -- another crawl whose backoff we also honour
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cfg        jsonb;
  v_backoff    timestamptz;
  v_peer       timestamptz;
  v_now        timestamptz := clock_timestamp();
  v_tod        time        := (clock_timestamp() AT TIME ZONE 'UTC')::time;
  r            record;
  v_from       time;
  v_to         time;
  v_cursor     jsonb;
  v_min_gap    int;
  v_last_close timestamptz;
  v_age_min    numeric;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = p_config_key;
  v_cfg := COALESCE(v_cfg, '{}'::jsonb);

  -- ── backoff (own) ─────────────────────────────────────────────────────────
  v_backoff := (v_cfg->>'backoff_until')::timestamptz;
  IF v_backoff IS NOT NULL AND v_backoff > v_now THEN
    RETURN jsonb_build_object(
      'run',    false,
      'reason', 'backoff',
      'detail', format('backing off until %s (%s s remaining) — a unit ran far over its rolling median',
                       v_backoff, round(EXTRACT(epoch FROM (v_backoff - v_now)))::int),
      'backoff_until', v_backoff);
  END IF;

  -- ── backoff (peer) ────────────────────────────────────────────────────────
  -- FIX-1031: the box's throttle is a property of the BOX, not of whichever
  -- crawl happened to measure it. A sibling crawl that ignored its peer's
  -- backoff would keep writing through exactly the condition the sensor exists
  -- to detect, and the two crawls together would be worse than the single one
  -- this pattern replaced.
  IF p_peer_key IS NOT NULL THEN
    SELECT (value->>'backoff_until')::timestamptz INTO v_peer
      FROM public.pipeline_state WHERE key = p_peer_key;
    IF v_peer IS NOT NULL AND v_peer > v_now THEN
      RETURN jsonb_build_object(
        'run',    false,
        'reason', 'peer_backoff',
        'detail', format('peer crawl %s is backed off until %s — the box is throttled for both of us',
                         p_peer_key, v_peer),
        'backoff_until', v_peer);
    END IF;
  END IF;

  -- ── blackout ──────────────────────────────────────────────────────────────
  -- Wrap-around supported: from > to means the window spans midnight UTC.
  FOR r IN SELECT e.value AS w FROM jsonb_array_elements(COALESCE(v_cfg->'blackout', '[]'::jsonb)) e
  LOOP
    BEGIN
      v_from := (r.w->>'from')::time;
      v_to   := (r.w->>'to')::time;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[%] unparseable blackout entry % — ignored', p_config_key, r.w;
      CONTINUE;
    END;
    IF v_from IS NULL OR v_to IS NULL THEN CONTINUE; END IF;

    IF (v_from <= v_to  AND v_tod >= v_from AND v_tod < v_to)
    OR (v_from >  v_to AND (v_tod >= v_from OR v_tod < v_to))
    THEN
      RETURN jsonb_build_object(
        'run',    false,
        'reason', 'blackout',
        'detail', format('inside blackout window %s–%s UTC', v_from, v_to));
    END IF;
  END LOOP;

  -- ── cycle cooldown ────────────────────────────────────────────────────────
  -- Only for a crawl that HAS cycles, and only when none is open. An open cycle
  -- is work already started and must be allowed to finish.
  IF p_cursor_key IS NOT NULL AND p_pipeline IS NOT NULL THEN
    SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = p_cursor_key;

    IF v_cursor IS NULL THEN
      v_min_gap := COALESCE((v_cfg->>'min_cycle_interval_minutes')::int, 0);
      IF v_min_gap > 0 THEN
        SELECT max(completed_at) INTO v_last_close
          FROM public.data_sync_log
         WHERE pipeline = p_pipeline
           AND status   = 'complete';
        IF v_last_close IS NOT NULL THEN
          v_age_min := EXTRACT(epoch FROM (v_now - v_last_close)) / 60.0;
          IF v_age_min < v_min_gap THEN
            RETURN jsonb_build_object(
              'run',    false,
              'reason', 'cycle_cooldown',
              'detail', format('last cycle closed %s min ago; minimum interval is %s min',
                               round(v_age_min)::int, v_min_gap));
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('run', true, 'reason', 'clear');
END;
$$;

REVOKE ALL ON FUNCTION public.crawl_gate(text, text, text, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.crawl_gate(text, text, text, text) IS
  'FIX-1031 — the FIX-1111 crawl gate, generalised over its config key so more '
  'than one crawl can share one implementation. Checks cheapest first: own '
  'backoff_until, PEER backoff_until (a throttle is a property of the box, not '
  'of whichever crawl measured it), configured blackout windows, and — only for '
  'a crawl that has a cycle cursor, and only when no cycle is open — a minimum '
  'interval since the last cycle CLOSED. Returns a verdict; the caller owns all '
  'logging. ec_crawl_gate() delegates here with the EC keys.';


CREATE OR REPLACE FUNCTION public.crawl_record_unit(
  p_config_key text,
  p_unit_class text,
  p_unit       text,
  p_seconds    numeric,
  p_rows       bigint,
  p_outcome    text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_ring_max CONSTANT int := 50;
  v_cfg      jsonb;
  v_ring     jsonb;
  v_entry    jsonb;
  v_median   numeric;
  v_samples  int;
  v_mult     numeric;
  v_minn     int;
  v_minrows  bigint;
  v_abs      numeric;
  v_hours    numeric;
  v_rows     bigint;
  v_rate     numeric;
  v_ratable  boolean;
  v_trip     boolean := false;
  v_reason   text    := NULL;
  v_until    timestamptz;
BEGIN
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = p_config_key;
  v_cfg  := COALESCE(v_cfg, '{}'::jsonb);
  v_ring := COALESCE(v_cfg->'recent_units', '[]'::jsonb);

  v_mult    := COALESCE((v_cfg->>'backoff_multiple')::numeric, 2.0);
  v_minn    := COALESCE((v_cfg->>'backoff_min_samples')::int, 5);
  v_minrows := COALESCE((v_cfg->>'backoff_min_rows')::bigint, 1000);
  v_abs     := COALESCE((v_cfg->>'backoff_abs_seconds')::numeric, 1500);
  v_hours   := COALESCE((v_cfg->>'backoff_hours')::numeric, 2);

  v_rows    := GREATEST(COALESCE(p_rows, 0), 0);
  v_ratable := v_rows >= v_minrows;
  v_rate    := CASE WHEN v_ratable THEN p_seconds * 1000.0 / v_rows END;

  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.value->>'rate')::numeric),
         count(*)
    INTO v_median, v_samples
    FROM jsonb_array_elements(v_ring) e
   WHERE e.value->>'unit_class' = p_unit_class
     AND (e.value->>'rate') IS NOT NULL;

  IF v_ratable AND v_samples >= v_minn AND v_median > 0
     AND v_rate >= v_mult * v_median THEN
    v_trip   := true;
    v_reason := format('throughput %s s/krow vs median %s over %s samples',
                       round(v_rate, 3), round(v_median, 3), v_samples);
  END IF;

  IF NOT v_trip AND p_seconds >= v_abs THEN
    v_trip   := true;
    v_reason := format('absolute duration %s s >= %s s', round(p_seconds)::int, round(v_abs)::int);
  END IF;

  IF v_trip THEN
    v_until := clock_timestamp() + make_interval(secs => v_hours * 3600);
  END IF;

  v_entry := jsonb_build_object(
    'unit',       p_unit,
    'unit_class', p_unit_class,
    'seconds',    round(p_seconds, 1),
    'rows',       v_rows,
    'rate',       CASE WHEN v_ratable THEN round(v_rate, 4) END,
    'outcome',    p_outcome,
    'at',         clock_timestamp(),
    'iops_class', CASE
                    WHEN v_trip                                      THEN 'degraded'
                    WHEN NOT v_ratable AND p_seconds < 30            THEN 'trivial'
                    WHEN NOT v_ratable                               THEN 'short'
                    WHEN p_seconds >= 120                            THEN 'sustained_writer'
                    ELSE 'short'
                  END,
    'median_rate_at_time', CASE WHEN v_samples >= v_minn THEN round(v_median, 4) END);

  v_ring := v_ring || jsonb_build_array(v_entry);
  IF jsonb_array_length(v_ring) > c_ring_max THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
      INTO v_ring
      FROM jsonb_array_elements(v_ring) WITH ORDINALITY AS e(value, ord)
     WHERE e.ord > jsonb_array_length(v_ring) - c_ring_max;
  END IF;

  v_cfg := v_cfg || jsonb_build_object('recent_units', v_ring);
  IF v_trip THEN
    v_cfg := v_cfg || jsonb_build_object('backoff_until', v_until);
    RAISE WARNING '[%] unit % (%) tripped backoff — % — backing off until %',
      p_config_key, p_unit, p_unit_class, v_reason, v_until;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES (p_config_key, v_cfg)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  RETURN jsonb_build_object(
    'recorded',      true,
    'unit',          p_unit,
    'seconds',       round(p_seconds, 1),
    'rows',          v_rows,
    'rate',          CASE WHEN v_ratable THEN round(v_rate, 4) END,
    'median_rate',   CASE WHEN v_samples >= v_minn THEN round(v_median, 4) END,
    'samples',       v_samples,
    'backoff_set',   v_trip,
    'backoff_reason', v_reason,
    'backoff_until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.crawl_record_unit(text, text, text, numeric, bigint, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.crawl_record_unit(text, text, text, numeric, bigint, text) IS
  'FIX-1031 — the FIX-1111b throughput sensor, generalised over its config key. '
  'Body is byte-for-byte the shipped ec_crawl_record_unit() logic with the '
  'hard-coded ''ec_crawl'' key replaced by a parameter and the RAISE prefixed '
  'with it. ec_crawl_record_unit() delegates here.';


-- ── the ec_* names become delegations; signatures unchanged ──────────────────
-- run_entity_connections_rebuild() is NOT edited by this migration. It keeps
-- calling ec_crawl_gate() and ec_crawl_record_unit(); those now forward.
CREATE OR REPLACE FUNCTION public.ec_crawl_gate()
RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  SELECT public.crawl_gate('ec_crawl',
                           'entity_connections_rebuild_cursor',
                           'entity_connections_rebuild',
                           NULL);
$$;

REVOKE ALL ON FUNCTION public.ec_crawl_gate() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ec_crawl_gate() IS
  'FIX-1111, generalised by FIX-1031 — delegates to crawl_gate() with the EC '
  'crawl''s config key, cycle cursor and pipeline name. Signature and returned '
  'verdict are unchanged; run_entity_connections_rebuild() is untouched. No peer '
  'key: the EC crawl is the senior consumer of the box and does not stand down '
  'for the FE crawl, which stands down for IT.';


CREATE OR REPLACE FUNCTION public.ec_crawl_record_unit(
  p_unit_class text,
  p_unit       text,
  p_seconds    numeric,
  p_rows       bigint,
  p_outcome    text
)
RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  SELECT public.crawl_record_unit('ec_crawl', p_unit_class, p_unit,
                                  p_seconds, p_rows, p_outcome);
$$;

REVOKE ALL ON FUNCTION public.ec_crawl_record_unit(text, text, numeric, bigint, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ec_crawl_record_unit(text, text, numeric, bigint, text) IS
  'FIX-1111b, generalised by FIX-1031 — delegates to crawl_record_unit() with '
  'the ec_crawl config key. Signature and behaviour unchanged.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The FE crawl's control block. Same shape as ec_crawl, same knob names, so
--    an operator who has learned one has learned both.
--
--    */30 rather than */15, and slice_rows is the knob that decides how big a
--    unit is. See the header for why the axis is time and not uuid.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.pipeline_state (key, value)
VALUES ('fe_crawl', jsonb_build_object(
          'cadence_minutes',     30,
          'slice_rows',          50000,
          'chunk_ids',           500,
          'unit_budget_seconds', 1800,
          'backoff_hours',       2,
          'backoff_multiple',    2.0,
          'backoff_min_samples', 5,
          'backoff_min_rows',    1000,
          'backoff_abs_seconds', 1500,
          'blackout',            '[]'::jsonb,
          'recent_units',        '[]'::jsonb))
ON CONFLICT (key) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. One slice — the atomic unit.
--
--    Returns {slice_end, fr_rows, donors, recipients, rows_written, caught_up}
--    and, critically, WRITES THE WATERMARK ITSELF. Everything this function does
--    is one transaction from the caller's point of view: there is no COMMIT in
--    here, so rows and watermark are indivisible.
--
--    NOT a procedure, precisely so it cannot COMMIT. The atomicity is enforced
--    by the language, not by a comment asking the next author to be careful.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_fe_totals_slice()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
SET work_mem = '64MB'
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.refresh_fe_totals_slice() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refresh_fe_totals_slice() IS
  'FIX-1031 — ONE bounded, ATOMIC unit of the financial-entity totals crawl. '
  'Advances financial_entity_totals_watermark by a slice of at most '
  'fe_crawl.slice_rows financial_relationships rows, chosen by an index scan of '
  'exactly that many entries BEFORE any work is done, then re-derives the dirty '
  'donors and recipients through the existing '
  'financial_entity_{donation_totals,recipient_count,received_totals}_rebuild() '
  'functions and writes the new watermark IN THE SAME TRANSACTION. It is a '
  'FUNCTION rather than a PROCEDURE so it physically cannot COMMIT mid-slice: '
  'rows and watermark are indivisible, which is what makes a watchdog cancel '
  'lose one slice instead of everything since 2026-08-07 (the FIX-1112 ratchet '
  'that made jobid 13 unconvergeable). Returns {bootstrap_required} when the '
  'watermark is NULL — the incremental path cannot zero an entity whose last FR '
  'row vanished, so a cold start must go through the 16-window bootstrap.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The driver — one unit per firing, the FIX-1111 shape.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.run_fe_totals_crawl(
  IN p_max_units int DEFAULT 1
)
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
                COALESCE((SELECT max(updated_at) FROM public.financial_relationships), now())::text))
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

REVOKE ALL ON PROCEDURE public.run_fe_totals_crawl(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_fe_totals_crawl(int) TO service_role;

COMMENT ON PROCEDURE public.run_fe_totals_crawl(int) IS
  'FIX-1031/FIX-969 — the financial-entity totals crawl: at most p_max_units '
  'bounded slices per firing, replacing jobid 13 '
  '(financial-entity-totals-incremental), which is paused permanently. Each '
  'slice is ATOMIC — refresh_fe_totals_slice() is a FUNCTION and cannot COMMIT, '
  'so its rows and its watermark advance are indivisible and a watchdog cancel '
  'loses one slice instead of everything since 2026-08-07 (the FIX-1112 ratchet '
  'that made jobid 13 unconvergeable: WHEN OTHERS does not match query_canceled, '
  'so the terminal watermark write was never reached). Carries the FIX-1111 '
  'pattern via crawl_gate()/crawl_record_unit(): backoff, blackout, per-unit '
  'wall-clock budget, the throughput sensor, and FIX-1101''s FEC interlock — '
  'plus a PEER backoff on ec_crawl, so the two crawls share one throttle signal '
  'and do not both write through a throttle. A NULL watermark takes the 16-window '
  'bootstrap path, one window per unit, because the incremental path cannot zero '
  'an entity whose last FR row vanished.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The job — created INACTIVE, and it stays that way until Craig enables it.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'fe-crawl';
  IF v_jobid IS NULL THEN
    v_jobid := cron.schedule('fe-crawl', '*/30 * * * *',
                             $cmd$CALL public.run_fe_totals_crawl(p_max_units := 1);$cmd$);
    PERFORM cron.alter_job(v_jobid, active := false);
    RAISE NOTICE '[FIX-1031] fe-crawl created as jobid % and parked INACTIVE (Craig enables it after the Monday read)', v_jobid;
  ELSE
    RAISE NOTICE '[FIX-1031] fe-crawl already exists as jobid % (active=%) — left alone',
      v_jobid, (SELECT active FROM cron.job WHERE jobid = v_jobid);
  END IF;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The FIX-1071 outside budget.
--
--    1,800 s, matching the ec-crawl's. Sized off the measured cost of the work
--    a slice does rather than off the cron expression (playbook D2): the 08-25
--    run wrote 775,098 entities in ~2h14m ≈ 5,800 entities/min, so a 50,000-FR-row
--    slice — tens of thousands of dirty entities at most — is single-digit
--    minutes. 1,800 s clears that with room and still catches a pathological one
--    long before the 6h role timeout, which is what killed jobid 13's progress.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES ('fe-crawl', 1800,
        'FIX-1031 — one bounded FE-totals slice per firing at */30. A cancel here '
        'is SAFE by construction: the slice is atomic, so the watchdog rolls back '
        'rows and watermark together and the next firing retries the same slice.')
ON CONFLICT (jobname) DO UPDATE
  SET budget_seconds = EXCLUDED.budget_seconds,
      note           = EXCLUDED.note,
      updated_at     = now();

NOTIFY pgrst, 'reload schema';
