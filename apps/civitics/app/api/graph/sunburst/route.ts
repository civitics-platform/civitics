import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import type { GroupFilter } from "@civitics/graph";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  try {
    const { searchParams } = new URL(req.url);
    const entityId      = searchParams.get("entityId");
    const entityLabel   = searchParams.get("entityLabel");
    const groupId       = searchParams.get("groupId");
    const groupFilterRaw = searchParams.get("groupFilter");
    const groupNameParam = searchParams.get("groupName");

    const supabase = createAdminClient();

    // ── Helper: resolve names for a list of to_ids ─────────────────────────
    async function buildNameMap(allToIds: string[]): Promise<Map<string, { name: string; entityType: string; party?: string }>> {
      const nameMap = new Map<string, { name: string; entityType: string; party?: string }>();
      if (allToIds.length === 0) return nameMap;

      const [officialsRes, proposalsRes, agenciesRes, financialRes] = await Promise.all([
        supabase.from("officials").select("id, full_name, party").in("id", allToIds),
        supabase.from("proposals").select("id, title").in("id", allToIds),
        supabase.from("agencies").select("id, name").in("id", allToIds),
        supabase.from("financial_entities").select("id, name, entity_type").in("id", allToIds),
      ]);

      for (const o of officialsRes.data ?? []) {
        nameMap.set(o.id, { name: o.full_name, entityType: "official", party: o.party ?? undefined });
      }
      for (const p of proposalsRes.data ?? []) {
        nameMap.set(p.id, { name: p.title, entityType: "proposal" });
      }
      for (const a of agenciesRes.data ?? []) {
        nameMap.set(a.id, { name: a.name, entityType: "agency" });
      }
      for (const f of financialRes.data ?? []) {
        nameMap.set(f.id, { name: f.name, entityType: f.entity_type ?? "financial" });
      }

      return nameMap;
    }

    // ── Helper: build children hierarchy from connections ──────────────────
    function buildChildren(
      connections: Array<{ connection_type: string | null; to_id: string; strength: number; amount_cents: number | null }>,
      nameMap: Map<string, { name: string; entityType: string; party?: string }>
    ) {
      const byType = new Map<string, typeof connections>();
      for (const conn of connections) {
        const type = conn.connection_type ?? "other";
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type)!.push(conn);
      }

      return Array.from(byType.entries())
        .map(([type, conns]) => ({
          name: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          type,
          children: conns
            .map((c) => {
              const entity = nameMap.get(c.to_id);
              return {
                name: entity?.name ?? c.to_id,
                entityId: c.to_id,
                entityType: entity?.entityType ?? "unknown",
                party: entity?.party,
                value: c.amount_cents ?? Math.round(c.strength * 1_000_000),
                type,
              };
            })
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
            .slice(0, 20),
        }))
        .filter((c) => c.children.length > 0)
        .sort((a, b) => {
          const aTotal = a.children.reduce((s, c) => s + (c.value ?? 0), 0);
          const bTotal = b.children.reduce((s, c) => s + (c.value ?? 0), 0);
          return bTotal - aTotal;
        });
    }

    // ── Group mode ─────────────────────────────────────────────────────────
    if (groupId && groupFilterRaw) {
      let groupFilter: GroupFilter | null = null;
      try {
        try {
          groupFilter = JSON.parse(decodeURIComponent(groupFilterRaw)) as GroupFilter;
        } catch {
          groupFilter = JSON.parse(groupFilterRaw) as GroupFilter;
        }
      } catch (e) {
        console.error("[sunburst] groupFilter parse error:", e);
      }

      if (!groupFilter) {
        return NextResponse.json({ error: "Invalid groupFilter" }, { status: 400 });
      }

      // Resolve member IDs via RPC
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: memberData, error: memberError } = await (supabase as any).rpc("get_officials_by_filter", {
        p_chamber: groupFilter.chamber ?? null,
        p_party:   groupFilter.party   ?? null,
        p_state:   groupFilter.state   ?? null,
      }) as { data: Array<{ id: string }> | null; error: unknown };

      if (memberError) console.error("[sunburst] getMemberIds error:", memberError);
      const memberIds = (memberData ?? []).map((m: { id: string }) => m.id);

      if (memberIds.length === 0) {
        return NextResponse.json({ name: groupNameParam ?? "Group", groupId, isGroup: true, children: [], meta: { totalConnections: 0, connectionTypes: [] } });
      }

      const { data: groupConns, error: connsError } = await supabase
        .from("entity_connections")
        .select("connection_type, to_id, strength, amount_cents, from_id")
        .in("from_id", memberIds)
        .limit(500);

      if (connsError) {
        console.error("[sunburst] group conns error:", connsError.message);
        return NextResponse.json({ name: groupNameParam ?? "Group", groupId, isGroup: true, children: [], meta: { totalConnections: 0, connectionTypes: [] } });
      }

      // Aggregate to_id totals per connection_type
      const aggregated = new Map<string, { connection_type: string | null; to_id: string; strength: number; amount_cents: number | null }>();
      for (const conn of groupConns ?? []) {
        const key = `${conn.connection_type ?? "other"}::${conn.to_id}`;
        const existing = aggregated.get(key);
        if (existing) {
          existing.amount_cents = (existing.amount_cents ?? 0) + (conn.amount_cents ?? 0);
          existing.strength = Math.max(existing.strength, conn.strength);
        } else {
          aggregated.set(key, { ...conn });
        }
      }

      const flatConns = Array.from(aggregated.values());
      const allToIds = [...new Set(flatConns.map((c) => c.to_id))];
      const nameMap = await buildNameMap(allToIds);
      const children = buildChildren(flatConns, nameMap);

      return NextResponse.json({
        name: groupNameParam ?? "Group",
        groupId,
        isGroup: true,
        children,
        meta: {
          totalConnections: groupConns?.length ?? 0,
          connectionTypes: children.map((c) => c.name),
        },
      });
    }

    // ── Individual mode ────────────────────────────────────────────────────
    if (!entityId) {
      return NextResponse.json({ error: "entityId or groupId required" }, { status: 400 });
    }

    // Look up the center entity's own name
    const { data: centerEntity } = await supabase
      .from("officials")
      .select("full_name, party, role_title")
      .eq("id", entityId)
      .single();

    const centerName = centerEntity?.full_name ?? entityLabel ?? entityId;

    const { data: connections, error } = await supabase
      .from("entity_connections")
      .select("connection_type, to_id, strength, amount_cents")
      .eq("from_id", entityId)
      .limit(200);

    if (error) {
      console.error("[sunburst]", error.message);
      return NextResponse.json({ name: centerName, entityId, entityType: "official", children: [], meta: { totalConnections: 0, connectionTypes: [] } });
    }

    const allToIds = [...new Set((connections ?? []).map((c) => c.to_id))];
    const nameMap = await buildNameMap(allToIds);
    const children = buildChildren(connections ?? [], nameMap);

    return NextResponse.json({
      name: centerName,
      entityId,
      entityType: "official",
      party: centerEntity?.party ?? undefined,
      role: centerEntity?.role_title ?? undefined,
      children,
      meta: {
        totalConnections: connections?.length ?? 0,
        connectionTypes: children.map((c) => c.name),
      },
    });
  } catch (e) {
    console.error("[sunburst]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
