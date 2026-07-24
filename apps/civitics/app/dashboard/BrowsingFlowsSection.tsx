import { SectionCard, SectionHeader, EmptyState } from "@civitics/ui";
import { Icon } from "@civitics/graph";

export type PathTransition = {
  from_page: string;
  to_page: string;
  sessions: number;
};

export type EntryPage = {
  page: string;
  sessions: number;
};

type Props = {
  transitions: PathTransition[];
  entryPages: EntryPage[];
};

function pathIcon(page: string): string {
  if (page === "/" || page === "") return "home";
  if (page.startsWith("/officials")) return "officials";
  if (page.startsWith("/proposals")) return "proposals";
  if (page.startsWith("/agencies")) return "agencies";
  if (page.startsWith("/initiatives")) return "initiatives";
  if (page.startsWith("/graph")) return "graph";
  if (page.startsWith("/search")) return "search";
  if (page.startsWith("/dashboard")) return "dashboard";
  if (page.startsWith("/desk") || page.startsWith("/profile")) return "profile";
  return "page";
}

function pathLabel(page: string): string {
  if (page === "/" || page === "") return "Home";
  if (page === "/officials/:id") return "Official profile";
  if (page === "/proposals/:id") return "Proposal detail";
  if (page === "/agencies/:id") return "Agency detail";
  if (page === "/initiatives/:id") return "Initiative detail";
  const segs = page.split("/").filter(Boolean);
  if (segs.length === 0) return page;
  return segs
    .map((s) => (s === ":id" ? "detail" : s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ")))
    .join(" / ");
}

export function BrowsingFlowsSection({ transitions, entryPages }: Props) {
  const maxSessions = Math.max(1, ...transitions.map((t) => t.sessions));
  const maxEntry = Math.max(1, ...entryPages.map((e) => e.sessions));

  return (
    <SectionCard>
      <SectionHeader
        icon={<Icon name="compass" className="w-4 h-4" />}
        title="How People Explore the Site"
        description="Common journeys across Civitics, last 30 days"
      />

      {/* Entry pages */}
      <div className="mt-4">
        <p className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Where visitors start
        </p>
        {entryPages.length === 0 ? (
          <EmptyState
            title="No entry-page data yet"
            description="Session data will appear here as visitors arrive."
          />
        ) : (
          <ul className="space-y-1.5">
            {entryPages.map((e) => {
              const pct = Math.round((e.sessions / maxEntry) * 100);
              const isTemplate = e.page.includes(":id");
              const rowClass =
                "relative flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-civic-blue/10";
              const inner = (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon name={pathIcon(e.page)} className="w-4 h-4 shrink-0 text-ink-soft" />
                    <span className="truncate font-medium text-ink">{pathLabel(e.page)}</span>
                    <code className="hidden truncate text-[10px] font-mono text-ink-soft/70 sm:inline">
                      {e.page}
                    </code>
                  </span>
                  <span className="tabular-nums text-xs text-ink-soft">
                    {e.sessions.toLocaleString()} sessions
                  </span>
                </>
              );
              return (
                <li key={e.page} className="relative">
                  <div
                    className="absolute inset-y-0 left-0 rounded bg-civic-blue/15"
                    style={{ width: `${pct}%` }}
                    aria-hidden="true"
                  />
                  {isTemplate ? (
                    <span className={rowClass} aria-disabled="true">
                      {inner}
                    </span>
                  ) : (
                    <a href={e.page} className={rowClass}>
                      {inner}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Top transitions */}
      <div className="mt-6 border-t border-rule/60 pt-4">
        <p className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Common next steps
        </p>
        {transitions.length === 0 ? (
          <EmptyState
            title="Not enough data yet"
            description="Transitions appear once several visitors have followed the same path."
          />
        ) : (
          <ul className="space-y-1.5">
            {transitions.map((t, i) => {
              const pct = Math.round((t.sessions / maxSessions) * 100);
              return (
                <li key={i} className="relative">
                  <div
                    className="absolute inset-y-0 left-0 rounded bg-civic-blue/10"
                    style={{ width: `${pct}%` }}
                    aria-hidden="true"
                  />
                  <div className="relative flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <Icon name={pathIcon(t.from_page)} className="w-4 h-4 shrink-0 text-ink-soft" />
                      <span className="truncate text-ink-soft">{pathLabel(t.from_page)}</span>
                      <span className="shrink-0 text-ink-soft/50" aria-hidden="true">→</span>
                      <Icon name={pathIcon(t.to_page)} className="w-4 h-4 shrink-0 text-ink-soft" />
                      <span className="truncate font-medium text-ink">{pathLabel(t.to_page)}</span>
                    </span>
                    <span className="tabular-nums text-xs text-ink-soft">
                      {t.sessions.toLocaleString()}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-4 border-t border-rule/60 pt-3 text-xs leading-relaxed text-ink-soft">
        Aggregate only. We store no IP, no user ID, and only ephemeral session
        IDs. Paths with fewer than 3 sessions are hidden to prevent
        re-identification.
      </p>
    </SectionCard>
  );
}
