"use client";

/**
 * packages/graph/src/components/NodePopup.tsx
 *
 * Shared click popup used by all viz types.
 * Centered absolutely within the parent graph canvas container.
 * A fixed backdrop closes on outside click.
 */

import type { GraphNode, NodeActions, VizType } from '../types';

export interface NodePopupProps {
  node: GraphNode | null;
  onClose: () => void;
  actions: NodeActions;
  vizType: VizType;
}

export function NodePopup({ node, onClose, actions, vizType }: NodePopupProps) {
  if (!node) return null;

  const isGroup    = node.type === 'group';
  const isForce    = vizType === 'force';
  const isOfficial = node.type === 'official';

  const displayName = node.name ?? 'Unknown';

  const memberCount = node.metadata?.memberCount as number | undefined;
  const groupColor  = node.metadata?.color as string | undefined;
  const groupIcon   = node.metadata?.icon as string | undefined;

  if (isGroup) {
    return (
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 z-40" onClick={onClose} />

        {/* Group popup card */}
        <div
          className="absolute z-50 bg-white rounded-xl shadow-xl border border-gray-200 w-64 p-4"
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 text-base leading-none"
            aria-label="Close"
          >
            ✕
          </button>

          {/* Group header */}
          <div className="flex items-center gap-3 pr-6 mb-3">
            {/* Color circle + icon */}
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-xl flex-shrink-0"
              style={{
                backgroundColor: (groupColor ?? '#6366f1') + '33',
                border: `2px solid ${groupColor ?? '#6366f1'}`,
              }}
            >
              {groupIcon ?? '👥'}
            </div>
            <div>
              <div className="font-semibold text-gray-900 text-sm leading-tight">
                {displayName}
              </div>
              {memberCount && (
                <div className="text-xs text-gray-500 mt-0.5">
                  {memberCount} members
                </div>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-100 mb-3" />

          {/* Explore actions */}
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide px-1 mb-1">
            Explore as
          </div>

          <div className="space-y-1">
            {/* Treemap */}
            <button
              onClick={() => {
                actions.viewGroupAsTreemap?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 flex items-center gap-2 transition-colors"
            >
              <span>▦</span>
              <span>Treemap</span>
              <span className="text-xs text-gray-400 ml-auto">Size by donations</span>
            </button>

            {/* Chord */}
            <button
              onClick={() => {
                actions.viewGroupAsChord?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 flex items-center gap-2 transition-colors"
            >
              <span>◎</span>
              <span>Chord diagram</span>
              <span className="text-xs text-gray-400 ml-auto">Money flows</span>
            </button>

            {/* Sunburst */}
            <button
              onClick={() => {
                actions.viewGroupAsSunburst?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 flex items-center gap-2 transition-colors"
            >
              <span>☀</span>
              <span>Sunburst</span>
              <span className="text-xs text-gray-400 ml-auto">Full breakdown</span>
            </button>

            {/* Divider */}
            <div className="border-t border-gray-100 my-1" />

            {/* Remove group */}
            <button
              onClick={() => {
                actions.removeGroup?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 flex items-center gap-2 transition-colors"
            >
              <span>×</span>
              <span>Remove group</span>
            </button>
          </div>
        </div>
      </>
    );
  }

  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

  const avatarBg =
    node.party === 'democrat'
      ? 'bg-blue-600'
      : node.party === 'republican'
      ? 'bg-red-600'
      : 'bg-gray-500';

  return (
    <>
      {/* Backdrop — fixed, click to close */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Popup card — centered in graph canvas */}
      <div
        className="absolute z-50 bg-white rounded-xl shadow-xl border border-gray-200 w-64 p-4"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 transition-colors text-base leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        {/* Avatar + name */}
        <div className="flex items-start gap-2 pr-6">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 ${avatarBg}`}
          >
            {initials}
          </div>
          <div>
            <div className="font-semibold text-gray-900 leading-tight text-sm">
              {displayName}
            </div>
            {node.role && (
              <div className="text-xs text-gray-500 mt-0.5">{node.role}</div>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-100 my-3" />

        {/* Stats */}
        <div className="space-y-1 text-sm text-gray-600 mb-3">
          {node.connectionCount != null && (
            <div className="flex justify-between">
              <span>Connections</span>
              <span className="font-medium text-gray-900">
                {node.connectionCount}
              </span>
            </div>
          )}
          {node.donationTotal != null && node.donationTotal > 0 && (
            <div className="flex justify-between">
              <span>Donations</span>
              <span className="font-medium text-gray-900">
                ${(node.donationTotal / 100).toLocaleString()}
              </span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-1">
          {/* Recenter — force only */}
          {isForce && (
            <button
              onClick={() => {
                actions.recenter(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
            >
              <span>⊙</span>
              <span>Recenter graph</span>
            </button>
          )}

          {/* View profile — officials only */}
          {isOfficial && (
            <button
              onClick={() => actions.openProfile(node.id)}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
            >
              <span>↗</span>
              <span>View full profile</span>
            </button>
          )}

          {/* View proposal */}
          {node.type === 'proposal' && (
            <button
              onClick={() => window.open(`/proposals/${node.id}`, '_blank')}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
            >
              <span>↗</span>
              <span>View proposal</span>
            </button>
          )}

          {/* Expand collapsed node — force only */}
          {isForce && node.collapsed && (
            <button
              onClick={() => {
                actions.expandNode(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-amber-700 hover:bg-amber-50 flex items-center gap-2 transition-colors"
            >
              <span>+</span>
              <span>Expand connections</span>
            </button>
          )}

          {/* Add to comparison — force + official only */}
          {isForce && isOfficial && (
            <button
              onClick={() => {
                actions.addToComparison(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors"
            >
              <span>+</span>
              <span>Add to comparison</span>
            </button>
          )}
        </div>
      </div>
    </>
  );
}
