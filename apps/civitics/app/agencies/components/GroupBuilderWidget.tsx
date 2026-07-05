"use client";

/**
 * GroupBuilderWidget — FIX-127
 *
 * Sidebar widget on /agencies. Wraps the shared CustomGroupForm; on save,
 * encodes the filter into URL params and routes to /graph, where GraphPage
 * decodes and adds the group as a FocusGroup. For signed-in users, the
 * group is also persisted via /api/graph/custom-groups before navigation.
 */

import { useRouter } from "next/navigation";
import { CustomGroupForm } from "@civitics/graph";
import type { CustomGroupFormPayload } from "@civitics/graph";

export function GroupBuilderWidget() {
  const router = useRouter();

  async function handleSave({ filter, name }: CustomGroupFormPayload) {
    // Best-effort persistence — anonymous and failed POSTs still get the
    // group via URL handoff so the user never loses their selection.
    try {
      await fetch("/api/graph/custom-groups", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name, filter }),
        credentials: "include",
      });
    } catch {
      // ignore — URL handoff is the primary contract
    }

    const params = new URLSearchParams();
    params.set("groupType", filter.entity_type);
    params.set("groupName", name);
    if (filter.chamber)  params.set("groupChamber",  filter.chamber);
    if (filter.party)    params.set("groupParty",    filter.party);
    if (filter.state)    params.set("groupState",    filter.state);
    if (filter.industry) params.set("groupIndustry", filter.industry);

    router.push(`/graph?${params.toString()}`);
  }

  return (
    <aside className="border border-rule bg-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-ink mb-1">Build a custom group</h2>
      <p className="text-xs text-ink-soft/70 mb-3 leading-snug">
        Pick filters to define a cohort of officials, PACs, or agencies — then
        open it in the connection graph.
      </p>
      <CustomGroupForm onSave={handleSave} saveLabel="Open in graph" />
    </aside>
  );
}
