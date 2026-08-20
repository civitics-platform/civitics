import type { HomeStats } from "./types";

/**
 * FIX-1070 — "—" means NOT MEASURED, and only that. A measured 0 prints "0".
 * This used to read `n > 0 ? … : "—"`, which quietly folded three different
 * states (timed out, absent, genuinely zero) into one glyph.
 */
function line(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

/**
 * The hero receipt card — running totals printed like a till receipt,
 * slightly rotated, with the $0.00-always pledge box and a barcode foot.
 */
export function HeroReceipt({
  stats,
  dateLabel,
}: {
  stats: HomeStats;
  /** Server-formatted MM/DD/YYYY — passed in so the card stays presentational. */
  dateLabel: string;
}) {
  const rows = [
    { label: "OFFICIALS",        value: line(stats.officials) },
    { label: "PROPOSALS",        value: line(stats.proposals) },
    { label: "DONOR RECORDS",    value: line(stats.donors) },
    { label: "SPENDING RECORDS", value: line(stats.spending) },
  ];

  return (
    <aside className="rotate-[0.6deg] border border-rule bg-card px-5 pb-3.5 pt-5 font-mono shadow-[0_1px_0_rgb(var(--c-rule)),0_10px_26px_rgba(28,26,22,0.10)]">
      <div className="border-b border-dashed border-rule pb-2.5 text-center">
        <div className="text-[13px] font-bold tracking-[0.2em] text-ink">CIVITICS</div>
        <div className="mt-1 text-[9px] tracking-[0.1em] text-ink-soft">
          RUNNING TOTALS — {dateLabel}
        </div>
      </div>
      <div className="pt-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between py-1.5 text-[11.5px]"
          >
            <span className="text-ink-soft">{row.label}</span>
            <span className="mx-2 flex-1 -translate-y-[3px] border-b border-dotted border-rule" />
            <span className="font-bold tabular-nums text-ink">{row.value}</span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 border border-ink p-2 text-center text-[10px] font-bold tracking-[0.06em] text-ink">
        YOUR COST TO READ &amp; COMMENT: <span className="text-accent">$0.00 — ALWAYS</span>
      </div>
      <div
        aria-hidden="true"
        className="mx-auto mb-1 mt-3 h-[26px] w-3/4"
        style={{
          background:
            "repeating-linear-gradient(90deg, rgb(var(--c-ink)) 0 2px, transparent 2px 5px, rgb(var(--c-ink)) 5px 6px, transparent 6px 11px, rgb(var(--c-ink)) 11px 14px, transparent 14px 17px)",
        }}
      />
      <div className="text-center text-[8.5px] tracking-[0.12em] text-ink-soft">
        DEMOCRACY EXPIRES IF UNUSED
      </div>
    </aside>
  );
}
