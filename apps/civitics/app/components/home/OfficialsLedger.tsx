import Link from "next/link";
import type { HomeOfficialCardData } from "./types";

const PARTY_SQUARE: Record<string, string> = {
  democrat:   "bg-civic-blue",
  republican: "bg-accent",
};

function formatMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  if (dollars > 0) return `$${dollars.toLocaleString("en-US")}`;
  return "—";
}

function seat(o: HomeOfficialCardData): string {
  const where = [o.state_name, o.district_name].filter(Boolean).join(" · ");
  return where ? `${o.role_title} — ${where}` : o.role_title;
}

/**
 * The officials ledger — paper-mode accountability table. Same top-officials
 * data the old card grid showed (votes / donors / raised); no Q&A column
 * (doesn't exist yet). Party reads as a small red/blue square, never a wash.
 */
export function OfficialsLedger({
  officials,
  totalOfficials,
}: {
  officials: HomeOfficialCardData[];
  /** FIX-1070 — null means the hero-stats read did not complete. */
  totalOfficials: number | null;
}) {
  return (
    <section className="border-b border-rule py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-accent">
          On the record
        </p>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl font-bold text-ink sm:text-[27px]">The ledger</h2>
          <a
            href="/officials"
            className="shrink-0 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-accent hover:underline"
          >
            {totalOfficials !== null && totalOfficials > 0
              ? `All ${totalOfficials.toLocaleString("en-US")} officials →`
              : "All officials →"}
          </a>
        </div>
        <p className="mb-5 mt-1.5 text-sm text-ink-soft">
          Votes, donors, and money on the record — most active officials this session.
        </p>

        {officials.length === 0 ? (
          <p className="text-sm text-ink-soft">Officials data unavailable right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Official", "Seat"].map((h) => (
                    <th
                      key={h}
                      className="border-b-2 border-ink px-3.5 py-2 text-left font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-soft"
                    >
                      {h}
                    </th>
                  ))}
                  {["Votes", "Donors", "Raised"].map((h) => (
                    <th
                      key={h}
                      className="border-b-2 border-ink px-3.5 py-2 text-right font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-soft"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {officials.map((o) => (
                  <tr key={o.id} className="group hover:bg-paper-2">
                    <td className="border-b border-rule px-3.5 py-3.5">
                      <span
                        aria-hidden="true"
                        className={`mr-2.5 inline-block h-[9px] w-[9px] ${PARTY_SQUARE[o.party ?? ""] ?? "bg-rule"}`}
                        title={o.party ?? undefined}
                      />
                      <Link
                        href={`/officials/${o.id}`}
                        className="font-serif text-[15.5px] font-semibold text-ink group-hover:text-accent transition-colors focus-visible:text-accent focus-visible:outline-none"
                      >
                        {o.full_name}
                      </Link>
                    </td>
                    <td className="border-b border-rule px-3.5 py-3.5 text-[12.5px] text-ink-soft">
                      {seat(o)}
                    </td>
                    <td className="border-b border-rule px-3.5 py-3.5 text-right font-mono text-[13px] tabular-nums text-ink">
                      {o.voteCount > 0 ? o.voteCount.toLocaleString("en-US") : "—"}
                    </td>
                    <td className="border-b border-rule px-3.5 py-3.5 text-right font-mono text-[13px] tabular-nums text-ink">
                      {o.donorCount > 0 ? o.donorCount.toLocaleString("en-US") : "—"}
                    </td>
                    <td className="border-b border-rule px-3.5 py-3.5 text-right font-mono text-[13px] font-bold tabular-nums text-ink">
                      {formatMoney(o.totalDonationsCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
