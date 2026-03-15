import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { AgencyGraph } from "./components/AgencyGraph";

export const revalidate = 3600;

// ─── Types ────────────────────────────────────────────────────────────────────

type Proposal = {
  id: string;
  title: string;
  status: string;
  type: string;
  bill_number: string | null;
  regulations_gov_id: string | null;
  introduced_at: string | null;
  comment_period_end: string | null;
  summary_plain: string | null;
};

type SpendingRow = {
  recipient_name: string;
  award_type: string | null;
  amount_cents: number;
  award_date: string | null;
};

type SpendingGroup = {
  recipient: string;
  awardType: string;
  totalCents: number;
  fiscalYear: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AGENCY_TYPE_LABELS: Record<string, string> = {
  federal:       "Federal Agency",
  state:         "State Agency",
  local:         "Local Agency",
  independent:   "Independent Agency",
  international: "International Body",
  other:         "Agency",
};

const AGENCY_TYPE_COLORS: Record<string, string> = {
  federal:       "bg-blue-50 text-blue-700 border-blue-200",
  state:         "bg-purple-50 text-purple-700 border-purple-200",
  local:         "bg-green-50 text-green-700 border-green-200",
  independent:   "bg-amber-50 text-amber-700 border-amber-200",
  international: "bg-indigo-50 text-indigo-700 border-indigo-200",
  other:         "bg-gray-50 text-gray-600 border-gray-200",
};

const PROPOSAL_STATUS: Record<string, { color: string; label: string }> = {
  open_comment:         { color: "bg-emerald-100 text-emerald-800", label: "Open Comment" },
  introduced:           { color: "bg-amber-100 text-amber-800",     label: "Proposed" },
  in_committee:         { color: "bg-amber-100 text-amber-800",     label: "In Review" },
  floor_vote:           { color: "bg-blue-100 text-blue-800",       label: "Floor Vote" },
  passed_committee:     { color: "bg-blue-100 text-blue-800",       label: "Passed Committee" },
  comment_closed:       { color: "bg-gray-100 text-gray-700",       label: "Comment Closed" },
  final_rule:           { color: "bg-green-100 text-green-800",     label: "Final Rule" },
  enacted:              { color: "bg-green-100 text-green-800",     label: "Enacted" },
  signed:               { color: "bg-green-100 text-green-800",     label: "Signed" },
  failed:               { color: "bg-red-100 text-red-800",         label: "Failed" },
  withdrawn:            { color: "bg-gray-100 text-gray-700",       label: "Withdrawn" },
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000_000) return `$${(dollars / 1_000_000_000).toFixed(1)}B`;
  if (dollars >= 1_000_000)     return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000)         return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

function getFiscalYear(isoDate: string | null): string {
  if (!isoDate) return "Unknown";
  const d = new Date(isoDate);
  // US fiscal year: Oct 1 – Sep 30
  const month = d.getMonth(); // 0-based
  const year  = d.getFullYear();
  return month >= 9 ? `FY${year + 1}` : `FY${year}`;
}

function aggregateSpending(rows: SpendingRow[]): SpendingGroup[] {
  const map = new Map<string, SpendingGroup>();

  for (const row of rows) {
    const fy  = getFiscalYear(row.award_date);
    const key = `${row.recipient_name}|${row.award_type ?? "other"}|${fy}`;

    if (map.has(key)) {
      map.get(key)!.totalCents += row.amount_cents;
    } else {
      map.set(key, {
        recipient:  row.recipient_name,
        awardType:  row.award_type ?? "other",
        totalCents: row.amount_cents,
        fiscalYear: fy,
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 10);
}

// ─── Static params (top 50 agencies pre-rendered) ────────────────────────────

export async function generateStaticParams() {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agencies")
    .select("id")
    .eq("is_active", true)
    .order("name")
    .limit(50);

  return (data ?? []).map((a) => ({ slug: a.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = createAdminClient();
  const { data } = await supabase.from("agencies").select("name, acronym").eq("id", slug).single();

  if (!data) return { title: "Agency" };
  const label = data.acronym ? `${data.acronym} — ${data.name}` : data.name;
  return { title: label };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AgencyProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const now = new Date().toISOString();

  // All fetches in parallel
  const [
    agencyRes,
    activeRulesRes,
    recentRulesRes,
    spendingRes,
    totalCountRes,
    openCountRes,
  ] = await Promise.all([
    supabase
      .from("agencies")
      .select("id, name, short_name, acronym, agency_type, website_url, contact_email, description, governing_body_id")
      .eq("id", slug)
      .single(),

    // Active rulemaking — will use agency key after we know it
    supabase
      .from("proposals")
      .select("id, title, status, type, bill_number, regulations_gov_id, introduced_at, comment_period_end, summary_plain")
      .in("status", ["open_comment", "introduced", "in_committee", "floor_vote"])
      .filter("metadata->>agency_id", "eq", slug) // placeholder; replaced below
      .order("comment_period_end", { ascending: true })
      .limit(20),

    // Recent closed rules
    supabase
      .from("proposals")
      .select("id, title, status, type, bill_number, regulations_gov_id, introduced_at, comment_period_end, summary_plain")
      .in("status", ["comment_closed", "final_rule", "enacted", "signed", "failed", "withdrawn"])
      .filter("metadata->>agency_id", "eq", slug)
      .order("updated_at", { ascending: false })
      .limit(5),

    // Spending records (top 100 raw rows, aggregate in JS)
    supabase
      .from("spending_records")
      .select("recipient_name, award_type, amount_cents, award_date")
      .ilike("awarding_agency", `%${slug}%`)
      .order("amount_cents", { ascending: false })
      .limit(100),

    // Total proposal count placeholder
    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .filter("metadata->>agency_id", "eq", slug),

    // Open comment count placeholder
    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .filter("metadata->>agency_id", "eq", slug)
      .eq("status", "open_comment")
      .gt("comment_period_end", now),
  ]);

  const agency = agencyRes.data;
  if (!agency) notFound();

  // Now re-run proposals queries using the real agency key (acronym or name)
  const agencyKey = agency.acronym ?? agency.name;

  const [activeRules2, recentRules2, totalCount2, openCount2] = await Promise.all([
    supabase
      .from("proposals")
      .select("id, title, status, type, bill_number, regulations_gov_id, introduced_at, comment_period_end, summary_plain")
      .in("status", ["open_comment", "introduced", "in_committee", "floor_vote"])
      .filter("metadata->>agency_id", "eq", agencyKey)
      .order("comment_period_end", { ascending: true })
      .limit(20),

    supabase
      .from("proposals")
      .select("id, title, status, type, bill_number, regulations_gov_id, introduced_at, comment_period_end, summary_plain")
      .in("status", ["comment_closed", "final_rule", "enacted", "signed", "failed", "withdrawn"])
      .filter("metadata->>agency_id", "eq", agencyKey)
      .order("updated_at", { ascending: false })
      .limit(5),

    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .filter("metadata->>agency_id", "eq", agencyKey),

    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .filter("metadata->>agency_id", "eq", agencyKey)
      .eq("status", "open_comment")
      .gt("comment_period_end", now),
  ]);

  const activeRules: Proposal[] = (activeRules2.data ?? []) as Proposal[];
  const recentRules: Proposal[] = (recentRules2.data ?? []) as Proposal[];
  const totalRules  = totalCount2.count ?? 0;
  const openRules   = openCount2.count ?? 0;

  // Spending — re-query with actual agency name
  const spendingRes2 = await supabase
    .from("spending_records")
    .select("recipient_name, award_type, amount_cents, award_date")
    .ilike("awarding_agency", `%${agency.name}%`)
    .order("amount_cents", { ascending: false })
    .limit(100);

  const spendingGroups = aggregateSpending(
    ((spendingRes2.data ?? spendingRes.data ?? []) as SpendingRow[])
  );

  const totalSpentCents = spendingGroups.reduce((sum, g) => sum + g.totalCents, 0);

  const typeColor = AGENCY_TYPE_COLORS[agency.agency_type] ?? AGENCY_TYPE_COLORS["other"]!;
  const typeLabel = AGENCY_TYPE_LABELS[agency.agency_type] ?? "Agency";
  const displayAcronym = agency.acronym ?? agency.short_name ?? agency.name.slice(0, 5).toUpperCase();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="border-b border-gray-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            ← Civitics
          </a>
          <span className="text-gray-200">/</span>
          <a href="/agencies" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            Agencies
          </a>
          <span className="text-gray-200">/</span>
          <span className="text-sm font-semibold text-gray-900">{displayAcronym}</span>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

        {/* ── 1. HEADER ────────────────────────────────────────────────────── */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-start gap-5">
            {/* Seal placeholder */}
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 font-mono text-lg font-bold text-gray-700">
              {displayAcronym.slice(0, 4)}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${typeColor}`}>
                  {typeLabel}
                </span>
              </div>
              <h1 className="mt-1 text-2xl font-bold text-gray-900 leading-tight">
                {agency.name}
              </h1>
              {agency.acronym && agency.acronym !== agency.name && (
                <p className="text-sm font-medium text-gray-500">{agency.acronym}</p>
              )}
              {agency.description && (
                <p className="mt-2 text-sm text-gray-600 leading-relaxed max-w-3xl">
                  {agency.description}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-4">
                {agency.website_url && (
                  <a
                    href={agency.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    {agency.website_url.replace(/^https?:\/\//, "")} ↗
                  </a>
                )}
                {agency.contact_email && (
                  <a
                    href={`mailto:${agency.contact_email}`}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    {agency.contact_email}
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── 2. QUICK STATS BAR ────────────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-4">
          <StatBox value={totalRules > 0 ? totalRules.toLocaleString() : "—"} label="Total rules" />
          <StatBox
            value={openRules > 0 ? openRules.toLocaleString() : "—"}
            label="Open comment periods"
            highlight={openRules > 0}
          />
          <StatBox
            value={totalSpentCents > 0 ? formatDollars(totalSpentCents) : "—"}
            label="Spending on record"
          />
          <StatBox value="—" label="Promises tracked" note="Phase 2" />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 flex flex-col gap-6">

            {/* ── 4. ACTIVE RULEMAKING ─────────────────────────────────────── */}
            <section>
              <SectionHeader title="Active Rulemaking" />

              {activeRules.length === 0 ? (
                <EmptyState message="No active rulemaking found for this agency." />
              ) : (
                <div className="flex flex-col gap-3">
                  {activeRules.map((rule) => {
                    const statusStyle = PROPOSAL_STATUS[rule.status] ?? {
                      color: "bg-gray-100 text-gray-700",
                      label: rule.status,
                    };
                    const isOpen = rule.status === "open_comment";
                    const isPastDeadline =
                      rule.comment_period_end &&
                      new Date(rule.comment_period_end) < new Date();

                    return (
                      <div
                        key={rule.id}
                        className="rounded-lg border border-gray-200 bg-white p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.color}`}>
                              {statusStyle.label}
                            </span>
                            {rule.bill_number && (
                              <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                                {rule.bill_number}
                              </span>
                            )}
                            {rule.regulations_gov_id && (
                              <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                                {rule.regulations_gov_id}
                              </span>
                            )}
                          </div>
                          {rule.comment_period_end && (
                            <span className={`shrink-0 text-xs ${isPastDeadline ? "text-red-500" : "text-gray-400"}`}>
                              {isOpen ? "Deadline: " : "Closed: "}
                              {formatDate(rule.comment_period_end)}
                            </span>
                          )}
                        </div>

                        <h3 className="mt-2 text-sm font-semibold text-gray-900 leading-snug">
                          {rule.title}
                        </h3>

                        {rule.summary_plain && (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-gray-500">
                            {rule.summary_plain}
                          </p>
                        )}

                        {isOpen && !isPastDeadline && (
                          <div className="mt-3 flex items-center justify-between rounded border border-emerald-200 bg-emerald-50 px-3 py-2">
                            <p className="text-xs text-emerald-800">
                              Comment period open. Submitting is free — no account required.
                            </p>
                            <a
                              href="#"
                              className="ml-3 shrink-0 rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 transition-colors"
                            >
                              Submit comment →
                            </a>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── 5. RECENT RULES (CLOSED) ─────────────────────────────────── */}
            {recentRules.length > 0 && (
              <section>
                <SectionHeader title="Recent Rules" subtitle="Closed or finalized" />
                <div className="flex flex-col gap-2">
                  {recentRules.map((rule) => {
                    const statusStyle = PROPOSAL_STATUS[rule.status] ?? {
                      color: "bg-gray-100 text-gray-700",
                      label: rule.status,
                    };
                    return (
                      <div
                        key={rule.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-gray-800">{rule.title}</p>
                          <p className="mt-0.5 text-xs text-gray-400">
                            {rule.bill_number ?? rule.regulations_gov_id ?? rule.type}
                            {rule.comment_period_end ? ` · ${formatDate(rule.comment_period_end)}` : ""}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.color}`}>
                          {statusStyle.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── 6. SPENDING ──────────────────────────────────────────────── */}
            <section>
              <SectionHeader
                title="Spending"
                subtitle="Top contractors and grant recipients"
              />
              {spendingGroups.length === 0 ? (
                <EmptyState message="Spending data syncs weekly from USASpending.gov." />
              ) : (
                <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Recipient
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Type
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Amount
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Year
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {spendingGroups.map((g, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="max-w-xs truncate px-4 py-2.5 text-sm font-medium text-gray-800">
                            {g.recipient}
                          </td>
                          <td className="px-4 py-2.5 text-xs capitalize text-gray-500">
                            {g.awardType}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-gray-900">
                            {formatDollars(g.totalCents)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-xs text-gray-400">
                            {g.fiscalYear}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

          </div>

          {/* ── RIGHT COLUMN ─────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-6">

            {/* ── 3. LEADERSHIP ─────────────────────────────────────────────── */}
            <section>
              <SectionHeader title="Leadership" />
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-sm text-gray-400">
                  Leadership data syncs from official sources.
                </p>
                <button
                  disabled
                  className="mt-3 w-full cursor-not-allowed rounded border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-300"
                >
                  ✦ Director history — Phase 2
                </button>
              </div>
            </section>

            {/* ── 7. LEADERSHIP HISTORY ──────────────────────────────────────── */}
            <section>
              <SectionHeader title="Past Officials" subtitle="Secretaries and directors" />
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-sm text-gray-400">
                  Career history and revolving door tracking loads as data is ingested.
                </p>
              </div>
            </section>

            {/* Comment banner */}
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-4">
              <p className="text-sm font-semibold text-indigo-900">
                Your tax dollars fund this agency.
              </p>
              <p className="mt-1 text-xs text-indigo-700 leading-relaxed">
                Comment on proposed rules — free, always. No account, no fees, no exceptions.
              </p>
              {openRules > 0 && (
                <a
                  href="#active-rulemaking"
                  className="mt-3 block rounded border border-indigo-300 bg-white px-3 py-2 text-center text-xs font-medium text-indigo-700 hover:bg-indigo-50 transition-colors"
                >
                  {openRules} open period{openRules !== 1 ? "s" : ""} — comment now →
                </a>
              )}
            </div>

          </div>
        </div>

        {/* ── 8. CONNECTION GRAPH ──────────────────────────────────────────── */}
        <div className="mt-6">
          <SectionHeader title="Connection Graph" subtitle="Officials, contractors, and oversight relationships" />
          <div className="mt-3 rounded-lg border border-gray-200 overflow-hidden">
            <AgencyGraph agencyId={agency.id} agencyName={agency.name} />
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatBox({
  value,
  label,
  highlight,
  note,
}: {
  value: string;
  label: string;
  highlight?: boolean;
  note?: string;
}) {
  return (
    <div className="bg-white px-4 py-4 text-center">
      <p className={`text-xl font-bold ${highlight ? "text-emerald-600" : "text-gray-900"}`}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
      {note && <p className="text-[10px] text-gray-300">{note}</p>}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-5 py-8 text-center">
      <p className="text-sm text-gray-400">{message}</p>
    </div>
  );
}
