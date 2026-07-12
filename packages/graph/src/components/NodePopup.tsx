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

/**
 * SYNTHETIC mark — persistent label for AI-generated demonstration entities
 * (entity.is_synthetic, FIX-572 / SF-P2). The app's shared SyntheticMark lives
 * in apps/civitics and isn't importable from this package, so this is a
 * self-contained twin styled off the same amber dashed `.stampb` idiom. Render
 * it next to any synthetic node's name.
 */
function SyntheticMark() {
  return (
    <span
      className="inline-flex items-center rounded-[2px] border-[1.5px] border-dashed border-amber/70 bg-amber/20 px-1.5 py-0 font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-ink align-middle"
      title="AI-generated demonstration content — not a real person, body, or statement."
    >
      Synthetic
    </span>
  );
}

export function NodePopup({ node, onClose, actions, vizType }: NodePopupProps) {
  if (!node) return null;

  const isGroup    = node.type === 'group';
  const isForce    = vizType === 'force';
  const isOfficial = node.type === 'official';
  const isBracket  = node.type === 'individual_bracket';
  // FIX-805 — profile links for the previously link-less types. Donor node
  // flavors are all financial_entities rows (/donors/[id]); agency nodes come
  // from either the agencies or governing_bodies table ("agency:" /
  // "governing_body:" id prefixes) and both resolve at /institutions/[uuid]
  // via the institutions UNION view (FIX-418).
  const isDonor  = ['financial', 'pac', 'corporation', 'individual'].includes(node.type);
  const isAgency = node.type === 'agency';
  const rawEntityId = node.id.replace(/^[a-z_]+:/, '');

  const displayName = node.name ?? 'Unknown';

  const memberCount = node.metadata?.memberCount as number | undefined;
  const groupColor  = node.metadata?.color as string | undefined;
  const groupIcon   = node.metadata?.icon as string | undefined;
  // FIX-497 — donor/connection aggregation timed out or errored server-side. The
  // bubble still renders (members resolve); donor edges are unavailable. Show a
  // degraded affordance + retry instead of a silent donor-less expansion.
  const donorFetchError = node.metadata?.donorFetchError as boolean | undefined;

  if (isGroup) {
    return (
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 z-40" onClick={onClose} />

        {/* Group popup card */}
        <div
          className="absolute z-50 bg-card rounded-xl shadow-xl border border-rule w-64 p-4"
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-ink-soft/60 hover:text-ink text-base leading-none"
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
                backgroundColor: groupColor ? groupColor + '33' : 'rgb(var(--c-accent) / 0.2)',
                border: `2px solid ${groupColor ?? 'rgb(var(--c-accent))'}`,
              }}
            >
              {groupIcon ?? '👥'}
            </div>
            <div>
              <div className="font-semibold text-ink text-sm leading-tight">
                {displayName}
              </div>
              {memberCount && (
                <div className="text-xs text-ink-soft mt-0.5">
                  {memberCount} members
                </div>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-rule/60 mb-3" />

          {/* FIX-497 — degraded donor state. Member bubble rendered; donor edges
              failed to load. Offer a retry instead of a silent donor-less group. */}
          {donorFetchError && (
            <div className="mb-3 rounded-lg bg-amber/20 border border-amber/40 px-3 py-2">
              <div className="text-xs font-semibold text-ink">
                Donor data unavailable
              </div>
              <div className="text-[11px] text-ink-soft mt-0.5 leading-snug">
                The donor aggregation timed out. Members are shown; donor connections
                couldn’t load.
              </div>
              <button
                onClick={() => {
                  actions.retryGroup?.(node.id);
                  onClose();
                }}
                className="mt-2 w-full text-center px-3 py-1.5 rounded-md text-xs font-medium bg-amber/20 text-ink hover:bg-amber/30 transition-colors"
              >
                ↻ Retry donor data
              </button>
            </div>
          )}

          {/* Explore actions */}
          <div className="text-xs font-medium text-ink-soft/60 uppercase tracking-wide px-1 mb-1">
            Explore as
          </div>

          <div className="space-y-1">
            {/* Treemap */}
            <button
              onClick={() => {
                actions.viewGroupAsTreemap?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-accent/10 hover:text-accent flex items-center gap-2 transition-colors"
            >
              <span>▦</span>
              <span>Treemap</span>
              <span className="text-xs text-ink-soft/60 ml-auto">Size by donations</span>
            </button>

            {/* Chord */}
            <button
              onClick={() => {
                actions.viewGroupAsChord?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-accent/10 hover:text-accent flex items-center gap-2 transition-colors"
            >
              <span>◎</span>
              <span>Chord diagram</span>
              <span className="text-xs text-ink-soft/60 ml-auto">Money flows</span>
            </button>

            {/* Sunburst */}
            <button
              onClick={() => {
                actions.viewGroupAsSunburst?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-accent/10 hover:text-accent flex items-center gap-2 transition-colors"
            >
              <span>☀</span>
              <span>Sunburst</span>
              <span className="text-xs text-ink-soft/60 ml-auto">Full breakdown</span>
            </button>

            {/* Divider */}
            <div className="border-t border-rule/60 my-1" />

            {/* Remove group */}
            <button
              onClick={() => {
                actions.removeGroup?.(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-accent hover:bg-accent/10 flex items-center gap-2 transition-colors"
            >
              <span>×</span>
              <span>Remove group</span>
            </button>
          </div>
        </div>
      </>
    );
  }

  if (isBracket) {
    const isEmployer   = node.metadata?.isEmployerNode as boolean | undefined;
    const tier         = node.metadata?.tier as string | undefined;
    const donorCount   = node.metadata?.donorCount as number | undefined;
    const officialId   = node.metadata?.officialId as string | undefined;
    const employer     = node.metadata?.employer as string | undefined;
    const totalUsd     = (node.donationTotal ?? 0) / 100;

    return (
      <>
        <div className="fixed inset-0 z-40" onClick={onClose} />
        <div
          className="absolute z-50 bg-card rounded-xl shadow-xl border border-rule w-64 p-4"
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
        >
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-ink-soft/60 hover:text-ink transition-colors text-base leading-none"
            aria-label="Close"
          >
            ✕
          </button>

          <div className="flex items-start gap-2 pr-6 mb-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl flex-shrink-0 bg-amber/20 border-2 border-amber/60">
              {isEmployer ? '🏢' : '👤'}
            </div>
            <div>
              <div className="font-semibold text-ink leading-tight text-sm">
                {isEmployer ? (employer === 'UNAFFILIATED' ? 'Unaffiliated' : employer) : `${displayName}`}
              </div>
              <div className="text-xs text-ink-soft mt-0.5">
                {isEmployer ? 'Employer group' : 'Individual donors'}
              </div>
            </div>
          </div>

          <div className="border-t border-rule/60 mb-3" />

          <div className="space-y-1 text-sm text-ink-soft mb-3">
            {donorCount != null && (
              <div className="flex justify-between">
                <span>Donors</span>
                <span className="font-medium text-ink">{donorCount.toLocaleString()}</span>
              </div>
            )}
            {totalUsd != null && totalUsd > 0 && (
              <div className="flex justify-between">
                <span>Total</span>
                <span className="font-medium text-ink">${Math.round(totalUsd).toLocaleString()}</span>
              </div>
            )}
            {totalUsd != null && donorCount && donorCount > 0 && (
              <div className="flex justify-between">
                <span>Avg per donor</span>
                <span className="font-medium text-ink">${Math.round(totalUsd / donorCount).toLocaleString()}</span>
              </div>
            )}
          </div>

          <div className="space-y-1">
            {officialId && (tier || employer) && (
              <button
                onClick={() => {
                  actions.openDonorList?.(officialId, tier ?? employer ?? '');
                  onClose();
                }}
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-amber/30 flex items-center gap-2 transition-colors"
              >
                <span>📋</span>
                <span>View donor list</span>
              </button>
            )}
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
      ? 'bg-civic-blue'
      : node.party === 'republican'
      ? 'bg-accent'
      : 'bg-ink/40';

  return (
    <>
      {/* Backdrop — fixed, click to close */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Popup card — centered in graph canvas */}
      <div
        className="absolute z-50 bg-card rounded-xl shadow-xl border border-rule w-64 p-4"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-ink-soft/60 hover:text-ink transition-colors text-base leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        {/* Avatar + name */}
        <div className="flex items-start gap-2 pr-6">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center text-paper font-semibold text-sm flex-shrink-0 ${avatarBg}`}
          >
            {initials}
          </div>
          <div>
            <div className="font-semibold text-ink leading-tight text-sm">
              {displayName}
              {node.isSynthetic && <span className="ml-1.5"><SyntheticMark /></span>}
            </div>
            {node.role && (
              <div className="text-xs text-ink-soft mt-0.5">{node.role}</div>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-rule/60 my-3" />

        {/* Stats */}
        <div className="space-y-1 text-sm text-ink-soft mb-3">
          {node.connectionCount != null && (
            <div className="flex justify-between">
              <span>Connections</span>
              <span className="font-medium text-ink">
                {node.connectionCount}
              </span>
            </div>
          )}
          {node.donationTotal != null && node.donationTotal > 0 && (
            <div className="flex justify-between">
              <span>Donations</span>
              <span className="font-medium text-ink">
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
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-ink/5 flex items-center gap-2 transition-colors"
            >
              <span>⊙</span>
              <span>Recenter graph</span>
            </button>
          )}

          {/* View profile — officials only */}
          {isOfficial && (
            <button
              onClick={() => actions.openProfile(node.id)}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-ink/5 flex items-center gap-2 transition-colors"
            >
              <span>↗</span>
              <span>View full profile</span>
            </button>
          )}

          {/* View proposal */}
          {node.type === 'proposal' && (
            <button
              onClick={() => window.open(`/proposals/${node.id.replace(/^proposal:/, '')}`, '_blank')}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-ink/5 flex items-center gap-2 transition-colors"
            >
              <span>↗</span>
              <span>View proposal</span>
            </button>
          )}

          {/* View donor profile (FIX-805) */}
          {isDonor && (
            <button
              onClick={() => window.open(`/donors/${rawEntityId}`, '_blank')}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-ink/5 flex items-center gap-2 transition-colors"
            >
              <span>↗</span>
              <span>View donor profile</span>
            </button>
          )}

          {/* View institution profile (FIX-805) */}
          {isAgency && (
            <button
              onClick={() => window.open(`/institutions/${rawEntityId}`, '_blank')}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-ink/5 flex items-center gap-2 transition-colors"
            >
              <span>↗</span>
              <span>View institution profile</span>
            </button>
          )}

          {/* Expand collapsed node — force only */}
          {isForce && node.collapsed && (
            <button
              onClick={() => {
                actions.expandNode(node.id);
                onClose();
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-ink hover:bg-amber/30 flex items-center gap-2 transition-colors"
            >
              <span>+</span>
              <span>Expand connections</span>
            </button>
          )}
          {/* "Add to comparison" removed (FIX-805) — it invoked an empty
              callback; no comparison feature exists. */}
        </div>
      </div>
    </>
  );
}
