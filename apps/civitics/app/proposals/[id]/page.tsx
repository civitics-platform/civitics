import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createPublicClient } from "@civitics/db";
import { CommentPeriodBadge } from "../components/CommentPeriodBadge";
import { CommentDraftSection } from "../components/CommentDraftSection";
import { AGENCY_FULL_NAMES } from "../components/agencyNames";
import { AiSummarySection } from "../components/AiSummarySection";
import { PageViewTracker } from "../../components/PageViewTracker";
import { SourceBadge } from "../../components/SourceBadge";
import { SourceDetailPopover } from "../../components/SourceDetailPopover";
import { EntityComments } from "../../components/EntityComments";
import { QASection } from "../../components/QASection";
import { PositionSection } from "../../components/PositionSection";
import { CommentHighlightsStrip } from "../../components/CommentHighlightsStrip";
import { getSlowMode } from "@/lib/slow-mode";
import { withDbTimeout } from "@/lib/supabase-check";
import { RelatedInitiatives, type InitiativeLink } from "../components/RelatedInitiatives";
import { ProposalShareButton } from "../components/ProposalShareButton";
import { getCachedProposal } from "../_lib/get-proposal";
import { SyntheticMark, SyntheticBanner } from "../../components/integrity/Synthetic";

// Public proposal detail; no auth dependency, RLS allows anon SELECT on
// proposals + votes + ai_summary_cache + civic_initiative_proposal_links.
// True ISR — built on first request, cached for 5 min, then revalidated in
// the background. Faster than the SSR-with-CDN-cache hit because the page
// is served from the function output cache (or static disk).
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata(
  { params }: { params: { id: string } }
): Promise<Metadata> {
  const data = await getCachedProposal(params.id);
  if (!data) return { title: "Proposal | Civitics" };

  const description = data.summary_plain
    ? data.summary_plain.slice(0, 160)
    : `${data.type} · ${data.status}`;

  return {
    title: data.title,
    description,
    openGraph: {
      title: `${data.title} | Civitics`,
      description,
    },
  };
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
  is_synthetic: boolean;
};

type Vote = {
  id: string;
  vote: string;
  voted_at: string | null;
  official: {
    id: string;
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
  metadata: Record<string, string>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Status gradient on the token palette: amber (open) → civic-blue (in
// progress) → green-ink (enacted) → accent (failed) → neutral (closed).
// passed-both-chambers uses ink outline — no purple/violet token by design.
const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  open_comment:         { label: "Open for Comment", color: "bg-amber/25 text-ink border-amber/60" },
  introduced:           { label: "Introduced",       color: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  in_committee:         { label: "In Committee",     color: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  passed_committee:     { label: "Passed Committee", color: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  floor_vote:           { label: "Floor Vote",       color: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  passed_chamber:       { label: "Passed Chamber",   color: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  passed_both_chambers: { label: "Passed Both",      color: "border-ink/40 text-ink" },
  signed:               { label: "Signed",           color: "bg-green-ink/10 text-green-ink border-green-ink/25" },
  enacted:              { label: "Enacted",          color: "bg-green-ink/10 text-green-ink border-green-ink/25" },
  failed:               { label: "Failed",           color: "bg-accent/10 text-accent border-accent/25" },
  withdrawn:            { label: "Withdrawn",        color: "bg-ink/5 text-ink-soft border-rule" },
  comment_closed:       { label: "Comment Closed",   color: "bg-ink/5 text-ink-soft border-rule" },
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
  yes:        { label: "Yes",        color: "bg-green-ink/10 text-green-ink border-green-ink/25" },
  no:         { label: "No",         color: "bg-accent/10 text-accent border-accent/25" },
  abstain:    { label: "Abstain",    color: "bg-ink/5 text-ink-soft border-rule" },
  present:    { label: "Present",    color: "bg-ink/5 text-ink-soft border-rule" },
  not_voting: { label: "Not Voting", color: "bg-ink/5 text-ink-soft/70 border-rule" },
  paired_yes: { label: "Paired Yes", color: "bg-green-ink/5 text-green-ink/80 border-green-ink/20" },
  paired_no:  { label: "Paired No",  color: "bg-amber/20 text-ink border-amber/50" },
};

// Independents stay ink — no purple token exists by design.
const PARTY_DOT: Record<string, string> = {
  democrat:    "bg-civic-blue",
  republican:  "bg-accent",
  independent: "bg-ink",
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
  const supabase = createPublicClient();

  // Cached fetch — generateMetadata already ran this for the same id; React.cache
  // returns the same row without a second Supabase round-trip.
  // regulations_gov_id, congress_gov_url, comment_period_end moved into
  // metadata JSONB post-promotion. Flatten back into the legacy shape below.
  const proposalRow = await getCachedProposal(params.id);

  if (!proposalRow) notFound();

  const rawMeta = (proposalRow.metadata as Record<string, string> | null) ?? {};
  const p: Proposal = {
    id:                 proposalRow.id,
    title:              proposalRow.title,
    type:               proposalRow.type,
    status:             proposalRow.status,
    regulations_gov_id: rawMeta.regulations_gov_id ?? null,
    congress_gov_url:   rawMeta.congress_gov_url   ?? null,
    comment_period_end: rawMeta.comment_period_end ?? null,
    summary_plain:      proposalRow.summary_plain,
    introduced_at:      proposalRow.introduced_at,
    metadata:           rawMeta,
    is_synthetic:       proposalRow.is_synthetic ?? false,
  };
  const open = isOpenForComment(p);
  const statusBadge = STATUS_BADGE[p.status] ?? { label: p.status, color: "bg-ink/5 text-ink-soft border-rule" };
  const typeLabel = TYPE_LABEL[p.type] ?? p.type;
  const agencyAcronym = p.metadata?.agency_id ?? null;
  const docType = p.metadata?.document_type ?? null;
  const docketId = p.metadata?.docket_id ?? null;

  const agencyFullName = agencyAcronym ? (AGENCY_FULL_NAMES[agencyAcronym] ?? null) : null;

  // Votes (for congressional bills). Post-promotion, votes.proposal_id was
  // renamed to votes.bill_proposal_id.
  const votesPromise = p.type === "bill"
    ? withDbTimeout(
        supabase
          .from("votes")
          .select("id,vote,voted_at,official:officials(id,full_name,party,district_name,role_title)")
          .eq("bill_proposal_id", p.id)
          .order("voted_at", { ascending: false })
          .limit(100),
        3000,
        "proposals:detail-votes",
      )
    : Promise.resolve({ data: [] });

  // Related proposals (same agency or type, excluding current). comment_period_end
  // now lives in metadata — pulled client-side after fetch.
  const relatedQuery = supabase // db-timeout-exempt: builder mutated below; wrapped at the Promise.all site
    .from("proposals")
    .select("id,title,type,status,metadata")
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
  const aiSummaryPromise = withDbTimeout(
    sb
      .from("ai_summary_cache")
      .select("summary_text")
      .eq("entity_type", "proposal")
      .eq("entity_id", p.id)
      .maybeSingle(),
    3000,
    "proposals:detail-ai-summary",
  );

  // Initiatives that linked this proposal. Post-promotion, civic_initiative_proposal_links
  // still uses `initiative_id` but that FK now targets proposals(id). Pull the initiative
  // proposal row + its initiative_details satellite in one nested join.
  const relatedInitiativesQuery = withDbTimeout(
    supabase
      .from("civic_initiative_proposal_links")
      .select("proposals!initiative_id(id, title, initiative_details(stage, scope, issue_area_tags))")
      .eq("proposal_id", p.id)
      .limit(5),
    3000,
    "proposals:detail-initiatives",
  );

  // FIX-I: jurisdiction → institution breadcrumb so users can navigate upward
  // from a proposal to its hubs. proposals carries jurisdiction_id +
  // governing_body_id; resolve both names in the same round-trip batch.
  const breadcrumbPromise = withDbTimeout(
    supabase
      .from("proposals")
      .select("jurisdiction_id, governing_body_id")
      .eq("id", p.id)
      .maybeSingle(),
    3000,
    "proposals:detail-breadcrumb",
  );

  const [votesRes, relatedRes, aiSummaryRes, relatedInitiativesRes, breadcrumbRes] = await Promise.all([
    votesPromise,
    withDbTimeout(relatedQuery, 3000, "proposals:detail-related"),
    aiSummaryPromise,
    relatedInitiativesQuery,
    breadcrumbPromise,
  ]);

  // Resolve breadcrumb entity names (jurisdiction + governing body).
  const bcMeta = (breadcrumbRes.data ?? null) as {
    jurisdiction_id: string | null;
    governing_body_id: string | null;
  } | null;
  let bcJurisdiction: { id: string; name: string; is_synthetic?: boolean } | null = null;
  let bcInstitution: { id: string; name: string } | null = null;
  if (bcMeta?.jurisdiction_id || bcMeta?.governing_body_id) {
    const [jRes, gRes] = await Promise.all([
      bcMeta.jurisdiction_id
        ? withDbTimeout(
            supabase.from("jurisdictions").select("id, name, is_synthetic").eq("id", bcMeta.jurisdiction_id).maybeSingle(),
            3000,
            "proposals:detail-bc-jurisdiction",
          )
        : Promise.resolve({ data: null }),
      bcMeta.governing_body_id
        ? withDbTimeout(
            supabase.from("institutions").select("id, name").eq("id", bcMeta.governing_body_id).maybeSingle(),
            3000,
            "proposals:detail-bc-institution",
          )
        : Promise.resolve({ data: null }),
    ]);
    bcJurisdiction = (jRes.data as { id: string; name: string; is_synthetic?: boolean } | null) ?? null;
    bcInstitution = (gRes.data as { id: string; name: string } | null) ?? null;
  }

  const votes = (votesRes.data ?? []) as Vote[];
  const related = (relatedRes.data ?? []) as RelatedProposal[];
  const cachedAiSummary: string | null =
    (aiSummaryRes as { data?: { summary_text?: string | null } | null } | null)?.data?.summary_text ?? null;
  // Flatten proposals + initiative_details join back into the legacy InitiativeLink shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const relatedInitiatives = ((relatedInitiativesRes.data ?? []) as any[])
    .map((row) => {
      const proposal = Array.isArray(row.proposals) ? row.proposals[0] : row.proposals;
      if (!proposal) return null;
      const details = Array.isArray(proposal.initiative_details)
        ? proposal.initiative_details[0]
        : proposal.initiative_details;
      if (!details) return null;
      return {
        id:              proposal.id,
        title:           proposal.title,
        stage:           details.stage,
        scope:           details.scope,
        issue_area_tags: details.issue_area_tags ?? [],
      };
    })
    .filter(Boolean) as InitiativeLink[];

  // Vote tally
  const tally = votes.reduce<Record<string, number>>((acc, v) => {
    acc[v.vote] = (acc[v.vote] ?? 0) + 1;
    return acc;
  }, {});

  // ── JSON-LD structured data (schema.org/Legislation) ─────────────────────
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://civitics.com";
  const proposalJsonLd = {
    "@context": "https://schema.org",
    "@type": "Legislation",
    name: p.title,
    description: p.summary_plain
      ? p.summary_plain.slice(0, 300)
      : `${typeLabel} · ${statusBadge.label}`,
    url: `${baseUrl}/proposals/${p.id}`,
    legislationType: typeLabel,
    ...(p.introduced_at ? { datePublished: p.introduced_at } : {}),
    ...(p.comment_period_end ? { expires: p.comment_period_end } : {}),
    ...(agencyFullName
      ? {
          publisher: {
            "@type": "GovernmentOrganization",
            name: agencyFullName,
            ...(agencyAcronym ? { alternateName: agencyAcronym } : {}),
          },
        }
      : {}),
    ...(p.congress_gov_url ? { sameAs: p.congress_gov_url } : {}),
  };

  // C1 Wave C: slow-mode flag (cheap PK lookup; never a request-path aggregation).
  const slowMode = await getSlowMode("proposal", p.id);

  return (
    <div className="min-h-screen bg-paper">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(proposalJsonLd) }}
      />
      {/* FIX-398: attribution payload embedded for the FIX-399 SourceBadge
          hydration hook. Not visually rendered. */}
      <script
        type="application/json"
        data-civitics-attribution="proposal"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(proposalRow.attribution) }}
      />
      <PageViewTracker entityType="proposal" entityId={params.id} />

      {/* ─── Header ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-rule bg-card">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* Breadcrumb — jurisdiction → institution → proposals → this */}
          <nav className="mb-4 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-soft">
            {bcJurisdiction && (
              <>
                <a
                  href={`/jurisdictions/${bcJurisdiction.id}`}
                  className="hover:text-accent transition-colors"
                >
                  {bcJurisdiction.name}
                </a>
                <span>/</span>
              </>
            )}
            {bcInstitution && (
              <>
                <a
                  href={`/institutions/${bcInstitution.id}`}
                  className="hover:text-accent transition-colors"
                >
                  {bcInstitution.name}
                </a>
                <span>/</span>
              </>
            )}
            <a href="/proposals" className="hover:text-accent transition-colors">Proposals</a>
            <span>/</span>
            <span className="text-ink truncate max-w-[200px] sm:max-w-none">{p.title}</span>
          </nav>

          {/* SF-P2 (FIX-599): inherited demonstration banner when this proposal
              is scoped under a synthetic jurisdiction. */}
          {bcJurisdiction?.is_synthetic && (
            <SyntheticBanner scope="entity" className="mb-4" />
          )}

          {/* Badge row */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className={`border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] ${statusBadge.color}`}>
              {open ? "⏰ " : ""}{statusBadge.label}
            </span>
            {agencyAcronym && (
              <span className="inline-flex items-center gap-1.5 border border-rule bg-paper-2 px-2.5 py-1 text-xs">
                <span className="font-mono font-semibold text-ink">{agencyAcronym}</span>
                {agencyFullName && (
                  <span className="text-ink-soft/70">· {agencyFullName}</span>
                )}
              </span>
            )}
            <span className="border border-rule bg-paper-2 px-2.5 py-1 text-xs font-medium text-ink-soft">
              {docType ?? typeLabel}
            </span>
            {docketId && (
              <span className="text-xs text-ink-soft/70 font-mono">{docketId}</span>
            )}
            <SourceDetailPopover
              entityType="proposal"
              entityId={params.id}
              attribution={proposalRow.attribution}
            >
              <SourceBadge attribution={proposalRow.attribution} />
            </SourceDetailPopover>
          </div>

          {/* Title */}
          <h1 className="font-serif text-2xl font-bold tracking-tight text-ink sm:text-3xl leading-snug max-w-4xl">
            {p.title}
            {p.is_synthetic && <SyntheticMark withIcon className="ml-2 align-middle" />}
          </h1>

          {/* Meta row */}
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-ink-soft">
            {p.introduced_at && (
              <span className="font-mono tabular-nums">Introduced {formatDate(p.introduced_at)}</span>
            )}
            {p.comment_period_end && (
              <span className="font-mono tabular-nums">Comment period ends {formatDate(p.comment_period_end)}</span>
            )}
            {p.regulations_gov_id && (
              <a
                href={`https://www.regulations.gov/document/${p.regulations_gov_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline transition-colors"
              >
                View on regulations.gov ↗
              </a>
            )}
            {p.congress_gov_url && (
              <a
                href={p.congress_gov_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline transition-colors"
              >
                View on congress.gov ↗
              </a>
            )}
            <ProposalShareButton title={p.title} id={p.id} />
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
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                  What This Means
                </h2>
                <div className="border border-civic-blue/20 bg-card p-5">
                  <p className="text-sm text-ink leading-relaxed">{cachedAiSummary}</p>
                  <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">
                    Plain language summary generated by AI · Civitics
                  </p>
                </div>
              </section>
            ) : open ? (
              <AiSummarySection proposalId={p.id} />
            ) : p.summary_plain ? (
              <section>
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                  What This Means
                </h2>
                <div className="border border-rule bg-card p-5">
                  <p className="text-sm text-ink leading-relaxed whitespace-pre-line">
                    {p.summary_plain}
                  </p>
                </div>
              </section>
            ) : null}

            {/* Vote Record — congressional bills only */}
            {p.type === "bill" && votes.length > 0 && (
              <section>
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                  Vote Record
                </h2>

                {/* Tally */}
                <div className="mb-4 flex flex-wrap gap-3">
                  {Object.entries(tally).map(([val, count]) => {
                    const style = VOTE_STYLES[val] ?? { label: val, color: "bg-ink/5 text-ink-soft border-rule" };
                    return (
                      <span key={val} className={`border px-3 py-1 font-mono text-sm font-semibold tabular-nums ${style.color}`}>
                        {style.label}: {count}
                      </span>
                    );
                  })}
                </div>

                {/* Individual votes */}
                <div className="border border-rule bg-card divide-y divide-rule/60">
                  {votes.map((v) => {
                    const voteStyle = VOTE_STYLES[v.vote] ?? { label: v.vote, color: "bg-ink/5 text-ink-soft border-rule" };
                    const partyKey = v.official?.party?.toLowerCase() ?? "";
                    const dot = PARTY_DOT[partyKey] ?? "bg-rule";
                    return (
                      <div key={v.id} className="flex items-center justify-between px-4 py-2.5 gap-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`h-2 w-2 rounded-full flex-shrink-0 ${dot}`} />
                          {v.official?.id ? (
                            <a
                              href={`/officials/${v.official.id}`}
                              className="text-sm text-ink truncate hover:text-accent hover:underline transition-colors"
                            >
                              {v.official.full_name}
                            </a>
                          ) : (
                            <span className="text-sm text-ink truncate">
                              {v.official?.full_name ?? "Unknown"}
                            </span>
                          )}
                          {v.official?.district_name && (
                            <span className="text-xs text-ink-soft/70">{v.official.district_name}</span>
                          )}
                          {v.official?.role_title && (
                            <span className="text-xs text-ink-soft/70">{v.official.role_title}</span>
                          )}
                        </div>
                        <span className={`flex-shrink-0 border px-2 py-0.5 font-mono text-xs font-medium ${voteStyle.color}`}>
                          {voteStyle.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Position spine (C1) — intensity, rollup, terms of consensus */}
            <PositionSection entityType="proposal" entityId={p.id} lensEnabled />

            {/* Community Comments */}
            <div className="mt-8">
              {/* Common-ground / steelman highlights, pinned above list + map */}
              <CommentHighlightsStrip entityType="proposal" entityId={p.id} />
              <EntityComments
                entityType="proposal"
                entityId={p.id}
                allowedKinds={["discussion", "question", "concern", "evidence", "stakeholder_impact"]}
                stanceEnabled
                lensEnabled
                statementsEnabled
                slowMode={slowMode}
              />
            </div>

            {/* Q&A v2 PR-2a (FIX-629): community Q&A on this bill. No official
                answerer exists for a proposal — questions are answered by the
                community with sourced, citation-required notes "from the record". */}
            <div className="mt-8">
              <QASection entityType="proposal" entityId={p.id} entityName={p.title} />
            </div>

            {/* Citizen Initiatives linked to this proposal */}
            <RelatedInitiatives initiatives={relatedInitiatives} />

            {/* Related Proposals */}
            {related.length > 0 && (
              <section>
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                  {agencyAcronym ? `Other Open ${agencyAcronym} Proposals` : "Related Proposals"}
                </h2>
                <div className="space-y-2">
                  {related.map((r) => {
                    const rStatus = STATUS_BADGE[r.status] ?? { label: r.status, color: "bg-ink/5 text-ink-soft border-rule" };
                    const rAgency = r.metadata?.agency_id ?? null;
                    return (
                      <a
                        key={r.id}
                        href={`/proposals/${r.id}`}
                        className="flex items-start gap-3 border border-rule bg-card p-4 hover:border-accent hover:shadow-sm transition-all"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 mb-1">
                            <span className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] ${rStatus.color}`}>
                              {rStatus.label}
                            </span>
                            {rAgency && (
                              <span className="text-xs font-mono text-ink-soft">{rAgency}</span>
                            )}
                          </div>
                          <p className="font-serif text-sm font-medium text-ink line-clamp-2 leading-snug">
                            {r.title}
                          </p>
                        </div>
                        <span className="flex-shrink-0 text-accent text-sm">→</span>
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
              <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                {open ? "Submit Your Comment" : "Comment Period"}
              </h2>
              {open ? (
                <div className="border border-amber/60 bg-card p-5">
                  <CommentDraftSection
                    regulationsGovId={p.regulations_gov_id}
                    congressGovUrl={p.congress_gov_url}
                    title={p.title}
                    proposalId={p.id}
                  />
                </div>
              ) : (
                <div className="border border-rule bg-paper-2 p-4 text-sm text-ink-soft">
                  {p.status === "comment_closed"
                    ? "The public comment period for this proposal has closed."
                    : "This proposal is not currently open for public comment."}
                </div>
              )}
            </section>

            {/* Proposal details */}
            <section>
              <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                Details
              </h2>
              <div className="border border-rule bg-card p-4 space-y-3">
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
              <p className="text-center text-xs text-ink-soft/70 leading-relaxed">
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
      <span className="text-ink-soft/70 flex-shrink-0">{label}</span>
      <span className={`text-ink text-right ${mono ? "font-mono text-xs break-all" : ""}`}>
        {value}
      </span>
    </div>
  );
}
