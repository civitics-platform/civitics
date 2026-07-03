import Link from "next/link";
import { SyntheticMark } from "../integrity/Synthetic";

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
  return (
    <Link
      href={`/meetings/${meeting.id}`}
      className="group block border border-rule bg-card p-4 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
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
    </Link>
  );
}
