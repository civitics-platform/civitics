import { NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";

export const revalidate = 600; // Chord data changes rarely — cache 10 minutes at edge

type FlowRow = {
  industry: string;
  display_label: string;
  display_icon: string;
  party_chamber: string;
  total_cents: number;
  official_count: number;
  donor_count: number;
};

function labelFor(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (createAdminClient() as any).rpc("chord_industry_flows");

    if (error) {
      console.error("[chord] RPC error:", error.message);
      return NextResponse.json({ groups: [], recipients: [], matrix: [], top_flows: [], total_flow_usd: 0 });
    }

    const rows = (data ?? []) as FlowRow[];

    const industryMap = new Map<string, { label: string; icon: string; total: number; donors: number }>();
    const partyMap = new Map<string, { total: number; officials: number }>();
    const flowMatrix = new Map<string, Map<string, number>>();
    let totalFlow = 0;
    let untaggedFlow = 0;

    for (const row of rows) {
      const usd = Number(row.total_cents) / 100;
      totalFlow += usd;

      if (row.industry === "untagged") {
        untaggedFlow += usd;
        continue;
      }

      const ig = industryMap.get(row.industry) ?? {
        label: row.display_label || labelFor(row.industry),
        icon: row.display_icon || "🏢",
        total: 0,
        donors: 0,
      };
      ig.total += usd;
      ig.donors += Number(row.donor_count);
      industryMap.set(row.industry, ig);

      const pg = partyMap.get(row.party_chamber) ?? { total: 0, officials: 0 };
      pg.total += usd;
      pg.officials += Number(row.official_count);
      partyMap.set(row.party_chamber, pg);

      if (!flowMatrix.has(row.industry)) flowMatrix.set(row.industry, new Map());
      const pm = flowMatrix.get(row.industry)!;
      pm.set(row.party_chamber, (pm.get(row.party_chamber) ?? 0) + usd);
    }

    const groups = [...industryMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({
        id,
        label: v.label,
        icon: v.icon,
        total_usd: Math.round(v.total),
        pac_count: v.donors,
      }));

    const recipients = [...partyMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({
        id,
        label: id,
        total_received_usd: Math.round(v.total),
        official_count: v.officials,
      }));

    const groupIds = groups.map((g) => g.id);
    const recipientIds = recipients.map((r) => r.id);

    const matrix: number[][] = groupIds.map((gid) =>
      recipientIds.map((rid) => Math.round(flowMatrix.get(gid)?.get(rid) ?? 0)),
    );

    const topFlows: { from: string; to: string; amount_usd: number }[] = [];
    for (const [ind, pm] of flowMatrix)
      for (const [party, usd] of pm)
        topFlows.push({ from: labelFor(ind), to: party, amount_usd: Math.round(usd) });
    topFlows.sort((a, b) => b.amount_usd - a.amount_usd);

    return NextResponse.json({
      groups,
      recipients,
      matrix,
      top_flows: topFlows.slice(0, 10),
      total_flow_usd: Math.round(totalFlow),
      untagged_flow_usd: Math.round(untaggedFlow),
    });
  } catch (e) {
    console.error("[chord]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
