import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

interface SearchRow {
  id: string;
  label: string;
  entity_type: string;
  subtitle: string | null;
  party: string | null;
}

export async function GET(req: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json([]);

  const supabase = createAdminClient();

  // Single RPC call: fuzzy (trigram + ILIKE) across officials, agencies,
  // proposals, and financial_entities. Fetch 20 per type so ranking has room.
  const { data, error } = await supabase.rpc("search_graph_entities", {
    q,
    lim: 20,
  });

  if (error) {
    console.error("[graph/search] RPC error:", error.message);
    return Response.json([], { status: 500 });
  }

  const rows = (data ?? []) as SearchRow[];

  // Attach connection counts for all result entities
  const allIds = rows.map((r) => r.id);
  if (allIds.length === 0) return Response.json([]);

  const [fromRes, toRes] = await Promise.all([
    supabase.from("entity_connections").select("from_id").in("from_id", allIds),
    supabase.from("entity_connections").select("to_id").in("to_id", allIds),
  ]);

  const countMap = new Map<string, number>();
  for (const r of fromRes.data ?? []) countMap.set(r.from_id, (countMap.get(r.from_id) ?? 0) + 1);
  for (const r of toRes.data ?? []) countMap.set(r.to_id, (countMap.get(r.to_id) ?? 0) + 1);

  // Identify federal officials (have a congress_gov source ID) so they rank
  // above state legislators regardless of alphabetical order.
  const officialIds = rows.filter((r) => r.entity_type === "official").map((r) => r.id);
  const federalIds = new Set<string>();
  if (officialIds.length > 0) {
    const { data: offData } = await supabase
      .from("officials")
      .select("id, source_ids")
      .in("id", officialIds);
    for (const o of (offData ?? []) as { id: string; source_ids: Record<string, string> | null }[]) {
      if (o.source_ids?.["congress_gov"]) federalIds.add(o.id);
    }
  }

  const qLower = q.toLowerCase();

  const results = rows
    .map((r) => ({
      id: r.id,
      label: r.label,
      type: r.entity_type as "official" | "agency" | "proposal" | "financial_entity",
      subtitle: r.subtitle ?? undefined,
      party: r.party ?? undefined,
      connectionCount: countMap.get(r.id) ?? 0,
    }))
    .sort((a, b) => {
      const priority = (r: (typeof results)[0]): number => {
        const name = r.label.toLowerCase();
        if (name === qLower) return 0;
        const lastName = (r.label.split(" ").pop() ?? "").toLowerCase();
        if (lastName === qLower) return 1;
        if (name.startsWith(qLower)) return 2;
        const isFederal = r.type === "official" && federalIds.has(r.id);
        if (isFederal && r.connectionCount > 0) return 3;
        if (isFederal) return 4;
        if (r.connectionCount > 0) return 5;
        return 6;
      };
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      if (b.connectionCount !== a.connectionCount) return b.connectionCount - a.connectionCount;
      return a.label.localeCompare(b.label);
    });

  return Response.json(results);
}
