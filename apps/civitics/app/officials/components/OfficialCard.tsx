"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@civitics/db";
import type { OfficialRow } from "../page";

type RecentVote = {
  id: string;
  vote: string;
  voted_at: string | null;
  roll_call_number: string | null;
  proposals: {
    id: string;
    title: string | null;
    bill_number: string | null;
    short_title: string | null;
  } | null;
};

const VOTE_STYLES: Record<string, { label: string; cls: string }> = {
  yes:         { label: "Yea",      cls: "bg-emerald-100 text-emerald-700" },
  no:          { label: "Nay",      cls: "bg-red-100 text-red-700" },
  abstain:     { label: "Abstain",  cls: "bg-gray-100 text-gray-600" },
  present:     { label: "Present",  cls: "bg-gray-100 text-gray-600" },
  not_voting:  { label: "No vote",  cls: "bg-gray-50 text-gray-400" },
  paired_yes:  { label: "Paired+",  cls: "bg-emerald-50 text-emerald-600" },
  paired_no:   { label: "Paired−",  cls: "bg-red-50 text-red-600" },
};

const PARTY_BORDER: Record<string, string> = {
  democrat:    "border-l-4 border-l-blue-500",
  republican:  "border-l-4 border-l-red-500",
  independent: "border-l-4 border-l-purple-500",
};

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-blue-100 text-blue-800",
  republican:  "bg-red-100 text-red-800",
  independent: "bg-purple-100 text-purple-800",
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function formatDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function OfficialCard({ official }: { official: OfficialRow }) {
  const [votes, setVotes] = useState<RecentVote[]>([]);
  const [voteCount, setVoteCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setVotes([]);
    setVoteCount(null);

    const supabase = createBrowserClient();

    async function fetch() {
      const [recentRes, countRes] = await Promise.all([
        supabase
          .from("votes")
          .select("id, vote, voted_at, roll_call_number, proposals!proposal_id(id, title, bill_number, short_title)")
          .eq("official_id", official.id)
          .order("voted_at", { ascending: false })
          .limit(10),
        supabase
          .from("votes")
          .select("id", { count: "exact", head: true })
          .eq("official_id", official.id),
      ]);

      if (cancelled) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setVotes((recentRes.data as any[]) ?? []);
      setVoteCount(countRes.count ?? 0);
      setLoading(false);
    }

    fetch();
    return () => { cancelled = true; };
  }, [official.id]);

  const partyBorder = PARTY_BORDER[official.party ?? ""] ?? "border-l-4 border-l-gray-300";
  const partyBadge  = PARTY_BADGE[official.party ?? ""]  ?? "bg-gray-100 text-gray-700";
  const partyLabel  = official.party
    ? official.party.charAt(0).toUpperCase() + official.party.slice(1)
    : "Unknown";

  return (
    <div className={`bg-white border-b border-gray-200 ${partyBorder}`}>
      {/* Profile header */}
      <div className="px-5 py-5">
        <div className="flex items-start gap-4">
          {/* Avatar */}
          {official.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={official.photo_url}
              alt={official.full_name}
              className="h-16 w-16 shrink-0 rounded-full border-2 border-gray-200 object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 border-gray-200 bg-gray-100 text-lg font-bold text-gray-500">
              {initials(official.full_name)}
            </div>
          )}

          {/* Name / role */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${partyBadge}`}>
                {partyLabel}
              </span>
              {official.chamber && (
                <span className="rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                  {official.chamber.toUpperCase()}
                </span>
              )}
            </div>
            <h2 className="mt-1 text-xl font-bold text-gray-900 leading-tight">{official.full_name}</h2>
            <p className="text-sm text-gray-500">{official.role_title}</p>
            {official.state_name && (
              <p className="text-sm text-gray-400">
                {official.state_name}
                {official.district_name ? ` · ${official.district_name}` : ""}
              </p>
            )}
            {(official.term_start || official.term_end) && (
              <p className="mt-1 text-xs text-gray-400">
                Term:{" "}
                {official.term_start ? formatDate(official.term_start) : "?"} →{" "}
                {official.term_end ? formatDate(official.term_end) : "present"}
              </p>
            )}
          </div>
        </div>

        {/* Stats bar */}
        <div className="mt-4 grid grid-cols-3 gap-px rounded overflow-hidden border border-gray-100 bg-gray-100">
          <Stat
            value={voteCount !== null ? voteCount.toLocaleString() : "—"}
            label="Votes on record"
            loading={loading}
          />
          <Stat value="—" label="Donors on record" note="FEC coming soon" />
          <Stat value="—" label="Promises" note="Phase 2" />
        </div>
      </div>

      {/* Recent votes */}
      <div className="border-t border-gray-100 px-5 py-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
          Recent Votes
        </p>

        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : votes.length === 0 ? (
          <p className="text-sm text-gray-400">No vote records found.</p>
        ) : (
          <div className="space-y-1.5">
            {votes.map((v) => {
              const vs = VOTE_STYLES[v.vote] ?? { label: v.vote, cls: "bg-gray-100 text-gray-600" };
              const proposal = v.proposals;
              const label = proposal?.bill_number ?? proposal?.short_title ?? proposal?.title ?? "Unknown bill";
              return (
                <div
                  key={v.id}
                  className="flex items-center gap-2.5 rounded border border-gray-100 bg-gray-50 px-3 py-2"
                >
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${vs.cls}`}>
                    {vs.label}
                  </span>
                  <p className="flex-1 truncate text-xs text-gray-700">{label}</p>
                  {v.voted_at && (
                    <span className="shrink-0 text-[10px] text-gray-400">
                      {new Date(v.voted_at).toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Phase 2 teaser */}
      <div className="border-t border-gray-100 px-5 pb-4">
        <button
          disabled
          title="Available in Phase 2 with AI credits"
          className="mt-3 w-full cursor-not-allowed rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-400"
        >
          ✦ AI analysis of this official — Phase 2
        </button>
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  loading,
  note,
}: {
  value: string;
  label: string;
  loading?: boolean;
  note?: string;
}) {
  return (
    <div className="bg-white px-3 py-3 text-center">
      {loading ? (
        <div className="mx-auto h-5 w-12 animate-pulse rounded bg-gray-100" />
      ) : (
        <p className="text-base font-bold text-gray-900">{value}</p>
      )}
      <p className="mt-0.5 text-[10px] text-gray-400">{label}</p>
      {note && <p className="text-[9px] text-gray-300">{note}</p>}
    </div>
  );
}
