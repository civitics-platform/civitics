import Link from "next/link";
import { CommentPeriodBadge } from "./CommentPeriodBadge";
import { SubmitCommentButton } from "./SubmitCommentButton";
import { EntityTags, type EntityTag } from "../../components/tags/EntityTags";
import { ProposalShareButton } from "./ProposalShareButton";

export type ProposalCardData = {
  id: string;
  title: string;
  type: string;
  status: string;
  regulations_gov_id: string | null;
  congress_gov_url: string | null;
  comment_period_end: string | null;
  summary_plain: string | null;
  summary_model: string | null;
  introduced_at: string | null;
  metadata: Record<string, string>;
  // Resolved at query time by the page
  agency_name?: string | null;
  ai_summary?: string | null;
  tags?: EntityTag[];
};

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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isOpenForComment(p: ProposalCardData): boolean {
  return (
    p.status === "open_comment" &&
    !!p.comment_period_end &&
    new Date(p.comment_period_end) > new Date()
  );
}

export function ProposalCard({ proposal }: { proposal: ProposalCardData }) {
  const statusBadge = STATUS_BADGE[proposal.status] ?? {
    label: proposal.status,
    color: "bg-ink/5 text-ink-soft border-rule",
  };
  const typeLabel = TYPE_LABEL[proposal.type] ?? proposal.type;
  const agencyAcronym = proposal.metadata?.agency_id ?? null;
  const docType = proposal.metadata?.document_type ?? null;
  const open = isOpenForComment(proposal);

  // Summary: prefer cached AI summary, fall back to summary_plain
  const summaryText = proposal.ai_summary ?? proposal.summary_plain ?? null;
  const isAiSummary = !!proposal.ai_summary || !!proposal.summary_model;
  const summaryTruncated = summaryText
    ? summaryText.length > 150
      ? summaryText.slice(0, 150) + "…"
      : summaryText
    : null;

  return (
    <div
      className={`group relative flex flex-col h-full border bg-card p-5 transition-all hover:shadow-sm hover:border-accent cursor-pointer ${
        open ? "border-amber/60" : "border-rule"
      }`}
    >
      {/* Stretched link — covers whole card, sits below interactive content */}
      <Link
        href={`/proposals/${proposal.id}`}
        className="absolute inset-0 z-0"
        aria-label={proposal.title}
      />

      {/* All card content sits above the stretched link */}
      <div className="relative z-10 flex flex-col h-full">
        {/* Badge row */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span
            className={`border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] ${statusBadge.color}`}
          >
            {open ? "⏰ " : ""}{statusBadge.label}
          </span>
          {docType && (
            <span className="text-xs text-ink-soft/70">{docType}</span>
          )}
          {!docType && typeLabel && (
            <span className="text-xs text-ink-soft/70">{typeLabel}</span>
          )}
        </div>

        {/* Agency */}
        {agencyAcronym && (
          <div className="flex items-center gap-1.5 mb-2">
            <span className="border border-rule bg-paper-2 px-2 py-0.5 text-xs font-mono font-semibold text-ink">
              {agencyAcronym}
            </span>
            {proposal.agency_name && (
              <span className="text-xs text-ink-soft/70 truncate" title={proposal.agency_name}>
                ·{" "}
                {proposal.agency_name.length > 40
                  ? proposal.agency_name.slice(0, 40) + "…"
                  : proposal.agency_name}
              </span>
            )}
          </div>
        )}

        {/* Title */}
        <h3 className="font-serif text-sm font-semibold text-ink leading-snug line-clamp-2 mb-2 group-hover:text-accent transition-colors">
          {proposal.title}
        </h3>

        {/* Summary */}
        {summaryTruncated && (
          <div className="mb-3">
            {isAiSummary && (
              <span className="inline-block bg-civic-blue/10 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-civic-blue mb-1">
                AI summary
              </span>
            )}
            <p className="text-xs text-ink-soft leading-relaxed line-clamp-3">
              {summaryTruncated}
            </p>
          </div>
        )}

        {/* Tags */}
        {proposal.tags && proposal.tags.length > 0 && (
          <EntityTags
            entityType="proposal"
            entityId={proposal.id}
            tags={proposal.tags}
            variant="compact"
          />
        )}

        <div className="mt-auto space-y-3">
          {/* Deadline badge */}
          {open && proposal.comment_period_end && (
            <CommentPeriodBadge
              commentPeriodEnd={proposal.comment_period_end}
              compact
            />
          )}
          {!open && proposal.introduced_at && (
            <p className="font-mono text-xs tabular-nums text-ink-soft/70">
              Introduced {formatDate(proposal.introduced_at)}
            </p>
          )}

          {/* Action row — these are above the stretched link, so clicks work normally */}
          <div className="flex items-center gap-2">
            {open && (
              <SubmitCommentButton
                regulationsGovId={proposal.regulations_gov_id}
                congressGovUrl={proposal.congress_gov_url}
                size="sm"
              />
            )}
            <ProposalShareButton title={proposal.title} id={proposal.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
