"use client";

/**
 * packages/graph/src/components/NodeContextMenu.tsx
 *
 * Small positional context menu that appears on right-click near a graph node.
 * Complements NodePopup (left-click centered modal) with quick in-place actions.
 *
 * Actions exposed:
 *  - Expand connections (collapsed nodes only)
 *  - Pin / Unpin node (fix position in simulation)
 *  - Hide node (remove from current view)
 *  - View profile / proposal (officials + proposals only)
 *  - Copy link to clipboard
 */

import { useEffect, useRef } from "react";
import type { GraphNode } from "../types";

export interface NodeContextMenuProps {
  node: GraphNode;
  /** Position in pixels relative to the graph container */
  x: number;
  y: number;
  /** Container dimensions so we can flip the menu if it would overflow */
  containerWidth: number;
  containerHeight: number;
  isPinned: boolean;
  onClose: () => void;
  onExpand: () => void;
  onPin: () => void;
  onHide: () => void;
  onViewProfile: () => void;
  onCopyLink: () => void;
}

const MENU_WIDTH  = 192; // px
const MENU_HEIGHT = 220; // approximate

export function NodeContextMenu({
  node,
  x,
  y,
  containerWidth,
  containerHeight,
  isPinned,
  onClose,
  onExpand,
  onPin,
  onHide,
  onViewProfile,
  onCopyLink,
}: NodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Flip menu so it stays inside the container
  const flipX = x + MENU_WIDTH  > containerWidth  ? x - MENU_WIDTH  : x;
  const flipY = y + MENU_HEIGHT > containerHeight ? y - MENU_HEIGHT : y;

  const isOfficial = node.type === "official";
  const isProposal = node.type === "proposal";
  const canViewProfile = isOfficial || isProposal;

  const profileLabel = isOfficial ? "View profile" : isProposal ? "View proposal" : null;
  const profileUrl   = isOfficial
    ? `/officials/${node.id}`
    : isProposal
    ? `/proposals/${node.id}`
    : null;

  return (
    <>
      {/* Invisible backdrop — click anywhere to close */}
      <div
        className="fixed inset-0 z-40"
        onMouseDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />

      {/* Menu */}
      <div
        ref={menuRef}
        className="absolute z-50 w-48 rounded-lg border border-rule bg-card shadow-lg py-1 text-sm"
        style={{ left: flipX, top: flipY }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header — entity name */}
        <div className="px-3 py-2 border-b border-rule/60">
          <p className="font-medium text-ink truncate text-xs leading-tight">
            {node.name ?? "Unknown"}
          </p>
          {node.role && (
            <p className="text-[10px] text-ink-soft/60 truncate mt-0.5">{node.role}</p>
          )}
        </div>

        {/* Actions */}
        <div className="py-1">

          {/* Expand — only if collapsed */}
          {node.collapsed && (
            <MenuButton
              icon="⊕"
              label="Expand connections"
              onClick={() => { onExpand(); onClose(); }}
              variant="default"
            />
          )}

          {/* Pin / Unpin */}
          <MenuButton
            icon={isPinned ? "📍" : "📌"}
            label={isPinned ? "Unpin node" : "Pin node"}
            onClick={() => { onPin(); onClose(); }}
            variant="default"
          />

          {/* View profile */}
          {canViewProfile && profileUrl && (
            <MenuButton
              icon="↗"
              label={profileLabel!}
              onClick={() => { window.open(profileUrl, "_blank"); onViewProfile(); onClose(); }}
              variant="default"
            />
          )}

          {/* Copy link */}
          <MenuButton
            icon="🔗"
            label="Copy link"
            onClick={() => { onCopyLink(); onClose(); }}
            variant="default"
          />

          {/* Divider before destructive */}
          <div className="border-t border-rule/60 my-1" />

          {/* Hide */}
          <MenuButton
            icon="✕"
            label="Hide node"
            onClick={() => { onHide(); onClose(); }}
            variant="danger"
          />
        </div>
      </div>
    </>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  variant,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  variant: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
        variant === "danger"
          ? "text-accent hover:bg-accent/10"
          : "text-ink hover:bg-ink/5"
      }`}
    >
      <span className="w-4 text-center flex-shrink-0 text-[11px]">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
