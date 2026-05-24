-- =============================================================================
-- FIX-335 — make search_graph_entities actually use the partial trigram index;
-- add deferred individual-side trigram for the future donor-by-name lookup.
--
-- ── Background ──────────────────────────────────────────────────────────────
-- FIX-335's original write-up hypothesized the cutover dropped the trigram
-- on financial_entities and never recreated it. Diagnostic against prod
-- showed otherwise: the partial index exists
--   `financial_entities_display_trgm WHERE entity_type <> 'individual'`
-- added intentionally by FIX-195 (20260502130000_financial_entities_partial_indexes.sql).
-- The reason search_graph_entities('warren') times out is in the RPC body,
-- not the index — two predicates make the partial index unusable to the
-- planner:
--
--   (a) The body has no `entity_type` filter, so the planner cannot use
--       a partial index whose predicate it can't prove is satisfied.
--   (b) `similarity(f.display_name, q) > 0.3` is not directly indexable;
--       the indexable equivalent is the `%` operator, which uses the same
--       pg_trgm.similarity_threshold of 0.3 by default.
--
-- Both fixes are required to switch from Parallel Seq Scan to Bitmap Index
-- Scan via financial_entities_display_trgm.
--
-- ── Verified plans against prod (db.xsazcoxinpgttgquwvuf.supabase.co) ──────
--   Before: Parallel Seq Scan on 2.4M rows → 11.3 s subquery, 12.2 s RPC
--           → 57014 statement timeout under service_role's shorter cap
--   After (RPC body with both fixes): Bitmap Index Scan on
--           financial_entities_display_trgm → ~9 ms subquery
--
-- ── Side effect of the entity_type predicate ───────────────────────────────
-- Individual donors are no longer surfaced in the financial_entity tile of
-- search_graph_entities. This matches FIX-195's design call ("would not
-- want to flood results with 248 individuals named GOLDMAN once they're
-- fixed"). The two call sites this RPC powers — entity_search_finds_warren
-- self-test and graph/search universal-search — both want PACs/corps, not
-- individual donors. A separate donor-by-name UI (FIX-194 territory) will
-- query the individual-side partial trigram added below.
--
-- ── Individual-side partial trigram ────────────────────────────────────────
-- FIX-195 deferred this with the note "An individual-only trigram for
-- donor-by-name lookup — no call site wants it today; revisit when FIX-194
-- (c) 'pin a donor' lands." FIX-194 is now in the backlog, and pre-building
-- the index here means that work won't need its own migration.
--
-- At ~2.34M individual rows on prod the GIN build is roughly 5–15 min and
-- ~500–800 MB on disk; financial pipelines that write to this table will
-- block for the duration of the SHARE lock. The migration uses
-- IF NOT EXISTS so a pre-build via psql with CONCURRENTLY (which can't
-- run inside a migration transaction) is safe — the migration's CREATE
-- becomes a no-op.
--
-- Zero-downtime pre-build (run against prod BEFORE `supabase db push --linked`):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_entities_display_trgm_individual
--     ON public.financial_entities
--     USING gin (display_name extensions.gin_trgm_ops)
--     WHERE entity_type = 'individual';
-- =============================================================================

-- ── 1. Individual-side partial trigram (mirrors FIX-195's pattern) ──────────
CREATE INDEX IF NOT EXISTS financial_entities_display_trgm_individual
  ON public.financial_entities
  USING gin (display_name gin_trgm_ops)
  WHERE entity_type = 'individual';

COMMENT ON INDEX public.financial_entities_display_trgm_individual IS
  'Trigram name search over individual donors only — complement to FIX-195''s non-individual partial. Deferred from FIX-195 prep, restored by FIX-335 ahead of FIX-194 (c) donor-by-name lookup.';

-- ── 2. search_graph_entities — replace financial_entities branch ──────────
-- Replaces the version from 20260428000000_drop_financial_entities_industry.sql.
-- Officials / agencies / proposals branches unchanged. Only the
-- financial_entities branch differs:
--   (a) Add `f.entity_type <> 'individual'` (predicate match for the partial trigram)
--   (b) Swap `similarity(f.display_name, q) > 0.3` for `f.display_name % q` (indexable)
CREATE OR REPLACE FUNCTION public.search_graph_entities(
  q   TEXT,
  lim INTEGER DEFAULT 5
)
RETURNS TABLE(
  id          UUID,
  label       TEXT,
  entity_type TEXT,
  subtitle    TEXT,
  party       TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
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
  -- the fuzzy branch. Subtitle joins entity_tags for the industry label.
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      f.id::UUID,
      f.display_name                                                          AS label,
      'financial_entity'::TEXT                                                AS entity_type,
      NULLIF(
        CONCAT_WS(' · ', f.entity_type, COALESCE(et.display_label, et.tag)),
        ''
      )                                                                       AS subtitle,
      NULL::TEXT                                                              AS party,
      similarity(f.display_name, q)                                           AS sim
    FROM public.financial_entities f
    LEFT JOIN public.entity_tags et
      ON et.entity_id    = f.id
     AND et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
    WHERE f.entity_type <> 'individual'
      AND (
        f.display_name ILIKE '%' || q || '%'
        OR f.display_name % q
      )
    ORDER BY sim DESC, f.total_donated_cents DESC
    LIMIT lim
  ) sub;
$$;

GRANT EXECUTE ON FUNCTION public.search_graph_entities(TEXT, INTEGER) TO anon, authenticated, service_role;

ANALYZE public.financial_entities;
