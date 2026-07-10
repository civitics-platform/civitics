import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// ─── GET /api/viewer/engagement?statement_ids=&entity_type=&entity_id= ────────
// FIX-788 — the per-viewer overlay for the CDN-cached public list routes
// (/api/statements, /api/questions). Those payloads are edge-cached cross-user
// and therefore carry zero viewer-dependent fields; this endpoint returns ONLY
// the viewer's own state, merged client-side onto the already-rendered rows:
//
//   votes      — { [statement_id]: -1|0|1 } for the caller's ballots among
//                ?statement_ids (comma-separated uuids; the RLS policy
//                statement_votes_select_own scopes the read to own rows)
//   can_answer — whether the caller holds the active answerer grant for
//                ?entity_type + ?entity_id (has_active_answerer_grant RPC)
//
// This response varies by the signed-in user, so it is pinned
// CDN-Cache-Control: no-store via the next.config.mjs userScopedApi denylist
// ("api/viewer") — the FIX-786/787 rule: per-user responses NEVER enter the
// shared edge cache. Signed-out clients short-circuit and never call this
// (fetchViewerEngagement checks the local session first); an anon hit that
// arrives anyway gets the empty overlay.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Grantable Q&A entity types — mirrors has_active_answerer_grant's branches.
// 'proposal' is deliberately absent: no official answerer exists for a bill.
const GRANTABLE_ENTITY_TYPES = new Set(["official", "institution", "jurisdiction"]);
// Batch cap: list pages are ≤100 rows; also keeps the .in() well under the
// local Kong URI limit (~200 uuids, see entity_connection_stats_mv precedent).
const MAX_STATEMENT_IDS = 200;

const EMPTY = { votes: {}, can_answer: false };

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const statementIds = (sp.get("statement_ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => UUID_RE.test(s))
      .slice(0, MAX_STATEMENT_IDS);
    const entityType = sp.get("entity_type");
    const entityId = sp.get("entity_id");

    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json(EMPTY);

    const grantArgs =
      entityType && GRANTABLE_ENTITY_TYPES.has(entityType) && entityId && UUID_RE.test(entityId)
        ? { p_user_id: user.id, p_entity_type: entityType, p_entity_id: entityId }
        : null;

    const [voteRows, grant] = await Promise.all([
      statementIds.length > 0
        ? supabase
            .from("statement_votes")
            .select("statement_id, vote")
            .in("statement_id", statementIds)
        : Promise.resolve({ data: null }),
      grantArgs
        ? supabase.rpc("has_active_answerer_grant", grantArgs)
        : Promise.resolve({ data: false }),
    ]);

    const votes: Record<string, number> = {};
    for (const row of voteRows.data ?? []) {
      votes[row.statement_id] = row.vote;
    }

    return NextResponse.json({ votes, can_answer: grant.data === true });
  } catch {
    return NextResponse.json(EMPTY);
  }
}
