// QWEN-ADDED: Government spending records section for official detail pages

type SpendingRow = {
  id: string;
  recipient_name: string;
  award_type: string | null;
  amount_cents: number;
  award_date: string | null;
  description: string | null;
  awarding_agency: string;
};

function formatMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  if (dollars > 0) return `$${dollars.toLocaleString()}`;
  return "$0";
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const AWARD_TYPE_STYLES: Record<string, { label: string; cls: string }> = {
  contract:  { label: 'Contract', cls: 'bg-ink/5 text-ink-soft' },
  grant:     { label: 'Grant',    cls: 'bg-green-ink/10 text-green-ink' },
  loan:      { label: 'Loan',     cls: 'bg-amber/25 text-ink' },
};

/**
 * Server component — data passed as props.
 * Returns null if items.length === 0.
 */
export function SpendingSection({ items }: { items: SpendingRow[] }) {
  if (items.length === 0) return null;

  const totalCents = items.reduce((s, r) => s + r.amount_cents, 0);

  return (
    <div className="border border-rule bg-card overflow-hidden mb-6">
      {/* Header */}
      <div className="px-5 py-4 border-b-2 border-ink">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Government Spending</h2>
          </div>
          <span className="font-mono text-sm font-bold tabular-nums text-ink">{formatMoney(totalCents)}</span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-rule bg-paper-2">
              <th className="text-left px-5 py-2 font-mono text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wide">Recipient</th>
              <th className="text-left px-3 py-2 font-mono text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wide">Type</th>
              <th className="text-right px-3 py-2 font-mono text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wide">Amount</th>
              <th className="text-left px-3 py-2 font-mono text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wide">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule/60">
            {items.map((row) => {
              const typeStyle = AWARD_TYPE_STYLES[row.award_type ?? ''] ?? { label: row.award_type ?? 'Other', cls: 'bg-ink/5 text-ink-soft' };
              return (
                <tr key={row.id} className="hover:bg-paper-2/50">
                  <td className="px-5 py-3">
                    <p className="font-medium text-ink truncate max-w-[200px]">{row.recipient_name}</p>
                    {row.description && (
                      <p className="text-[10px] text-ink-soft/70 truncate max-w-[200px] mt-0.5">{row.description}</p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`px-1.5 py-0.5 font-mono text-[9px] font-semibold ${typeStyle.cls}`}>
                      {typeStyle.label}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono font-semibold text-ink tabular-nums">
                    {formatMoney(row.amount_cents)}
                  </td>
                  <td className="px-3 py-3 font-mono text-ink-soft/70 tabular-nums">
                    {formatDate(row.award_date)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
