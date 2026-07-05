type AgencyRef = { id: string; name: string; acronym: string | null };

function Chip({ agency, isCurrent }: { agency: AgencyRef; isCurrent?: boolean }) {
  const label = agency.acronym ?? agency.name.split(" ").map((w) => w[0]).join("").slice(0, 5).toUpperCase();

  if (isCurrent) {
    return (
      <div className="flex items-center gap-2 rounded-lg border-2 border-accent bg-accent/10 px-3 py-2">
        <span className="font-mono text-xs font-bold text-accent">{label}</span>
        <span className="text-sm font-semibold text-accent truncate">{agency.name}</span>
        <span className="ml-auto shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
          This agency
        </span>
      </div>
    );
  }

  return (
    <a
      href={`/agencies/${agency.id}`}
      className="flex items-center gap-2 rounded-lg border border-rule bg-card px-3 py-2 hover:border-accent hover:shadow-sm transition-all"
    >
      <span className="font-mono text-xs font-bold text-ink-soft/70">{label}</span>
      <span className="text-sm font-medium text-ink-soft truncate">{agency.name}</span>
      <svg
        className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-soft/70"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </a>
  );
}

export function AgencyHierarchyTree({
  parent,
  current,
  children,
}: {
  parent: AgencyRef | null;
  current: AgencyRef;
  children: AgencyRef[];
}) {
  return (
    <div className="border border-rule bg-card p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
        Agency Hierarchy
      </p>

      <div className="space-y-1.5">
        {/* Parent row */}
        {parent && (
          <div>
            <Chip agency={parent} />
          </div>
        )}

        {/* Current agency row — indented when there's a parent */}
        <div className={parent ? "flex gap-2" : undefined}>
          {parent && (
            <div className="flex w-5 shrink-0 flex-col items-center">
              <div className="mt-0 w-px flex-1 bg-rule/40" />
              <div className="mb-1 h-3 w-3 rounded-sm border-b-2 border-l-2 border-rule" />
            </div>
          )}
          <div className="flex-1">
            <Chip agency={current} isCurrent />
          </div>
        </div>

        {/* Child rows — indented under current */}
        {children.length > 0 && (
          <div className="flex gap-2">
            <div className="flex w-5 shrink-0 flex-col items-center">
              <div className="mt-0 w-px flex-1 bg-rule/40" />
            </div>
            <div className="flex-1 space-y-1.5">
              {children.map((child) => (
                <div key={child.id} className="flex gap-2">
                  <div className="flex w-4 shrink-0 flex-col items-center">
                    <div className="mt-0 w-px flex-1 bg-rule/40" />
                    <div className="mb-1 h-3 w-3 rounded-sm border-b-2 border-l-2 border-rule" />
                  </div>
                  <div className="flex-1">
                    <Chip agency={child} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {children.length > 0 && (
        <p className="mt-2 text-[11px] text-ink-soft/70">
          {children.length} sub-{children.length === 1 ? "agency" : "agencies"}
        </p>
      )}
    </div>
  );
}
