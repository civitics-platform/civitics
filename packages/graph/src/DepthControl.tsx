"use client";

const DEPTHS = [1, 2, 3, 4, 5] as const;
const DEPTH_TOOLTIPS: Record<number, string> = {
  1: "Direct connections only",
  2: "Friends of friends",
  3: "Extended network",
  4: "Deep connections",
  5: "Full network (slow)",
};

export interface DepthControlProps {
  depth: number;
  onChange: (depth: number) => void;
}

export function DepthControl({ depth, onChange }: DepthControlProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 font-medium">Depth</span>
      <div className="flex items-center rounded-md overflow-hidden border border-gray-700">
        {DEPTHS.map((d) => (
          <button
            key={d}
            onClick={() => onChange(d)}
            title={DEPTH_TOOLTIPS[d]}
            className={`
              w-7 h-7 text-xs font-medium transition-colors
              ${d === depth
                ? "bg-indigo-600 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
              }
            `}
          >
            {d}
          </button>
        ))}
      </div>
      {depth >= 4 && (
        <span className="text-xs text-amber-500">Large graphs may load slowly</span>
      )}
    </div>
  );
}
