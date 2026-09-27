-- =============================================================================
-- FIX-918 — primary_industry_tag(): ONE home for "a donor's primary industry"
-- =============================================================================
--
-- THE RULE. A financial entity with several industry tags has exactly one
-- primary industry:
--
--   ORDER BY (generated_by = 'curated') DESC,   -- a hand audit wins outright
--            confidence DESC NULLS LAST,         -- then the most confident
--            (generated_by = 'ai') ASC,          -- at equal confidence, rule beats ai
--            tag                                 -- the alphabet: last, documented tie-break
--
-- Measured confidences (prod, 2026-09-27): curated 1.00 (426); NAICS rule tags
-- 0.85 (none yet: FIX-919 lands them); keyword rule tags 0.80 on a single match
-- (38,098) and 0.70 when a name matches several industries (2,472); ai tags
-- 0.50–1.00. So NAICS outranks keyword on confidence alone, with no NAICS-specific
-- key needed, and an AI tag ABOVE a rule tag's confidence wins
-- (confidence before provenance). The alphabet now decides only among tags of
-- equal provenance and equal confidence. Today that is the 1,223 donors whose
-- two or three tags are all rule@0.70 (one ambiguous keyword match).
--
-- Before this, fifteen surfaces each carried their own copy of the pick, and
-- they did not agree: thirteen took DISTINCT ON (entity_id) ORDER BY tag
-- (alphabetical); refresh_group_donor_rollup took MIN(display_label) (alphabetical
-- by LABEL); get_cohort_top_donors took ORDER BY tag LIMIT 1; and
-- search_graph_entities took all of them (a fan-out). The TS reader
-- fetchIndustryTagsByEntityId had no ORDER BY at all. Every one now reads this
-- function. Population it moves on prod (2026-09-27): 1,334 multi-tag donors, of
-- which 44 change pick. 145 of the 1,334 donate to officials, $13.76M in all,
-- and $4.82M of that belongs to donors whose pick moves.
--
-- CALL SHAPES. p_entity_ids = an id array → that set only (an index probe on
-- entity_tags_fe_industry_content). p_entity_ids = NULL → every tagged
-- financial entity, for the whole-table sites (the two MVs, the full rollups,
-- the search index) whose CTE already read the whole set. One row per entity:
-- (entity_type, entity_id, tag, tag_category) is UNIQUE, so the final `tag`
-- key makes the order total.
--
-- THE SHAPE IS LOAD-BEARING. Measured on the clone, 2026-09-27, three bodies:
--   * DISTINCT ON over (NULL-gated arm UNION ALL array arm), with SET
--     search_path — never inlined, so the planner costs a Function Scan at the
--     default 1,000 rows. Joined to financial_relationships it picks a nested
--     loop of per-donor index probes (FR from_id stats estimate ~1 row per
--     donor), and official_sector_dollars_mv's populate ran >10 min against
--     2.8 s for a hash plan; ROWS 50000 did not change the plan.
--   * one scan with (p IS NULL OR entity_id = ANY(p)) — inlines and folds for a
--     NULL or constant argument, but an argument holding a sub-select
--     (ARRAY(SELECT …)) blocks inlining, and the generic plan cannot use the
--     index through the OR: 23 s for 100 ids.
--   * THIS ONE: two arms, each its own DISTINCT ON … ORDER BY, no SET clause.
--     Inlined with NULL, the NULL arm carries entity_tags' own distinct estimate
--     (87,560) and the MV queries plan the hash join the old CTE did; inlined
--     with a constant array the NULL arm folds to One-Time Filter: false; not
--     inlined (a sub-select argument) it runs the gated arm plus the index
--     probe: 100 ids in 84 ms, a ~50k-id array in ~0.7 s; a per-row LATERAL
--     call 0.02 ms.
-- The ranking is therefore WRITTEN TWICE, once per arm, inside this one
-- function. Keep the two ORDER BYs identical; data:verify:primary-industry
-- checks the array arm against the NULL arm on every fixture and every real
-- multi-tag donor. No SET clause: every name is schema-qualified, and a SET
-- would stop the inlining the MVs depend on. SECURITY INVOKER, STABLE.
--
-- ALSO IN THIS MIGRATION
--   * compute_fe_industry_tag_signature() + refresh_sector_affinity_from_tag_changes():
--     the per-donor signature was md5 of the tag SET, so a change that moved a
--     donor's pick without changing its tag set (this migration, for one) never
--     reached official_sector_affinity_rollup. Each tag now contributes
--     tag:generated_by:confidence — the ranking inputs. The shadow rows of
--     single-tag donors whose stored sig still matches their one tag are
--     converted in place (their pick cannot have moved); every multi-tag donor
--     is left in the old format, so the next scheduled refresh (the nightly tail,
--     after the tagger) re-derives exactly their officials.
--   * The two MVs (official_sector_dollars_mv, chord_industry_flows_mv) are NOT
--     redefined here. Their swap is 20260927020200: its first landing, inside
--     this file, was cancelled on prod after the chord twin's populate ran 19.5
--     min under the session's default parallel settings (see that file).
--     Until it lands they keep the alphabetical pick; nothing here depends on it.
--
-- CONSERVATION (rule 116). The pick moves dollars between tags; it never
-- creates or destroys them. Per surface, Σ total_cents before = after, to the
-- cent, with the per-tag split moving only for the multi-tag population:
--
--   SELECT 'osar', sum(total_cents) FROM official_sector_affinity_rollup
--   UNION ALL SELECT 'osd', sum(total_cents) FROM official_sector_dollars_mv
--   UNION ALL SELECT 'cif', sum(total_cents) FROM chord_industry_flows_mv
--   UNION ALL SELECT 'gdr', sum(total_cents) FROM group_donor_rollup
--   UNION ALL SELECT 'crr', sum(total_cents) FROM contract_recipient_rollup
--   UNION ALL SELECT 'cas', sum(total_cents) FROM contract_agency_sector_rollup
--   UNION ALL SELECT 'odr', sum(total_cents) FROM official_donor_rollup_mv
--   UNION ALL SELECT 'dpr', sum(total_cents) FROM donor_party_rollup_mv;
--
-- plus, per surface, the same with GROUP BY <its industry column> for the split.
-- The MVs are compared against the live ledger in one snapshot on the clone
-- (their prior contents are a week stale).
--
-- Every function redefined here is the PROD body (pg_get_functiondef,
-- 2026-09-27) with only the pick changed; each re-states its own SET /
-- SECURITY clauses (rule 34). refresh_donor_party_rollup_incremental is the
-- body AFTER FIX-1216 (20260927010000), which lands first.
-- =============================================================================

SET statement_timeout = '10min';

-- ── 0. The one home ──────────────────────────────────────────────────────────
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
            et.confidence DESC NULLS LAST,        --  keep identical to the
            (et.generated_by = 'ai') ASC,         --  array arm below)
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
            et.confidence DESC NULLS LAST,
            (et.generated_by = 'ai') ASC,
            et.tag);
$function$;

COMMENT ON FUNCTION public.primary_industry_tag(uuid[]) IS
  'FIX-918 — THE home of a financial entity''s primary industry: one row per '
  'tagged entity, ranked curated > confidence DESC NULLS LAST > rule-before-ai > '
  'tag. Pass the ids you need; NULL = every tagged financial entity (whole-table '
  'rebuilds only). Every SQL surface and fetchIndustryTagsByEntityId read this; '
  'do not re-derive the pick inline.';

GRANT EXECUTE ON FUNCTION public.primary_industry_tag(uuid[]) TO anon, authenticated, service_role;

-- ── 1. The sites, redefined in place (prod bodies; only the pick changes) ─────

-- sector_affinity_rebuild_officials: donor_tag CTE → primary_industry_tag(per_donor ids)
CREATE OR REPLACE FUNCTION public.sector_affinity_rebuild_officials(p_recipients uuid[])
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.official_sector_affinity_rollup
   WHERE official_id = ANY (p_recipients);

  WITH per_donor AS (
    SELECT
      fr.to_id                     AS official_id,
      fr.from_id                   AS donor_id,
      SUM(fr.amount_cents)::bigint  AS cents
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type         = 'financial_entity'
      AND fr.to_type           = 'official'
      AND fr.amount_cents > 0
      AND fr.to_id = ANY (p_recipients)
    GROUP BY fr.to_id, fr.from_id
  ),
  donor_tag AS (
    -- FIX-918: the donor's primary industry, from its one home. Scoped to this
    -- chunk's donors so it stays an index probe.
    SELECT pit.entity_id AS donor_id,
           pit.tag       AS industry
    FROM public.primary_industry_tag(ARRAY(SELECT donor_id FROM per_donor)) pit
  ),
  by_sector AS (
    SELECT
      pd.official_id,
      COALESCE(dt.industry, 'Untagged') AS industry,
      SUM(pd.cents)::bigint             AS total_cents,
      COUNT(*)::bigint                  AS donor_count   -- per_donor is 1 row/donor → distinct donors
    FROM per_donor pd
    LEFT JOIN donor_tag dt ON dt.donor_id = pd.donor_id
    GROUP BY pd.official_id, COALESCE(dt.industry, 'Untagged')
  ),
  ins AS (
    INSERT INTO public.official_sector_affinity_rollup
      (official_id, industry, total_cents, donor_count, updated_at)
    -- FIX-981: was now() — the caller's chunk-transaction start, not this write.
    SELECT official_id, industry, total_cents, donor_count, clock_timestamp() FROM by_sector
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$function$;

-- chord_industry_flows_for_official: donor_industry CTE → primary_industry_tag(NULL)
CREATE OR REPLACE FUNCTION public.chord_industry_flows_for_official(p_official_id uuid)
 RETURNS TABLE(industry text, display_label text, display_icon text, total_cents bigint, donor_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH donor_industry AS (
    -- FIX-918: the donor's primary industry, from its one home.
    SELECT pit.entity_id, pit.tag, pit.display_label, pit.display_icon
    FROM public.primary_industry_tag(NULL) pit
  )
  SELECT
    COALESCE(di.tag, 'untagged')                    AS industry,
    -- FIX-854 display collapse retained; with one row per donor it is a no-op
    -- collapse but keeps the exact output shape.
    COALESCE(MAX(di.display_label), 'Untagged')     AS display_label,
    COALESCE(MAX(NULLIF(di.display_icon, '')), '')  AS display_icon,
    SUM(fr.amount_cents)::BIGINT                     AS total_cents,
    COUNT(DISTINCT fe.id)::BIGINT                    AS donor_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN donor_industry di
    ON di.entity_id = fe.id
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
    AND fr.amount_cents > 0
  GROUP BY COALESCE(di.tag, 'untagged')
  ORDER BY total_cents DESC;
$function$;

-- chord_top_pacs_for_official: donor_industry CTE → primary_industry_tag(NULL)
CREATE OR REPLACE FUNCTION public.chord_top_pacs_for_official(p_official_id uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(pac_id uuid, pac_name text, industry text, display_label text, display_icon text, total_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  WITH donor_industry AS (
    -- FIX-918: the donor's primary industry, from its one home.
    SELECT pit.entity_id, pit.tag, pit.display_label, pit.display_icon
    FROM public.primary_industry_tag(NULL) pit
  )
  SELECT
    fe.id                                  AS pac_id,
    fe.display_name                        AS pac_name,
    COALESCE(di.tag,           'untagged') AS industry,
    COALESCE(di.display_label, 'Untagged') AS display_label,
    COALESCE(di.display_icon,  '')         AS display_icon,
    SUM(fr.amount_cents)::BIGINT           AS total_cents
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN donor_industry di
    ON di.entity_id = fe.id
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
    AND fr.amount_cents > 0
    AND fe.entity_type IN ('pac', 'super_pac', 'party_committee', 'union', 'corporation')
  GROUP BY fe.id, fe.display_name,
           COALESCE(di.tag,           'untagged'),
           COALESCE(di.display_label, 'Untagged'),
           COALESCE(di.display_icon,  '')
  ORDER BY total_cents DESC
  LIMIT p_limit;
$function$;

-- chord_contract_flows_full: recipient_industry CTE → primary_industry_tag(NULL)
CREATE OR REPLACE FUNCTION public.chord_contract_flows_full()
 RETURNS TABLE(agency_id uuid, agency_name text, agency_acronym text, sector text, total_cents bigint, award_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH recipient_industry AS (
    -- FIX-873: one industry tag per financial_entity, so a multi-tag recipient's
    -- awards are NOT counted into every sector. FIX-918: the ranked pick, from
    -- its one home.
    SELECT pit.entity_id, pit.tag
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
        ri.tag,
        -- Fallback: derive sector from NAICS 2-digit prefix in metadata
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
    SUM(amount_cents)::BIGINT  AS total_cents,
    COUNT(*)::BIGINT           AS award_count
  FROM classified
  GROUP BY agency_id, agency_name, agency_acronym, sector
  ORDER BY total_cents DESC;
$function$;

-- treemap_recipients_by_contracts_full: recipient_industry CTE → primary_industry_tag(NULL)
CREATE OR REPLACE FUNCTION public.treemap_recipients_by_contracts_full(lim integer DEFAULT 100)
 RETURNS TABLE(entity_id uuid, entity_name text, industry text, naics_code text, total_cents bigint, award_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH recipient_industry AS (
    -- FIX-873: one industry tag per financial_entity, so a multi-tag recipient
    -- is NOT emitted as N duplicate rows. FIX-918: the ranked pick, from its
    -- one home.
    SELECT pit.entity_id, pit.tag
    FROM public.primary_industry_tag(NULL) pit
  )
  SELECT
    fe.id::UUID                              AS entity_id,
    fe.display_name                          AS entity_name,
    COALESCE(ri.tag, 'Other')                AS industry,
    MIN(fr.metadata->>'naics_code')          AS naics_code,
    SUM(fr.amount_cents)::BIGINT             AS total_cents,
    COUNT(*)::BIGINT                         AS award_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
  LEFT JOIN recipient_industry ri
    ON ri.entity_id = fe.id
  WHERE fr.relationship_type = 'contract'
    AND fr.amount_cents > 0
  GROUP BY fe.id, fe.display_name, ri.tag
  ORDER BY total_cents DESC
  LIMIT lim;
$function$;

-- refresh_contract_flow_rollups: both recipient_industry CTEs → primary_industry_tag(NULL)
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
    -- FIX-918: the ranked pick, from its one home.
    SELECT pit.entity_id, pit.tag
    FROM public.primary_industry_tag(NULL) pit
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
    -- FIX-918: the ranked pick, from its one home.
    SELECT pit.entity_id, pit.tag
    FROM public.primary_industry_tag(NULL) pit
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
$procedure$;

-- donor_rollup_rebuild_bulk: _drb_fe industry subquery → primary_industry_tag(NULL)
CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('official_donor_rollup_refresh')::bigint;
  c_state_key  text   := 'donor_rollup_bulk_sweep';
  c_global     uuid   := '00000000-0000-0000-0000-000000000000';
  c_chunks     int    := 32;      -- must divide 256 (uuid first-byte ranges)
  -- FIX-973 - the SCHEDULED budget, sized the FIX-1002 way. Was 4h30m, which
  -- was right for a hand-driven break-glass run and wrong for jobid 24: two
  -- firings 3 h apart mean a 4h30m run is still inside itself when the second
  -- starts, and pg_cron QUEUES rather than skips. 2 h is the same bound the
  -- per-recipient path carried; the measured full sweep is 926 s.
  -- Overridable via civitics.donor_rollup_bulk_budget_seconds (break-glass).
  c_budget     interval := interval '2 hours';
  c_max_sweep  interval := interval '48 hours';

  -- FIX-973 - the log pipeline. The registry, the canary and
  -- check_rollup_freshness all judge `donor_rollup_refresh`; routing jobid 24
  -- here must not move the freshness clock to a new name, so the REGIME is
  -- metadata and the PIPELINE stays put. 'donor_rollup_bulk' survives as
  -- metadata.regime so the two histories stay separable after the fact.
  c_pipeline   text   := 'donor_rollup_refresh';

  -- FIX-973 - carried over from refresh_official_donor_rollup_incremental().
  -- The 12:00 backstop exists for a starved 09:00 launch; it must not open a
  -- second window into active hours. Same two GUCs as the incremental so the
  -- refusal stays testable without a wall clock.
  c_latest_hour int := 13;

  -- FIX-973 - cold seed for the predictive budget guard, so it is ARMED BEFORE
  -- CHUNK 0 rather than only after one chunk has completed. Without a seed
  -- `v_max_chunk > 0` is false on the first iteration and the guard cannot
  -- refuse a first chunk - which is exactly the window a slow pre-loop staging
  -- build opens. 600 s is ~10x the worst chunk ever measured (59 s, the 08-07
  -- full sweep). Overridable via civitics.donor_rollup_bulk_chunk_seed_seconds,
  -- which is also how the refusal is exercised in test.
  c_seed_chunk double precision := 600.0;

  v_state      jsonb;
  v_cursor     int;
  v_mode       text;
  v_resumed    boolean := false;
  v_restarted  text    := NULL;
  v_sweep_beg  timestamptz;
  v_sweep_tgt  timestamptz;
  v_horizon    timestamptz;   -- FIX-983
  v_watermark  timestamptz;
  v_log_id     uuid;
  v_cfg        int;
  v_cfg_txt    text;
  v_step       int;
  v_ignore_win boolean;
  v_hour_cfg   int;
  v_seed_cfg   double precision;
  v_seed_ref   double precision;
  v_guard_ref  double precision;
  v_prev_slow  int := 0;
  v_resume_at  int;
  v_started    timestamptz := clock_timestamp();
  v_chunk_beg  timestamptz;
  v_chunk_secs double precision;
  v_max_chunk  double precision := 0;
  v_budget_hit boolean := false;
  v_failed     text := NULL;
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- This is the manual break-glass bulk path, so the axe here is normally an
  -- operator cancel or the 6h role default rather than a cron budget — the
  -- stranding is identical either way.
  v_canceled   text := NULL;
  v_elapsed    double precision;
  v_lo         uuid;
  v_hi         uuid;
  v_n_targets  int := 0;
  v_n_offic    int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_done       int := 0;
  k            int;
BEGIN
  -- Start-window refusal (FIX-1002, carried to the bulk regime by FIX-973).
  -- BEFORE the advisory lock, so a firing pg_cron queued behind an overrunning
  -- run exits immediately instead of waiting on a lock it would then hold for
  -- another full budget.
  v_ignore_win := COALESCE(
    NULLIF(current_setting('civitics.donor_rollup_ignore_start_window', true), '')::boolean,
    false);
  v_hour_cfg := NULLIF(current_setting('civitics.donor_rollup_latest_start_hour', true), '')::int;
  IF v_hour_cfg IS NOT NULL THEN
    c_latest_hour := GREATEST(0, LEAST(v_hour_cfg, 24));
  END IF;
  IF NOT v_ignore_win
     AND EXTRACT(hour FROM (clock_timestamp() AT TIME ZONE 'UTC')) >= c_latest_hour THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object(
              'regime', 'bulk',
              'skip_reason', format(
                'start window closed — %s UTC is at or past the %s:00 cutoff; a firing queued behind an overrunning run must not open a second window into active hours',
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'HH24:MI'), c_latest_hour),
              'latest_start_hour', c_latest_hour,
              'source', 'pg_cron'));
    RAISE NOTICE '[donor-rollup bulk] start window closed (cutoff %:00 UTC) — skipping', c_latest_hour;
    RETURN;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('regime', 'bulk', 'source', 'pg_cron', 'skip_reason',
              'advisory lock held by a concurrent donor-rollup refresh (incremental or bulk)'));
    RAISE NOTICE '[donor-rollup bulk] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (c_pipeline, 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-rollup bulk] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '256MB';

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_budget_seconds', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    c_budget := make_interval(secs => v_cfg);
  END IF;

  v_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunks', true), '')::int;
  IF COALESCE(v_cfg, 0) > 0 THEN
    IF v_cfg NOT IN (16, 32, 64, 128, 256) THEN
      PERFORM pg_advisory_unlock(c_lock_key);
      RAISE EXCEPTION 'civitics.donor_rollup_bulk_chunks must be one of 16/32/64/128/256 (got %)', v_cfg;
    END IF;
    c_chunks := v_cfg;
  END IF;
  v_step := 256 / c_chunks;

  v_cfg_txt := NULLIF(current_setting('civitics.donor_rollup_bulk_mode', true), '');
  v_mode := COALESCE(v_cfg_txt, 'dirty');
  IF v_mode NOT IN ('dirty', 'full') THEN
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE EXCEPTION 'civitics.donor_rollup_bulk_mode must be ''dirty'' or ''full'' (got %)', v_mode;
  END IF;

  v_seed_cfg := NULLIF(current_setting('civitics.donor_rollup_bulk_chunk_seed_seconds', true), '')::double precision;
  IF COALESCE(v_seed_cfg, 0) > 0 THEN
    c_seed_chunk := v_seed_cfg;
  END IF;

  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;
  v_cursor    := COALESCE((v_state->>'chunk_cursor')::int, -1);

  -- FIX-973 — arm the guard from chunk 0. `v_max_chunk` stays a pure
  -- MEASUREMENT (it is what gets logged and persisted); the guard consults
  -- v_seed_ref instead, until this run has actually completed a chunk.
  --
  -- The 0.75 cap is what keeps the seed from becoming a wedge: 1.25 x 0.75 is
  -- under 1, so a run that arrives at the loop having spent none of its budget
  -- CANNOT be refused by the seed alone, however bad the previous sweep's worst
  -- chunk was. What the seed CAN refuse is a run that reaches the loop having
  -- already burned the budget in the pre-loop staging build — the FIX-1018
  -- shape, and the only case a chunk-0 guard exists for.
  v_prev_slow := COALESCE((v_state->>'slowest_chunk_seconds')::int, 0);
  v_seed_ref  := LEAST(
    GREATEST(v_prev_slow::double precision, c_seed_chunk),
    EXTRACT(epoch FROM c_budget) * 0.75);
  v_sweep_beg := (v_state->>'sweep_started_at')::timestamptz;
  v_sweep_tgt := (v_state->>'sweep_target')::timestamptz;

  IF v_cursor >= 0 THEN
    v_resumed := true;
    IF (v_state->>'mode') IS DISTINCT FROM v_mode THEN
      v_restarted := format('mode changed %s -> %s', v_state->>'mode', v_mode);
    ELSIF COALESCE((v_state->>'chunks')::int, -1) <> c_chunks THEN
      v_restarted := format('chunk count changed %s -> %s', v_state->>'chunks', c_chunks);
    ELSIF v_sweep_beg IS NULL OR clock_timestamp() - v_sweep_beg > c_max_sweep THEN
      v_restarted := format('sweep started %s exceeds the %s staleness bound', v_sweep_beg, c_max_sweep);
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_targets LIMIT 1) THEN
      v_restarted := 'target staging empty (crash recovery truncates UNLOGGED tables)';
    ELSIF NOT EXISTS (SELECT 1 FROM public._drb_fe LIMIT 1) THEN
      v_restarted := 'donor-dimension staging empty (crash recovery truncates UNLOGGED tables)';
    END IF;
    IF v_restarted IS NOT NULL THEN
      RAISE NOTICE '[donor-rollup bulk] discarding in-flight sweep: %', v_restarted;
      v_cursor  := -1;
      v_resumed := false;
    END IF;
  END IF;

  IF v_cursor < 0 THEN
    SELECT MAX(fr.updated_at) INTO v_sweep_tgt
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');

    SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_rollup_watermark';

    -- FIX-983 — the head-lag horizon, then the never-go-backwards floor.
    v_horizon   := public.fr_watermark_horizon();
    v_sweep_tgt := LEAST(COALESCE(v_sweep_tgt, v_horizon), v_horizon);

    -- Caught-up refusal (FIX-973; invariant (c) as an EXIT rather than a
    -- no-op sweep). The GREATEST clamp below still guarantees the watermark
    -- can never move backwards, but on the SCHEDULED path a caught-up firing
    -- must not pay for the staging build to discover it has nothing to do:
    -- `_drb_fe` is a full pass over financial_entities (5.2M rows / 1.9 GB
    -- heap on prod today) joined to entity_tags, and jobid 24 fires twice a
    -- day. The per-recipient path exits a caught-up run in ~0.1 s; this makes
    -- the bulk path do the same.
    -- Logged 'complete', not 'skipped' — FIX-1140: freshness counts ONLY
    -- status='complete', so a caught-up run that logs 'skipped' freezes the
    -- clock and the canary pages on a pipeline that is working perfectly.
    IF v_watermark IS NOT NULL AND v_sweep_tgt <= v_watermark THEN
      INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
      VALUES (c_pipeline, 'complete', v_started, clock_timestamp(),
              jsonb_build_object(
                'regime', 'bulk', 'mode', v_mode, 'chunks', c_chunks,
                'source', 'pg_cron', 'resumed', false,
                'targets', 0, 'target_officials', 0, 'recipients_done', 0,
                'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                'skip_reason', format('caught up at the FIX-983 horizon — %s is at or before the watermark %s',
                                      v_sweep_tgt, v_watermark),
                'horizon', v_sweep_tgt, 'watermark', v_watermark));
      RAISE NOTICE '[donor-rollup bulk] caught up at the horizon (% <= %) — nothing to do', v_sweep_tgt, v_watermark;
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;

    v_sweep_tgt := GREATEST(v_sweep_tgt, v_watermark);

    -- FIX-974 follow-up: assert the from_type invariant BEFORE anything is
    -- written, so a violating sweep publishes nothing at all. Placed after the
    -- caught-up exit above, because a run that writes nothing needs no guard
    -- and the assert anti-joins all six arms.
    PERFORM public.donor_rollup_bulk_assert_invariants();

    TRUNCATE public._drb_targets;
    IF v_mode = 'full' OR v_watermark IS NULL THEN
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    ELSE
      INSERT INTO public._drb_targets (to_id, is_official)
      SELECT d.to_id, (o.id IS NOT NULL)
      FROM (
        SELECT DISTINCT fr.to_id
        FROM public.financial_relationships fr
        WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
          AND fr.from_type = 'financial_entity'
          AND fr.to_type = 'official'                                 -- FIX-1018
          AND fr.updated_at >  v_watermark
          AND fr.updated_at <= v_sweep_tgt                             -- FIX-983
      ) d
      LEFT JOIN public.officials o ON o.id = d.to_id;
    END IF;

    TRUNCATE public._drb_fe;
    INSERT INTO public._drb_fe (id, display_name, entity_type, state, industry_tag, industry_label)
    SELECT fe.id, fe.display_name, fe.entity_type, fe.metadata->>'state',
           t.tag, t.display_label
    FROM public.financial_entities fe
    LEFT JOIN (
      -- FIX-918: the donor's primary industry, from its one home.
      SELECT pit.entity_id, pit.tag, pit.display_label
      FROM public.primary_industry_tag(NULL) pit
    ) t ON t.entity_id = fe.id;

    ANALYZE public._drb_targets;
    ANALYZE public._drb_fe;

    v_sweep_beg := clock_timestamp();   -- FIX-981: the instant, not the txn start
    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_state_key, jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks,
              'slowest_chunk_seconds', v_prev_slow))
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object(
              'chunk_cursor', -1, 'sweep_started_at', v_sweep_beg::text,
              'sweep_target', v_sweep_tgt::text, 'mode', v_mode, 'chunks', c_chunks,
              'slowest_chunk_seconds', v_prev_slow),
          updated_at = clock_timestamp();
  END IF;

  SELECT count(*), count(*) FILTER (WHERE is_official) INTO v_n_targets, v_n_offic
  FROM public._drb_targets;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (c_pipeline, 'running', v_started,
          jsonb_build_object(
            'regime', 'bulk', 'source', 'pg_cron',
            'shape', 'to_id-range chunks, one FR scan per chunk, six arms derived',
            'mode', v_mode, 'chunks', c_chunks,
            'targets', v_n_targets, 'target_officials', v_n_offic,
            'resumed', v_resumed, 'resume_cursor', v_cursor,
            'restarted_reason', v_restarted,
            'sweep_target', v_sweep_tgt,
            'budget_seconds', EXTRACT(epoch FROM c_budget)))
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR k IN (v_cursor + 1) .. (c_chunks - 1) LOOP
    v_elapsed := EXTRACT(epoch FROM (clock_timestamp() - v_started));
    -- Before any chunk has completed THIS run, size on the seed; after that, on
    -- what this run has actually measured.
    v_guard_ref := CASE WHEN v_done > 0 THEN v_max_chunk ELSE v_seed_ref END;
    IF v_guard_ref > 0
       AND v_elapsed + (v_guard_ref * 1.25) > EXTRACT(epoch FROM c_budget) THEN
      v_budget_hit := true;
      RAISE NOTICE '[donor-rollup bulk] budget guard — stopping before chunk % (elapsed %s, reference %s, sized from %)',
        k, round(v_elapsed)::int, round(v_guard_ref)::int,
        CASE WHEN v_done > 0 THEN 'this run' ELSE 'seed' END;
      EXIT;
    END IF;

    v_lo := (lpad(to_hex(k * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid;
    v_hi := CASE WHEN k < c_chunks - 1
                 THEN (lpad(to_hex((k + 1) * v_step), 2, '0') || '000000-0000-0000-0000-000000000000')::uuid
                 ELSE NULL END;
    v_chunk_beg := clock_timestamp();

    BEGIN
      TRUNCATE public._drb_donor;
      INSERT INTO public._drb_donor
        (to_id, relationship_type, from_id, total_cents, total_cents0, tx_count,
         small_cents, small_count, pos_cents, pos_count)
      SELECT
        fr.to_id,
        fr.relationship_type::text,
        fr.from_id,
        SUM(fr.amount_cents)::bigint,
        SUM(COALESCE(fr.amount_cents, 0))::bigint,
        COUNT(*)::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0 AND fr.amount_cents < 50000))::bigint,
        COALESCE(SUM(fr.amount_cents) FILTER (WHERE fr.amount_cents > 0), 0)::bigint,
        (COUNT(*)                     FILTER (WHERE fr.amount_cents > 0))::bigint
      FROM public.financial_relationships fr
      JOIN public._drb_targets t ON t.to_id = fr.to_id
      WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
        AND fr.to_id >= v_lo
        AND (v_hi IS NULL OR fr.to_id < v_hi)
      GROUP BY fr.to_id, fr.relationship_type, fr.from_id;

      TRUNCATE public._drb_chunk_fe;
      INSERT INTO public._drb_chunk_fe (id, display_name, entity_type, state, industry_tag, industry_label)
      SELECT f.id, f.display_name, f.entity_type, f.state, f.industry_tag, f.industry_label
      FROM public._drb_fe f
      WHERE f.id IN (SELECT DISTINCT d.from_id FROM public._drb_donor d);

      ANALYZE public._drb_donor;
      ANALYZE public._drb_chunk_fe;

      DELETE FROM public.official_donor_rollup_mv m
       WHERE m.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH ranked AS (
        SELECT d.to_id AS official_id, d.relationship_type, d.from_id AS donor_id,
               d.total_cents, d.tx_count,
               ROW_NUMBER() OVER (PARTITION BY d.to_id, d.relationship_type
                                  ORDER BY d.total_cents DESC, d.from_id) AS rn
        FROM public._drb_donor d
      ),
      top_rows AS (
        SELECT r.official_id, r.relationship_type, r.rn::int AS rank, r.donor_id,
               fe.display_name, fe.entity_type, fe.industry_tag, fe.industry_label,
               r.total_cents, r.tx_count, NULL::bigint AS tail_donor_count
        FROM ranked r
        LEFT JOIN public._drb_chunk_fe fe ON fe.id = r.donor_id
        WHERE r.rn <= 200
      ),
      tail_rows AS (
        SELECT r.official_id, r.relationship_type, 201 AS rank, NULL::uuid, NULL::text,
               NULL::text, NULL::text, NULL::text,
               SUM(r.total_cents)::bigint, SUM(r.tx_count)::bigint, COUNT(*)::bigint
        FROM ranked r WHERE r.rn > 200
        GROUP BY r.official_id, r.relationship_type
      ),
      ins AS (
        INSERT INTO public.official_donor_rollup_mv (
          official_id, relationship_type, rank, donor_id, donor_name, entity_type,
          industry_tag, industry_label, total_cents, tx_count, tail_donor_count)
        SELECT * FROM top_rows UNION ALL SELECT * FROM tail_rows
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_n FROM ins;
      v_rows := v_rows + v_n;

      DELETE FROM public.official_donor_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_donor_totals
        (official_id, total_cents, pac_cents, individual_cents, donor_count, updated_at)
      SELECT d.to_id,
             SUM(d.total_cents0)::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type IN ('pac','super_pac')))::bigint,
             (SUM(d.total_cents0) FILTER (WHERE fe.entity_type = 'individual'))::bigint,
             SUM(d.tx_count)::bigint,
             -- FIX-981: was the column DEFAULT now(), i.e. the START of this
             -- chunk's transaction, N COMMITs into the sweep.
             clock_timestamp()
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_small_dollar_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_small_dollar_rollup
        (official_id, small_dollar_cents, small_dollar_count, updated_at)
      SELECT d.to_id, SUM(d.small_cents)::bigint, SUM(d.small_count)::bigint, clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      WHERE d.relationship_type = 'donation'
      GROUP BY d.to_id;

      DELETE FROM public.official_sector_affinity_rollup x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      INSERT INTO public.official_sector_affinity_rollup
        (official_id, industry, total_cents, donor_count, updated_at)
      SELECT d.to_id,
             COALESCE(fe.industry_tag, 'Untagged'),
             SUM(d.pos_cents)::bigint,
             COUNT(*)::bigint,
             clock_timestamp()   -- FIX-981
      FROM public._drb_donor d
      JOIN public._drb_targets t ON t.to_id = d.to_id AND t.is_official
      LEFT JOIN public._drb_chunk_fe fe ON fe.id = d.from_id
      WHERE d.relationship_type = 'donation'
        AND d.pos_cents > 0
      GROUP BY d.to_id, COALESCE(fe.industry_tag, 'Untagged');

      DELETE FROM public.treemap_individuals_rollup x
       WHERE x.scope_id <> c_global
         AND x.scope_id IN (
           SELECT t.to_id FROM public._drb_targets t
            WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH per_name AS (
        SELECT d.to_id AS scope_id,
               COALESCE(fe.state, '??') AS state,
               fe.display_name          AS donor_name,
               SUM(d.pos_cents)::bigint AS total_cents,
               SUM(d.pos_count)::bigint AS donation_count
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
        GROUP BY d.to_id, COALESCE(fe.state, '??'), fe.display_name
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY scope_id, state
                                     ORDER BY total_cents DESC, donor_name) AS rank
        FROM per_name
      )
      INSERT INTO public.treemap_individuals_rollup
        (scope_id, state, rank, donor_name, total_cents, donation_count)
      SELECT scope_id, state, rank::int, donor_name, total_cents, donation_count
      FROM ranked WHERE rank <= 50;

      DELETE FROM public.official_donor_bracket_totals x
       WHERE x.official_id IN (
         SELECT t.to_id FROM public._drb_targets t
          WHERE t.is_official AND t.to_id >= v_lo AND (v_hi IS NULL OR t.to_id < v_hi));

      WITH bucketed AS (
        SELECT d.to_id AS official_id, d.pos_cents AS donor_cents,
               CASE WHEN d.pos_cents >= 1000000 THEN 'mega'
                    WHEN d.pos_cents >=  250000 THEN 'major'
                    WHEN d.pos_cents >=   50000 THEN 'mid'
                    ELSE                              'small' END AS tier
        FROM public._drb_donor d
        JOIN public._drb_targets t   ON t.to_id = d.to_id AND t.is_official
        JOIN public._drb_chunk_fe fe ON fe.id = d.from_id AND fe.entity_type = 'individual'
        WHERE d.relationship_type = 'donation'
          AND d.pos_cents > 0
      )
      INSERT INTO public.official_donor_bracket_totals (official_id, tier, total_cents, donor_count)
      SELECT official_id, tier, SUM(donor_cents)::bigint, COUNT(*)::bigint
      FROM bucketed GROUP BY official_id, tier;

      UPDATE public.pipeline_state
         SET value = value || jsonb_build_object(
                       'chunk_cursor', k,
                       'slowest_chunk_seconds', GREATEST(round(v_max_chunk)::int, v_prev_slow)),
             updated_at = clock_timestamp()
       WHERE key = c_state_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pipeline_state row % vanished mid-sweep', c_state_key;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. The cursor is written INSIDE this chunk's
    -- transaction, so a cancelled chunk rolls back together with its cursor
    -- advance and the next CALL resumes at exactly k.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % CANCELED (statement_timeout or operator cancel): %', k, SQLERRM;
    WHEN OTHERS THEN
      v_failed := format('chunk %s [%s..%s): %s', k, v_lo, COALESCE(v_hi::text, 'end'), SQLERRM);
      RAISE WARNING '[donor-rollup bulk] chunk % FAILED: %', k, SQLERRM;
    END;

    EXIT WHEN v_canceled IS NOT NULL;
    EXIT WHEN v_failed IS NOT NULL;

    COMMIT;

    v_done := v_done + 1;
    v_chunk_secs := EXTRACT(epoch FROM (clock_timestamp() - v_chunk_beg));
    IF v_chunk_secs > v_max_chunk THEN v_max_chunk := v_chunk_secs; END IF;
    RAISE NOTICE '[donor-rollup bulk] chunk %/% done (%s, % arm-1 rows so far)',
      k + 1, c_chunks, round(v_chunk_secs)::int, v_rows;
  END LOOP;

  -- FIX-1028 — cancelled is PARTIAL and RESUMABLE. The bulk path's watermark
  -- write is at the very end and stays there (this is the manual, re-runnable
  -- path — a re-CALL resumes from the committed cursor), but the ROW now closes
  -- itself instead of sitting 'running' until the reaper.
  -- FIX-973 — check_rollup_freshness now derives sweep_in_progress/sweep_cursor
  -- from THIS pipeline's own last row (it used to hard-wire a read of
  -- pipeline_state.donor_rollup_watermark, which the bulk regime never writes
  -- a cursor into). `resumable` + `resume_at_chunk` are that contract.
  SELECT COALESCE((value->>'chunk_cursor')::int + 1, 0) INTO v_resume_at
  FROM public.pipeline_state WHERE key = c_state_key;
  v_resume_at := COALESCE(v_resume_at, 0);

  IF v_canceled IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = left(format('canceled — %s; resumable at chunk %s of %s', v_canceled,
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks), 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'canceled', true, 'cancel_detail', v_canceled,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE WARNING '[donor-rollup bulk] CANCELED — partial, resumable; re-CALL to continue';
    RETURN;
  END IF;

  IF v_failed IS NOT NULL THEN
    UPDATE public.data_sync_log
       SET status = 'failed', completed_at = clock_timestamp(), error_message = left(v_failed, 1000),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  IF v_budget_hit THEN
    UPDATE public.data_sync_log
       SET status = 'partial', completed_at = clock_timestamp(), rows_inserted = v_rows,
           error_message = format('budget exhausted — resumable at chunk %s of %s',
             COALESCE((SELECT (value->>'chunk_cursor')::int + 1
                       FROM public.pipeline_state WHERE key = c_state_key), 0), c_chunks),
           metadata = metadata || jsonb_build_object(
             'resumable', true, 'chunks_done_this_run', v_done,
             'resume_at_chunk', v_resume_at,
             'slowest_chunk_seconds', round(v_max_chunk)::int,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;
    COMMIT;
    PERFORM pg_advisory_unlock(c_lock_key);
    RAISE NOTICE '[donor-rollup bulk] PARTIAL — resumable; re-CALL to continue';
    RETURN;
  END IF;

  INSERT INTO public.pipeline_state (key, value)
  VALUES ('donor_rollup_watermark',
          jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text))
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('last_indexed_at', COALESCE(v_sweep_tgt, public.fr_watermark_horizon())::text),
        updated_at = clock_timestamp();

  UPDATE public.pipeline_state
     SET value = jsonb_build_object('last_completed_at', clock_timestamp()::text,   -- FIX-981
                                    'mode', v_mode, 'chunks', c_chunks,
                                    'targets', v_n_targets,
                                    -- FIX-973: seeds the NEXT run's chunk-0 guard.
                                    'slowest_chunk_seconds', GREATEST(round(v_max_chunk)::int, v_prev_slow)),
         updated_at = clock_timestamp()
   WHERE key = c_state_key;

  TRUNCATE public._drb_donor;
  TRUNCATE public._drb_chunk_fe;

  UPDATE public.data_sync_log
     SET status = 'complete', completed_at = clock_timestamp(), rows_inserted = v_rows,
         metadata = metadata || jsonb_build_object(
           'chunks_done_this_run', v_done,
           'recipients_done', v_n_offic,
           'slowest_chunk_seconds', round(v_max_chunk)::int,
           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
           'watermark_advanced_to', v_sweep_tgt)
   WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup bulk] complete — % targets, % arm-1 rows', v_n_targets, v_rows;
  COMMIT;
  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

-- donor_rollup_rebuild_recipients: ind CTE → primary_industry_tag(top-200 donor ids)
CREATE OR REPLACE FUNCTION public.donor_rollup_rebuild_recipients(p_recipients uuid[])
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
    -- FIX-918: the donor's primary industry, from its one home.
    SELECT pit.entity_id,
           pit.tag           AS industry_tag,
           pit.display_label AS industry_label
    FROM public.primary_industry_tag(
           ARRAY(SELECT r.donor_id FROM ranked r WHERE r.rn <= 200)) pit
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

  -- FIX-836: exact per-official donation summary (feeds get_official_donor_rollup()).
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

  -- FIX-776: per-official small-dollar summary (feeds /api/graph/small-dollar).
  PERFORM public.small_dollar_rebuild_officials(p_recipients);

  -- FIX-777: per-(official, industry) sector-affinity summary (feeds /api/graph/sector-affinity).
  PERFORM public.sector_affinity_rebuild_officials(p_recipients);

  -- FIX-779: focused individual-donor treemap (top-50/state) (feeds
  -- /api/graph/treemap-individuals focused mode).
  PERFORM public.treemap_individuals_rebuild_officials(p_recipients);

  -- FIX-868: per-(official, tier) individual-donor bracket totals (feeds the
  -- /api/graph/treemap "Individual donors" bracket cells). Additive; own DELETE+INSERT.
  PERFORM public.treemap_individual_brackets_rebuild_officials(p_recipients);

  RETURN v_count;
END;
$function$;

-- refresh_donor_party_rollup_incremental: windowed ind CTE → primary_industry_tag(the window's tagged ids)
CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('donor_party_rollup_refresh')::bigint;
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  -- FIX-1212 — the full-rebuild cursor, and the age past which it is discarded.
  c_cursor_key     text     := 'donor_party_full_rebuild';
  -- FIX-1216 — 3 weekly firings + 1 d of slack. started_at is the FIRST
  -- firing's, so at 7 d the second firing always found the cursor a few ms
  -- past the bound and discarded it; weekly firings never reached 16/16.
  c_cycle_max_age  interval := interval '22 days';
  v_cfg        jsonb;
  v_budget     interval;
  v_max_units  int;
  v_full_lag   interval;
  v_log_id     uuid;
  v_watermark  timestamptz;
  v_target     timestamptz;
  v_lag        interval;
  v_mode       text;
  v_i          int;
  v_lo         uuid;
  v_hi         uuid;
  v_rows       bigint := 0;
  v_n          bigint;
  v_units      int     := 0;
  v_donors     bigint  := 0;
  v_capped     boolean := false;
  v_caught_up  boolean := false;
  v_failures   text[]  := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text    := NULL;
  -- FIX-979 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
  v_res        jsonb;
  i            int;
  -- FIX-1212 — the windowed full rebuild.
  v_cursor         jsonb;
  v_discarded      jsonb   := NULL;
  v_resumed        boolean := false;
  v_cycle_started  timestamptz;
  v_cycle_target   timestamptz;
  v_done           int[]   := ARRAY[]::int[];
  v_win_run        int[]   := ARRAY[]::int[];
  v_stage_s        numeric[] := ARRAY[]::numeric[];
  v_apply_s        numeric[] := ARRAY[]::numeric[];
  v_max_unit       interval := interval '0';
  v_t0             timestamptz;
  v_t1             timestamptz;
  v_fr_w           text;
  v_et_w           text;
  v_fe_w           text;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent donor-party-rollup refresh',
                               'source', 'pg_cron'));
    RAISE NOTICE '[donor-party-rollup] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-party-rollup] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Plain SET (not SET LOCAL) survives the per-unit COMMITs. NOTE (FIX-703,
  -- FIX-1185): the CALL's statement bound is the postgres role default (3 h)
  -- armed at CALL start — nothing in this body can change it. The budget guard
  -- below and the FIX-1063 watchdog are the real stops.
  SET work_mem = '256MB';
  -- FIX-1212 — FIX-1123's remedy: no parallel workers, so one window's memory is
  -- one backend's memory, not (1 + workers) copies of it.
  SET max_parallel_workers_per_gather = 0;

  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  v_cfg       := COALESCE(v_cfg, '{}'::jsonb);
  v_budget    := make_interval(secs => GREATEST(
                   COALESCE((v_cfg->>'unit_budget_seconds')::numeric, 1500), 60));
  v_max_units := GREATEST(COALESCE((v_cfg->>'max_units')::int, 40), 1);
  v_full_lag  := make_interval(days => GREATEST(
                   COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));

  -- ── the mode decision, O(1) ──────────────────────────────────────────────
  -- Two index probes and a subtraction. The old body materialised
  -- array_agg(DISTINCT from_id) over the whole backlog — 3.3M uuids on
  -- 2026-09-02 — purely to compare its length against a threshold, then
  -- discarded it. That array build IS the 1,814 s that the watchdog killed on
  -- 2026-09-01. It is gone.
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_watermark
    FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';

  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;

  -- FIX-983 — the head-lag horizon. Bounds the lag that picks the mode AND the
  -- watermark the full path writes below.
  v_target := LEAST(v_target, public.fr_watermark_horizon());

  v_lag  := CASE WHEN v_watermark IS NULL OR v_target IS NULL
                 THEN NULL ELSE v_target - v_watermark END;

  -- FIX-1212 — a full rebuild in progress wins the decision. A cursor younger
  -- than c_cycle_max_age is resumed whatever the lag is now; an older (or
  -- malformed) one is discarded and the mode decided afresh.
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;
  IF v_cursor IS NOT NULL THEN
    IF v_cursor->>'mode' IN ('bootstrap', 'full')
       AND (v_cursor->>'started_at')::timestamptz > clock_timestamp() - c_cycle_max_age
       AND v_cursor->>'target' IS NOT NULL THEN
      v_resumed       := true;
      v_mode          := v_cursor->>'mode';
      v_cycle_started := (v_cursor->>'started_at')::timestamptz;
      v_cycle_target  := (v_cursor->>'target')::timestamptz;
      SELECT COALESCE(array_agg(DISTINCT x::int ORDER BY x::int), ARRAY[]::int[])
        INTO v_done
        FROM jsonb_array_elements_text(COALESCE(v_cursor->'windows_done', '[]'::jsonb)) x;
    ELSE
      v_discarded := v_cursor;
    END IF;
  END IF;

  IF NOT v_resumed THEN
    v_mode := CASE
                WHEN v_watermark IS NULL     THEN 'bootstrap'
                WHEN v_lag > v_full_lag      THEN 'full'
                ELSE                              'crawl'
              END;
    IF v_mode IN ('bootstrap', 'full') THEN
      -- A new cycle. Its target is fixed HERE, before window 1 reads anything.
      v_cycle_started := v_started;
      v_cycle_target  := COALESCE(v_target, public.fr_watermark_horizon());   -- FIX-983
    END IF;
  END IF;

  IF v_discarded IS NOT NULL THEN
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
    RAISE WARNING '[donor-party-rollup] discarded a stale full-rebuild cursor (started %, % window(s) done)',
      v_discarded->>'started_at', jsonb_array_length(COALESCE(v_discarded->'windows_done', '[]'::jsonb));
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_refresh', 'running', v_started,
          jsonb_strip_nulls(jsonb_build_object(
                             'mode', v_mode, 'source', 'pg_cron',
                             'watermark_before', v_watermark,
                             'lag', v_lag::text,
                             'full_rebuild_lag', v_full_lag::text,
                             'max_units', v_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int,
                             'resumed', CASE WHEN v_mode IN ('bootstrap', 'full') THEN v_resumed END,
                             'cycle_started_at', v_cycle_started,
                             'cycle_target', v_cycle_target,
                             'windows_done_before', CASE WHEN v_mode IN ('bootstrap', 'full')
                                                         THEN to_jsonb(v_done) END,
                             'cursor_discarded', v_discarded)))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the first unit's txn short

  IF v_mode IN ('bootstrap', 'full') THEN
    -- ═══ Windowed full rebuild (FIX-1212) ═══════════════════════════════════
    -- Sixteen donor-id windows. Each is ONE bounded unit: stage the window's
    -- aggregate, replace the window in donor_party_rollup_mv, record it in the
    -- cursor, COMMIT. The GROUP BY and both joins are bounded to the window, so
    -- the peak is ~1/16 of the whole-table stage's (clone: 30.7 MB + 19.2 MB
    -- against 434 MB + 306 MB). A cap or a cancel banks every window already
    -- committed; the next CALL or firing resumes at the first window not done.
    --
    -- Cost is NOT independent of the lag's consequences (FIX-1112's header said
    -- it was: "~350-420 s on prod regardless"). It scales with
    -- financial_relationships and financial_entities — 21,628.6 s on 2026-08-04
    -- and 11,278 s on 2026-09-22 as one statement. What the windows buy is that
    -- no single statement has to be the whole of it.
    FOR i IN 1..16 LOOP
      CONTINUE WHEN i = ANY (v_done);

      IF v_units >= v_max_units THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] UNIT CAP (%) reached before window %/16; stopping cleanly', v_max_units, i;
        EXIT;
      END IF;
      -- Project the next window from the longest one this call has run, so the
      -- CALL stops AT its budget rather than one window past it. The first
      -- window of a call always runs (v_max_unit is 0), which is what
      -- guarantees progress.
      IF (clock_timestamp() - v_started) + v_max_unit >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] BUDGET: % elapsed + % longest window >= %; stopping before window %/16',
          clock_timestamp() - v_started, v_max_unit, v_budget, i;
        EXIT;
      END IF;

      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      -- Literal bounds, so each window is planned against its real range.
      v_fr_w := format('fr.from_id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND fr.from_id < %L::uuid', v_hi) END;
      v_et_w := format('et.entity_id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND et.entity_id < %L::uuid', v_hi) END;
      v_fe_w := format('fe.id >= %L::uuid', v_lo)
             || CASE WHEN v_hi IS NULL THEN '' ELSE format(' AND fe.id < %L::uuid', v_hi) END;

      BEGIN
        v_t0 := clock_timestamp();
        DROP TABLE IF EXISTS dpr_stage_w;
        EXECUTE format($stage$
          CREATE TEMP TABLE dpr_stage_w AS
          WITH agg AS MATERIALIZED (
            SELECT
              fr.from_id                          AS donor_id,
              COALESCE(o.party::text, 'unknown')  AS party_key,
              SUM(fr.amount_cents)::bigint        AS total_cents,
              COUNT(*)::bigint                    AS tx_count
            FROM public.financial_relationships fr
            JOIN public.officials o
              ON o.id = fr.to_id AND fr.to_type = 'official'
            WHERE fr.relationship_type = 'donation'
              AND fr.from_type = 'financial_entity'
              AND %1$s
            GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
          ),
          ind AS (
            -- FIX-918: the donor's primary industry, from its one home, for
            -- this window's tagged donors.
            SELECT pit.entity_id,
                   pit.tag           AS industry_tag,
                   pit.display_label AS industry_label
            FROM public.primary_industry_tag(ARRAY(
                   SELECT et.entity_id
                   FROM public.entity_tags et
                   WHERE et.entity_type  = 'financial_entity'
                     AND et.tag_category = 'industry'
                     AND %2$s)) pit
          )
          SELECT
            a.donor_id, a.party_key, fe.display_name AS donor_name,
            fe.entity_type, ind.industry_tag, ind.industry_label,
            a.total_cents, a.tx_count
          FROM agg a
          LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id AND %3$s
          LEFT JOIN ind                          ON ind.entity_id = a.donor_id
        $stage$, v_fr_w, v_et_w, v_fe_w);
        v_t1 := clock_timestamp();

        DELETE FROM public.donor_party_rollup_mv
         WHERE donor_id >= v_lo AND (v_hi IS NULL OR donor_id < v_hi);
        INSERT INTO public.donor_party_rollup_mv (
          donor_id, party_key, donor_name, entity_type, industry_tag,
          industry_label, total_cents, tx_count
        )
        SELECT donor_id, party_key, donor_name, entity_type, industry_tag,
               industry_label, total_cents, tx_count
        FROM dpr_stage_w;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        DROP TABLE dpr_stage_w;

        -- The cursor rides the SAME transaction as the window's rows: it can
        -- never name a window whose apply rolled back.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
                  'mode',         v_mode,
                  'started_at',   v_cycle_started,
                  'target',       v_cycle_target,
                  'windows_done', to_jsonb(v_done || i)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = clock_timestamp();

        -- Locals last: a PL/pgSQL variable is NOT rolled back with the
        -- subtransaction, so nothing that can still raise may follow these.
        v_done     := v_done || i;
        v_win_run  := v_win_run || i;
        v_stage_s  := v_stage_s || round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 2);
        v_apply_s  := v_apply_s || round(EXTRACT(epoch FROM (clock_timestamp() - v_t1))::numeric, 2);
        v_max_unit := GREATEST(v_max_unit, clock_timestamp() - v_t0);
        v_rows     := v_rows + v_n;
        v_units    := v_units + 1;
        RAISE NOTICE '  [donor-party-rollup] window %/16 — stage % s, apply % s, % rows (% of 16 done)',
          i, v_stage_s[array_length(v_stage_s, 1)], v_apply_s[array_length(v_apply_s, 1)],
          v_n, array_length(v_done, 1);
      EXCEPTION
      -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
      WHEN query_canceled THEN
        v_canceled := format('window %s: %s', i, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] window %/16 CANCELED (rolled back whole — cursor unmoved): %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('window %s: %s', i, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;  -- top level, outside the EXCEPTION subtransaction
      -- FIX-1028 — the box has just proven it cannot finish one window; the
      -- remaining ones would each re-arm the same axe.
      EXIT WHEN v_canceled IS NOT NULL;
    END LOOP;

    DROP TABLE IF EXISTS dpr_stage_w;
    COMMIT;

    -- All sixteen banked (across however many calls): the cycle recomputed
    -- EVERY donor, so the watermark jumps to the target fixed before window 1
    -- read. FR writes stamped after it are re-processed by the next crawl,
    -- never silently consumed. The cursor goes in the same transaction.
    IF (SELECT count(DISTINCT x) FROM unnest(v_done) x) = 16 THEN
      IF v_watermark IS NULL OR v_cycle_target > v_watermark THEN
        INSERT INTO public.pipeline_state (key, value)
        VALUES ('donor_party_rollup_watermark',
                jsonb_build_object('last_indexed_at', v_cycle_target::text))   -- FIX-983
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = clock_timestamp();
      ELSE
        -- Something advanced the watermark past this cycle's target mid-cycle.
        -- Writing the target would move it BACKWARDS (the FIX-983 rule).
        RAISE WARNING '  [donor-party-rollup] watermark % is already past cycle target %; left alone',
          v_watermark, v_cycle_target;
      END IF;
      DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
      v_caught_up := true;
      COMMIT;
    END IF;

  ELSE
    -- ═══ CRAWL PATH — the normal one ═══════════════════════════════════════
    WHILE v_units < v_max_units LOOP
      IF clock_timestamp() - v_started >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [donor-party-rollup] BUDGET EXHAUSTED before slice %; stopping cleanly', v_units + 1;
        EXIT;
      END IF;

      v_res := NULL;
      BEGIN
        v_res    := public.refresh_donor_party_rollup_slice();
        v_rows   := v_rows   + COALESCE((v_res->>'rows_written')::bigint, 0);
        v_donors := v_donors + COALESCE((v_res->>'donors')::bigint, 0);
      EXCEPTION
      -- FIX-1028 — by name. The slice is atomic, so a cancel here has already
      -- rolled back BOTH its rows and its watermark advance. Nothing is
      -- stranded and nothing is skipped; the next firing retries the same
      -- slice. That is the whole point of FIX-1112.
      WHEN query_canceled THEN
        v_canceled := format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % CANCELED (rolled back whole — watermark unmoved): %',
          v_units + 1, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [donor-party-rollup] slice % FAILED: %', v_units + 1, SQLERRM;
      END;
      COMMIT;

      IF v_res IS NOT NULL AND COALESCE((v_res->>'bootstrap_required')::boolean, false) THEN
        RAISE WARNING '  [donor-party-rollup] watermark vanished mid-run — bootstrap required; stopping';
        EXIT;
      END IF;

      EXIT WHEN v_canceled IS NOT NULL;
      EXIT WHEN COALESCE(array_length(v_failures, 1), 0) > 0;

      v_units := v_units + 1;

      IF v_res IS NOT NULL THEN
        RAISE NOTICE '  [donor-party-rollup] slice -> % — % donors, % rows',
          v_res->>'watermark', v_res->>'donors', v_res->>'rows_written';
        IF COALESCE((v_res->>'caught_up')::boolean, false) THEN
          v_caught_up := true;
          RAISE NOTICE '  [donor-party-rollup] CAUGHT UP — watermark is at the newest FR write';
          EXIT;
        END IF;
      END IF;
    END LOOP;

    IF v_units >= v_max_units AND NOT v_caught_up AND v_canceled IS NULL
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      v_capped := true;
    END IF;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        WHEN v_capped                        THEN 'partial'
                        ELSE 'complete'
                      END,
      -- FIX-979/981: clock_timestamp(), not now() — this transaction began
      -- after the last unit's COMMIT.
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; every COMMITTED %s kept its progress, the next firing resumes from it',
                                 v_canceled,
                                 CASE WHEN v_mode IN ('bootstrap', 'full') THEN 'window' ELSE 'slice' END), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_capped
                          THEN left(format('%s — %s unit(s) run, resumable',
                                 CASE WHEN v_units >= v_max_units THEN 'unit cap reached'
                                      ELSE 'wall-clock budget reached' END, v_units), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode',            v_mode,
                        'units_run',       v_units,
                        'unit_capped',     v_capped,
                        'caught_up',       v_caught_up,
                        'dirty_donors',    v_donors,
                        'rollup_rows',     v_rows,
                        'failures',        COALESCE(array_length(v_failures, 1), 0),
                        'canceled',        v_canceled IS NOT NULL,
                        'cancel_detail',   v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- Where the next firing picks up. On the old code this
                        -- was always the same value as watermark_before, which
                        -- is what the ratchet looked like in the log.
                        'next_slice_from', (SELECT value->>'last_indexed_at'
                                              FROM public.pipeline_state
                                             WHERE key = 'donor_party_rollup_watermark'))
                      -- FIX-1212 — the windowed full rebuild's own clock (the
                      -- phase_seconds shape, rule 93). Absent on a crawl run.
                      || CASE WHEN v_mode IN ('bootstrap', 'full') THEN jsonb_build_object(
                           'windows_total', 16,
                           'windows_done',  to_jsonb(v_done),
                           'windows_run',   to_jsonb(v_win_run),
                           'stage_seconds', to_jsonb(v_stage_s),
                           'apply_seconds', to_jsonb(v_apply_s))
                         ELSE '{}'::jsonb END
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-party-rollup] % (mode=%) — % unit(s), % donors, % rows, watermark now %',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'FAILED'
         WHEN v_caught_up THEN 'CAUGHT UP'
         WHEN v_capped THEN 'UNIT CAP' ELSE 'complete' END,
    v_mode, v_units, v_donors, v_rows,
    (SELECT value->>'last_indexed_at' FROM public.pipeline_state
      WHERE key = 'donor_party_rollup_watermark');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

-- donor_party_rollup_rebuild_donors: ind CTE → primary_industry_tag(p_donors)
CREATE OR REPLACE FUNCTION public.donor_party_rollup_rebuild_donors(p_donors uuid[])
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count bigint;
BEGIN
  DELETE FROM public.donor_party_rollup_mv
   WHERE donor_id = ANY (p_donors);

  WITH agg AS (
    SELECT
      fr.from_id                          AS donor_id,
      COALESCE(o.party::text, 'unknown')  AS party_key,
      SUM(fr.amount_cents)::bigint        AS total_cents,
      COUNT(*)::bigint                    AS tx_count
    FROM public.financial_relationships fr
    JOIN public.officials o
      ON o.id = fr.to_id AND fr.to_type = 'official'
    WHERE fr.relationship_type = 'donation'
      AND fr.from_type = 'financial_entity'
      AND fr.from_id = ANY (p_donors)
    GROUP BY fr.from_id, COALESCE(o.party::text, 'unknown')
  ),
  ind AS (
    -- FIX-918: the donor's primary industry, from its one home.
    SELECT pit.entity_id,
           pit.tag           AS industry_tag,
           pit.display_label AS industry_label
    FROM public.primary_industry_tag(p_donors) pit
  ),
  ins AS (
    INSERT INTO public.donor_party_rollup_mv (
      donor_id, party_key, donor_name, entity_type, industry_tag,
      industry_label, total_cents, tx_count
    )
    SELECT
      a.donor_id, a.party_key, fe.display_name, fe.entity_type,
      ind.industry_tag, ind.industry_label, a.total_cents, a.tx_count
    FROM agg a
    LEFT JOIN public.financial_entities fe ON fe.id = a.donor_id
    LEFT JOIN ind                          ON ind.entity_id = a.donor_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$function$;

-- rebuild_entity_search_index: _fe_industry → primary_industry_tag(NULL)
CREATE OR REPLACE FUNCTION public.rebuild_entity_search_index()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_count integer;
  -- FIX-985(b). The spend-precedence vocabulary, declared ONCE so the
  -- predicate below and the domain assertion cannot drift apart. Was
  -- ('corporation','organization') at both sites; 'organization' has never
  -- been in the financial_entities.entity_type CHECK domain, so every
  -- non-corporation spender fell through to total_donated_cents and
  -- rendered amount_cents = 0. Prod 2026-09-02: 35 'other' + 2 'nonprofit'
  -- entities, 1,317,782,700 cents ($13,177,827.00) of contract+grant, all
  -- showing $0.
  c_spend_types text[] := ARRAY['corporation', 'other', 'nonprofit'];
  v_domain text[];
  v_lit    text;
  -- FIX-687's canonical 16. uuid v4 keys distribute evenly across them.
  c_bounds uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  i    int;
  v_lo uuid;
  v_hi uuid;
BEGIN
  -- FIX-985(b) guard: every literal in c_spend_types must be a real member of
  -- the financial_entities.entity_type CHECK domain. The next vocabulary
  -- drift fails loudly here instead of silently zeroing an amount column.
  SELECT array_agg(m[1]) INTO v_domain
  FROM pg_constraint con
  CROSS JOIN LATERAL regexp_matches(
         pg_get_constraintdef(con.oid), '''([a-z0-9_]+)''::text', 'g') AS m
  WHERE con.conrelid = 'public.financial_entities'::regclass
    AND con.contype  = 'c'
    AND con.conname  = 'financial_entities_entity_type_check';

  IF v_domain IS NULL THEN
    -- Constraint renamed or dropped: cannot assert. Say so, do not block the
    -- nightly rebuild on a missing guard.
    RAISE WARNING 'FIX-985: financial_entities_entity_type_check not readable - '
                  'entity_type vocabulary left unasserted.';
  ELSE
    FOREACH v_lit IN ARRAY c_spend_types LOOP
      IF NOT (v_lit = ANY (v_domain)) THEN
        RAISE EXCEPTION
          'FIX-985: entity_type ''%'' in the search-index spend vocabulary is not in '
          'the financial_entities.entity_type CHECK domain (%). Fix the vocabulary '
          'or the constraint before rebuilding the search index.',
          v_lit, array_to_string(v_domain, ', ');
      END IF;
    END LOOP;
  END IF;

  -- Per-statement memory for the GIN builds on the INSERTs below. The _conn
  -- stage no longer runs under this: entity_search_conn_window() carries its own
  -- 64MB proconfig, which is what actually bounds the aggregate (FIX-1123).
  SET LOCAL work_mem = '256MB';

  -- ── Shared derivations (built once) ──
  --
  -- FIX-1123 — sixteen bounded windows instead of one whole-table
  -- HashAggregate over a UNION ALL of both id columns. Each window is its own
  -- statement, so the memory ceiling is per-window and a future cardinality
  -- spills one window's worth rather than the box. entity_connections is
  -- 10,503,011 rows / 7,473 MB on prod as of 2026-08-31 — the ~2.4M in FIX-748's
  -- header was true when it shipped 2026-07-06 and has been 4.4x wrong since.
  CREATE TEMP TABLE _conn (entity_id uuid, c int) ON COMMIT DROP;
  FOR i IN 1 .. 16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    INSERT INTO _conn (entity_id, c)
    SELECT w.entity_id, w.c
      FROM public.entity_search_conn_window(v_lo, v_hi) w;
  END LOOP;
  CREATE UNIQUE INDEX ON _conn (entity_id);
  -- The old build was a CTAS, which leaves no statistics behind either; the
  -- INSERT path is the same. ANALYZE so the eight INSERTs below join against a
  -- real row count rather than a default guess.
  ANALYZE _conn;

  CREATE TEMP TABLE _off_committees ON COMMIT DROP AS
    SELECT official_id, array_agg(DISTINCT committee_id) AS committee_ids
    FROM public.official_committee_memberships
    WHERE ended_at IS NULL
    GROUP BY official_id;
  CREATE UNIQUE INDEX ON _off_committees (official_id);

  -- one primary industry slug per financial entity (FIX-918: the ranked pick,
  -- from its one home)
  CREATE TEMP TABLE _fe_industry ON COMMIT DROP AS
    SELECT pit.entity_id, pit.tag
    FROM public.primary_industry_tag(NULL) pit;
  CREATE UNIQUE INDEX ON _fe_industry (entity_id);

  TRUNCATE public.entity_search_index;

  -- ── official ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, photo_url, search_tsv, is_synthetic,
    jurisdiction_level, state, party, chamber, status, committee_ids,
    amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'official', o.id, o.full_name, o.role_title, o.photo_url,
    to_tsvector('english', coalesce(o.full_name,'') || ' ' || coalesce(o.role_title,'')),
    coalesce(o.is_synthetic, false),
    CASE lower(coalesce(j.type::text, oj.type::text))
      WHEN 'country' THEN 'federal'
      WHEN 'state'   THEN 'state'
      WHEN 'county'  THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL
    END,
    o.metadata->>'state',
    o.party::text,
    CASE WHEN o.role_title = 'Senator' THEN 'senate'
         WHEN o.role_title ILIKE 'Representative%' THEN 'house' ELSE NULL END,
    'active',
    oc.committee_ids,
    -- FIX-942: the authoritative per-official donation total is
    -- official_donor_totals.total_cents, NOT officials.total_received_cents.
    -- Both sum the same quantity (FR rows, to_type='official',
    -- relationship_type='donation'), but the column lost its writer when the
    -- nightly moved to the FIX-836 bulk regime and has been frozen since.
    -- Prod 2026-09-05: 4,131 officials disagreed, $2,745,805,506 of |gap|.
    -- Missing rollup row = 0, which is what an official with no donations has.
    COALESCE(odt.total_cents, 0),
    CASE WHEN odt.total_cents IS NOT NULL THEN 'received' ELSE NULL END,
    coalesce(cn.c, 0),
    o.updated_at,
    CASE WHEN o.source_ids ? 'congress_gov' OR o.source_ids ? 'bioguide_id' THEN 'congress.gov'
         WHEN o.source_ids ? 'openstates' THEN 'openstates' ELSE NULL END,
    now()
  FROM public.officials o
  LEFT JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
  LEFT JOIN public.jurisdictions j     ON j.id = gb.jurisdiction_id
  LEFT JOIN public.jurisdictions oj    ON oj.id = o.jurisdiction_id
  LEFT JOIN _conn cn                    ON cn.entity_id = o.id
  LEFT JOIN _off_committees oc          ON oc.official_id = o.id
  LEFT JOIN public.official_donor_totals odt ON odt.official_id = o.id
  WHERE o.is_active
    -- FIX-939 - merge stubs never surface. A FIX-933 merge neutralises a
    -- same-person duplicate: the money moves to the elected survivor and the
    -- candidate row keeps its retired FEC id purely as provenance. What is
    -- left is a $0 official that duplicates a real person, and all 86 of them
    -- on prod (2026-09-05) were being offered by search, typeahead and the
    -- browse facets as people you could look up. All three read this table, so
    -- this predicate is what covers them; the TS mirror for the readers that
    -- hit `officials` directly is isMergeStubSourceIds() in @civitics/db.
    --
    -- PRESENCE of any marker key, not equality with a particular id:
    --   merged_fec_candidate_id   legacy scalar (86 prod rows today)
    --   merged_fec_candidate_ids  the FIX-956 array writers now emit
    --   merged_into               the survivor pointer, written by a later
    --                             data pass - accepted here already so
    --                             nothing changes when it lands.
    AND NOT (o.source_ids ?| ARRAY[
      'merged_fec_candidate_id', 'merged_fec_candidate_ids', 'merged_into']);

  -- ── proposal (non-initiative) ───────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, proposal_type, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'proposal', p.id, p.title, p.type::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.type::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, p.type::text,
    NULL, NULL, coalesce(cn.c, 0),
    p.introduced_at::timestamptz,
    CASE WHEN p.type::text = 'regulation' THEN 'regulations.gov' ELSE 'congress.gov' END,
    now()
  FROM public.proposals p
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type <> 'initiative';

  -- ── initiative ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, initiative_stage, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'initiative', p.id, p.title, id2.stage::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(id2.stage::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, id2.stage::text,
    coalesce(cn.c, 0), p.created_at, 'civitics', now()
  FROM public.proposals p
  LEFT JOIN public.initiative_details id2 ON id2.proposal_id = p.id
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type = 'initiative';

  -- ── agency ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    agency_type, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'agency', a.id, a.name, a.acronym,
    to_tsvector('english', coalesce(a.name,'') || ' ' || coalesce(a.acronym,'')),
    coalesce(a.is_synthetic, false),
    a.agency_type, 'active', coalesce(cn.c, 0), a.updated_at, NULL, now()
  FROM public.agencies a
  LEFT JOIN _conn cn ON cn.entity_id = a.id
  WHERE a.is_active;

  -- ── financial (non-individual) — FIX-667 amount precedence ──────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    financial_type, industry, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'financial', f.id, f.display_name, f.entity_type,
    to_tsvector('english', coalesce(f.display_name,'') || ' ' || coalesce(f.entity_type,'')),
    coalesce(f.is_synthetic, false),
    f.entity_type, fi.tag,
    amt.amount_cents, amt.amount_label,
    coalesce(cn.c, 0),
    f.created_at,   -- FIX-699: updated_at is stale (lost trigger) — created_at is the defensible column
    CASE WHEN amt.amount_label IN ('contract','grant') THEN 'usaspending' ELSE 'fec' END,
    now()
  FROM public.financial_entities f
  LEFT JOIN _conn cn ON cn.entity_id = f.id
  LEFT JOIN _fe_industry fi ON fi.entity_id = f.id
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN ie > 0 THEN ie
           WHEN spend > 0 AND f.entity_type = ANY (c_spend_types) THEN spend
           ELSE don END AS amount_cents,
      CASE WHEN ie > 0 THEN 'independent_expenditure'
           WHEN spend > 0 AND f.entity_type = ANY (c_spend_types)
             THEN CASE WHEN contract_c >= grant_c THEN 'contract' ELSE 'grant' END
           ELSE 'donation' END AS amount_label
    FROM (SELECT
            coalesce(f.total_ie_support_cents,0) + coalesce(f.total_ie_oppose_cents,0) AS ie,
            coalesce(f.total_contract_cents,0)   + coalesce(f.total_grant_cents,0)     AS spend,
            coalesce(f.total_contract_cents,0)   AS contract_c,
            coalesce(f.total_grant_cents,0)      AS grant_c,
            coalesce(f.total_donated_cents,0)    AS don) v
  ) amt
  WHERE f.entity_type <> 'individual';

  -- ── jurisdiction ────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'jurisdiction', jr.id, jr.name, jr.type::text,
    to_tsvector('english', coalesce(jr.name,'') || ' ' || coalesce(jr.short_name,'')),
    coalesce(jr.is_synthetic, false),
    CASE lower(jr.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    'active', coalesce(cn.c, 0), jr.updated_at, 'census', now()
  FROM public.jurisdictions jr
  LEFT JOIN _conn cn ON cn.entity_id = jr.id
  WHERE jr.is_active;

  -- ── institution (governing bodies) ──────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, institution_type, status, connection_count, activity_at, refreshed_at)
  SELECT
    'institution', g.id, g.name, g.type::text,
    to_tsvector('english', coalesce(g.name,'') || ' ' || coalesce(g.short_name,'')),
    coalesce(g.is_synthetic, false),
    CASE lower(gj.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    g.type::text, 'active', coalesce(cn.c, 0), g.updated_at, now()
  FROM public.governing_bodies g
  LEFT JOIN public.jurisdictions gj ON gj.id = g.jurisdiction_id
  LEFT JOIN _conn cn ON cn.entity_id = g.id
  WHERE g.is_active;

  -- ── meeting ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, connection_count, activity_at, refreshed_at)
  SELECT
    'meeting', m.id, m.title, m.meeting_type,
    to_tsvector('english', coalesce(m.title,'') || ' ' || coalesce(m.meeting_type,'')),
    false,  -- meetings have no is_synthetic column
    m.status, coalesce(cn.c, 0), m.scheduled_at, now()
  FROM public.meetings m
  LEFT JOIN _conn cn ON cn.entity_id = m.id
  WHERE m.title IS NOT NULL;

  -- ── facet rollup ──
  PERFORM public.rebuild_browse_facet_counts();

  SELECT count(*) INTO v_count FROM public.entity_search_index;
  RETURN v_count;
END;
$function$;

-- refresh_group_donor_rollup: _gdr_ind MIN(display_label) → primary_industry_tag(NULL).display_label
CREATE OR REPLACE FUNCTION public.refresh_group_donor_rollup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cohorts    bigint;
  v_donor_rows bigint;
BEGIN
  SET LOCAL work_mem = '256MB';

  -- Institutional donation edges + donor display fields, resolved once (individuals
  -- and the PAC/Committee placeholder excluded HERE, ahead of the membership fan-out).
  CREATE TEMP TABLE _gdr_base ON COMMIT DROP AS
    SELECT ec.to_id        AS official_id,
           ec.from_id      AS donor_id,
           ec.amount_cents,
           fe.display_name AS donor_name,
           fe.entity_type  AS donor_entity_type
    FROM public.entity_connections ec
    JOIN public.financial_entities fe ON fe.id = ec.from_id
    WHERE ec.connection_type = 'donation'
      AND ec.to_type         = 'official'
      AND ec.from_type       = 'financial_entity'
      AND fe.entity_type    <> 'individual'
      AND fe.display_name NOT ILIKE '%PAC/Committee%';
  CREATE INDEX ON _gdr_base (official_id);
  ANALYZE _gdr_base;

  -- Membership: one row per (gb_id, party_key, official_id). Non-committee members
  -- appear under 'all' AND their own party; committee members under 'all' only (the
  -- route never party-filters committee membership — FIX-139). FIX-470 roster
  -- predicate for non-committee gbs.
  CREATE TEMP TABLE _gdr_membership ON COMMIT DROP AS
    SELECT o.governing_body_id AS gb_id, 'all'::text AS party_key, o.id AS official_id
    FROM public.officials o
    JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
    WHERE gb.type <> 'committee'
      AND o.is_active = true
      AND o.tier = 'elected'
      AND o.governing_body_id IS NOT NULL
    UNION ALL
    SELECT o.governing_body_id, o.party::text, o.id
    FROM public.officials o
    JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
    WHERE gb.type <> 'committee'
      AND o.is_active = true
      AND o.tier = 'elected'
      AND o.governing_body_id IS NOT NULL
      AND o.party IS NOT NULL
    UNION ALL
    SELECT ocm.committee_id, 'all'::text, ocm.official_id
    FROM public.official_committee_memberships ocm
    JOIN public.governing_bodies gb
      ON gb.id = ocm.committee_id AND gb.type = 'committee'
    WHERE ocm.ended_at IS NULL;
  CREATE INDEX ON _gdr_membership (official_id);
  ANALYZE _gdr_membership;

  -- Representative industry label per donor (tiny financial_entity industry set).
  -- FIX-918: the label of the donor's primary industry, from its one home — was
  -- MIN(display_label), alphabetical by LABEL.
  CREATE TEMP TABLE _gdr_ind ON COMMIT DROP AS
    SELECT pit.entity_id, pit.display_label AS sector
    FROM public.primary_industry_tag(NULL) pit;
  CREATE INDEX ON _gdr_ind (entity_id);
  ANALYZE _gdr_ind;

  -- Per-(cohort, donor) institutional totals. donor_name / donor_entity_type are
  -- constant per donor_id, carried through with min() so no financial_entities
  -- re-join is needed at insert time.
  CREATE TEMP TABLE _gdr_agg ON COMMIT DROP AS
    SELECT m.gb_id,
           m.party_key,
           b.donor_id,
           min(b.donor_name)        AS donor_name,
           min(b.donor_entity_type) AS donor_entity_type,
           SUM(b.amount_cents)::bigint AS total_cents,
           COUNT(*)::bigint            AS member_count
    FROM _gdr_membership m
    JOIN _gdr_base b ON b.official_id = m.official_id
    GROUP BY m.gb_id, m.party_key, b.donor_id;
  ANALYZE _gdr_agg;

  -- DELETE (not TRUNCATE) so concurrent request-path reads keep the prior snapshot
  -- until commit — no ACCESS EXCLUSIVE lock on the read path during refresh.
  DELETE FROM public.group_donor_rollup;
  DELETE FROM public.group_donor_rollup_summary;

  INSERT INTO public.group_donor_rollup
    (gb_id, party_key, financial_entity_id, donor_name, donor_entity_type, sector,
     total_cents, member_count)
  SELECT a.gb_id,
         a.party_key,
         a.donor_id,
         a.donor_name,
         a.donor_entity_type,
         ind.sector,
         a.total_cents,
         a.member_count
  FROM _gdr_agg a
  LEFT JOIN _gdr_ind ind ON ind.entity_id = a.donor_id;

  -- Summary: ONE row per DISTINCT cohort in the membership set (zero-donor state
  -- gbs included, donor_count=0 — the route's materialized-vs-not disambiguator).
  INSERT INTO public.group_donor_rollup_summary
    (gb_id, party_key, donor_count, total_cents, refreshed_at)
  SELECT c.gb_id,
         c.party_key,
         COALESCE(r.donor_count, 0),
         COALESCE(r.total_cents, 0),
         now()
  FROM (SELECT DISTINCT gb_id, party_key FROM _gdr_membership) c
  LEFT JOIN (
    SELECT gb_id, party_key,
           COUNT(*)         AS donor_count,
           SUM(total_cents) AS total_cents
    FROM public.group_donor_rollup
    GROUP BY gb_id, party_key
  ) r ON r.gb_id = c.gb_id AND r.party_key = c.party_key;

  SELECT count(*) INTO v_cohorts    FROM public.group_donor_rollup_summary;
  SELECT count(*) INTO v_donor_rows FROM public.group_donor_rollup;

  RETURN jsonb_build_object(
    'cohorts',      v_cohorts,
    'donor_rows',   v_donor_rows,
    'refreshed_at', now()
  );
END;
$function$;

-- get_cohort_top_donors: LATERAL ORDER BY tag LIMIT 1 → primary_industry_tag(top_n ids)
CREATE OR REPLACE FUNCTION public.get_cohort_top_donors(p_official_ids uuid[], p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH agg AS (
    -- Index-only scan on entity_connections_donation_to_official_idx.
    SELECT ec.from_id                   AS donor_id,
           SUM(ec.amount_cents)::bigint AS total_cents,
           COUNT(*)::int                AS member_count
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'donation'
      AND ec.to_type         = 'official'
      AND ec.from_type       = 'financial_entity'
      AND ec.to_id = ANY (p_official_ids)
    GROUP BY ec.from_id
  ),
  inst AS (
    -- Institutional money only. INNER JOIN drops donors with no
    -- financial_entities row, matching the live path's `if (!info) continue`.
    SELECT a.donor_id, a.total_cents, a.member_count,
           fe.display_name AS donor_name,
           fe.entity_type
    FROM agg a
    JOIN public.financial_entities fe ON fe.id = a.donor_id
    WHERE fe.entity_type <> 'individual'
      AND COALESCE(fe.display_name, '') !~* 'PAC/Committee'
  ),
  top_n AS (
    SELECT * FROM inst
    -- donor_id breaks ties so the list is stable across identical calls.
    ORDER BY total_cents DESC, donor_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 0), 100)
  ),
  tagged AS (
    SELECT t.*, ind.display_label AS sector
    FROM top_n t
    -- FIX-918: the donor's primary industry, from its one home (was ORDER BY
    -- et.tag LIMIT 1 — alphabetical).
    LEFT JOIN public.primary_industry_tag(ARRAY(SELECT donor_id FROM top_n)) ind
      ON ind.entity_id = t.donor_id
  )
  SELECT jsonb_build_object(
    'donors', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'donor_id',     tg.donor_id,
                 'donor_name',   tg.donor_name,
                 'entity_type',  tg.entity_type,
                 'sector',       tg.sector,
                 'total_cents',  tg.total_cents,
                 'member_count', tg.member_count
               )
               ORDER BY tg.total_cents DESC, tg.donor_id
             )
      FROM tagged tg
    ), '[]'::jsonb),
    -- Distinct institutional donors across the WHOLE cohort (live: donorMap.size).
    'donor_count', (SELECT COUNT(*)::bigint FROM inst),
    -- Sum over the RETURNED donors only (live: topDonors.reduce). Keeping this
    -- shown-only preserves the existing meta.totalDonatedUsd contract exactly.
    'shown_cents', COALESCE((SELECT SUM(total_cents)::bigint FROM top_n), 0)
  );
$function$;

-- search_graph_entities: fan-out join → primary_industry_tag(ARRAY[id]) after the LIMIT
CREATE OR REPLACE FUNCTION public.search_graph_entities(q text, lim integer DEFAULT 5)
 RETURNS TABLE(id uuid, label text, entity_type text, subtitle text, party text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  -- Officials: active only, fuzzy name match. Last-name exact match → sim=1.0.
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      o.id::UUID,
      o.full_name                                                      AS label,
      'official'::TEXT                                                 AS entity_type,
      NULLIF(CONCAT_WS(' · ', o.metadata->>'state', o.role_title), '') AS subtitle,
      o.party::TEXT                                                    AS party,
      CASE
        WHEN LOWER(
          (string_to_array(o.full_name, ' '))[
            array_upper(string_to_array(o.full_name, ' '), 1)
          ]
        ) = LOWER(q)
          THEN 1.0::REAL
        ELSE similarity(o.full_name, q)
      END                                                              AS sim
    FROM public.officials o
    WHERE o.is_active = true
      AND (
        o.full_name ILIKE '%' || q || '%'
        OR similarity(o.full_name, q) > 0.3
      )
    ORDER BY sim DESC, o.full_name
    LIMIT lim
  ) sub

  UNION ALL

  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      a.id::UUID,
      a.name                  AS label,
      'agency'::TEXT          AS entity_type,
      a.acronym               AS subtitle,
      NULL::TEXT              AS party
    FROM public.agencies a
    WHERE a.name    ILIKE '%' || q || '%'
       OR a.acronym ILIKE '%' || q || '%'
    ORDER BY a.name
    LIMIT lim
  ) sub

  UNION ALL

  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      p.id::UUID,
      p.title           AS label,
      'proposal'::TEXT  AS entity_type,
      p.status::TEXT    AS subtitle,
      NULL::TEXT        AS party
    FROM public.proposals p
    WHERE p.title ILIKE '%' || q || '%'
    ORDER BY p.title
    LIMIT lim
  ) sub

  UNION ALL

  -- Financial entities: excludes individual donors (FIX-195 / FIX-335).
  -- Uses `%` instead of `similarity() > 0.3` so the GIN trigram can serve
  -- the fuzzy branch. Subtitle carries the industry label.
  -- FIX-918: the label is the entity's primary industry, from its one home,
  -- joined AFTER the LIMIT. It was a plain join to every industry tag, so a
  -- multi-tag entity came back once per tag and pushed others past the LIMIT.
  SELECT sub.id, sub.label, sub.entity_type,
         NULLIF(
           CONCAT_WS(' · ', sub.fe_type, COALESCE(pit.display_label, pit.tag)),
           ''
         )                                                                    AS subtitle,
         sub.party
  FROM (
    SELECT
      f.id::UUID,
      f.display_name                                                          AS label,
      'financial_entity'::TEXT                                                AS entity_type,
      f.entity_type                                                           AS fe_type,
      NULL::TEXT                                                              AS party,
      similarity(f.display_name, q)                                           AS sim
    FROM public.financial_entities f
    WHERE f.entity_type <> 'individual'
      AND (
        f.display_name ILIKE '%' || q || '%'
        OR f.display_name % q
      )
    ORDER BY sim DESC, f.total_donated_cents DESC
    LIMIT lim
  ) sub
  LEFT JOIN LATERAL public.primary_industry_tag(ARRAY[sub.id]) pit ON true;
$function$;

-- compute_fe_industry_tag_signature: per-donor sig covers tag:generated_by:confidence
CREATE OR REPLACE FUNCTION public.compute_fe_industry_tag_signature()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- FIX-918: each tag contributes tag:generated_by:confidence, the inputs
  -- primary_industry_tag() ranks on, so a change that moves a donor's primary
  -- industry without changing its tag SET still moves the signature.
  WITH per_donor AS (
    SELECT et.entity_id,
           md5(string_agg(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''), ',' ORDER BY et.tag)) AS sig,
           count(*)::bigint                             AS n
      FROM public.entity_tags et
     WHERE et.entity_type  = 'financial_entity'
       AND et.tag_category = 'industry'
     GROUP BY et.entity_id
  )
  SELECT COALESCE(sum(n), 0)::text || '|'
         || COALESCE(md5(string_agg(entity_id::text || ':' || sig, ',' ORDER BY entity_id)), 'empty')
    FROM per_donor;
$function$;

-- refresh_sector_affinity_from_tag_changes: per-donor sig covers tag:generated_by:confidence (3 sites)
CREATE OR REPLACE PROCEDURE public.refresh_sector_affinity_from_tag_changes()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('sector_affinity_tag_refresh')::bigint;
  c_sig_key    constant text := 'sector_affinity:industry_tag_signature';
  c_chunk      constant int  := 500;   -- matches backfill_official_sector_affinity_rollup
  v_log_id     uuid;
  v_live_sig   text;
  v_stored_sig text;
  v_shadow_n   bigint;
  v_reason     text;
  v_donors     uuid[];
  v_n_donors   int;
  v_officials  uuid[];
  v_n_off      int := 0;
  v_chunk_ids  uuid[];
  v_i          int := 1;
  v_chunk_no   int := 0;
  v_rows       bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled   text := NULL;
  -- FIX-979 — real entry time.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent sector-affinity tag refresh'));
    RAISE NOTICE '[sector-affinity tag refresh] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[sector-affinity tag refresh] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '128MB';

  -- Signature FIRST, before any rebuild: tag writes that land mid-run make the
  -- NEXT run's live signature differ from what this run stores, so they are
  -- re-processed rather than silently absorbed — the FIX-704
  -- capture-watermark-before-dirty-set discipline, content-shaped.
  v_live_sig := public.compute_fe_industry_tag_signature();

  SELECT value->>'sig' INTO v_stored_sig
    FROM public.pipeline_state WHERE key = c_sig_key;

  SELECT count(*) INTO v_shadow_n FROM public.donor_industry_tag_state;

  -- ── Path 1: no-op — identical content, zero rollup work ────────────────────
  IF v_stored_sig IS NOT NULL AND v_shadow_n > 0 AND v_live_sig = v_stored_sig THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
    VALUES ('sector_affinity_tag_refresh', 'complete', v_started, clock_timestamp(), 0,
            jsonb_build_object('path', 'noop',
                               'reason', 'industry tag content signature unchanged',
                               'sig', v_live_sig));
    RAISE NOTICE '[sector-affinity tag refresh] noop — signature unchanged (%)', v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 2: cold start / signature-store miss — the full backfill ──────────
  IF v_stored_sig IS NULL OR v_shadow_n = 0 THEN
    v_reason := CASE WHEN v_stored_sig IS NULL
                     THEN 'cold_start_no_signature'
                     ELSE 'signature_store_miss_empty_shadow' END;
    INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
    VALUES ('sector_affinity_tag_refresh', 'running', v_started,
            jsonb_build_object('path', 'full_backfill', 'reason', v_reason))
    RETURNING id INTO v_log_id;
    COMMIT;

    -- Deliberately NOT wrapped in an EXCEPTION block: the nested procedure
    -- COMMITs per chunk, and transaction control is illegal inside a plpgsql
    -- EXCEPTION subtransaction. On failure the error propagates, the signature
    -- is never seeded, and the next run retries the cold path — fail-safe
    -- direction is REBUILD, same as the FIX-652 gate.
    --
    -- FIX-1028 NOTE: this path is therefore the one place in the sweep that
    -- CANNOT carry a query_canceled handler — the language forbids it. A cancel
    -- inside the cold-start backfill still strands the running row for the
    -- reaper. That is a structural consequence of CALLing a COMMITting
    -- procedure, not an oversight; the fix would be to inline the backfill's
    -- chunk loop here, which is out of scope for this sweep. Path 3 below (the
    -- steady-state path, and the only one a scheduled firing takes once the
    -- signature store is warm) IS protected.
    CALL public.backfill_official_sector_affinity_rollup();

    DELETE FROM public.donor_industry_tag_state;
    INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
    SELECT et.entity_id,
           md5(string_agg(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''), ',' ORDER BY et.tag)),
           count(*)::int,
           clock_timestamp()   -- FIX-981: after the backfill's per-chunk COMMITs
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();

    UPDATE public.data_sync_log
       SET status = 'complete', completed_at = clock_timestamp(),
           metadata = metadata || jsonb_build_object(
             'sig', v_live_sig,
             'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
     WHERE id = v_log_id;

    RAISE NOTICE '[sector-affinity tag refresh] full backfill (%) — signature store seeded (%)',
      v_reason, v_live_sig;
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── Path 3: targeted — diff the per-donor shadow, rebuild only the affected ─
  -- FIX-918: the per-donor sig covers tag:generated_by:confidence (the ranking
  -- inputs), matching compute_fe_industry_tag_signature().
  WITH cur AS (
    SELECT et.entity_id AS donor_id,
           md5(string_agg(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''), ',' ORDER BY et.tag)) AS sig,
           count(*)::int AS n
      FROM public.entity_tags et
     WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
     GROUP BY et.entity_id
  )
  SELECT array_agg(donor_id) INTO v_donors
    FROM (
      SELECT COALESCE(c.donor_id, s.donor_id) AS donor_id
        FROM cur c
        FULL OUTER JOIN public.donor_industry_tag_state s ON s.donor_id = c.donor_id
       WHERE c.donor_id IS NULL                       -- tags removed entirely
          OR s.donor_id IS NULL                       -- newly tagged donor
          OR c.sig IS DISTINCT FROM s.tag_sig
          OR c.n   IS DISTINCT FROM s.tag_count
    ) d;

  v_n_donors := COALESCE(array_length(v_donors, 1), 0);

  -- v_n_donors = 0 with a moved global signature means tags changed between the
  -- signature capture and this diff (the shadow was already advanced past the
  -- captured signature by content that arrived mid-scan). Nothing to rebuild
  -- for THIS signature; the newer content re-diffs on the next run. Advance and
  -- log donors_changed=0 — self-healing by construction.
  IF v_n_donors > 0 THEN
    SELECT array_agg(DISTINCT fr.to_id) INTO v_officials
      FROM unnest(v_donors) AS d(id)
      JOIN public.financial_relationships fr ON fr.from_id = d.id
     WHERE fr.relationship_type = 'donation'
       AND fr.from_type = 'financial_entity'
       AND fr.to_type   = 'official'
       AND fr.amount_cents > 0;
    v_n_off := COALESCE(array_length(v_officials, 1), 0);
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('sector_affinity_tag_refresh', 'running', v_started,
          jsonb_build_object('path', 'targeted',
                             'reason', 'industry tag content signature changed',
                             'donors_changed', v_n_donors,
                             'officials_affected', v_n_off,
                             'sig_before', v_stored_sig,
                             'sig_after', v_live_sig))
  RETURNING id INTO v_log_id;
  COMMIT;

  WHILE v_i <= v_n_off LOOP
    v_chunk_ids := v_officials[v_i : LEAST(v_i + c_chunk - 1, v_n_off)];
    v_chunk_no  := v_chunk_no + 1;
    BEGIN
      v_n    := public.sector_affinity_rebuild_officials(v_chunk_ids);
      v_rows := v_rows + v_n;
    EXCEPTION
    -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % CANCELED (statement_timeout or operator cancel): %',
        v_chunk_no, SQLERRM;
    WHEN OTHERS THEN
      -- One bad chunk must not abort the rest; its officials keep their PRIOR
      -- rollup rows (complete-if-stale) and the un-advanced signature re-derives
      -- the same diff next run.
      v_failures := v_failures || format('chunk %s (officials %s..%s): %s',
        v_chunk_no, v_i, LEAST(v_i + c_chunk - 1, v_n_off), SQLERRM);
      RAISE WARNING '[sector-affinity tag refresh] chunk % FAILED: %', v_chunk_no, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction (PL/pgSQL rule)
    -- FIX-1028 — stop the sweep; the remaining chunks would each re-arm the
    -- same axe, and the signature advance below is gated so the un-covered
    -- officials stay in the next run's diff.
    EXIT WHEN v_canceled IS NOT NULL;
    v_i := v_i + c_chunk;
  END LOOP;

  -- Advance shadow + signature only on a clean run. FIX-1028 adds the cancel
  -- arm: a cancelled run did not rebuild every affected official, so storing
  -- the new signature would drop the remainder out of the next run's diff
  -- forever.
  IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
    IF v_n_donors > 0 THEN
      DELETE FROM public.donor_industry_tag_state s
       WHERE s.donor_id = ANY (v_donors)
         AND NOT EXISTS (
           SELECT 1 FROM public.entity_tags et
            WHERE et.entity_type  = 'financial_entity'
              AND et.tag_category = 'industry'
              AND et.entity_id    = s.donor_id);

      INSERT INTO public.donor_industry_tag_state (donor_id, tag_sig, tag_count, updated_at)
      SELECT et.entity_id,
             md5(string_agg(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''), ',' ORDER BY et.tag)),
             count(*)::int,
             clock_timestamp()   -- FIX-981: after the chunk loop's COMMITs
        FROM unnest(v_donors) AS d(id)
        JOIN public.entity_tags et ON et.entity_id = d.id
       WHERE et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
       GROUP BY et.entity_id
      ON CONFLICT (donor_id) DO UPDATE
        SET tag_sig = EXCLUDED.tag_sig,
            tag_count = EXCLUDED.tag_count,
            updated_at = clock_timestamp();
    END IF;

    INSERT INTO public.pipeline_state (key, value)
    VALUES (c_sig_key, jsonb_build_object('sig', v_live_sig, 'changed_at', clock_timestamp()::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
  END IF;

  UPDATE public.data_sync_log
     SET status        = CASE
                             WHEN v_canceled IS NOT NULL          THEN 'partial'
                             WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                             ELSE 'complete'
                           END,
         completed_at  = clock_timestamp(),
         rows_inserted = v_rows,
         rows_failed   = COALESCE(array_length(v_failures, 1), 0),
         error_message = CASE
                           WHEN v_canceled IS NOT NULL
                             THEN left(format('canceled — %s; signature unmoved, the remaining officials stay in the next diff', v_canceled), 1000)
                           WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000)
                           ELSE NULL
                         END,
         metadata      = metadata || jsonb_build_object(
                           'rollup_rows', v_rows,
                           'chunks', v_chunk_no,
                           'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                           'canceled', v_canceled IS NOT NULL,
                           'cancel_detail', v_canceled,
                           'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
   WHERE id = v_log_id;

  RAISE NOTICE '[sector-affinity tag refresh] % — % donor(s) changed, % official(s) in % chunk(s), % rows (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_n_donors, v_n_off, v_chunk_no, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

-- ── 2. Signature format: convert the shadow rows whose pick cannot have moved ─
-- A single-tag donor whose stored sig is still md5(<its one tag>) has not
-- changed since the last refresh, and a one-tag donor's pick is that tag. Its
-- row is rewritten in the new format, so the next refresh does not treat it as
-- dirty. Multi-tag donors and donors with pending changes keep their old-format
-- sig and are re-derived by the next scheduled refresh.
UPDATE public.donor_industry_tag_state s
   SET tag_sig = md5(et.tag || ':' || et.generated_by || ':' || COALESCE(et.confidence::text, ''))
  FROM public.entity_tags et
 WHERE s.tag_count = 1
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
   AND et.entity_id    = s.donor_id
   AND s.tag_sig       = md5(et.tag)
   AND NOT EXISTS (
         SELECT 1 FROM public.entity_tags e2
          WHERE e2.entity_type  = 'financial_entity'
            AND e2.tag_category = 'industry'
            AND e2.entity_id    = s.donor_id
            AND e2.tag         <> et.tag);

RESET statement_timeout;
