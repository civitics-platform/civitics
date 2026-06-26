/**
 * FIX-659: Local auth test harness — mint a logged-in local session.
 *
 * WHAT THIS DOES
 *   Mints a real, signed-in Supabase session on the LOCAL stack without going
 *   through the captcha-gated OTP send. Authenticated UI branches (the
 *   verified-constituent lens from FIX-574, claim/verification flows, etc.)
 *   could not be exercised locally because:
 *     1. local [auth.captcha] now holds the REAL Turnstile secret, so a
 *        scripted/headless signInWithOtp/signUp send carries no valid token
 *        and fails; and
 *     2. the seeded aaaaaaaa-* users 500 on admin generateLink ("Database
 *        error finding user") — they are public.users rows without complete
 *        GoTrue auth.users/auth.identities.
 *
 *   This harness sidesteps both via the captcha-FREE admin path:
 *     admin.createUser({ email_confirm: true })   // fresh, GoTrue-complete
 *       -> admin.generateLink({ type: "magiclink" })  // returns a hashed_token
 *       -> the app's own /auth/confirm route runs verifyOtp(type="email")
 *          and sets the @supabase/ssr cookies -> logged in.
 *   Captcha is enforced on the SEND endpoints, NOT on admin generateLink or on
 *   verifyOtp — confirmed locally with the real secret in place. A magiclink
 *   hash verifies as type="email" (already in /auth/confirm's accepted union),
 *   so NO app change is required.
 *
 * HOW TO RUN (LOCAL ONLY)
 *   # default: a constituent-test identity, lands on /
 *   pnpm --filter @civitics/data data:auth:mint
 *
 *   # verified constituent of a jurisdiction (the FIX-574-class need)
 *   pnpm --filter @civitics/data data:auth:mint -- --grant-constituent <jurisdiction_uuid>
 *
 *   # land on a specific path after login
 *   pnpm --filter @civitics/data data:auth:mint -- --next /jurisdictions/<id>
 *
 *   # alt output: raw access/refresh tokens for setSession-style API tests
 *   pnpm --filter @civitics/data data:auth:mint -- --tokens
 *
 *   Then navigate a browser (or headless Chrome) to the printed /auth/confirm
 *   URL against a running `pnpm dev` (http://127.0.0.1:3000). The app's route
 *   sets the SSR cookies and you are signed in.
 *
 * SAFETY
 *   LOCAL-ONLY. It mints real sessions, so pointing it at prod must be
 *   impossible: it asserts NEXT_PUBLIC_SUPABASE_URL is a 127.0.0.1/localhost
 *   address and exits nonzero otherwise, AND it builds on createAdminClient()
 *   which independently refuses non-local URLs. NEVER imported by app runtime.
 *
 * Flags:
 *   --email <addr>                override the email (default harness+<role>@civitics.test)
 *   --role <name>                 identity label baked into the default email (default "constituent")
 *   --next <path>                 post-login redirect path (default "/")
 *   --grant-constituent <jid>     insert an active constituent entity_grant for <jurisdiction uuid>
 *   --tokens                      print access/refresh tokens instead of a /auth/confirm URL
 */

import { createAdminClient, createPublicClient } from "@civitics/db";

const APP_ORIGIN = "http://127.0.0.1:3000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function assertLocal(url: string | undefined): asserts url is string {
  const ok = !!url && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
  if (!ok) {
    process.stderr.write(
      `[mint-local-session] REFUSING to run — NEXT_PUBLIC_SUPABASE_URL is not local.\n` +
        `[mint-local-session]   got: ${url ?? "<unset>"}\n` +
        `[mint-local-session] This tool mints real sessions and is LOCAL-ONLY.\n` +
        `[mint-local-session] Switch back to local: Copy-Item .env.local.dev .env.local\n`,
    );
    process.exit(1);
  }
}

// generateLink (magiclink) returns the resolved user object for an existing
// user. We use it to recover the user id on the reuse path — admin.listUsers
// is unusable locally ("Database error finding users") because the corrupt
// aaaaaaaa-* seed rows poison pagination. The hash from this call is discarded;
// the output path mints its own fresh link. Returns the user id, or null.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recoverUserId(admin: any, email: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  return data?.user?.id ?? null;
}

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  assertLocal(url);
  process.stderr.write(`[mint-local-session] target: ${url} (local) — minting a real session\n`);

  const role = arg("role") ?? "constituent";
  const email = (arg("email") ?? `harness+${role}@civitics.test`).toLowerCase();
  const next = arg("next") ?? "/";
  const grantJid = arg("grant-constituent");
  const tokensMode = flag("tokens");

  if (grantJid && !UUID_RE.test(grantJid)) {
    process.stderr.write(`[mint-local-session] --grant-constituent must be a UUID, got: ${grantJid}\n`);
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // 1. Ensure the user exists (idempotent on the harness email namespace).
  let userId: string | undefined;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (createErr) {
    if (createErr.code === "email_exists" || createErr.status === 422) {
      const found = await recoverUserId(admin, email);
      if (!found) {
        process.stderr.write(`[mint-local-session] user ${email} exists but could not be looked up\n`);
        process.exit(1);
      }
      userId = found;
      process.stderr.write(`[mint-local-session] reusing existing user ${userId} (${email})\n`);
    } else {
      process.stderr.write(`[mint-local-session] createUser error: ${createErr.message ?? createErr}\n`);
      process.exit(1);
    }
  } else {
    userId = created?.user?.id;
    process.stderr.write(`[mint-local-session] created user ${userId} (${email})\n`);
  }

  // 2. Ensure a public.users profile row. /auth/confirm (unlike /auth/callback)
  //    does NOT upsert one, and entity_grants.user_id FKs to public.users — so
  //    the row must exist before granting, and authed surfaces that read
  //    public.users want it regardless. Mirrors /auth/callback's upsert shape.
  if (userId) {
    const { error: profileErr } = await admin.from("users").upsert(
      {
        id: userId,
        email,
        auth_provider: "email",
        last_seen: new Date().toISOString(),
      },
      { onConflict: "id", ignoreDuplicates: false },
    );
    if (profileErr) {
      process.stderr.write(`[mint-local-session] users upsert error: ${profileErr.message ?? profileErr}\n`);
      process.exit(1);
    }
  }

  // 3. Optional: grant an active constituent entity_grant for a jurisdiction.
  if (grantJid && userId) {
    const { data: jur } = await admin
      .from("jurisdictions")
      .select("id, name")
      .eq("id", grantJid)
      .maybeSingle();
    if (!jur) {
      process.stderr.write(
        `[mint-local-session] WARNING: no jurisdiction ${grantJid} found locally — granting anyway (target_id has no FK)\n`,
      );
    }

    const { data: existingGrant } = await admin
      .from("entity_grants")
      .select("id")
      .eq("user_id", userId)
      .eq("role", "constituent")
      .eq("target_type", "jurisdiction")
      .eq("target_id", grantJid)
      .eq("status", "active")
      .maybeSingle();

    if (existingGrant) {
      process.stderr.write(`[mint-local-session] active constituent grant already present (${existingGrant.id})\n`);
    } else {
      const nowIso = new Date().toISOString();
      const { data: grant, error: grantErr } = await admin
        .from("entity_grants")
        .insert({
          user_id: userId,
          target_type: "jurisdiction",
          target_id: grantJid,
          role: "constituent",
          status: "active",
          granted_at: nowIso,
          expires_at: null,
          metadata: { source: "mint-local-session", harness: true },
        })
        .select("id")
        .single();
      if (grantErr) {
        process.stderr.write(`[mint-local-session] grant insert error: ${grantErr.message ?? grantErr}\n`);
        process.exit(1);
      }
      process.stderr.write(
        `[mint-local-session] granted constituent of ${grantJid}${jur?.name ? ` (${jur.name})` : ""} — grant ${grant.id}\n`,
      );
    }
  }

  // 4a. --tokens mode: consume a fresh link server-side, print tokens.
  //     A token_hash is single-use, so this link feeds tokens ONLY (the URL
  //     mode below generates its own fresh link).
  if (tokensMode) {
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr || !link?.properties?.hashed_token) {
      process.stderr.write(`[mint-local-session] generateLink error: ${linkErr?.message ?? "no hashed_token"}\n`);
      process.exit(1);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pub = createPublicClient() as any;
    const { data: verified, error: vErr } = await pub.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "email",
    });
    if (vErr || !verified?.session) {
      process.stderr.write(`[mint-local-session] verifyOtp error: ${vErr?.message ?? "no session"}\n`);
      process.exit(1);
    }
    process.stderr.write(`[mint-local-session] tokens for ${email} (user ${userId}):\n`);
    console.log(
      JSON.stringify(
        {
          user_id: userId,
          email,
          access_token: verified.session.access_token,
          refresh_token: verified.session.refresh_token,
          expires_at: verified.session.expires_at,
        },
        null,
        2,
      ),
    );
    return;
  }

  // 4b. Default: print a ready-to-navigate /auth/confirm URL (token unconsumed).
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !link?.properties?.hashed_token) {
    process.stderr.write(`[mint-local-session] generateLink error: ${linkErr?.message ?? "no hashed_token"}\n`);
    process.exit(1);
  }

  const confirmUrl = new URL(`${APP_ORIGIN}/auth/confirm`);
  confirmUrl.searchParams.set("token_hash", link.properties.hashed_token);
  confirmUrl.searchParams.set("type", "email"); // magiclink hash verifies as "email"
  confirmUrl.searchParams.set("next", next.startsWith("/") ? next : "/");

  process.stderr.write(
    `[mint-local-session] navigate the running local dev server (pnpm dev) to:\n`,
  );
  console.log(confirmUrl.toString());
}

main().catch((err) => {
  process.stderr.write(`[mint-local-session] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
