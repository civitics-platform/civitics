-- FIX-411: decouple the Legistar display slug from the API client name.
--
-- The xsr `source` string was built from the Legistar API client name
-- (`legistar:${client}`), so `sfgov`/`austintexas` leaked into user-visible
-- source labels via resolveSource: "Legistar Sfgov", "Legistar Austintexas".
-- The writer now builds the source from a clean display slug
-- (`legistar:san-francisco:*`, `legistar:austin:*`) — see
-- packages/data/src/pipelines/legistar/index.ts (METRO_CLIENTS.slug). This
-- migration rewrites the existing rows to match.
--
-- Scope (decisions #4/#5 in the FIX-411 prompt):
--   * external_source_refs.source           — the canonical xsr source string
--   * <entity>.primary_source               — materialized copy of the xsr source
--     carried by: governing_bodies, officials, proposals
--     (votes/agencies/financial_entities have the column but no legistar rows;
--      `institutions` is a UNION view over governing_bodies — rewriting the base
--      table flows through it, and the view is not directly updatable anyway).
-- Seattle is already clean (slug == client) — left untouched.
--
-- NOT rewritten (decision #2/#5): source_url, metadata.legistar_client, and the
-- `legistar_${client}_last_run` cursor key all keep the API client name.
--
-- Prefix-replace only — env-portable, no hardcoded IDs, idempotent (re-running
-- finds 0 `legistar:sfgov:%` / `legistar:austintexas:%` rows). Runs clean on
-- both local and prod.
--
-- Reverse: swap the replace() args (san-francisco→sfgov, austin→austintexas).

-- ── external_source_refs.source ──────────────────────────────────────────────
UPDATE external_source_refs
   SET source = replace(source, 'legistar:sfgov:', 'legistar:san-francisco:')
 WHERE source LIKE 'legistar:sfgov:%';

UPDATE external_source_refs
   SET source = replace(source, 'legistar:austintexas:', 'legistar:austin:')
 WHERE source LIKE 'legistar:austintexas:%';

-- ── primary_source on the entity tables that carry a legistar slug ───────────
UPDATE governing_bodies
   SET primary_source = replace(primary_source, 'legistar:sfgov:', 'legistar:san-francisco:')
 WHERE primary_source LIKE 'legistar:sfgov:%';
UPDATE governing_bodies
   SET primary_source = replace(primary_source, 'legistar:austintexas:', 'legistar:austin:')
 WHERE primary_source LIKE 'legistar:austintexas:%';

UPDATE officials
   SET primary_source = replace(primary_source, 'legistar:sfgov:', 'legistar:san-francisco:')
 WHERE primary_source LIKE 'legistar:sfgov:%';
UPDATE officials
   SET primary_source = replace(primary_source, 'legistar:austintexas:', 'legistar:austin:')
 WHERE primary_source LIKE 'legistar:austintexas:%';

UPDATE proposals
   SET primary_source = replace(primary_source, 'legistar:sfgov:', 'legistar:san-francisco:')
 WHERE primary_source LIKE 'legistar:sfgov:%';
UPDATE proposals
   SET primary_source = replace(primary_source, 'legistar:austintexas:', 'legistar:austin:')
 WHERE primary_source LIKE 'legistar:austintexas:%';
