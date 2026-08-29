import Link from "next/link";
import { SyntheticMark } from "../integrity/Synthetic";
import { meetingsEnabled } from "@/lib/meetings-flag";

// First meeting card in the app. Presentational only — shared for reuse across
// meeting surfaces. The card links to the live /meetings/[id] detail route
// (apps/civitics/app/meetings/[id]/page.tsx).
//
// is_synthetic is governing-body-scoped: the meetings table has no is_synthetic
// column of its own, so feeders pass the parent governing_bodies.is_synthetic
// through (e.g. via a `governing_bodies(is_synthetic)` embed).
export type MeetingCardData = {
  id: string;
  title: string | null;
  meeting_type: string;
  scheduled_at: string;
  bodyName: string | null;
  agenda_url: string | null;
  is_synthetic?: boolean;
};

const MEETING_TYPE_LABELS: Record<string, string> = {
  regular: "Regular",
  special: "Special",
  committee: "Committee",
  hearing: "Hearing",
  executive_session: "Executive Session",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function MeetingCard({ meeting }: { meeting: MeetingCardData }) {
  const typeLabel = MEETING_TYPE_LABELS[meeting.meeting_type] ?? meeting.meeting_type.replace(/_/g, " ");

  // FIX-1119 — this card renders on THREE live public surfaces
  // (/jurisdictions/[id], /institutions/[id], /franklin), so gating the detail
  // route alone would have turned every one of those into a link to a 404.
  // Meeting information is still real and worth showing; only the navigation is
  // withdrawn, so the card degrades to a non-interactive record rather than
  // disappearing. Hover/focus affordances go with the link — a card that still
  // looked clickable would be the same broken promise in a quieter costume.
  const linked = meetingsEnabled();

  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded border border-rule bg-paper-2 px-2 py-0.5 text-xs font-medium capitalize text-ink-soft">
          {typeLabel}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-soft">
          {formatDateTime(meeting.scheduled_at)}
        </span>
      </div>
      <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-ink transition-colors group-hover:text-accent">
        {meeting.title ?? `${typeLabel} meeting`}
        {meeting.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
      </h3>
      {meeting.bodyName && (
        <p className="mt-0.5 truncate text-xs text-ink-soft">{meeting.bodyName}</p>
      )}
    </>
  );

  const base = "block border border-rule bg-card p-4";

  if (!linked) {
    return <div className={base}>{body}</div>;
  }

  return (
    <Link
      href={`/meetings/${meeting.id}`}
      className={`group ${base} transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      {body}
    </Link>
  );
}
