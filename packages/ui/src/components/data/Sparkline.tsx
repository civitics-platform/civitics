import * as React from "react";

interface SparklineProps {
  data: number[];
  color?: string;
  height?: number;
  width?: number;
  showArea?: boolean;
  /** Stroke weight of the trend line. FIX-090 stat cards use 2. */
  strokeWidth?: number;
  /**
   * FIX-090 — draw a filled dot on the final point, marking "you are here" so
   * the eye lands on the present value rather than reading the line as a range.
   */
  endDot?: boolean;
}

export function Sparkline({
  data,
  // Default follows the semantic civic-blue var so terminal scopes re-bind it;
  // callers can still pass any CSS color (FIX-719). On /dashboard that re-bind
  // is what makes this the terminal blue without the component ever naming a
  // term-* token, which packages/ui forbids.
  color = "rgb(var(--c-blue))",
  height = 32,
  width = 80,
  showArea = false,
  strokeWidth = 1.5,
  endDot = false,
}: SparklineProps) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  // Leave room for the end dot's radius so it is never clipped by the viewBox.
  const padding = endDot ? Math.max(2, strokeWidth + 1) : 2;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  const points = data.map((val, i) => {
    const x = padding + (i / (data.length - 1)) * innerWidth;
    const y = padding + innerHeight - ((val - min) / range) * innerHeight;
    return [x, y] as [number, number];
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`)
    .join(" ");

  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  const areaPath = [
    linePath,
    `L${lastPoint[0]},${height - padding}`,
    `L${firstPoint[0]},${height - padding}`,
    "Z",
  ].join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {/* Colors go through style= — var() isn't valid in SVG presentation
          attributes, but works as a CSS property. */}
      {showArea && (
        <path d={areaPath} style={{ fill: color }} fillOpacity={0.1} stroke="none" />
      )}
      <path d={linePath} fill="none" style={{ stroke: color }} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {endDot && (
        <circle cx={lastPoint[0]} cy={lastPoint[1]} r={strokeWidth} style={{ fill: color }} />
      )}
    </svg>
  );
}
