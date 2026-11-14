-- FIX-1384 — contract-flow reads the contract rows ONCE into
-- public.contract_flow_stage and derives both rollups from it (cc-280).
--
-- Design of record: Cowork's design-fix1384-contract-flow-one-pass-stage-
-- 2026-11-13 (D1–D8, ratified by Craig 11-13), restated in cc-280's prompt.
-- Audit: docs/audits/2026-11-13-contract-flow-cost-shape.md.
--
-- THE FINDING (prod reads 2026-11-14 23:21–23:26Z beside the clone's).
--   The wall (2,791.6 / 2,995.0 / 3,049.3 s on 11-01 / 11-05 / 11-12) is not
--   the sorts. The agency x sector statement is planned on the join's
--   estimate: prod 46 rows (clone 58) where the real count is 4,332,843
--   (clone 3,277,322). Nested Loop: Seq Scan agencies (137) -> Index Scan
--   financial_relationships_agency_spend_lateral, so every contract row is
--   fetched from the heap in amount order. pg_stat_statements since 10-25:
--   3 calls, 4,653,478 shared reads and 194,531 temp blocks a call, mean
--   2,945.3 s (clone, both statements: 3,314,614 reads, 163,835 temp).
--   The stage pass alone on prod: 136.7 s, 390,630 reads, HashAggregate in
--   one batch (59,409 kB), 203,314 rows (clone 7.3 s, 163,501 rows).
--
-- DECISIONS (Craig's picks, by letter).
--   D1 one aggregate pass; both rollups derived from it. No chunks, no index.
--   D2 the stage is a real LOGGED table, RLS on, no policy, service_role DML
--      only (the two rollup tables' shape, 20260719020000).
--   D3 no chunking. ctid-range chunks are designed and held: built only if
--      the Thu 11-19 wall is above 900 s or the run draws an io_throttled hold.
--   D4 the pass runs on every call; the body records the source fingerprint
--      and a stage checksum so two later runs can prove a skip safe. No skip.
--   D5 the registry row is not touched (by 0 14 * * 4, budget 9000, mvs, 64).
--   D6 atomic as today: the stage replace, both rollup replaces and the state
--      flip sit in the ONE existing sub-block. The running row, its COMMIT,
--      the session lock, the FIX-950 stand-down, the cancel / failure close
--      and the final COMMIT are not edited.
--   D7 the START gate line is not edited.  D8 the two SET lines are not edited.
--
-- WHAT CHANGES IN THE BODY (20261010020000 M3, md5 c699dc7d…): a first stage
-- inside the sub-block; recipient_codes and classified read the stage; the
-- state and the complete row gain staged / source_fingerprint, the state
-- stage_checksum, the row stage_seconds {stage, recipients, agency_sectors}.
-- financial_relationships is named once in the code. Grants restated as M3
-- states them (20261010020000:364-365). No SET clause: the body COMMITs
-- (FIX-1128, check:proconfig).
--
-- ROLLBACK: scripts/fix1384-revert-contract-flow-one-pass.sql — the M3 body
-- verbatim. It leaves contract_flow_stage in place (unread by M3).

-- ---------------------------------------------------------------------------
-- D2 — the stage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contract_flow_stage (
  from_id     uuid    NOT NULL,
  from_type   text    NOT NULL,
  to_id       uuid    NOT NULL,
  to_type     text    NOT NULL,
  naics_code  text,
  total_cents numeric NOT NULL,
  award_count bigint  NOT NULL,
  CONSTRAINT contract_flow_stage_key
    UNIQUE NULLS NOT DISTINCT (from_id, from_type, to_id, to_type, naics_code)
);

COMMENT ON TABLE public.contract_flow_stage IS
  'FIX-1384 — every contract financial_relationships row with amount_cents > 0, '
  'aggregated once per (from, to, NAICS code): SUM(amount_cents), COUNT(*). '
  'contract_recipient_rollup and contract_agency_sector_rollup are derived from '
  'it. Written ONLY by refresh_contract_flow_rollups(), which replaces it whole '
  'in the same sub-block as both rollups (a cancel leaves all three as they were).';

ALTER TABLE public.contract_flow_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contract_flow_stage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_flow_stage TO service_role;

-- ---------------------------------------------------------------------------
-- refresh_contract_flow_rollups — copied from 20261010020000_fix1295_work_mem_m3.sql; grants as last stated at 20261010020000:364-365
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
  -- FIX-1384 — the one-pass stage: what it read, what it wrote, the three walls.
  v_staged     bigint;
  v_source_fp  text;
  v_stage_sum  text;
  v_t_stage    timestamptz;
  v_t_recip    timestamptz;
  v_t_flows    timestamptz;
  v_t_done     timestamptz;
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
  -- FIX-1384 (D6) — the stage replace is in the same sub-block: a cancel or an
  -- error leaves the stage and both rollups as they were.
  BEGIN
  v_stage := 'contract_flow_stage';
  v_t_stage := clock_timestamp();

  -- FIX-1384 — the contract rows, read ONCE: one row per (from, to, NAICS
  -- code). Both rollups below are derived from it: their grouping keys are
  -- functions of these five columns and SUM / COUNT are associative, so the
  -- outputs are the same rows (cc-280's clone EXCEPT proof). The fingerprint
  -- is recorded so two later runs can prove a skip safe (D4); nothing skips
  -- on it here. NULL is allowed and recorded as NULL.
  v_source_fp := public.ec_arm_source_fingerprint('rebuild_entity_connections_contracts');
  DELETE FROM public.contract_flow_stage;
  INSERT INTO public.contract_flow_stage
    (from_id, from_type, to_id, to_type, naics_code, total_cents, award_count)
  SELECT fr.from_id, fr.from_type, fr.to_id, fr.to_type,
         fr.metadata->>'naics_code', SUM(fr.amount_cents), COUNT(*)
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fr.from_id, fr.from_type, fr.to_id, fr.to_type, fr.metadata->>'naics_code';
  GET DIAGNOSTICS v_staged = ROW_COUNT;
  ANALYZE public.contract_flow_stage;
  -- Order-independent and no long string: the count, both sums and a sum of
  -- 64-bit row hashes, folded into one md5.
  SELECT md5(format('%s:%s:%s:%s', count(*), sum(s.total_cents), sum(s.award_count),
                    sum(hashtextextended((s.from_id, s.from_type, s.to_id, s.to_type,
                                          s.naics_code, s.total_cents, s.award_count)::text, 0)::numeric)))
    INTO v_stage_sum
    FROM public.contract_flow_stage s;

  v_t_recip := clock_timestamp();
  v_stage := 'contract_recipient_rollup';

  -- Recipient rollup: top-500 recipients — the same rows as
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
    -- FIX-1252: dollars and rows per (recipient, NAICS code). FIX-1384: off the stage.
    SELECT s.to_id AS entity_id, s.naics_code, SUM(s.total_cents) AS code_cents, SUM(s.award_count) AS code_rows
    FROM public.contract_flow_stage s
    WHERE s.to_type = 'financial_entity'
    GROUP BY s.to_id, s.naics_code
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

  v_t_flows := clock_timestamp();
  v_stage := 'contract_agency_sector_rollup';
  -- Agency × sector chord rollup: FULL dataset — the same rows as
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
        CASE SUBSTRING(s.naics_code FROM 1 FOR 2)
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
      s.total_cents                                   AS amount_cents,
      s.award_count
    FROM public.contract_flow_stage s
    JOIN public.agencies a
      ON a.id = s.from_id AND s.from_type = 'agency'
    LEFT JOIN public.financial_entities fe
      ON fe.id = s.to_id AND s.to_type = 'financial_entity'
    LEFT JOIN recipient_industry ri
      ON ri.entity_id = fe.id
  )
  SELECT
    agency_id,
    agency_name,
    agency_acronym,
    sector,
    SUM(amount_cents)::BIGINT,
    SUM(award_count)::BIGINT
  FROM classified
  GROUP BY agency_id, agency_name, agency_acronym, sector;
  GET DIAGNOSTICS v_flows = ROW_COUNT;
  v_t_done := clock_timestamp();

  v_stage := 'pipeline_state';
  -- Flip the bootstrap flag in the SAME txn as the writes.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('contract_flow_rollups_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text,
                             'recipients', v_recipients, 'agency_sectors', v_flows,
                             'staged', v_staged, 'source_fingerprint', v_source_fp,
                             'stage_checksum', v_stage_sum))
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
         metadata = metadata || jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows,
           -- FIX-1384: the three walls, split.
           'staged', v_staged, 'source_fingerprint', v_source_fp,
           'stage_seconds', jsonb_build_object(
             'stage',          round(EXTRACT(epoch FROM (v_t_recip - v_t_stage))::numeric, 1),
             'recipients',     round(EXTRACT(epoch FROM (v_t_flows - v_t_recip))::numeric, 1),
             'agency_sectors', round(EXTRACT(epoch FROM (v_t_done - v_t_flows))::numeric, 1)))
   WHERE id = v_log_id;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);

  RAISE NOTICE '[contract-flow rollups] complete — % recipients, % agency×sector rows',
    v_recipients, v_flows;
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_contract_flow_rollups() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_contract_flow_rollups() TO service_role;
