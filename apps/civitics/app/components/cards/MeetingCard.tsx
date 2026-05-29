import Link from "next/link";

// First meeting card in the app. Presentational only — created shared from the
// start for reuse once a meetings index / detail surface exists.
//
// NOTE: /meetings/[id] does NOT exist yet (v1). The link is intentionally a
// documented dead-end; remove this comment when the detail route ships.
export type MeetingCardData = {
  id: string;
  title: string | null;
  meeting_type: string;
  scheduled_at: string;
  bodyName: string | null;
  agenda_url: string | null;
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
      className="group block rounded-lg border border-gray-200 bg-white p-4 transition-all hover:border-gray-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <div className="flex items-center gap-2">
        <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium capitalize text-gray-600">
          {typeLabel}
        </span>
        <span className="text-xs text-gray-400">{formatDateTime(meeting.scheduled_at)}</span>
      </div>
      <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
        {meeting.title ?? `${typeLabel} meeting`}
      </h3>
      {meeting.bodyName && (
        <p className="mt-0.5 truncate text-xs text-gray-500">{meeting.bodyName}</p>
      )}
    </Link>
  );
}
