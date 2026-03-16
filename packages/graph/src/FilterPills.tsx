"use client";

import { useMemo } from "react";
import type { GraphEdge, EdgeType } from "./index";

const PILL_CONFIG: { type: EdgeType; label: string; color: string }[] = [
  { type: "donation",       label: "Donations",     color: "#16a34a" },
  { type: "vote_yes",       label: "Vote Yes",       color: "#2563eb" },
  { type: "vote_no",        label: "Vote No",        color: "#dc2626" },
  { type: "co_sponsorship", label: "Co-Sponsor",     color: "#3b82f6" },
  { type: "appointment",    label: "Appointment",    color: "#7c3aed" },
  { type: "revolving_door", label: "Revolving Door", color: "#ea580c" },
  { type: "oversight",      label: "Oversight",      color: "#6b7280" },
  { type: "lobbying",       label: "Lobbying",       color: "#eab308" },
  { type: "vote_abstain",   label: "Vote Abstain",   color: "#94a3b8" },
];

export interface FilterPillsProps {
  edges: GraphEdge[];
  activeTypes: EdgeType[] | null; // null = all active
  onChange: (types: EdgeType[] | null) => void;
}

export function FilterPills({ edges, activeTypes, onChange }: FilterPillsProps) {
  const counts = useMemo(() => {
    const map = new Map<EdgeType, number>();
    for (const e of edges) {
      map.set(e.type, (map.get(e.type) ?? 0) + 1);
    }
    return map;
  }, [edges]);

  const presentPills = PILL_CONFIG.filter((p) => (counts.get(p.type) ?? 0) > 0);
  if (presentPills.length === 0) return null;

  const allActive = activeTypes === null;

  function toggle(type: EdgeType) {
    if (allActive) {
      onChange([type]);
      return;
    }
    const current = activeTypes ?? [];
    if (current.includes(type)) {
      const next = current.filter((t) => t !== type);
      onChange(next.length === 0 ? null : next);
    } else {
      onChange([...current, type]);
    }
  }

  return (
    <div className="flex items-center gap-1.5 px-5 py-2 border-b border-gray-800 bg-gray-950 shrink-0 overflow-x-auto">
      <button
        onClick={() => onChange(null)}
        className={`
          flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium border transition-all
          ${allActive
            ? "bg-gray-200 border-gray-300 text-gray-900"
            : "bg-gray-900 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500"
          }
        `}
      >
        All
      </button>

      {presentPills.map(({ type, label, color }) => {
        const count = counts.get(type) ?? 0;
        const active = allActive || (activeTypes?.includes(type) ?? false);
        return (
          <button
            key={type}
            onClick={() => toggle(type)}
            className={`
              flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all
              ${active
                ? "text-white border-transparent"
                : "bg-gray-900 text-gray-400 hover:text-white"
              }
            `}
            style={
              active
                ? { backgroundColor: color, borderColor: color }
                : { borderColor: color }
            }
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: active ? "white" : color }}
            />
            {label} ({count})
          </button>
        );
      })}
    </div>
  );
}
