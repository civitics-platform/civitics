-- 20260528000000_institutions_stage1.sql
-- FIX-418: Stage 1 institution unification.
--
-- Scope (Stage 1 only — Stage 3 is the actual table collapse):
--   1. institution_extensions — sidecar for agency-specific columns on
--      governing_bodies rows. Empty today; backfilled in Stage 3. Exists
--      now so the read view shape stays stable post-Stage-3.
--   2. governing_bodies.slug — nullable, unique-where-not-null. No
--      backfill in this FIX (separate follow-up).
--   3. institutions — UNION view over governing_bodies + agencies, used
--      by /institutions/[id]. Both sides expose the same column shape;
--      source_table distinguishes them at read time.
--
-- Not touched in this FIX:
--   - No INSERTs into governing_bodies from agencies (Stage 3).
--   - No agencies-table changes.
--   - No refactor of the 31 from('agencies') callsites (Stage 3).
--   - No slug backfill.
--
-- Column-name verification done before writing:
--   - governing_bodies: primary_source / primary_source_url /
--     primary_source_last_seen_at (added by FIX-402, migration
--     20260527000000_attribution_coverage_402_410_406.sql).
--   - agencies: primary_source / primary_source_url /
--     primary_source_last_seen_at (added by FIX-397, migration
--     20260526000001_primary_source_materialization.sql).
--   - governing_body_type enum: confirmed castable to text via 'foo'::governing_body_type::text.
--   - agencies.agency_type: TEXT with CHECK ('federal','state','local','independent','international','other').
--   - No prior migration mentions institution_extensions / public.institutions / governing_bodies.slug
--     (verified via grep over supabase/migrations/).

-- ── 1. institution_extensions sidecar ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.institution_extensions (
  governing_body_id      UUID PRIMARY KEY REFERENCES public.governing_bodies(id) ON DELETE CASCADE,
  acronym                TEXT,
  usaspending_agency_id  TEXT,
  usaspending_subtier_id TEXT,
  parent_id              UUID REFERENCES public.governing_bodies(id),
  metadata               JSONB NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS institution_extensions_parent_id_idx
  ON public.institution_extensions(parent_id);
CREATE INDEX IF NOT EXISTS institution_extensions_acronym_idx
  ON public.institution_extensions(acronym);

ALTER TABLE public.institution_extensions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'institution_extensions'
       AND policyname = 'public_institution_extensions_select'
  ) THEN
    CREATE POLICY "public_institution_extensions_select"
      ON public.institution_extensions FOR SELECT USING (true);
  END IF;
END
$$;

DROP TRIGGER IF EXISTS institution_extensions_updated_at ON public.institution_extensions;
CREATE TRIGGER institution_extensions_updated_at
  BEFORE UPDATE ON public.institution_extensions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. governing_bodies.slug ──────────────────────────────────────────────

ALTER TABLE public.governing_bodies
  ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS governing_bodies_slug_idx
  ON public.governing_bodies(slug)
  WHERE slug IS NOT NULL;

-- ── 3. institutions view ──────────────────────────────────────────────────
-- LEFT JOIN on the gb side because institution_extensions is empty today;
-- post-Stage-3 it will hold rows for the promoted-from-agencies entries.
-- Both sides cast their type enum/text to TEXT so the UNION resolves.

CREATE OR REPLACE VIEW public.institutions AS
  SELECT
    gb.id,
    gb.jurisdiction_id,
    gb.type::text                     AS type,
    gb.name,
    gb.short_name,
    gb.website_url,
    gb.contact_email,
    gb.is_active,
    gb.slug,
    'governing_body'::text            AS source_table,
    ie.acronym,
    ie.usaspending_agency_id,
    ie.usaspending_subtier_id,
    ie.parent_id,
    gb.primary_source,
    gb.primary_source_url,
    gb.primary_source_last_seen_at,
    gb.metadata,
    gb.created_at,
    gb.updated_at
  FROM public.governing_bodies gb
  LEFT JOIN public.institution_extensions ie
    ON ie.governing_body_id = gb.id

  UNION ALL

  SELECT
    a.id,
    a.jurisdiction_id,
    a.agency_type                     AS type,
    a.name,
    a.short_name,
    a.website_url,
    a.contact_email,
    a.is_active,
    NULL::text                        AS slug,
    'agency'::text                    AS source_table,
    a.acronym,
    a.usaspending_agency_id,
    a.usaspending_subtier_id,
    a.parent_agency_id                AS parent_id,
    a.primary_source,
    a.primary_source_url,
    a.primary_source_last_seen_at,
    a.metadata,
    a.created_at,
    a.updated_at
  FROM public.agencies a;

COMMENT ON VIEW public.institutions IS
  'FIX-418 Stage 1: unified read view over governing_bodies + agencies. source_table column distinguishes the underlying table. Stage 3 collapses agencies into governing_bodies and drops this view''s agencies branch.';

GRANT SELECT ON public.institutions TO anon, authenticated, service_role;
