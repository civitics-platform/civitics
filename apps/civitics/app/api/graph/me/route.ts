import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// GET /api/graph/me
// Returns the signed-in user's followed entities as focus-ready shapes.
// Used by GraphPage to auto-anchor the graph on a user's network.
export async function GET() {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ entities: [] });
  }

  const { data: follows } = await supabase
    .from("user_follows")
    .select("entity_type, entity_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(5);

  if (!follows?.length) {
    return NextResponse.json({ entities: [] });
  }

  // .in() bounded (both lists): the user_follows read above is `.limit(5)`, so
  // the two type-split lists sum to 5 — FIX-902
  const officialIds = follows.filter((f: { entity_type: string }) => f.entity_type === "official").map((f: { entity_id: string }) => f.entity_id);
  const agencyIds = follows.filter((f: { entity_type: string }) => f.entity_type === "agency").map((f: { entity_id: string }) => f.entity_id);

  const [officialsRes, agenciesRes] = await Promise.all([
    officialIds.length
      ? supabase.from("officials").select("id, full_name, role_title, party, photo_url").in("id", officialIds)
      : Promise.resolve({ data: [] }),
    agencyIds.length
      ? supabase.from("agencies").select("id, name").in("id", agencyIds)
      : Promise.resolve({ data: [] }),
  ]);

  const officialMap = new Map<string, { id: string; full_name: string; role_title: string; party: string | null; photo_url: string | null }>(
    (officialsRes.data ?? []).map((o: { id: string; full_name: string; role_title: string; party: string | null; photo_url: string | null }) => [o.id, o])
  );
  const agencyMap = new Map<string, { id: string; name: string }>(
    (agenciesRes.data ?? []).map((a: { id: string; name: string }) => [a.id, a])
  );

  const entities = follows
    .map((f: { entity_type: string; entity_id: string }) => {
      if (f.entity_type === "official") {
        const o = officialMap.get(f.entity_id);
        if (!o) return null;
        return {
          id: o.id,
          name: o.full_name,
          type: "official" as const,
          role: o.role_title,
          party: o.party ?? undefined,
          photoUrl: o.photo_url ?? undefined,
          highlight: true,
        };
      }
      if (f.entity_type === "agency") {
        const a = agencyMap.get(f.entity_id);
        if (!a) return null;
        return {
          id: a.id,
          name: a.name,
          type: "agency" as const,
          highlight: true,
        };
      }
      return null;
    })
    .filter((e: unknown): e is NonNullable<typeof e> => e !== null);

  return NextResponse.json({ entities });
}
