-- =============================================================================
-- FIX-958 / FIX-959 — a donor industry-tag change now triggers its own
-- (targeted) sector-affinity rebuild, and a content-keyed staleness alarm
-- makes the next silent strand loud.
--
-- THE GAP. official_sector_affinity_rollup is refreshed incrementally off the
-- FIX-704/832 donor dirty set, which keys on financial_relationships.updated_at.
-- A tag-only change never touches a financial relationship, so it never enters
-- the dirty set: the rollup does not update, the FIX-897 pills keep rendering
-- the old industry, and nothing errors. Between 2026-07-16 and 2026-07-29 that
-- left 1,607 of 1,779 override-touched officials on pre-audit pills for eleven
-- days while every check that did not look at freshness passed. The only
-- remedy was a human remembering backfill_official_sector_affinity_rollup()
-- (943.8s / 19,869 rows measured on prod 2026-07-29).
--
-- WHY THE CHANGE SIGNAL IS CONTENT-DERIVED, NEVER TIME-DERIVED (FIX-958
-- decision 1). entity_tags has created_at and NO updated_at, and
-- tagFinancialEntities() performs an authoritative DELETE-then-reinsert of
-- every generated_by='rule' industry row on each run — so max(created_at) for
-- the category resets to ~now every successful night. A "rollup older than the
-- last tag write" check would fire every single night, forever, whether or not
-- anything changed — and a signal that always fires is a signal nobody reads.
-- Instead: an md5 CONTENT signature over the (entity_id, tag) set for
-- entity_type='financial_entity' AND tag_category='industry' (a row count plus
-- a hash), stored in pipeline_state under 'sector_affinity:industry_tag_signature'
-- — the FIX-652/716 'size_tags:donation_watermark' count+signature gate shape.
-- Identical content → identical signature → zero work, no matter how many
-- times the producer rewrites the same rows.
--
-- WHY A PER-DONOR SHADOW TABLE (decision 3). The global signature says THAT
-- something changed, not WHAT. Recomputing the whole rollup because the global
-- signature moved would be the 16-minute backfill all over again (decision 2's
-- failure). public.donor_industry_tag_state holds one row per industry-tagged
-- donor (~24k) with an md5 of its ordered tag set; a FULL OUTER JOIN against
-- the live per-donor signatures yields exactly the donors whose industry
-- assignment changed — including donors whose tags were REMOVED, which a
-- current-rows-only diff would miss. Chosen over "the producer reports the
-- donor ids it changed" because the diff then works for EVERY writer by
-- construction: the nightly Node tagger, a curated-override seed migration
-- (FIX-916/921/923), the AI classifier, a hand edit. Content in, diff out —
-- no writer has to remember to cooperate, which is precisely the failure mode
-- this FIX exists to close.
--
-- THE TARGETED REBUILD (decision 2). Affected recipients = officials who
-- received a donation from a changed donor — an index probe on
-- financial_relationships (from_id) via financial_relationships_donation_size_rollup
-- — rebuilt through the existing sector_affinity_rebuild_officials() in
-- 500-official chunks with per-chunk COMMIT (FIX-703/704 discipline).
-- backfill_official_sector_affinity_rollup() is reserved for a cold start or a
-- signature-store miss, and every run logs WHICH path ran and why
-- (data_sync_log pipeline 'sector_affinity_tag_refresh', metadata.path =
-- noop | targeted | full_backfill).
--
-- THE ALARM (FIX-959 decision 5). check_sector_affinity_tag_staleness()
-- compares the LIVE content signature against the stored one — keyed on
-- signature CHANGE, never write time, so the nightly rewrite of identical
-- content can never false-fire. A mismatch alone is not a strand (the canary
-- runs at 05:00 UTC, inside the nightly window, so it can legitimately observe
-- tags-written-refresh-pending); it escalates only when the STORED signature
-- has been stuck unchanged across >26h of observed mismatch (probe state under
-- 'sector_affinity:staleness_probe'). A stored signature that advanced since
-- the probe was set means the refresh is alive and the mismatch is a NEW
-- change in flight — the probe resets. FIX-884/885 silent-strand class: the
-- guard exists so the next eleven-day drift is loud.
--
-- The donor-side dirty set (FIX-704) is NOT touched — it is correct as-is;
-- the gap was officials-only (decision 6).
-- =============================================================================

-- The partial index below scans the full entity_tags heap (~3.39M rows) once at
-- build time; the migration role's default statement_timeout is too short for
-- that on prod (same as the FIX-443 index build, 20260530030000).
SET LOCAL statement_timeout = '600s';

-- ── 1. Per-donor tag-content shadow ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.donor_industry_tag_state (
  donor_id   uuid PRIMARY KEY,          -- financial_entities.id
  tag_sig    text NOT NULL,             -- md5 of the donor's ordered industry tag set
  tag_count  int  NOT NULL,             -- belt-and-braces beside the hash
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.donor_industry_tag_state IS
  'FIX-958 — per-donor content signature of the financial_entity/industry tag '
  'set (md5 of the ordered tags + row count). Diffed by '
  'refresh_sector_affinity_from_tag_changes() to find exactly the donors whose '
  'industry assignment changed since the last refresh, writer-independent. '
  'Advanced only after a clean targeted rebuild, so a failed run re-derives the '
  'same diff. Truncated + reseeded on the full-backfill (cold start) path.';

ALTER TABLE public.donor_industry_tag_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.donor_industry_tag_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.donor_industry_tag_state TO service_role;

-- ── 2. Signature/diff scan index ─────────────────────────────────────────────
-- The signature and the per-donor diff both scan exactly the
-- financial_entity/industry slice of entity_tags (~40k of 3.39M rows). The
-- unique constraint's index leads (entity_type, entity_id, tag, tag_category),
-- which forces a ~2.4M-entry range scan over every financial_entity row (the
-- 2.33M size tags included) filtering on tag_category. This partial index holds
-- just the slice, in (entity_id, tag) order, so both scans are sub-second
-- index-only probes — cheap enough for the canary to run the signature daily
-- under the prod PostgREST caps.
CREATE INDEX IF NOT EXISTS entity_tags_fe_industry_content
  ON public.entity_tags (entity_id, tag)
  WHERE entity_type = 'financial_entity' AND tag_category = 'industry';

-- ── 3. The content signature ─────────────────────────────────────────────────
-- ONE canonical formula, used by the refresh, the alarm, and any ad-hoc report:
-- per-donor md5 over the ordered tag set, then a global md5 over the ordered
-- (donor, per-donor-sig) pairs, prefixed with the total row count. Identical
-- content always produces the identical string; 'created_at churn' cannot move
-- it (decision 1).
CREATE OR REPLACE FUNCTION public.compute_fe_industry_tag_signature()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH per_donor AS (
    SELECT et.entity_id,
           md5(string_agg(et.tag, ',' ORDER BY et.tag)) AS sig,
           count(*)::bigint                             AS n
      FROM public.entity_tags et
     WHERE et.entity_type  = 'financial_entity'
       AND et.tag_category = 'industry'
     GROUP BY et.entity_id
  )
  SELECT COALESCE(sum(n), 0)::text || '|'
         || COALESCE(md5(string_agg(entity_id::text || ':' || sig, ',' ORDER BY entity_id)), 'empty')
    FROM per_donor;
$$;

COMMENT ON FUNCTION public.compute_fe_industry_tag_signature() IS
  'FIX-958 — content signature ("<row count>|<md5>") over the (entity_id, tag) '
  'set for entity_type=financial_entity AND tag_category=industry. '
  'Content-derived by construction: the nightly DELETE-then-reinsert of an '
  'identical tag set produces the identical signature (entity_tags has no '
  'updated_at and its created_at resets every night — a time-derived signal '
  'would fire forever). Stored in pipeline_state '
  '''sector_affinity:industry_tag_signature'' by the refresh procedure.';

-- ── 4. The gated, targeted refresh ───────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.refresh_sector_affinity_from_tag_changes()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key   bigint := hashtext('sector_affinity_tag_refresh')::bigint;
  c_sig_key    constant text := 'sector_affinity:industry_tag_signature';
  c_chunk      constant int  := 500;   -- matches backfill_official_sector_affinity_rollup
  v_log_id     uuid;
  v_live_sig   text;
  v_stored_sig text;
  v_shadow_n   bigint;
  v_reason     text;
  v_donors     uuid[];
  v_n_donors   int;
  v_officials  uuid[];
  v_n_off      int := 0;
  v_chunk_ids  uuid[];
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent sector-affinity tag refresh'));
    RAISE NOTICE '[sector-affinity tag refresh] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  -- Signature FIRST, before any rebuild: tag writes that land mid-run make the
  -- NEXT run's live signature differ from what this run stores, so they are
  -- re-processed rather than silently absorbed — the FIX-704
  -- capture-watermark-before-dirty-set discipline, content-shaped.
  v_live_sig := public.compute_fe_industry_tag_signature();

  SELECT value->>'sig' INTO v_stored_sig
    FROM public.pipeline_state WHERE key = c_sig_key;

  SELECT count(*) INTO v_shadow_n FROM public.donor_industry_tag_state;

  -- ── Path 1: no-op — identical content, zero rollup work ────────────────────
  IF v_stored_sig IS NOT NULL AND v_shadow_n > 0 AND v_live_sig = v_stored_sig THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
    VALUES ('sector_affinity_tag_refresh', 'complete', now(), now(), 0,
            jsonb_build_object('path', 'noop',
                               'reason', 'industry tag content signature unchanged',
                               'sig', v_live_sig));
    RAISE NOTICE '[sector-affinity tag refresh] noop — signature unchanged (%)', v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 2: cold start / signature-store miss — the full backfill ──────────
  IF v_stored_sig IS NULL OR v_shadow_n = 0 THEN
    v_reason := CASE WHEN v_stored_sig IS NULL
                     THEN 'cold_start_no_signature'
                     ELSE 'signature_store_miss_empty_shadow' END;
    INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'running', now(),
            jsonb_build_object('path', 'full_backfill', 'reason', v_reason))
    RETURNING id INTO v_log_id;
    COMMIT;

    -- Deliberately NOT wrapped in an EXCEPTION block: the nested procedure
    -- COMMITs per chunk, and transaction control is illegal inside a plpgsql
    -- EXCEPTION subtransaction. On failure the error propagates, the signature
    -- is never seeded, and the next run retries the cold path — fail-safe
    -- direction is REBUILD, same as the FIX-652 gate.
    CALL public.backfill_official_sector_affinity_rollup();

    DELETE FROM public.donor_industry_tag_state;
    INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
    SELECT et.entity_id,
           md5(string_agg(et.tag, ',' ORDER BY et.tag)),
           count(*)::int,
           now()
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', now()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    UPDATE public.data_sync_log
       SET status = 'complete', completed_at = now(),
           metadata = metadata || jsonb_build_object('sig', v_live_sig)
     WHERE id = v_log_id;

    RAISE NOTICE '[sector-affinity tag refresh] full backfill (%) — signature store seeded (%)',
      v_reason, v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 3: targeted — diff the per-donor shadow, rebuild only the affected ─
  WITH cur AS (
    SELECT et.entity_id AS donor_id,
           md5(string_agg(et.tag, ',' ORDER BY et.tag)) AS sig,
           count(*)::int AS n
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id
  )
  SELECT array_agg(donor_id) INTO v_donors
    FROM (
      SELECT COALESCE(c.donor_id, s.donor_id) AS donor_id
        FROM cur c
        FULL OUTER JOIN public.donor_industry_tag_state s ON s.donor_id = c.donor_id
       WHERE c.donor_id IS NULL                       -- tags removed entirely
          OR s.donor_id IS NULL                       -- newly tagged donor
          OR c.sig IS DISTINCT FROM s.tag_sig
          OR c.n   IS DISTINCT FROM s.tag_count
    ) d;

  v_n_donors := COALESCE(array_length(v_donors, 1), 0);

  -- v_n_donors = 0 with a moved global signature means tags changed between the
  -- signature capture and this diff (the shadow was already advanced past the
  -- captured signature by content that arrived mid-scan). Nothing to rebuild
  -- for THIS signature; the newer content re-diffs on the next run. Advance and
  -- log donors_changed=0 — self-healing by construction.
  IF v_n_donors > 0 THEN
    SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
      FROM unnest(v_donors) AS d(id)
      JOIN public.financial_relationships fr ON fr.from_id = d.id
     WHERE fr.relationship_type = 'donation'
       AND fr.from_type = 'financial_entity'
       AND fr.to_type   = 'official'
       AND fr.amount_cents > 0;
    v_n_off := COALESCE(array_length(v_officials, 1), 0);
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('sector_affinity_tag_refresh', 'running', now(),
          jsonb_build_object('path', 'targeted',
                             'reason', 'industry tag content signature changed',
                             'donors_changed', v_n_donors,
                             'officials_affected', v_n_off,
                             'sig_before', v_stored_sig,
                             'sig_after', v_live_sig))
  RETURNING id INTO v_log_id;
  COMMIT;

  WHILE v_i <= v_n_off LOOP
    v_chunk_ids := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n_off)];
    v_chunk_no  := v_chunk_no + 1;
    BEGIN
      v_n    := public.sector_affinity_rebuild_officials(v_chunk_ids);
      v_rows := v_rows + v_n;
    EXCEPTION WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its officials keep their PRIOR
      -- rollup rows (complete-if-stale) and the un-advanced signature re-derives
      -- the same diff next run.
      v_failures := v_failures || format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction (PL/pgSQL rule)
    v_i := v_i + c_chunk;
  END LOOP;

  -- Advance shadow + signature only on a clean run.
  IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    IF v_n_donors > 0 THEN
      DELETE FROM public.donor_industry_tag_state s
       WHERE s.donor_id = ANY (v_donors)
         AND NOT EXISTS (
           SELECT 1 FROM public.entity_tags et
            WHERE et.entity_type  = 'financial_entity'
              AND et.tag_category = 'industry'
              AND et.entity_id    = s.donor_id);

      INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
      SELECT et.entity_id,
             md5(string_agg(et.tag, ',' ORDER BY et.tag)),
             count(*)::int,
             now()
        FROM unnest(v_donors) AS d(id)
        JOIN public.entity_tags et ON et.entity_id = d.id
       WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
       GROUP BY et.entity_id
      ON CONFLICT (donor_id) DO UPDATE
        SET tag_sig = EXCLUDED.tag_sig,
            tag_count = EXCLUDED.tag_count,
            updated_at = now();
    END IF;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', now()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;

  UPDATE public.data_sync_log
     SET status        = CASE WHEN array_length(v_failures, 1) > 0 THEN 'failed' ELSE 'complete' END,
         completed_at  = now(),
         rows_inserted = v_rows,
         rows_failed   = COALESCE(array_length(v_failures, 1), 0),
         error_message = CASE WHEN array_length(v_failures, 1) > 0
                              THEN left(array_to_string(v_failures, '; '), 1000)
                              ELSE NULL END,
         metadata      = metadata || jsonb_build_object(
                           'rollup_rows', v_rows,
                           'chunks', v_chunk_no,
                           'chunk_failures', COALESCE(array_length(v_failures, 1), 0))
   WHERE id = v_log_id;

  RAISE NOTICE '[sector-affinity tag refresh] % — % donor(s) changed, % official(s) in % chunk(s), % rows (% failures)',
    CASE WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_n_donors, v_n_off, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;

COMMENT ON PROCEDURE public.refresh_sector_affinity_from_tag_changes() IS
  'FIX-958 — content-signature-gated refresh of official_sector_affinity_rollup '
  'off donor industry-tag changes. noop when the signature is unchanged; '
  'targeted sector_affinity_rebuild_officials() (500/chunk, COMMIT each) over '
  'exactly the officials who received from a changed donor when it moved; '
  'backfill_official_sector_affinity_rollup() only on a cold start / '
  'signature-store miss. Logs which path ran and why under data_sync_log '
  'pipeline sector_affinity_tag_refresh. Nightly entry point: runRuleBasedTagger '
  'between tagFinancialEntities and tagOfficials (FIX-959 ordering).';

-- ── 5. The staleness alarm ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_sector_affinity_tag_staleness()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  c_sig_key    constant text := 'sector_affinity:industry_tag_signature';
  c_probe_key  constant text := 'sector_affinity:staleness_probe';
  -- One full nightly cycle (the refresh runs nightly inside runRuleBasedTagger)
  -- plus slack. A mismatch is only a strand once a whole cycle failed to clear it.
  c_grace      constant interval := interval '26 hours';
  v_live       text;
  v_stored     text;
  v_changed_at timestamptz;
  v_probe      jsonb;
  v_first      timestamptz;
  v_hours      numeric;
BEGIN
  v_live := public.compute_fe_industry_tag_signature();

  SELECT value->>'sig', (value->>'changed_at')::timestamptz
    INTO v_stored, v_changed_at
    FROM public.pipeline_state WHERE key = c_sig_key;

  -- Pre-bootstrap env: no signature store yet. Not a strand — the refresh's
  -- cold-start path owns seeding it. Report, never alarm.
  IF v_stored IS NULL THEN
    DELETE FROM public.pipeline_state WHERE key = c_probe_key;
    RETURN jsonb_build_object('stale', false, 'state', 'no_signature_store',
                              'live_sig', v_live);
  END IF;

  IF v_live = v_stored THEN
    DELETE FROM public.pipeline_state WHERE key = c_probe_key;
    RETURN jsonb_build_object('stale', false, 'state', 'match',
                              'live_sig', v_live,
                              'stored_changed_at', v_changed_at);
  END IF;

  SELECT value INTO v_probe FROM public.pipeline_state WHERE key = c_probe_key;
  v_first := (v_probe->>'first_mismatch_at')::timestamptz;

  -- First observation of this mismatch epoch — or the stored signature has
  -- ADVANCED since the probe was set, which means the refresh is alive and this
  -- mismatch is a NEW change in flight, not the old one stranded. Reset the
  -- probe either way and give the nightly one cycle to absorb it.
  IF v_probe IS NULL OR (v_probe->>'stored_sig') IS DISTINCT FROM v_stored THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_probe_key, jsonb_build_object('first_mismatch_at', now()::text,
                                            'stored_sig', v_stored))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    RETURN jsonb_build_object('stale', false, 'state', 'pending',
                              'live_sig', v_live, 'stored_sig', v_stored,
                              'hours_outstanding', 0);
  END IF;

  v_hours := round(extract(epoch FROM (now() - v_first)) / 3600.0, 1);

  IF now() - v_first > c_grace THEN
    RETURN jsonb_build_object('stale', true, 'state', 'stranded',
                              'live_sig', v_live, 'stored_sig', v_stored,
                              'stored_changed_at', v_changed_at,
                              'first_mismatch_at', v_first,
                              'hours_outstanding', v_hours);
  END IF;

  RETURN jsonb_build_object('stale', false, 'state', 'pending',
                            'live_sig', v_live, 'stored_sig', v_stored,
                            'first_mismatch_at', v_first,
                            'hours_outstanding', v_hours);
END;
$$;

COMMENT ON FUNCTION public.check_sector_affinity_tag_staleness() IS
  'FIX-959 — canary detector: is a donor industry-tag content change stranded '
  'un-incorporated in official_sector_affinity_rollup? Compares the live '
  'content signature to pipeline_state sector_affinity:industry_tag_signature. '
  'stale=true only when the STORED signature has sat unchanged across >26h of '
  'observed mismatch (probe under sector_affinity:staleness_probe) — a stored '
  'signature that advanced means the refresh is alive and the mismatch is a new '
  'change in flight. Keyed on signature-change time, never write time, so the '
  'nightly DELETE-then-reinsert of identical content cannot false-fire. Called '
  'by canary-check.ts beside the FIX-885/943/944 detectors; escalates the run.';

-- ── 6. Grant hygiene (FIX-695/834) ───────────────────────────────────────────
REVOKE ALL ON FUNCTION public.compute_fe_industry_tag_signature()          FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.compute_fe_industry_tag_signature()          TO service_role;
REVOKE ALL ON PROCEDURE public.refresh_sector_affinity_from_tag_changes()  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.refresh_sector_affinity_from_tag_changes()  TO service_role;
REVOKE ALL ON FUNCTION public.check_sector_affinity_tag_staleness()        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_sector_affinity_tag_staleness()        TO service_role;

-- PostgREST: new table + new RPC → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
