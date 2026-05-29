import Link from "next/link";
import {
  InstitutionCard,
  type InstitutionCardData,
} from "../../../components/cards/InstitutionCard";
import { MeetingCard, type MeetingCardData } from "../../../components/cards/MeetingCard";
import {
  OfficialRosterCard,
  type OfficialRosterData,
} from "../../../components/cards/OfficialRosterCard";
import { ProposalCard, type ProposalCardData } from "../../../proposals/components/ProposalCard";
import {
  InitiativeCard,
  type InitiativeCardData,
} from "../../../initiatives/components/InitiativeCard";
import { JURISDICTION_TYPE_LABELS } from "./JurisdictionHeader";

// ─── Shared section wrapper ──────────────────────────────────────────────────

export function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000_000) return `$${(dollars / 1_000_000_000).toFixed(1)}B`;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── 4. Child jurisdictions ──────────────────────────────────────────────────

export type ChildJurisdiction = {
  id: string;
  name: string;
  short_name: string | null;
  type: string;
};

export function ChildJurisdictionsNav({ items }: { items: ChildJurisdiction[] }) {
  const byType = new Map<string, ChildJurisdiction[]>();
  for (const c of items) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c);
  }

  return (
    <div className="space-y-4">
      {Array.from(byType.entries()).map(([type, items]) => {
        const label = JURISDICTION_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
        const heading = `${label}${items.length === 1 ? "" : "s"} (${items.length})`;
        const links = items.map((c) => (
          <Link
            key={c.id}
            href={`/jurisdictions/${c.id}`}
            className="rounded-full border border-gray-200 bg-white px-2.5 py-0.5 text-xs text-gray-700 hover:border-indigo-300 hover:text-indigo-700"
          >
            {c.short_name ?? c.name}
          </Link>
        ));

        return (
          <div key={type} className="rounded-lg border border-gray-200 bg-white p-4">
            {items.length > 20 ? (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-gray-700">
                  {heading}
                </summary>
                <div className="mt-3 flex flex-wrap gap-1.5">{links}</div>
              </details>
            ) : (
              <>
                <p className="mb-3 text-sm font-medium text-gray-700">{heading}</p>
                <div className="flex flex-wrap gap-1.5">{links}</div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── 5. Institutions ─────────────────────────────────────────────────────────

export function InstitutionsList({ institutions }: { institutions: InstitutionCardData[] }) {
  if (institutions.length <= 5) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {institutions.map((i) => (
          <InstitutionCard key={i.id} institution={i} />
        ))}
      </div>
    );
  }
  // Group by type when the list is long.
  const byType = new Map<string, InstitutionCardData[]>();
  for (const i of institutions) {
    if (!byType.has(i.type)) byType.set(i.type, []);
    byType.get(i.type)!.push(i);
  }
  return (
    <div className="space-y-4">
      {Array.from(byType.entries()).map(([type, items]) => (
        <div key={type}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            {type.replace(/_/g, " ")}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map((i) => (
              <InstitutionCard key={i.id} institution={i} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 6. Officials roster ─────────────────────────────────────────────────────

export function OfficialsRoster({
  officials,
  hasMore,
}: {
  officials: OfficialRosterData[];
  hasMore: boolean;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {officials.map((o) => (
          <OfficialRosterCard key={o.id} official={o} />
        ))}
      </div>
      {hasMore && (
        <p className="mt-3 text-xs text-gray-400">
          Showing the first {officials.length}. More officials are on record for this jurisdiction.
        </p>
      )}
    </>
  );
}

// ─── 7. Proposals ────────────────────────────────────────────────────────────

export function ProposalsSection({ proposals }: { proposals: ProposalCardData[] }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {proposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} />
        ))}
      </div>
      <Link
        href="/proposals"
        className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline"
      >
        View all proposals →
      </Link>
    </>
  );
}

// ─── 8. Meetings ─────────────────────────────────────────────────────────────

export function MeetingsSection({ meetings }: { meetings: MeetingCardData[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {meetings.map((m) => (
        <MeetingCard key={m.id} meeting={m} />
      ))}
    </div>
  );
}

// ─── 9. Initiatives ──────────────────────────────────────────────────────────

export function InitiativesSection({ initiatives }: { initiatives: InitiativeCardData[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {initiatives.map((i) => (
        <InitiativeCard key={i.id} initiative={i} />
      ))}
    </div>
  );
}

// ─── 10. Spending ────────────────────────────────────────────────────────────

export type SpendingGroup = {
  recipient: string;
  awardType: string;
  totalCents: number;
  fiscalYear: string;
};

export function SpendingSection({ groups }: { groups: SpendingGroup[] }) {
  return (
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
          {groups.map((g, i) => (
            <tr key={i} className="hover:bg-gray-50">
              <td className="max-w-xs truncate px-4 py-2.5 text-sm font-medium text-gray-800">
                {g.recipient}
              </td>
              <td className="px-4 py-2.5 text-xs capitalize text-gray-500">{g.awardType}</td>
              <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-gray-900">
                {formatDollars(g.totalCents)}
              </td>
              <td className="px-4 py-2.5 text-right text-xs text-gray-400">{g.fiscalYear}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 11. Activity feed ───────────────────────────────────────────────────────

export type ActivityEvent = {
  occurred_at: string | null;
  event_type: string;
  entity_id: string;
  summary: string;
  url: string;
};

const EVENT_ICON: Record<string, string> = {
  proposal_introduced: "📄",
  meeting: "📅",
  initiative_created: "📣",
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <ol className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      {events.map((e, i) => (
        <li key={`${e.entity_id}-${i}`} className="border-b border-gray-100 last:border-0">
          <Link
            href={e.url}
            className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50"
          >
            <span aria-hidden className="text-base">
              {EVENT_ICON[e.event_type] ?? "•"}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{e.summary}</span>
            <span className="shrink-0 text-xs text-gray-400">{formatDate(e.occurred_at)}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
