/**
 * Graph ink band — full-bleed ink section pointing at the connection graph,
 * with a faint decorative network in the corner.
 */
export function GraphBand() {
  return (
    <div className="relative overflow-hidden bg-ink py-12 text-paper">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute -top-[70px] right-[-30px] opacity-[0.16]"
        width="560"
        height="420"
        viewBox="0 0 560 420"
        fill="none"
      >
        <g stroke="var(--c-paper)" strokeWidth="1">
          <line x1="60" y1="80" x2="220" y2="160" />
          <line x1="220" y1="160" x2="380" y2="90" />
          <line x1="220" y1="160" x2="300" y2="300" />
          <line x1="380" y1="90" x2="500" y2="200" />
          <line x1="300" y1="300" x2="500" y2="200" />
          <line x1="60" y1="80" x2="140" y2="280" />
          <line x1="140" y1="280" x2="300" y2="300" />
          <line x1="380" y1="90" x2="300" y2="300" />
        </g>
        <g fill="var(--c-paper)">
          <circle cx="60" cy="80" r="7" />
          <circle cx="220" cy="160" r="11" />
          <circle cx="380" cy="90" r="8" />
          <circle cx="500" cy="200" r="9" />
          <circle cx="300" cy="300" r="12" />
          <circle cx="140" cy="280" r="6" />
        </g>
      </svg>
      <div className="relative mx-auto flex max-w-7xl flex-col gap-6 px-4 sm:flex-row sm:items-center sm:justify-between sm:gap-10 sm:px-6 lg:px-8">
        <div>
          <h2 className="font-serif text-3xl font-semibold italic">Follow the money.</h2>
          <p className="mt-2 max-w-[54ch] text-sm leading-relaxed text-[#b8b2a4]">
            Officials, agencies, donors, and legislation — every connection in the public
            record, drawn as a live graph.
          </p>
        </div>
        <a
          href="/graph"
          className="shrink-0 self-start border border-paper px-6 py-3 text-xs font-semibold uppercase tracking-[0.08em] transition-colors hover:bg-paper hover:text-ink sm:self-auto"
        >
          Open the graph →
        </a>
      </div>
    </div>
  );
}
