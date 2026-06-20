// FIX-621: the Commons strip for HB-14 — top bridge-scored comment, the
// where-people-stand bar, and upcoming public meetings.
//
// All three are READS of existing display surfaces: the top comment by bridge_score
// off entity_comments; the position distribution off get_position_rollup_display
// (the FIX-614 display seam — an authored, display-only rollup for the synthetic
// entity, no live recompute, confers no standing); and upcoming meetings (none are
// seeded for Franklin today, so that panel is omitted rather than faked).
import Link from "next/link";
import { SyntheticMark } from "../../components/integrity/Synthetic";
import { MeetingCard, type MeetingCardData } from "../../components/cards/MeetingCard";

export type CommonsPosition = {
  oppose: number;
  mixed: number;
  support: number;
  n: number;
  synthetic: boolean;
};

export function CommonsStrip({
  topComment,
  commentTotal,
  position,
  proposalHref,
  meetings,
}: {
  topComment: { body: string; bridgeScore: number | null } | null;
  commentTotal: number;
  position: CommonsPosition | null;
  proposalHref: string;
  meetings: MeetingCardData[];
}) {
  const panels: React.ReactNode[] = [];

  if (topComment) {
    panels.push(
      <div key="comment" className="flex h-full flex-col border border-rule bg-card p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-soft/70">
          Top bridge comment · HB-14 <SyntheticMark size="xs" />
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink">“{trim(topComment.body, 200)}”</p>
        <div className="mt-auto pt-3 flex items-center justify-between font-mono text-[11px] text-ink-soft">
          {topComment.bridgeScore != null ? (
            <span className="text-civic-blue">bridge {topComment.bridgeScore.toFixed(2)} · crosses blocs</span>
          ) : (
            <span />
          )}
          <Link href={proposalHref} className="text-accent hover:underline">
            {commentTotal > 0 ? `${commentTotal} comments →` : "Read the thread →"}
          </Link>
        </div>
      </div>
    );
  }

  if (position && position.n > 0) {
    const total = position.oppose + position.mixed + position.support || 1;
    const pct = (x: number) => Math.round((x / total) * 100);
    panels.push(
      <div key="stand" className="flex h-full flex-col border border-rule bg-card p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-soft/70">
          Where people stand · HB-14 {position.synthetic && <SyntheticMark size="xs" />}
        </p>
        <div className="mt-3 flex h-3 overflow-hidden rounded-sm border border-rule" aria-hidden>
          <span className="block bg-accent" style={{ width: `${pct(position.oppose)}%` }} />
          <span className="block bg-ink/20" style={{ width: `${pct(position.mixed)}%` }} />
          <span className="block bg-green-ink" style={{ width: `${pct(position.support)}%` }} />
        </div>
        <p className="mt-2 font-mono text-[11px] text-ink-soft">
          <span className="text-accent">oppose {pct(position.oppose)}%</span> ·{" "}
          mixed {pct(position.mixed)}% ·{" "}
          <span className="text-green-ink">support {pct(position.support)}%</span>
        </p>
        <p className="mt-auto pt-2 font-mono text-[11px] text-ink-soft/70">
          {position.n} positions recorded
        </p>
      </div>
    );
  }

  if (meetings.length > 0) {
    panels.push(
      <div key="meetings" className="flex h-full flex-col gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-soft/70">
          Public meetings
        </p>
        {meetings.map((m) => (
          <MeetingCard key={m.id} meeting={m} />
        ))}
      </div>
    );
  }

  if (panels.length === 0) return null;

  return <div className="grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3">{panels}</div>;
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}
