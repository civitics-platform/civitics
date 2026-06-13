// QWEN-ADDED: Career history timeline component for official detail pages

type CareerHistoryRow = {
  id: string;
  organization: string;
  role_title: string | null;
  started_at: string | null;
  ended_at: string | null;
  is_government: boolean;
  revolving_door_flag: boolean;
  revolving_door_explanation: string | null;
};

/** Format a date string as "Jan 2019" or return "—" if missing. */
function formatMonthYear(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

/**
 * Server component — data is passed in as props.
 * Shows nothing (return null) if items.length === 0.
 */
export function CareerHistory({ items }: { items: CareerHistoryRow[] }) {
  if (items.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink mb-3">Career History</h3>
      <div className="space-y-0">
        {items.map((item, idx) => (
          <div
            key={item.id}
            className={`flex gap-4 px-4 py-3 ${
              idx < items.length - 1 ? "border-b border-rule/60" : ""
            }`}
          >
            {/* Timeline dot + line */}
            <div className="flex flex-col items-center pt-1 shrink-0">
              <div
                className={`w-3 h-3 rounded-full border-2 ${
                  item.revolving_door_flag
                    ? "border-amber bg-amber/30"
                    : item.is_government
                      ? "border-ink-soft bg-ink/10"
                      : "border-civic-blue bg-civic-blue/10"
                }`}
              />
              {idx < items.length - 1 && (
                <div className="w-px flex-1 bg-rule mt-1" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-ink">
                  {item.role_title ?? "Employee"}
                </span>
                {item.is_government && (
                  <span className="px-1.5 py-0.5 font-mono text-[9px] font-semibold bg-ink/10 text-ink-soft">
                    GOV
                  </span>
                )}
                {item.revolving_door_flag && (
                  <span className="px-1.5 py-0.5 font-mono text-[9px] font-semibold bg-amber/25 text-ink">
                    ⚠ Revolving Door
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-soft mt-0.5">{item.organization}</p>
              <p className="font-mono text-[10px] tabular-nums text-ink-soft/70 mt-1">
                {formatMonthYear(item.started_at)} — {item.ended_at ? formatMonthYear(item.ended_at) : "Present"}
              </p>
              {item.revolving_door_flag && item.revolving_door_explanation && (
                <p className="text-[10px] text-ink-soft mt-1 leading-relaxed">
                  {item.revolving_door_explanation}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
