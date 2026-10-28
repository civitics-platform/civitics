-- FIX-1356 — max_parallel_workers_per_gather = 0 and hash_mem_multiplier = 1
-- for the two login roles, postgres and authenticator, in database postgres
-- (memory levers 2 + 3 of the cc-251 census; cc-252).
--
-- WHAT. Four role-in-database settings:
--   postgres      @ postgres: max_parallel_workers_per_gather = 0, hash_mem_multiplier = 1
--   authenticator @ postgres: max_parallel_workers_per_gather = 0, hash_mem_multiplier = 1
-- postgres is every pg_cron unit (cron.use_background_workers = off: each job
-- is a fresh libpq login as postgres), every gated push, every ad-hoc read and
-- the GHA runners' direct connections. authenticator is PostgREST's login role;
-- it SET ROLEs to anon / authenticated / service_role per request, and role
-- settings apply at LOGIN, so the authenticator row covers the whole request
-- path. Rows on anon / authenticated would be inert for these two parameters.
--
-- WHY. (2) Every parallel worker maps its own DSM segment: cc-182/188 found
-- 128 MB DSM refusals under ad-hoc parallel reads, and the 10-07 swap storm was
-- one (cc-210 R2). Only db-query.mjs --prod's prelude set the parallel setting
-- to 0, for its own sessions. The server is already at 1 (cc-251 M5:
-- reset_val 1, not the default 2), so this removes the DSM CLASS, not
-- megabytes. cc-252 read 3: at 1, the request path's FR shapes plan
-- Gather Merge / Workers Planned: 1 for a heavy entity (the custom plans of
-- the 4,308-call to_id and from_id reads); their generic plans and the EC read
-- do not. postgres_logs carried 0 DSM-refusal lines 10-21 00:40Z -> 10-28
-- 00:40Z, so the "after" count proves the class stays absent, not a drop.
-- (3) hash_mem_multiplier 2 lets every hash node take 2 x work_mem: postgres
-- is at 64MB (M1, 20261009030000) -> 128 MB per node; refresh_derived_mvs SETs
-- work_mem 128MB -> 256 MB per node. The 10-06 wedge was a ~560 MB hash. At 1
-- every hash peak halves, and a hash that no longer fits spills to batches —
-- IO, not swap, the better failure on a 904 MiB box. cc-252 read 4 on the
-- clone, the FIX-1248 weekly merge's _insert (Hash Right Anti Join over
-- 2,819,195 desired rows): work_mem 64MB  x2 Batches 4  89.5 MiB -> x1 Batches 8  44.8 MiB;
--                     work_mem 128MB x2 Batches 2 179.1 MiB -> x1 Batches 4  89.5 MiB;
-- wall 5.1-5.4 s warm either way. rebuild_entity_search_index (the daily's
-- largest unit) peaks at 31.8 MiB, Batches 1, under both: unaffected.
-- No routine on prod SETs hash_mem_multiplier (read 6: the mentions in
-- refresh_derived_mvs and run_rule_taggers are comments), so the role value
-- reaches every unit. FIX-1357 re-derives job_registry.cap_mb to match.
--
-- MECHANISM (i) — ALTER ROLE … IN DATABASE postgres SET, the path M1's
-- work_mem took. Both parameters are USERSET (pg_settings.context 'user'), so
-- a non-superuser with authority over the role may set them: postgres is the
-- role itself, and holds ADMIN OPTION on authenticator (pg_auth_members), which
-- supautils lists as a modifiable reserved role (authenticator*).
-- supautils.privileged_role_allowed_configs governs SUSET parameters and
-- placeholders; fix1316's civitics.* failure (20261016230000:78-88) was a
-- placeholder. The prompt's proxy, has_parameter_privilege(..., 'SET'), reads
-- pg_parameter_acl grants only: on prod it read f for both targets AND for
-- work_mem, whose ALTER ROLE landed on 10-09, so it cannot tell the cases
-- apart. The clone decided it (cc-252, PG 17.6, the same supautils config):
-- the four statements below applied as non-superuser postgres inside BEGIN …
-- ROLLBACK.
--
-- NETS. pg_db_role_setting is the whole state. Prior state (prod, cc-252 read
-- 2, 2026-10-28 00:47Z):
--   postgres      @ postgres  {statement_timeout=3h,work_mem=64MB}   (neither param present)
--   authenticator @ postgres  no row                                  (its global row
--                             {session_preload_libraries=safeupdate,statement_timeout=8s,lock_timeout=8s}
--                             is setdatabase 0 and is not touched here)
-- so the revert, scripts/fix1356-revert-parallel-hash.sql, RESETs all four
-- (a missing entry → RESET; nothing was present to SET back). A new value
-- reaches a session at its next login: pg_cron units at their next firing,
-- PostgREST's pool as it recycles (minutes, cc-251 M2).
--
-- IDEMPOTENT. ALTER ROLE … SET of the same value is a no-op rewrite of the
-- entry; the read-back re-asserts.

ALTER ROLE postgres IN DATABASE postgres SET max_parallel_workers_per_gather = 0;
ALTER ROLE postgres IN DATABASE postgres SET hash_mem_multiplier = 1;
ALTER ROLE authenticator IN DATABASE postgres SET max_parallel_workers_per_gather = 0;
ALTER ROLE authenticator IN DATABASE postgres SET hash_mem_multiplier = 1;

-- Read-back: both roles carry both values, and M1's two settings survived on
-- postgres (the FIX-1294 assertion shape, 20261009030000:79-93).
DO $$
DECLARE
  v_role text;
  cfg    text[];
BEGIN
  FOREACH v_role IN ARRAY ARRAY['postgres', 'authenticator'] LOOP
    SELECT s.setconfig INTO cfg
      FROM pg_db_role_setting s
      JOIN pg_roles r    ON r.oid = s.setrole
      JOIN pg_database d ON d.oid = s.setdatabase
     WHERE r.rolname = v_role AND d.datname = 'postgres';
    RAISE NOTICE '[fix1356] pg_db_role_setting(%@postgres) = %', v_role, cfg;
    IF cfg IS NULL OR NOT ('max_parallel_workers_per_gather=0' = ANY (cfg)) THEN
      RAISE EXCEPTION '[fix1356] %: max_parallel_workers_per_gather=0 not present after ALTER ROLE (got %)', v_role, cfg;
    END IF;
    IF NOT ('hash_mem_multiplier=1' = ANY (cfg)) THEN
      RAISE EXCEPTION '[fix1356] %: hash_mem_multiplier=1 not present after ALTER ROLE (got %)', v_role, cfg;
    END IF;
    IF v_role = 'postgres' THEN
      IF NOT ('statement_timeout=3h' = ANY (cfg)) THEN
        RAISE EXCEPTION '[fix1356] postgres: statement_timeout=3h did not survive (got %)', cfg;
      END IF;
      IF NOT ('work_mem=64MB' = ANY (cfg)) THEN
        RAISE EXCEPTION '[fix1356] postgres: work_mem=64MB did not survive (got %)', cfg;
      END IF;
    END IF;
  END LOOP;
  RAISE NOTICE '[fix1356] this session still reads max_parallel_workers_per_gather % / hash_mem_multiplier % — role settings apply at the next login',
    current_setting('max_parallel_workers_per_gather'), current_setting('hash_mem_multiplier');
END $$;
