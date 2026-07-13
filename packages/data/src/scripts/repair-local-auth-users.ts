/**
 * FIX-660: repair corrupt LOCAL auth seed rows that poison admin.listUsers.
 *
 * WHAT THIS FIXES
 *   Two classes of malformed local auth.users rows made `admin.listUsers` return
 *   500 "Database error finding users" and poisoned pagination globally (surfaced
 *   building the FIX-659 mint harness):
 *
 *     1. ~30 "phantom" rows created by the SF-P3 moderation harness helpers
 *        (createUser / createAgedUser / createSyntheticUser), each of which used
 *        `INSERT INTO auth.users (id) VALUES (gen_random_uuid())` — a bare-id row
 *        with EVERY other column NULL. Those inserts run inside a rolled-back
 *        transaction, so they normally never persist; these are historical leaks
 *        from runs whose rollback didn't take. GoTrue's admin list endpoint scans
 *        aud/role/instance_id/the token columns/created_at as NON-nullable Go
 *        values, so a single NULL-column row anywhere in the page 500s the whole
 *        call. (The harness inserts are hardened in the same FIX to be
 *        GoTrue-complete, so any FUTURE leak is harmless — this script cleans the
 *        rows that already leaked.)
 *
 *     2. The two aaaaaaaa-* FIX-540 test users (fix540-commenter / fix540-official)
 *        are well-formed auth.users rows but have NO auth.identities, so
 *        admin.generateLink / verifyOtp 500 on them ("Database error finding user").
 *
 *   The repair is NON-DESTRUCTIVE (no row deletion) and idempotent:
 *     - coerce every NULL GoTrue-scanned column to its valid empty default
 *       (only touches rows that actually have a NULL — second run is a no-op);
 *     - backfill an email identity for any emailed user that lacks one.
 *
 * SAFETY — LOCAL ONLY
 *   Asserts NEXT_PUBLIC_SUPABASE_URL is a 127.0.0.1/localhost address and refuses
 *   otherwise, and only ever connects to the local Docker DB URL. It touches the
 *   `auth` schema, so it uses a direct pg connection (PostgREST does not expose
 *   auth.*). Never runs against prod; never imported by app runtime.
 *
 * RUN (local only):
 *   pnpm --filter @civitics/data data:repair:auth-local
 */

import { Client } from "pg";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function assertLocal(url: string | undefined): void {
  const ok = !!url && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
  if (!ok) {
    process.stderr.write(
      `[repair-local-auth] REFUSING to run — NEXT_PUBLIC_SUPABASE_URL is not local.\n` +
        `[repair-local-auth]   got: ${url ?? "<unset>"}\n` +
        `[repair-local-auth] This tool rewrites auth.* seed state and is LOCAL-ONLY.\n` +
        `[repair-local-auth] Switch back to local: Copy-Item .env.local.dev .env.local\n`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  assertLocal(process.env["NEXT_PUBLIC_SUPABASE_URL"]);
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    // 1. Coerce malformed auth.users rows → GoTrue-scannable empty defaults.
    //    Column set mirrors a known-good GoTrue row (instance_id zero-uuid,
    //    aud/role 'authenticated', all token columns '', raw_*_meta_data '{}',
    //    created_at/updated_at set). WHERE limits to rows that actually have a
    //    NULL so re-runs match zero rows.
    const coerce = await client.query(`
      UPDATE auth.users SET
        instance_id                = COALESCE(instance_id, '00000000-0000-0000-0000-000000000000'),
        aud                        = COALESCE(aud, 'authenticated'),
        role                       = COALESCE(role, 'authenticated'),
        confirmation_token         = COALESCE(confirmation_token, ''),
        recovery_token             = COALESCE(recovery_token, ''),
        email_change               = COALESCE(email_change, ''),
        email_change_token_new     = COALESCE(email_change_token_new, ''),
        email_change_token_current = COALESCE(email_change_token_current, ''),
        phone_change               = COALESCE(phone_change, ''),
        phone_change_token         = COALESCE(phone_change_token, ''),
        reauthentication_token     = COALESCE(reauthentication_token, ''),
        raw_app_meta_data          = COALESCE(raw_app_meta_data, '{}'::jsonb),
        raw_user_meta_data         = COALESCE(raw_user_meta_data, '{}'::jsonb),
        created_at                 = COALESCE(created_at, now()),
        updated_at                 = COALESCE(updated_at, now())
      WHERE instance_id IS NULL OR aud IS NULL OR role IS NULL
         OR confirmation_token IS NULL OR recovery_token IS NULL
         OR email_change IS NULL OR email_change_token_new IS NULL
         OR email_change_token_current IS NULL OR phone_change IS NULL
         OR phone_change_token IS NULL OR reauthentication_token IS NULL
         OR raw_app_meta_data IS NULL OR raw_user_meta_data IS NULL
         OR created_at IS NULL OR updated_at IS NULL
    `);

    // 2. Backfill an email identity for any emailed user missing one (completes
    //    the aaaaaaaa-* FIX-540 users so generateLink/verifyOtp resolve them).
    // NB: auth.identities.email is a GENERATED column (lower(identity_data->>'email'))
    // in this GoTrue schema — it is NOT in the insert list; it derives from the
    // identity_data 'email' key below.
    const ident = await client.query(`
      INSERT INTO auth.identities
        (provider_id, user_id, identity_data, provider,
         last_sign_in_at, created_at, updated_at)
      SELECT u.id::text, u.id,
             jsonb_build_object(
               'sub', u.id::text, 'email', u.email,
               'email_verified', true, 'phone_verified', false),
             'email', now(), now(), now()
      FROM auth.users u
      WHERE u.email IS NOT NULL AND u.email <> ''
        AND NOT EXISTS (
          SELECT 1 FROM auth.identities i
          WHERE i.user_id = u.id AND i.provider = 'email')
    `);

    process.stdout.write(
      `[repair-local-auth] coerced ${coerce.rowCount ?? 0} malformed auth.users row(s)\n` +
        `[repair-local-auth] backfilled ${ident.rowCount ?? 0} auth.identities row(s)\n` +
        `[repair-local-auth] done — re-run admin.listUsers to confirm 200.\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(
    `[repair-local-auth] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
