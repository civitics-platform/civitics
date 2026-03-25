import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  try {
    const { searchParams } = new URL(req.url);
    const entityId = searchParams.get("entityId");

    if (!entityId) {
      return NextResponse.json({ error: "entityId required" }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Get entity connections grouped by type
    const { data: connections, error } = await supabase
      .from("entity_connections")
      .select("connection_type, to_id, strength, amount_cents")
      .eq("from_id", entityId)
      .limit(200);

    if (error) {
      console.error("[sunburst]", error.message);
      return NextResponse.json({ name: entityId, children: [] });
    }

    // Group by connection type
    const byType = new Map<string, NonNullable<typeof connections>>();
    for (const conn of connections ?? []) {
      const type = conn.connection_type ?? "other";
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(conn);
    }

    const children = Array.from(byType.entries()).map(([type, conns]) => ({
      name: type.replace(/_/g, " "),
      type,
      children: conns.map((c) => ({
        name: c.to_id,
        value: c.amount_cents ?? Math.round(c.strength * 1_000_000),
      })),
    }));

    return NextResponse.json({ name: entityId, children });
  } catch (e) {
    console.error("[sunburst]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
