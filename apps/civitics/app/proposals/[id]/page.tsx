import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createPublicClient } from "@civitics/db";
import { CommentPeriodBadge } from "../components/CommentPeriodBadge";
import { CommentDraftSection } from "../components/CommentDraftSection";
import { AGENCY_FULL_NAMES } from "../components/agencyNames";
import { AiSummarySection } from "../components/AiSummarySection";
import { PageViewTracker } from "../../components/PageViewTracker";
import { SourceBadge } from "../../components/SourceBadge";
import { FlagDataButton } from "../../components/FlagDataButton";
import { SourceDetailPopover } from "../../components/SourceDetailPopover";
import { EntityComments } from "../../components/EntityComments";
import { QASection } from "../../components/QASection";
import { PositionSection } from "../../components/PositionSection";
import { CommentHighlightsStrip } from "../../components/CommentHighlightsStrip";
import { getSlowMode } from "@/lib/slow-mode";
import { withDbTimeout } from "@/lib/supabase-check";
import { assertRenderNotDegraded } from "@/lib/degraded-render";
import { canonicalForEntity, entityPath, SITE_ORIGIN } from "@/lib/canonical";
import { RelatedInitiatives, type InitiativeLink } from "../components/RelatedInitiatives";
import { ProposalShareButton } from "../components/ProposalShareButton";
import { getCachedProposal } from "../_lib/get-proposal";
import { SyntheticMark, SyntheticBanner } from "../../components/integrity/Synthetic";
import { PrintLetterhead, PrintProvenance } from "../../components/print/PrintRecord";
import { EntityTags, type EntityTag } from "../../components/tags/EntityTags";
import { Icon } from "@civitics/graph";
import { proposalTypeLabel } from "@/lib/proposal-detail/labels";
import {
  ON_RECORD_NOTE,
  groupMembers,
  groupRolls,
  headlineRoll,
  partySplit,
  rollHeading,
  rollLines,
  type MemberVote,
  type VoteRoll,
} from "@/lib/proposal-detail/vote-rolls";
import { stagePath } from "@/lib/proposal-detail/stage-path";
import {
  chamberLabel,
  identityLine,
  latestAction,
  metadataTitle,
  ordinal,
  sourceLink,
} from "@/lib/proposal-detail/identity";

// Public proposal detail; no auth dependency, RLS allows anon SELECT on
// proposals + votes + bill_details + entity_tags + ai_summary_cache +
// civic_initiative_proposal_links; proposal_vote_rolls() is anon-executable.
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
  if (!data) return { title: "Proposal" };

  const description = data.summary_plain
    ? data.summary_plain.slice(0, 160)
    : `${data.type} · ${data.status}`;
  // FIX-1447 (D5): "HR 1 — <title>" when a number exists and the title is not it.
  const title = metadataTitle(data.title, data.bill_details);

  return {
    title,
    description,
    openGraph: {
      title: `${title} | Civitics`,
      description,
    },
    // FIX-1306: from the loaded row's id, not params.id.
    ...canonicalForEntity("proposal", data.id),
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
  vetoed:               { label: "Vetoed",           color: "bg-accent/10 text-accent border-accent/25" },
  veto_overridden:      { label: "Veto Overridden",  color: "bg-green-ink/10 text-green-ink border-green-ink/25" },
  tabled:               { label: "Tabled",           color: "bg-ink/5 text-ink-soft border-rule" },
  final_rule:           { label: "Final Rule",       color: "bg-ink/5 text-ink-soft border-rule" },
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

// In UTC: introduced_at / last_action_at are dates stored at midnight UTC, and
// Vercel renders in UTC — a local dev server would otherwise print the day before.
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
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

  if (!proposalRow) {
    // A timed-out proposal read must not become a cached 404 (FIX-1227).
    assertRenderNotDegraded();
    notFound();
  }

  const rawMeta = (proposalRow.metadata as Record<string, string> | null) ?? {};
  const bd = proposalRow.bill_details;
  const p: Proposal = {
    id:                 proposalRow.id,
    title:              proposalRow.title,
    type:               proposalRow.type,
    status:             proposalRow.status,
    regulations_gov_id: rawMeta.regulations_gov_id ?? null,
    // FIX-1447 (D7): the stored URL lives on bill_details, not in metadata.
    congress_gov_url:   bd?.congress_gov_url ?? null,
    comment_period_end: rawMeta.comment_period_end ?? null,
    summary_plain:      proposalRow.summary_plain,
    introduced_at:      proposalRow.introduced_at,
    metadata:           rawMeta,
    is_synthetic:       proposalRow.is_synthetic ?? false,
  };
  const open = isOpenForComment(p);
  const statusBadge = STATUS_BADGE[p.status] ?? { label: p.status, color: "bg-ink/5 text-ink-soft border-rule" };
  const typeLabel = proposalTypeLabel(p.type, { billNumber: bd?.bill_number, metadata: rawMeta });
  const agencyAcronym = p.metadata?.agency_id ?? null;
  const docType = p.metadata?.document_type ?? null;
  const docketId = p.metadata?.docket_id ?? null;

  const agencyFullName = agencyAcronym ? (AGENCY_FULL_NAMES[agencyAcronym] ?? null) : null;

  // FIX-1447 (D5–D7): identity, status and source, from stored rows only.
  const identity = identityLine(bd, rawMeta);
  const latest = latestAction(rawMeta, proposalRow.last_action_at);
  const stage = stagePath({
    type: p.type,
    status: p.status,
    congressNumber: bd?.congress_number,
    billNumber: bd?.bill_number,
  });
  const regulationsGovHref = p.regulations_gov_id
    ? `https://www.regulations.gov/document/${p.regulations_gov_id}`
    : null;
  const sourceUrl = sourceLink({ congressGovUrl: bd?.congress_gov_url, externalUrl: proposalRow.external_url });
  // The meta row prints the regulations.gov link already; never the same link twice.
  const source = sourceLink({
    congressGovUrl: bd?.congress_gov_url,
    externalUrl: proposalRow.external_url,
    alreadyLinked: [regulationsGovHref],
  });
  const number = bd?.bill_number ?? rawMeta.file_number ?? null;
  const chamber = chamberLabel(bd?.chamber);

  // FIX-1447 (D1, D3): one row per roll, for every type but a regulation. The
  // counts are what Civitics stores, never the roll's official count.
  const rollsPromise = p.type !== "regulation"
    ? withDbTimeout(
        supabase.rpc("proposal_vote_rolls", { p_proposal_id: p.id }),
        3000,
        "proposals:detail-vote-rolls",
      )
    : Promise.resolve({ data: [] });

  // FIX-1447 (D10): topic tags shown publicly; never internal.
  const tagsPromise = withDbTimeout(
    supabase
      .from("entity_tags")
      .select("tag,tag_category,display_label,display_icon,visibility,confidence,generated_by,ai_model,metadata")
      .eq("entity_type", "proposal")
      .eq("entity_id", p.id)
      .eq("tag_category", "topic")
      .in("visibility", ["primary", "secondary"]),
    3000,
    "proposals:detail-tags",
  );

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
      .select("proposals!initiative_id(id, title, initiative_details!initiative_details_proposal_id_fkey(stage, scope, issue_area_tags))")
      .eq("proposal_id", p.id)
      .limit(5),
    3000,
    "proposals:detail-initiatives",
  );

  // FIX-441: jurisdiction → institution breadcrumb so users can navigate upward
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

  const [rollsRes, relatedRes, aiSummaryRes, relatedInitiativesRes, breadcrumbRes, tagsRes] = await Promise.all([
    rollsPromise,
    withDbTimeout(relatedQuery, 3000, "proposals:detail-related"),
    aiSummaryPromise,
    relatedInitiativesQuery,
    breadcrumbPromise,
    tagsPromise,
  ]);

  // FIX-1447 (D4): members are listed for ONE roll — the newest final roll,
  // else the newest roll. Started here so it runs beside the breadcrumb reads.
  const rolls = (rollsRes.data ?? []) as unknown as VoteRoll[];
  const headline = headlineRoll(rolls);
  const membersPromise = headline
    ? withDbTimeout(
        supabase
          .from("votes")
          .select("id,vote,official:officials(id,full_name,party,district_name,role_title)")
          .eq("roll_call_id", headline.roll_call_id)
          .eq("bill_proposal_id", p.id)
          .limit(600),
        3000,
        "proposals:detail-roll-members",
      )
    : Promise.resolve({ data: [] });

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

  const members = ((await membersPromise).data ?? []) as unknown as MemberVote[];
  const memberGroups = groupMembers(members);
  const rollGroups = groupRolls(rolls);
  const tags = (tagsRes.data ?? []) as EntityTag[];
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

  // ── JSON-LD structured data (schema.org/Legislation) ─────────────────────
  const proposalJsonLd = {
    "@context": "https://schema.org",
    "@type": "Legislation",
    name: p.title,
    description: p.summary_plain
      ? p.summary_plain.slice(0, 300)
      : `${typeLabel} · ${statusBadge.label}`,
    // FIX-1306: the same URL as the canonical.
    url: `${SITE_ORIGIN}${entityPath("proposal", p.id)}`,
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
    // FIX-1447 (D7): the same URL the page links, and the number it carries.
    ...(sourceUrl ? { sameAs: sourceUrl.href } : {}),
    ...(number ? { legislationIdentifier: number } : {}),
  };

  // FIX-1227: every labelled read above has settled — never cache a render in
  // which one ran out of time.
  assertRenderNotDegraded();

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

          {/* Print-only letterhead — proposal pages print as filed public records (FIX-713). */}
          <PrintLetterhead />

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
              {open && <Icon name="deadline" className="w-3.5 h-3.5 inline-block align-[-2px] mr-1" />}{statusBadge.label}
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
            <FlagDataButton
              entityType="proposal"
              entityId={p.id}
              source={proposalRow.attribution?.primary?.source ?? null}
            />
          </div>

          {/* Identity — FIX-1447 (D5): number · Congress · chamber, from bill_details */}
          {identity && (
            <p className="mb-2 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-ink-soft">
              {identity}
            </p>
          )}

          {/* Title */}
          <h1 className="font-serif text-2xl font-bold tracking-tight text-ink sm:text-3xl leading-snug max-w-4xl">
            {p.title}
            {p.is_synthetic && <SyntheticMark withIcon className="ml-2 align-middle" />}
          </h1>

          {/* Topic tags — FIX-1447 (D10), as ProposalCard shows them */}
          {tags.length > 0 && (
            <div className="max-w-4xl">
              <EntityTags entityType="proposal" entityId={p.id} tags={tags} variant="full" />
            </div>
          )}

          {/* Meta row */}
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-ink-soft">
            {p.introduced_at && (
              <span className="font-mono tabular-nums">Introduced {formatDate(p.introduced_at)}</span>
            )}
            {p.comment_period_end && (
              <span className="font-mono tabular-nums">Comment period ends {formatDate(p.comment_period_end)}</span>
            )}
            {regulationsGovHref && (
              <a
                href={regulationsGovHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline transition-colors"
              >
                View on regulations.gov ↗
              </a>
            )}
            {source && (
              <a
                href={source.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline transition-colors"
              >
                {source.label}
              </a>
            )}
            <ProposalShareButton title={p.title} id={p.id} />
          </div>

          {/* Latest action — FIX-1447 (D6): the stored text and its date */}
          {latest && (
            <p className="mt-3 max-w-4xl text-sm text-ink-soft">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-soft/70">
                Latest action{latest.date ? ` · ${latest.date}` : ""}
              </span>{" "}
              <span className="text-ink">{latest.text}</span>
            </p>
          )}

          {/* Stage path — FIX-1447 (D6): federal bills and resolutions only, no dates */}
          {stage && (
            <ol
              aria-label="Stage"
              className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.06em]"
            >
              {stage.steps.map((s, i) => (
                <li
                  key={s.label}
                  aria-current={s.current ? "step" : undefined}
                  className="flex items-center gap-1.5"
                >
                  {i > 0 && <span className="text-ink-soft/40" aria-hidden>→</span>}
                  <span
                    className={
                      s.current
                        ? "border border-civic-blue/40 bg-civic-blue/10 px-1.5 py-0.5 font-bold text-civic-blue"
                        : s.reached
                          ? "text-ink"
                          : "text-ink-soft/50"
                    }
                  >
                    {s.label}
                  </span>
                </li>
              ))}
              {stage.end && (
                <li className="flex items-center gap-1.5">
                  <span className="text-ink-soft/40" aria-hidden>·</span>
                  <span className="border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-bold text-accent">
                    {stage.end}
                  </span>
                </li>
              )}
            </ol>
          )}
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
            ) : null}

            {/* Summary — FIX-1447 (D11): source text keeps its author, beside the AI text */}
            {p.summary_plain && (
              <section>
                <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                  Summary
                </h2>
                <div className="border border-rule bg-card p-5">
                  <p className="text-sm text-ink leading-relaxed whitespace-pre-line">
                    {p.summary_plain}
                  </p>
                  {/* backfill-crs-summaries.ts is the one writer of summary_plain on
                      congress_gov rows (cc-317 read 0 / read 5). */}
                  {proposalRow.primary_source === "congress_gov" && (
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">
                      Congressional Research Service
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* Vote Record — FIX-1447 (D2–D4): every roll of every type, grouped by
                class. The counts are what Civitics stores; never a result. */}
            {rolls.length > 0 && (
              <section>
                <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                  Vote Record
                </h2>
                <p className="mb-4 max-w-2xl text-xs leading-relaxed text-ink-soft">{ON_RECORD_NOTE}</p>

                <div className="space-y-6">
                  {rollGroups.map((g) => (
                    <div key={g.cls}>
                      <h3 className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink">
                        {g.title}
                      </h3>
                      <ul className="border border-rule bg-card divide-y divide-rule/60">
                        {g.shown.map((r) => (
                          <RollItem key={`${r.chamber}:${r.roll_call_id}`} roll={r} isHeadline={r === headline} />
                        ))}
                      </ul>
                      {g.more.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer font-mono text-[10.5px] uppercase tracking-[0.08em] text-accent hover:underline">
                            {g.more.length} more {g.more.length === 1 ? "roll" : "rolls"}
                          </summary>
                          <ul className="mt-2 border border-rule bg-card divide-y divide-rule/60">
                            {g.more.map((r) => (
                              <RollItem key={`${r.chamber}:${r.roll_call_id}`} roll={r} isHeadline={r === headline} />
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  ))}
                </div>

                {/* Members — the headline roll only (D4) */}
                {headline && memberGroups.length > 0 && (
                  <div className="mt-6">
                    <h3 className="mb-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink">
                      How members voted
                    </h3>
                    <p className="mb-3 text-xs text-ink-soft">{rollHeading(headline)}</p>
                    <div className="space-y-2">
                      {memberGroups.map((mg) => {
                        const style = VOTE_STYLES[mg.vote] ?? { label: mg.label, color: "bg-ink/5 text-ink-soft border-rule" };
                        const split = partySplit(headline.by_party, mg.vote);
                        return (
                          <details key={mg.vote} className="border border-rule bg-card">
                            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2.5">
                              <span className={`border px-2 py-0.5 font-mono text-xs font-semibold ${style.color}`}>
                                {style.label}
                              </span>
                              <span className="font-mono text-xs tabular-nums text-ink">
                                {mg.members.length} recorded
                              </span>
                              {split && (
                                <span className="font-mono text-xs tabular-nums text-ink-soft">({split})</span>
                              )}
                            </summary>
                            <div className="divide-y divide-rule/60 border-t border-rule">
                              {mg.members.map((v) => {
                                const partyKey = v.official?.party?.toLowerCase() ?? "";
                                const dot = PARTY_DOT[partyKey] ?? "bg-rule";
                                return (
                                  <div key={v.id} className="flex items-center gap-2 px-4 py-2 min-w-0">
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
                                );
                              })}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Position spine (C1) — intensity, rollup, terms of consensus */}
            <div className="print:hidden">
              <PositionSection
                entityType="proposal"
                entityId={p.id}
                lensEnabled
                constituentJurisdictionId={bcMeta?.jurisdiction_id ?? null}
              />
            </div>

            {/* Community Comments */}
            <div className="mt-8 print:hidden">
              {/* Common-ground / steelman highlights, pinned above list + map */}
              <CommentHighlightsStrip
                entityType="proposal"
                entityId={p.id}
                constituentJurisdictionId={bcMeta?.jurisdiction_id ?? null}
              />
              <EntityComments
                entityType="proposal"
                entityId={p.id}
                allowedKinds={["discussion", "question", "concern", "evidence", "stakeholder_impact"]}
                stanceEnabled
                lensEnabled
                constituentJurisdictionId={bcMeta?.jurisdiction_id ?? null}
                statementsEnabled
                slowMode={slowMode}
              />
            </div>

            {/* Q&A v2 PR-2a (FIX-629): community Q&A on this bill. No official
                answerer exists for a proposal — questions are answered by the
                community with sourced, citation-required notes "from the record". */}
            <div className="mt-8 print:hidden">
              <QASection
                entityType="proposal"
                entityId={p.id}
                entityName={p.title}
                lensEnabled
                constituentJurisdictionId={bcMeta?.jurisdiction_id ?? null}
              />
            </div>

            {/* Citizen Initiatives linked to this proposal */}
            <div className="print:hidden">
              <RelatedInitiatives initiatives={relatedInitiatives} />
            </div>

            {/* Related Proposals */}
            {related.length > 0 && (
              <section className="print:hidden">
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

            {/* Submit Comment — interactive composer, hidden on the printed record.
                FIX-1447 (D9): only a regulation or a row with a comment period has one. */}
            {(p.type === "regulation" || p.comment_period_end) && (
              <section className="print:hidden">
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
            )}

            {/* Proposal details */}
            <section>
              <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
                Details
              </h2>
              <div className="border border-rule bg-card p-4 space-y-3">
                <DetailRow label="Type" value={typeLabel} />
                {number && <DetailRow label="Number" value={number} mono />}
                {bd?.congress_number != null && (
                  <DetailRow label="Congress" value={`${ordinal(bd.congress_number)} Congress`} />
                )}
                {chamber && <DetailRow label="Chamber" value={chamber} />}
                <DetailRow label="Status" value={statusBadge.label} />
                {proposalRow.last_action_at && (
                  <DetailRow label="Last action" value={formatDate(proposalRow.last_action_at)} />
                )}
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
              <p className="text-center text-xs text-ink-soft/70 leading-relaxed print:hidden">
                Official comments are submitted directly to the federal agency via
                regulations.gov — always free, no account required.
              </p>
            )}

          </div>
        </div>

        {/* Print-only provenance footer — stamps the record's URL + print date. */}
        <PrintProvenance />
      </div>
    </div>
  );
}

// FIX-1447 (D2): one roll — its question, chamber and date, the source's result
// when one is stored, what Civitics recorded, and the official roll. Never a
// verdict derived from the counts; the wording lives in vote-rolls.ts.
function RollItem({ roll, isHeadline }: { roll: VoteRoll; isHeadline: boolean }) {
  const l = rollLines(roll);
  return (
    <li className="px-4 py-3 space-y-1">
      <p className="text-sm text-ink">{l.heading}</p>
      {l.result && <p className="text-sm font-semibold text-ink">{l.result}</p>}
      <p className="font-mono text-xs tabular-nums text-ink-soft">{l.recorded}</p>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {roll.source_url && (
          <a
            href={roll.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline transition-colors"
          >
            Official roll ↗
          </a>
        )}
        {isHeadline && <span className="text-ink-soft/70">Members listed below</span>}
      </div>
    </li>
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
