-- FIX-1384 REVERT (cc-280) — puts back the FIX-1295 M3 body of
-- refresh_contract_flow_rollups(), verbatim from
-- 20261010020000_fix1295_work_mem_m3.sql:78-365 (md5(prosrc) c699dc7d6acf1cf35a3164b71ec0a3aa):
-- both rollups read the contract rows again, each in its own statement.
--
-- It LEAVES public.contract_flow_stage in place. The M3 body never reads it,
-- so the table is inert; drop it in a migration of its own if it is to go.
--
-- Run through db-query (a CREATE OR REPLACE, no data written):
--   node scripts/db-query.mjs --local --call --file scripts/fix1384-revert-contract-flow-one-pass.sql
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file scripts/fix1384-revert-contract-flow-one-pass.sql
-- Pause the dispatcher first if contract-flow's one-shot is armed.

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
