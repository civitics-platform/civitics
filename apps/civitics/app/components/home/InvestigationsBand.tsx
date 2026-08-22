import Link from "next/link";
import type { HomeInvestigation } from "../../investigations/_lib/load";
import { SyntheticMark } from "../integrity/Synthetic";

/**
 * InvestigationsBand — homepage "cited case files" module (FIX-711). The
 * 2026-06-11 mockup carried an Investigations block; it's live now at
 * /investigations and Franklin seeded real case files, so it renders content
 * rather than an empty promise. Paper register, mirroring OfficialsLedger /
 * Commons: mono kicker, header + "all →" affordance, one-line description, a
 * capped card grid.
 *
 * Synthetic case files (Franklin's seeded files) are SHOWN and labeled with the
 * SYNTHETIC mark (SF-P2, FIX-599) — never excluded, never laundered.
 *
 * Pure presentational server component — the fetch lives in app/page.tsx.
 */

const CHIP =
  "inline-flex items-center border px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em]";

const STATUS_CHIP: Record<HomeInvestigation["status"], string> = {
  open: "border-amber/60 bg-amber/20 text-ink",
  closed: "border-rule bg-ink/5 text-ink-soft",
  archived: "border-rule bg-ink/5 text-ink-soft",
};

const STATUS_LABEL: Record<HomeInvestigation["status"], string> = {
  open: "Open",
  closed: "Closed",
  archived: "Archived",
};

export function InvestigationsBand({ items }: { items: HomeInvestigation[] }) {
  return (
    <section className="border-b border-rule py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-accent">
          Cited case files
        </p>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl font-bold text-ink sm:text-[27px]">
            Investigations
          </h2>
          <a
            href="/investigations"
            className="shrink-0 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-accent hover:underline"
          >
            All case files →
          </a>
        </div>
        <p className="mb-6 mt-1.5 text-sm text-ink-soft">
          Community case files built on the record — no claim without a citation.
        </p>

        {items.length === 0 ? (
          <p className="text-sm text-ink-soft">No case files on the record yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2">
            {items.map((inv) => (
              <div key={inv.id} className="group relative flex flex-col bg-paper p-5 hover:bg-paper-2">
                {/* Overlay sits ABOVE the static content so the card body is
                    clickable (FIX-1086). Nothing here is interactive, so no
                    child needs raising back above it. */}
                <Link
                  href={`/investigations/${inv.id}`}
                  className="absolute inset-0 z-10"
                  aria-label={inv.title}
                />
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className={`${CHIP} ${STATUS_CHIP[inv.status]}`}>
                    {STATUS_LABEL[inv.status]}
                  </span>
                  {inv.isSynthetic && <SyntheticMark size="xs" />}
                </div>
                <h3 className="font-serif text-[16px] font-semibold leading-snug text-ink transition-colors group-hover:text-accent">
                  {inv.title}
                </h3>
                {inv.summary && (
                  <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink-soft">
                    {inv.summary}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-ink-soft">
                  <span>
                    {inv.evidenceCount} {inv.evidenceCount === 1 ? "evidence card" : "evidence cards"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {inv.citationCount} {inv.citationCount === 1 ? "citation" : "citations"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
