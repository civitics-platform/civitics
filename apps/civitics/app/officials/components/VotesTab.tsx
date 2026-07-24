"use client";

import { useState, useEffect } from "react";
import { Icon } from "@civitics/graph";

export interface IssueStats {
  issue: string;
  label: string;
  icon: string;
  color: string;
  yes: number;
  no: number;
  total: number;
  yesRate: number;
  recentBills: string[];
}

export interface VoteBreakdown {
  yes: number;
  no: number;
  abstain: number;
  total: number;
  procedural: number;
  substantive: number;
}

interface UserPriority {
  id: string;
  importance: number;
}

export function VotesTab({
  issueStats,
  voteBreakdown,
  recentVotes,
}: {
  issueStats: IssueStats[];
  voteBreakdown: VoteBreakdown;
  recentVotes: Array<{
    id: string;
    vote: string;
    title: string;
    proposalId?: string;
    date?: string;
    voteQuestion?: string | null;
  }>;
}) {
  const [userPriorities, setUserPriorities] = useState<UserPriority[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("civic-alignment");
      if (saved) {
        const parsed = JSON.parse(saved);
        setUserPriorities(
          parsed.map((p: { id: string; importance: number }) => ({
            id: p.id,
            importance: p.importance,
          }))
        );
      }
    } catch {}
  }, []);

  function getAlignment(
    issue: string,
    yesRate: number
  ): {
    label: string;
    color: string;
    bg: string;
    icon: string;
  } {
    const priority = userPriorities.find((p) => p.id === issue);

    if (!priority || userPriorities.length === 0) {
      return { label: "", color: "text-ink-soft/70", bg: "bg-paper-2", icon: "" };
    }

    const importance = priority.importance / 100;
    const alignScore = yesRate * importance;

    if (alignScore >= 50)
      return {
        label: "Aligns with your priorities",
        color: "text-green-ink",
        bg: "bg-green-ink/5",
        icon: "✓",
      };
    if (alignScore >= 25)
      return {
        label: "Mixed record",
        color: "text-ink",
        bg: "bg-amber/15",
        icon: "⚠",
      };
    return {
      label: "Conflicts with your priorities",
      color: "text-accent",
      bg: "bg-accent/5",
      icon: "✗",
    };
  }

  const hasUserPriorities =
    userPriorities.length > 0 && userPriorities.some((p) => p.importance !== 50);

  return (
    <div className="p-6 space-y-6">
      {/* Overall breakdown */}
      <div>
        <h3 className="text-sm font-semibold text-ink mb-3">
          Vote Breakdown
        </h3>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-green-ink/5 border border-green-ink/20 p-3 text-center">
            <p className="font-mono text-xl font-bold tabular-nums text-green-ink">
              {voteBreakdown.yes.toLocaleString()}
            </p>
            <p className="text-xs text-green-ink/80 mt-0.5">Yea votes</p>
          </div>
          <div className="bg-accent/5 border border-accent/20 p-3 text-center">
            <p className="font-mono text-xl font-bold tabular-nums text-accent">
              {voteBreakdown.no.toLocaleString()}
            </p>
            <p className="text-xs text-accent/80 mt-0.5">Nay votes</p>
          </div>
          <div className="bg-paper-2 border border-rule p-3 text-center">
            <p className="font-mono text-xl font-bold tabular-nums text-ink-soft">
              {voteBreakdown.abstain.toLocaleString()}
            </p>
            <p className="text-xs text-ink-soft mt-0.5">Abstain/NV</p>
          </div>
        </div>

        {/* Progress bar */}
        {voteBreakdown.total > 0 && (
          <div className="h-2 bg-ink/5 overflow-hidden flex">
            <div
              className="h-full bg-green-ink transition-all"
              style={{
                width: `${(voteBreakdown.yes / voteBreakdown.total) * 100}%`,
              }}
            />
            <div
              className="h-full bg-accent"
              style={{
                width: `${(voteBreakdown.no / voteBreakdown.total) * 100}%`,
              }}
            />
          </div>
        )}

        <p className="font-mono text-[10px] tabular-nums text-ink-soft/70 mt-1.5">
          {voteBreakdown.total.toLocaleString()} total &middot;{" "}
          {voteBreakdown.procedural.toLocaleString()} procedural (filtered)
          &middot; {voteBreakdown.substantive.toLocaleString()} substantive
        </p>
      </div>

      {/* By Issue section */}
      {issueStats.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-ink">
              Votes by Issue
            </h3>
            {!hasUserPriorities && (
              <span className="text-[10px] text-accent bg-accent/5 px-2 py-1 rounded-full">
                Set priorities in graph to see alignment
              </span>
            )}
          </div>

          <div className="space-y-3">
            {issueStats.map((stat) => {
              const alignment = getAlignment(stat.issue, stat.yesRate);
              const borderColor = hasUserPriorities
                ? alignment.color.replace("text-", "border-")
                : "border-rule";

              return (
                <div
                  key={stat.issue}
                  className={`border p-3 ${
                    hasUserPriorities ? alignment.bg : "bg-card"
                  } ${borderColor}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Icon name={stat.icon} className="w-4 h-4 text-ink-soft" />
                      <span className="text-sm font-medium text-ink">
                        {stat.label}
                      </span>
                      {hasUserPriorities && alignment.icon && (
                        <span className={`text-xs font-bold ${alignment.color}`}>
                          {alignment.icon}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-xs tabular-nums text-ink-soft">
                      {stat.total} bills
                    </span>
                  </div>

                  {/* Mini bar */}
                  <div className="h-1.5 bg-ink/5 overflow-hidden flex mb-1.5">
                    <div
                      className="h-full"
                      style={{
                        width: `${stat.yesRate}%`,
                        backgroundColor: stat.color,
                      }}
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="font-mono text-[10px] tabular-nums text-ink-soft">
                      {stat.yesRate}% YES &middot; {stat.yes} yea / {stat.no}{" "}
                      nay
                    </span>
                    {hasUserPriorities && alignment.label && (
                      <span
                        className={`text-[10px] font-medium ${alignment.color}`}
                      >
                        {alignment.label}
                      </span>
                    )}
                  </div>

                  {/* Sample bills */}
                  {stat.recentBills.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-rule/60">
                      {stat.recentBills.slice(0, 2).map((bill, i) => (
                        <p
                          key={i}
                          className="text-[10px] text-ink-soft/70 truncate"
                        >
                          &middot; {bill}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent substantive votes */}
      <div>
        <h3 className="text-sm font-semibold text-ink mb-3">
          Recent Votes
        </h3>
        <div className="divide-y divide-rule/60 border border-rule overflow-hidden">
          {recentVotes.slice(0, 15).map((v, i) => {
            const isYes = v.vote === "yes" || v.vote === "paired_yes";
            const isNo = v.vote === "no" || v.vote === "paired_no";
            const isExpanded = expandedId === v.id;
            const hasDetail = !!(v.voteQuestion || v.proposalId);
            return (
              <div key={i}>
                <button
                  type="button"
                  onClick={() => hasDetail && setExpandedId(isExpanded ? null : v.id)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${hasDetail ? "hover:bg-paper-2" : "cursor-default"} ${isExpanded ? "bg-paper-2" : ""}`}
                >
                  <span
                    className={`shrink-0 w-8 text-center px-1 py-0.5 font-mono text-[10px] font-bold ${
                      isYes
                        ? "bg-green-ink/10 text-green-ink"
                        : isNo
                        ? "bg-accent/10 text-accent"
                        : "bg-ink/5 text-ink-soft"
                    }`}
                  >
                    {isYes ? "YEA" : isNo ? "NAY" : "ABS"}
                  </span>
                  <span className="flex-1 text-xs text-ink truncate">
                    {v.title || "Procedural vote"}
                  </span>
                  {v.date && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-soft/70">
                      {new Date(v.date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "2-digit",
                      })}
                    </span>
                  )}
                  {hasDetail && (
                    <span className="shrink-0 text-[10px] text-ink-soft/70 ml-1" aria-hidden="true">
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  )}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-3 pt-1 bg-paper-2 border-t border-rule/60 space-y-1.5">
                    {v.voteQuestion && (
                      <p className="text-[11px] text-ink-soft">
                        <span className="font-medium text-ink">Question: </span>
                        {v.voteQuestion}
                      </p>
                    )}
                    {v.proposalId && (
                      <a
                        href={`/proposals/${v.proposalId}`}
                        className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline font-medium"
                      >
                        View proposal →
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
