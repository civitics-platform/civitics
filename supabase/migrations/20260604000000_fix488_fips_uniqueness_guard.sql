-- FIX-488: fips uniqueness guard for state-level jurisdictions.
--
-- Prevents the FIX-482 (DC) / FIX-487 (territories) duplicate-jurisdiction class
-- from recurring. The three "state-level" jurisdiction kinds must be exactly one
-- row per fips_code:
--   'state'                    — the 50 states
--   'federal_district'         — DC (FIX-422 canonical row)
--   'unincorporated_territory' — AS/GU/MP/PR/VI (FIX-422 canonical rows)
--
-- All three previously had a sibling type='district' row sharing the same fips,
-- which split each entity's officials across two jurisdiction rows. The merges
-- (data:merge-dc-jurisdiction, data:merge-territory-jurisdictions) collapsed
-- those, and the STATE_DATA type flip stops the seed re-splitting; this partial
-- unique index is the durable schema-level backstop.
--
-- It is deliberately PARTIAL: county / district / city / precinct / school_district
-- etc. legitimately repeat a fips (e.g. DC county 11001, Guam county 66010, the
-- "District of Columbia Delegate District (at Large)" row at fips 11) and are
-- intentionally NOT constrained.
--
-- Ships LAST and only when clean: created only after the DC + territory merges
-- landed on BOTH envs, because a residual duplicate would fail this
-- CREATE UNIQUE INDEX mid-push. The jurisdictions table is small, so a plain
-- (non-CONCURRENTLY) build is fine and keeps the migration transaction-safe.
CREATE UNIQUE INDEX IF NOT EXISTS jurisdictions_statelevel_fips_uniq
  ON public.jurisdictions (fips_code)
  WHERE type IN ('state', 'federal_district', 'unincorporated_territory');
