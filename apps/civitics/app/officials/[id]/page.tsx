import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { createServerClient, createAdminClient } from "@civitics/db";
import { OfficialGraph } from "../components/OfficialGraph";

export const revalidate = 3600;

// ─── Static pre-render top 100 officials for SEO ──────────────────────────────

export async function generateStaticParams() {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("officials")
      .select("id")
      .eq("is_active", true)
      .order("last_name")
      .limit(100);
    return (data ?? []).map((o) => ({ id: o.id }));
  } catch {
    return [];
  }
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
  individual:     "Individual",
  corporation:    "Corporation",
  pac:            "PAC",
  super_pac:      "Super PAC",
  party:          "Political Party",
  union:          "Union",
  nonprofit:      "Nonprofit",
  foreign:        "Foreign Entity",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function OfficialProfilePage({
  params,
}: {
  params: { id: string };
}) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  // Fetch official + joins in parallel with votes, donor count, donor amounts
  const [officialRes, voteCountRes, votesRes, donorCountRes, donorAmtRes] =
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
        .limit(10),
      supabase
        .from("financial_relationships")
        .select("id", { count: "exact", head: true })
        .eq("official_id", params.id),
      supabase
        .from("financial_relationships")
        .select("donor_name, donor_type, industry, amount_cents")
        .eq("official_id", params.id),
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
    .slice(0, 10);

  const voteCount = voteCountRes.count ?? 0;
  const donorCount = donorCountRes.count ?? 0;
  const totalDonations = (donorAmtRes.data ?? []).reduce(
    (sum, r) => sum + (r.amount_cents ?? 0),
    0
  );

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
              {/* Avatar */}
              {official.photo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={official.photo_url}
                  alt={official.full_name}
                  className="h-20 w-20 shrink-0 rounded-full border-2 border-gray-200 object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-2 border-gray-200 bg-gray-100 text-2xl font-bold text-gray-500">
                  {initials(official.full_name)}
                </div>
              )}

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
                  {official.website_url && (
                    <a
                      href={official.website_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
                    >
                      Official website →
                    </a>
                  )}
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

        {/* ── VOTING RECORD + CAMPAIGN FINANCE ──────────────────────────── */}
        <div className="mt-6 grid gap-6 lg:grid-cols-2">

          {/* Voting Record */}
          <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-3">
              <h2 className="text-sm font-semibold text-gray-900">Voting Record</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {voteCount.toLocaleString()} total votes · showing most recent
              </p>
            </div>

            {recentVotes.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <p className="text-sm font-medium text-gray-500">Voting record loading</p>
                <p className="mt-1 text-xs text-gray-400">
                  Check back as we sync congressional data.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentVotes.map((v) => {
                  const vs = VOTE_STYLES[v.vote] ?? { label: v.vote, cls: "bg-gray-100 text-gray-600" };
                  const proposal = v.proposals;
                  const label =
                    proposal?.bill_number ??
                    proposal?.short_title ??
                    proposal?.title ??
                    "Unknown bill";
                  return (
                    <div key={v.id} className="flex items-center gap-3 px-5 py-3">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${vs.cls}`}>
                        {vs.label}
                      </span>
                      <p className="flex-1 truncate text-xs text-gray-700">{label}</p>
                      {v.voted_at && (
                        <span className="shrink-0 text-[10px] text-gray-400">
                          {new Date(v.voted_at).toLocaleDateString("en-US", {
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
            )}
          </section>

          {/* Campaign Finance */}
          <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-3">
              <h2 className="text-sm font-semibold text-gray-900">Campaign Finance</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {donorCount.toLocaleString()} donors · {formatMoney(totalDonations)} total · FEC data
              </p>
            </div>

            {topDonors.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <p className="text-sm font-medium text-gray-500">Donor data loading</p>
                <p className="mt-1 text-xs text-gray-400">
                  FEC filings sync weekly. Data will appear when available.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {topDonors.map((d, i) => (
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
                      <p className="text-[10px] text-gray-400">{d.count} transaction{d.count !== 1 ? "s" : ""}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ── CONNECTION GRAPH ──────────────────────────────────────────── */}
        <div className="mt-6 rounded-lg border border-gray-200 bg-white overflow-hidden">
          <OfficialGraph
            officialId={official.id}
            officialName={official.full_name}
            officialParty={official.party}
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
