-- =============================================================================
-- FIX-778 — Materialize /api/graph/agency-staffing per-agency rollup (FIX-775 #4).
--
-- /api/graph/agency-staffing ("Agencies by Staffing" scatter preset) paginates,
-- per agency, entity_connections (appointment COUNT) + financial_relationships
-- (contract/grant SUM) in 100-agency batches. A live request-path aggregate over
-- BOTH big tables (entity_connections + ~1.28M agency contract/grant FR rows) —
-- the FIX-775 audit gap, cold-IOWait (FIX-499) class on Pro Small. Bounded by
-- agency count (~105 active), so lower-severity, but still a request-path scan.
--
-- ── Fix: a tiny per-agency rollup, refreshed on the source cadence ────────────
-- public.agency_staffing_rollup holds {agency_id, appointment_count,
-- contract_cents, grant_cents} — one row per agency (~105). The route reads it by
-- agency_id (the static fte/founded_year/name stay on the agencies table it
-- already selects); its live COUNT/SUM aggregation stays as the per-entity miss
-- fallback.
--
-- ── Refresh hook: dedicated WEEKLY pg_cron (no donor-dirty-set to reuse) ──────
-- Unlike FIX-776/777 (donations → the FIX-704 donor dirty set), 778's sources are
-- entity_connections appointments (EC rebuild, Mon+Wed pg_cron) and agency
-- contract/grant FR (USASpending manual + FEC weekly). There is NO existing
-- per-agency dirty-set machinery to piggyback, so per packages/db/CLAUDE.md
-- ("file a note before adding a new cron") this adds ONE weekly job matching the
-- weekly-slowest source. The recompute is a FULL rebuild but memory-bounded:
-- chunked per agency-batch with per-chunk COMMIT (FIX-775 decision 3), never a
-- single aggregate over the whole FR table. The output is ~105 rows and every
-- per-agency scan rides financial_relationships_agency_spend_lateral (partial,
-- from_type='agency') and the entity_connections to-side index. Appointment/spend
-- staleness couples to the weekly refresh — accepted (this is a slow-moving
-- scatter preset).
--
-- ── Byte-for-byte with the route ─────────────────────────────────────────────
-- appointment_count = COUNT(*) of entity_connections (connection_type=
-- 'appointment', to_type='agency', to_id=agency) — raw edge count, matching the
-- route's per-edge tally. contract_cents/grant_cents = SUM(amount_cents) FILTER by
-- relationship_type over from_type='agency' rows (NULL amount → 0, matching the
-- route's `?? 0`). A row is written for EVERY agency (0s when none), so the route
-- always hits the fast path. Appointment edges verified present (FIX-808/1d).
-- =============================================================================

-- ── 1. Rollup table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agency_staffing_rollup (
  agency_id         uuid   NOT NULL PRIMARY KEY,
  appointment_count bigint NOT NULL DEFAULT 0,   -- entity_connections appointment edges into the agency
  contract_cents    bigint NOT NULL DEFAULT 0,   -- SUM agency contract FR amount_cents
  grant_cents       bigint NOT NULL DEFAULT 0,   -- SUM agency grant FR amount_cents
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agency_staffing_rollup IS
  'FIX-778 — per-agency {appointment_count, contract_cents, grant_cents} for '
  '/api/graph/agency-staffing. One row per agency. Read by agency_id (static '
  'fte/founded_year/name stay on agencies); the route keeps its live COUNT/SUM as '
  'the per-entity miss fallback. Full recompute refresh_agency_staffing_rollup() '
  '(chunked per agency-batch, per-chunk COMMIT), weekly pg_cron '
  '(agency-staffing-rollup-refresh); also the per-env backfill.';

-- Read only by the agency-staffing route (createAdminClient → service_role).
ALTER TABLE public.agency_staffing_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agency_staffing_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agency_staffing_rollup TO service_role;

-- ── 2. Per-agency-batch rebuild helper (single txn, no COMMIT) ───────────────
-- One row per agency in the batch (COALESCE 0 when no appointments/spend), so the
-- route's fast path always hits. Byte-for-byte with the route's per-agency
-- COUNT(appointments) + SUM(contract)/SUM(grant).
CREATE OR REPLACE FUNCTION public.agency_staffing_rebuild_agencies(p_agencies uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.agency_staffing_rollup
   WHERE agency_id = ANY (p_agencies);

  WITH appt AS (
    SELECT ec.to_id AS agency_id, COUNT(*)::bigint AS cnt
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'appointment'
      AND ec.to_type = 'agency'
      AND ec.to_id = ANY (p_agencies)
    GROUP BY ec.to_id
  ),
  spend AS (
    SELECT fr.from_id AS agency_id,
           (SUM(fr.amount_cents) FILTER (WHERE fr.relationship_type = 'contract'))::bigint AS contract_cents,
           (SUM(fr.amount_cents) FILTER (WHERE fr.relationship_type = 'grant'))::bigint    AS grant_cents
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'agency'
      AND fr.relationship_type IN ('contract', 'grant')
      AND fr.from_id = ANY (p_agencies)
    GROUP BY fr.from_id
  ),
  ins AS (
    INSERT INTO public.agency_staffing_rollup
      (agency_id, appointment_count, contract_cents, grant_cents, updated_at)
    SELECT
      a.id,
      COALESCE(appt.cnt, 0),
      COALESCE(spend.contract_cents, 0),
      COALESCE(spend.grant_cents, 0),
      now()
    FROM public.agencies a
    LEFT JOIN appt  ON appt.agency_id  = a.id
    LEFT JOIN spend ON spend.agency_id = a.id
    WHERE a.id = ANY (p_agencies)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.agency_staffing_rebuild_agencies(uuid[]) TO service_role;

COMMENT ON FUNCTION public.agency_staffing_rebuild_agencies(uuid[]) IS
  'FIX-778 — delete + re-aggregate agency_staffing_rollup for a set of agencies '
  '(appointment COUNT + contract/grant SUM; one row per agency, 0s when none). '
  'No COMMIT: the refresh procedure commits per agency-batch.';

-- ── 3. Full recompute refresh PROCEDURE (chunked per agency-batch, COMMIT each) ─
--     Weekly pg_cron entry point AND the per-env backfill (run over direct-pg). A
--     full rebuild over ALL agencies, but memory-bounded: 50 agencies per chunk,
--     COMMIT each. Idempotent. Any agency not re-inserted (deleted) is cleaned by
--     the AFTER DELETE trigger below, so a full recompute over current agencies
--     never leaves an orphan.
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
  VALUES ('agency_staffing_rollup_refresh', 'complete', now(), now(), v_rows,
          jsonb_build_object('agencies', v_n, 'chunks', v_chunk_no, 'source', 'pg_cron/backfill'));

  RAISE NOTICE '[agency-staffing refresh] complete — % agencies in % chunks', v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.refresh_agency_staffing_rollup() TO service_role;

COMMENT ON PROCEDURE public.refresh_agency_staffing_rollup() IS
  'FIX-778 — full recompute of agency_staffing_rollup, chunked per 50-agency '
  'batch with per-chunk COMMIT (memory-bounded; never a single whole-FR-table '
  'aggregate). Weekly pg_cron entry point and the per-env backfill (direct-pg).';

-- ── 4. Derived-cleanup trigger: drop an agency's row on delete ───────────────
CREATE OR REPLACE FUNCTION public.agency_staffing_rollup_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.agency_staffing_rollup WHERE agency_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS agency_staffing_rollup_cleanup_del ON public.agencies;
CREATE TRIGGER agency_staffing_rollup_cleanup_del
  AFTER DELETE ON public.agencies
  FOR EACH ROW
  EXECUTE FUNCTION public.agency_staffing_rollup_cleanup();

-- ── 5. Weekly pg_cron job — Tue 07:30 UTC (after the Mon 08:00 EC rebuild and the
--     Sunday weekly USASpending/FEC data; alongside the other Tue refreshes). ──
SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname = 'agency-staffing-rollup-refresh';

SELECT cron.schedule(
  'agency-staffing-rollup-refresh',
  '30 7 * * 2',
  $$CALL public.refresh_agency_staffing_rollup();$$
);

-- ── 6. Function-grant hygiene (FIX-695/834) ──────────────────────────────────
REVOKE ALL ON FUNCTION public.agency_staffing_rebuild_agencies(uuid[])  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.agency_staffing_rebuild_agencies(uuid[])  TO service_role;
REVOKE ALL ON PROCEDURE public.refresh_agency_staffing_rollup()         FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.refresh_agency_staffing_rollup()         TO service_role;

-- PostgREST: new table + changed function signature → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
