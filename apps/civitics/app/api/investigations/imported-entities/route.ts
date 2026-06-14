// Investigations MVP PR2 (FIX-580) — additive read route for the tier-2
// (imported_entity) citation picker. /api/search doesn't expose primary_source or
// let callers filter to imported third-party network nodes, and the
// investigation_citation_target_exists() validator only accepts a financial_entity
// whose primary_source is 'littlesis' or 'icij'. Rather than touch PR1's schema or
// the search route, this small route searches exactly that set. Read-only, public
// (the underlying entities are already public).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// Mirrors the validator in 20260614000100_investigations_foundation.sql.
const IMPORTED_SOURCES = ["littlesis", "icij"] as const;

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim();
    const limit = Math.min(20, Math.max(1, parseInt(sp.get("limit") ?? "", 10) || 8));
    if (q.length < 2) return NextResponse.json({ results: [] });

    const db = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db2 = db as any;

    const { data, error } = await db2
      .from("financial_entities")
      .select("id, display_name, entity_type, primary_source")
      .in("primary_source", IMPORTED_SOURCES)
      .ilike("canonical_name", `%${q}%`)
      .limit(limit);

    if (error) {
      return NextResponse.json({ error: "Search failed", results: [] }, { status: 500 });
    }

    const results = (data ?? []).map(
      (r: { id: string; display_name: string; entity_type: string; primary_source: string }) => ({
        id: r.id,
        name: r.display_name,
        entity_type: r.entity_type,
        source: r.primary_source,
      }),
    );
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: "Search failed", results: [] }, { status: 500 });
  }
}
