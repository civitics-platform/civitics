"use client";

// Animated ghost graph — shown while entity_connections pipeline is running.
// SVG only, no data, pure CSS animation.

interface GhostGraphProps {
  className?: string;
}

// Static node positions spread across the canvas
const GHOST_NODES = [
  { cx: "22%",  cy: "35%", r: 26, shape: "circle" },
  { cx: "45%",  cy: "20%", r: 20, shape: "rect"   },
  { cx: "68%",  cy: "30%", r: 26, shape: "circle" },
  { cx: "78%",  cy: "55%", r: 20, shape: "rect"   },
  { cx: "55%",  cy: "65%", r: 18, shape: "diamond" },
  { cx: "30%",  cy: "62%", r: 26, shape: "circle" },
  { cx: "15%",  cy: "55%", r: 16, shape: "rect"   },
  { cx: "60%",  cy: "45%", r: 20, shape: "circle" },
  { cx: "40%",  cy: "75%", r: 16, shape: "diamond" },
] as const;

// Edges between ghost nodes (by index pairs)
const GHOST_EDGES = [
  [0, 1], [1, 2], [2, 7], [7, 3],
  [0, 5], [5, 6], [5, 4], [4, 7],
  [1, 7], [3, 4], [4, 8], [5, 8],
] as const;

export function GhostGraph({ className }: GhostGraphProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 1000 600"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <style>{`
        @keyframes ghost-pulse {
          0%,100% { opacity: 0.15; }
          50%      { opacity: 0.45; }
        }
        @keyframes ghost-line {
          0%,100% { stroke-opacity: 0.08; }
          50%      { stroke-opacity: 0.25; }
        }
        .gn { animation: ghost-pulse 3s ease-in-out infinite; }
        .gn:nth-child(2) { animation-delay: 0.4s; }
        .gn:nth-child(3) { animation-delay: 0.8s; }
        .gn:nth-child(4) { animation-delay: 1.2s; }
        .gn:nth-child(5) { animation-delay: 1.6s; }
        .gn:nth-child(6) { animation-delay: 2.0s; }
        .gn:nth-child(7) { animation-delay: 2.4s; }
        .gn:nth-child(8) { animation-delay: 2.8s; }
        .gn:nth-child(9) { animation-delay: 3.2s; }
        .ge { animation: ghost-line 3s ease-in-out infinite; }
        .ge:nth-child(even) { animation-delay: 1.5s; }
      `}</style>

      {/* Ghost edges */}
      {GHOST_EDGES.map(([a, b], i) => {
        const na = GHOST_NODES[a];
        const nb = GHOST_NODES[b];
        // Convert percentage strings to numeric coords in viewBox
        const x1 = parseFloat(na.cx) * 10;
        const y1 = parseFloat(na.cy) * 6;
        const x2 = parseFloat(nb.cx) * 10;
        const y2 = parseFloat(nb.cy) * 6;
        return (
          <line
            key={i}
            className="ge"
            x1={x1} y1={y1} x2={x2} y2={y2}
            style={{ stroke: "rgb(var(--c-term-faint))" }}
            strokeWidth="1.5"
            strokeDasharray="6 4"
          />
        );
      })}

      {/* Ghost nodes */}
      {GHOST_NODES.map((n, i) => {
        const cx = parseFloat(n.cx) * 10;
        const cy = parseFloat(n.cy) * 6;
        const r = n.r;
        return (
          <g key={i} className="gn">
            {n.shape === "circle" && (
              <circle cx={cx} cy={cy} r={r} style={{ fill: "rgb(var(--c-term-panel))", stroke: "rgb(var(--c-term-line))" }} strokeWidth="2" />
            )}
            {n.shape === "rect" && (
              <rect
                x={cx - r * 1.4} y={cy - r * 0.75}
                width={r * 2.8} height={r * 1.5}
                rx="5"
                style={{ fill: "rgb(var(--c-term-panel))", stroke: "rgb(var(--c-term-line))" }} strokeWidth="2"
              />
            )}
            {n.shape === "diamond" && (
              <path
                d={`M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`}
                style={{ fill: "rgb(var(--c-term-panel))", stroke: "rgb(var(--c-term-line))" }} strokeWidth="2"
              />
            )}
            {/* Ghost label bar */}
            <rect
              x={cx - r * 0.9} y={cy + r + 6}
              width={r * 1.8} height={5}
              rx="2" style={{ fill: "rgb(var(--c-term-panel))" }}
            />
          </g>
        );
      })}
    </svg>
  );
}
