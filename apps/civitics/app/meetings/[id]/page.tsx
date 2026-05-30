// FIX-I: /meetings/[id] detail page. Fills the FIX-424-documented dead link from
// MeetingCard (rendered on /jurisdictions/[id] and /institutions/[id]). UUID-
// canonical (middleware guards malformed paths to a true 404; the page also
// notFound()s a non-UUID as belt-and-braces). ISR (revalidate 300) — meetings
// are time-bounded events that rarely change once recorded. Publishable client.
//
// Live-schema notes: meetings carries governing_body_id (NOT NULL), meeting_type,
// title (nullable), scheduled_at, location, status, agenda_url, minutes_url,
// video_url, metadata. No primary_source* columns → no SourceBadge here.
import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";
import { createPublicClient } from "@civitics/db";
import { PageViewTracker } from "../../components/PageViewTracker";

export const revalidate = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MEETING_TYPE_LABELS: Record<string, string> = {
  regular: "Regular",
  special: "Special",
  committee: "Committee",
  hearing: "Hearing",
  executive_session: "Executive Session",
};

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  scheduled: { label: "Scheduled", color: "bg-blue-50 text-blue-700 border-blue-200" },
  in_progress: { label: "In Progress", color: "bg-amber-50 text-amber-800 border-amber-200" },
  completed: { label: "Completed", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  cancelled: { label: "Cancelled", color: "bg-gray-100 text-gray-500 border-gray-200" },
  postponed: { label: "Postponed", color: "bg-orange-50 text-orange-700 border-orange-200" },
};

const OUTCOME_BADGE: Record<string, { label: string; color: string }> = {
  passed: { label: "Passed", color: "bg-emerald-50 text-emerald-700" },
  failed: { label: "Failed", color: "bg-red-50 text-red-700" },
  tabled: { label: "Tabled", color: "bg-gray-100 text-gray-600" },
  continued: { label: "Continued", color: "bg-blue-50 text-blue-700" },
  withdrawn: { label: "Withdrawn", color: "bg-gray-100 text-gray-500" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function typeLabel(t: string): string {
  return MEETING_TYPE_LABELS[t] ?? t.replace(/_/g, " ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anonClient(): any {
  return createClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]!
  );
}

export async function generateStaticParams(): Promise<Array<{ id: string }>> {
  try {
    const supabase = anonClient();
    const result = await Promise.race([
      supabase.from("meetings").select("id").order("scheduled_at", { ascending: false }).limit(50),
      new Promise<{ data: null }>((resolve) => setTimeout(() => resolve({ data: null }), 5000)),
    ]);
    const data = (result as { data: Array<{ id: string }> | null }).data;
    return (data ?? []).map((r) => ({ id: r.id }));
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return { title: "Meeting · Civitics" };
  const supabase = createPublicClient();
  const { data } = await supabase
    .from("meetings")
    .select("title, meeting_type, scheduled_at")
    .eq("id", id)
    .maybeSingle();
  if (!data) return { title: "Meeting · Civitics" };
  const m = data as { title: string | null; meeting_type: string; scheduled_at: string };
  const t = m.title ?? `${typeLabel(m.meeting_type)} meeting · ${formatDateTime(m.scheduled_at)}`;
  return { title: `${t} · Civitics` };
}

type AgendaItem = {
  id: string;
  sequence: number | null;
  title: string | null;
  item_type: string | null;
  description: string | null;
  outcome: string | null;
  proposal_id: string | null;
};

export default async function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const supabase = createPublicClient();

  const { data: meetingData } = await supabase
    .from("meetings")
    .select(
      "id, governing_body_id, meeting_type, title, scheduled_at, location, status, agenda_url, minutes_url, video_url"
    )
    .eq("id", id)
    .maybeSingle();

  if (!meetingData) notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meeting = meetingData as any;

  const [bodyRes, agendaRes] = await Promise.all([
    supabase
      .from("institutions")
      .select("id, name, jurisdiction_id")
      .eq("id", meeting.governing_body_id)
      .maybeSingle(),
    supabase
      .from("agenda_items")
      .select("id, sequence, title, item_type, description, outcome, proposal_id")
      .eq("meeting_id", id)
      .order("sequence", { ascending: true }),
  ]);

  const body = (bodyRes.data ?? null) as { id: string; name: string; jurisdiction_id: string | null } | null;

  let jurisdiction: { id: string; name: string } | null = null;
  if (body?.jurisdiction_id) {
    const { data } = await supabase
      .from("jurisdictions")
      .select("id, name")
      .eq("id", body.jurisdiction_id)
      .maybeSingle();
    jurisdiction = (data as { id: string; name: string } | null) ?? null;
  }

  const agendaItems = (agendaRes.data ?? []) as AgendaItem[];

  // Resolve linked proposal titles for agenda items that reference one.
  const proposalIds = Array.from(
    new Set(agendaItems.map((a) => a.proposal_id).filter(Boolean) as string[])
  );
  const proposalTitles = new Map<string, string>();
  if (proposalIds.length > 0) {
    const { data: props } = await supabase
      .from("proposals")
      .select("id, title")
      .in("id", proposalIds);
    for (const p of (props ?? []) as Array<{ id: string; title: string }>) {
      proposalTitles.set(p.id, p.title);
    }
  }

  const status = STATUS_BADGE[meeting.status] ?? {
    label: meeting.status,
    color: "bg-gray-100 text-gray-600 border-gray-200",
  };
  const headerTitle =
    meeting.title ??
    `${typeLabel(meeting.meeting_type)} meeting${body ? ` · ${body.name}` : ""}`;

  const artifacts: Array<{ label: string; href: string }> = [
    meeting.agenda_url && { label: "Agenda", href: meeting.agenda_url },
    meeting.minutes_url && { label: "Minutes", href: meeting.minutes_url },
    meeting.video_url && { label: "Video", href: meeting.video_url },
  ].filter(Boolean) as Array<{ label: string; href: string }>;

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker entityType="meeting" entityId={id} />

      {/* ─── Header ─────────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          {/* Breadcrumb */}
          <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
            {jurisdiction && (
              <>
                <Link
                  href={`/jurisdictions/${jurisdiction.id}`}
                  className="hover:text-gray-700 transition-colors"
                >
                  {jurisdiction.name}
                </Link>
                <span>/</span>
              </>
            )}
            {body && (
              <>
                <Link
                  href={`/institutions/${body.id}`}
                  className="hover:text-gray-700 transition-colors"
                >
                  {body.name}
                </Link>
                <span>/</span>
              </>
            )}
            <span className="text-gray-600">Meeting</span>
          </nav>

          {/* Badge row */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="rounded border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium capitalize text-gray-600">
              {typeLabel(meeting.meeting_type)}
            </span>
            <span className={`rounded border px-2.5 py-1 text-xs font-semibold ${status.color}`}>
              {status.label}
            </span>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl leading-snug">
            {headerTitle}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
            <span>
              {formatDateTime(meeting.scheduled_at)} · {formatTime(meeting.scheduled_at)}
            </span>
            {meeting.location && <span>· {meeting.location}</span>}
          </div>

          {/* Artifact links */}
          {artifacts.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {artifacts.map((a) => (
                <a
                  key={a.label}
                  href={a.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
                >
                  {a.label} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── Agenda items ───────────────────────────────────────────────────── */}
      <main id="main-content" className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {agendaItems.length > 0 ? (
          <section>
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Agenda</h2>
            <ol className="space-y-3">
              {agendaItems.map((item) => {
                const outcome = item.outcome ? OUTCOME_BADGE[item.outcome] : null;
                const linkedTitle = item.proposal_id ? proposalTitles.get(item.proposal_id) : null;
                return (
                  <li
                    key={item.id}
                    className="rounded-lg border border-gray-200 bg-white p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {item.sequence != null && (
                            <span className="font-mono text-xs text-gray-400">
                              {item.sequence}.
                            </span>
                          )}
                          <h3 className="text-sm font-semibold text-gray-900">
                            {item.title ?? "Agenda item"}
                          </h3>
                          {item.item_type && (
                            <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium capitalize text-gray-500">
                              {item.item_type.replace(/_/g, " ")}
                            </span>
                          )}
                        </div>
                        {item.description && (
                          <p className="mt-1 text-sm text-gray-600">{item.description}</p>
                        )}
                        {item.proposal_id && (
                          <Link
                            href={`/proposals/${item.proposal_id}`}
                            className="mt-1 inline-block text-xs font-medium text-indigo-600 hover:text-indigo-800"
                          >
                            {linkedTitle ?? "View proposal"} →
                          </Link>
                        )}
                      </div>
                      {outcome && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${outcome.color}`}
                        >
                          {outcome.label}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
            No agenda items on record for this meeting.
          </div>
        )}
      </main>
    </div>
  );
}
