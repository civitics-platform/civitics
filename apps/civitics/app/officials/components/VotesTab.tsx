"use client";

import { useState, useEffect } from "react";

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
    date?: string;
  }>;
}) {
  const [userPriorities, setUserPriorities] = useState<UserPriority[]>([]);

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
      return { label: "", color: "text-gray-400", bg: "bg-gray-50", icon: "" };
    }

    const importance = priority.importance / 100;
    const alignScore = yesRate * importance;

    if (alignScore >= 50)
      return {
        label: "Aligns with your priorities",
        color: "text-emerald-700",
        bg: "bg-emerald-50",
        icon: "✓",
      };
    if (alignScore >= 25)
      return {
        label: "Mixed record",
        color: "text-amber-700",
        bg: "bg-amber-50",
        icon: "⚠",
      };
    return {
      label: "Conflicts with your priorities",
      color: "text-red-700",
      bg: "bg-red-50",
      icon: "✗",
    };
  }

  const hasUserPriorities =
    userPriorities.length > 0 && userPriorities.some((p) => p.importance !== 50);

  return (
    <div className="p-6 space-y-6">
      {/* Overall breakdown */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">
          Vote Breakdown
        </h3>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-center">
            <p className="text-xl font-bold text-emerald-700">
              {voteBreakdown.yes.toLocaleString()}
            </p>
            <p className="text-xs text-emerald-600 mt-0.5">Yea votes</p>
          </div>
          <div className="rounded-lg bg-red-50 border border-red-100 p-3 text-center">
            <p className="text-xl font-bold text-red-700">
              {voteBreakdown.no.toLocaleString()}
            </p>
            <p className="text-xs text-red-600 mt-0.5">Nay votes</p>
          </div>
          <div className="rounded-lg bg-gray-50 border border-gray-100 p-3 text-center">
            <p className="text-xl font-bold text-gray-600">
              {voteBreakdown.abstain.toLocaleString()}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">Abstain/NV</p>
          </div>
        </div>

        {/* Progress bar */}
        {voteBreakdown.total > 0 && (
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden flex">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{
                width: `${(voteBreakdown.yes / voteBreakdown.total) * 100}%`,
              }}
            />
            <div
              className="h-full bg-red-400"
              style={{
                width: `${(voteBreakdown.no / voteBreakdown.total) * 100}%`,
              }}
            />
          </div>
        )}

        <p className="text-[10px] text-gray-400 mt-1.5">
          {voteBreakdown.total.toLocaleString()} total &middot;{" "}
          {voteBreakdown.procedural.toLocaleString()} procedural (filtered)
          &middot; {voteBreakdown.substantive.toLocaleString()} substantive
        </p>
      </div>

      {/* By Issue section */}
      {issueStats.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900">
              Votes by Issue
            </h3>
            {!hasUserPriorities && (
              <span className="text-[10px] text-indigo-500 bg-indigo-50 px-2 py-1 rounded-full">
                Set priorities in graph to see alignment
              </span>
            )}
          </div>

          <div className="space-y-3">
            {issueStats.map((stat) => {
              const alignment = getAlignment(stat.issue, stat.yesRate);
              const borderColor = hasUserPriorities
                ? alignment.color.replace("text-", "border-")
                : "border-gray-200";

              return (
                <div
                  key={stat.issue}
                  className={`rounded-lg border p-3 ${
                    hasUserPriorities ? alignment.bg : "bg-white"
                  } ${borderColor}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{stat.icon}</span>
                      <span className="text-sm font-medium text-gray-900">
                        {stat.label}
                      </span>
                      {hasUserPriorities && alignment.icon && (
                        <span className={`text-xs font-bold ${alignment.color}`}>
                          {alignment.icon}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-500">
                      {stat.total} bills
                    </span>
                  </div>

                  {/* Mini bar */}
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden flex mb-1.5">
                    <div
                      className="h-full"
                      style={{
                        width: `${stat.yesRate}%`,
                        backgroundColor: stat.color,
                      }}
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-gray-500">
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
                    <div className="mt-2 pt-2 border-t border-gray-100">
                      {stat.recentBills.slice(0, 2).map((bill, i) => (
                        <p
                          key={i}
                          className="text-[10px] text-gray-400 truncate"
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
        <h3 className="text-sm font-semibold text-gray-900 mb-3">
          Recent Votes
        </h3>
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 overflow-hidden">
          {recentVotes.slice(0, 15).map((v, i) => {
            const isYes = v.vote === "yes" || v.vote === "paired_yes";
            const isNo = v.vote === "no" || v.vote === "paired_no";
            return (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  className={`shrink-0 w-8 text-center rounded px-1 py-0.5 text-[10px] font-bold ${
                    isYes
                      ? "bg-emerald-100 text-emerald-700"
                      : isNo
                      ? "bg-red-100 text-red-700"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {isYes ? "YEA" : isNo ? "NAY" : "ABS"}
                </span>
                <p className="flex-1 text-xs text-gray-700 truncate">
                  {v.title || "Procedural vote"}
                </p>
                {v.date && (
                  <span className="shrink-0 text-[10px] text-gray-400">
                    {new Date(v.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "2-digit",
                    })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
