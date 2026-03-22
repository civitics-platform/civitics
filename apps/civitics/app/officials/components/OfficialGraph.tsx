"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createBrowserClient } from "@civitics/db";
import { ForceGraph } from "@civitics/graph";
import type { GraphNodeV2 as GraphNode, GraphEdgeV2 as GraphEdge } from "@civitics/graph";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  metadata: Record<string, unknown> | null;
};

type VoteRow = {
  id: string;
  vote: string;
  voted_at: string | null;
  roll_call_number: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proposals: any | null;
};

type GraphData = { nodes: GraphNode[]; edges: GraphEdge[] };
type EdgeTypeCount = Record<string, number>;

// ── Presets ───────────────────────────────────────────────────────────────────

const PRESETS: {
  id: string;
  label: string;
  filters: string[];
  emptyMsg: string;
}[] = [
  {
    id: "full_picture",
    label: "Full Picture",
    filters: [],                           // empty = all
    emptyMsg: "No connections on record for this official yet.",
  },
  {
    id: "follow_money",
    label: "Follow the Money",
    filters: ["donation", "lobbying"],
    emptyMsg: "No donation or lobbying connections found for this official yet — donor data loads when the FEC pipeline runs.",
  },
  {
    id: "votes_bills",
    label: "Votes & Bills",
    filters: ["vote_yes", "vote_no", "vote_abstain", "co_sponsorship"],
    emptyMsg: "No vote connections found for this official yet.",
  },
  {
    id: "revolving_door",
    label: "Revolving Door",
    filters: ["revolving_door", "appointment"],
    emptyMsg: "No revolving-door connections found for this official yet.",
  },
];

const EDGE_TYPE_LABELS: Record<string, string> = {
  donation:       "Donation",
  vote_yes:       "Vote yes",
  vote_no:        "Vote no",
  vote_abstain:   "Abstain",
  co_sponsorship: "Co-sponsor",
  revolving_door: "Revolving door",
  appointment:    "Appointment",
  oversight:      "Oversight",
  lobbying:       "Lobbying",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapVoteToEdge(vote: string): string | null {
  if (vote === "yes" || vote === "paired_yes") return "vote_yes";
  if (vote === "no"  || vote === "paired_no")  return "vote_no";
  if (vote === "abstain" || vote === "present" || vote === "not_voting") return "vote_abstain";
  return null;
}

function mapParty(party: string | null): GraphNode["party"] {
  if (party === "democrat")    return "democrat";
  if (party === "republican")  return "republican";
  if (party === "independent") return "independent";
  return "nonpartisan";
}

function buildGraphData(
  officialId: string,
  officialName: string,
  officialParty: string | null,
  connections: ConnectionRow[],
  votes: VoteRow[]
): GraphData {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  // Central node — always present
  const central: GraphNode = {
    id: officialId,
    type: "official",
    name: officialName,
    party: mapParty(officialParty),
  };
  nodes.set(officialId, central);

  // Entity_connections edges
  for (const c of connections) {
    const edgeType = c.connection_type as string;
    const isFrom = c.from_id === officialId;
    const peerId = isFrom ? c.to_id : c.from_id;
    const peerType = isFrom ? c.to_type : c.from_type;
    const meta = c.metadata ?? {};

    if (!nodes.has(peerId)) {
      nodes.set(peerId, {
        id: peerId,
        type: peerType === "official" ? "official"
            : peerType === "proposal"  ? "proposal"
            : peerType === "corporation" ? "corporation"
            : peerType === "pac" ? "pac"
            : peerType === "individual" ? "individual"
            : "agency",
        name: (meta["name"] as string) ?? (meta["full_name"] as string) ?? peerId.slice(0, 8),
      });
    }

    edges.push({
      fromId: isFrom ? officialId : peerId,
      toId: isFrom ? peerId : officialId,
      connectionType: edgeType,
      amountUsd: c.amount_cents != null ? c.amount_cents / 100 : undefined,
      occurredAt: c.occurred_at ?? undefined,
      strength: Number(c.strength) || 0.5,
    });
  }

  // Vote edges — from votes table
  const proposalsSeen = new Set<string>();
  for (const v of votes) {
    const edgeType = mapVoteToEdge(v.vote);
    if (!edgeType || !v.proposals) continue;

    const p = v.proposals;
    const proposalId = p.id as string;
    if (!proposalId) continue;

    if (!nodes.has(proposalId)) {
      const label = (p.bill_number ?? p.short_title ?? p.title ?? "Unknown bill") as string;
      nodes.set(proposalId, {
        id: proposalId,
        type: "proposal",
        name: label.length > 20 ? label.slice(0, 20) + "…" : label,
      });
    }

    // Deduplicate: one edge per proposal (most recent vote wins)
    if (!proposalsSeen.has(proposalId)) {
      proposalsSeen.add(proposalId);
      edges.push({
        fromId: officialId,
        toId: proposalId,
        connectionType: edgeType,
        occurredAt: v.voted_at ?? undefined,
        strength: 1,
      });
    }
  }

  return { nodes: Array.from(nodes.values()), edges };
}

function countByType(edges: GraphEdge[]): EdgeTypeCount {
  const counts: EdgeTypeCount = {};
  for (const e of edges) {
    counts[e.connectionType] = (counts[e.connectionType] ?? 0) + 1;
  }
  return counts;
}

// ── Placeholder animated graph (empty state visual) ───────────────────────────

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

// ── Main component ─────────────────────────────────────────────────────────────

export function OfficialGraph({
  officialId,
  officialName,
  officialParty,
}: {
  officialId: string;
  officialName: string;
  officialParty: string | null;
}) {
  const [allData, setAllData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePreset, setActivePreset] = useState("full_picture");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);

  // Cache fetched data per official to avoid re-fetching on re-select
  const cache = useRef<Map<string, GraphData>>(new Map());

  const fetchData = useCallback(async (id: string, name: string, party: string | null) => {
    if (cache.current.has(id)) {
      setAllData(cache.current.get(id)!);
      setLoading(false);
      return;
    }

    setLoading(true);
    setAllData(null);

    const supabase = createBrowserClient();

    const [connRes, voteRes] = await Promise.all([
      supabase
        .from("entity_connections")
        .select("id, from_type, from_id, to_type, to_id, connection_type, strength, amount_cents, occurred_at, metadata")
        .or(`from_id.eq.${id},to_id.eq.${id}`)
        .limit(200),
      supabase
        .from("votes")
        .select("id, vote, voted_at, roll_call_number, proposals!proposal_id(id, title, bill_number, short_title)")
        .eq("official_id", id)
        .order("voted_at", { ascending: false })
        .limit(40),
    ]);

    const data = buildGraphData(
      id,
      name,
      party,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connRes.data as any[]) ?? [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (voteRes.data as any[]) ?? []
    );

    cache.current.set(id, data);
    setAllData(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    setActivePreset("full_picture");
    setActiveFilters([]);
    fetchData(officialId, officialName, officialParty);
  }, [officialId, officialName, officialParty, fetchData]);

  // Apply filters to compute visible nodes/edges
  const { visibleNodes, visibleEdges, typeCounts } = (() => {
    if (!allData) return { visibleNodes: [], visibleEdges: [], typeCounts: {} };

    const filterSet = activeFilters.length > 0 ? new Set(activeFilters) : null;
    const filteredEdges = filterSet
      ? allData.edges.filter((e) => filterSet.has(e.connectionType))
      : allData.edges;

    // Keep only nodes that appear in filtered edges, plus the central node
    const referencedIds = new Set<string>([officialId]);
    for (const e of filteredEdges) {
      referencedIds.add(e.fromId);
      referencedIds.add(e.toId);
    }
    const filteredNodes = allData.nodes.filter((n) => referencedIds.has(n.id));

    return {
      visibleNodes: filteredNodes,
      visibleEdges: filteredEdges,
      typeCounts: countByType(allData.edges),
    };
  })();

  const preset = PRESETS.find((p) => p.id === activePreset) ?? PRESETS[0]!;
  const hasAnyData = (allData?.edges.length ?? 0) > 0;

  // Decide which edge types to show as pills (only those present in data)
  const availableTypes = Object.keys(typeCounts);

  return (
    <div className="flex flex-col bg-gray-50">
      {/* Section header */}
      <div className="border-b border-t border-gray-200 bg-white px-5 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Connection Graph
        </p>
      </div>

      {/* Preset buttons */}
      <div className="border-b border-gray-200 bg-white px-5 py-3">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setActivePreset(p.id);
                setActiveFilters(p.filters);
              }}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                activePreset === p.id
                  ? "border-indigo-400 bg-indigo-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:border-indigo-300 hover:text-indigo-700"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Filter pills — only shown when there's data */}
        {hasAnyData && availableTypes.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {availableTypes.map((type) => {
              const isActive = activeFilters.length === 0 || activeFilters.includes(type);
              const count = typeCounts[type] ?? 0;
              return (
                <button
                  key={type}
                  onClick={() => {
                    setActivePreset("custom");
                    setActiveFilters((prev) => {
                      const base = prev.length === 0 ? availableTypes : prev;
                      if (base.includes(type)) {
                        const next = base.filter((t) => t !== type);
                        return next.length === 0 ? availableTypes : next;
                      }
                      return [...base, type];
                    });
                  }}
                  className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    isActive
                      ? "border-gray-300 bg-white text-gray-700"
                      : "border-gray-100 bg-gray-50 text-gray-400"
                  }`}
                >
                  <span>{EDGE_TYPE_LABELS[type] ?? type}</span>
                  <span className={`rounded-full px-1 ${isActive ? "bg-gray-100 text-gray-500" : "bg-gray-100 text-gray-300"}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Graph area */}
      <div className="relative" style={{ height: 420 }}>
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
              <p className="text-xs text-gray-400">Loading connections…</p>
            </div>
          </div>
        ) : !hasAnyData ? (
          // Global empty state — no data at all yet
          <div className="relative flex h-full flex-col items-center justify-center">
            <PlaceholderNodes />
            <div className="relative z-10 mx-auto max-w-xs text-center">
              <p className="text-sm font-medium text-gray-500">Relationship data coming soon</p>
              <p className="mt-1 text-xs text-gray-400 leading-relaxed">
                Donor and co-sponsorship connections load as we ingest more data. Vote connections
                appear above as records are available.
              </p>
            </div>
          </div>
        ) : visibleEdges.length === 0 ? (
          // Per-filter empty state
          <div className="relative flex h-full flex-col items-center justify-center">
            <PlaceholderNodes />
            <div className="relative z-10 mx-auto max-w-xs text-center">
              <p className="text-sm font-medium text-gray-500">{preset.emptyMsg}</p>
              <button
                onClick={() => { setActivePreset("full_picture"); setActiveFilters([]); }}
                className="mt-2 text-xs text-indigo-500 hover:underline"
              >
                Show full picture instead
              </button>
            </div>
          </div>
        ) : (
          <ForceGraph
            nodes={visibleNodes}
            edges={visibleEdges}
            className="h-full w-full"
          />
        )}
      </div>

      {/* Footer note */}
      {hasAnyData && (
        <div className="border-t border-gray-200 bg-white px-5 py-2.5">
          <p className="text-xs text-gray-400">
            {visibleNodes.length} nodes · {visibleEdges.length} connections visible ·{" "}
            <span className="text-gray-300">Drag to reposition · scroll to zoom · click node for details</span>
          </p>
        </div>
      )}
    </div>
  );
}
