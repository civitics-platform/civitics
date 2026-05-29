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

// Outline / fill / marker per jurisdiction_type. Falls back to slate.
const TYPE_PALETTE: Record<string, { stroke: string; fill: string }> = {
  state: { stroke: "#2563eb", fill: "#dbeafe" }, // blue
  county: { stroke: "#16a34a", fill: "#dcfce7" }, // green
  city: { stroke: "#d97706", fill: "#fef3c7" }, // amber
  district: { stroke: "#9333ea", fill: "#f3e8ff" }, // purple
  school_district: { stroke: "#9333ea", fill: "#f3e8ff" },
  special_district: { stroke: "#0d9488", fill: "#ccfbf1" }, // teal
  federal_district: { stroke: "#dc2626", fill: "#fee2e2" }, // red
  unincorporated_territory: { stroke: "#4f46e5", fill: "#e0e7ff" }, // indigo
  country: { stroke: "#475569", fill: "#e2e8f0" }, // slate
};

export function BoundarySvg({ data, type }: { data: BoundarySvgData; type: string }) {
  const palette = TYPE_PALETTE[type] ?? { stroke: "#475569", fill: "#e2e8f0" };
  // Marker radius scales with the viewBox so it stays visible at any extent.
  const [, , w] = data.viewbox.split(" ").map(Number);
  const r = (w || 1) * 0.012;

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
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
          fill={palette.fill}
          stroke={palette.stroke}
          strokeWidth={(w || 1) * 0.002}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={data.centroid_x}
          cy={data.centroid_y}
          r={r}
          fill={palette.stroke}
          stroke="#ffffff"
          strokeWidth={r * 0.4}
        />
      </svg>
    </div>
  );
}
