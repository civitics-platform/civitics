import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/officials/claim-status?official_id=<uuid>
//   → { signedIn: false }
//   → { signedIn: true, status: 'none'|'pending'|'active'|'revoked'|'expired',
//       expiresAt: string|null, grantedAt: string|null }
//
// FIX-558: backs the ClaimProfileSection client island on /officials/[id].
// The page is ISR (5-min revalidate); per-user claim state is read here at
// request time. RLS (users_read_own_grants) scopes entity_grants to the
// signed-in user, so no admin client is needed. Mirrors
// /api/constituent-status. Returns the LATEST claim's status — a rejected
// (revoked) claim followed by a fresh pending one reads as pending.
export async function GET(request: NextRequest) {
  const officialId = request.nextUrl.searchParams.get("official_id");
  if (!officialId || !UUID_RE.test(officialId)) {
    return NextResponse.json({ error: "valid official_id required" }, { status: 400 });
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

  const { data } = await supabase
    .from("entity_grants")
    .select("status, granted_at, expires_at, created_at")
    .eq("user_id", user.id)
    .eq("role", "official")
    .eq("target_type", "official")
    .eq("target_id", officialId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    signedIn: true,
    status: data?.status ?? "none",
    expiresAt: data?.expires_at ?? null,
    grantedAt: data?.granted_at ?? null,
  });
}
