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
    const entityId       = searchParams.get("entityId");
    const entityLabel    = searchParams.get("entityLabel");
    const groupId        = searchParams.get("groupId");
    const groupFilterRaw = searchParams.get("groupFilter");
    const groupNameParam = searchParams.get("groupName");
    const ring1    = searchParams.get("ring1") ?? "connection_types";
    const ring2    = searchParams.get("ring2") ?? "top_entities";
    const maxRing1 = parseInt(searchParams.get("maxRing1") ?? "8");
    const maxRing2 = parseInt(searchParams.get("maxRing2") ?? "10");

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

    // ── Helper: sort ring2 children by the selected mode ──────────────────
    function sortByRing2<T extends { value?: number }>(items: T[]): T[] {
      // by_count: future — use count field when available. For now same as by_amount.
      // top_entities / by_amount / by_count all sort value desc until count tracking lands.
      return [...items].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
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
          children: sortByRing2(
            conns.map((c) => {
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
          ).slice(0, maxRing2),
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

      // ── Group mode: donation_industries ─────────────────────────────────────
      if (ring1 === "donation_industries") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: sectorData, error: sectorError } = await (supabase as any).rpc("get_group_sector_totals", {
          p_member_ids: memberIds,
          p_min_usd: 0,
        }) as { data: Array<{ sector: string; total_usd: number }> | null; error: unknown };

        if (sectorError) console.error("[sunburst] group sector error:", sectorError);

        const children = (sectorData ?? [])
          .slice(0, maxRing1)
          .map((row) => ({
            name: row.sector,
            type: "donation",
            value: Math.round(row.total_usd),
            children: [] as Array<{ name: string; value: number; type: string }>,
          }));

        return NextResponse.json({
          name: groupNameParam ?? "Group",
          groupId,
          isGroup: true,
          children,
          meta: {
            ring1: "donation_industries",
            totalConnections: children.length,
            connectionTypes: children.map((c) => c.name),
          },
        });
      }

      // ── Fetch all group connections via RPC (avoids .in() URL limit) ─────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: groupConns, error: connsError } = await (supabase as any).rpc("get_group_connections", {
        p_member_ids: memberIds,
        p_limit: 500,
      }) as { data: Array<{ connection_type: string | null; to_id: string; strength: number; amount_cents: number | null; from_id: string }> | null; error: unknown };

      if (connsError) {
        console.error("[sunburst] group conns error:", (connsError as { message?: string }).message ?? connsError);
        return NextResponse.json({ name: groupNameParam ?? "Group", groupId, isGroup: true, children: [], meta: { totalConnections: 0, connectionTypes: [] } });
      }
      console.log("[sunburst] group conns:", groupConns?.length ?? 0);

      // ── Group mode: vote_categories ──────────────────────────────────────────
      if (ring1 === "vote_categories") {
        const voteTypes = new Set(["vote_yes", "vote_no", "vote_abstain", "nomination_vote_yes", "nomination_vote_no"]);
        const voteConns = (groupConns ?? []).filter((c) => voteTypes.has(c.connection_type ?? ""));

        const aggregatedVotes = new Map<string, { connection_type: string; to_id: string; strength: number; amount_cents: number }>();
        for (const conn of voteConns) {
          const key = `${conn.connection_type ?? "other"}::${conn.to_id}`;
          const existing = aggregatedVotes.get(key);
          if (existing) {
            existing.amount_cents += conn.amount_cents ?? 0;
            existing.strength = Math.max(existing.strength, conn.strength);
          } else {
            aggregatedVotes.set(key, {
              connection_type: conn.connection_type ?? "other",
              to_id: conn.to_id,
              strength: conn.strength,
              amount_cents: conn.amount_cents ?? 0,
            });
          }
        }

        const flatVoteConns = Array.from(aggregatedVotes.values());
        const proposalIds = [...new Set(flatVoteConns.map((c) => c.to_id))];
        const { data: proposals } = await supabase
          .from("proposals")
          .select("id, title")
          .in("id", proposalIds.slice(0, 100));

        const proposalMap = new Map((proposals ?? []).map((p) => [p.id, p.title]));

        const byType = new Map<string, typeof flatVoteConns>();
        for (const c of flatVoteConns) {
          const t = c.connection_type;
          if (!byType.has(t)) byType.set(t, []);
          byType.get(t)!.push(c);
        }

        const children = [...byType.entries()]
          .map(([type, conns]) => ({
            name: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            type,
            children: sortByRing2(
              conns.map((c) => ({
                name: proposalMap.get(c.to_id) ?? c.to_id,
                entityId: c.to_id,
                entityType: "proposal",
                value: c.amount_cents || Math.round(c.strength * 1_000_000),
                type,
              }))
            ).slice(0, maxRing2),
          }))
          .filter((c) => c.children.length > 0)
          .sort((a, b) => b.children.length - a.children.length)
          .slice(0, maxRing1);

        return NextResponse.json({
          name: groupNameParam ?? "Group",
          groupId,
          isGroup: true,
          children,
          meta: {
            ring1: "vote_categories",
            totalConnections: voteConns.length,
            connectionTypes: children.map((c) => c.name),
          },
        });
      }

      // ── Group mode: connection_types (default) ────────────────────────────────
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

    // ── MODE: donation_industries ──────────────────────────────────────────
    if (ring1 === "donation_industries") {
      const { data: donations } = await supabase
        .from("financial_relationships")
        .select("donor_name, amount_cents, metadata")
        .eq("official_id", entityId)
        .not("donor_name", "ilike", "%PAC/Committee%")
        .order("amount_cents", { ascending: false })
        .limit(200);

      const bySector = new Map<string, Array<{ name: string; value: number }>>();
      for (const d of donations ?? []) {
        const sector = (d.metadata as Record<string, string> | null)?.sector ?? "Other";
        if (!bySector.has(sector)) bySector.set(sector, []);
        bySector.get(sector)!.push({
          name: d.donor_name as string,
          value: ((d.amount_cents as number | null) ?? 0) / 100,
        });
      }

      const children = [...bySector.entries()]
        .map(([sector, donors]) => ({
          name: sector,
          type: "donation",
          children: sortByRing2(donors)
            .slice(0, maxRing2)
            .map(d => ({ name: d.name, value: d.value, type: "donation" })),
        }))
        .sort((a, b) => {
          const aTotal = a.children.reduce((s, c) => s + c.value, 0);
          const bTotal = b.children.reduce((s, c) => s + c.value, 0);
          return bTotal - aTotal;
        })
        .slice(0, maxRing1);

      return NextResponse.json({
        name: centerName,
        entityId,
        party: centerEntity?.party,
        role: centerEntity?.role_title,
        children,
        meta: { ring1: "donation_industries", totalConnections: donations?.length ?? 0 },
      });
    }

    // ── MODE: vote_categories ──────────────────────────────────────────────
    if (ring1 === "vote_categories") {
      const { data: votes } = await supabase
        .from("entity_connections")
        .select("connection_type, to_id, strength")
        .eq("from_id", entityId)
        .in("connection_type", ["vote_yes", "vote_no", "vote_abstain", "nomination_vote_yes", "nomination_vote_no"])
        .limit(200);

      const proposalIds = [...new Set((votes ?? []).map(v => v.to_id))];
      const { data: proposals } = await supabase
        .from("proposals")
        .select("id, title")
        .in("id", proposalIds);

      const proposalMap = new Map((proposals ?? []).map(p => [p.id, p.title]));

      const byType = new Map<string, typeof votes>();
      for (const v of votes ?? []) {
        const type = v.connection_type ?? "other";
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type)!.push(v);
      }

      const children = [...byType.entries()]
        .map(([type, voteList]) => ({
          name: type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
          type,
          children: sortByRing2(
            (voteList ?? []).map(v => ({
              name: proposalMap.get(v.to_id) ?? v.to_id,
              entityId: v.to_id,
              entityType: "proposal",
              value: Math.round(v.strength * 1_000_000),
              type,
            }))
          ).slice(0, maxRing2),
        }))
        .filter(c => c.children.length > 0)
        .sort((a, b) => b.children.length - a.children.length)
        .slice(0, maxRing1);

      return NextResponse.json({
        name: centerName,
        entityId,
        party: centerEntity?.party,
        role: centerEntity?.role_title,
        children,
        meta: { ring1: "vote_categories", totalConnections: votes?.length ?? 0 },
      });
    }

    // ── MODE: connection_types (default) ───────────────────────────────────
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
    const rawChildren = buildChildren(connections ?? [], nameMap);
    // Apply maxRing1 / maxRing2
    const children = rawChildren
      .slice(0, maxRing1)
      .map(c => ({ ...c, children: c.children.slice(0, maxRing2) }));

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
