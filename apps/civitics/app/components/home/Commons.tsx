import Link from "next/link";
import type { CommonsThread } from "./types";
import { SyntheticMark } from "../integrity/Synthetic";

// Relative "Nd ago" against the page's request-time nowIso. Both server and
// client receive the same nowIso, so the computed string matches at hydration
// (same pattern as ClosingSoonPanel's daysLeft).
function relativeTime(iso: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const CHIP =
  "inline-flex items-center border border-rule px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-soft";

/**
 * The Commons — homepage "discussion ledger". The most *bridging* root comment
 * threads across the whole public record (FIX-595), read MV-only from
 * commons_active_threads (FIX-594). Bridge-ranked, never trending. Paper
 * register, mirroring OfficialsLedger / ClosingSoonPanel.
 *
 * Sparse is a first-class state: entity_comments is near-zero today, so with
 * fewer than 3 threads we render a deliberate "just getting started" panel
 * rather than a broken 1–2 row grid (design decision 6).
 */
export function Commons({
  threads,
  nowIso,
}: {
  threads: CommonsThread[];
  nowIso: string;
}) {
  const sparse = threads.length < 3;

  return (
    <section className="border-b border-rule py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-accent">
          Where the record is debated
        </p>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-2xl font-bold text-ink sm:text-[27px]">The Commons</h2>
          <a
            href="/proposals?status=open"
            className="shrink-0 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-accent hover:underline"
          >
            Join the discussion →
          </a>
        </div>
        <p className="mb-6 mt-1.5 text-sm text-ink-soft">
          The most bridging threads across the public record — ranked by common ground, never by
          volume.
        </p>

        {sparse ? (
          <div className="border border-rule bg-paper-2 px-6 py-10 text-center">
            <p className="font-serif text-lg font-semibold text-ink">
              The Commons is just getting started.
            </p>
            <p className="mx-auto mt-1.5 max-w-[52ch] text-sm text-ink-soft">
              Public deliberation on proposals, officials, and the money behind them is opening up.
              Be among the first to put a reasoned comment on the record.
            </p>
            <a
              href="/proposals?status=open"
              className="mt-5 inline-block border-[1.5px] border-ink px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink transition-colors hover:bg-ink hover:text-paper"
            >
              Browse open proposals →
            </a>
          </div>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {threads.map((t) => (
              <li key={t.commentId} className="group py-4 hover:bg-paper-2">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className={CHIP}>{t.chip}</span>
                  {t.isQuestion && <span className={CHIP}>Q&amp;A</span>}
                  {t.isAnswered && (
                    <span className={`${CHIP} border-accent text-accent`}>Answered</span>
                  )}
                  {t.authorIsSynthetic && <SyntheticMark size="xs" />}
                  <span className="font-mono text-[10.5px] text-ink-soft/70">· {t.label}</span>
                </div>
                <Link
                  href={t.href}
                  className="block font-serif text-[16px] font-semibold leading-snug text-ink transition-colors group-hover:text-accent focus-visible:text-accent focus-visible:outline-none"
                >
                  {t.excerpt}
                </Link>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-ink-soft">
                  <span>
                    {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t.raterCount} {t.raterCount === 1 ? "rater" : "raters"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{relativeTime(t.lastActivityAt, nowIso)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
