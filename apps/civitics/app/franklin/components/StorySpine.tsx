// FIX-621: the "Follow HB-14" narrative spine, rendered from records the page
// resolved live off `FRANKLIN_SPINE` (apps/civitics/app/franklin/spine.ts).
// Presentational only — every `value`/`detail` here was queried, never hardcoded.
// Mirrors the layout reference's "Follow HB-14 all the way through" thread block
// (paper mode; no terminal accents — this is narrative, not a live instrument).
import Link from "next/link";
import { SyntheticMark } from "../../components/integrity/Synthetic";

export type ResolvedStop = {
  id: string;
  kicker: string;
  /** Live headline value (e.g. "Passed 6–4", "Open for comment", a title). */
  value: string;
  /** Optional live secondary fact (e.g. "12 evidence cards"). */
  detail?: string | null;
  connective: string;
  cta: string;
  href: string;
};

export function StorySpine({
  billLabel,
  billTitle,
  stops,
}: {
  billLabel: string;
  billTitle: string;
  stops: ResolvedStop[];
}) {
  if (stops.length === 0) return null;
  return (
    <div className="border border-rule bg-card p-5">
      <div className="flex items-center gap-2">
        <h3 className="font-serif text-xl font-semibold text-ink">
          {billLabel} — {billTitle}
        </h3>
        <SyntheticMark size="xs" />
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        One bill, threaded through every surface. Follow it one stop at a time.
      </p>

      <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {stops.map((s, i) => (
          // id is the A2 guided-tour scroll+highlight target (GuidedTour.tsx);
          // scroll-mt keeps the card clear of the top chrome when scrolled to.
          <li key={s.id} id={`tour-stop-${s.id}`} className="relative scroll-mt-24">
            <Link
              href={s.href}
              className="group flex h-full flex-col border border-rule bg-paper p-3.5 transition-colors hover:border-accent"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] tabular-nums text-ink-soft/50">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
                  {s.kicker}
                </span>
              </div>
              <p className="mt-1.5 font-serif text-base font-semibold leading-snug text-ink">
                {s.value}
              </p>
              {s.detail && (
                <p className="mt-0.5 font-mono text-[11px] text-ink-soft/80">{s.detail}</p>
              )}
              <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">{s.connective}</p>
              <span className="mt-auto pt-2.5 font-mono text-[11px] text-accent group-hover:underline">
                {s.cta} →
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
