-- verify_fix401.sql — RLS, CHECKs, the unique key and the 24-hour cap on
-- public.data_flags (20261120000000_fix401_data_flags.sql).
--
-- Run as ONE command:
--
--   node scripts/db-query.mjs --local --file supabase/tests/verify_fix401.sql
--
-- Exits non-zero on any failed assertion (ON_ERROR_STOP + RAISE EXCEPTION). The
-- whole run is wrapped BEGIN; ... ROLLBACK; — nothing persists, including the
-- three ephemeral users.
--
-- CASES:
--   1. As user A, an insert of A's own flag succeeds and A reads it back.
--   2. A cannot read B's flag.
--   3. A cannot insert a row for B; cannot pre-stamp a resolution or a
--      created_at (column-scoped grant); cannot update its own flag.
--   4. anon can neither read nor insert.
--   5. Each CHECK refuses one bad value.
--   6. The unique key refuses the duplicate; a second REASON is a new row.
--   7. The cap: the 20th flag inside 24 hours lands, the 21st raises 53400;
--      a row exactly 24 hours old is outside the window.
--   8. The cap holds on the direct signed-in path too (the trigger fires for
--      `authenticated`, whose EXECUTE on the function is revoked).

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

\echo '── fixtures: users A, B, C (f401* ids) ─────────────────────────────────────'

INSERT INTO auth.users
  (id, instance_id, aud, role, created_at, updated_at,
   confirmation_token, recovery_token, email_change, email_change_token_new,
   email_change_token_current, phone_change, phone_change_token,
   reauthentication_token, raw_app_meta_data, raw_user_meta_data)
SELECT u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), now(),
       '', '', '', '', '', '', '', '', '{}'::jsonb, '{}'::jsonb
  FROM (VALUES ('f4010000-0000-0000-0000-00000000000a'::uuid),
               ('f4010000-0000-0000-0000-00000000000b'::uuid),
               ('f4010000-0000-0000-0000-00000000000c'::uuid)) AS u(id);

INSERT INTO public.users (id, is_synthetic) VALUES
  ('f4010000-0000-0000-0000-00000000000a', false),
  ('f4010000-0000-0000-0000-00000000000b', false),
  ('f4010000-0000-0000-0000-00000000000c', false);

-- B's flag, written as the table owner (the service-role path).
INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
VALUES ('proposal', 'f401e000-0000-0000-0000-0000000000b1', 'outdated', 'f4010000-0000-0000-0000-00000000000b');

\echo '── CASE 1: A inserts its own flag and reads it back ────────────────────────'

SELECT set_config('request.jwt.claims',
  '{"sub":"f4010000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

INSERT INTO public.data_flags (entity_type, entity_id, reason, comment, source, flagger_user_id)
VALUES ('official', 'f401e000-0000-0000-0000-0000000000a1', 'misspelled', 'Surname is spelled wrong',
        'congress_gov', 'f4010000-0000-0000-0000-00000000000a');

DO $$
DECLARE r public.data_flags;
BEGIN
  SELECT * INTO r FROM public.data_flags
   WHERE entity_id = 'f401e000-0000-0000-0000-0000000000a1';
  IF r.id IS NULL THEN RAISE EXCEPTION 'CASE 1 FAILED: A cannot read its own flag back'; END IF;
  IF r.reason <> 'misspelled' OR r.source <> 'congress_gov' OR r.admin_resolved_at IS NOT NULL
     OR r.classification IS NOT NULL THEN
    RAISE EXCEPTION 'CASE 1 FAILED: unexpected row %', row_to_json(r);
  END IF;
END $$;
\echo 'CASE 1 ok'

\echo '── CASE 2: A cannot read B''s flag ─────────────────────────────────────────'

DO $$
BEGIN
  IF (SELECT count(*) FROM public.data_flags
       WHERE flagger_user_id = 'f4010000-0000-0000-0000-00000000000b') <> 0 THEN
    RAISE EXCEPTION 'CASE 2 FAILED: A read B''s flag';
  END IF;
  IF (SELECT count(*) FROM public.data_flags) <> 1 THEN
    RAISE EXCEPTION 'CASE 2 FAILED: A sees % rows, expected only its own 1', (SELECT count(*) FROM public.data_flags);
  END IF;
END $$;
\echo 'CASE 2 ok'

\echo '── CASE 3: A cannot write for B, pre-stamp a resolution, or update ─────────'

DO $$
BEGIN
  BEGIN
    INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
    VALUES ('official', 'f401e000-0000-0000-0000-0000000000a2', 'wrong', 'f4010000-0000-0000-0000-00000000000b');
    RAISE EXCEPTION 'CASE 3 FAILED: A inserted a row for B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;  -- 42501, the insert-own WITH CHECK
  END;

  BEGIN
    INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, resolution, admin_resolved_at)
    VALUES ('official', 'f401e000-0000-0000-0000-0000000000a3', 'wrong', 'f4010000-0000-0000-0000-00000000000a',
            'valid', now());
    RAISE EXCEPTION 'CASE 3 FAILED: A pre-stamped a resolution';
  EXCEPTION WHEN insufficient_privilege THEN NULL;  -- column-scoped INSERT grant
  END;

  BEGIN
    INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, created_at)
    VALUES ('official', 'f401e000-0000-0000-0000-0000000000a4', 'wrong', 'f4010000-0000-0000-0000-00000000000a',
            now() - interval '2 days');
    RAISE EXCEPTION 'CASE 3 FAILED: A back-dated created_at out of the cap window';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.data_flags SET resolution = 'invalid'
     WHERE flagger_user_id = 'f4010000-0000-0000-0000-00000000000a';
    RAISE EXCEPTION 'CASE 3 FAILED: A updated its own flag';
  EXCEPTION WHEN insufficient_privilege THEN NULL;  -- no UPDATE grant, no update policy
  END;
END $$;
\echo 'CASE 3 ok'

\echo '── CASE 4: anon can neither read nor insert ────────────────────────────────'

RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;

DO $$
DECLARE n bigint;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.data_flags;
    RAISE EXCEPTION 'CASE 4 FAILED: anon read data_flags (% rows)', n;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
    VALUES ('official', 'f401e000-0000-0000-0000-0000000000a5', 'wrong', 'f4010000-0000-0000-0000-00000000000a');
    RAISE EXCEPTION 'CASE 4 FAILED: anon inserted a flag';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
\echo 'CASE 4 ok'

\echo '── CASE 5: each CHECK refuses one bad value ────────────────────────────────'

RESET ROLE;

DO $$
DECLARE
  c text;
  bad text[] := ARRAY[
    $q$INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id) VALUES ('jurisdiction', gen_random_uuid(), 'wrong', 'f4010000-0000-0000-0000-00000000000b')$q$,
    $q$INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id) VALUES ('official', gen_random_uuid(), 'spam', 'f4010000-0000-0000-0000-00000000000b')$q$,
    $q$INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, resolution) VALUES ('official', gen_random_uuid(), 'wrong', 'f4010000-0000-0000-0000-00000000000b', 'fixed')$q$,
    $q$INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, comment) VALUES ('official', gen_random_uuid(), 'wrong', 'f4010000-0000-0000-0000-00000000000b', repeat('x', 501))$q$,
    $q$INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, source) VALUES ('official', gen_random_uuid(), 'wrong', 'f4010000-0000-0000-0000-00000000000b', '')$q$,
    $q$INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, classification_confidence) VALUES ('official', gen_random_uuid(), 'wrong', 'f4010000-0000-0000-0000-00000000000b', 1.5)$q$
  ];
BEGIN
  FOREACH c IN ARRAY bad LOOP
    BEGIN
      EXECUTE c;
      RAISE EXCEPTION 'CASE 5 FAILED: accepted %', c;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- the boundary values are accepted
  INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, comment, classification_confidence)
  VALUES ('financial_entity', gen_random_uuid(), 'other', 'f4010000-0000-0000-0000-00000000000b', repeat('x', 500), 0.8);
END $$;
\echo 'CASE 5 ok'

\echo '── CASE 6: the unique key ──────────────────────────────────────────────────'

DO $$
BEGIN
  BEGIN
    INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
    VALUES ('official', 'f401e000-0000-0000-0000-0000000000a1', 'misspelled', 'f4010000-0000-0000-0000-00000000000a');
    RAISE EXCEPTION 'CASE 6 FAILED: a duplicate (entity, flagger, reason) was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- same entity, same flagger, another reason: a new row
  INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
  VALUES ('official', 'f401e000-0000-0000-0000-0000000000a1', 'outdated', 'f4010000-0000-0000-0000-00000000000a');
END $$;
\echo 'CASE 6 ok'

\echo '── CASE 7: the 20 / 21 boundary on the rolling 24 hours ────────────────────'

DO $$
DECLARE
  v_c constant uuid := 'f4010000-0000-0000-0000-00000000000c';
BEGIN
  -- outside the window: exactly 24 h old, and older. These never count.
  INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, created_at)
  SELECT 'official', gen_random_uuid(), 'wrong', v_c, now() - interval '24 hours' - (g || ' minutes')::interval
    FROM generate_series(0, 4) g;

  -- 19 inside the window
  INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id, created_at)
  SELECT 'official', gen_random_uuid(), 'wrong', v_c, now() - interval '23 hours 59 minutes' + (g || ' seconds')::interval
    FROM generate_series(1, 19) g;

  -- the 20th lands
  INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
  VALUES ('official', gen_random_uuid(), 'wrong', v_c);

  -- the 21st does not
  BEGIN
    INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
    VALUES ('official', gen_random_uuid(), 'wrong', v_c);
    RAISE EXCEPTION 'CASE 7 FAILED: the 21st flag inside 24 hours was accepted';
  EXCEPTION WHEN SQLSTATE '53400' THEN NULL;
  END;

  IF (SELECT count(*) FROM public.data_flags WHERE flagger_user_id = v_c) <> 25 THEN
    RAISE EXCEPTION 'CASE 7 FAILED: C has % rows, expected 25 (5 old + 20 in window)',
      (SELECT count(*) FROM public.data_flags WHERE flagger_user_id = v_c);
  END IF;
END $$;
\echo 'CASE 7 ok'

\echo '── CASE 8: the cap holds on the direct signed-in path ──────────────────────'

SELECT set_config('request.jwt.claims',
  '{"sub":"f4010000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.data_flags (entity_type, entity_id, reason, flagger_user_id)
    VALUES ('agency', gen_random_uuid(), 'other', 'f4010000-0000-0000-0000-00000000000c');
    RAISE EXCEPTION 'CASE 8 FAILED: a direct signed-in insert passed the cap';
  EXCEPTION WHEN SQLSTATE '53400' THEN NULL;
  END;
END $$;
\echo 'CASE 8 ok'

RESET ROLE;
\echo '── all 8 cases passed — rolling back ──────────────────────────────────────'

ROLLBACK;
