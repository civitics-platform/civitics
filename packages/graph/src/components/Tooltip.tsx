"use client";

/**
 * packages/graph/src/components/Tooltip.tsx
 *
 * Shared hover tooltip used by all viz types.
 * Positioned absolutely relative to the graph canvas container.
 * Import useTooltip for state management alongside this component.
 */

import { useState } from 'react';
import type { GraphNode } from '../types';

export interface TooltipProps {
  node: GraphNode | null;
  x: number;
  y: number;
  visible: boolean;
  /** Width of the containing element (px). Used to flip tooltip when near right edge. */
  containerWidth?: number;
}

export function Tooltip({ node, x, y, visible, containerWidth }: TooltipProps) {
  if (!visible || !node) return null;

  const TOOLTIP_W = 220;
  const boundary = containerWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1024);
  const safeX = Math.min(x + 12, boundary - TOOLTIP_W - 8);
  const safeY = Math.min(y - 8, (typeof window !== 'undefined' ? window.innerHeight : 800) - 100);

  return (
    <div
      className="absolute z-50 pointer-events-none bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-sm max-w-[240px]"
      style={{
        left: safeX,
        top: safeY,
      }}
    >
      {/* Name — bold */}
      <div className="font-semibold text-gray-900 leading-tight">
        {node.name}
      </div>

      {/* Subtitle — role/type */}
      {(node.role || node.party) && (
        <div className="text-gray-500 text-xs mt-0.5">
          {node.role}
          {node.party && (
            <span
              className={
                node.party === 'democrat'
                  ? 'text-blue-600'
                  : node.party === 'republican'
                  ? 'text-red-600'
                  : 'text-purple-600'
              }
            >
              {node.role ? ' · ' : ''}
              {node.party.charAt(0).toUpperCase() + node.party.slice(1)}
            </span>
          )}
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-gray-100 my-1.5" />

      {/* Stats */}
      <div className="space-y-0.5 text-xs text-gray-600">
        {node.connectionCount != null && (
          <div>{node.connectionCount} connections</div>
        )}
        {node.donationTotal != null && node.donationTotal > 0 && (
          <div>
            ${(node.donationTotal / 100).toLocaleString()} in donations
          </div>
        )}
      </div>

      {/* Hint */}
      <div className="text-gray-400 text-xs mt-1.5 italic">Click for more</div>
    </div>
  );
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export interface TooltipState {
  node: GraphNode | null;
  x: number;
  y: number;
  visible: boolean;
}

export function useTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState>({
    node: null,
    x: 0,
    y: 0,
    visible: false,
  });

  const show = (node: GraphNode, x: number, y: number) =>
    setTooltip({ node, x, y, visible: true });

  const hide = () => setTooltip((t) => ({ ...t, visible: false }));

  return { tooltip, show, hide };
}
