import Link from "next/link";
import type { AgencyRow } from "../page";

export function WhiteHouseFeaturedCard({ agency }: { agency: AgencyRow }) {
  return (
    <div className="relative overflow-hidden border-2 border-accent bg-gradient-to-r from-accent/10 via-card to-civic-blue/10 p-5 shadow-sm">
      {/* Subtle decorative ring */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full border border-accent/10 opacity-40"
      />

      <div className="flex items-start gap-4">
        {/* Seal placeholder */}
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-accent bg-card font-mono text-base font-bold text-accent shadow-sm">
          {(agency.acronym ?? agency.name.slice(0, 3)).slice(0, 4)}
        </div>

        <div className="flex-1 min-w-0">
          <span className="inline-block rounded border border-accent bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
            Featured
          </span>
          <h2 className="mt-0.5 text-base font-bold text-ink">{agency.name}</h2>
          {agency.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-soft/70">
              {agency.description}
            </p>
          )}
        </div>

        <Link
          href={`/agencies/${agency.id}`}
          className="shrink-0 rounded-lg border border-accent bg-card px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/10 transition-colors shadow-sm"
        >
          View profile →
        </Link>
      </div>

      {/* Stats strip */}
      <div className="mt-4 flex items-center gap-6">
        <div>
          <span className="text-sm font-bold text-ink">
            {agency.totalProposals > 0 ? agency.totalProposals.toLocaleString() : "—"}
          </span>
          <span className="ml-1.5 text-xs text-ink-soft/70">total rules</span>
        </div>
        {agency.openProposals > 0 && (
          <div>
            <span className="text-sm font-bold text-green-ink">
              {agency.openProposals.toLocaleString()}
            </span>
            <span className="ml-1.5 text-xs text-ink-soft/70">open now</span>
          </div>
        )}
      </div>
    </div>
  );
}
