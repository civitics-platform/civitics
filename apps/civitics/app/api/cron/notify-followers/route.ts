// Vercel cron route — fan out notifications to followers.
//
// Schedule: every 6 hours — configured in /vercel.json
//
// Detects:
//   - New votes by followed officials since last run -> "official_vote" notifications
//   - New proposals for followed agencies since last run -> "new_proposal" notifications
//
// State is tracked in pipeline_state key "notify_followers_last_run".
// Security: CRON_SECRET header, same as nightly-sync.

export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { notifyFollowers } from "@/lib/notifications";
import { fetchChunkedByIds } from "@/lib/paginate";

const STATE_KEY = "notify_followers_last_run";

// PostgREST caps a single .select() at db-max-rows (1000), so an unbounded
// follower load silently dropped everyone past the first 1000 from the fan-out
// (FIX-429). Page through the full set instead. Latent today (follow volume < 1k)
// but a correctness landmine as the platform scales.
const FOLLOWS_PAGE = 1000;

async function fetchAllFollowedEntityIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  entityType: string,
): Promise<string[]> {
  const ids = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("user_follows")
      .select("entity_id")
      .eq("entity_type", entityType)
      .range(from, from + FOLLOWS_PAGE - 1);
    if (error) throw error;
    const batch: { entity_id: string }[] = data ?? [];
    for (const r of batch) ids.add(r.entity_id);
    if (batch.length < FOLLOWS_PAGE) break;
    from += FOLLOWS_PAGE;
  }
  return Array.from(ids);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (process.env["CRON_DISABLED"] === "true") {
    return NextResponse.json({ skipped: true, reason: "CRON_DISABLED" });
  }

  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;
  const isVercelCron = !!process.env["CRON_SECRET"] && authHeader === expected;
  const isManualAdmin = request.nextUrl.searchParams.get("manual") === "1";

  if (!isVercelCron && !isManualAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // Fetch last-run cursor
  const { data: stateRow } = await db
    .from("pipeline_state")
    .select("value")
    .eq("key", STATE_KEY)
    .maybeSingle();

  const lastRunIso =
    (stateRow?.value?.last_run as string | undefined) ??
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const now = new Date().toISOString();

  // ── 1. followed officials: did they vote? ──────────────────────────────────
  const followedOfficialIds = await fetchAllFollowedEntityIds(db, "official");

  let officialEventsSent = 0;
  if (followedOfficialIds.length > 0) {
    // FIX-902: chunked. `fetchAllFollowedEntityIds` pages the ENTIRE
    // user_follows table for this entity type — there is no cap at all, and it
    // grows with every user who follows anyone. A 414 here silently sends zero
    // vote notifications and the cron still reports success.
    const { rows: newVotes, complete: votesComplete } = await fetchChunkedByIds<{
      id: string; official_id: string; vote: string; voted_at: string | null; bill_proposal_id: string | null;
    }>(
      followedOfficialIds,
      (ids) =>
        db
          .from("votes")
          .select("id, official_id, vote, voted_at, bill_proposal_id")
          .in("official_id", ids)
          .gt("voted_at", lastRunIso)
          .order("voted_at", { ascending: false })
          .limit(500),
      { label: "notify-followers:new-votes" },
    );
    if (!votesComplete) {
      console.error("[notify-followers] vote read incomplete — some followed officials skipped this run");
    }

    // votes.bill_proposal_id FKs to bill_details(proposal_id), not proposals, so a
    // PostgREST embed can't resolve. Two-step: fetch proposals + bill_number
    // separately. The bill_proposal_id value IS a proposals.id.
    const newVoteRows = newVotes;
    // FIX-902: chunked. Bounded by the vote read's `.limit(500)` — which is now
    // per chunk, so this can carry more distinct proposals than the 500 the old
    // single-shot read allowed. Either way it was already over the 200 bound.
    const followProposalIds = [...new Set(newVoteRows.map((v) => v.bill_proposal_id).filter(Boolean) as string[])];
    const followProposalsById = new Map<string, { id: string; title: string | null; bill_number: string | null }>();
    if (followProposalIds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { rows: props, complete: propsComplete } = await fetchChunkedByIds<any>(
        followProposalIds,
        (ids) => db.from("proposals").select("id, title, bill_details(bill_number)").in("id", ids),
        { label: "notify-followers:vote-proposals" },
      );
      if (!propsComplete) {
        console.error("[notify-followers] proposal read incomplete — some notifications say 'Unknown bill'");
      }
      for (const p of props) {
        const bd = Array.isArray(p.bill_details) ? p.bill_details[0] : p.bill_details;
        followProposalsById.set(p.id, { id: p.id, title: p.title ?? null, bill_number: bd?.bill_number ?? null });
      }
    }

    const votesByOfficial = new Map<
      string,
      Array<{ title: string; bill_number: string | null; vote: string; proposal_id: string | null }>
    >();
    for (const v of newVoteRows) {
      const proposal = v.bill_proposal_id ? followProposalsById.get(v.bill_proposal_id) ?? null : null;
      const entry = votesByOfficial.get(v.official_id) ?? [];
      entry.push({
        title:       proposal?.title ?? "Unknown bill",
        bill_number: proposal?.bill_number ?? null,
        vote:        v.vote,
        proposal_id: proposal?.id ?? null,
      });
      votesByOfficial.set(v.official_id, entry);
    }

    for (const [officialId, votes] of votesByOfficial) {
      const { data: official } = await db
        .from("officials")
        .select("full_name")
        .eq("id", officialId)
        .single();
      const name = official?.full_name ?? "An official you follow";
      const first = votes[0]!;
      const extra = votes.length > 1 ? ` (+${votes.length - 1} more)` : "";
      const billLabel = first.bill_number ? `${first.bill_number}: ` : "";
      const result = await notifyFollowers({
        entityType: "official",
        entityId:   officialId,
        eventType:  "official_vote",
        title:      `${name} voted "${first.vote}" on ${billLabel}${truncate(first.title, 80)}${extra}`,
        body:
          votes.length > 1
            ? `${votes.length} new votes by ${name} since your last check-in.`
            : undefined,
        link: `/officials/${officialId}`,
      });
      officialEventsSent += result.notified;
    }
  }

  // ── 2. followed agencies: new proposals? ───────────────────────────────────
  const followedAgencyIds = await fetchAllFollowedEntityIds(db, "agency");

  let agencyEventsSent = 0;
  if (followedAgencyIds.length > 0) {
    // Agencies are keyed by acronym or name in proposals.metadata->>agency_id.
    // FIX-902: chunked — same uncapped `fetchAllFollowedEntityIds` feeder as the
    // official branch above.
    const { rows: agencies, complete: agenciesComplete } = await fetchChunkedByIds<{
      id: string; name: string; acronym: string | null;
    }>(
      followedAgencyIds,
      (ids) => db.from("agencies").select("id, name, acronym").in("id", ids),
      { label: "notify-followers:agencies" },
    );
    if (!agenciesComplete) {
      console.error("[notify-followers] agency read incomplete — some followed agencies skipped this run");
    }

    for (const a of agencies) {
      const key = a.acronym ?? a.name;
      const { data: newProposals } = await db
        .from("proposals")
        .select("id, title, bill_details(bill_number), introduced_at, created_at")
        .filter("metadata->>agency_id", "eq", key)
        .gt("created_at", lastRunIso)
        .order("created_at", { ascending: false })
        .limit(10);

      // proposals has no bill_number column — it lives in bill_details (FK). Unwrap
      // the embed array-vs-object the same way the followed-officials block does (l.106).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = ((newProposals ?? []) as any[]).map((p) => ({
        ...p,
        bill_number: (Array.isArray(p.bill_details) ? p.bill_details[0] : p.bill_details)?.bill_number ?? null,
      }));
      if (rows.length === 0) continue;

      const first = rows[0]!;
      const extra = rows.length > 1 ? ` (+${rows.length - 1} more)` : "";
      const billLabel = first.bill_number ? `${first.bill_number}: ` : "";
      const result = await notifyFollowers({
        entityType: "agency",
        entityId:   a.id,
        eventType:  "new_proposal",
        title:      `New from ${a.acronym ?? a.name}: ${billLabel}${truncate(first.title, 80)}${extra}`,
        body:
          rows.length > 1
            ? `${rows.length} new proposals from ${a.name}.`
            : undefined,
        link: first.id ? `/proposals/${first.id}` : `/agencies/${a.id}`,
      });
      agencyEventsSent += result.notified;
    }
  }

  // Advance cursor
  await db.from("pipeline_state").upsert(
    {
      key:        STATE_KEY,
      value:      {
        last_run:  now,
        previous:  lastRunIso,
        official_events_sent: officialEventsSent,
        agency_events_sent:   agencyEventsSent,
      },
      updated_at: now,
    },
    { onConflict: "key" }
  );

  return NextResponse.json({
    ok: true,
    window_start: lastRunIso,
    window_end:   now,
    officialEventsSent,
    agencyEventsSent,
  });
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
