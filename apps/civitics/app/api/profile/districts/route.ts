import { NextResponse } from "next/server";
import { createAdminClient, noStoreFetch } from "@civitics/db";

export const dynamic = "force-dynamic";

// GET /api/profile/districts?state=CO
// Returns sorted House district numbers for a given state abbreviation.
// Used by the district picker UI to populate the CD dropdown.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get("state");

  if (!state || state.length !== 2) {
    return NextResponse.json({ error: "state param required (2-char abbr)" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient({ fetch: noStoreFetch }) as any;

  const { data } = await supabase
    .from("officials")
    .select("metadata")
    .eq("is_active", true)
    .ilike("role_title", "%Representative%")
    .filter("metadata->>state_abbr", "eq", state.toUpperCase());

  const districts = [
    ...new Set<number>(
      (data ?? [])
        .map((o: { metadata: Record<string, unknown> }) =>
          parseInt(o.metadata?.district as string, 10)
        )
        .filter((d: number) => !isNaN(d) && d > 0)
    ),
  ].sort((a: number, b: number) => a - b);

  return NextResponse.json({ districts });
}
