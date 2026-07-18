/**
 * packages/graph/src/groupQuery.ts
 *
 * Pure builder for the /api/graph/group query params (FIX-849 contract
 * surface). Extracted from useGraphData.fetchGroups so the Top-N `limit`
 * forwarding (FIX-842) and the filter param set are unit-testable — the drift
 * that let the group route silently ignore the Top-donors dropdown is now a red
 * test, not a bug report. No React / fetch / state, so it imports cleanly under
 * the data package's tsx.
 */

import type { FocusGroup } from './types';

export function graphGroupParams(group: FocusGroup, donationLimit: number): URLSearchParams {
  const params = new URLSearchParams({
    groupId: group.id,
    entity_type: group.filter.entity_type,
    groupName: group.name,
    groupIcon: group.icon,
    groupColor: group.color,
    // FIX-842 — forward the Top-donors cap so the dropdown actually changes the
    // group's donor count (the route clamps to ≤100).
    limit: String(donationLimit),
  });

  if (group.filter.chamber)  params.set('chamber',  group.filter.chamber);
  if (group.filter.party)    params.set('party',    group.filter.party);
  if (group.filter.state)    params.set('state',    group.filter.state);
  if (group.filter.industry) params.set('industry', group.filter.industry);
  if (group.filter.tag)      params.set('tag',      group.filter.tag);
  if (group.filter.committeeId) params.set('committeeId', group.filter.committeeId);
  if (group.filter.governingBody) params.set('governingBody', group.filter.governingBody);
  // FIX-772 — financial cohorts carry a subtype the route needs.
  if (group.filter.financial_type) params.set('financial_type', group.filter.financial_type);

  return params;
}
