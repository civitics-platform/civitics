/**
 * FranklinBand — homepage discoverability entry for the State of Franklin
 * demonstration jurisdiction (FIX-616, PR A). A paper-mode module dropped among
 * the existing homepage sections: an amber "demonstration" tag + the Portico mark
 * signal it is the sandbox; the button is the discoverability fix that points at
 * the /franklin hub.
 *
 * Pure presentational server component — no data fetch, no fabricated counts.
 */
import { PorticoMark } from "../brand/PorticoMark";
import { StampMark } from "../brand/StampMark";

export function FranklinBand() {
  return (
    <section className="border-b border-rule bg-paper-2">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-5 border-[1.5px] border-dashed border-amber/70 bg-amber/10 px-6 py-6 sm:flex-row sm:items-center">
          <div className="flex-1">
            <span className="inline-flex items-center gap-1.5 rounded-[2px] border-[1.5px] border-dashed border-amber/70 bg-amber/25 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink">
              <StampMark size={11} />
              Demonstration · populated by AI
            </span>
            <div className="mt-2.5 flex items-center gap-2.5">
              <span className="text-ink">
                <PorticoMark size={30} />
              </span>
              <h2 className="font-serif text-2xl font-semibold text-ink">
                Visit the State of Franklin
              </h2>
            </div>
            <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-ink-soft">
              A fictional 14th state where every Civitics feature is populated — explore
              officials, bills, money trails, investigations and Q&amp;A in one place. Clearly
              labeled; nothing here is real civic data.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
            <a
              href="/franklin"
              className="border-[1.5px] border-ink bg-ink px-5 py-2.5 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-paper transition-colors hover:bg-accent hover:border-accent"
            >
              Take the tour →
            </a>
            <span className="font-mono text-[11px] text-ink-soft">
              Cost to you: <span className="font-semibold text-green-ink">$0.00 — always</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
