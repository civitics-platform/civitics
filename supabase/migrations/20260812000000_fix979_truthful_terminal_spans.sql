-- =============================================================================
-- FIX-979 — the three single-row terminal writers stop reporting zero-length
-- runs, and pipeline_runtime_stats_mv stops rendering 0 ms as a runtime.
--
-- THE DEFECT. Three rollup procedures close out with ONE data_sync_log row:
--
--   INSERT INTO data_sync_log (pipeline, status, started_at, completed_at, …)
--   VALUES ('…', 'complete', now(), now(), …);
--
-- `now()` is `transaction_timestamp()`, frozen at transaction start, so BOTH
-- calls return the same value and the recorded duration is EXACTLY zero. Same
-- root cause as FIX-972, surfacing where FIX-972 never looked — playbook E5
-- (after fixing one site, grep for the mechanism). The row is not visible until
-- COMMIT, so it does not advertise completion early to other readers, and per
-- playbook D2 a missing `running` row is not itself a liveness defect. The
-- defect is the TIMESTAMPS.
--
-- Measured on prod: every retained row for official_vote_stats_rebuild,
-- agency_staffing_rollup_refresh and contract_flow_rollups_rebuild has
-- `completed_at - started_at = 0.000000`. Exact-alignment proof —
-- contract_flow_rollups_rebuild runid 130 ran 14:00:02.448368 → 15:58:48.014711
-- (7,125.6 s per cron.job_run_details) while its data_sync_log row reads
-- started_at = completed_at = 14:00:02.448486. It understates the finish by
-- 1h58m. Consequence: 8 of 46 pipelines report p50 = p95 = max = 0 ms on
-- /admin/pipeline-health, including treemap_individuals_global_refresh, whose
-- 21,615.9 s run renders as 0 ms on the only runtime surface the platform has.
--
-- (a) clock_timestamp() for the terminal stamp. Playbook E7: NOW() is for
--     transactional consistency, not observability. Each procedure now also
--     captures its true entry time into a variable at block entry and uses that
--     for started_at.
--
--     That second half matters most for refresh_agency_staffing_rollup, which
--     COMMITs per 50-agency chunk: its trailing `now()` is the timestamp of the
--     transaction that began after the LAST commit, so `started_at` was landing
--     near the END of the run, not the start. Both of its columns were wrong,
--     not just one.
--
-- (b) NOT DONE, deliberately, for the other two. Restructuring to an entry row +
--     terminal UPDATE is only clean where the procedure already commits mid-run.
--     refresh_contract_flow_rollups and rebuild_official_vote_stats hold
--     pg_try_advisory_XACT_lock and do an atomic DELETE+INSERT swap in ONE
--     transaction — an entry row would need a COMMIT, which releases the xact
--     lock and breaks the swap's atomicity. The captured-entry-time variable
--     gives the identical truthful span with no new failure mode and no new
--     orphan-row regime, so it is the shape used in all three.
--
-- (c) pipeline_runtime_stats_mv no longer folds zero-span rows into the duration
--     percentiles, and reports how many it set aside. A pipeline whose every row
--     is zero-span now reads NULL ("—" on the admin page) rather than 0 ms — an
--     honest "not measured" instead of a confident lie. The refresh wiring
--     (refresh_pipeline_runtime_stats_mv → pg_cron) is untouched.
--
-- The reaped-row hazard from FIX-971 lands on the same two columns: a reaped row
-- now carries completed_at = NULL, which the MV's existing
-- `completed_at IS NOT NULL` predicate already excludes.
--
-- Cross-ref FIX-972, FIX-971, FIX-969, FIX-973, FIX-837, FIX-838, FIX-778,
-- FIX-873.
-- =============================================================================

-- ── 1. refresh_contract_flow_rollups() ───────────────────────────────────────
-- Body is byte-identical to 20260721010000_fix873_contract_flow_tag_dedup.sql
-- (the LATEST definition — 20260719020000_fix838 is superseded by it) except for
-- v_started and the terminal stamp.
CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_recipients bigint;
  v_flows      bigint;
  -- FIX-979: real entry time. Single-transaction procedure, so now() would in
  -- fact be correct here — the variable is used anyway so all three writers
  -- carry one greppable pattern.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('contract_flow_rollups_rebuild')::bigint) THEN
    RAISE NOTICE '[contract-flow rollups] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  -- Recipient rollup: top-500 recipients — byte-identical to
  -- treemap_recipients_by_contracts_full(500). One deterministic industry per
  -- recipient (FIX-873) → 500 distinct entity_ids, no fan-out.
  DELETE FROM public.contract_recipient_rollup;
  INSERT INTO public.contract_recipient_rollup
    (entity_id, entity_name, industry, naics_code, total_cents, award_count)
  WITH recipient_industry AS (
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  )
  SELECT
    fe.id::UUID,
    fe.display_name,
    COALESCE(ri.tag, 'Other'),
    MIN(fr.metadata->>'naics_code'),
    SUM(fr.amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fe.id, fe.display_name, ri.tag
  ORDER BY SUM(fr.amount_cents) DESC
  LIMIT 500;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  -- Agency × sector chord rollup: FULL dataset — byte-identical to
  -- chord_contract_flows_full(). Each award in exactly one sector (FIX-873).
  DELETE FROM public.contract_agency_sector_rollup;
  INSERT INTO public.contract_agency_sector_rollup
    (agency_id, agency_name, agency_acronym, sector, total_cents, award_count)
  WITH recipient_industry AS (
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
    ORDER BY et.entity_id, et.tag
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        ri.tag,
        CASE SUBSTRING(fr.metadata->>'naics_code' FROM 1 FOR 2)
          WHEN '11' THEN 'Agriculture'
          WHEN '21' THEN 'Mining'
          WHEN '22' THEN 'Utilities'
          WHEN '23' THEN 'Construction'
          WHEN '31' THEN 'Manufacturing'
          WHEN '32' THEN 'Manufacturing'
          WHEN '33' THEN 'Manufacturing'
          WHEN '42' THEN 'Wholesale Trade'
          WHEN '44' THEN 'Retail'
          WHEN '45' THEN 'Retail'
          WHEN '48' THEN 'Transportation'
          WHEN '49' THEN 'Transportation'
          WHEN '51' THEN 'Information Technology'
          WHEN '52' THEN 'Finance'
          WHEN '54' THEN 'Professional Services'
          WHEN '56' THEN 'Administrative Services'
          WHEN '61' THEN 'Education'
          WHEN '62' THEN 'Healthcare'
          WHEN '71' THEN 'Arts & Entertainment'
          WHEN '72' THEN 'Hospitality'
          WHEN '81' THEN 'Other Services'
          WHEN '92' THEN 'Government'
          ELSE 'Other'
        END,
        'Other'
      )                                               AS sector,
      fr.amount_cents
    FROM public.financial_relationships fr
    JOIN public.agencies a
      ON a.id = fr.from_id AND fr.from_type = 'agency'
    LEFT JOIN public.financial_entities fe
      ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
    LEFT JOIN recipient_industry ri
      ON ri.entity_id = fe.id
    WHERE fr.relationship_type = 'contract'
      AND fr.amount_cents > 0
  )
  SELECT
    agency_id,
    agency_name,
    agency_acronym,
    sector,
    SUM(amount_cents)::BIGINT,
    COUNT(*)::BIGINT
  FROM classified
  GROUP BY agency_id, agency_name, agency_acronym, sector;
  GET DIAGNOSTICS v_flows = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the writes.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('contract_flow_rollups_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text,
                             'recipients', v_recipients, 'agency_sectors', v_flows))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  -- FIX-979: clock_timestamp(), not now(). runid 130 ran 7,125.6 s and reported
  -- 0.000000 because both columns were the same frozen transaction_timestamp().
  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('contract_flow_rollups_rebuild', 'complete', v_started, clock_timestamp(),
          v_recipients + v_flows,
          jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows));

  RAISE NOTICE '[contract-flow rollups] complete — % recipients, % agency×sector rows',
    v_recipients, v_flows;
END;
$$;

COMMENT ON PROCEDURE public.refresh_contract_flow_rollups() IS
  'FIX-838/FIX-873/FIX-979 — full atomic rebuild of contract_recipient_rollup '
  '(top-500) + contract_agency_sector_rollup (full), byte-identical to the two '
  '_full() fns (one deterministic industry per recipient — no multi-tag '
  'fan-out). Weekly via pg_cron contract-flow-rollups-refresh (Thu 14:00 UTC); '
  'also the per-env bootstrap / break-glass. FIX-979: the data_sync_log row '
  'stamps clock_timestamp() at exit against a captured entry time, so the span '
  'is the real runtime and not 0.';

-- ── 2. rebuild_official_vote_stats() ─────────────────────────────────────────
-- Body byte-identical to 20260719000000_fix837 except v_started + the stamp.
CREATE OR REPLACE PROCEDURE public.rebuild_official_vote_stats()
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count   bigint;
  v_started timestamptz := clock_timestamp();  -- FIX-979
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('official_vote_stats_rebuild')::bigint) THEN
    RAISE NOTICE '[vote-stats rebuild] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '256MB';

  -- Atomic swap: readers are snapshot-isolated, so DELETE + INSERT in one txn is
  -- never observed as an empty set. Aggregation is byte-identical to _full().
  DELETE FROM public.official_vote_stats;

  WITH yes_party_votes AS (
    SELECT v.official_id, v.bill_proposal_id, o.party
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE v.vote = 'yes' AND o.party IS NOT NULL
  ),
  proposal_party_counts AS (
    SELECT bill_proposal_id, COUNT(DISTINCT party) AS distinct_parties
    FROM yes_party_votes
    GROUP BY bill_proposal_id
  ),
  bipartisan AS (
    SELECT ypv.official_id,
           COUNT(*) FILTER (WHERE ppc.distinct_parties >= 2) AS bipartisan_yes
    FROM yes_party_votes ypv
    JOIN proposal_party_counts ppc ON ppc.bill_proposal_id = ypv.bill_proposal_id
    GROUP BY ypv.official_id
  ),
  totals AS (
    SELECT v.official_id,
           COUNT(*)                               AS total_votes,
           COUNT(*) FILTER (WHERE v.vote = 'yes') AS yes_votes
    FROM public.votes v
    GROUP BY v.official_id
  )
  INSERT INTO public.official_vote_stats (official_id, total_votes, yes_votes, bipartisan_yes)
  SELECT
    to2.official_id,
    to2.total_votes::BIGINT,
    to2.yes_votes::BIGINT,
    COALESCE(b.bipartisan_yes, 0)::BIGINT
  FROM totals to2
  LEFT JOIN bipartisan b ON b.official_id = to2.official_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the full write, so the read fn only
  -- leaves the _full() fallback once the complete set is committed.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('official_vote_stats_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text, 'rows', v_count))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('official_vote_stats_rebuild', 'complete', v_started, clock_timestamp(), v_count,
          jsonb_build_object('rows', v_count));

  RAISE NOTICE '[vote-stats rebuild] complete — % officials', v_count;
END;
$$;

COMMENT ON PROCEDURE public.rebuild_official_vote_stats() IS
  'FIX-837/FIX-979 — full atomic rebuild of official_vote_stats (byte-identical '
  'aggregation to get_official_bipartisan_stats_full()). Nightly via pg_cron '
  'vote-stats-refresh; also the one-shot per-env bootstrap. ~2 min as the '
  'postgres role. Run over direct-pg with a raised session statement_timeout '
  'when bootstrapping. FIX-979: the terminal row stamps clock_timestamp() '
  'against a captured entry time — 17 prod runs had reported 0 ms.';

-- ── 3. refresh_agency_staffing_rollup() ──────────────────────────────────────
-- Body byte-identical to 20260715020000_fix778 except v_started + the stamp.
-- This is the one where BOTH columns were wrong: the procedure COMMITs per
-- chunk, so the trailing now() is the timestamp of the transaction that began
-- after the LAST commit — i.e. started_at was landing at the END of the run.
CREATE OR REPLACE PROCEDURE public.refresh_agency_staffing_rollup()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('agency_staffing_rollup_refresh')::bigint;
  c_chunk    int    := 50;
  v_agencies uuid[];
  v_chunk    uuid[];
  v_n        int;
  v_i        int := 1;
  v_chunk_no int := 0;
  v_rows     bigint := 0;
  v_n_ins    bigint;
  -- FIX-979: survives the per-chunk COMMITs; now() would not.
  v_started  timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[agency-staffing refresh] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT array_agg(id ORDER BY id) INTO v_agencies FROM public.agencies;
  v_n := COALESCE(array_length(v_agencies, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_agencies[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.agency_staffing_rebuild_agencies(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('agency_staffing_rollup_refresh', 'complete', v_started, clock_timestamp(), v_rows,
          jsonb_build_object('agencies', v_n, 'chunks', v_chunk_no, 'source', 'pg_cron/backfill'));

  RAISE NOTICE '[agency-staffing refresh] complete — % agencies in % chunks', v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_agency_staffing_rollup() TO service_role;

COMMENT ON PROCEDURE public.refresh_agency_staffing_rollup() IS
  'FIX-778/FIX-979 — full recompute of agency_staffing_rollup, chunked per '
  '50-agency batch with per-chunk COMMIT (memory-bounded; never a single '
  'whole-FR-table aggregate). Weekly pg_cron entry point and the per-env '
  'backfill (direct-pg). FIX-979: started_at is a clock_timestamp() captured at '
  'block entry — the trailing now() belonged to the post-final-COMMIT '
  'transaction, so BOTH timestamps used to describe the end of the run.';

-- ── 4. pipeline_runtime_stats_mv — zero-span rows leave the percentiles ──────
-- CREATE OR REPLACE is not available for materialized views, so this is a drop
-- and recreate. refresh_pipeline_runtime_stats_mv() resolves the MV by name and
-- is deliberately left untouched, as is its pg_cron schedule.
DROP MATERIALIZED VIEW IF EXISTS public.pipeline_runtime_stats_mv;

CREATE MATERIALIZED VIEW public.pipeline_runtime_stats_mv AS
SELECT
  pipeline,
  COUNT(*)::INT
    AS runs_30d,
  COUNT(*) FILTER (WHERE status = 'complete')::INT
    AS successful_runs_30d,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'complete')
         / NULLIF(COUNT(*), 0),
    1
  )::NUMERIC(5,1)
    AS success_rate_pct,

  -- FIX-979: duration percentiles are computed ONLY over rows with a strictly
  -- positive span. A zero-span row is not a fast run, it is an unmeasured one
  -- (both columns stamped from the same frozen transaction_timestamp()), and
  -- folding it in is what made 8 of 46 pipelines report p50=p95=max=0 ms —
  -- including treemap_individuals_global_refresh, whose 21,615.9 s run rendered
  -- as 0. When a pipeline has no measurable run at all these read NULL, which
  -- the admin page renders as '—'. NULL is the honest answer; 0 was not.
  PERCENTILE_CONT(0.5)  WITHIN GROUP (
    ORDER BY CASE WHEN completed_at > started_at
                  THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 END
  )::INT AS p50_duration_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY CASE WHEN completed_at > started_at
                  THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 END
  )::INT AS p95_duration_ms,
  MAX(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
    FILTER (WHERE completed_at > started_at)::INT
    AS max_duration_ms,

  -- The flag half of "exclude or flag". A non-zero count here against a NULL
  -- p50 is the tell that a pipeline's writer is stamping both columns from one
  -- now(); a future rate detector must read this before trusting a percentile.
  COUNT(*) FILTER (WHERE completed_at <= started_at)::INT
    AS zero_span_runs_30d,
  COUNT(*) FILTER (WHERE completed_at >  started_at)::INT
    AS measured_runs_30d,

  MAX(started_at) AS last_run_at,

  -- Memory cols — populated by Stage 7b. NULL today; MV refresh picks them up
  -- automatically once pipelines write peak_rss_mb into data_sync_log.metadata.
  MAX((metadata->>'peak_rss_mb')::INT) AS max_peak_rss_mb,
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY (metadata->>'peak_rss_mb')::NUMERIC
  )::INT AS p95_peak_rss_mb
FROM public.data_sync_log
WHERE started_at > NOW() - INTERVAL '30 days'
  -- Unchanged, and it is also what keeps FIX-971's reaped rows out: a reaped
  -- row now carries completed_at = NULL precisely so its started_at..reap gap
  -- can never be read as a runtime.
  AND completed_at IS NOT NULL
GROUP BY pipeline;

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_runtime_stats_mv_pkey
  ON public.pipeline_runtime_stats_mv (pipeline);

GRANT SELECT ON public.pipeline_runtime_stats_mv
  TO anon, authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.pipeline_runtime_stats_mv IS
  'FIX-233/FIX-979 — 30-day per-pipeline runtime stats from data_sync_log. '
  'Duration percentiles cover only rows with completed_at > started_at; '
  'zero-span rows (a writer stamping both columns from one now()) are counted '
  'in zero_span_runs_30d and excluded from the percentiles, so 0 ms can never '
  'again be rendered as a measured runtime.';
