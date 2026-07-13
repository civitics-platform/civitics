/**
 * GET /api/graph/tag-groups — FIX-137
 *
 * Returns the top topic tags applied to proposals, ordered by distinct
 * proposal count desc. Powers the "Legislation → By topic tag" browse list.
 *
 * Filters: entity_type='proposal', tag_category='topic', visibility != 'internal',
 *          tag != 'other' (placeholder bucket — not useful as a filter),
 *          count >= 10. Cap at 30 results.
 *
 * Response: { tags: [{ tag, label, icon, count }, ...] }
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

const MIN_COUNT = 10;
const MAX_RESULTS = 30;

interface TagRow {
  tag: string;
  display_label: string;
  display_icon: string | null;
  entity_id: string;
}

export interface TagGroup {
  tag: string;
  label: string;
  icon: string | null;
  count: number;
}

export async function GET() {
  if (supabaseUnavailable()) return unavailableResponse();

  const supabase = createAdminClient();

  // Pull all topic-category proposal tags. We aggregate in JS rather than via
  // a Postgres GROUP BY because PostgREST doesn't expose count(distinct ...)
  // — and the row volume is bounded (~1.4k topic rows total, see entity_tags).
  const { data, error } = await supabase
    .from("entity_tags")
    .select("tag, display_label, display_icon, entity_id")
    .eq("entity_type", "proposal")
    .eq("tag_category", "topic")
    .neq("visibility", "internal")
    .neq("tag", "other");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as TagRow[];

  // Aggregate distinct entity_id per tag.
  const acc = new Map<string, { label: string; icon: string | null; ids: Set<string> }>();
  for (const row of rows) {
    const existing = acc.get(row.tag);
    if (existing) {
      existing.ids.add(row.entity_id);
    } else {
      acc.set(row.tag, {
        label: row.display_label,
        icon: row.display_icon,
        ids: new Set([row.entity_id]),
      });
    }
  }

  const tags: TagGroup[] = [...acc.entries()]
    .map(([tag, v]) => ({ tag, label: v.label, icon: v.icon, count: v.ids.size }))
    .filter(t => t.count >= MIN_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_RESULTS);

  return withPublicCdnCache(NextResponse.json({ tags }));
}
