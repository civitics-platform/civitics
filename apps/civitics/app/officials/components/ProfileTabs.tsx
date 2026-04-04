"use client";

import { useState } from "react";

type Tab = "overview" | "votes" | "donations" | "connections";

interface ProfileTabsProps {
  overview: React.ReactNode;
  votes: React.ReactNode;
  donations: React.ReactNode;
  connections: React.ReactNode;
  voteCount: number;
  donorCount: number;
}

export function ProfileTabs({
  overview,
  votes,
  donations,
  connections,
  voteCount,
  donorCount,
}: ProfileTabsProps) {
  const [active, setActive] = useState<Tab>("overview");

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "votes", label: "Votes", count: voteCount },
    { id: "donations", label: "Donations", count: donorCount },
    { id: "connections", label: "Connections" },
  ];

  return (
    <div className="mt-6">
      {/* Tab bar */}
      <div className="border-b border-gray-200 bg-white rounded-t-lg overflow-hidden">
        <div className="flex px-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                active === tab.id
                  ? "border-indigo-500 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span
                  className={`text-xs rounded-full px-1.5 py-0.5 ${
                    active === tab.id
                      ? "bg-indigo-100 text-indigo-600"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {tab.count.toLocaleString()}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="bg-white rounded-b-lg border border-t-0 border-gray-200 overflow-hidden">
        {active === "overview" && overview}
        {active === "votes" && votes}
        {active === "donations" && donations}
        {active === "connections" && connections}
      </div>
    </div>
  );
}
