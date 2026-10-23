-- FIX-1258 (cc-244, D-g) — the twin of the out-of-band CREATE EXTENSION pg_repack.
--
-- On PROD this is a no-op: scripts/fix1258-repack-entity-tags.mjs created the
-- extension inside its own FIX-950 claim, immediately before compacting
-- public.entity_tags with the pg_repack client (a container pinned to the
-- server's version, scripts/pg_repack/Dockerfile). This file lands on main AFTER
-- that run's read-back and rides the NEXT gated push (the fix1269 twin pattern).
-- On LOCAL and on any rebuilt-from-zero environment it is the real install path.
--
-- The extension STAYS (design D6): the client refuses to run without it, and a
-- later compaction of another table should not have to re-argue the install.
-- `postgres` is not a superuser on Supabase; pg_repack is in
-- supautils.privileged_extensions, which is what lets this CREATE run, and the
-- client runs with -k (no superuser check).
--
-- PINNED: 1.5.2 — prod's pg_available_extensions.default_version on 2026-10-23,
-- and the client the Dockerfile builds (PGDG lists only 1.5.3 now, so the image
-- is a source build of the ver_1.5.2 tag). If Supabase bumps the server, the
-- read-back below RAISEs rather than leaving a client/server mismatch to be
-- found mid-compaction: rebuild the image with the new version and re-pin here.
-- A server that does not offer pg_repack at all NOTICEs and skips, so a
-- rebuilt-from-zero environment without it does not fail the push.

DO $$
DECLARE
  c_pinned    CONSTANT text := '1.5.2';
  v_available text;
  v_installed text;
BEGIN
  SELECT default_version INTO v_available FROM pg_available_extensions WHERE name = 'pg_repack';
  IF v_available IS NULL THEN
    RAISE NOTICE '[fix1258] pg_repack is not available on this server — skipped (nothing to compact with here)';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS pg_repack;

  SELECT extversion INTO v_installed FROM pg_extension WHERE extname = 'pg_repack';
  IF v_installed IS DISTINCT FROM c_pinned THEN
    RAISE EXCEPTION '[fix1258] pg_repack installed % (available %) but this migration pins % — rebuild scripts/pg_repack with --build-arg PG_REPACK_VERSION=% and re-pin',
      v_installed, v_available, c_pinned, v_installed;
  END IF;
  RAISE NOTICE '[fix1258] read-back ok: pg_repack % installed (pinned %, available %)', v_installed, c_pinned, v_available;
END $$;
