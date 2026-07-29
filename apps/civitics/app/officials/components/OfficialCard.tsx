"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@civitics/db";
import type { OfficialRow } from "../page";
import { EntityTags } from "../../components/tags/EntityTags";
import { SyntheticMark } from "../../components/integrity/Synthetic";
import { EngagementBadges } from "../../components/EngagementBadges";
import { engagedTier, communityTier, EMPTY_ENGAGEMENT } from "../../lib/engagement";

type RecentVote = {
  id: string;
  vote: string;
  voted_at: string | null;
  proposals: {
    id: string;
    title: string | null;
    bill_number: string | null;
    short_title: string | null;
  } | null;
};

const VOTE_STYLES: Record<string, { label: string; cls: string }> = {
  yes:         { label: "Yea",      cls: "bg-green-ink/10 text-green-ink" },
  no:          { label: "Nay",      cls: "bg-accent/10 text-accent" },
  abstain:     { label: "Abstain",  cls: "bg-ink/5 text-ink-soft" },
  present:     { label: "Present",  cls: "bg-ink/5 text-ink-soft" },
  not_voting:  { label: "No vote",  cls: "bg-ink/5 text-ink-soft/70" },
  paired_yes:  { label: "Paired+",  cls: "bg-green-ink/5 text-green-ink/80" },
  paired_no:   { label: "Paired−",  cls: "bg-accent/5 text-accent/80" },
};

// Independents stay ink-outline — no purple token exists by design.
const PARTY_BORDER: Record<string, string> = {
  democrat:    "border-l-4 border-l-civic-blue",
  republican:  "border-l-4 border-l-accent",
  independent: "border-l-4 border-l-ink",
};

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-civic-blue/10 text-civic-blue",
  republican:  "bg-accent/10 text-accent",
  independent: "border border-ink/40 text-ink",
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function formatDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  if (dollars > 0) return `$${dollars.toLocaleString()}`;
  return "$0";
}

export function OfficialCard({ official }: { official: OfficialRow }) {
  const [votes, setVotes]             = useState<RecentVote[]>([]);
  const [voteCount, setVoteCount]     = useState<number | null>(null);
  const [donorCount, setDonorCount]   = useState<number | null>(null);
  const [totalDonations, setTotal]    = useState<number | null>(null);
  const [loading, setLoading]         = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setVotes([]);
    setVoteCount(null);
    setDonorCount(null);
    setTotal(null);

    const supabase = createBrowserClient();

    async function load() {
      // Stats read from official_homepage_stats_mv (FIX-223 / FIX-308); see
      // migration 20260510000001_homepage_stats_mvs.sql. MV refreshes nightly;
      // officials missing from the MV fall back to 0/0/$0 — acceptable for a
      // directory card and consistent with the homepage's numbers.
      const [recentRes, mvRes] = await Promise.all([
        supabase
          .from("votes")
          .select("id, vote, voted_at, bill_proposal_id")
          .eq("official_id", official.id)
          .order("voted_at", { ascending: false })
          .limit(10),
        supabase
          .from("official_homepage_stats_mv")
          .select("vote_count, donor_count, total_donations_cents")
          .eq("official_id", official.id)
          .maybeSingle(),
      ]);

      if (cancelled) return;

      // votes.bill_proposal_id FKs to bill_details(proposal_id); there is no
      // direct votes→proposals relationship, so a PostgREST embed can't resolve.
      // Two-step: fetch the proposals separately and attach them. The
      // bill_proposal_id value IS a proposals.id (bill_details.proposal_id == proposals.id).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const voteRows = ((recentRes.data as any[]) ?? []) as Array<{ bill_proposal_id: string | null }>;
      const proposalIds = [...new Set(voteRows.map((v) => v.bill_proposal_id).filter(Boolean) as string[])];
      const proposalsById = new Map<string, RecentVote["proposals"]>();
      if (proposalIds.length > 0) {
        const { data: props } = await supabase
          .from("proposals")
          .select("id, title, short_title, bill_details(bill_number)")
          .in("id", proposalIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const p of ((props as any[]) ?? [])) {
          const bd = Array.isArray(p.bill_details) ? p.bill_details[0] : p.bill_details;
          proposalsById.set(p.id, {
            id: p.id,
            title: p.title ?? null,
            short_title: p.short_title ?? null,
            bill_number: bd?.bill_number ?? null,
          });
        }
      }

      if (cancelled) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hydrated: RecentVote[] = voteRows.map((v: any) => ({
        ...v,
        proposals: v.bill_proposal_id ? proposalsById.get(v.bill_proposal_id) ?? null : null,
      }));
      setVotes(hydrated);
      setVoteCount(mvRes.data?.vote_count ?? 0);
      setDonorCount(mvRes.data?.donor_count ?? 0);
      setTotal(mvRes.data?.total_donations_cents ?? 0);
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [official.id]);

  // FIX-618: display-only engagement rollup attached server-side in page.tsx.
  const engagement = official.engagement ?? EMPTY_ENGAGEMENT;
  const partyBorder = PARTY_BORDER[official.party ?? ""] ?? "border-l-4 border-l-rule";
  const partyBadge  = PARTY_BADGE[official.party ?? ""]  ?? "bg-ink/5 text-ink-soft";
  const partyLabel  = official.party
    ? official.party.charAt(0).toUpperCase() + official.party.slice(1)
    : "Unknown";
  // QWEN-ADDED: derive federal vs state level from source_ids
  const isFederal = !!(official.source_ids as Record<string, string> | null)?.["congress_gov"];

  return (
    <div className={`bg-card border-b border-rule ${partyBorder}`}>
      {/* Profile header */}
      <div className="px-5 py-5">
        <div className="flex items-start gap-4">
          {/* Avatar */}
          {official.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={official.photo_url}
              alt={official.full_name}
              className="h-16 w-16 shrink-0 rounded-full border-2 border-rule object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 border-rule bg-paper-2 font-serif text-lg font-bold text-ink-soft">
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
                <span className="border border-rule px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                  {official.chamber.toUpperCase()}
                </span>
              )}
              {isFederal ? (
                <span className="border border-civic-blue/30 bg-civic-blue/10 px-1.5 py-0.5 text-[10px] font-semibold text-civic-blue">
                  Federal
                </span>
              ) : (
                <span className="border border-rule bg-paper-2 px-1.5 py-0.5 text-[10px] font-semibold text-ink-soft">
                  State
                </span>
              )}
            </div>
            <h2 className="mt-1 font-serif text-xl font-bold text-ink leading-tight">
              {official.full_name}
              {official.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
            </h2>
            <p className="text-sm text-ink-soft">{official.role_title}</p>
            {official.state_name && (
              <p className="text-sm text-ink-soft/80">
                {official.state_name}
                {official.district_name ? ` · ${official.district_name}` : ""}
              </p>
            )}
            {(official.term_start || official.term_end) && (
              <p className="mt-1 font-mono text-xs tabular-nums text-ink-soft/80">
                Term:{" "}
                {official.term_start ? formatDate(official.term_start) : "?"} →{" "}
                {official.term_end ? formatDate(official.term_end) : "present"}
              </p>
            )}
            {/* Engagement badges (FIX-618) — display-only claimed/engaged/community */}
            <EngagementBadges
              className="mt-2"
              entityType="official"
              isClaimed={engagement.isClaimed}
              engaged={engagedTier(engagement)}
              community={communityTier(engagement)}
            />
            {/* Tags */}
            {official.tags && official.tags.length > 0 && (
              <EntityTags
                entityType="official"
                entityId={official.id}
                tags={official.tags}
                variant="compact"
              />
            )}
          </div>
        </div>

        {/* Stats bar */}
        <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden border border-rule bg-rule">
          <Stat
            value={voteCount !== null ? voteCount.toLocaleString() : "—"}
            label="Votes on record"
            loading={loading}
          />
          {/* FIX-931: same two relabels as officials/[id]. Both figures come
              from official_homepage_stats_mv, whose donor_count is COUNT(*)
              over financial_relationships rows (donor-and-cycle pairs, not
              distinct donors) and whose total_donations_cents is the all-cycle
              sum of itemized donations only. The full coverage caveat lives on
              the detail page — a directory card has no room for it, and the
              labels no longer assert anything the numbers cannot support. */}
          <Stat
            value={donorCount !== null ? donorCount.toLocaleString() : "—"}
            label="Donor records"
            loading={loading}
            note={donorCount === 0 ? "FEC sync weekly" : undefined}
          />
          <Stat
            value={totalDonations !== null ? formatMoney(totalDonations) : "—"}
            label="Itemized donations"
            loading={loading}
            note={totalDonations === 0 ? "FEC sync weekly" : undefined}
          />
        </div>
      </div>

      {/* Recent votes */}
      <div className="border-t border-rule px-5 py-4">
        <p className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-ink-soft/70">
          Recent Votes
        </p>

        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-10 animate-pulse bg-paper-2" />
            ))}
          </div>
        ) : votes.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Voting record loading — check back as we sync congressional data.
          </p>
        ) : (
          <div className="space-y-1.5">
            {votes.map((v) => {
              const vs = VOTE_STYLES[v.vote] ?? { label: v.vote, cls: "bg-ink/5 text-ink-soft" };
              const proposal = v.proposals;
              const label = proposal?.bill_number ?? proposal?.short_title ?? proposal?.title ?? "Unknown bill";
              return (
                <div
                  key={v.id}
                  className="flex items-center gap-2.5 border border-rule/60 bg-paper px-3 py-2"
                >
                  <span className={`shrink-0 px-1.5 py-0.5 font-mono text-[10px] font-bold ${vs.cls}`}>
                    {vs.label}
                  </span>
                  <p className="flex-1 truncate text-xs text-ink">{label}</p>
                  {v.voted_at && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-soft/70">
                      {new Date(v.voted_at).toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Profile link + Phase 2 teaser */}
      <div className="border-t border-rule px-5 pb-4 space-y-2">
        <a
          href={`/officials/${official.id}`}
          className="mt-3 block w-full border border-rule bg-paper-2 px-3 py-2 text-center text-xs font-medium text-ink hover:border-accent hover:text-accent transition-colors"
        >
          View full profile →
        </a>
        <button
          disabled
          title="Available in Phase 2 with AI credits"
          className="w-full cursor-not-allowed border border-rule bg-paper-2 px-3 py-2 text-xs font-medium text-ink-soft/60"
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
    <div className="bg-card px-3 py-3 text-center">
      {loading ? (
        <div className="mx-auto h-5 w-12 animate-pulse bg-paper-2" />
      ) : (
        <p className="font-mono text-base font-bold tabular-nums text-ink">{value}</p>
      )}
      <p className="mt-0.5 text-[10px] text-ink-soft/70">{label}</p>
      {note && <p className="text-[9px] text-ink-soft/50">{note}</p>}
    </div>
  );
}
