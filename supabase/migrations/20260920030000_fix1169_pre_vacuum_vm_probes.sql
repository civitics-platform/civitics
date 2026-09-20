-- FIX-1169 — the pre-vacuum visibility-map probe. THE INSTRUMENT, NOT THE GATE.
--
-- FIX-1169 asks whether `ec-vacuum-analyze` is a fixed daily cost worth gating
-- on `pg_class` instead of running unconditionally. That question cannot be
-- answered today, because NOTHING measures a table's visibility map immediately
-- BEFORE its vacuum runs. The closest reading is FIX-1152's `vm_before`, stamped
-- at `refresh_derived_mvs` RUN START -- which is 06:00 UTC, i.e. AFTER all three
-- vacuums (03:00 FR, 04:30 EC, 04:50 FE). It measures what the vacuum LEFT, and
-- the gate decision needs what the vacuum FOUND.
--
-- So: one catalog read per table, scheduled five minutes before each vacuum.
-- After a week of rows the question "would a gate have skipped this run, and
-- what would it have cost?" is answerable from the receipts file instead of from
-- a live pg_class read that only ever holds NOW.
--
-- NO GATE IS ADDED AND NO VACUUM IS CHANGED BY THIS MIGRATION. FIX-1169 stays
-- OPEN; this is the evidence it was missing, and the decision waits for the data.
--
-- SHAPE. `vm[]` is FIX-1152's `vm_before` jsonb, element for element, which is
-- itself the shape `check_rebuild_autovacuum_status()` publishes (FIX-885) -- so
-- the pre-vacuum and post-vacuum readings can be read with the same expression
-- and diffed without a translation step. That is the whole reason not to invent
-- a new shape here.
--
-- STORAGE. `pipeline_state` key `vm_probe:<label>`, one row per label, upserted.
-- The prefix:suffix key form follows `size_tags:donation_watermark` and
-- `irs990:index_watermark`. Deliberately NOT a history table: the row is
-- overwritten daily, and the history that matters is the one the receipts file
-- already keeps, day by day, in git. A table nobody prunes is a bill nobody
-- planned (FIX-1165's lesson, one size down).
--
-- COST. Two index lookups per relation over pg_class and pg_stat_user_tables,
-- plus one upsert. Milliseconds. It takes no lock a vacuum cares about, which is
-- why running it five minutes before one is safe.
--
-- WHY A PLAIN FUNCTION AND A SINGLE-STATEMENT pg_cron COMMAND. The job's command
-- is `SELECT public.record_vm_probe(...)` -- ONE statement. A pg_cron command
-- with more than one statement runs in an implicit transaction block, which is
-- fatal for a procedure that COMMITs (FIX-1128). This callee never COMMITs, so
-- the single-statement form is safe for it, and it is the form that stays safe.
-- No `cron_job_budget` row: a budget exists to bound a unit that can run long,
-- and this cannot.
--
-- fix1128: the SET clause below is `search_path` only. This routine has no
-- transaction control, so proconfig is legal for it -- the rule those two break
-- is that they are mutually exclusive, and only one is used here. There is no
-- `statement_timeout` proconfig, which would be inert.

CREATE OR REPLACE FUNCTION public.record_vm_probe(p_label text, p_relations text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vm  jsonb;
  v_out jsonb;
BEGIN
  IF p_label IS NULL OR p_label = '' THEN
    RAISE EXCEPTION 'record_vm_probe: p_label is required';
  END IF;
  IF p_relations IS NULL OR array_length(p_relations, 1) IS NULL THEN
    RAISE EXCEPTION 'record_vm_probe: p_relations must name at least one relation';
  END IF;

  -- FIX-1152's vm_before shape, element for element.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'relation',        t.relname,
           'relpages',        t.relpages,
           'relallvisible',   t.relallvisible,
           'pct_all_visible', CASE WHEN t.relpages > 0
                                   THEN round(100.0 * t.relallvisible / t.relpages, 1)
                                   ELSE 100.0 END,
           'n_dead_tup',      t.n_dead_tup,
           'n_live_tup',      t.n_live_tup,
           'last_vacuum',     t.last_vacuum,
           'last_autovacuum', t.last_autovacuum
         ) ORDER BY t.relname), '[]'::jsonb)
    INTO v_vm
    FROM (
      SELECT c.relname, c.relpages, c.relallvisible,
             s.n_dead_tup, s.n_live_tup, s.last_vacuum, s.last_autovacuum
      FROM pg_class c
      JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relname = ANY(p_relations)
    ) t;

  v_out := jsonb_build_object('at', clock_timestamp(), 'vm', v_vm);

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('vm_probe:' || p_label, v_out)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.record_vm_probe(text, text[]) IS
  'FIX-1169 — records a relation''s visibility-map state into pipeline_state as '
  'vm_probe:<label>, in FIX-1152''s vm_before shape. Scheduled five minutes before '
  'each *-vacuum-analyze job so the gate question (what did the vacuum FIND?) has '
  'an answer; the 06:00 vm_before reading only ever showed what it LEFT.';

REVOKE ALL ON FUNCTION public.record_vm_probe(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_vm_probe(text, text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- The three jobs, five minutes ahead of the vacuum each one is paired with.
-- Schedules read off prod's cron.job by NAME, never by jobid (FIX-946):
--   fr-vacuum-analyze  0 3 * * *   -> vm-probe-pre-fr  55 2 * * *
--   ec-vacuum-analyze  30 4 * * *  -> vm-probe-pre-ec  25 4 * * *
--   fe-vacuum-analyze  50 4 * * *  -> vm-probe-pre-fe  45 4 * * *
-- `votes` rides with the EC probe: cc-136 §3.4 found it is the only Index Only
-- Scan in the rule-tagger plan (96.7 % all-visible) and it has no vacuum owner
-- at all, so its decay is the one nothing would otherwise notice.
-- cron.schedule() on an existing jobname updates it in place, so this is
-- re-runnable.
-- ---------------------------------------------------------------------------

SELECT cron.schedule('vm-probe-pre-fr', '55 2 * * *',
  $job$SELECT public.record_vm_probe('pre-fr', ARRAY['financial_relationships'])$job$);

SELECT cron.schedule('vm-probe-pre-ec', '25 4 * * *',
  $job$SELECT public.record_vm_probe('pre-ec', ARRAY['entity_connections','votes'])$job$);

SELECT cron.schedule('vm-probe-pre-fe', '45 4 * * *',
  $job$SELECT public.record_vm_probe('pre-fe', ARRAY['financial_entities'])$job$);
