/**
 * GET /api/graph/tag-groups — FIX-137, server-side aggregate since FIX-892
 *
 * Returns the top topic tags applied to proposals, ordered by distinct
 * proposal count desc. Powers the "Legislation → By topic tag" browse list.
 *
 * Filters: entity_type='proposal', tag_category='topic', visibility != 'internal',
 *          tag != 'other' (placeholder bucket — not useful as a filter),
 *          count >= 10. Cap at 30 results.
 *
 * Response: { tags: [{ tag, label, icon, count }, ...] }
 *
 * FIX-892 — this used to `.select()` every qualifying entity_tags row and
 * aggregate `count(DISTINCT entity_id)` in JS, justified by a header comment
 * asserting "the row volume is bounded (~1.4k topic rows total)". That
 * assumption expired: the slice is 6,039 rows on local (prod larger), PostgREST
 * caps any response at max_rows=1,000, and the read carried no `.order()` — so
 * the route aggregated an arbitrary 1,000-row physical slice and its counts
 * summed to 1,000 against a true 6,039 (~6x understatement), failing OPEN with
 * no error. Truncation also pushed whole tags under MIN_COUNT: 20 tags clear
 * the floor on the true data, 18 on the truncated read, so the browse list was
 * missing topics outright. The aggregate now happens in Postgres —
 * get_proposal_topic_groups() returns ONE jsonb array (the RPC-row-cap rule,
 * mirroring FIX-878) — and this route is a thin pass-through that only applies
 * the presentation thresholds below.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

// Presentation thresholds, deliberately kept OUT of the RPC: the aggregate is
// ~24 elements, so filtering server-side saves nothing, and changing either of
// these should never require a migration.
const MIN_COUNT = 10;
const MAX_RESULTS = 30;

export interface TagGroup {
  tag: string;
  label: string;
  icon: string | null;
  count: number;
}

export async function GET() {
  if (supabaseUnavailable()) return unavailableResponse();

  const supabase = createAdminClient();

  // One jsonb array, already ordered count DESC, tag ASC.
  const { data, error } = await supabase.rpc("get_proposal_topic_groups");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const groups = (data ?? []) as unknown as TagGroup[];

  const tags: TagGroup[] = groups
    .filter((t) => t.count >= MIN_COUNT)
    .slice(0, MAX_RESULTS);

  return withPublicCdnCache(NextResponse.json({ tags }));
}
