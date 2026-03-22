import * as React from "react";
import { formatUSD } from "../../utils";

interface ConnectionHighlightProps {
  from: string;
  fromType?: "industry" | "official";
  to: string;
  toType?: "party" | "official";
  amountUsd: number;
  graphHref?: string;
}

export function ConnectionHighlight({
  from,
  to,
  amountUsd,
  graphHref,
}: ConnectionHighlightProps) {
  const formatted = formatUSD(amountUsd * 100, { compact: true });

  return (
    <div className="flex items-center gap-2 py-2">
      <span className="text-sm font-medium text-gray-900 truncate max-w-[30%]">
        {from}
      </span>
      <span className="text-gray-400 shrink-0">→</span>
      <span className="text-sm font-medium text-gray-900 truncate max-w-[30%]">
        {to}
      </span>
      <span className="ml-auto text-sm font-semibold tabular-nums text-gray-700 shrink-0">
        {formatted}
      </span>
      {graphHref && (
        <a
          href={graphHref}
          className="shrink-0 text-sm text-blue-600 hover:text-blue-700 transition-colors duration-150"
          aria-label="View in graph"
        >
          →
        </a>
      )}
    </div>
  );
}
