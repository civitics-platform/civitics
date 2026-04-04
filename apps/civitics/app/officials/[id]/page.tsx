import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import nextDynamic from "next/dynamic";
import { createServerClient } from "@civitics/db";
import { OfficialGraph } from "../components/OfficialGraph";
import { AiProfileSection } from "../components/AiProfileSection";
import { ProfileTabs } from "../components/ProfileTabs";
import { ShareButton } from "../components/ShareButton";
import { PageViewTracker } from "../../components/PageViewTracker";

const CivicBadge = nextDynamic(
  () => import("@civitics/graph").then((m) => ({ default: m.CivicBadge })),
  { ssr: false }
);

export const dynamic = "force-dynamic";

export async function generateStaticParams() {
  return [];
}

// ─── Types ────────────────────────────────────────────────────────────────────

type VoteRow = {
  id: string;
  vote: string;
  voted_at: string | null;
  roll_call_number: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proposals: any | null;
};

type DonorRow = {
  donor_name: string;
  donor_type: string;
  industry: string | null;
  total_cents: number;
  count: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  if (dollars > 0) return `$${dollars.toLocaleString()}`;
  return "$0";
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// ─── Procedural vote filter ───────────────────────────────────────────────────

const PROCEDURAL_PATTERNS = [
  "on passage",
  "on the motion",
  "on cloture",
  "on the cloture",
  "on the nomination",
  "on the resolution",
  "on ordering",
  "on the amendment",
  "on the conference",
  "on the joint",
  "on adjourn",
  "on the motion to table",
];

function isProcedural(title: string): boolean {
  const lower = title.toLowerCase();
  return PROCEDURAL_PATTERNS.some((p) => lower.startsWith(p));
}

// ─── Issue keyword taxonomy ───────────────────────────────────────────────────

const ISSUE_KEYWORDS: Record<
  string,
  { label: string; icon: string; keywords: string[]; color: string }
> = {
  healthcare: {
    label: "Healthcare",
    icon: "🏥",
    color: "#10b981",
    keywords: [
      "health", "medicare", "medicaid", "hospital", "prescription", "drug",
      "pharma", "insurance", "care act", "patient", "medical", "mental health",
      "opioid", "vaccine", "public health",
    ],
  },
  climate: {
    label: "Climate & Energy",
    icon: "⚡",
    color: "#06b6d4",
    keywords: [
      "climate", "clean energy", "renewable", "carbon", "emission",
      "environment", "pollution", "solar", "wind energy", "fossil", "oil",
      "gas pipeline", "green", "conservation", "wildlife", "ocean",
      "water quality",
    ],
  },
  economy: {
    label: "Economy",
    icon: "💼",
    color: "#f59e0b",
    keywords: [
      "tax", "budget", "spending", "economic", "inflation", "trade", "tariff",
      "jobs", "employment", "wage", "financial", "bank", "housing", "debt",
      "appropriation", "fund", "relief",
    ],
  },
  education: {
    label: "Education",
    icon: "📚",
    color: "#8b5cf6",
    keywords: [
      "education", "school", "student", "teacher", "college", "university",
      "loan", "learning", "child", "youth", "early childhood",
    ],
  },
  defense: {
    label: "Defense & Security",
    icon: "🛡",
    color: "#64748b",
    keywords: [
      "defense", "military", "national security", "armed forces", "veteran",
      "army", "navy", "air force", "pentagon", "nato", "authorization act",
      "homeland",
    ],
  },
  immigration: {
    label: "Immigration",
    icon: "🌎",
    color: "#f97316",
    keywords: [
      "immigration", "border", "asylum", "refugee", "citizenship", "visa",
      "daca", "migrant", "deportation", "undocumented",
    ],
  },
  justice: {
    label: "Justice & Rights",
    icon: "⚖️",
    color: "#a855f7",
    keywords: [
      "justice", "civil rights", "voting rights", "police", "criminal",
      "prison", "court", "constitutional", "amendment", "equal",
      "discrimination", "freedom", "privacy",
    ],
  },
};

function tagIssues(title: string): string[] {
  const lower = title.toLowerCase();
  return Object.entries(ISSUE_KEYWORDS)
    .filter(([, cfg]) => cfg.keywords.some((kw) => lower.includes(kw)))
    .map(([id]) => id);
}

// ─── Vote display styles ───────────────────────────────────────────────────────

const VOTE_STYLES: Record<string, { label: string; cls: string }> = {
  yes:        { label: "Yea",     cls: "bg-emerald-100 text-emerald-700" },
  no:         { label: "Nay",     cls: "bg-red-100 text-red-700" },
  abstain:    { label: "Abstain", cls: "bg-gray-100 text-gray-600" },
  present:    { label: "Present", cls: "bg-gray-100 text-gray-600" },
  not_voting: { label: "No vote", cls: "bg-gray-50 text-gray-400" },
  paired_yes: { label: "Paired+", cls: "bg-emerald-50 text-emerald-600" },
  paired_no:  { label: "Paired−", cls: "bg-red-50 text-red-600" },
};

const PARTY_STYLES: Record<string, { border: string; badge: string; label: string }> = {
  democrat:    { border: "border-l-4 border-l-blue-500",   badge: "bg-blue-100 text-blue-800",     label: "Democrat" },
  republican:  { border: "border-l-4 border-l-red-500",    badge: "bg-red-100 text-red-800",       label: "Republican" },
  independent: { border: "border-l-4 border-l-purple-500", badge: "bg-purple-100 text-purple-800", label: "Independent" },
};
const DEFAULT_PARTY = { border: "border-l-4 border-l-gray-300", badge: "bg-gray-100 text-gray-700", label: "Unknown" };

const DONOR_TYPE_LABELS: Record<string, string> = {
  individual:  "Individual",
  corporation: "Corporation",
  pac:         "PAC",
  super_pac:   "Super PAC",
  party:       "Political Party",
  union:       "Union",
  nonprofit:   "Nonprofit",
  foreign:     "Foreign Entity",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function OfficialProfilePage({
  params,
}: {
  params: { id: string };
}) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  // Fetch official + joins in parallel with votes, donor count, donor amounts, AI summary
  const [officialRes, voteCountRes, votesRes, donorCountRes, donorAmtRes, aiSummaryRes, allVotesRes] =
    await Promise.all([
      supabase
        .from("officials")
        .select(
          "id, full_name, first_name, last_name, role_title, party, photo_url, email, website_url, phone, district_name, term_start, term_end, is_active, jurisdictions!jurisdiction_id(name), governing_bodies!governing_body_id(short_name)"
        )
        .eq("id", params.id)
        .single(),
      supabase
        .from("votes")
        .select("id", { count: "exact", head: true })
        .eq("official_id", params.id),
      supabase
        .from("votes")
        .select(
          "id, vote, voted_at, roll_call_number, proposals!proposal_id(id, title, bill_number, short_title)"
        )
        .eq("official_id", params.id)
        .order("voted_at", { ascending: false })
        .limit(100),
      supabase
        .from("financial_relationships")
        .select("id", { count: "exact", head: true })
        .eq("official_id", params.id),
      supabase
        .from("financial_relationships")
        .select("donor_name, donor_type, industry, amount_cents, metadata")
        .eq("official_id", params.id),
      sb
        .from("ai_summary_cache")
        .select("summary_text")
        .eq("entity_type", "official")
        .eq("entity_id", params.id)
        .eq("summary_type", "profile")
        .maybeSingle(),
      supabase
        .from("votes")
        .select("vote, proposals!proposal_id(id, title, bill_number)")
        .eq("official_id", params.id)
        .limit(500),
    ]);

  if (officialRes.error || !officialRes.data) {
    notFound();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = officialRes.data as any;
  const official = {
    id: o.id as string,
    full_name: o.full_name as string,
    role_title: o.role_title as string,
    party: (o.party ?? null) as string | null,
    photo_url: (o.photo_url ?? null) as string | null,
    email: (o.email ?? null) as string | null,
    website_url: (o.website_url ?? null) as string | null,
    phone: (o.phone ?? null) as string | null,
    district_name: (o.district_name ?? null) as string | null,
    term_start: (o.term_start ?? null) as string | null,
    term_end: (o.term_end ?? null) as string | null,
    is_active: (o.is_active ?? null) as boolean | null,
    state_name: (o.jurisdictions?.name ?? null) as string | null,
    chamber: (o.governing_bodies?.short_name ?? null) as string | null,
  };

  // Aggregate donor data in JS (no GROUP BY in PostgREST)
  const donorMap = new Map<
    string,
    { donor_type: string; industry: string | null; total_cents: number; count: number }
  >();
  for (const row of donorAmtRes.data ?? []) {
    const existing = donorMap.get(row.donor_name);
    if (existing) {
      existing.total_cents += row.amount_cents ?? 0;
      existing.count += 1;
    } else {
      donorMap.set(row.donor_name, {
        donor_type: row.donor_type,
        industry: row.industry ?? null,
        total_cents: row.amount_cents ?? 0,
        count: 1,
      });
    }
  }
  const topDonors: DonorRow[] = Array.from(donorMap.entries())
    .map(([donor_name, v]) => ({ donor_name, ...v }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, 50);

  const totalDonations = (donorAmtRes.data ?? []).reduce(
    (sum, r) => sum + (r.amount_cents ?? 0),
    0
  );

  // ── Industry breakdown ───────────────────────────────────────────────────────
  const bySector = new Map<string, number>();
  for (const row of donorAmtRes.data ?? []) {
    const sector =
      (row.metadata as Record<string, string> | null)?.sector ??
      row.industry ??
      row.donor_type ??
      "Other";
    bySector.set(sector, (bySector.get(sector) ?? 0) + (row.amount_cents ?? 0));
  }
  const industrySummary = [...bySector.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([sector, cents]) => ({
      sector,
      totalCents: cents,
      pct: totalDonations > 0 ? Math.round((cents / totalDonations) * 100) : 0,
    }));

  // ── Issue tagging + vote breakdown ──────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allVotesRaw = (allVotesRes.data ?? []) as any[];

  const substantiveVotesRaw = allVotesRaw.filter((v) => {
    const title = v.proposals?.title ?? "";
    return !isProcedural(title);
  });
  const proceduralCount = allVotesRaw.length - substantiveVotesRaw.length;

  const voteBreakdown = {
    yes: allVotesRaw.filter((v) => v.vote === "yes" || v.vote === "paired_yes").length,
    no: allVotesRaw.filter((v) => v.vote === "no" || v.vote === "paired_no").length,
    abstain: allVotesRaw.filter(
      (v) => v.vote === "abstain" || v.vote === "not_voting" || v.vote === "present"
    ).length,
    total: allVotesRaw.length,
    procedural: proceduralCount,
    substantive: substantiveVotesRaw.length,
  };

  const taggedVotes = substantiveVotesRaw.map((v) => ({
    vote: v.vote as string,
    title: (v.proposals?.title ?? "") as string,
    billNumber: (v.proposals?.bill_number ?? undefined) as string | undefined,
    issues: tagIssues(v.proposals?.title ?? ""),
  }));

  const issueStats = Object.entries(ISSUE_KEYWORDS)
    .map(([issue, cfg]) => {
      const issueVotes = taggedVotes.filter((v) => v.issues.includes(issue));
      const yes = issueVotes.filter(
        (v) => v.vote === "yes" || v.vote === "paired_yes"
      ).length;
      const no = issueVotes.filter(
        (v) => v.vote === "no" || v.vote === "paired_no"
      ).length;
      const total = yes + no;
      return {
        issue,
        label: cfg.label,
        icon: cfg.icon,
        color: cfg.color,
        yes,
        no,
        total,
        yesRate: total > 0 ? Math.round((yes / total) * 100) : 0,
        recentBills: issueVotes
          .filter((v) => v.title && !isProcedural(v.title))
          .slice(0, 3)
          .map((v) => v.title),
      };
    })
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total);

  // Map recent votes for VotesTab display
  const allVotesForTab = (votesRes.data ?? []).map((v) => ({
    id: v.id,
    vote: v.vote,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    title: (v.proposals as any)?.title ?? "",
    date: v.voted_at ?? undefined,
  }));

  const voteCount = voteCountRes.count ?? 0;
  const donorCount = donorCountRes.count ?? 0;
  const cachedAiProfile: string | null = aiSummaryRes?.data?.summary_text ?? null;

  // Years in office
  const yearsInOffice = official.term_start
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(official.term_start).getTime()) /
            (365.25 * 24 * 60 * 60 * 1000)
        )
      )
    : null;

  const party = PARTY_STYLES[official.party ?? ""] ?? DEFAULT_PARTY;
  const recentVotes = (votesRes.data ?? []) as VoteRow[];

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker entityType="official" entityId={params.id} />
      {/* Nav */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <a href="/" className="hover:text-gray-900 transition-colors">Civitics</a>
            <span className="text-gray-300">/</span>
            <a href="/officials" className="hover:text-gray-900 transition-colors">Officials</a>
            <span className="text-gray-300">/</span>
            <span className="text-gray-900 font-medium truncate max-w-xs">{official.full_name}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">

        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <div className={`rounded-lg border border-gray-200 bg-white overflow-hidden ${party.border}`}>
          <div className="p-6">
            <div className="flex items-start gap-5">
              {/* Avatar + mini badge */}
              <div className="flex flex-col items-center gap-2 shrink-0">
                {official.photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={official.photo_url}
                    alt={official.full_name}
                    className="h-20 w-20 rounded-full border-2 border-gray-200 object-cover"
                  />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-gray-200 bg-gray-100 text-2xl font-bold text-gray-500">
                    {initials(official.full_name)}
                  </div>
                )}
                {(voteCount > 0 || donorCount > 0) && (
                  <div className="w-12 h-12" title="Connection profile">
                    <CivicBadge
                      entityId={official.id}
                      entityLabel={official.full_name}
                      size="small"
                      party={official.party ?? undefined}
                    />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${party.badge}`}>
                    {party.label}
                  </span>
                  {official.chamber && (
                    <span className="rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                      {official.chamber.toUpperCase()}
                    </span>
                  )}
                  {official.is_active === false && (
                    <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold bg-gray-100 text-gray-500">
                      Former
                    </span>
                  )}
                  {official.is_active === true && (
                    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-emerald-50 text-emerald-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
                      Active
                    </span>
                  )}
                </div>

                <h1 className="text-2xl font-bold text-gray-900 leading-tight">
                  {official.full_name}
                </h1>
                <p className="mt-0.5 text-base text-gray-600">{official.role_title}</p>
                {official.state_name && (
                  <p className="mt-0.5 text-sm text-gray-500">
                    {official.state_name}
                    {official.district_name ? ` · ${official.district_name}` : ""}
                  </p>
                )}

                {/* Term */}
                {(official.term_start || official.term_end) && (
                  <p className="mt-2 text-xs text-gray-400">
                    Term: {formatDate(official.term_start)} → {official.term_end ? formatDate(official.term_end) : "present"}
                  </p>
                )}

                {/* Contact */}
                <div className="mt-3 flex flex-wrap gap-3">
                  {official.email && (
                    <a
                      href={`mailto:${official.email}`}
                      className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                    >
                      {official.email}
                    </a>
                  )}
                  {official.phone && (
                    <span className="text-xs text-gray-500">{official.phone}</span>
                  )}
                </div>

                {/* Action buttons */}
                <div className="mt-4 flex flex-wrap gap-2">
                  <a
                    href={`/graph?entity=${official.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 transition-colors"
                  >
                    <span>◎</span>
                    View in Graph
                  </a>
                  <ShareButton
                    name={official.full_name}
                    url={`/officials/${official.id}`}
                  />
                  {official.website_url && (
                    <a
                      href={official.website_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      Official site ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-2 gap-px border-t border-gray-100 bg-gray-100 sm:grid-cols-4">
            <StatCell value={voteCount.toLocaleString()} label="Votes on record" />
            <StatCell
              value={donorCount.toLocaleString()}
              label="Donors on record"
              note={donorCount === 0 ? "FEC sync weekly" : undefined}
            />
            <StatCell
              value={formatMoney(totalDonations)}
              label="Total raised"
              note={totalDonations === 0 ? "FEC sync weekly" : undefined}
            />
            <StatCell
              value={yearsInOffice !== null ? `${yearsInOffice}y` : "—"}
              label="Years in office"
            />
          </div>
        </div>

        {/* ── TABS ────────────────────────────────────────────────────────── */}
        <ProfileTabs
          voteCount={voteCount}
          donorCount={donorCount}
          issueStats={issueStats}
          voteBreakdown={voteBreakdown}
          allVotes={allVotesForTab}
          overview={
            <div className="p-6 space-y-6">
              {/* AI Summary */}
              {cachedAiProfile ? (
                <div className="rounded-md border border-indigo-100 bg-indigo-50 px-4 py-3">
                  <p className="text-sm text-gray-700 leading-relaxed">{cachedAiProfile}</p>
                  <p className="mt-1.5 text-[10px] text-indigo-400">Civic profile · AI generated</p>
                </div>
              ) : (voteCount > 0 || donorCount > 0) ? (
                <AiProfileSection officialId={official.id} />
              ) : null}

              {/* Quick vote breakdown */}
              {recentVotes.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Votes</h3>
                  <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 overflow-hidden">
                    {recentVotes.slice(0, 5).map((v) => {
                      const vs = VOTE_STYLES[v.vote] ?? { label: v.vote, cls: "bg-gray-100 text-gray-600" };
                      const proposal = v.proposals;
                      const label = proposal?.short_title ?? proposal?.title ?? "Unknown bill";
                      return (
                        <div key={v.id} className="flex items-center gap-3 px-4 py-3">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${vs.cls}`}>
                            {vs.label}
                          </span>
                          <p className="flex-1 truncate text-xs text-gray-700">{label}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Top donors preview */}
              {topDonors.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Donors</h3>
                  <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 overflow-hidden">
                    {topDonors.slice(0, 5).map((d, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-500">
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-xs font-medium text-gray-800">{d.donor_name}</p>
                          <p className="truncate text-[10px] text-gray-400">
                            {d.industry ?? d.donor_type}
                          </p>
                        </div>
                        <p className="shrink-0 text-xs font-semibold text-gray-900">
                          {formatMoney(d.total_cents)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          }
          donations={
            <div>
              {/* Industry breakdown */}
              {industrySummary.length > 0 && (
                <div className="p-5 border-b border-gray-100">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                    By Industry/Type
                  </h3>
                  <div className="space-y-2">
                    {industrySummary.map((item) => (
                      <div key={item.sector}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-gray-700 font-medium truncate max-w-[60%]">
                            {item.sector}
                          </span>
                          <span className="text-gray-500 tabular-nums">
                            {item.pct}% · {formatMoney(item.totalCents)}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-indigo-500 transition-all"
                            style={{ width: `${item.pct}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Donor list */}
              <div className="divide-y divide-gray-100">
                {topDonors.length === 0 ? (
                  <div className="px-5 py-8 text-center">
                    <p className="text-sm font-medium text-gray-500">No donor data available</p>
                  </div>
                ) : (
                  topDonors.map((d, i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-500">
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-xs font-medium text-gray-800">{d.donor_name}</p>
                        <p className="truncate text-[10px] text-gray-400">
                          {DONOR_TYPE_LABELS[d.donor_type] ?? d.donor_type}
                          {d.industry ? ` · ${d.industry}` : ""}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs font-semibold text-gray-900">{formatMoney(d.total_cents)}</p>
                        <p className="text-[10px] text-gray-400">
                          {d.count} transaction{d.count !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          }
          connections={
            <div className="p-0">
              <OfficialGraph
                officialId={official.id}
                officialName={official.full_name}
                officialParty={official.party}
              />

              {/* Opponents / Election Data */}
              <div className="border-t border-gray-100 p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">Election &amp; Opponents</h3>
                    <p className="text-xs text-gray-400 mt-0.5">Upcoming and recent election data</p>
                  </div>
                  <span className="text-[10px] bg-amber-50 text-amber-600 border border-amber-200 rounded-full px-2 py-0.5 font-medium">
                    Coming soon
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {/* Next election placeholder */}
                  <div className="rounded-lg border border-dashed border-gray-200 p-4 bg-gray-50/50">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">🗳</span>
                      <span className="text-xs font-medium text-gray-600">Next Election</span>
                    </div>
                    <p className="text-xs text-gray-400 leading-relaxed">
                      Election date, ballot position, and district info will appear here.
                    </p>
                    <div className="mt-3 h-1 rounded-full bg-gray-200 overflow-hidden">
                      <div className="h-full w-0 bg-indigo-400 rounded-full" />
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1">Polling data not yet available</p>
                  </div>

                  {/* Opponents placeholder */}
                  <div className="rounded-lg border border-dashed border-gray-200 p-4 bg-gray-50/50">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">👥</span>
                      <span className="text-xs font-medium text-gray-600">Opponents</span>
                    </div>
                    <p className="text-xs text-gray-400 leading-relaxed">
                      Declared candidates and challengers will be listed here with their donor networks for comparison.
                    </p>
                    <div className="mt-3 flex gap-2">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="h-8 w-8 rounded-full bg-gray-200 animate-pulse" />
                      ))}
                      <div className="h-8 w-8 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center">
                        <span className="text-gray-400 text-xs">+</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Comparison teaser */}
                <div className="mt-4 rounded-lg bg-indigo-50 border border-indigo-100 p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">⚖️</span>
                    <div>
                      <p className="text-xs font-medium text-gray-800">
                        Side-by-side comparison coming soon
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Compare donor networks, voting records, and alignment scores between candidates.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          }
        />

      </main>

      <footer className="mt-16 border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-gray-500">
              Civitics — open civic infrastructure. Beta · All data is public record.
            </p>
            <a href="/officials" className="text-xs text-gray-400 hover:text-indigo-600 transition-colors">
              ← Back to all officials
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function StatCell({
  value,
  label,
  note,
}: {
  value: string;
  label: string;
  note?: string;
}) {
  return (
    <div className="bg-white px-4 py-3 text-center">
      <p className="text-lg font-bold text-gray-900">{value}</p>
      <p className="mt-0.5 text-[10px] text-gray-400">{label}</p>
      {note && <p className="text-[9px] text-gray-300">{note}</p>}
    </div>
  );
}
