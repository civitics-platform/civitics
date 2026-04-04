"use client";

import { useState } from "react";

interface IssueAlignment {
  id: string;
  label: string;
  icon: string;
  importance: number; // 0–100
  color: string;
}

const DEFAULT_ISSUES: IssueAlignment[] = [
  { id: "healthcare",  label: "Healthcare",  icon: "🏥", importance: 50, color: "#10b981" },
  { id: "climate",     label: "Climate",     icon: "⚡", importance: 50, color: "#06b6d4" },
  { id: "economy",     label: "Economy",     icon: "💼", importance: 50, color: "#f59e0b" },
  { id: "education",   label: "Education",   icon: "📚", importance: 50, color: "#8b5cf6" },
  { id: "defense",     label: "Defense",     icon: "🛡", importance: 50, color: "#64748b" },
  { id: "immigration", label: "Immigration", icon: "🌎", importance: 50, color: "#f97316" },
];

export interface AlignmentPanelProps {
  initialIssues?: IssueAlignment[] | null;
  onAlignmentChange?: (issues: IssueAlignment[]) => void;
}

export function AlignmentPanel({ initialIssues, onAlignmentChange }: AlignmentPanelProps) {
  const [issues, setIssues] = useState<IssueAlignment[]>(initialIssues ?? DEFAULT_ISSUES);
  const [expanded, setExpanded] = useState(false);

  function updateIssue(id: string, importance: number) {
    const updated = issues.map((issue) =>
      issue.id === id ? { ...issue, importance } : issue
    );
    setIssues(updated);
    onAlignmentChange?.(updated);
  }

  const topIssues = [...issues]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3);

  const sortedIssues = [...issues].sort((a, b) => b.importance - a.importance);

  return (
    <div className="border-t border-gray-800 mt-2 pt-2">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-400 hover:text-gray-300 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span>🧭</span>
          <span className="font-medium">My Priorities</span>
          <div className="flex gap-1">
            {topIssues.map((i) => (
              <span key={i.id} className="text-xs" title={i.label}>
                {i.icon}
              </span>
            ))}
          </div>
        </div>
        <span>{expanded ? "▲" : "▾"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          <p className="text-[10px] text-gray-500 mb-3 leading-relaxed">
            Set how much each issue matters to you. This will power your civic alignment profile.
          </p>

          {issues.map((issue) => (
            <div key={issue.id}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <span>{issue.icon}</span>
                  <span>{issue.label}</span>
                </div>
                <span
                  className="text-[10px] font-medium tabular-nums"
                  style={{ color: issue.color }}
                >
                  {issue.importance}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={issue.importance}
                onChange={(e) => updateIssue(issue.id, parseInt(e.target.value))}
                className="w-full h-1 rounded-full appearance-none cursor-pointer"
                style={{
                  accentColor: issue.color,
                  background: `linear-gradient(to right, ${issue.color} ${issue.importance}%, #1f2937 ${issue.importance}%)`,
                }}
              />
            </div>
          ))}

          {/* Mini alignment preview */}
          <div className="mt-3 pt-2 border-t border-gray-800">
            <p className="text-[10px] text-gray-500 mb-2">Your priority profile:</p>
            <div className="flex gap-1 items-end h-8">
              {sortedIssues.map((issue) => (
                <div
                  key={issue.id}
                  className="flex-1 rounded-sm transition-all duration-200"
                  style={{
                    height: `${Math.max(issue.importance * 0.32, 2)}px`,
                    backgroundColor: issue.color,
                    opacity: 0.8,
                  }}
                  title={`${issue.label}: ${issue.importance}%`}
                />
              ))}
            </div>
            <div className="flex gap-1 mt-1">
              {sortedIssues.map((issue) => (
                <div
                  key={issue.id}
                  className="flex-1 text-center text-[8px] text-gray-600 truncate"
                >
                  {issue.icon}
                </div>
              ))}
            </div>
          </div>

          <p className="text-[9px] text-gray-600 mt-2 text-center">
            Full alignment quiz coming soon
          </p>
        </div>
      )}
    </div>
  );
}
