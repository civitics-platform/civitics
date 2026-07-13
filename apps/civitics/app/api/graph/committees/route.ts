/**
 * GET /api/graph/committees — FIX-139
 *
 * Returns all major (non-sub) congressional committees with current-member
 * counts, grouped client-side by chamber. Powers the People → Federal →
 * By committee browse list.
 *
 * Subcommittees are excluded for now — a future FIX can add drill-down by
 * parent committee. Inactive memberships (ended_at IS NOT NULL) are excluded
 * from the count.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export interface CommitteeListItem {
  id: string;
  name: string;
  chamber: "house" | "senate" | "joint" | null;
  memberCount: number;
}

interface CommitteeRow {
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
}

interface MembershipRow {
  committee_id: string;
}

export async function GET() {
  if (supabaseUnavailable()) return unavailableResponse();

  const supabase = createAdminClient();

  const { data: committees, error: committeesErr } = await supabase
    .from("governing_bodies")
    .select("id, name, metadata")
    .eq("type", "committee")
    .eq("is_active", true)
    .order("name");

  if (committeesErr) {
    return NextResponse.json({ error: committeesErr.message }, { status: 500 });
  }

  const parents = ((committees ?? []) as CommitteeRow[]).filter(
    c => c.metadata?.["is_subcommittee"] !== true,
  );

  const ids = parents.map(c => c.id);

  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: memberships, error: membersErr } = await supabase
      .from("official_committee_memberships")
      .select("committee_id")
      .is("ended_at", null)
      .in("committee_id", ids);

    if (membersErr) {
      return NextResponse.json({ error: membersErr.message }, { status: 500 });
    }

    for (const row of (memberships ?? []) as MembershipRow[]) {
      counts.set(row.committee_id, (counts.get(row.committee_id) ?? 0) + 1);
    }
  }

  const items: CommitteeListItem[] = parents
    .map(c => ({
      id: c.id,
      name: c.name,
      chamber: (c.metadata?.["chamber"] as CommitteeListItem["chamber"]) ?? null,
      memberCount: counts.get(c.id) ?? 0,
    }))
    // Hide rows with no members (likely stale/inactive committees)
    .filter(c => c.memberCount > 0);

  return withPublicCdnCache(NextResponse.json({ committees: items }));
}
