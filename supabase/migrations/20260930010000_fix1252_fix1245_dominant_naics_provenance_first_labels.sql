-- =============================================================================
-- FIX-1252 — a contractor's NAICS code is its dollar-DOMINANT code, not MIN()
-- FIX-1245 — primary_industry_tag() ranks PROVENANCE before confidence
-- FIX-1254 — the seven 1:1 NAICS fallback labels become their industry labels
-- =============================================================================
--
-- ── FIX-1252: THE RULE ──────────────────────────────────────────────────────
-- get_financial_entity_naics() gave each contractor MIN(naics_code): the
-- lexicographically smallest code on any of its contract/grant rows, one stray
-- row enough. Now each contractor gets the code that carries the most dollars
-- on its rows (a NULL amount counts 0); a tie goes to the code with more rows;
-- a tie on both goes to the smaller code, so the pick is total. Examples (prod,
-- 2026-09-30, cc-176 read 2; MIN code → dominant code):
--   Electric Boat      213113 coal-mining support (→ oil_gas)  → 336611 ship building (→ defense)
--   Sikorsky           323117 book printing (→ manufacturing)  → 336411 aircraft (→ defense)
--   RTX                314999 textiles (→ manufacturing)       → 336412 aircraft engines (→ defense)
--   Bath Iron Works    332510 hardware (→ manufacturing)       → 336611 ship building (→ defense)
--   Lockheed Martin    331491 non-ferrous rolling              → 336411 aircraft
-- Population, prod 2026-09-30 04:53 UTC: 64,215 coded contractors, 20,224 with
-- more than one code; the MIN and dominant codes differ for 12,665 and the
-- INDUSTRY differs for 6,305 of them, carrying $158.7B of $417.7B coded
-- contract dollars. The top transition is manufacturing → defense (595
-- contractors, $64.6B).
--
-- The function keeps its signature, return shape, SECURITY DEFINER, SET
-- search_path and the FIX-919 one-pass LATERAL VALUES scan. Only the inner
-- aggregate changes: per (entity, code) dollars and rows, then DISTINCT ON
-- (entity) by the three keys. Measured on the clone (2026-09-30,
-- max_parallel_workers_per_gather = 0): cold (container stop, VM page cache
-- dropped 4,873 → 435 MB, start) 287,584 buffers read, 35.6 s, against the
-- MIN body's 33.2 s (cc-166 read 5b) on the same 287,584 buffers; warm, MIN
-- 7.60 s, DISTINCT ON 7.78 s, a row_number() window 7.54 s — the heap read is
-- the cost and the pick is noise. Prod plain EXPLAIN: the same Parallel Bitmap
-- Heap Scan via financial_relationships_contract_grant_updated_at, a
-- HashAggregate over (entity, code) (153k estimated groups), then Sort + Unique;
-- total cost 881,320 against the window form's 886,294. Its one runtime caller
-- is the nightly enrichment tail (rules.ts, rollupJsonbDirect), where the MIN
-- body took 105.1 s on prod (cc-166 §4).
--
-- WHAT IT WRITES (by the nightly, not here). The tagger clears and rewrites
-- every rule industry row in one transaction, so the next tail re-tags every
-- contractor under the dominant code. Rehearsed on the clone (the tagger
-- locally, this body plus FIX-1246's NAICS map, which reaches prod on the
-- same tail): 12,500 donors' tag content changed, the sector-affinity refresh
-- ran targeted with 0 officials affected (every NAICS-tagged entity donates
-- $0), multi-tag entities 4,919 → 4,061.
--
-- The contract treemap and contract_recipient_rollup report ONE code per
-- recipient row (FIX-873: one row per recipient), and they read MIN too
-- (20260930000000). They now take the same three-key pick, set-based: a
-- per-(recipient, code) aggregate, then array_agg(code ORDER BY dollars DESC,
-- rows DESC, code)[1] per recipient, over the rows the treemap already sums
-- (contracts, amount > 0, the to_id side). Measured on the clone, warm,
-- treemap(500): the MIN form 5.73 s / 554k buffers, this form 3.36 s / 520k —
-- it aggregates before the financial_entities join instead of after it. A
-- per-recipient LATERAL LIMIT 1 over the top 500 took 9.45 s. The whole
-- refresh_contract_flow_rollups() rebuild: 34.2 s on the clone (37–49 s for
-- the 20260930000000 body, cc-173). Totals and counts per recipient are
-- unchanged (the old and new treemap(500) EXCEPT each other on (entity,
-- cents, awards): 0 rows both ways); only naics_code and the fallback label
-- of an untagged recipient can move.
--
-- ── FIX-1245: THE RULE ──────────────────────────────────────────────────────
-- A financial entity with several industry tags has exactly one primary
-- industry:
--
--   ORDER BY (generated_by = 'curated') DESC,   -- a hand audit wins outright
--            (generated_by = 'ai') ASC,          -- then every non-ai (rule/NAICS) row
--            confidence DESC NULLS LAST,         -- by confidence within a provenance
--            tag                                 -- the alphabet: last, documented tie-break
--
-- FIX-918 (20260927020000) put confidence BEFORE provenance, so an ai tag above
-- a rule tag's confidence won. The two confidences are not one scale: an ai
-- tag's is the model's self-report (0.50–1.00), a rule tag's is a hand-set
-- constant (NAICS 0.85, a single keyword match 0.80, an ambiguous one 0.70).
-- Now curated beats everything, every rule row beats every ai row, ai rows rank
-- among themselves by confidence, and the alphabet decides only a full tie.
-- Ratified by Craig 2026-09-29 (cc-173 D1). cc-173 stopped it because it would
-- have promoted MIN(naics_code) tags over ai tags on 26 contractors carrying
-- $270.4B of contracts; with FIX-1252 above, that input is fixed.
--
-- Population it moves. Prod, now (the MIN-code tags this migration sees): 73
-- of 4,975 multi-tag entities — 23 donating PACs ($2,417,581.00 to officials:
-- Federal Agricultural Mortgage agriculture → finance, Ultra Electronics
-- defense → tech, …) and 50 NAICS-tagged corporations ($0 donated). After the
-- next tail re-tags under FIX-1252 (clone rehearsal, cc-176 read 3): 52 of
-- 4,061 — 24 donating PACs ($2,643,881.00) and 28 corporations ($0), where a
-- corrected contract code and an ai tag still disagree (L3Harris, SAIC, CACI,
-- MITRE defense → tech on 5415/5417/334; Duke Energy Progress oil_gas →
-- utilities on 2211; Tyson Foods agriculture → manufacturing on 3116).
--
-- The function keeps its FIX-918 shape exactly — two arms, each its own
-- DISTINCT ON … ORDER BY, NO SET clause (a SET would stop the inlining the MVs
-- depend on; see 20260927020000's header). Only the two ORDER BYs change, and
-- they stay identical. data:verify:primary-industry checks array = NULL = TS.
--
-- ── FIX-1245: THE RE-DIRTY ──────────────────────────────────────────────────
-- compute_fe_industry_tag_signature() hashes each donor's tag CONTENT
-- (tag:generated_by:confidence), so a change to the ORDER BY with the same tags
-- moves no signature, and refresh_sector_affinity_from_tag_changes() — the
-- nightly tail, after the tagger — would never re-derive the officials of a
-- donor whose pick just moved. Its three paths (20260927020000:2527-2613):
--   Path 1  stored sig NOT NULL AND shadow_n > 0 AND live = stored → noop
--   Path 2  stored sig IS NULL OR shadow_n = 0 → the FULL backfill (~23 min)
--   Path 3  otherwise → diff cur vs donor_industry_tag_state; a donor with no
--           shadow row (s.donor_id IS NULL) is dirty; its officials are
--           rebuilt in chunks of 500 and its shadow row re-inserted.
-- So this migration (a) DELETEs the shadow rows of exactly the entities whose
-- pick moves under the new rule — computed inline, the OLD order written out
-- literally, the NEW order read from the function just redefined — and (b)
-- sets the stored global sig to a non-NULL sentinel: Path 1 fails (live ≠
-- sentinel), Path 2 cannot fire (the sentinel is not NULL and the shadow keeps
-- ~81k rows), Path 3 diffs. Guards: more than 200 pick-changers means the CTE
-- is wrong, not the data; an UPDATE that touches ≠ 1 row means the key is
-- absent (Path 2 would already fire). Either RAISEs, and the whole migration
-- rolls back. It runs after the FIX-1252 redefinition but over the tags that
-- exist now: the 50 contractors among the 73 are re-dirtied harmlessly (they
-- donate $0), and the next tail re-tags them under the dominant code and then
-- re-derives. check_sector_affinity_tag_staleness() reads the sentinel as
-- 'pending' until that tail clears it (it escalates only after 26 h).
--
-- ── FIX-1254: ONE WORD PER INDUSTRY ─────────────────────────────────────────
-- The NAICS fallback CASE labels an untagged recipient, and seven of its arms
-- sat beside the INDUSTRY_LABELS value (packages/data/src/pipelines/tags/
-- topics.ts) a tagged recipient of the same industry carries, so one industry
-- drew as two rows inside an agency on the chord (cc-173 §5.4). Those seven
-- arms now emit the industry label; every other arm is unchanged (Construction,
-- Professional Services and the rest have no 1:1 industry; Utilities,
-- Manufacturing and Transportation already were one). The CASE, written ONCE
-- here and copied verbatim into all four sites — chord_contract_flows_full(),
-- treemap_recipients_by_contracts_full() and both CTEs of
-- refresh_contract_flow_rollups() — with only the argument differing (the
-- chord and its CTE label each row by its own code; the treemap and its CTE
-- by the recipient's dominant code):
--
--   CASE SUBSTRING(<code> FROM 1 FOR 2)
--     WHEN '11' THEN 'Agriculture & Food'             -- was 'Agriculture'
--     WHEN '21' THEN 'Mining & Metals'                -- was 'Mining'
--     WHEN '22' THEN 'Utilities'
--     WHEN '23' THEN 'Construction'
--     WHEN '31' / '32' / '33' THEN 'Manufacturing'
--     WHEN '42' THEN 'Wholesale Trade'
--     WHEN '44' / '45' THEN 'Consumer Goods & Services' -- was 'Retail'
--     WHEN '48' / '49' THEN 'Transportation'
--     WHEN '51' THEN 'Technology & Communications'    -- was 'Information Technology'
--     WHEN '52' THEN 'Finance & Insurance'            -- was 'Finance'
--     WHEN '53' THEN 'Real Estate & Construction'     -- was 'Real Estate'
--     WHEN '54' THEN 'Professional Services'
--     WHEN '55' THEN 'Management'
--     WHEN '56' THEN 'Administrative Services'
--     WHEN '61' THEN 'Education'
--     WHEN '62' THEN 'Health Care'                    -- was 'Healthcare'
--     WHEN '71' THEN 'Arts & Entertainment'
--     WHEN '72' THEN 'Hospitality'
--     WHEN '81' THEN 'Other Services'
--     WHEN '92' THEN 'Government'
--     ELSE 'Other'
--   END
--
-- apps/civitics/src/lib/naics-sector-label.ts is its TS copy, pinned by
-- naics-sector-label.test.ts to the newest migration carrying the CASE (this
-- one). The renamed labels are industry labels, so contractSectorColor()
-- colours them by key with no new entries. No shape change: jobid 28's next
-- rebuild (Thu 14:00 UTC, DELETE then INSERT) writes the new strings; Σ
-- total_cents per rollup is unchanged to the cent (rule 116); rows can merge
-- where a pair sat in one agency.
--
-- Every redefinition here is the PROD body (pg_get_functiondef, 2026-09-30
-- 04:59 UTC, md5-equal to the clone's, i.e. to 20260930000000 /
-- 20260927020000 / 20260927020100) with only the named lines changed, and
-- each re-states its own SET / SECURITY clauses (rule 34).
-- =============================================================================

SET statement_timeout = '10min';

-- ── 1. FIX-1252 — the dominant code ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_financial_entity_naics()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'entity_id',  n.entity_id,
           'naics_code', n.naics_code
         )), '[]'::jsonb)
  FROM (
    -- FIX-1252: the dollar-dominant code, not MIN(naics_code). One row per
    -- entity: most dollars (a NULL amount counts 0), then most rows, then the
    -- smaller code.
    SELECT DISTINCT ON (c.entity_id) c.entity_id, c.naics_code
    FROM (
      -- FIX-919: the financial_entity on EITHER side of a contract/grant — the
      -- contractor is to_id (agency → financial_entity); from_id is kept for
      -- FE-sourced rows. One heap pass; see 20260927020100 for why not UNION ALL.
      SELECT side.entity_id,
             fr.metadata->>'naics_code'        AS naics_code,
             SUM(COALESCE(fr.amount_cents, 0)) AS code_cents,
             COUNT(*)                          AS code_rows
      FROM public.financial_relationships fr
      CROSS JOIN LATERAL (VALUES
        (CASE WHEN fr.to_type   = 'financial_entity' THEN fr.to_id   END),
        (CASE WHEN fr.from_type = 'financial_entity' THEN fr.from_id END)
      ) AS side(entity_id)
      WHERE fr.relationship_type IN ('contract', 'grant')
        AND (fr.to_type = 'financial_entity' OR fr.from_type = 'financial_entity')
        AND fr.metadata->>'naics_code' IS NOT NULL
        AND side.entity_id IS NOT NULL
      GROUP BY side.entity_id, fr.metadata->>'naics_code'
    ) c
    ORDER BY c.entity_id, c.code_cents DESC, c.code_rows DESC, c.naics_code
  ) n;
$function$;

-- ── 2. FIX-1245 — the one home, provenance first ──────────────────────────────
CREATE OR REPLACE FUNCTION public.primary_industry_tag(p_entity_ids uuid[])
RETURNS TABLE (entity_id uuid, tag text, display_label text, display_icon text)
LANGUAGE sql
STABLE
AS $function$
  -- Every tagged financial entity (p_entity_ids IS NULL).
  (SELECT DISTINCT ON (et.entity_id)
          et.entity_id, et.tag, et.display_label, et.display_icon
   FROM public.entity_tags et
   WHERE p_entity_ids IS NULL
     AND et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
   ORDER BY et.entity_id,
            (et.generated_by = 'curated') DESC,   -- THE RULE (1 of 2 copies;
            (et.generated_by = 'ai') ASC,         --  keep identical to the
            et.confidence DESC NULLS LAST,        --  array arm below)
            et.tag)
  UNION ALL
  -- The given ids.
  (SELECT DISTINCT ON (et.entity_id)
          et.entity_id, et.tag, et.display_label, et.display_icon
   FROM public.entity_tags et
   WHERE et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
     AND et.entity_id = ANY (p_entity_ids)
   ORDER BY et.entity_id,
            (et.generated_by = 'curated') DESC,   -- THE RULE (2 of 2 copies)
            (et.generated_by = 'ai') ASC,
            et.confidence DESC NULLS LAST,
            et.tag);
$function$;

COMMENT ON FUNCTION public.primary_industry_tag(uuid[]) IS
  'FIX-918/FIX-1245 — THE home of a financial entity''s primary industry: one '
  'row per tagged entity, ranked curated > rule-before-ai > confidence DESC '
  'NULLS LAST > tag (provenance before confidence: an ai confidence is a '
  'self-report, a rule confidence a hand-set constant). Pass the ids you need; '
  'NULL = every tagged financial entity (whole-table rebuilds only). Every SQL '
  'surface and fetchIndustryTagsByEntityId read this; do not re-derive the pick '
  'inline.';

-- ── 3. FIX-1245 — re-dirty exactly the pick-changers for the nightly tail ─────
DO $$
DECLARE
  v_changed  uuid[];
  v_n        int;
  v_deleted  bigint;
  v_sentinel bigint;
BEGIN
  WITH multi AS (
    SELECT et.entity_id
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id
    HAVING count(*) > 1
  ),
  old_pick AS (
    -- The FIX-918 order, written out: the function above is now the new one.
    SELECT DISTINCT ON (et.entity_id) et.entity_id, et.tag
      FROM public.entity_tags et
      JOIN multi m ON m.entity_id = et.entity_id
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     ORDER BY et.entity_id,
              (et.generated_by = 'curated') DESC,
              et.confidence DESC NULLS LAST,
              (et.generated_by = 'ai') ASC,
              et.tag
  ),
  new_pick AS (
    SELECT pit.entity_id, pit.tag
      FROM public.primary_industry_tag(NULL) pit
      JOIN multi m ON m.entity_id = pit.entity_id
  )
  SELECT array_agg(o.entity_id ORDER BY o.entity_id) INTO v_changed
    FROM old_pick o
    JOIN new_pick n ON n.entity_id = o.entity_id
   WHERE o.tag IS DISTINCT FROM n.tag;

  v_n := COALESCE(array_length(v_changed, 1), 0);
  RAISE NOTICE '[FIX-1245] % multi-tag entities pick differently under provenance-first', v_n;
  IF v_n > 200 THEN
    RAISE EXCEPTION '[FIX-1245] % pick-changers > 200 — the re-dirty CTE is wrong, not the data; nothing landed', v_n;
  END IF;

  DELETE FROM public.donor_industry_tag_state s
   WHERE s.donor_id = ANY (v_changed);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE '[FIX-1245] deleted % donor_industry_tag_state rows (the Path 3 dirty set)', v_deleted;

  UPDATE public.pipeline_state
     SET value      = jsonb_set(value, '{sig}', to_jsonb('invalidated:cc-176:' || clock_timestamp()::text)),
         updated_at = clock_timestamp()
   WHERE key = 'sector_affinity:industry_tag_signature';
  GET DIAGNOSTICS v_sentinel = ROW_COUNT;
  RAISE NOTICE '[FIX-1245] signature sentinel set on % pipeline_state row(s)', v_sentinel;
  IF v_sentinel <> 1 THEN
    RAISE EXCEPTION '[FIX-1245] sentinel UPDATE touched % rows, want 1 — the key is absent and Path 2 (the full backfill) would fire; nothing landed', v_sentinel;
  END IF;
END
$$;

-- ── 4. FIX-1254 — the contract surfaces' NAICS CASE, seven arms renamed ───────

-- chord_contract_flows_full: the CASE only (per-row code, as before)
CREATE OR REPLACE FUNCTION public.chord_contract_flows_full()
 RETURNS TABLE(agency_id uuid, agency_name text, agency_acronym text, sector text, total_cents bigint, award_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH recipient_industry AS (
    -- FIX-873: one industry tag per financial_entity, so a multi-tag recipient's
    -- awards are NOT counted into every sector. FIX-918: the ranked pick, from
    -- its one home. FIX-1247: its display label, not its key.
    SELECT pit.entity_id, pit.display_label
    FROM public.primary_industry_tag(NULL) pit
  ),
  classified AS (
    SELECT
      a.id::UUID                                      AS agency_id,
      a.name                                          AS agency_name,
      COALESCE(a.acronym, a.short_name, a.name)       AS agency_acronym,
      COALESCE(
        -- FIX-109 industry tag takes priority (rule-based NAICS classifier),
        -- FIX-873: single deterministic tag per recipient.
        ri.display_label,
        -- Fallback: derive sector from NAICS 2-digit prefix in metadata.
        -- FIX-1254: the 1:1 arms emit the industry label.
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
    SUM(amount_cents)::BIGINT  AS total_cents,
    COUNT(*)::BIGINT           AS award_count
  FROM classified
  GROUP BY agency_id, agency_name, agency_acronym, sector
  ORDER BY total_cents DESC;
$function$;

-- treemap_recipients_by_contracts_full: the recipient's dominant code (FIX-1252) + the CASE (FIX-1254)
CREATE OR REPLACE FUNCTION public.treemap_recipients_by_contracts_full(lim integer DEFAULT 100)
 RETURNS TABLE(entity_id uuid, entity_name text, industry text, naics_code text, total_cents bigint, award_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH recipient_industry AS (
    -- FIX-873: one industry tag per financial_entity, so a multi-tag recipient
    -- is NOT emitted as N duplicate rows. FIX-918: the ranked pick, from its
    -- one home. FIX-1247: its display label, not its key.
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
    -- FIX-1252: one row per recipient (FIX-873); its code is the dominant one —
    -- most dollars, then most rows, then the smaller code, the rule
    -- get_financial_entity_naics() tags by. A NULL code carries no vote.
    SELECT rc.entity_id,
           SUM(rc.code_cents)::BIGINT AS total_cents,
           SUM(rc.code_rows)::BIGINT  AS award_count,
           (array_agg(rc.naics_code ORDER BY rc.code_cents DESC, rc.code_rows DESC, rc.naics_code)
              FILTER (WHERE rc.naics_code IS NOT NULL))[1] AS naics_code
    FROM recipient_codes rc
    GROUP BY rc.entity_id
  )
  SELECT
    fe.id::UUID                              AS entity_id,
    fe.display_name                          AS entity_name,
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
    )                                        AS industry,
    r.naics_code                             AS naics_code,
    r.total_cents                            AS total_cents,
    r.award_count                            AS award_count
  FROM recipients r
  JOIN public.financial_entities fe
    ON fe.id = r.entity_id
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  ORDER BY r.total_cents DESC
  LIMIT lim;
$function$;

-- refresh_contract_flow_rollups: the recipient CTE takes the dominant code (FIX-1252); both CTEs the CASE (FIX-1254)
CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
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
    -- xact-scoped lock: the RETURN ends the transaction, which releases it.
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
$procedure$;

RESET statement_timeout;
