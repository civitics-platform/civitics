-- FIX-1295 (M3) — the work_mem step-down, M3 (cc-211): contract-flow and the
-- five monthly reconcile sweeps at 64MB with parallel 0. Group-donor (B8) is
-- NOT here: R5 stopped it (below).
--
-- Census of record: docs/audits/2026-10-09-work-mem-allowance-census.md — §1.1
-- and §7 (the M2/M3 rows); §5's ratios reused as read 2026-10-09 03:21Z. M1 is
-- 20261009030000, M2 is 20261010010000. Separate from M2 because the receipts
-- are different days: contract-flow Thu 14:00Z, the sweeps on the 1st.
--
-- WHY. Contract-flow is the strongest candidate on every instrument (pgss
-- 3,018 MB temp over 3 calls, the longest ec-crawl overlap — 1,887 s at
-- 1,024 MB serial — and R4's -240 MB). The sweeps each SET 256MB = a 512 MB
-- hash cap per node; the EC-stats sweep builds two such hashes at once.
--
-- THE MEASUREMENT (R5, local prod-clone, cc-205's recipe: 256MB vs 64MB,
-- parallel 0 both, hash_mem_multiplier untouched, each body's top statement
-- cold, RssAnon per second). Verdict = wall <= 1.5x and no Hash Join flip and
-- temp under the clone's free disk (918 GB). Projections: FR tuples x1.46, FE
-- x1.42, EC x1.51.
--   refresh_contract_flow_rollups           PASS. Recipients (cold): HashAgg
--       B1 49 MB over 3.24M contracts -> Sort + GroupAggregate, external merge
--       133 MB; 42.6 -> 43.9 s; RssAnon 102 -> 102 MB. Agency x sector: the
--       3.24M-row sorts spill at BOTH (270 + 448 MB disk); 31.1 -> 23.5 s;
--       RssAnon 320 -> 94 MB. No Hash Join anywhere to flip.
--   reconcile_donation_edge_orphans          PASS. Both Merge Anti Join sorts
--       (5.7M / 6.6M rows) spill at BOTH (428 + 495 MB); 43.1 -> 28.3 s;
--       RssAnon 594 -> 133 MB. The SET comment's "spill regardless" is right.
--   reconcile_donor_party_rollup_orphans     PASS. Hash 1.86M rows, B1 114 MB
--       at both (inside 64MB's 128 MB cap); 38.3 -> 36.4 s; RssAnon 146 MB.
--   reconcile_donor_rollup_orphans           PASS. Hash 6.59M rows: B1 413 MB
--       -> B4 101 MB; 7.3 -> 7.7 s; RssAnon 421 -> 95 MB. Projected ~603 MB:
--       over 256MB's 512 MB cap already (prod's 225 MB temp at 256MB agrees).
--   reconcile_entity_connection_stats_orphans PASS. Two hashes at once, B1
--       203 + 434 MB -> B2 101 + B4 107 MB; 10.4 -> 11.0 s; RssAnon 536 ->
--       212 MB. Projected (EC x1.51) ~655 MB for the larger at 256MB.
--   reconcile_financial_entity_totals         PASS. Sweep A hash 2.82M rows B1
--       181 MB -> B2 91 MB; 10.8 -> 11.9 s; sweep C the same shape, 6.16 ->
--       5.94 s; RssAnon 187 -> 96 MB. The SET comment's "single batch" holds
--       at 256MB (and on prod, ~257 MB projected) — not at 64MB.
--   refresh_group_donor_rollup                STOP — keeps SET LOCAL 256MB.
--       The function whole is 42.7 -> 43.3 s (RssAnon 196 -> 88 MB), but its
--       _gdr_agg statement (HashAgg 2.07M -> 539k rows, B1 188 MB) becomes an
--       external-merge Sort + GroupAggregate (225 MB) at 64MB and at 128MB:
--       2.30 / 2.35 -> 4.61 s (2.0x), over the 1.5x bar.
--
-- WHAT THIS DOES.
--   B3  refresh_contract_flow_rollups:  SET work_mem 64MB + parallel 0 (+2/-1).
--   B7  the five sweeps: each SET work_mem 64MB + parallel 0 (+2/-1); the two
--       whose SET carried a comment gain one line under it saying what R5
--       measured (+1 each).
--
-- Every body is a full CREATE OR REPLACE copied from its latest file (each
-- equal to prod's prosrc by md5, read 2026-10-10 04:22Z; no CRLF in any) with
-- ONLY the SET lines (and those two comment lines) changed;
-- work-mem-allowances.test.ts proves it by a line diff. Grants are restated as
-- last stated: contract-flow from 20261003030000:1272-1273, the sweeps from
-- 20260902100000 (20260911000200 restates none).
--
-- fix1128: no routine gains a SET clause; all six COMMIT and keep proconfig
-- NULL.
--
-- ROLLBACK — per body, SET 256MB, never RESET (design B0: RESET lands on the
-- role default, 64MB since M1):
--   ROLLBACK refresh_contract_flow_rollups: re-apply from 20261003030000.
--   ROLLBACK reconcile_donation_edge_orphans: re-apply from 20260911000200.
--   ROLLBACK reconcile_donor_party_rollup_orphans: re-apply from 20260911000200.
--   ROLLBACK reconcile_donor_rollup_orphans: re-apply from 20260911000200.
--   ROLLBACK reconcile_entity_connection_stats_orphans: re-apply from 20260911000200.
--   ROLLBACK reconcile_financial_entity_totals: re-apply from 20260911000200.
--
-- NOT TOUCHED: refresh_group_donor_rollup (the STOP) and its wrapper
-- run_group_donor_rollup_refresh, the proconfig-64 units, hash_mem_multiplier
-- (D5), maintenance_work_mem, the weekly merge, any schedule.

-- ---------------------------------------------------------------------------
-- refresh_contract_flow_rollups — copied from 20261003030000_fix1194_p1a_box_backoff_gates.sql; grants as last stated at 20261003030000:1272-1273
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_recipients bigint;
  v_flows      bigint;
  -- FIX-979: real entry time. FIX-1194: the procedure now COMMITs its running
  -- row first, so now() would be the WORK transaction's start, not the entry.
  v_started    timestamptz := clock_timestamp();
  -- FIX-1194 P1-A — a SESSION advisory lock (was an xact lock on the same
  -- key): the running row's COMMIT would release an xact lock mid-run.
  c_lock_key   bigint := hashtext('contract_flow_rollups_rebuild')::bigint;
  v_gate       jsonb;
  v_log_id     uuid;
  v_stage      text := NULL;   -- the table in flight, for the cancel stamp
  v_canceled   text := NULL;
  v_failed     text := NULL;
  v_sqlstate   text := NULL;
BEGIN
  -- FIX-1194 P1-A — the START gate: wait up to 1,800 s for a box that is
  -- neither stale nor failing forks (D2). A weekly job: a skip costs a week of
  -- freshness (FIX-1140 counts only `complete`), so it waits before it skips.
  -- BEFORE the lock, so a waiting firing holds nothing.
  v_gate := public.box_backoff_gate('contract-flow-rollups-refresh', 1800);
  IF NOT (v_gate->>'clear')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('contract_flow_rollups_rebuild', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'skip_reason', format('box saturated after %s s: %s', v_gate->>'waited_s', v_gate->>'reason'),
              'source', 'pg_cron',
              'gate', v_gate));
    RAISE NOTICE '[contract-flow rollups] box saturated (%) after % s — skipping (FIX-1194)',
      v_gate->>'reason', v_gate->>'waited_s';
    RETURN;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[contract-flow rollups] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('contract_flow_rollups_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[contract-flow rollups] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  -- FIX-1194 P1-A — the running row, COMMITted before the work, so a budget
  -- cancel (enforce_cron_job_budgets → pg_cancel_backend) leaves a visible row
  -- instead of rolling back to nothing (09-17: 5,892 s, no row at all).
  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('contract_flow_rollups_rebuild', 'running', v_started,
          CASE WHEN (v_gate->>'waited_s')::int > 0
               THEN jsonb_build_object('gate', v_gate) ELSE '{}'::jsonb END)
  RETURNING id INTO v_log_id;
  COMMIT;

  -- FIX-1194 P1-A — the rebuild in ONE sub-block: a cancel or an error rolls
  -- back both tables and the state flip together, as the single transaction
  -- did. The statements inside are byte-identical to the prod body and are
  -- deliberately NOT re-indented (rule 34: +0/-0 on the aggregation lines).
  BEGIN
  v_stage := 'contract_recipient_rollup';

  -- Recipient rollup: top-500 recipients — byte-identical to
  -- treemap_recipients_by_contracts_full(500). One deterministic industry per
  -- recipient (FIX-873) → 500 distinct entity_ids, no fan-out.
  DELETE FROM public.contract_recipient_rollup;
  INSERT INTO public.contract_recipient_rollup
    (entity_id, entity_name, industry, naics_code, total_cents, award_count)
  WITH recipient_industry AS (
    -- FIX-918: the ranked pick, from its one home. FIX-1247: its display label.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  ),
  recipient_codes AS (
    -- FIX-1252: dollars and rows per (recipient, NAICS code), one heap pass.
    SELECT fr.to_id                    AS entity_id,
           fr.metadata->>'naics_code'  AS naics_code,
           SUM(fr.amount_cents)        AS code_cents,
           COUNT(*)                    AS code_rows
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'contract'
      AND fr.amount_cents > 0
      AND fr.to_type = 'financial_entity'
    GROUP BY fr.to_id, fr.metadata->>'naics_code'
  ),
  recipients AS (
    -- FIX-1252: one row per recipient; its code is the dominant one.
    SELECT rc.entity_id,
           SUM(rc.code_cents)::BIGINT AS total_cents,
           SUM(rc.code_rows)::BIGINT  AS award_count,
           (array_agg(rc.naics_code ORDER BY rc.code_cents DESC, rc.code_rows DESC, rc.naics_code)
              FILTER (WHERE rc.naics_code IS NOT NULL))[1] AS naics_code
    FROM recipient_codes rc
    GROUP BY rc.entity_id
  )
  SELECT
    fe.id::UUID,
    fe.display_name,
    -- FIX-1247: the chord's NAICS fallback, on the code this row reports.
    COALESCE(
      ri.display_label,
      CASE SUBSTRING(r.naics_code FROM 1 FOR 2)
        WHEN '11' THEN 'Agriculture & Food'
        WHEN '21' THEN 'Mining & Metals'
        WHEN '22' THEN 'Utilities'
        WHEN '23' THEN 'Construction'
        WHEN '31' THEN 'Manufacturing'
        WHEN '32' THEN 'Manufacturing'
        WHEN '33' THEN 'Manufacturing'
        WHEN '42' THEN 'Wholesale Trade'
        WHEN '44' THEN 'Consumer Goods & Services'
        WHEN '45' THEN 'Consumer Goods & Services'
        WHEN '48' THEN 'Transportation'
        WHEN '49' THEN 'Transportation'
        WHEN '51' THEN 'Technology & Communications'
        WHEN '52' THEN 'Finance & Insurance'
        WHEN '53' THEN 'Real Estate & Construction'
        WHEN '54' THEN 'Professional Services'
        WHEN '55' THEN 'Management'
        WHEN '56' THEN 'Administrative Services'
        WHEN '61' THEN 'Education'
        WHEN '62' THEN 'Health Care'
        WHEN '71' THEN 'Arts & Entertainment'
        WHEN '72' THEN 'Hospitality'
        WHEN '81' THEN 'Other Services'
        WHEN '92' THEN 'Government'
        ELSE 'Other'
      END,
      'Other'
    ),
    r.naics_code,
    r.total_cents,
    r.award_count
  FROM recipients r
  JOIN public.financial_entities fe
    ON fe.id = r.entity_id
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  ORDER BY r.total_cents DESC
  LIMIT 500;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  v_stage := 'contract_agency_sector_rollup';
  -- Agency × sector chord rollup: FULL dataset — byte-identical to
  -- chord_contract_flows_full(). Each award in exactly one sector (FIX-873).
  DELETE FROM public.contract_agency_sector_rollup;
  INSERT INTO public.contract_agency_sector_rollup
    (agency_id, agency_name, agency_acronym, sector, total_cents, award_count)
  WITH recipient_industry AS (
    -- FIX-918: the ranked pick, from its one home. FIX-1247: its display label.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        ri.display_label,
        CASE SUBSTRING(fr.metadata->>'naics_code' FROM 1 FOR 2)
          WHEN '11' THEN 'Agriculture & Food'
          WHEN '21' THEN 'Mining & Metals'
          WHEN '22' THEN 'Utilities'
          WHEN '23' THEN 'Construction'
          WHEN '31' THEN 'Manufacturing'
          WHEN '32' THEN 'Manufacturing'
          WHEN '33' THEN 'Manufacturing'
          WHEN '42' THEN 'Wholesale Trade'
          WHEN '44' THEN 'Consumer Goods & Services'
          WHEN '45' THEN 'Consumer Goods & Services'
          WHEN '48' THEN 'Transportation'
          WHEN '49' THEN 'Transportation'
          WHEN '51' THEN 'Technology & Communications'
          WHEN '52' THEN 'Finance & Insurance'
          WHEN '53' THEN 'Real Estate & Construction'
          WHEN '54' THEN 'Professional Services'
          WHEN '55' THEN 'Management'
          WHEN '56' THEN 'Administrative Services'
          WHEN '61' THEN 'Education'
          WHEN '62' THEN 'Health Care'
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

  v_stage := 'pipeline_state';
  -- Flip the bootstrap flag in the SAME txn as the writes.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('contract_flow_rollups_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text,
                             'recipients', v_recipients, 'agency_sectors', v_flows))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('%s: %s', v_stage, SQLERRM);
      RAISE WARNING '[contract-flow rollups] CANCELED during % (statement_timeout, budget or operator cancel): %',
        v_stage, SQLERRM;
    WHEN OTHERS THEN
      v_failed   := format('%s: %s', v_stage, SQLERRM);
      v_sqlstate := SQLSTATE;
      RAISE WARNING '[contract-flow rollups] FAILED during %: %', v_stage, SQLERRM;
  END;

  -- FIX-1194 P1-A — the cancel / failure close. Both tables are as they were
  -- before this run (the sub-block rolled back); the row says which table was
  -- in flight and for how long.
  IF v_canceled IS NOT NULL OR v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(),
           error_message = left(CASE WHEN v_canceled IS NOT NULL
                                     THEN 'canceled — ' || v_canceled ELSE v_failed END, 1000),
           metadata = metadata || jsonb_build_object(
             'canceled', v_canceled IS NOT NULL,
             'cancel_detail', v_canceled,
             'stage_in_flight', v_stage,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    IF v_failed IS NOT NULL THEN
      -- An error still fails the job in cron.job_run_details, as it did before.
      RAISE EXCEPTION '[contract-flow rollups] %', v_failed USING ERRCODE = v_sqlstate;
    END IF;
    RETURN;
  END IF;

  -- FIX-979: clock_timestamp(), not now(). runid 130 ran 7,125.6 s and reported
  -- 0.000000 because both columns were the same frozen transaction_timestamp().
  -- FIX-1194: the running row closes in the SAME transaction as the writes.
  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(),
         rows_inserted = v_recipients + v_flows,
         metadata = metadata || jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows)
   WHERE id = v_log_id;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);

  RAISE NOTICE '[contract-flow rollups] complete — % recipients, % agency×sector rows',
    v_recipients, v_flows;
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_contract_flow_rollups() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_contract_flow_rollups() TO service_role;

-- ---------------------------------------------------------------------------
-- reconcile_donation_edge_orphans — copied from 20260911000200_fix950_guards_rebuild_family.sql; grants as last stated at 20260902100000:222-223
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.reconcile_donation_edge_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donation_edge_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled text := NULL;
  -- FIX-979 — real entry time so a cancelled run reports a true span.
  v_started  timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donation-edge-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donation_edge_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donation-edge-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Keep the Merge Anti Join sorts as in-memory as Micro allows (they spill past
  -- ~256MB regardless at this cardinality — external merge sort, sequential IO).
  -- FIX-1295 M3 (cc-211 R5): true at 256MB too — both sorts spill (428 + 495 MB disk); at 64MB the same spill, RssAnon 594 -> 133 MB, 43.1 -> 28.3 s.
  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donation_edge_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the sweep its own short txn

  BEGIN
    DELETE FROM public.entity_connections ec
     WHERE ec.connection_type = 'donation'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_relationships fr
         WHERE fr.from_type = ec.from_type
           AND fr.from_id   = ec.from_id
           AND fr.to_type   = ec.to_type
           AND fr.to_id     = ec.to_id
           AND fr.relationship_type IN ('donation', 'ie_support')
       );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [donation-edge-orphans] orphan donation edges deleted: %', v_deleted;
  EXCEPTION
  -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled, so
  -- before this a watchdog cancel skipped the terminal UPDATE below entirely
  -- and stranded the row 'running' until the reaper.
  WHEN query_canceled THEN
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donation-edge-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donation-edge-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      -- FIX-981/979: clock_timestamp(), not now() — this transaction began
      -- after the sweep's COMMIT.
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_edges_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[donation-edge-orphans] % — % orphan donation edges deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.reconcile_donation_edge_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_donation_edge_orphans() TO service_role;

-- ---------------------------------------------------------------------------
-- reconcile_donor_party_rollup_orphans — copied from 20260911000200_fix950_guards_rebuild_family.sql; grants as last stated at 20260902100000:311-312
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.reconcile_donor_party_rollup_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_party_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[dpr-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[dpr-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- DELETE rollup rows for any donor with NO surviving qualifying FR row —
  -- same predicate as donor_party_rollup_rebuild_donors. The FR.updated_at
  -- watermark cannot see hard deletes (FIX-705 blind spot); this is the
  -- catch-all. Single set-based anti-join.
  BEGIN
    DELETE FROM public.donor_party_rollup_mv r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.from_id = r.donor_id
        AND fr.relationship_type = 'donation'
        AND fr.from_type = 'financial_entity'
        AND fr.to_type   = 'official'
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [dpr-orphans] orphan rollup rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [dpr-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [dpr-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[dpr-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.reconcile_donor_party_rollup_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_donor_party_rollup_orphans() TO service_role;

-- ---------------------------------------------------------------------------
-- reconcile_donor_rollup_orphans — copied from 20260911000200_fix950_guards_rebuild_family.sql; grants as last stated at 20260902100000:401-402
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.reconcile_donor_rollup_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donor-rollup-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-rollup-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- DELETE rollup rows for any recipient (official_id) with NO surviving
  -- qualifying FR to-side — same predicate as donor_rollup_rebuild_recipients
  -- (relationship_type IN donation/ie_support/ie_oppose, from_type=fe). Single
  -- Hash Anti Join: seq scan the rollup, anti-join against
  -- financial_relationships_donor_rollup_idx. Catches FIX-672-deleted junk
  -- committees + quarantined-IE officials whose FR rows are gone.
  BEGIN
    DELETE FROM public.official_donor_rollup_mv r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.to_id = r.official_id
        AND fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [donor-rollup-orphans] orphan rollup rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('rollup orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donor-rollup-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('rollup orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donor-rollup-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.reconcile_donor_rollup_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_donor_rollup_orphans() TO service_role;

-- ---------------------------------------------------------------------------
-- reconcile_entity_connection_stats_orphans — copied from 20260911000200_fix950_guards_rebuild_family.sql; grants as last stated at 20260902100000:489-490
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.reconcile_entity_connection_stats_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_entity_connection_stats_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[ec-stats-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connection_stats_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[ec-stats-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('entity_connection_stats_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- Belt-and-braces: the staged full rebuild removes orphans by construction
  -- (windowed DELETE covers the whole keyspace), so this normally deletes ~0
  -- rows. Kept per the FIX-705 discipline — it guards a future incremental
  -- conversion and any window that failed complete-if-stale.
  BEGIN
    DELETE FROM public.entity_connection_stats_mv s
    WHERE NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.from_id = s.entity_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.to_id = s.entity_id
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [ec-stats-orphans] orphan stats rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [ec-stats-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [ec-stats-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[ec-stats-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.reconcile_entity_connection_stats_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_entity_connection_stats_orphans() TO service_role;

-- ---------------------------------------------------------------------------
-- reconcile_financial_entity_totals — copied from 20260911000200_fix950_guards_rebuild_family.sql; grants as last stated at 20260902100000:648-649
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.reconcile_financial_entity_totals()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_financial_entity_totals')::bigint;
  v_log_id   uuid;
  v_donated  bigint := 0;
  v_received bigint := 0;
  v_reccount bigint := 0;   -- FIX-736: recipient_count orphans zeroed
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[fe-totals-reconcile] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_reconcile', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[fe-totals-reconcile] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Keep the anti-join hash builds in memory (single batch).
  -- FIX-1295 M3 (cc-211 R5): true at 256MB (sweep A hash B1 181 MB); at 64MB B2 91 MB, RssAnon 187 -> 96 MB, 10.8 -> 11.9 s.
  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_reconcile', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep each sweep its own short txn

  -- Sweep A — donated orphans: a donor carrying a positive total_donated_cents
  -- but with no surviving donation FR from-side (all rows hard-deleted).
  BEGIN
    UPDATE public.financial_entities fe
    SET total_donated_cents = 0
    WHERE fe.total_donated_cents > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_relationships fr
        WHERE fr.from_type = 'financial_entity'
          AND fr.relationship_type = 'donation'
          AND fr.from_id = fe.id
      );
    GET DIAGNOSTICS v_donated = ROW_COUNT;
    RAISE NOTICE '  [fe-totals-reconcile] donated orphans zeroed: %', v_donated;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('donated sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] donated sweep CANCELED: %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('donated sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] donated sweep FAILED: %', SQLERRM;
  END;
  COMMIT;

  -- Sweep B — received orphans: a recipient carrying a positive
  -- total_received_cents but no surviving inbound donation FR.
  IF v_canceled IS NULL THEN
    BEGIN
      UPDATE public.financial_entities fe
      SET total_received_cents = 0
      WHERE fe.total_received_cents > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.financial_relationships fr
          WHERE fr.to_type = 'financial_entity'
            AND fr.from_type = 'financial_entity'
            AND fr.relationship_type = 'donation'
            AND fr.to_id = fe.id
        );
      GET DIAGNOSTICS v_received = ROW_COUNT;
      RAISE NOTICE '  [fe-totals-reconcile] received orphans zeroed: %', v_received;
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('received sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] received sweep CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('received sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] received sweep FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  -- Sweep C (FIX-736) — recipient_count orphans: an individual carrying a
  -- positive recipient_count but no surviving donation FR from-side. SOUND (FR is
  -- complete) — this replaces the reverted, UNSOUND EC-based sweep. Outer driven
  -- by financial_entities_recipient_count_idx (partial WHERE entity_type=
  -- 'individual'); anti-join FR side rides financial_relationships_donation_size_rollup.
  IF v_canceled IS NULL THEN
    BEGIN
      UPDATE public.financial_entities fe
      SET recipient_count = 0
      WHERE fe.entity_type = 'individual'
        AND fe.recipient_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.financial_relationships fr
          WHERE fr.from_type = 'financial_entity'
            AND fr.relationship_type = 'donation'
            AND fr.from_id = fe.id
        );
      GET DIAGNOSTICS v_reccount = ROW_COUNT;
      RAISE NOTICE '  [fe-totals-reconcile] recipient_count orphans zeroed: %', v_reccount;
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('recipient_count sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] recipient_count sweep CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('recipient_count sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] recipient_count sweep FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_donated + v_received + v_reccount,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s', v_canceled,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'donated_orphans_zeroed', v_donated,
                        'received_orphans_zeroed', v_received,
                        'recipient_count_orphans_zeroed', v_reccount,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals-reconcile] % — donated=% received=% recipient_count=% zeroed (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_donated, v_received, v_reccount, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.reconcile_financial_entity_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.reconcile_financial_entity_totals() TO service_role;
