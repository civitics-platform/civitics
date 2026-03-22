"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@civitics/db";
import { ForceGraph } from "@civitics/graph";
import type { GraphNodeV2 as GraphNode, GraphEdgeV2 as GraphEdge } from "@civitics/graph";

type ConnectionRow = {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  connection_type: string;
  strength: number;
  amount_cents: number | null;
  occurred_at: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any> | null;
};

function PlaceholderNodes() {
  const positions = [
    { cx: "30%", cy: "35%", r: 18, delay: "0s" },
    { cx: "65%", cy: "25%", r: 14, delay: "0.4s" },
    { cx: "75%", cy: "60%", r: 16, delay: "0.8s" },
    { cx: "45%", cy: "70%", r: 12, delay: "1.2s" },
    { cx: "20%", cy: "65%", r: 14, delay: "0.6s" },
  ];
  return (
    <svg className="absolute inset-0 h-full w-full opacity-20" aria-hidden>
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50%       { transform: translateY(-8px); }
        }
      `}</style>
      {positions.map((p, i) => (
        <g key={i} style={{ animation: `float 3s ease-in-out ${p.delay} infinite` }}>
          <circle cx={p.cx} cy={p.cy} r={p.r} fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.5" />
        </g>
      ))}
      <line x1="30%" y1="35%" x2="65%" y2="25%" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4,3" />
      <line x1="65%" y1="25%" x2="75%" y2="60%" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4,3" />
      <line x1="30%" y1="35%" x2="20%" y2="65%" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4,3" />
      <line x1="75%" y1="60%" x2="45%" y2="70%" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4,3" />
    </svg>
  );
}

/** Map old DB entity type strings to new NodeType values */
function mapNodeType(t: string): GraphNode["type"] {
  if (t === "official")      return "official";
  if (t === "proposal")      return "proposal";
  if (t === "corporation")   return "corporation";
  if (t === "pac")           return "pac";
  if (t === "individual")    return "individual";
  if (t === "organization")  return "organization";
  return "agency"; // covers governing_body + agency
}

export function AgencyGraph({
  agencyId,
  agencyName,
}: {
  agencyId: string;
  agencyName: string;
}) {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const supabase = createBrowserClient();

    supabase
      .from("entity_connections")
      .select("id, from_type, from_id, to_type, to_id, connection_type, strength, amount_cents, occurred_at, metadata")
      .or(`from_id.eq.${agencyId},to_id.eq.${agencyId}`)
      .limit(200)
      .then(({ data }) => {
        if (cancelled) return;

        const rows = (data ?? []) as ConnectionRow[];
        const nodeMap = new Map<string, GraphNode>();
        const edgeList: GraphEdge[] = [];

        // Central node
        nodeMap.set(agencyId, {
          id:   agencyId,
          type: "agency",
          name: agencyName,
        });

        for (const c of rows) {
          const isFrom   = c.from_id === agencyId;
          const peerId   = isFrom ? c.to_id   : c.from_id;
          const peerType = isFrom ? c.to_type : c.from_type;
          const meta     = c.metadata ?? {};

          if (!nodeMap.has(peerId)) {
            nodeMap.set(peerId, {
              id:   peerId,
              type: mapNodeType(peerType),
              name: (meta["name"] as string) ??
                    (meta["full_name"] as string) ??
                    peerId.slice(0, 8),
            });
          }

          edgeList.push({
            fromId:         isFrom ? agencyId : peerId,
            toId:           isFrom ? peerId   : agencyId,
            connectionType: c.connection_type,
            amountUsd:      c.amount_cents != null ? c.amount_cents / 100 : undefined,
            occurredAt:     c.occurred_at  ?? undefined,
            strength:       Number(c.strength) || 0.5,
          });
        }

        setNodes(Array.from(nodeMap.values()));
        setEdges(edgeList);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [agencyId, agencyName]);

  const hasData = edges.length > 0;

  return (
    <div className="flex flex-col bg-gray-50">
      {/* Graph area */}
      <div className="relative" style={{ height: 380 }}>
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
              <p className="text-xs text-gray-400">Loading connections…</p>
            </div>
          </div>
        ) : !hasData ? (
          <div className="relative flex h-full flex-col items-center justify-center">
            <PlaceholderNodes />
            <div className="relative z-10 mx-auto max-w-xs text-center">
              <p className="text-sm font-medium text-gray-500">No connections on record yet</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                Oversight officials, contractors, and regulatory connections appear here as data is
                ingested.
              </p>
            </div>
          </div>
        ) : (
          <ForceGraph nodes={nodes} edges={edges} className="h-full w-full" />
        )}
      </div>

      {hasData && (
        <div className="border-t border-gray-200 bg-white px-5 py-2.5">
          <p className="text-xs text-gray-400">
            {nodes.length} nodes · {edges.length} connections ·{" "}
            <span className="text-gray-300">Drag to reposition · scroll to zoom</span>
          </p>
        </div>
      )}
    </div>
  );
}
