import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

interface TreemapRow {
  official_id: string;
  official_name: string;
  party: string;
  state: string;
  chamber: string;
  total_donated_cents: number;
}

export interface DonorRow {
  donor_id: string;
  donor_name: string;
  industry_category: string;
  amount_usd: number;
  entity_type: string;
}

export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const supabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const entityId = searchParams.get("entityId");

  // ── Entity mode: donors for one official ─────────────────────────────────
  if (entityId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("financial_relationships")
      .select("financial_entities!inner(id, name, industry_category, entity_type), amount_cents")
      .eq("official_id", entityId)
      .order("amount_cents", { ascending: false })
      .limit(100) as {
        data: Array<{
          financial_entities: { id: string; name: string; industry_category: string | null; entity_type: string | null } | null;
          amount_cents: number;
        }> | null;
        error: { message: string } | null;
      };

    if (error) {
      console.error("[graph/treemap/entity] query error:", error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows: DonorRow[] = (data ?? []).map((row) => {
      const fe = row.financial_entities;
      return {
        donor_id:          fe?.id ?? "",
        donor_name:        fe?.name ?? "Unknown",
        industry_category: fe?.industry_category ?? "Other",
        amount_usd:        Number(row.amount_cents) / 100,
        entity_type:       fe?.entity_type ?? "pac",
      };
    });

    return Response.json(rows);
  }

  // ── Aggregate mode: all officials by party / chamber ─────────────────────
  // groupBy and sizeBy are accepted for API compatibility and passed to the client.
  // Actual grouping is done client-side in TreemapGraph; chamber data is always returned.
  void searchParams.get("groupBy");  // accepted, used client-side
  void searchParams.get("sizeBy");   // accepted, used client-side

  const { data, error } = await supabase.rpc("treemap_officials_by_donations", {
    lim: 200,
  });

  if (error) {
    console.error("[graph/treemap] RPC error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json((data ?? []) as TreemapRow[]);
}
