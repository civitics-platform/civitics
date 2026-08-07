-- =============================================================================
-- FIX-974 — A BULK regime for the six donor rollups: to_id-RANGE chunks,
--           set-based, one FR scan per chunk feeding all six arms.
--
-- ── Why a second regime rather than tuning the first ────────────────────────
-- refresh_official_donor_rollup_incremental() drives donor_rollup_rebuild_
-- recipients(uuid[]) over a per-recipient dirty set. That is the right shape
-- for a trickle (a nightly's worth of newly-touched officials) and the WRONG
-- shape for a backlog: FIX-973 measured it at 19.0 s/recipient on 2026-08-06
-- (vs 1.35 s/recipient on 07-31), ~33 ms per FR row — about one random page
-- read per row. With 9,086 recipients still owed that is ~48 h of pure compute.
--
-- The cost is ACCESS PATTERN, not arithmetic, and it has two sources:
--
--   1. `to_id = ANY(p_recipients)` over 50 scattered uuids is 50 independent
--      index descents plus scattered heap access. A `to_id >= lo AND to_id < hi`
--      RANGE predicate over the same index is one dense, largely sequential
--      walk. financial_relationships_donor_rollup_idx is
--        (to_id, relationship_type, from_id) INCLUDE (amount_cents)
--        WHERE relationship_type IN ('donation','ie_support','ie_oppose')
--              AND from_type = 'financial_entity'
--      so to_id LEADS it — the range is exactly what it was built to serve.
--
--   2. The six arms EACH re-scan financial_relationships for the same
--      recipients. Six passes over the same rows through a 256 MB
--      shared_buffers (FIX-589) is six chances to miss. Here ONE scan lands in
--      UNLOGGED staging and all six arms are derived from it.
--
-- ── The index-only unlock (measured on prod 2026-08-06, 6,457,535 rows) ─────
-- Arms 2-6 filter `fr.to_type = 'official'`, and to_type is NOT in the rollup
-- index — so every such row needs a heap visit. But the predicate is redundant:
--
--     rows with to_type='official' and no public.officials row   → 0
--     rows with to_type<>'official' whose to_id IS an official   → 0
--
-- i.e. within this index's WHERE scope, `to_type = 'official'` is EXACTLY
-- `to_id IN (SELECT id FROM officials)`. Resolving official-ness through the
-- target table instead of the heap column lets the whole FR scan stay
-- INDEX-ONLY. (financial_relationships is 94.1% all-visible — FIX-973 — so the
-- visibility map actually pays out. If that decays, this degrades to the old
-- cost: see the FIX-943/884 vacuum rule, and the VACUUM tail below.)
--
-- ── Shape (FIX-965's resumable global rebuild, generalised) ─────────────────
-- One loop of to_id-RANGE chunks. Per chunk, in ONE transaction:
--
--     A. TRUNCATE _drb_donor; INSERT the chunk's per-(to_id, relationship_type,
--        from_id) aggregate — one index-only FR range scan. Seven measures, one
--        per distinct thing the six arms need (see the column comments).
--     B. Materialise _drb_chunk_fe: this chunk's donors only, from the slim
--        sweep-scoped donor dimension _drb_fe. ONE donor-dimension access per
--        chunk instead of one per arm.
--     C. Derive all six arms from (A) JOIN (B) and write them.
--     D. Advance the chunk cursor in pipeline_state. COMMIT.
--
-- Same durability contract as FIX-944/965: the cursor advances INSIDE the
-- chunk's transaction, so a run cancelled mid-chunk loses at most that chunk;
-- a predictive between-chunk wall-clock budget (elapsed + slowest×1.25) is the
-- ONLY clean stop and exits status='partial'; chunk FAILURE aborts the run
-- rather than skipping (a skipped range would silently leave a stale island);
-- staging is UNLOGGED, and a resume that finds it crash-truncated, or a sweep
-- older than the staleness bound, restarts from chunk 0.
--
-- ── DELIBERATE DEVIATION from FIX-965: no whole-table publish swap ──────────
-- FIX-965 accumulates every chunk into staging and swaps at the end because
-- its chunks are keyed by DONOR (from_id) while its output is partitioned by
-- STATE — a donor range contributes to every state, so no chunk's output is
-- final until all of them have merged.
--
-- Here the chunk key IS the output partition key: every one of the six arms is
-- keyed by official_id / scope_id, which is to_id. A chunk's output is
-- therefore FINAL for that chunk's recipients, and there is no cross-chunk
-- merge to protect. Writing straight into the live arms per chunk:
--
--   * halves the write volume and the dead-tuple load (a shadow copy would be
--     written once to staging and once to live) — decisive on a box whose
--     measured problem is I/O, and the exact load FIX-943 exists to bound;
--   * preserves the only atomicity that matters to a reader — one official is
--     either wholly old or wholly new, consistent ACROSS all six arms, because
--     one chunk is one transaction;
--   * makes a partial run worth something, which is the entire point of
--     clearing a backlog.
--
-- What a swap would add is cross-OFFICIAL epoch consistency, which these tables
-- have never had (the incremental converges an official at a time) and which
-- the 9,086-recipient backlog already violates far more.
--
-- ── Coordination with the live incremental (no schedule change) ─────────────
-- This procedure takes the SAME advisory lock as
-- refresh_official_donor_rollup_incremental() — hashtext('official_donor_
-- rollup_refresh'). A 09:00/12:00 pg_cron firing during a bulk run therefore
-- defers behind it exactly as the two firings already chain behind each other
-- (FIX-972). On COMPLETION the bulk sweep advances
-- pipeline_state.donor_rollup_watermark.last_indexed_at to the target captured
-- at sweep start and clears the incremental's in-flight cursor, so the next
-- firing builds a near-empty dirty set instead of redoing this work.
--
-- ── Modes ──────────────────────────────────────────────────────────────────
--   civitics.donor_rollup_bulk_mode = 'dirty' (default) | 'full'
-- 'dirty' scopes the target table to recipients with FR touched since the
-- watermark; 'full' takes every recipient. Range chunks make the two much
-- closer in cost than the per-recipient regime would suggest (the index walk
-- covers the range either way) — the difference is the per-arm derivation.
--
-- NOT changed: what any arm COMPUTES. Every arm below is a set-based transcript
-- of the live per-recipient body (pg_get_functiondef md5 read from prod
-- 2026-08-06: donor_rollup_rebuild_recipients dc22edfb4d8dd0cc69f642c794180518,
-- plus small_dollar_rebuild_officials, sector_affinity_rebuild_officials,
-- treemap_individuals_rebuild_officials,
-- treemap_individual_brackets_rebuild_officials). Equality against those is the
-- acceptance test, not a delta.
--
-- Cross-ref FIX-965, FIX-944, FIX-969 (this is the bulk half of its regime
-- split), FIX-970, FIX-972, FIX-973, FIX-943, FIX-884, FIX-589.
-- =============================================================================

-- ── Sweep-scoped staging ────────────────────────────────────────────────────
-- Created here so grants/ownership are migration-managed rather than invented
-- at runtime; the procedure TRUNCATEs and repopulates them per sweep/chunk.

DROP TABLE IF EXISTS public._drb_donor;
DROP TABLE IF EXISTS public._drb_chunk_fe;
DROP TABLE IF EXISTS public._drb_fe;
DROP TABLE IF EXISTS public._drb_targets;

-- Recipients this sweep is responsible for. is_official is resolved ONCE here
-- (against public.officials) so no arm has to touch fr.to_type and the FR scan
-- can stay index-only. See the equivalence proof in the header.
CREATE UNLOGGED TABLE public._drb_targets (
  to_id       uuid    PRIMARY KEY,
  is_official boolean NOT NULL
);

-- Slim, sweep-scoped donor dimension: everything the arms need about a donor,
-- with the industry tag already folded in, so entity_tags is probed once per
-- sweep rather than once per chunk per arm. financial_entities is wide (jsonb
-- metadata); this is not.
CREATE UNLOGGED TABLE public._drb_fe (
  id             uuid PRIMARY KEY,
  display_name   text,
  entity_type    text,
  state          text,
  industry_tag   text,
  industry_label text
);

-- This chunk's donors only — one _drb_fe access per chunk, then six cheap
-- joins against a small local table.
CREATE UNLOGGED TABLE public._drb_chunk_fe (
  id             uuid PRIMARY KEY,
  display_name   text,
  entity_type    text,
  state          text,
  industry_tag   text,
  industry_label text
);

-- The chunk's single FR scan, aggregated to (recipient, relationship_type,
-- donor). Seven measures because the six arms slice the same rows seven ways:
--   total_cents   SUM(amount_cents)                       — arm 1 (NULL-skipping, as live)
--   total_cents0  SUM(COALESCE(amount_cents,0))           — arm 2 (COALESCEd, as live)
--   tx_count      COUNT(*)                                — arms 1, 2
--   small_cents / small_count   amount in (0, 50000)      — arm 3
--   pos_cents / pos_count       amount > 0                — arms 4, 5, 6
CREATE UNLOGGED TABLE public._drb_donor (
  to_id             uuid   NOT NULL,
  relationship_type text   NOT NULL,
  from_id           uuid   NOT NULL,
  total_cents       bigint,
  total_cents0      bigint NOT NULL,
  tx_count          bigint NOT NULL,
  small_cents       bigint NOT NULL,
  small_count       bigint NOT NULL,
  pos_cents         bigint NOT NULL,
  pos_count         bigint NOT NULL
);

-- Supabase default-grants table access broadly and this staging can persist for
-- hours mid-sweep. Nothing reads it but the procedure. (FIX-965 precedent.)
REVOKE ALL ON public._drb_targets  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public._drb_fe       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public._drb_chunk_fe FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public._drb_donor    FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()
LANGUAGE plpgsql
AS $procedure$
DECLARE
  -- SAME key as refresh_official_donor_rollup_incremental(): the two regimes
  -- must never interleave on the same tables, and a scheduled firing during a
  -- bulk run should defer, not race.
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_state_key  text   := 'donor_rollup_bulk_sweep';
  c_global     uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks     int    := 32;      -- must divide 256 (uuid first-byte ranges)
  c_budget     interval := interval '4 hours 30 minutes';
  c_max_sweep  interval := interval '48 hours';

  v_state      jsonb;
  v_cursor     int;               -- last COMMITTED chunk (-1 = none)
  v_mode       text;
  v_resumed    boolean := false;
  v_restarted  text    := NULL;
  v_sweep_beg  timestamptz;
  v_sweep_tgt  timestamptz;       -- FR watermark captured at sweep start
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

  -- Plain SET (not SET LOCAL) so it survives the per-chunk COMMITs. The CALL's
  -- statement_timeout is armed at CALL start and CANNOT be changed from here
  -- (FIX-944, measured) — the c_budget guard is the only clean stop.
  SET work_mem = '256MB';

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_budget_seconds', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_cfg);
  END IF;

  -- Chunk count must divide 256 so the uuid first-byte ranges tile exactly.
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
    -- A resume must reuse the sweep's ORIGINAL mode and chunk count: both
    -- change what a cursor value means.
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
    -- ── Fresh sweep ─────────────────────────────────────────────────────────
    -- Capture the FR watermark BEFORE building the target set, so anything
    -- written mid-sweep is left for the NEXT sweep rather than silently
    -- consumed (the FIX-704 invariant).
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
          AND fr.updated_at > v_watermark
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    END IF;

    -- Slim donor dimension, built once. entity_tags' industry pick mirrors the
    -- FIX-518/704 `ind` CTE exactly: DISTINCT ON (entity_id) ORDER BY tag, i.e.
    -- the alphabetically smallest tag, deterministically.
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
  COMMIT;  -- publish the running row; keep the first chunk's txn short

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    -- PREDICTIVE budget guard (FIX-944/965): stop when the slowest chunk seen
    -- so far, plus 25% headroom, would not fit in what remains. Only stop path.
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
      -- ── A. THE one FR scan. Index-only on financial_relationships_donor_
      -- rollup_idx: to_id leads it, and every column referenced (to_id,
      -- relationship_type, from_id, amount_cents) is in the index. to_type is
      -- deliberately NOT referenced — see the equivalence proof in the header.
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

      -- ── B. This chunk's donors, once.
      TRUNCATE public._drb_chunk_fe;
      INSERT INTO public._drb_chunk_fe (id, display_name, entity_type, state, industry_tag, industry_label)
      SELECT f.id, f.display_name, f.entity_type, f.state, f.industry_tag, f.industry_label
      FROM public._drb_fe f
      WHERE f.id IN (SELECT DISTINCT d.from_id FROM public._drb_donor d);

      ANALYZE public._drb_donor;
      ANALYZE public._drb_chunk_fe;

      -- ── C. The six arms. Each is a set-based transcript of its live
      -- per-recipient body; nothing about WHAT is computed changes.

      -- Arm 1 — official_donor_rollup_mv: top-200 donors per
      -- (recipient, relationship_type) plus one rank-201 tail aggregate.
      -- NOTE (FIX-970): this arm is deliberately NOT scoped to officials,
      -- matching the live body. Re-scoping it is FIX-970's call, not this one's.
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

      -- Arm 2 — official_donor_totals (FIX-836). Donations to officials only.
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

      -- Arm 3 — official_small_dollar_rollup (FIX-776). Sub-$500 donations.
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

      -- Arm 4 — official_sector_affinity_rollup (FIX-777). Per-(official,
      -- industry) dollars and DISTINCT DONOR count over positive donations.
      DELETE FROM public.official_sector_affinity_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_sector_affinity_rollup
        (official_id, industry, total_cents, donor_count, updated_at)
      SELECT d.to_id,
             COALESCE(fe.industry_tag, 'Untagged'),
             SUM(d.pos_cents)::bigint,
             COUNT(*)::bigint,          -- one _drb_donor row per donor here
             now()
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
        AND d.pos_cents > 0
      GROUP BY d.to_id, COALESCE(fe.industry_tag, 'Untagged');

      -- Arm 5 — treemap_individuals_rollup, per-official scopes (FIX-779).
      -- The GLOBAL sentinel scope belongs to refresh_treemap_individuals_global()
      -- (FIX-965) and is never touched here; _drb_targets cannot contain it
      -- (it is not a recipient), but the guard is explicit for safety.
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

      -- Arm 6 — official_donor_bracket_totals (FIX-868). Per-(official, tier)
      -- over PER-DONOR lifetime totals, individuals only.
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

      -- ── D. Cursor advances INSIDE the chunk's transaction (FIX-944/965).
      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object('chunk_cursor', k),
             updated_at = clock_timestamp()   -- FIX-972: NOT NOW(), which stamps the chunk's START
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Abort, do not skip: a skipped range leaves a silently stale island of
      -- officials that no later run would know to revisit (FIX-965's rule).
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;  -- top level (PL/pgSQL forbids COMMIT inside the EXCEPTION block)

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

  -- ── Sweep complete ─────────────────────────────────────────────────────────
  -- Hand the incremental a clean slate: advance its watermark to the target
  -- captured at sweep start and drop any in-flight per-recipient cursor, so the
  -- next 09:00/12:00 firing builds a near-empty dirty set instead of redoing
  -- everything this sweep just did. Anything written to FR after that capture
  -- has updated_at > sweep_target and is picked up by the next firing.
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
  -- NOTE: the caller MUST VACUUM (ANALYZE) the six arms afterwards — this is a
  -- bulk rewrite and VACUUM cannot run inside a procedure (FIX-943 standing
  -- rule). packages/data/src/scripts/donor-rollup-bulk.ts does it.
END;
$procedure$;

COMMENT ON PROCEDURE public.donor_rollup_rebuild_bulk() IS
  'FIX-974 — BULK regime for the six per-official money rollups: to_id-RANGE '
  'chunks (default 32, GUC civitics.donor_rollup_bulk_chunks) each doing ONE '
  'index-only scan of financial_relationships_donor_rollup_idx into UNLOGGED '
  'staging, from which all six arms are derived — versus the per-recipient '
  'regime of refresh_official_donor_rollup_incremental(), which scatter-probes '
  'and re-scans FR once per arm. Scope via civitics.donor_rollup_bulk_mode '
  '(''dirty'' default | ''full''); budget via '
  'civitics.donor_rollup_bulk_budget_seconds (default 4h30m). Resumable: the '
  'chunk cursor (pipeline_state.donor_rollup_bulk_sweep) advances inside each '
  'chunk transaction; budget exhaustion exits status=''partial''; a chunk '
  'failure ABORTS rather than skipping. Takes the SAME advisory lock as the '
  'incremental, and on completion advances donor_rollup_watermark so the '
  'scheduled firings do not redo the work. Callers must VACUUM (ANALYZE) the '
  'six arms afterwards (FIX-943). Driver: '
  'packages/data/src/scripts/donor-rollup-bulk.ts.';

REVOKE ALL ON PROCEDURE public.donor_rollup_rebuild_bulk() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.donor_rollup_rebuild_bulk() TO service_role;
