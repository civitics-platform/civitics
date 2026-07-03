import Link from "next/link";

// ─── Shared types ────────────────────────────────────────────────────────────

export type InitiativeCardData = {
  id: string;
  title: string;
  summary: string | null;
  stage: string; // "problem" | "draft" | "deliberate" | "mobilise" | "resolved"
  scope: string; // "federal" | "state" | "local"
  authorship_type: string; // "individual" | "community"
  issue_area_tags: string[];
  target_district: string | null;
  mobilise_started_at: string | null;
  created_at: string;
  resolved_at: string | null;
  /** Optional — surfaced on the homepage "trending" grid */
  upvoteCount?: number;
};

// ─── Style tables ────────────────────────────────────────────────────────────

// Stage pills mirror the RelatedInitiatives token map (FIX-565 precedent);
// scope is a categorical fact, not a signal, so it reads as one neutral chip.
const STAGE_STYLES: Record<string, { label: string; color: string }> = {
  problem:    { label: "Problem",      color: "bg-accent/10 text-accent border-accent/25" },
  draft:      { label: "Draft",        color: "bg-ink/5 text-ink-soft border-rule" },
  deliberate: { label: "Deliberating", color: "bg-amber/25 text-ink border-amber/60" },
  mobilise:   { label: "Mobilising",   color: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  resolved:   { label: "Resolved",     color: "bg-green-ink/10 text-green-ink border-green-ink/25" },
};

const SCOPE_CLS = "border border-rule bg-paper-2 text-ink-soft";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export function InitiativeCard({ initiative }: { initiative: InitiativeCardData }) {
  const stageStyle = STAGE_STYLES[initiative.stage] ?? STAGE_STYLES.draft!;

  return (
    <Link
      href={`/initiatives/${initiative.id}`}
      className="group block h-full border border-rule bg-card p-5 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex h-full flex-col">
        {/* Tags row */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${stageStyle.color}`}>
            {stageStyle.label}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${SCOPE_CLS}`}>
            {initiative.scope}
          </span>
          {initiative.authorship_type === "community" && (
            <span className="rounded-full bg-green-ink/10 px-2 py-0.5 text-xs font-medium text-green-ink">
              Community
            </span>
          )}
          {initiative.issue_area_tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded-full bg-ink/5 px-2 py-0.5 text-xs capitalize text-ink-soft"
            >
              {t.replace(/_/g, " ")}
            </span>
          ))}
        </div>

        {/* Title */}
        <h2 className="text-base font-semibold leading-snug text-ink line-clamp-2 group-hover:text-accent transition-colors">
          {initiative.title}
        </h2>

        {/* Summary */}
        {initiative.summary && (
          <p className="mt-1 text-sm text-ink-soft line-clamp-2">{initiative.summary}</p>
        )}

        {/* Spacer so footer stays at bottom when used in equal-height grids */}
        <div className="flex-1" />

        {/* Footer */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-ink-soft">
          {typeof initiative.upvoteCount === "number" && initiative.upvoteCount > 0 && (
            <span className="inline-flex items-center gap-1 font-medium text-green-ink">
              <svg
                aria-hidden="true"
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
              </svg>
              {initiative.upvoteCount.toLocaleString()} upvote
              {initiative.upvoteCount === 1 ? "" : "s"}
            </span>
          )}
          <span>Started {formatDate(initiative.created_at)}</span>
          {initiative.mobilise_started_at && (
            <span>Mobilising since {formatDate(initiative.mobilise_started_at)}</span>
          )}
          {initiative.target_district && <span>{initiative.target_district}</span>}
        </div>
      </div>
    </Link>
  );
}
