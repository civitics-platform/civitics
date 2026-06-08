import type { Metadata } from "next";
import { notFound } from "next/navigation";
import nextDynamic from "next/dynamic";
import { createPublicClient, fetchIndustryTagsByEntityId } from "@civitics/db";
import { fetchAllRows } from "@/lib/paginate";
// FIX-205: defer the D3 graph chunk off the initial /officials/[id] bundle.
// Most visitors land on the profile and never expand the graph; even when
// they do, the chunk loads on demand.
const OfficialGraph = nextDynamic(
  () => import("../components/OfficialGraph").then((m) => ({ default: m.OfficialGraph })),
  { ssr: false, loading: () => <div className="h-[400px] bg-gray-50 rounded-lg" /> }
);
import { AiProfileSection } from "../components/AiProfileSection";
import { ProfileTabs } from "../components/ProfileTabs";
import { ShareButton } from "../components/ShareButton";
import { CareerHistory } from "../components/CareerHistory";
import { PromisesSection } from "../components/PromisesSection";
import { SpendingSection } from "../components/SpendingSection";
import { EntityComments } from "../../components/EntityComments";
import { ResponsivenessCard } from "../components/ResponsivenessCard";
import { gradeFromRate } from "../../api/officials/[id]/responsiveness/_lib";
import { PageViewTracker } from "../../components/PageViewTracker";
import { FollowButton } from "../../components/FollowButton";
import { SourceBadge } from "../../components/SourceBadge";
import { SourceDetailPopover } from "../../components/SourceDetailPopover";
import { getCachedOfficial } from "../_lib/get-official";

const CivicBadge = nextDynamic(
  () => import("@civitics/graph").then((m) => ({ default: m.CivicBadge })),
  { ssr: false }
);

// Public official detail; no auth dependency. RLS allows anon SELECT on
// officials, votes, financial_relationships, ai_summary_cache, career_history,
// promises, civic_initiative_responses, financial_entities, jurisdictions,
// governing_bodies, entity_tags. Switching off createAdminClient also
// removes the build-time secret-key constraint, so the page can use real
// ISR (5-min revalidation) instead of force-dynamic + CDN cache.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata(
  { params }: { params: { id: string } }
): Promise<Metadata> {
  const data = await getCachedOfficial(params.id);
  if (!data) return { title: "Official | Civitics" };

  const description = [
    data.role_title,
    data.party ? `(${data.party.charAt(0).toUpperCase() + data.party.slice(1)})` : null,
    data.district_name,
  ].filter(Boolean).join(" · ");

  return {
    title: data.full_name,
    description,
    openGraph: {
      title: `${data.full_name} | Civitics`,
      description,
      ...(data.photo_url ? { images: [{ url: data.photo_url }] } : {}),
    },
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

type VoteRow = {
  id: string;
  vote: string;
  voted_at: string | null;
  roll_call_id: string | null;
  bill_proposal_id?: string | null;
  // `proposals` is attached at runtime by the two-step hydration (votes has no
  // direct FK to proposals), so it's optional on the statically-typed select.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proposals?: any | null;
};

type DonorRow = {
  donor_name: string;
  donor_type: string;
  industry: string | null;
  total_cents: number;
  count: number;
};

// FIX-270: super-PAC IE rows are politically distinct from donations —
// money spent on the candidate's behalf (or against them) under Schedule E,
// not capped contributions to the campaign. We surface them as separate
// lists so the legal and political distinction stays visible.
type OutsideSpenderRow = {
  spender_id: string;
  spender_name: string;
  spender_type: string;
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
  const supabase = createPublicClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  // Fetch official + joins in parallel with votes, donor count, donor amounts, AI summary, career history, promises.
  // Official itself comes from the React.cache()-wrapped fetcher so generateMetadata
  // and this page share a single Supabase round-trip.
  const [officialData, voteCountRes, votesRes, donorRollupRes, aiSummaryRes, allVotesRes, careerHistoryRes, promisesRes, responsivenessRes] =
    await Promise.all([
      getCachedOfficial(params.id),
      supabase
        .from("votes")
        .select("id", { count: "exact", head: true })
        .eq("official_id", params.id),
      supabase
        .from("votes")
        .select("id, vote, voted_at, roll_call_id, bill_proposal_id")
        .eq("official_id", params.id)
        .order("voted_at", { ascending: false })
        .limit(100),
      // FIX-518 — donor + IE aggregations read official_donor_rollup_mv: per
      // (official, relationship_type) the top-1000 donors (rank 1..1000) plus
      // one tail-bucket row (rank 1001, donor_id NULL, tail_donor_count set),
      // donor_name/entity_type/industry_label denormalized at refresh time.
      // Replaces both the donor-count head query and the 50k-row fetchAllRows
      // donation scan that JS-aggregated per render and silently undercounted
      // heavily-funded officials at the ceiling (the whale: 308,847 rows /
      // $268M). relationship_type ∈ ('donation','ie_support','ie_oppose')
      // (FIX-270). Paginated: up to 3×1001 rows exceeds the 1000-row PostgREST
      // cap, which would silently drop the donation tail row (rank 1001 — where
      // most of a small-dollar official's money lives) and the IE rows. The
      // (official_id, relationship_type, rank) unique key is a stable total
      // order. ORDER BY rank is materialized — no request-time sort. EXISTS-
      // gated fallback (below) preserves correctness if the MV is stale/missing.
      (async () => {
        const { rows } = await fetchAllRows<{
          relationship_type: string;
          rank: number;
          donor_id: string | null;
          donor_name: string | null;
          entity_type: string | null;
          industry_label: string | null;
          total_cents: number;
          tx_count: number;
          tail_donor_count: number | null;
        }>((f, t) =>
          sb
            .from("official_donor_rollup_mv")
            .select("relationship_type, rank, donor_id, donor_name, entity_type, industry_label, total_cents, tx_count, tail_donor_count")
            .eq("official_id", params.id)
            .order("relationship_type", { ascending: true })
            .order("rank", { ascending: true })
            .range(f, t),
          { maxRows: 10000 },
        );
        return { data: rows };
      })(),
      sb
        .from("ai_summary_cache")
        .select("summary_text")
        .eq("entity_type", "official")
        .eq("entity_id", params.id)
        .eq("summary_type", "profile")
        .maybeSingle(),
      supabase
        .from("votes")
        .select("vote, bill_proposal_id")
        .eq("official_id", params.id)
        .limit(500),
      supabase
        .from("career_history")
        .select("id, organization, role_title, started_at, ended_at, is_government, revolving_door_flag, revolving_door_explanation")
        .eq("official_id", params.id)
        .order("started_at", { ascending: false })
        .limit(20),
      supabase
        .from("promises")
        .select("id, title, description, status, made_at, deadline, resolved_at, source_url, source_quote")
        .eq("official_id", params.id)
        .order("made_at", { ascending: false })
        .limit(10),
      supabase
        .from("civic_initiative_responses")
        .select("id, initiative_id, response_type, responded_at, window_closes_at, window_opened_at, proposals!initiative_id(id, title, type, initiative_details(scope))")
        .eq("official_id", params.id)
        .order("window_opened_at", { ascending: false })
        .limit(20),
    ]);

  // votes.bill_proposal_id FKs to bill_details(proposal_id), not proposals, so a
  // PostgREST embed (proposals!bill_proposal_id) errors → silent empty vote history.
  // Two-step: fetch the proposals for both vote queries and attach a `proposals`
  // field so downstream consumers are unchanged. bill_proposal_id IS a proposals.id.
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const voteRowsToHydrate = [
      ...((votesRes.data ?? []) as any[]),
      ...((allVotesRes.data ?? []) as any[]),
    ];
    const billProposalIds = [
      ...new Set(voteRowsToHydrate.map((v) => v.bill_proposal_id).filter(Boolean) as string[]),
    ];
    if (billProposalIds.length > 0) {
      const propById = new Map<
        string,
        { id: string; title: string | null; short_title: string | null; bill_details: { bill_number: string | null } | null }
      >();
      const CHUNK = 300;
      for (let i = 0; i < billProposalIds.length; i += CHUNK) {
        const { data: props } = await supabase
          .from("proposals")
          .select("id, title, short_title, bill_details(bill_number)")
          .in("id", billProposalIds.slice(i, i + CHUNK));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const p of ((props ?? []) as any[])) {
          const bd = Array.isArray(p.bill_details) ? p.bill_details[0] : p.bill_details;
          propById.set(p.id, {
            id: p.id,
            title: p.title ?? null,
            short_title: p.short_title ?? null,
            bill_details: bd ? { bill_number: bd.bill_number ?? null } : null,
          });
        }
      }
      for (const v of voteRowsToHydrate) {
        v.proposals = v.bill_proposal_id ? propById.get(v.bill_proposal_id) ?? null : null;
      }
    }
  }

  if (!officialData) {
    notFound();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = officialData as any;
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
    tier: (o.tier ?? "elected") as string,
    jurisdiction_id: (o.jurisdiction_id ?? null) as string | null,
    state_name: (o.jurisdictions?.name ?? null) as string | null,
    chamber: (o.governing_bodies?.short_name ?? null) as string | null,
    // FIX-474 — link the official to their governing body (institution page).
    governing_body_id: (o.governing_bodies?.id ?? null) as string | null,
    governing_body_name: (o.governing_bodies?.name ?? o.governing_bodies?.short_name ?? null) as string | null,
    attribution: o.attribution,
  };

  // FIX-246: candidate-tier officials skip incumbent-only sections (votes,
  // committees, promises, career history) since their data is empty by design.
  const isCandidate = official.tier === "candidate";

  // ── Donor + IE view (FIX-518) ───────────────────────────────────────────────
  // Built from official_donor_rollup_mv (ranked top-1000 donors + tail bucket
  // per relationship_type). totalDonations / donorCount include the tail so the
  // headline figures are the TRUE totals past the leaf cap; topDonors and the
  // industry breakdown render the ranked rows (the tail has no per-donor / per-
  // industry identity). EXISTS-gated fallback re-runs the pre-FIX-518 live
  // fetchAllRows aggregation when the MV has no rows for this official but
  // donations exist (stale/missing refresh) — never an empty list pretending
  // to be a real zero.
  type RollupRow = {
    relationship_type: string;
    rank: number;
    donor_id: string | null;
    donor_name: string | null;
    entity_type: string | null;
    industry_label: string | null;
    total_cents: number;
    tx_count: number;
    tail_donor_count: number | null;
  };

  function buildIeFromRollup(rows: RollupRow[]): { rows: OutsideSpenderRow[]; total: number } {
    const total = rows.reduce((s, r) => s + Number(r.total_cents ?? 0), 0);
    const ranked = rows
      .filter((r) => r.donor_id !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 50)
      .map((r) => ({
        spender_id:   r.donor_id as string,
        spender_name: r.donor_name ?? "Unknown",
        spender_type: r.entity_type ?? "other",
        total_cents:  Number(r.total_cents ?? 0),
        count:        Number(r.tx_count ?? 0),
      }));
    return { rows: ranked, total };
  }

  let topDonors: DonorRow[] = [];
  let totalDonations = 0;
  let donorCount = 0;
  let industrySummary: { sector: string; totalCents: number; pct: number }[] = [];
  let ieSupport: { rows: OutsideSpenderRow[]; total: number } = { rows: [], total: 0 };
  let ieOppose:  { rows: OutsideSpenderRow[]; total: number } = { rows: [], total: 0 };

  const rollupRows = (donorRollupRes.data ?? []) as RollupRow[];

  if (rollupRows.length > 0) {
    const donationRows = rollupRows.filter((r) => r.relationship_type === "donation");
    const rankedDonations = donationRows.filter((r) => r.donor_id !== null);

    totalDonations = donationRows.reduce((s, r) => s + Number(r.total_cents ?? 0), 0);
    donorCount     = donationRows.reduce((s, r) => s + Number(r.tx_count ?? 0), 0);

    topDonors = rankedDonations
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 50)
      .map((r) => ({
        donor_name:  r.donor_name ?? "Unknown",
        donor_type:  r.entity_type ?? "other",
        industry:    r.industry_label ?? null,
        total_cents: Number(r.total_cents ?? 0),
        count:       Number(r.tx_count ?? 0),
      }));

    const bySector = new Map<string, number>();
    for (const r of rankedDonations) {
      const sector = r.industry_label ?? r.entity_type ?? "Other";
      bySector.set(sector, (bySector.get(sector) ?? 0) + Number(r.total_cents ?? 0));
    }
    industrySummary = [...bySector.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([sector, cents]) => ({
        sector,
        totalCents: cents,
        pct: totalDonations > 0 ? Math.round((cents / totalDonations) * 100) : 0,
      }));

    ieSupport = buildIeFromRollup(rollupRows.filter((r) => r.relationship_type === "ie_support"));
    ieOppose  = buildIeFromRollup(rollupRows.filter((r) => r.relationship_type === "ie_oppose"));
  } else {
    // EXISTS probe (cheap — never COUNT(*), which seq-scans for a whale): does
    // this official have ANY donation row despite an empty MV? If so the MV is
    // stale/unrefreshed → fall back to the live aggregation.
    const { data: probe } = await sb
      .from("financial_relationships")
      .select("id")
      .eq("relationship_type", "donation")
      .eq("to_type", "official")
      .eq("to_id", params.id)
      .limit(1);

    if (probe && probe.length > 0) {
      const { rows: inflowRaw } = await fetchAllRows<{ from_id: string; amount_cents: number | null; relationship_type: string }>((f, t) =>
        sb
          .from("financial_relationships")
          .select("from_id, amount_cents, relationship_type")
          .in("relationship_type", ["donation", "ie_support", "ie_oppose"])
          .eq("to_type", "official")
          .eq("to_id", params.id)
          .eq("from_type", "financial_entity")
          .order("id", { ascending: true })
          .range(f, t),
        { maxRows: 50000 },
      );
      const fromEntityIds = [...new Set(inflowRaw.map((d) => d.from_id))];
      const entityInfo = new Map<string, { display_name: string; industry: string | null; entity_type: string | null }>();
      if (fromEntityIds.length > 0) {
        const industryByEntityId = await fetchIndustryTagsByEntityId(supabase, fromEntityIds);
        const BATCH = 300;
        for (let i = 0; i < fromEntityIds.length; i += BATCH) {
          const batch = fromEntityIds.slice(i, i + BATCH);
          const { data: entities } = await supabase
            .from("financial_entities")
            .select("id, display_name, entity_type")
            .in("id", batch);
          for (const e of entities ?? []) {
            entityInfo.set(e.id, {
              display_name: e.display_name,
              industry:     industryByEntityId.get(e.id)?.display_label ?? null,
              entity_type:  e.entity_type,
            });
          }
        }
      }
      const enriched = inflowRaw.map((r) => {
        const info = entityInfo.get(r.from_id);
        return {
          from_id:           r.from_id,
          donor_name:        info?.display_name ?? "Unknown",
          donor_type:        info?.entity_type ?? "other",
          industry:          info?.industry ?? null,
          amount_cents:      r.amount_cents,
          relationship_type: r.relationship_type,
        };
      });
      const donations = enriched.filter((r) => r.relationship_type === "donation");

      const donorMap = new Map<string, { donor_type: string; industry: string | null; total_cents: number; count: number }>();
      for (const row of donations) {
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
      topDonors = Array.from(donorMap.entries())
        .map(([donor_name, v]) => ({ donor_name, ...v }))
        .sort((a, b) => b.total_cents - a.total_cents)
        .slice(0, 50);
      totalDonations = donations.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);
      donorCount = donations.length;

      const bySector = new Map<string, number>();
      for (const row of donations) {
        const sector = row.industry ?? row.donor_type ?? "Other";
        bySector.set(sector, (bySector.get(sector) ?? 0) + (row.amount_cents ?? 0));
      }
      industrySummary = [...bySector.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([sector, cents]) => ({
          sector,
          totalCents: cents,
          pct: totalDonations > 0 ? Math.round((cents / totalDonations) * 100) : 0,
        }));

      function aggregateOutsideSpenders(rows: typeof enriched): { rows: OutsideSpenderRow[]; total: number } {
        const map = new Map<string, OutsideSpenderRow>();
        let total = 0;
        for (const r of rows) {
          total += r.amount_cents ?? 0;
          const existing = map.get(r.from_id);
          if (existing) {
            existing.total_cents += r.amount_cents ?? 0;
            existing.count       += 1;
          } else {
            map.set(r.from_id, {
              spender_id:   r.from_id,
              spender_name: r.donor_name,
              spender_type: r.donor_type,
              total_cents:  r.amount_cents ?? 0,
              count:        1,
            });
          }
        }
        const aggregated = [...map.values()].sort((a, b) => b.total_cents - a.total_cents).slice(0, 50);
        return { rows: aggregated, total };
      }
      ieSupport = aggregateOutsideSpenders(enriched.filter((r) => r.relationship_type === "ie_support"));
      ieOppose  = aggregateOutsideSpenders(enriched.filter((r) => r.relationship_type === "ie_oppose"));
    }
  }

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

  const taggedVotes = substantiveVotesRaw.map((v) => {
    const bd = Array.isArray(v.proposals?.bill_details) ? v.proposals.bill_details[0] : v.proposals?.bill_details;
    return {
      vote: v.vote as string,
      title: (v.proposals?.title ?? "") as string,
      billNumber: (bd?.bill_number ?? undefined) as string | undefined,
      issues: tagIssues(v.proposals?.title ?? ""),
    };
  });

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

  // Map recent votes for VotesTab display. `proposals` is attached at runtime by
  // the two-step hydration above; the typed select doesn't include it, so cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allVotesForTab = ((votesRes.data ?? []) as any[]).map((v) => ({
    id: v.id,
    vote: v.vote,
    title: v.proposals?.title ?? "",
    proposalId: v.proposals?.id as string | undefined,
    date: v.voted_at ?? undefined,
  }));

  const voteCount = voteCountRes.count ?? 0;
  // donorCount is derived from the rollup MV above (SUM of tx_count over the
  // official's donation rows) — see the FIX-518 donor-view block.
  const cachedAiProfile: string | null = aiSummaryRes?.data?.summary_text ?? null;
  // QWEN-ADDED: Extract career history data for CareerHistory component
  const careerHistory = (careerHistoryRes.data ?? []) as Array<{
    id: string;
    organization: string;
    role_title: string | null;
    started_at: string | null;
    ended_at: string | null;
    is_government: boolean;
    revolving_door_flag: boolean;
    revolving_door_explanation: string | null;
  }>;

  // QWEN-ADDED: Extract promises data for PromisesSection component
  const promises = (promisesRes.data ?? []) as Array<{
    id: string;
    title: string;
    description: string | null;
    status: 'made' | 'in_progress' | 'kept' | 'broken' | 'partially_kept' | 'expired' | 'modified';
    made_at: string | null;
    deadline: string | null;
    resolved_at: string | null;
    source_url: string | null;
    source_quote: string | null;
  }>;

  // QWEN-ADDED: Fetch spending records — after shadow→public promotion these live
  // in financial_relationships with relationship_type IN ('contract','grant').
  // Donor = awarding_agency (from_type='agency'), recipient = financial_entity.
  let spendingRecords: Array<{
    id: string;
    recipient_name: string;
    award_type: string | null;
    amount_cents: number;
    award_date: string | null;
    description: string | null;
    awarding_agency: string;
  }> = [];
  if (official.jurisdiction_id) {
    const { data: rows } = await supabase
      .from("financial_relationships")
      .select("id, from_id, to_id, amount_cents, occurred_at, relationship_type, metadata")
      .in("relationship_type", ["contract", "grant"])
      // FIX-503: amount_cents>0 lets the top-10 use the partial DESC index
      // financial_relationships_amount (prod cost 371k → 39) instead of a
      // parallel seq scan + sort, and drops NULL-amount rows that sort first
      // under DESC and would otherwise crowd out the real top contracts.
      .gt("amount_cents", 0)
      .order("amount_cents", { ascending: false })
      .limit(10);
    const spendRows = rows ?? [];
    const agencyIds    = [...new Set(spendRows.map((r) => r.from_id))];
    const recipientIds = [...new Set(spendRows.map((r) => r.to_id))];
    const [agenciesRes, recipientsRes] = await Promise.all([
      agencyIds.length > 0
        ? supabase.from("agencies").select("id, name").in("id", agencyIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
      recipientIds.length > 0
        ? supabase.from("financial_entities").select("id, display_name").in("id", recipientIds)
        : Promise.resolve({ data: [] as Array<{ id: string; display_name: string }> }),
    ]);
    const agencyName = new Map<string, string>();
    for (const a of agenciesRes.data ?? []) agencyName.set(a.id, a.name);
    const recipientName = new Map<string, string>();
    for (const r of recipientsRes.data ?? []) recipientName.set(r.id, r.display_name);
    spendingRecords = spendRows.map((r) => ({
      id:              r.id,
      recipient_name:  recipientName.get(r.to_id) ?? "Unknown recipient",
      award_type:      r.relationship_type,
      amount_cents:    r.amount_cents ?? 0,
      award_date:      r.occurred_at,
      description:     ((r.metadata ?? {}) as Record<string, string>)?.description ?? null,
      awarding_agency: agencyName.get(r.from_id) ?? "Unknown agency",
    }));
  }

  // ── Responsiveness score ──────────────────────────────────────────────────────
  const now = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responsivenessRows = (responsivenessRes.data ?? []) as any[];
  let civicResponded   = 0;
  let civicNoResponse  = 0;
  let civicOpen        = 0;
  for (const r of responsivenessRows) {
    if (r.responded_at)                                    civicResponded++;
    else if (new Date(r.window_closes_at) < now)           civicNoResponse++;
    else                                                   civicOpen++;
  }
  const civicTotalClosed   = civicResponded + civicNoResponse;
  const civicResponseRate  = civicTotalClosed > 0
    ? Math.round((civicResponded / civicTotalClosed) * 100)
    : null;
  const civicGrade         = civicResponseRate !== null ? gradeFromRate(civicResponseRate) : null;

  const responsivenessData = {
    responded:     civicResponded,
    no_response:   civicNoResponse,
    open:          civicOpen,
    total_closed:  civicTotalClosed,
    response_rate: civicResponseRate,
    grade:         civicGrade,
    recent: responsivenessRows.slice(0, 10).map((r) => {
      const p = Array.isArray(r.proposals) ? r.proposals[0] : r.proposals;
      const details = p?.initiative_details
        ? (Array.isArray(p.initiative_details) ? p.initiative_details[0] : p.initiative_details)
        : null;
      return {
        initiative_id:    r.initiative_id as string,
        initiative_title: (p?.title ?? "Unknown initiative") as string,
        scope:            (details?.scope ?? "federal") as string,
        response_type:    r.response_type as string,
        responded_at:     r.responded_at as string | null,
        window_closes_at: r.window_closes_at as string,
        window_opened_at: r.window_opened_at as string,
      };
    }),
  };

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

  // ── JSON-LD structured data (schema.org/Person) ───────────────────────────
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://civitics.com";
  const officialJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: official.full_name,
    jobTitle: official.role_title,
    url: `${baseUrl}/officials/${params.id}`,
    ...(official.photo_url ? { image: official.photo_url } : {}),
    ...(official.email ? { email: official.email } : {}),
    ...(official.website_url ? { sameAs: official.website_url } : {}),
    ...(official.district_name ? { description: official.district_name } : {}),
    affiliation: {
      "@type": "Organization",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      name: (official as any).governing_bodies?.short_name ?? "U.S. Government",
    },
    ...(official.party
      ? {
          memberOf: {
            "@type": "Organization",
            name:
              official.party.charAt(0).toUpperCase() + official.party.slice(1),
          },
        }
      : {}),
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(officialJsonLd) }}
      />
      {/* FIX-398: attribution payload embedded for the FIX-399 SourceBadge
          hydration hook. Not visually rendered. */}
      <script
        type="application/json"
        data-civitics-attribution="official"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(official.attribution) }}
      />
      <PageViewTracker entityType="official" entityId={params.id} />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">

        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <div className={`rounded-lg border border-gray-200 bg-white overflow-hidden ${party.border}`}>
          <div className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
              {/* Avatar + mini badge */}
              <div className="flex flex-row items-center gap-4 sm:flex-col sm:items-center sm:gap-2 shrink-0">
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
                  {isCandidate && (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-900">
                      Candidate
                    </span>
                  )}
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
                  <SourceDetailPopover
                    entityType="official"
                    entityId={params.id}
                    attribution={official.attribution}
                  >
                    <SourceBadge attribution={official.attribution} />
                  </SourceDetailPopover>
                </div>

                <h1 className="text-2xl font-bold text-gray-900 leading-tight">
                  {official.full_name}
                </h1>
                <p className="mt-0.5 text-base text-gray-600">{official.role_title}</p>
                {/* FIX-474 — link to the official's governing body (institution page) */}
                {official.governing_body_id && official.governing_body_name && (
                  <p className="mt-0.5 text-sm text-gray-500">
                    <a
                      href={`/institutions/${official.governing_body_id}`}
                      className="hover:text-indigo-600 hover:underline transition-colors"
                    >
                      {official.governing_body_name}
                    </a>
                  </p>
                )}
                {official.state_name && (
                  <p className="mt-0.5 text-sm text-gray-500">
                    {official.jurisdiction_id ? (
                      <a
                        href={`/jurisdictions/${official.jurisdiction_id}`}
                        className="hover:text-indigo-600 hover:underline transition-colors"
                      >
                        {official.state_name}
                      </a>
                    ) : (
                      official.state_name
                    )}
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
                  <FollowButton
                    entityType="official"
                    entityId={official.id}
                    entityLabel={official.full_name}
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
          <div className="grid grid-cols-2 gap-px border-t border-gray-100 bg-gray-100 sm:grid-cols-5">
            <StatCell value={voteCount.toLocaleString()} label="Votes on record" />
            <StatCell
              value={donorCount.toLocaleString()}
              label="Donors on record"
              note={donorCount === 0 ? "FEC sync weekly" : undefined}
            />
            <StatCell
              value={formatMoney(totalDonations)}
              label="Total raised"
              note={
                ieSupport.total > 0 || ieOppose.total > 0
                  ? `+${formatMoney(ieSupport.total)} support · ${formatMoney(ieOppose.total)} oppose`
                  : totalDonations === 0
                    ? "FEC sync weekly"
                    : undefined
              }
            />
            <StatCell
              value={yearsInOffice !== null ? `${yearsInOffice}y` : "—"}
              label="Years in office"
            />
            <StatCell
              value={
                civicGrade
                  ? `${civicGrade} · ${civicResponseRate}%`
                  : civicOpen > 0
                  ? `${civicOpen} open`
                  : "—"
              }
              label="Civic responsiveness"
              note={civicTotalClosed > 0 ? `${civicResponded}/${civicTotalClosed} responded` : undefined}
            />
          </div>
        </div>

        {/* QWEN-ADDED: Promises Section - flagship feature, shown below basic info */}
        {/* FIX-246: hide incumbent-only sections for tier='candidate' rows */}
        {!isCandidate && <PromisesSection promises={promises} />}

        {/* ── TABS ────────────────────────────────────────────────────────── */}
        <ProfileTabs
          isCandidate={isCandidate}
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

              {/* QWEN-ADDED: Career History Section */}
              {!isCandidate && <CareerHistory items={careerHistory} />}

              {/* Civic responsiveness */}
              <ResponsivenessCard data={responsivenessData} />

              {/* Quick vote breakdown */}
              {!isCandidate && recentVotes.length > 0 && (
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
                          {proposal?.id ? (
                            <a
                              href={`/proposals/${proposal.id}`}
                              className="flex-1 truncate text-xs text-gray-700 hover:text-indigo-600 hover:underline transition-colors"
                            >
                              {label}
                            </a>
                          ) : (
                            <p className="flex-1 truncate text-xs text-gray-700">{label}</p>
                          )}
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

              {/* FIX-270: super-PAC independent expenditures (FEC Schedule E).
                  Money spent on behalf of (ie_support) or against (ie_oppose)
                  the candidate. Politically distinct from capped donations
                  above — kept in separate sections so the legal and
                  accountability distinction stays visible. */}
              <OutsideSpendingList
                title="Outside spending supporting"
                subtitle="Super-PAC IEs supporting this official (uncapped Schedule E)"
                spenders={ieSupport.rows}
                total={ieSupport.total}
                accent="emerald"
              />
              <OutsideSpendingList
                title="Outside spending opposing"
                subtitle="Super-PAC IEs opposing this official (uncapped Schedule E)"
                spenders={ieOppose.rows}
                total={ieOppose.total}
                accent="rose"
              />
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

        {/* QWEN-ADDED: Government Spending Section */}
        <SpendingSection items={spendingRecords} />

        {/* Community Comments */}
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <EntityComments
            entityType="official"
            entityId={official.id}
            allowedKinds={["discussion", "question", "concern", "evidence", "stakeholder_impact"]}
            stanceEnabled
            lensEnabled
          />
        </div>

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

function OutsideSpendingList({
  title,
  subtitle,
  spenders,
  total,
  accent,
}: {
  title: string;
  subtitle: string;
  spenders: OutsideSpenderRow[];
  total: number;
  accent: "emerald" | "rose";
}) {
  if (spenders.length === 0) return null;
  const accentCls =
    accent === "emerald"
      ? "border-emerald-100 bg-emerald-50/40"
      : "border-rose-100 bg-rose-50/40";
  const totalCls = accent === "emerald" ? "text-emerald-700" : "text-rose-700";
  return (
    <div className={`border-t ${accentCls}`}>
      <div className="px-5 py-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
        </div>
        <p className={`shrink-0 text-sm font-bold tabular-nums ${totalCls}`}>
          {formatMoney(total)}
        </p>
      </div>
      <div className="divide-y divide-gray-100 bg-white">
        {spenders.map((s, i) => (
          <div key={s.spender_id} className="flex items-center gap-3 px-5 py-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[10px] font-bold text-gray-500">
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <a
                href={`/donors/${s.spender_id}`}
                className="truncate text-xs font-medium text-gray-800 hover:text-indigo-600 hover:underline transition-colors block"
              >
                {s.spender_name}
              </a>
              <p className="truncate text-[10px] text-gray-400">
                {DONOR_TYPE_LABELS[s.spender_type] ?? s.spender_type}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs font-semibold text-gray-900">{formatMoney(s.total_cents)}</p>
              <p className="text-[10px] text-gray-400">
                {s.count} expenditure{s.count !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
