import Link from "next/link";
import type { AgencyRow } from "../../agencies/page";

/**
 * Agencies row — compact paper-card grid in the record style. Same agency
 * rows + proposal counts the old AgencyCard grid showed, restyled for the
 * homepage only (the full AgencyCard keeps serving /agencies).
 */
export function AgenciesRow({ agencies }: { agencies: AgencyRow[] }) {
  return (
    <section className="border-b border-rule py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-accent">
          The executive record
        </p>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl font-bold text-ink sm:text-[27px]">Agencies</h2>
          <a
            href="/agencies"
            className="shrink-0 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-accent hover:underline"
          >
            All agencies →
          </a>
        </div>
        <p className="mb-6 mt-1.5 text-sm text-ink-soft">
          Federal agencies, their active rulemaking, and open comment periods.
        </p>

        {agencies.length === 0 ? (
          <p className="text-sm text-ink-soft">Agency data unavailable right now.</p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {agencies.map((a) => (
              <Link
                key={a.id}
                href={`/agencies/${a.id}`}
                className="group flex flex-col border border-rule bg-card p-5 shadow-[0_1px_0_rgb(var(--c-rule))] transition-colors hover:border-accent focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
              >
                <span className="w-fit border border-rule bg-paper-2 px-2 py-1 font-mono text-[11px] font-bold text-ink">
                  {(a.acronym ?? a.short_name ?? a.name).slice(0, 5).toUpperCase()}
                </span>
                <span className="mt-3 line-clamp-2 text-sm font-semibold leading-snug text-ink group-hover:text-accent transition-colors">
                  {a.name}
                </span>
                <span className="mt-auto flex items-baseline justify-between gap-2 pt-4 font-mono text-[11px] tabular-nums text-ink-soft">
                  <span>{a.totalProposals > 0 ? `${a.totalProposals.toLocaleString("en-US")} rules` : "—"}</span>
                  <span className={a.openProposals > 0 ? "font-bold text-accent" : ""}>
                    {a.openProposals > 0 ? `${a.openProposals.toLocaleString("en-US")} open` : "0 open"}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
