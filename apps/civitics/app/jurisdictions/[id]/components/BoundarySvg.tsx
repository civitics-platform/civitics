// Pure presentational static map. The SVG path + viewBox + centroid come from
// the jurisdiction_boundary_svg RPC (server-rendered — no Mapbox JS on this
// route). ST_AsSVG already negates Y, and the RPC negates the centroid to
// match, so everything composes in one SVG coordinate space.
export type BoundarySvgData = {
  svg_path: string;
  viewbox: string;
  centroid_x: number;
  centroid_y: number;
};

// Outline / fill / marker per jurisdiction_type. SVG presentation attributes
// can't consume Tailwind alpha tokens, so colors are token-backed CSS custom
// properties in rgb(var(--c-…)) form. Per-type distinction lives on the stroke
// (semantic + categorical viz tokens); fills use the neutral paper-2 surface.
// Falls back to the ink-soft rule tone.
const TYPE_PALETTE: Record<string, { stroke: string; fill: string }> = {
  state: { stroke: "rgb(var(--c-blue))", fill: "rgb(var(--c-paper-2))" },
  county: { stroke: "rgb(var(--c-green-ink))", fill: "rgb(var(--c-paper-2))" },
  city: { stroke: "rgb(var(--c-viz-3))", fill: "rgb(var(--c-paper-2))" },
  district: { stroke: "rgb(var(--c-viz-7))", fill: "rgb(var(--c-paper-2))" },
  school_district: { stroke: "rgb(var(--c-viz-7))", fill: "rgb(var(--c-paper-2))" },
  special_district: { stroke: "rgb(var(--c-viz-2))", fill: "rgb(var(--c-paper-2))" },
  federal_district: { stroke: "rgb(var(--c-accent))", fill: "rgb(var(--c-paper-2))" },
  unincorporated_territory: { stroke: "rgb(var(--c-accent))", fill: "rgb(var(--c-paper-2))" },
  country: { stroke: "rgb(var(--c-ink-soft))", fill: "rgb(var(--c-paper-2))" },
};

export function BoundarySvg({ data, type }: { data: BoundarySvgData; type: string }) {
  const palette =
    TYPE_PALETTE[type] ?? { stroke: "rgb(var(--c-ink-soft))", fill: "rgb(var(--c-paper-2))" };
  // Marker radius scales with the viewBox so it stays visible at any extent.
  const [, , w] = data.viewbox.split(" ").map(Number);
  const r = (w || 1) * 0.012;

  return (
    <div className="overflow-hidden border border-rule bg-card">
      <svg
        viewBox={data.viewbox}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Jurisdiction boundary"
        className="block h-auto w-full"
        style={{ maxHeight: 360 }}
      >
        <path
          d={data.svg_path}
          style={{ fill: palette.fill, stroke: palette.stroke }}
          strokeWidth={(w || 1) * 0.002}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={data.centroid_x}
          cy={data.centroid_y}
          r={r}
          style={{ fill: palette.stroke }}
          stroke="#ffffff"
          strokeWidth={r * 0.4}
        />
      </svg>
    </div>
  );
}
