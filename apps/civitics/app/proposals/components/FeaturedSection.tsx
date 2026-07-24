"use client";

import { useState } from "react";
import { Icon } from "@civitics/graph";
import { ProposalCard, type ProposalCardData } from "./ProposalCard";

type Tab = "closing_soon" | "trending" | "most_commented" | "new" | "bills" | "most_viewed";

interface FeaturedSectionProps {
  closingSoon:   ProposalCardData[];
  bills:         ProposalCardData[];
  mostViewed:    ProposalCardData[];
  trending:      ProposalCardData[];
  mostCommented: ProposalCardData[];
  newest:        ProposalCardData[];
}

const TABS: { id: Tab; label: string; icon: string; emptyMsg: string }[] = [
  {
    id:       "closing_soon",
    label:    "Closing Soon",
    icon:     "deadline",
    emptyMsg: "No open comment periods right now.",
  },
  {
    id:       "trending",
    label:    "Trending",
    icon:     "hot",
    emptyMsg: "No trending proposals in the last 24 hours.",
  },
  {
    id:       "most_commented",
    label:    "Most Commented",
    icon:     "comment",
    emptyMsg: "No proposals have comments yet.",
  },
  {
    id:       "new",
    label:    "New",
    icon:     "ai",
    emptyMsg: "No new proposals.",
  },
  {
    id:       "bills",
    label:    "Congressional Bills",
    icon:     "agency",
    emptyMsg: "No congressional bills found.",
  },
  {
    id:       "most_viewed",
    label:    "Most Viewed",
    icon:     "eye",
    emptyMsg: "No view data yet.",
  },
];

export function FeaturedSection({ closingSoon, bills, mostViewed, trending, mostCommented, newest }: FeaturedSectionProps) {
  const [activeTab, setActiveTab] = useState<Tab>("closing_soon");

  const proposals =
    activeTab === "closing_soon"    ? closingSoon
    : activeTab === "trending"      ? trending
    : activeTab === "most_commented" ? mostCommented
    : activeTab === "new"           ? newest
    : activeTab === "bills"         ? bills
    : mostViewed;

  const activeTabMeta = TABS.find((t) => t.id === activeTab)!;

  // Count badge copy per tab
  function badge(tab: Tab): string | null {
    if (tab === "closing_soon" && closingSoon.length > 0)
      return `${closingSoon.length} closing soonest`;
    if (tab === "trending" && trending.length > 0)
      return `${trending.length} hot`;
    if (tab === "most_commented" && mostCommented.length > 0)
      return `${mostCommented.length} discussed`;
    if (tab === "new" && newest.length > 0)
      return `${newest.length} recent`;
    if (tab === "bills" && bills.length > 0)
      return `${bills.length} recent`;
    if (tab === "most_viewed" && mostViewed.length > 0)
      return `${mostViewed.length} proposals`;
    return null;
  }

  return (
    <section aria-labelledby="featured-heading" className="mb-12">
      {/* Tab header */}
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber animate-pulse shrink-0" />
        <h2 id="featured-heading" className="sr-only">Featured proposals</h2>

        <div
          role="tablist"
          aria-label="Featured proposals"
          className="flex gap-1 flex-wrap"
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const count = badge(tab.id);
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-controls="featured-tab-panel"
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
                  isActive
                    ? "bg-ink text-paper"
                    : "bg-card border border-rule text-ink-soft hover:border-accent hover:text-accent"
                }`}
              >
                <Icon name={tab.icon} className="w-4 h-4" />
                {tab.label}
                {count && (
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                      isActive ? "bg-paper/20 text-paper" : "bg-ink/5 text-ink-soft"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Panel */}
      <div
        id="featured-tab-panel"
        role="tabpanel"
        aria-label={activeTabMeta.label}
      >
        {proposals.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        ) : (
          <div className="border border-dashed border-rule bg-card px-8 py-10 text-center">
            <p className="text-sm text-ink-soft/70">{activeTabMeta.emptyMsg}</p>
          </div>
        )}
      </div>
    </section>
  );
}
