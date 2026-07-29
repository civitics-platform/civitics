-- =============================================================================
-- FIX-892 — get_proposal_topic_groups() : server-side GROUP BY for
--           /api/graph/tag-groups (defeat the PostgREST 1k row cap).
--
-- The route (FIX-137) `.select()`s every topic-category proposal tag row and
-- aggregates `count(DISTINCT entity_id)` per tag in JS, on the strength of a
-- header comment claiming "the row volume is bounded (~1.4k topic rows total)".
-- That assumption expired. The qualifying slice is 6,039 rows on local
-- (prod is larger), PostgREST caps ANY response at max_rows=1,000, and the
-- route's `.select()` carries no `.order()` — so it aggregates an arbitrary
-- physical-order 1,000-row slice and reports counts that sum to 1,000 against
-- a true 6,039. A ~6.0x understatement, failing OPEN: no error, no short-read
-- signal, just smaller numbers. Worse, a truncated read drops whole tags below
-- the route's `count >= 10` floor — 20 tags clear it on the true data, 18 on
-- the truncated read, so at least two topics vanish from the browse list.
--
-- This is the reference-postgrest-rpc-row-cap rule (mirrors FIX-878): an
-- aggregate that can exceed 1,000 rows must be computed server-side and
-- returned as ONE jsonb aggregate, never SETOF and never .range()-paginated.
-- count(DISTINCT ...) is precisely what PostgREST cannot express, which is why
-- the route was aggregating in JS in the first place.
--
-- SCOPE / DESIGN NOTES
--
--  • Returns the FULL aggregate — no `count >= 10` floor, no 30-row cap. Those
--    are presentation thresholds and stay in the route (MIN_COUNT/MAX_RESULTS):
--    the array is ~24 elements, so there is nothing to save by filtering
--    server-side, and changing a threshold should never need a migration.
--
--  • Filters are byte-identical to the route's today: entity_type='proposal',
--    tag_category='topic', visibility <> 'internal', tag <> 'other'.
--    `<> 'internal'` (not IS DISTINCT FROM) is deliberate — it reproduces
--    PostgREST's `.neq()`, which drops NULLs. entity_tags.visibility has ZERO
--    NULLs on this slice today (verified local, 2026-07-28: 0 of 7,543
--    proposal/topic rows), so the two forms are currently indistinguishable;
--    matching `.neq()` means a future NULL behaves exactly as it does now
--    rather than silently changing the browse list.
--
--  • label/icon per tag is the MODE of the (display_label, display_icon) pair,
--    tiebroken pair_rows DESC, display_label ASC, display_icon ASC. NOT min().
--    Three tags carry more than one pair on local — consumer_protection
--    ("Consumer Protection" x108 vs "Consumer" x16), transportation
--    ("Transportation"/car x591 vs "Transport"/anchor x249 vs "Transport"/car x5),
--    technology (laptop x195 vs satellite x56). min(display_label) picks the
--    MINORITY label for two of those three; the mode reproduces the title-cased
--    tag key for all 20 tags over the floor, which is what today's
--    arbitrary-order JS aggregation lands on in practice.
--
--  • Array order is `count DESC, tag ASC`. The route sorted `count DESC` over a
--    Map's insertion order, which is non-deterministic between requests; the
--    `tag ASC` tiebreak makes the browse list stable. (Unrelated to FIX-918 —
--    that is about DISTINCT ON tie-breaks on eight other surfaces.)
--
--  • Element shape is the route's existing TagGroup interface
--    ({tag, label, icon, count}), so the route is a thin pass-through.
--    Returns '[]'::jsonb when empty, never NULL.
--
-- The route calls via createAdminClient() (service_role), so the FIX-834/835
-- route-gated posture applies: EXECUTE is revoked from anon/authenticated.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_proposal_topic_groups()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH scoped AS (
    SELECT t.tag, t.display_label, t.display_icon, t.entity_id
    FROM public.entity_tags t
    WHERE t.entity_type  = 'proposal'
      AND t.tag_category = 'topic'
      AND t.visibility  <> 'internal'
      AND t.tag         <> 'other'
  ),
  counts AS (
    -- The reason this function exists: count(DISTINCT entity_id) has no
    -- PostgREST expression, so the route had to materialize every row to
    -- compute it — and PostgREST would only hand it 1,000 of them.
    SELECT s.tag, count(DISTINCT s.entity_id)::int AS cnt
    FROM scoped s
    GROUP BY s.tag
  ),
  pairs AS (
    SELECT s.tag, s.display_label, s.display_icon, count(*) AS pair_rows
    FROM scoped s
    GROUP BY s.tag, s.display_label, s.display_icon
  ),
  modes AS (
    -- Modal (display_label, display_icon) per tag. The ORDER BY is total:
    -- (tag, display_label, display_icon) is `pairs`' group key, so the ASC
    -- tiebreaks fully determine the winner for any data.
    SELECT DISTINCT ON (p.tag) p.tag, p.display_label, p.display_icon
    FROM pairs p
    ORDER BY p.tag, p.pair_rows DESC, p.display_label ASC, p.display_icon ASC
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'tag',   c.tag,
        'label', m.display_label,
        'icon',  m.display_icon,
        'count', c.cnt
      )
      ORDER BY c.cnt DESC, c.tag ASC
    ),
    '[]'::jsonb
  )
  FROM counts c
  JOIN modes  m USING (tag);
$$;

COMMENT ON FUNCTION public.get_proposal_topic_groups() IS
  'FIX-892 — topic tags applied to proposals as ONE jsonb array of '
  '{tag, label, icon, count}, count = count(DISTINCT entity_id), ordered '
  'count DESC, tag ASC. Returns jsonb rather than SETOF so the aggregate is '
  'computed server-side and is not subject to PostgREST''s max_rows cap '
  '(/api/graph/tag-groups previously aggregated in JS over a silently '
  'truncated 1,000-row read). label/icon are the modal (display_label, '
  'display_icon) pair per tag. No count floor or result cap — those stay '
  'presentation thresholds in the route.';

-- Route-gated (createAdminClient = service_role). Supabase default-grants
-- EXECUTE on every new function to anon/authenticated (FIX-834/835) — revoke.
REVOKE ALL ON FUNCTION public.get_proposal_topic_groups() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_proposal_topic_groups() TO service_role;

-- New function → PostgREST needs to see it in the schema cache.
NOTIFY pgrst, 'reload schema';
