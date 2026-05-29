import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/constituent-status?jurisdiction_id=<uuid>
//   → { signedIn: false }
//   → { signedIn: true, verified: boolean, expiresAt: string|null, grantedAt: string|null }
//
// Backs the VerifyConstituentSection client island on /jurisdictions/[id]. The
// page itself is statically rendered (ISR); per-user constituent state is read
// here at request time. RLS (users_read_own_grants) scopes entity_grants to the
// signed-in user, so no admin client is needed.
export async function GET(request: NextRequest) {
  const jurisdictionId = request.nextUrl.searchParams.get("jurisdiction_id");
  if (!jurisdictionId || !UUID_RE.test(jurisdictionId)) {
    return NextResponse.json({ error: "valid jurisdiction_id required" }, { status: 400 });
  }

  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ signedIn: false });
  }

  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("entity_grants")
    .select("granted_at, expires_at")
    .eq("user_id", user.id)
    .eq("role", "constituent")
    .eq("target_type", "jurisdiction")
    .eq("target_id", jurisdictionId)
    .eq("status", "active")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("granted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    signedIn: true,
    verified: !!data,
    expiresAt: data?.expires_at ?? null,
    grantedAt: data?.granted_at ?? null,
  });
}
