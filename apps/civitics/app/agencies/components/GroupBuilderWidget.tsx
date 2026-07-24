/**
 * GroupBuilderWidget — FIX-127, simplified in FIX-773.
 *
 * Sidebar widget on /agencies. Custom-group building moved to the /search
 * Explorer (W2 selector unification), so this widget is now a compact link-card
 * pointing there — it no longer embeds the retired CustomGroupForm selector.
 */

import Link from "next/link";

export function GroupBuilderWidget() {
  return (
    <aside className="border border-rule bg-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-ink mb-1">Build a custom group</h2>
      <p className="text-xs text-ink-soft/70 mb-3 leading-snug">
        Define a cohort of officials, PACs, or agencies — filter by party,
        chamber, state, or industry — in the Explorer, then open it in the
        connection graph.
      </p>
      <Link
        href="/search"
        className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
      >
        Build a custom group in the Explorer →
      </Link>
    </aside>
  );
}
