-- =============================================================================
-- FIX-776 — Materialize /api/graph/small-dollar per-official rollup (FIX-775 #1).
--
-- /api/graph/small-dollar?entityId=X (the "Small-Dollar Dependency" preset)
-- computes, per focused official, the share of donations received in amounts
-- under $500 (the grassroots itemization threshold):
--   small_dollar_cents = SUM(amount_cents) WHERE amount_cents < 50000 (and > 0)
--   small_dollar_share = small_dollar_cents / officials.total_received_cents
-- The route fetched EVERY small-dollar donation row for the official in 1000-row
-- PostgREST pages and summed them in JS ("hundreds of thousands per official" —
-- its own comment; up to a 200k-row safety ceiling). That live per-request scan
-- over financial_relationships (~2.84M donation→official rows, growing) is the
-- FIX-499 cold-IOWait class against Pro Small and can graze the 8s role timeout.
--
-- ── Fix: a tiny per-official summary, maintained incrementally ────────────────
-- public.official_small_dollar_rollup holds exactly {official_id,
-- small_dollar_cents, small_dollar_count} — one row per official with ≥1 donation
-- (~4.2k rows, not a 2.84M-row scan). The route reads it by PK and keeps its live
-- pagination sum as the per-entity fallback on a miss (nothing 500s / blanks).
--
-- ── Refresh hook: the existing FIX-704/832 donor-rollup dirty set (NO new cron) ─
-- Donations only change on the weekly FEC Sunday ingest, whose dirty recipients
-- are already re-aggregated daily by refresh_official_donor_rollup_incremental()
-- via donor_rollup_rebuild_recipients(). This migration appends a third additive
-- block to that helper (mirroring FIX-836's official_donor_totals block), so the
-- small-dollar summary rides the same watermark / chunked-COMMIT / advisory-lock
-- refresh with NO new pg_cron job and NO new watermark (FIX-775 decision 2).
--
-- ── Why NO bootstrap flag (unlike FIX-836) ───────────────────────────────────
-- FIX-836 gated its fast path on a pipeline_state flag because its reader
-- (get_official_donor_rollup) scans the WHOLE summary table, so a partial
-- (dirty-only) pre-backfill population would under-tag. This rollup is read
-- ONLY as a per-official PK point read with a per-entity live-compute fallback:
-- an official present in the summary serves the fast path (it was fully
-- re-aggregated for that official); an official absent falls through to the live
-- sum (correct, just slower). So a partial pre-backfill population is always
-- correct per-entity — no global flag needed.
--
-- ── Byte-for-byte with the route ─────────────────────────────────────────────
-- The summary aggregation reproduces the route's filter exactly
-- (relationship_type='donation', to_type='official', 0 < amount_cents < 50000).
-- The added from_type='financial_entity' predicate is a no-op on the data (100%
-- of donation→official rows are from_type='financial_entity' on both local and
-- prod, verified 2026-07-15) that lets the aggregation ride the FIX-704
-- financial_relationships_donor_rollup_idx as an index-only scan. A row is
-- written for every official with ≥1 donation (small_dollar 0 when none qualify),
-- so a 0-small-dollar official still serves fast instead of re-computing live.
--
-- ── Promotion (FIX-761 official-FK-surface contract) ─────────────────────────
-- official_small_dollar_rollup.official_id references officials. Derived +
-- self-healing exactly like official_donor_totals (FIX-836): the candidate side
-- re-aggregates on the next daily refresh (the promotion FR rewrite bumps
-- updated_at → the recipient goes dirty); the elected (deleted) side is cleaned
-- by an officials AFTER DELETE trigger. See [[FIX-761]] [[FIX-704]] [[FIX-836]].
-- =============================================================================

-- ── 1. Summary table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.official_small_dollar_rollup (
  official_id        uuid   NOT NULL PRIMARY KEY,  -- to_type='official' recipient
  small_dollar_cents bigint NOT NULL DEFAULT 0,    -- SUM(amount_cents) WHERE 0 < amount_cents < 50000
  small_dollar_count bigint NOT NULL DEFAULT 0,    -- COUNT(*) of those rows
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.official_small_dollar_rollup IS
  'FIX-776 — per-official small-dollar (<$500) donation summary '
  '{official_id, small_dollar_cents, small_dollar_count}. One row per official '
  'with ≥1 donation FR. Serves /api/graph/small-dollar as a PK point read; the '
  'route keeps its live pagination sum as the per-entity miss fallback. '
  'Maintained incrementally by donor_rollup_rebuild_recipients() on the FIX-704 '
  'donor_rollup_watermark (daily, FIX-832); full backfill via '
  'backfill_official_small_dollar_rollup(). Derived + self-healing (candidate '
  'side re-aggregates next refresh; elected side cleaned by the officials AFTER '
  'DELETE trigger).';

-- Read only by the small-dollar route (createAdminClient → service_role, which
-- BYPASSRLS). No anon/authenticated surface (FIX-834/695 hygiene). RLS on with no
-- policy = deny direct non-owner access; service_role gets DML for the
-- refresh/backfill paths.
ALTER TABLE public.official_small_dollar_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.official_small_dollar_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_small_dollar_rollup TO service_role;

-- ── 2. Per-recipient rebuild helper (single txn, no COMMIT — callers own txns) ─
-- DELETE + re-aggregate the small-dollar summary for a set of recipients. The
-- FILTER form writes a row for every recipient with ≥1 donation (small_dollar 0
-- when none qualify) so a 0-small-dollar official still serves the fast path.
-- p_recipients may include financial_entity recipients (super PACs); the
-- to_type='official' filter yields no rows for them and the DELETE matches
-- nothing (FE ids are never in this table).
CREATE OR REPLACE FUNCTION public.small_dollar_rebuild_officials(p_recipients uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_small_dollar_rollup
   WHERE official_id = ANY (p_recipients);

  WITH ins AS (
    INSERT INTO public.official_small_dollar_rollup
      (official_id, small_dollar_cents, small_dollar_count, updated_at)
    SELECT
      fr.to_id,
      COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
      (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
      now()
    FROM public.financial_relationships fr
    WHERE fr.to_type           = 'official'
      AND fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'   -- 100% of donation→official; enables the FIX-704 idx
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.small_dollar_rebuild_officials(uuid[]) TO service_role;

COMMENT ON FUNCTION public.small_dollar_rebuild_officials(uuid[]) IS
  'FIX-776 — delete + re-aggregate official_small_dollar_rollup for a set of '
  'recipients (one row per official with ≥1 donation; small_dollar 0 when none '
  '< $500). No COMMIT: the chunked backfill commits per chunk; '
  'donor_rollup_rebuild_recipients() calls it inside its own chunk txn.';

-- ── 3. Extend donor_rollup_rebuild_recipients() to ALSO maintain the summary ──
--     Body below is the live FIX-704/836 helper VERBATIM, with one additive line
--     appended before RETURN (`PERFORM small_dollar_rebuild_officials(...)`). The
--     MV and official_donor_totals blocks are untouched — the small-dollar write
--     is independent and rides the same chunk's transaction.
CREATE OR REPLACE FUNCTION public.donor_rollup_rebuild_recipients(p_recipients uuid[])
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_donor_rollup_mv
   WHERE official_id = ANY (p_recipients);

  WITH per_donor AS (
    SELECT
      fr.to_id                       AS official_id,
      fr.relationship_type::text     AS relationship_type,
      fr.from_id                     AS donor_id,
      SUM(fr.amount_cents)::bigint   AS total_cents,
      COUNT(*)::bigint               AS tx_count
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
      AND fr.from_type = 'financial_entity'
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id, fr.relationship_type, fr.from_id
  ),
  ranked AS (
    SELECT
      pd.*,
      ROW_NUMBER() OVER (
        PARTITION BY pd.official_id, pd.relationship_type
        ORDER BY pd.total_cents DESC, pd.donor_id
      ) AS rn
    FROM per_donor pd
  ),
  ind AS (
    -- One deterministic (tag, label) pair per donor, scoped to this chunk's
    -- ranked donors (the FIX-518 MV computed this over ALL donors once per
    -- refresh; per-chunk scoping keeps it an index probe). Same smallest-tag
    -- pick as fetchIndustryTagsByEntityId.
    SELECT DISTINCT ON (et.entity_id)
      et.entity_id,
      et.tag           AS industry_tag,
      et.display_label AS industry_label
    FROM public.entity_tags et
    WHERE et.entity_type  = 'financial_entity'
      AND et.tag_category = 'industry'
      AND et.entity_id IN (SELECT r.donor_id FROM ranked r WHERE r.rn <= 200)
    ORDER BY et.entity_id, et.tag
  ),
  top_rows AS (
    SELECT
      r.official_id,
      r.relationship_type,
      r.rn::int           AS rank,
      r.donor_id,
      fe.display_name     AS donor_name,
      fe.entity_type      AS entity_type,
      ind.industry_tag    AS industry_tag,
      ind.industry_label  AS industry_label,
      r.total_cents,
      r.tx_count,
      NULL::bigint        AS tail_donor_count
    FROM ranked r
    LEFT JOIN public.financial_entities fe ON fe.id = r.donor_id
    LEFT JOIN ind                          ON ind.entity_id = r.donor_id
    WHERE r.rn <= 200
  ),
  tail_rows AS (
    SELECT
      r.official_id,
      r.relationship_type,
      201                        AS rank,
      NULL::uuid                 AS donor_id,
      NULL::text                 AS donor_name,
      NULL::text                 AS entity_type,
      NULL::text                 AS industry_tag,
      NULL::text                 AS industry_label,
      SUM(r.total_cents)::bigint AS total_cents,
      SUM(r.tx_count)::bigint    AS tx_count,
      COUNT(*)::bigint           AS tail_donor_count
    FROM ranked r
    WHERE r.rn > 200
    GROUP BY r.official_id, r.relationship_type
  ),
  ins AS (
    INSERT INTO public.official_donor_rollup_mv (
      official_id, relationship_type, rank, donor_id, donor_name, entity_type,
      industry_tag, industry_label, total_cents, tx_count, tail_donor_count
    )
    SELECT * FROM top_rows
    UNION ALL
    SELECT * FROM tail_rows
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  -- FIX-836: exact per-official donation summary for this chunk's official
  -- recipients (feeds get_official_donor_rollup()). Additive to the MV build.
  DELETE FROM public.official_donor_totals
   WHERE official_id = ANY (p_recipients);

  INSERT INTO public.official_donor_totals
    (official_id, total_cents, pac_cents, individual_cents, donor_count)
  SELECT
    fr.to_id,
    SUM(COALESCE(fr.amount_cents, 0))::bigint,
    (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
    (SUM(COALESCE(fr.amount_cents, 0)) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
    COUNT(*)::bigint
  FROM public.financial_relationships fr
  LEFT JOIN public.financial_entities fe ON fe.id = fr.from_id
  WHERE fr.to_type = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.to_id = ANY (p_recipients)
  GROUP BY fr.to_id;

  -- FIX-776: per-official small-dollar summary for this chunk's official
  -- recipients (feeds /api/graph/small-dollar). Additive; independent of the two
  -- blocks above. Own DELETE+INSERT (see small_dollar_rebuild_officials).
  PERFORM public.small_dollar_rebuild_officials(p_recipients);

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.donor_rollup_rebuild_recipients(uuid[]) TO service_role;

-- ── 4. Chunked one-shot backfill (per-chunk COMMIT — memory-bounded) ──────────
--     FIX-775 decision 3: NEVER a single full aggregate over the whole donation
--     table. Processes officials-with-donations in chunks, re-aggregating each
--     chunk via small_dollar_rebuild_officials() and committing per chunk. Run
--     over direct-pg (a PROCEDURE with COMMIT cannot run inside a txn). Idempotent
--     — safe to re-run. NOT watermark-driven: this is the one-shot bootstrap; the
--     ongoing refresh is the donor_rollup_rebuild_recipients() block above.
CREATE OR REPLACE PROCEDURE public.backfill_official_small_dollar_rollup()
LANGUAGE plpgsql
AS $$
DECLARE
  c_lock_key bigint := hashtext('official_small_dollar_rollup_backfill')::bigint;
  c_chunk    int    := 500;
  v_officials uuid[];
  v_chunk     uuid[];
  v_n         int;
  v_i         int := 1;
  v_chunk_no  int := 0;
  v_rows      bigint := 0;
  v_n_ins     bigint;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[small-dollar backfill] advisory lock held — skipping';
    RETURN;
  END IF;

  SET work_mem = '128MB';

  SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
  FROM public.financial_relationships fr
  WHERE fr.to_type           = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.from_type         = 'financial_entity';

  v_n := COALESCE(array_length(v_officials, 1), 0);

  WHILE v_i <= v_n LOOP
    v_chunk    := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n)];
    v_chunk_no := v_chunk_no + 1;
    v_n_ins    := public.small_dollar_rebuild_officials(v_chunk);
    v_rows     := v_rows + v_n_ins;
    COMMIT;  -- bounds txn size + advances xmin between chunks
    v_i := v_i + c_chunk;
  END LOOP;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('small_dollar_rollup_backfill', 'complete', now(), now(), v_rows,
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no));

  RAISE NOTICE '[small-dollar backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;
GRANT EXECUTE ON PROCEDURE public.backfill_official_small_dollar_rollup() TO service_role;

COMMENT ON PROCEDURE public.backfill_official_small_dollar_rollup() IS
  'FIX-776 — chunked (500 officials/chunk, COMMIT each) one-shot bootstrap of '
  'official_small_dollar_rollup. Memory-bounded (no full-table aggregate in one '
  'statement). Idempotent. Run over direct-pg per env; the incremental refresh '
  '(donor_rollup_rebuild_recipients block) keeps it fresh thereafter.';

-- ── 5. Derived-cleanup trigger: drop an official's summary row on delete ──────
--     Mirrors official_donor_totals_cleanup (FIX-836) — same FIX-761 rationale
--     (trigger, not FK, so the shared refresh's health isn't coupled to orphan-FR
--     tolerance and promote_candidate_to_elected() need not be re-CREATE'd).
CREATE OR REPLACE FUNCTION public.official_small_dollar_rollup_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.official_small_dollar_rollup WHERE official_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS official_small_dollar_rollup_cleanup_del ON public.officials;
CREATE TRIGGER official_small_dollar_rollup_cleanup_del
  AFTER DELETE ON public.officials
  FOR EACH ROW
  EXECUTE FUNCTION public.official_small_dollar_rollup_cleanup();

-- ── 6. Function-grant hygiene (Supabase default-grants EXECUTE to anon/auth on
--     every new function — FIX-695/834). The rebuild helper + backfill are
--     service_role-only (cron / supervised direct-pg bootstrap).
REVOKE ALL ON FUNCTION public.small_dollar_rebuild_officials(uuid[])       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.small_dollar_rebuild_officials(uuid[])       TO service_role;
REVOKE ALL ON PROCEDURE public.backfill_official_small_dollar_rollup()     FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_official_small_dollar_rollup()     TO service_role;

-- PostgREST: new table + changed function signature → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
