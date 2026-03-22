import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { CommentPeriodBadge } from "../components/CommentPeriodBadge";
import { CommentDraftSection } from "../components/CommentDraftSection";
import { AGENCY_FULL_NAMES } from "../components/agencyNames";
import { AiSummarySection } from "../components/AiSummarySection";
import { PageViewTracker } from "../../components/PageViewTracker";

export const dynamic = "force-dynamic";

export async function generateStaticParams() {
  return [];
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Proposal = {
  id: string;
  title: string;
  type: string;
  status: string;
  regulations_gov_id: string | null;
  congress_gov_url: string | null;
  comment_period_end: string | null;
  summary_plain: string | null;
  introduced_at: string | null;
  metadata: Record<string, string>;
};

type Vote = {
  id: string;
  vote: string;
  voted_at: string | null;
  official: {
    full_name: string;
    party: string | null;
    district_name: string | null;
    role_title: string;
  } | null;
};

type RelatedProposal = {
  id: string;
  title: string;
  type: string;
  status: string;
  comment_period_end: string | null;
  metadata: Record<string, string>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  open_comment:         { label: "Open for Comment", color: "bg-amber-100 text-amber-800 border-amber-200" },
  introduced:           { label: "Introduced",       color: "bg-blue-100 text-blue-800 border-blue-200" },
  in_committee:         { label: "In Committee",     color: "bg-blue-100 text-blue-800 border-blue-200" },
  passed_committee:     { label: "Passed Committee", color: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  floor_vote:           { label: "Floor Vote",       color: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  passed_chamber:       { label: "Passed Chamber",   color: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  passed_both_chambers: { label: "Passed Both",      color: "bg-violet-100 text-violet-800 border-violet-200" },
  signed:               { label: "Signed",           color: "bg-green-100 text-green-800 border-green-200" },
  enacted:              { label: "Enacted",          color: "bg-green-100 text-green-800 border-green-200" },
  failed:               { label: "Failed",           color: "bg-red-100 text-red-800 border-red-200" },
  withdrawn:            { label: "Withdrawn",        color: "bg-gray-100 text-gray-600 border-gray-200" },
  comment_closed:       { label: "Comment Closed",   color: "bg-gray-100 text-gray-600 border-gray-200" },
};

const TYPE_LABEL: Record<string, string> = {
  regulation:      "Federal Regulation",
  bill:            "Congressional Bill",
  executive_order: "Executive Order",
  treaty:          "Treaty",
  referendum:      "Referendum",
  resolution:      "Resolution",
};

const VOTE_STYLES: Record<string, { label: string; color: string }> = {
  yes:        { label: "Yes",        color: "bg-green-100 text-green-800 border-green-200" },
  no:         { label: "No",         color: "bg-red-100 text-red-800 border-red-200" },
  abstain:    { label: "Abstain",    color: "bg-gray-100 text-gray-600 border-gray-200" },
  present:    { label: "Present",    color: "bg-gray-100 text-gray-600 border-gray-200" },
  not_voting: { label: "Not Voting", color: "bg-gray-100 text-gray-500 border-gray-200" },
  paired_yes: { label: "Paired Yes", color: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  paired_no:  { label: "Paired No",  color: "bg-orange-100 text-orange-800 border-orange-200" },
};

const PARTY_DOT: Record<string, string> = {
  democrat:    "bg-blue-500",
  republican:  "bg-red-500",
  independent: "bg-purple-500",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function isOpenForComment(p: Proposal): boolean {
  return (
    p.status === "open_comment" &&
    !!p.comment_period_end &&
    new Date(p.comment_period_end) > new Date()
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function ProposalDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  // Main proposal
  const { data: proposal, error } = await supabase
    .from("proposals")
    .select("id,title,type,status,regulations_gov_id,congress_gov_url,comment_period_end,summary_plain,introduced_at,metadata")
    .eq("id", params.id)
    .single();

  if (error || !proposal) notFound();

  const p = proposal as Proposal;
  const open = isOpenForComment(p);
  const statusBadge = STATUS_BADGE[p.status] ?? { label: p.status, color: "bg-gray-100 text-gray-600 border-gray-200" };
  const typeLabel = TYPE_LABEL[p.type] ?? p.type;
  const agencyAcronym = p.metadata?.agency_id ?? null;
  const docType = p.metadata?.document_type ?? null;
  const docketId = p.metadata?.docket_id ?? null;

  const agencyFullName = agencyAcronym ? (AGENCY_FULL_NAMES[agencyAcronym] ?? null) : null;

  // Votes (for congressional bills)
  const votesPromise = p.type === "bill"
    ? supabase
        .from("votes")
        .select("id,vote,voted_at,official:officials(full_name,party,district_name,role_title)")
        .eq("proposal_id", p.id)
        .order("voted_at", { ascending: false })
        .limit(100)
    : Promise.resolve({ data: [] });

  // Related proposals (same agency or type, excluding current)
  const relatedQuery = supabase
    .from("proposals")
    .select("id,title,type,status,comment_period_end,metadata")
    .neq("id", p.id)
    .eq("status", "open_comment")
    .limit(4);

  if (agencyAcronym) {
    relatedQuery.filter("metadata->>agency_id", "eq", agencyAcronym);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    relatedQuery.eq("type", p.type as any);
  }

  // Cached AI summary for "What This Means" section
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const aiSummaryPromise = sb
    .from("ai_summary_cache")
    .select("summary_text")
    .eq("entity_type", "proposal")
    .eq("entity_id", p.id)
    .maybeSingle();

  const [votesRes, relatedRes, aiSummaryRes] = await Promise.all([votesPromise, relatedQuery, aiSummaryPromise]);

  const votes = (votesRes.data ?? []) as Vote[];
  const related = (relatedRes.data ?? []) as RelatedProposal[];
  const cachedAiSummary: string | null = aiSummaryRes?.data?.summary_text ?? null;

  // Vote tally
  const tally = votes.reduce<Record<string, number>>((acc, v) => {
    acc[v.vote] = (acc[v.vote] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker entityType="proposal" entityId={params.id} />

      {/* ─── Header ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* Breadcrumb */}
          <nav className="mb-4 flex items-center gap-1.5 text-xs text-gray-400">
            <a href="/proposals" className="hover:text-gray-600 transition-colors">Proposals</a>
            <span>/</span>
            <span className="text-gray-600 truncate max-w-[200px] sm:max-w-none">{p.title}</span>
          </nav>

          {/* Badge row */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className={`rounded border px-2.5 py-1 text-xs font-semibold ${statusBadge.color}`}>
              {open ? "⏰ " : ""}{statusBadge.label}
            </span>
            {agencyAcronym && (
              <span className="inline-flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs">
                <span className="font-mono font-semibold text-gray-700">{agencyAcronym}</span>
                {agencyFullName && (
                  <span className="text-gray-400">· {agencyFullName}</span>
                )}
              </span>
            )}
            <span className="rounded border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600">
              {docType ?? typeLabel}
            </span>
            {docketId && (
              <span className="text-xs text-gray-400 font-mono">{docketId}</span>
            )}
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl leading-snug max-w-4xl">
            {p.title}
          </h1>

          {/* Meta row */}
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-gray-500">
            {p.introduced_at && (
              <span>Introduced {formatDate(p.introduced_at)}</span>
            )}
            {p.comment_period_end && (
              <span>Comment period ends {formatDate(p.comment_period_end)}</span>
            )}
            {p.regulations_gov_id && (
              <a
                href={`https://www.regulations.gov/document/${p.regulations_gov_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                View on regulations.gov ↗
              </a>
            )}
            {p.congress_gov_url && (
              <a
                href={p.congress_gov_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                View on congress.gov ↗
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-3">

          {/* ─── Main column ──────────────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-8">

            {/* Comment Period Banner */}
            {open && p.comment_period_end && (
              <CommentPeriodBadge commentPeriodEnd={p.comment_period_end} />
            )}

            {/* What This Means — AI plain language summary */}
            {cachedAiSummary ? (
              <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  What This Means
                </h2>
                <div className="rounded-lg border border-indigo-100 bg-white p-5">
                  <p className="text-sm text-gray-700 leading-relaxed">{cachedAiSummary}</p>
                  <p className="mt-3 text-[10px] text-gray-400">
                    Plain language summary generated by AI · Civitics
                  </p>
                </div>
              </section>
            ) : open ? (
              <AiSummarySection proposalId={p.id} />
            ) : p.summary_plain ? (
              <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  What This Means
                </h2>
                <div className="rounded-lg border border-gray-200 bg-white p-5">
                  <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                    {p.summary_plain}
                  </p>
                </div>
              </section>
            ) : null}

            {/* Vote Record — congressional bills only */}
            {p.type === "bill" && votes.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Vote Record
                </h2>

                {/* Tally */}
                <div className="mb-4 flex flex-wrap gap-3">
                  {Object.entries(tally).map(([val, count]) => {
                    const style = VOTE_STYLES[val] ?? { label: val, color: "bg-gray-100 text-gray-600 border-gray-200" };
                    return (
                      <span key={val} className={`rounded border px-3 py-1 text-sm font-semibold ${style.color}`}>
                        {style.label}: {count}
                      </span>
                    );
                  })}
                </div>

                {/* Individual votes */}
                <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
                  {votes.map((v) => {
                    const voteStyle = VOTE_STYLES[v.vote] ?? { label: v.vote, color: "bg-gray-100 text-gray-600 border-gray-200" };
                    const partyKey = v.official?.party?.toLowerCase() ?? "";
                    const dot = PARTY_DOT[partyKey] ?? "bg-gray-400";
                    return (
                      <div key={v.id} className="flex items-center justify-between px-4 py-2.5 gap-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`h-2 w-2 rounded-full flex-shrink-0 ${dot}`} />
                          <span className="text-sm text-gray-900 truncate">
                            {v.official?.full_name ?? "Unknown"}
                          </span>
                          {v.official?.district_name && (
                            <span className="text-xs text-gray-400">{v.official.district_name}</span>
                          )}
                          {v.official?.role_title && (
                            <span className="text-xs text-gray-400">{v.official.role_title}</span>
                          )}
                        </div>
                        <span className={`flex-shrink-0 rounded border px-2 py-0.5 text-xs font-medium ${voteStyle.color}`}>
                          {voteStyle.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Related Proposals */}
            {related.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  {agencyAcronym ? `Other Open ${agencyAcronym} Proposals` : "Related Proposals"}
                </h2>
                <div className="space-y-2">
                  {related.map((r) => {
                    const rStatus = STATUS_BADGE[r.status] ?? { label: r.status, color: "bg-gray-100 text-gray-600 border-gray-200" };
                    const rAgency = r.metadata?.agency_id ?? null;
                    return (
                      <a
                        key={r.id}
                        href={`/proposals/${r.id}`}
                        className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 hover:border-indigo-200 hover:shadow-sm transition-all"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 mb-1">
                            <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${rStatus.color}`}>
                              {rStatus.label}
                            </span>
                            {rAgency && (
                              <span className="text-xs font-mono text-gray-500">{rAgency}</span>
                            )}
                          </div>
                          <p className="text-sm font-medium text-gray-900 line-clamp-2 leading-snug">
                            {r.title}
                          </p>
                        </div>
                        <span className="flex-shrink-0 text-indigo-600 text-sm">→</span>
                      </a>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* ─── Sidebar ──────────────────────────────────────────────────── */}
          <div className="space-y-6">

            {/* Submit Comment */}
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                {open ? "Submit Your Comment" : "Comment Period"}
              </h2>
              {open ? (
                <div className="rounded-lg border border-amber-200 bg-white p-5">
                  <CommentDraftSection
                    regulationsGovId={p.regulations_gov_id}
                    congressGovUrl={p.congress_gov_url}
                    title={p.title}
                  />
                </div>
              ) : (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
                  {p.status === "comment_closed"
                    ? "The public comment period for this proposal has closed."
                    : "This proposal is not currently open for public comment."}
                </div>
              )}
            </section>

            {/* Proposal details */}
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Details
              </h2>
              <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
                <DetailRow label="Type" value={typeLabel} />
                {agencyAcronym && (
                  <DetailRow
                    label="Agency"
                    value={agencyFullName ? `${agencyAcronym} · ${agencyFullName}` : agencyAcronym}
                  />
                )}
                {docketId && <DetailRow label="Docket" value={docketId} mono />}
                {p.regulations_gov_id && (
                  <DetailRow label="Regulations.gov ID" value={p.regulations_gov_id} mono />
                )}
                {p.introduced_at && (
                  <DetailRow label="Introduced" value={formatDate(p.introduced_at)} />
                )}
                {p.comment_period_end && (
                  <DetailRow label="Comment Deadline" value={formatDate(p.comment_period_end)} />
                )}
              </div>
            </section>

            {/* Official comment CTA (if open, remind below the draft form) */}
            {open && p.regulations_gov_id && (
              <p className="text-center text-xs text-gray-400 leading-relaxed">
                Official comments are submitted directly to the federal agency via
                regulations.gov — always free, no account required.
              </p>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-gray-400 flex-shrink-0">{label}</span>
      <span className={`text-gray-900 text-right ${mono ? "font-mono text-xs break-all" : ""}`}>
        {value}
      </span>
    </div>
  );
}
