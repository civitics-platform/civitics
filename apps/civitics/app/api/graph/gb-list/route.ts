/**
 * GET /api/graph/gb-list — FIX-493 (FIX-468 Wave B)
 *
 * Returns the browseable state-level legislature chambers: every slugged,
 * active legislature_upper/lower/unicameral governing body in a state,
 * federal_district, or unincorporated_territory jurisdiction. Powers the
 * People → Officials → State legislatures browse list; each entry seeds a
 * gb-backed group via the FIX-490 governingBody route path.
 *
 * Entries are derived AT RUNTIME from governing_bodies (decision 6) — never
 * from a hardcoded UUID or slug table, so the FIX-489/548 unicameral
 * conversions (and any future re-shapes) flow through without a code change.
 * Federal chambers (country jurisdiction) are excluded — Congress has its own
 * preset groups in the browse tree.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export interface GbListItem {
  slug: string;
  name: string;
  shortName: string | null;
  type: "legislature_upper" | "legislature_lower" | "legislature_unicameral";
  stateAbbr: string | null;
  stateName: string;
}

interface GbRow {
  slug: string | null;
  name: string;
  short_name: string | null;
  type: GbListItem["type"];
  jurisdictions: { name: string; short_name: string | null; type: string } | null;
}

// Upper before lower; a unicameral chamber is the jurisdiction's only entry.
const CHAMBER_RANK: Record<GbListItem["type"], number> = {
  legislature_upper: 0,
  legislature_lower: 1,
  legislature_unicameral: 0,
};

export async function GET() {
  if (supabaseUnavailable()) return unavailableResponse();

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("governing_bodies")
    .select("slug, name, short_name, type, jurisdictions!inner(name, short_name, type)")
    .in("type", ["legislature_upper", "legislature_lower", "legislature_unicameral"])
    .in("jurisdictions.type", ["state", "federal_district", "unincorporated_territory"])
    .eq("is_active", true)
    .not("slug", "is", null)
    .order("name");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items: GbListItem[] = ((data ?? []) as unknown as GbRow[])
    .filter((g): g is GbRow & { slug: string } => Boolean(g.slug) && g.jurisdictions != null)
    .map((g) => ({
      slug: g.slug,
      name: g.name,
      shortName: g.short_name,
      type: g.type,
      stateAbbr: g.jurisdictions?.short_name ?? null,
      stateName: g.jurisdictions?.name ?? "",
    }))
    .sort(
      (a, b) =>
        a.stateName.localeCompare(b.stateName) || CHAMBER_RANK[a.type] - CHAMBER_RANK[b.type],
    );

  return NextResponse.json({ governingBodies: items });
}
