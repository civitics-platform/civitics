-- =============================================================================
-- FIX-1068 — the sub-$200 residual gets a home, and "small dollar" stops being
--            inverted.
--
-- PR 3b moves the FEC $200 itemization floor from a PER-TRANSACTION filter at
-- parse time to a PER-DONOR-CYCLE-AGGREGATE filter at emit time (FEC's actual
-- rule). Two consequences land here.
--
-- ── 1. The residual is now measured, so it needs somewhere to live ───────────
-- A (donor × recipient × cycle) aggregate below $200 emits NO
-- financial_relationships row and NO financial_entities row — that decision is
-- locked. But the money is real and disclosed: measured on the full cycle-2026
-- file, 1,002,643 sub-floor groups totalling $83,453,297 (docs/audits/
-- 2026-08-18-fec-coverage-pr3a-phase0.md §2.4). Pre-3b it vanished without
-- trace. It is now counted into per-recipient size brackets by the indiv stage
-- and written here.
--
-- Grain: (recipient_type, recipient_id, cycle_year, bracket). recipient_type
-- mirrors financial_relationships.to_type because the residual spans BOTH
-- recipient routes — donor→official and donor→committee — exactly as the
-- emitted population does. Scoping the table to officials only would have
-- silently dropped the committee half.
--
-- `donor_count` counts (donor × recipient) GROUPS, i.e. donor-and-recipient
-- pairs, not distinct donors — the same unit as an FR row, and the same unit
-- the phase-0 audit reports. A donor giving $30 to five committees is five.
--
-- ── 2. official_small_dollar_rollup was measuring the wrong population ───────
-- FIX-776 defined small_dollar_cents as SUM(amount_cents) over donation FRs with
-- amount_cents < 50000 ($500). Under the PER-TRANSACTION floor every FR row was
-- built from transactions of $200-and-up, so "small dollar" in practice meant
-- "$200–$500" — the label pointed DOWN and the data pointed UP, and the whole
-- sub-$200 population it purports to describe was absent by construction.
--
-- Post-3b, amount_cents on an indiv FR row is a donor's CYCLE AGGREGATE, so
-- `< 50000` is an honest "donors whose aggregate was under $500" band. What is
-- still missing is everything below $200 — which is precisely what the bracket
-- table now holds. So the rollup gains two columns, sourced from it:
--
--   small_dollar_cents / small_dollar_count   itemized, aggregate in [200, 500)
--   sub_floor_cents    / sub_floor_donor_count  bracketed, aggregate in (0, 200)
--
-- They are kept SEPARATE rather than summed because their denominators differ:
-- officials.total_received_cents is derived from FR rows, so it contains the
-- first and not the second. A consumer that wants the honest grassroots share
-- must add the residual to BOTH sides — see /api/graph/small-dollar, which now
-- returns the components and both shares rather than one ambiguous number.
--
-- Refresh: rides the existing FIX-704/832 donor-rollup dirty set via
-- small_dollar_rebuild_officials(), so NO new cron job and NO new watermark
-- (FIX-775 decision 2), exactly as FIX-776 established.
-- =============================================================================

-- ── 1. The bracket table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.small_dollar_bracket_rollup (
  recipient_type text   NOT NULL CHECK (recipient_type IN ('official', 'financial_entity')),
  recipient_id   uuid   NOT NULL,
  cycle_year     int    NOT NULL,
  bracket        text   NOT NULL CHECK (bracket IN ('lt_50', '50_99', '100_199')),
  -- (donor × recipient) groups in this bracket — the FR-row unit, not distinct donors.
  donor_count    bigint NOT NULL DEFAULT 0,
  total_cents    bigint NOT NULL DEFAULT 0,
  -- Underlying itemized transactions rolled into those groups.
  tx_count       bigint NOT NULL DEFAULT 0,
  -- Which ingest produced the row. Lets a future source (pas2, oth{yy}/JFC in
  -- PR 3c) coexist without either polluting the individual-donor figure.
  source         text   NOT NULL DEFAULT 'fec_bulk_indiv',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_type, recipient_id, cycle_year, bracket, source)
);

COMMENT ON TABLE public.small_dollar_bracket_rollup IS
  'FIX-1068 (PR 3b) — sub-$200-aggregate individual giving, bracketed per '
  '(recipient, cycle). These are DISCLOSED contributions that emit no '
  'financial_relationships row because the donor''s cycle aggregate with the '
  'recipient never reached FEC''s $200 itemization floor. donor_count counts '
  '(donor x recipient) groups, the same unit as an FR row. Written by the FEC '
  'indiv stage (delete-then-insert per cycle+source, inside one transaction); '
  'read by small_dollar_rebuild_officials() to populate '
  'official_small_dollar_rollup.sub_floor_*. NOT a place for PAC money — see '
  'the streamPas224 header for why the pas2 residual is logged, not bracketed.';

-- Read path is the per-official rollup refresh (service_role) plus operator
-- queries. No anon/authenticated surface (FIX-695/834 hygiene).
ALTER TABLE public.small_dollar_bracket_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.small_dollar_bracket_rollup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.small_dollar_bracket_rollup TO service_role;

-- The refresh reads by (recipient_type, recipient_id) across all cycles; the PK
-- leads with recipient_type so that is already a prefix scan. This index serves
-- the other direction — "everything for cycle N", which the ingest's own
-- delete-then-insert and any coverage audit both want.
CREATE INDEX IF NOT EXISTS small_dollar_bracket_rollup_cycle_idx
  ON public.small_dollar_bracket_rollup (cycle_year, source);

-- ── 2. official_small_dollar_rollup gains the sub-floor components ───────────
ALTER TABLE public.official_small_dollar_rollup
  ADD COLUMN IF NOT EXISTS sub_floor_cents       bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sub_floor_donor_count bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.official_small_dollar_rollup.small_dollar_cents IS
  'FIX-776/1068 — SUM(amount_cents) over donation FRs with 0 < amount_cents < '
  '$500. Post-PR-3b an indiv FR amount is a donor CYCLE AGGREGATE, so this is '
  '"donors whose aggregate was under $500" — an honest small-dollar band. It '
  'necessarily EXCLUDES everything under $200, which emits no FR row at all; '
  'that lives in sub_floor_cents.';
COMMENT ON COLUMN public.official_small_dollar_rollup.sub_floor_cents IS
  'FIX-1068 — disclosed giving whose per-donor cycle aggregate never reached '
  'FEC''s $200 itemization floor, so it has no FR row. Summed from '
  'small_dollar_bracket_rollup. NOT included in officials.total_received_cents '
  '(which is FR-derived), so a share computed against that denominator must add '
  'this to BOTH numerator and denominator.';
COMMENT ON COLUMN public.official_small_dollar_rollup.sub_floor_donor_count IS
  'FIX-1068 — (donor x official) groups behind sub_floor_cents. Groups, not '
  'distinct donors.';

-- ── 3. Teach the per-recipient rebuild about the sub-floor half ──────────────
--     Body is the FIX-776 helper with the two new columns sourced from the
--     bracket table by LEFT JOIN. LEFT so an official with no bracketed residual
--     still gets a row (zeros), preserving FIX-776's "present ⇒ fast path"
--     contract for the route.
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

  WITH sub AS (
    -- All cycles, matching the all-cycle grain of the FR aggregation below and
    -- of officials.total_received_cents. Individual-donor sources only.
    SELECT b.recipient_id AS official_id,
           SUM(b.total_cents)::bigint AS sub_floor_cents,
           SUM(b.donor_count)::bigint AS sub_floor_donor_count
      FROM public.small_dollar_bracket_rollup b
     WHERE b.recipient_type = 'official'
       AND b.source         = 'fec_bulk_indiv'
       AND b.recipient_id   = ANY (p_recipients)
     GROUP BY b.recipient_id
  ),
  ins AS (
    INSERT INTO public.official_small_dollar_rollup
      (official_id, small_dollar_cents, small_dollar_count,
       sub_floor_cents, sub_floor_donor_count, updated_at)
    SELECT
      fr.to_id,
      COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
      (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
      COALESCE(MAX(sub.sub_floor_cents),       0)::bigint,
      COALESCE(MAX(sub.sub_floor_donor_count), 0)::bigint,
      now()
    FROM public.financial_relationships fr
    LEFT JOIN sub ON sub.official_id = fr.to_id
    WHERE fr.to_type           = 'official'
      AND fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'   -- 100% of donation→official; enables the FIX-704 idx
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  -- An official can have bracketed sub-floor money and ZERO itemized donation
  -- FRs (every one of their donors stayed under $200). The FR-driven INSERT
  -- above emits nothing for them, so they would read as "absent ⇒ live-compute
  -- fallback" forever and their residual would never surface. Add them.
  INSERT INTO public.official_small_dollar_rollup
    (official_id, small_dollar_cents, small_dollar_count,
     sub_floor_cents, sub_floor_donor_count, updated_at)
  SELECT b.recipient_id, 0, 0,
         SUM(b.total_cents)::bigint,
         SUM(b.donor_count)::bigint,
         now()
    FROM public.small_dollar_bracket_rollup b
   WHERE b.recipient_type = 'official'
     AND b.source         = 'fec_bulk_indiv'
     AND b.recipient_id   = ANY (p_recipients)
   GROUP BY b.recipient_id
  ON CONFLICT (official_id) DO NOTHING;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.small_dollar_rebuild_officials(uuid[]) IS
  'FIX-776/1068 — delete + re-aggregate official_small_dollar_rollup for a set '
  'of recipients: the itemized <$500 band from financial_relationships, and the '
  'sub-$200 residual from small_dollar_bracket_rollup. No COMMIT: the chunked '
  'backfill commits per chunk; donor_rollup_rebuild_recipients() calls it inside '
  'its own chunk txn.';

-- Function-grant hygiene (Supabase default-grants EXECUTE to anon/auth on every
-- CREATE OR REPLACE — FIX-695/834).
REVOKE ALL ON FUNCTION public.small_dollar_rebuild_officials(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.small_dollar_rebuild_officials(uuid[]) TO service_role;

-- ── 3b. The backfill has to see sub-floor-only officials too ─────────────────
--     FIX-776's bootstrap derived its work list from financial_relationships.
--     Post-3b an official can have bracketed sub-floor money and ZERO donation
--     FRs (every one of their donors stayed under $200), and such an official
--     would never appear in that list — so their residual would never reach the
--     rollup and the route would live-compute a permanent 0. UNION the bracket
--     table's official recipients in.
--
--     Everything else is FIX-776's procedure verbatim: same advisory lock, same
--     500-official chunks, same per-chunk COMMIT (memory-bounded, FIX-775
--     decision 3), same idempotency.
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

  SELECT array_agg(id) INTO v_officials
  FROM (
    SELECT DISTINCT fr.to_id AS id
      FROM public.financial_relationships fr
     WHERE fr.to_type           = 'official'
       AND fr.relationship_type = 'donation'
       AND fr.from_type         = 'financial_entity'
    UNION
    SELECT DISTINCT b.recipient_id AS id           -- FIX-1068
      FROM public.small_dollar_bracket_rollup b
     WHERE b.recipient_type = 'official'
  ) s;

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
          jsonb_build_object('officials', v_n, 'chunks', v_chunk_no, 'fix', 'FIX-1068'));

  RAISE NOTICE '[small-dollar backfill] complete — % officials, % rows in % chunks',
    v_n, v_rows, v_chunk_no;

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$$;

REVOKE ALL ON PROCEDURE public.backfill_official_small_dollar_rollup() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.backfill_official_small_dollar_rollup() TO service_role;

-- ── 4. Cleanup trigger parity ────────────────────────────────────────────────
--     official_small_dollar_rollup already drops rows on officials DELETE
--     (FIX-776 §5). The bracket table references officials the same way and
--     needs the same treatment — a derived table, cleaned by trigger rather than
--     FK, per the FIX-761 official-FK-surface contract.
CREATE OR REPLACE FUNCTION public.small_dollar_bracket_rollup_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.small_dollar_bracket_rollup
   WHERE recipient_type = 'official' AND recipient_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS small_dollar_bracket_rollup_cleanup_del ON public.officials;
CREATE TRIGGER small_dollar_bracket_rollup_cleanup_del
  AFTER DELETE ON public.officials
  FOR EACH ROW
  EXECUTE FUNCTION public.small_dollar_bracket_rollup_cleanup();

-- The financial_entity side (committee recipients) is cleaned the same way —
-- financial_entities rows are merged/deleted by the FIX-544 collision merge.
CREATE OR REPLACE FUNCTION public.small_dollar_bracket_rollup_cleanup_fe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.small_dollar_bracket_rollup
   WHERE recipient_type = 'financial_entity' AND recipient_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS small_dollar_bracket_rollup_cleanup_fe_del ON public.financial_entities;
CREATE TRIGGER small_dollar_bracket_rollup_cleanup_fe_del
  AFTER DELETE ON public.financial_entities
  FOR EACH ROW
  EXECUTE FUNCTION public.small_dollar_bracket_rollup_cleanup_fe();

-- PostgREST: new table + changed function body → nudge the schema cache.
NOTIFY pgrst, 'reload schema';
