-- 20260526000003_congress_officials_xsr_seed.sql
-- FIX-403: backfill external_source_refs from officials.source_ids.congress_gov.
--
-- Pre-FIX-403 the Congress pipeline stamped only legacy
-- `source_ids: { congress_gov: <bioguide> }` on each official and never wrote
-- a matching xsr row. That left the FIX-397 primary_source materialization
-- with nothing to derive from — only ~33% of officials had primary_source
-- bound on prod (the third coming from littlesis/openstates/etc. paths that
-- DO write xsr). This seed fills the gap in one set-based statement, then
-- calls rebuild_all_primary_sources() to materialize the lift.
--
-- The pipeline writer changes shipping in the same PR start dual-writing
-- xsr on every Congress upsert so the gap doesn't reopen.
--
-- Pattern reference: supabase/migrations/20260525234504_officials_casing_dupe_merge_fix375.sql
-- (DO block + DECLARE + timing instrumentation).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

DO $$
DECLARE
  t0              timestamptz := clock_timestamp();
  rows_inserted   bigint;
  r               RECORD;
BEGIN
  RAISE NOTICE '[FIX-403] congress officials xsr seed start: %', t0;

  -- ── 1. Set-based seed ─────────────────────────────────────────────────
  -- NOT EXISTS pre-filter avoids touching already-bound bioguide IDs;
  -- ON CONFLICT DO NOTHING is the safety net against any race or
  -- pre-existing binding we mis-counted.
  INSERT INTO public.external_source_refs
    (source, external_id, entity_type, entity_id, source_url, last_seen_at, metadata)
  SELECT
    'congress_gov',
    o.source_ids->>'congress_gov',
    'official',
    o.id,
    'https://www.congress.gov/member/' || (o.source_ids->>'congress_gov'),
    COALESCE(o.updated_at, NOW()),
    '{}'::jsonb
  FROM public.officials o
  WHERE o.source_ids ? 'congress_gov'
    AND NOT EXISTS (
      SELECT 1
        FROM public.external_source_refs xsr
       WHERE xsr.source      = 'congress_gov'
         AND xsr.external_id = o.source_ids->>'congress_gov'
    )
  ON CONFLICT (source, external_id) DO NOTHING;
  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RAISE NOTICE '[FIX-403] step 1: % xsr rows inserted', rows_inserted;

  -- ── 2. Materialize primary_source on freshly-bound officials ─────────
  -- rebuild_all_primary_sources() returns (table_name, rows_updated) per
  -- table; emit each one for observability of the lift.
  RAISE NOTICE '[FIX-403] step 2: rebuilding primary_source across xsr-bound tables';
  FOR r IN SELECT * FROM public.rebuild_all_primary_sources() LOOP
    RAISE NOTICE '[FIX-403]   %: % rows updated', r.table_name, r.rows_updated;
  END LOOP;

  RAISE NOTICE '[FIX-403] DONE. Wall time: % s. xsr inserted: %.',
               EXTRACT(EPOCH FROM clock_timestamp() - t0)::numeric(10,2),
               rows_inserted;
END $$;
