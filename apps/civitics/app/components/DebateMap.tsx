"use client";

// C1 Wave B (FIX-529): the §4.13 debate-map scatter.
//   x = map_x  (opposers ← → supporters,  -1..+1)
//   y = map_y  (one-sided ↓ cross-stance ↑, 0..+1)
// Dots colored/shaped by stance, sized by rating volume `n`. Clicking a dot
// asks the comment list to select + scroll to that comment (focusComment). The
// map is an ALTERNATE view of the same data the list already shows — never the
// only path to a comment (a11y: role="img" + summary; the list is the path).
//
// Inline SVG (no chart lib). Geographic choropleth + participant clustering are
// later phases — not here.

import { useEffect, useState } from "react";
import { focusComment } from "./comment-focus";
import type { EntityCommentType } from "@civitics/db";

type MapPoint = {
  id: string;
  map_x: number;
  map_y: number;
  bridge_score: number;
  stance: string | null;
  kind: string;
  n: number;
  snippet: string;
};

export interface DebateMapProps {
  entityType: EntityCommentType;
  entityId: string;
  lens: "all" | "constituents";
}

// Plot geometry (SVG user units).
const W = 400;
const H = 300;
const PAD_L = 40;
const PAD_R = 40;
const PAD_T = 24;
const PAD_B = 40;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const STANCE_FILL: Record<string, string> = {
  support: "#10b981", // emerald-500
  oppose: "#ef4444", // red-500
  conditional: "#f59e0b", // amber-500
  neutral: "#9ca3af", // gray-400
};
function fillFor(stance: string | null): string {
  return (stance && STANCE_FILL[stance]) || "#9ca3af";
}

function px(mapX: number): number {
  return PAD_L + ((mapX + 1) / 2) * PLOT_W; // -1 → left, +1 → right
}
function py(mapY: number): number {
  return PAD_T + (1 - mapY) * PLOT_H; // 1 → top, 0 → bottom
}
function radius(n: number): number {
  return 4 + (Math.min(n, 20) / 20) * 7; // 4..11
}

export function DebateMap({ entityType, entityId, lens }: DebateMapProps) {
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<MapPoint | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, lens });
    fetch(`/api/comments/map?${sp.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setPoints((data.points ?? []) as MapPoint[]);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load the map.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId, lens]);

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-400 shadow-sm">
        Loading the debate map…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (points.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-400 shadow-sm">
        The map appears once comments have enough ratings.
        <div className="mt-1 text-xs text-gray-400">
          A comment is plotted after at least 5 ratings with both sides weighing in.
        </div>
      </div>
    );
  }

  const summary =
    `Debate map: ${points.length} scored comment${points.length === 1 ? "" : "s"}. ` +
    `Horizontal axis is endorser lean from opposers (left) to supporters (right); ` +
    `vertical axis is how cross-stance the support is, from one-sided (bottom) to ` +
    `valued by both sides (top). The same comments are listed below.`;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={summary}
          onMouseLeave={() => setHover(null)}
        >
          <title>{summary}</title>

          {/* Plot frame */}
          <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} fill="#fafafa" stroke="#e5e7eb" />
          {/* Center vertical (map_x = 0) */}
          <line x1={px(0)} y1={PAD_T} x2={px(0)} y2={PAD_T + PLOT_H} stroke="#e5e7eb" strokeDasharray="3 3" />
          {/* High-bridge band (map_y >= 0.6) */}
          <line
            x1={PAD_L}
            y1={py(0.6)}
            x2={PAD_L + PLOT_W}
            y2={py(0.6)}
            stroke="#c7d2fe"
            strokeDasharray="2 4"
          />

          {/* Zone labels */}
          <text x={W / 2} y={PAD_T - 9} textAnchor="middle" className="fill-indigo-500" fontSize="9" fontWeight="600">
            Common ground
          </text>
          <text x={PAD_L + 4} y={PAD_T + PLOT_H + 14} textAnchor="start" className="fill-red-500" fontSize="8">
            ◄ Opposers’ rallying cry
          </text>
          <text x={PAD_L + PLOT_W - 4} y={PAD_T + PLOT_H + 14} textAnchor="end" className="fill-emerald-600" fontSize="8">
            Supporters’ rallying cry ►
          </text>
          <text x={W / 2} y={PAD_T + PLOT_H + 26} textAnchor="middle" className="fill-gray-400" fontSize="8">
            ← opposers · supporters →
          </text>
          {/* y-axis hints */}
          <text x={10} y={py(0.97)} className="fill-gray-400" fontSize="8" transform={`rotate(-90 10 ${py(0.97)})`} textAnchor="start">
            cross-stance ↑
          </text>
          <text x={10} y={py(0.03)} className="fill-gray-400" fontSize="8" transform={`rotate(-90 10 ${py(0.03)})`} textAnchor="end">
            one-sided ↓
          </text>

          {/* Dots */}
          {points.map((p) => (
            <circle
              key={p.id}
              cx={px(p.map_x)}
              cy={py(p.map_y)}
              r={radius(p.n)}
              fill={fillFor(p.stance)}
              fillOpacity={0.65}
              stroke={fillFor(p.stance)}
              strokeWidth={1}
              className="cursor-pointer transition-opacity hover:fill-opacity-90"
              onMouseEnter={() => setHover(p)}
              onClick={() => focusComment(p.id)}
            >
              <title>{p.snippet}</title>
            </circle>
          ))}
        </svg>

        {hover && (
          <div className="pointer-events-none absolute left-2 top-2 max-w-[70%] rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-[11px] text-gray-700 shadow">
            <span className="font-medium capitalize">{hover.stance ?? "discussion"}</span>
            {" · "}
            <span className="tabular-nums text-gray-400">bridge {hover.bridge_score.toFixed(2)}</span>
            <div className="mt-0.5 text-gray-600">{hover.snippet}</div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-gray-500">
        {(["support", "oppose", "conditional", "neutral"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: STANCE_FILL[s] }} />
            <span className="capitalize">{s}</span>
          </span>
        ))}
        <span className="text-gray-400">· dot size = rating volume · click a dot to read it</span>
      </div>
    </div>
  );
}
