import { formatStatCompact, type HomeStats } from "./types";

/**
 * Terminal stat ticker — the dark instrument strip under the masthead.
 * Pure CSS marquee (two copies of the track, translateX(-50%) loop, keyframes
 * in globals.css); motion-reduce:animate-none leaves a static strip.
 */
export function Ticker({ stats }: { stats: HomeStats }) {
  const items: { label: string; value: string; accent?: boolean }[] = [
    { label: "OFFICIALS",        value: stats.officials > 0 ? formatStatCompact(stats.officials) : "—" },
    { label: "PROPOSALS",        value: stats.proposals > 0 ? formatStatCompact(stats.proposals) : "—" },
    { label: "DONOR RECORDS",    value: stats.donors    > 0 ? formatStatCompact(stats.donors)    : "—" },
    { label: "SPENDING RECORDS", value: stats.spending  > 0 ? formatStatCompact(stats.spending)  : "—" },
    { label: "COMMENT FEE",      value: "$0.00 — ALWAYS", accent: true },
  ];

  const track = (ariaHidden: boolean) => (
    <span aria-hidden={ariaHidden || undefined} className="inline-block">
      {items.map((item) => (
        <span
          key={item.label}
          className="mx-6 font-mono text-xs font-medium text-term-faint"
        >
          {item.label}{" "}
          <b
            className={`font-semibold tabular-nums ${
              item.accent ? "text-term-green" : "text-term-txt"
            }`}
          >
            {item.value}
          </b>
        </span>
      ))}
    </span>
  );

  return (
    <div className="overflow-hidden whitespace-nowrap border-b border-rule bg-term-bg py-2">
      <div className="inline-flex animate-[ticker-scroll_36s_linear_infinite] motion-reduce:animate-none">
        {track(false)}
        {track(true)}
      </div>
    </div>
  );
}
