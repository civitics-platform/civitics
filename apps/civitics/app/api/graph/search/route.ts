import { createAdminClient, fetchIndustryTagsByEntityId } from "@civitics/db";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";

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
  if (q.length < 2) return withPublicCdnCache(Response.json([]));

  const supabase = createAdminClient();

  // search_graph_entities RPC was retired in the shadow→public promotion.
  // Direct ILIKE queries across the four entity tables; results merged below.
  const like = `%${q}%`;
  const [officialsRes, agenciesRes, financialRes, proposalsRes] = await Promise.all([
    withDbTimeout(
      supabase
        .from("officials")
        .select("id, full_name, role_title, party")
        .ilike("full_name", like)
        .limit(20),
    ),
    withDbTimeout(
      supabase
        .from("agencies")
        .select("id, name, acronym, agency_type")
        .or(`name.ilike.${like},acronym.ilike.${like}`)
        .limit(20),
    ),
    withDbTimeout(
      supabase
        .from("financial_entities")
        // FIX-503: scope to non-individuals so the partial display_name trgm
        // index serves this ILIKE instead of a seq scan (prod cost 219k→27).
        .select("id, display_name, entity_type")
        .neq("entity_type", "individual")
        .ilike("display_name", like)
        .limit(20),
    ),
    withDbTimeout(
      supabase
        .from("proposals")
        .select("id, title, type")
        .ilike("title", like)
        .limit(20),
    ),
  ]);

  type OfficialRow = { id: string; full_name: string; role_title: string | null; party: string | null };
  type AgencyRow = { id: string; name: string; acronym: string | null; agency_type: string | null };
  type FinancialRow = { id: string; display_name: string; entity_type: string | null };
  type ProposalRow = { id: string; title: string; type: string | null };

  const financialRows = ((financialRes as { data: FinancialRow[] | null }).data ?? []);
  const industryByEntityId = await fetchIndustryTagsByEntityId(
    supabase,
    financialRows.map((f) => f.id),
  );

  const rows: SearchRow[] = [];
  for (const o of ((officialsRes as { data: OfficialRow[] | null }).data ?? [])) {
    rows.push({ id: o.id, label: o.full_name, entity_type: "official", subtitle: o.role_title, party: o.party });
  }
  for (const a of ((agenciesRes as { data: AgencyRow[] | null }).data ?? [])) {
    rows.push({
      id: a.id,
      label: a.acronym ? `${a.acronym} — ${a.name}` : a.name,
      entity_type: "agency",
      subtitle: a.agency_type,
      party: null,
    });
  }
  for (const f of financialRows) {
    rows.push({
      id: f.id,
      label: f.display_name,
      entity_type: "financial_entity",
      subtitle: industryByEntityId.get(f.id)?.display_label ?? f.entity_type,
      party: null,
    });
  }
  for (const p of ((proposalsRes as { data: ProposalRow[] | null }).data ?? [])) {
    rows.push({ id: p.id, label: p.title, entity_type: "proposal", subtitle: p.type, party: null });
  }

  // Attach connection counts for all result entities
  const allIds = rows.map((r) => r.id);
  if (allIds.length === 0) return withPublicCdnCache(Response.json([]));

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

  return withPublicCdnCache(Response.json(results));
}
