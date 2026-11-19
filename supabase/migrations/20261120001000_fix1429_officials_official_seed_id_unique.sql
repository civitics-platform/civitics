-- FIX-1429 — one officials row per executive seed id (cc-299 D7).
--
-- Before FIX-1428 the nightly executive seed (packages/data/src/pipelines/
-- executive/seed.ts) inserted a President or Vice President whenever its
-- lookup failed, and prod reached 4 + 43 rows. FIX-1428 made a failed lookup
-- write nothing; scripts/fix1429-delete-executive-seed-duplicates.sql deleted
-- the 45 duplicates on prod (2026-11-19 05:18Z, cc-299). This index makes a
-- third path impossible: an insert for a seed id that already has a row
-- fails with 23505, and the seed counts it as `failed` instead of adding a row.
--
-- The guard RAISEs while any seed id still has more than one row, so this
-- file cannot land ahead of the delete. officials is ~39k rows and the index
-- is partial (2 rows), so a plain build inside the migration is class P.
DO $$
DECLARE
  v_dupes jsonb;
BEGIN
  SELECT jsonb_object_agg(seed, n) INTO v_dupes
    FROM (SELECT source_ids->>'official_seed_id' AS seed, count(*) AS n
            FROM public.officials
           WHERE source_ids ? 'official_seed_id'
           GROUP BY 1
          HAVING count(*) > 1) q;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'FIX-1429: official_seed_id still has duplicate officials rows (%); run scripts/fix1429-delete-executive-seed-duplicates.sql first',
      v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS officials_official_seed_id_key
  ON public.officials ((source_ids->>'official_seed_id'))
  WHERE source_ids ? 'official_seed_id';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = 'public.officials_official_seed_id_key'::regclass
       AND indisunique AND indisvalid
  ) THEN
    RAISE EXCEPTION 'FIX-1429: officials_official_seed_id_key is missing, not unique or not valid';
  END IF;
END $$;
