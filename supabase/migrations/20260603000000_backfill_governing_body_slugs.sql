-- FIX-475: backfill governing_bodies.slug + idempotent slugify function.
--
-- institutions_stage1 (20260528000000) added governing_bodies.slug (nullable,
-- UNIQUE WHERE slug IS NOT NULL) but did NO backfill, so every row has slug
-- NULL and /institutions/[id] slug URLs never resolve via slug. A one-shot
-- UPDATE would strand later-ingested rows; instead we ship a retained,
-- idempotent function the migration invokes once and the Legistar/openstates
-- pipelines can call again as new gbs land (pipeline wiring is a follow-up).
--
-- Slug scheme (FIX-475 decision 6):
--   base = slugify(coalesce(short_name, name))
--   on global collision        -> prefix slugify(jurisdiction.name)
--   still colliding            -> append a numeric suffix (-2, -3, ...)
-- Deterministic (ORDER BY id) and idempotent: only ever fills NULL slugs,
-- never rewrites an existing slug. Collision-safe against
-- governing_bodies_slug_idx (UNIQUE WHERE slug IS NOT NULL).
--
-- Reverse: `UPDATE governing_bodies SET slug = NULL;` (slugs are derived).

-- ── slugify helper ───────────────────────────────────────────────────────────
-- lower-case, non-alphanumeric runs -> single hyphen, trimmed. IMMUTABLE so it
-- can be used in expression indexes later if needed.
CREATE OR REPLACE FUNCTION public.civitics_slugify(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(both '-' from
    regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g')
  );
$$;

-- ── backfill function ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.backfill_governing_body_slugs()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  rec        RECORD;
  base       text;
  juris      text;
  candidate  text;
  n          integer;
  filled     integer := 0;
BEGIN
  FOR rec IN
    SELECT gb.id,
           gb.short_name,
           gb.name,
           j.name AS jurisdiction_name
      FROM public.governing_bodies gb
      LEFT JOIN public.jurisdictions j ON j.id = gb.jurisdiction_id
     WHERE gb.slug IS NULL
     ORDER BY gb.id
  LOOP
    base := public.civitics_slugify(coalesce(nullif(trim(rec.short_name), ''), rec.name));
    -- Degenerate input (e.g. non-latin name slugifies to empty): fall back to a
    -- stable id-derived stub so the row still gets a unique, resolvable slug.
    IF base IS NULL OR base = '' THEN
      base := 'gb-' || left(rec.id::text, 8);
    END IF;

    candidate := base;

    -- 1) global collision -> prefix the jurisdiction name
    IF EXISTS (SELECT 1 FROM public.governing_bodies WHERE slug = candidate) THEN
      juris := public.civitics_slugify(rec.jurisdiction_name);
      IF juris IS NOT NULL AND juris <> '' THEN
        candidate := juris || '-' || base;
      END IF;
    END IF;

    -- 2) still colliding -> numeric suffix
    IF EXISTS (SELECT 1 FROM public.governing_bodies WHERE slug = candidate) THEN
      n := 2;
      WHILE EXISTS (SELECT 1 FROM public.governing_bodies WHERE slug = candidate || '-' || n) LOOP
        n := n + 1;
      END LOOP;
      candidate := candidate || '-' || n;
    END IF;

    UPDATE public.governing_bodies SET slug = candidate WHERE id = rec.id;
    filled := filled + 1;
  END LOOP;

  RETURN filled;
END;
$$;

-- ── invoke once ──────────────────────────────────────────────────────────────
SELECT public.backfill_governing_body_slugs();
