"use client";

type ChartRow = { name: string; acronym: string | null; count: number };

export function AgencyActivityChart({ rows }: { rows: ChartRow[] }) {
  if (rows.length === 0) return null;

  const max = rows[0]?.count ?? 1;

  return (
    <div className="mb-8 border border-rule bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink">Agency Activity</h2>
          <p className="text-xs text-ink-soft/70">By total rulemaking proposals on record</p>
        </div>
      </div>

      <div className="space-y-2.5">
        {rows.map((row) => {
          const pct = max > 0 ? Math.max(2, Math.round((row.count / max) * 100)) : 0;
          const label = row.acronym ?? row.name.split(" ").map((w) => w[0]).join("").slice(0, 5).toUpperCase();

          return (
            <div key={row.acronym ?? row.name} className="flex items-center gap-3">
              <span
                className="w-12 shrink-0 text-right font-mono text-[11px] font-semibold text-ink-soft/70"
                title={row.name}
              >
                {label}
              </span>
              <div className="flex-1 overflow-hidden rounded-full bg-civic-blue/10" style={{ height: "10px" }}>
                <div
                  className="h-full rounded-full bg-civic-blue transition-all"
                  style={{ width: `${pct}%` }}
                  aria-label={`${row.name}: ${row.count} proposals`}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-ink-soft">
                {row.count.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
