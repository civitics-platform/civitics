import Link from "next/link";
import type { ProposalCardData } from "../../proposals/components/ProposalCard";

function daysLeft(end: string | null, nowIso: string): number | null {
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(nowIso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function closesTone(days: number | null): string {
  if (days === null) return "text-term-dim";
  if (days <= 7) return "text-term-red";
  if (days <= 14) return "text-amber";
  return "text-term-green";
}

/**
 * Closing-soon comment windows as an embedded terminal instrument.
 * The data-theme="terminal" wrapper re-binds the semantic tokens, so this
 * panel renders dark inside the paper page. Rows are the homepage's existing
 * open-proposals fetch — no comment counts (they don't exist yet).
 */
export function ClosingSoonPanel({
  proposals,
  nowIso,
  activeCount,
}: {
  proposals: ProposalCardData[];
  nowIso: string;
  /** FIX-1070 — null means the hero-stats read did not complete. */
  activeCount: number | null;
}) {
  return (
    <section className="border-b border-rule py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-accent">
          Act before the window closes
        </p>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl font-bold text-ink sm:text-[27px]">
            Open comment windows
          </h2>
          <a
            href="/proposals?status=open"
            className="shrink-0 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-accent hover:underline"
          >
            All open windows →
          </a>
        </div>
        <p className="mb-6 mt-1.5 text-sm text-ink-soft">
          Submitting a public comment is a constitutional right — free here, forever, no
          account required.
        </p>

        <div
          data-theme="terminal"
          className="overflow-hidden rounded-[10px] border border-term-line bg-term-bg text-term-txt shadow-[0_14px_34px_rgba(28,26,22,0.18)]"
        >
          <div className="flex items-center justify-between border-b border-term-line bg-term-panel px-4 py-3">
            <span className="font-mono text-[11.5px] font-bold uppercase tracking-[0.16em]">
              <span className="mr-2 text-amber">●</span>Closing soon
            </span>
            <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-term-green">
              <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-term-green motion-reduce:animate-none" />
              <span className="tabular-nums">
                {activeCount !== null && activeCount > 0
                  ? `${activeCount.toLocaleString("en-US")} active proposals`
                  : "Live"}
              </span>
            </span>
          </div>

          {proposals.length === 0 ? (
            <p className="px-4 py-6 text-sm text-term-dim">
              No open comment windows right now. Check back soon.
            </p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="border-b border-term-line px-4 py-2.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-term-faint">
                    Proposal
                  </th>
                  <th className="border-b border-term-line px-4 py-2.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-term-faint">
                    Agency
                  </th>
                  <th className="border-b border-term-line px-4 py-2.5 text-right font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-term-faint">
                    Closes
                  </th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => {
                  const days = daysLeft(p.comment_period_end, nowIso);
                  const agency = p.metadata?.agency_id ?? p.agency_name ?? "—";
                  return (
                    <tr key={p.id} className="group [&:last-child>td]:border-b-0">
                      <td className="border-b border-term-line px-4 py-3 text-[13px]">
                        <Link
                          href={`/proposals/${p.id}`}
                          className="font-semibold group-hover:text-amber transition-colors focus-visible:text-amber focus-visible:outline-none"
                        >
                          {p.title}
                        </Link>
                      </td>
                      <td className="max-w-[16rem] truncate border-b border-term-line px-4 py-3 text-[13px] text-term-dim">
                        {agency}
                      </td>
                      <td
                        className={`border-b border-term-line px-4 py-3 text-right font-mono text-[13px] font-bold tabular-nums ${closesTone(days)}`}
                      >
                        {days === null ? "—" : days === 0 ? "today" : `${days}d left`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
