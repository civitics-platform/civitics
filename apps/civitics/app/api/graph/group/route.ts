export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, fetchIndustryTagsByEntityId, fetchEntityIdsByIndustryTag, currentGoverningBodyMembers } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";
import { fetchAllRows } from "@/lib/paginate";
import { isGbExpandableJurisdictionType } from "@/lib/graph-seedable-kinds";
import type { GraphEdgeV2 as GraphEdge, GraphNodeV2 as GraphNode, NodeTypeV2 as NodeType } from "@civitics/graph";

// Local extensions — group route adds metadata and id fields not in base types
type ResponseNode = GraphNode & { metadata?: Record<string, unknown> };
type ResponseEdge = GraphEdge & { id?: string; metadata?: Record<string, unknown> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FIX-490 — group identity (icon/color) derived from gb.type, server-side, so a
// gb group's appearance never depends on (spoofable) groupIcon/groupColor URL
// params. One map, with a sensible default for any unmapped type.
const GB_TYPE_VISUAL: Record<string, { icon: string; color: string }> = {
  legislature_upper:      { icon: "🏛", color: "#6366f1" },
  legislature_lower:      { icon: "🏛", color: "#8b5cf6" },
  legislature_unicameral: { icon: "🏛", color: "#6366f1" },
  executive:              { icon: "🏛", color: "#6366f1" },
  judicial:               { icon: "⚖️", color: "#475569" },
  committee:              { icon: "🪪", color: "#0891b2" },
};
const GB_TYPE_VISUAL_DEFAULT = { icon: "🏛", color: "#6366f1" };

// FIX-497 — JS-level budget for the connection-aggregation phase (donations,
// oversight). The donation queries page entity_connections; under prod IOWait
// load a single ordered aggregate of one chamber's donors is a ~70s on-disk
// sort (pre-index EXPLAIN), and fetchAllRows makes ~50 sequential page calls,
// so the route waited the full Postgres statement_timeout and a mid-paging
// 57014 (or the cumulative wall) got swallowed into donorCount:0 + 200. This
// budget makes the route fail FAST and flag, rather than ship a convincing
// empty. Sized above the 5s member-query timeout (withDbTimeout) because the
// donation set is the heavy query; post-index it returns in ~0.5s warm, so this
// is headroom for cold/under-load, not the steady-state cost.
const DONOR_FETCH_BUDGET_MS = 8000;

/**
 * Race a work promise against a JS-level timeout. On timeout, resolves with
 * `onTimeout()` and `timedOut:true` instead of hanging the full Postgres
 * statement_timeout. Mirrors the withDbTimeout race used by the member query,
 * but generic over any aggregate work (FIX-497).
 */
async function raceWithBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  label: string,
  onTimeout: () => T,
): Promise<{ value: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: T; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[graph/group] ${label} exceeded ${budgetMs}ms JS budget — flagging donorFetchError`);
      resolve({ value: onTimeout(), timedOut: true });
    }, budgetMs);
  });
  const wrapped = work.then((value) => ({ value, timedOut: false as const }));
  const result = await Promise.race([wrapped, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * Run a set of paged entity_connections fetches under the JS budget. Returns
 * the flattened rows plus `fetchFailed` — true when ANY page errors (e.g. a
 * Postgres statement_timeout 57014 surfaced as fetchAllRows' `error`, which the
 * callers previously discarded by destructuring `{ rows }` only) OR the whole
 * batch exceeds `budgetMs`. The caller sets meta.donorFetchError and returns a
 * partial-with-flag payload — never a silent zero (FIX-497).
 */
async function fetchPagedConnections<T>(
  builders: Array<
    (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
  >,
  budgetMs: number,
  label: string,
): Promise<{ rows: T[]; fetchFailed: boolean }> {
  const work = Promise.all(
    builders.map((b) => fetchAllRows<T>(b, { maxRows: 50000 })),
  ).then((results) => {
    const errored = results.find((r) => r.error != null);
    if (errored) console.error(`[graph/group] ${label} page error: ${errored.error?.message}`);
    return { rows: results.flatMap((r) => r.rows), fetchFailed: results.some((r) => r.error != null) };
  });
  const { value } = await raceWithBudget(
    work,
    budgetMs,
    label,
    () => ({ rows: [] as T[], fetchFailed: true }),
  );
  return value;
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();

  const { searchParams } = req.nextUrl;
  const groupId    = searchParams.get("groupId")    ?? "group-unknown";
  const entityType = searchParams.get("entity_type") ?? "official";
  const chamber    = searchParams.get("chamber");
  const party      = searchParams.get("party");
  const state      = searchParams.get("state");
  const industry   = searchParams.get("industry");
  const tag        = searchParams.get("tag");
  const committeeId = searchParams.get("committeeId");
  // FIX-490 — gb cohort key. Slug canonical, UUID accepted as fallback forever.
  const governingBody = searchParams.get("governingBody");
  const groupName  = searchParams.get("groupName")  ?? "Group";
  const groupIcon  = searchParams.get("groupIcon")  ?? "👥";
  const groupColor = searchParams.get("groupColor") ?? "#6366f1";
  const limit      = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);

  const supabase = createAdminClient();

  // ── Official group mode ──────────────────────────────────────────────────────
  // Who donated to this group of officials, and how much in aggregate?

  if (entityType === "official") {
    // Committee membership (FIX-139) is a join, not a direct officials column,
    // so resolve the cohort first and skip the officials.* filters when present.
    let memberIds: string[] = [];
    let memberCount: number | null = null;

    // Group identity. For gb groups these are server-resolved from the row and
    // override the (untrusted) groupName/Icon/Color URL params (FIX-490).
    let groupNameOut  = groupName;
    let groupIconOut  = groupIcon;
    let groupColorOut = groupColor;
    let seatCanaryTripped = false;

    // FIX-490 (FIX-468 Wave A C1) — governing-body cohort branch. A gb expands
    // to its member cohort: a generalization of the committeeId path (FIX-139).
    // `governingBody` is slug-canonical with UUID fallback; the legacy
    // `committeeId` param is an internal alias for the same code path.
    const gbKey = governingBody ?? committeeId;

    if (gbKey) {
      const isUuid = UUID_RE.test(gbKey);
      let gbq = supabase
        .from("governing_bodies")
        .select("id, name, short_name, type, seat_count, jurisdiction_id");
      gbq = isUuid ? gbq.eq("id", gbKey) : gbq.eq("slug", gbKey);
      const { data: gb, error: gbErr } = await gbq.maybeSingle();

      if (gbErr) {
        return NextResponse.json({ error: gbErr.message }, { status: 500 });
      }
      if (!gb) {
        return NextResponse.json(
          { error: "gb_not_found", governingBody: gbKey },
          { status: 404 },
        );
      }

      // Expansion eligibility gate = jurisdiction-type allowlist (decision 4).
      // city (FIX-471 Legistar pollution) and federal_district (FIX-489 DC) are
      // excluded; gated gbs get a structured 422, never a silent empty payload.
      const { data: juris } = await supabase
        .from("jurisdictions")
        .select("type")
        .eq("id", gb.jurisdiction_id)
        .maybeSingle();
      const jurisType = juris?.type ?? null;
      if (!isGbExpandableJurisdictionType(jurisType)) {
        return NextResponse.json(
          {
            error: "gb_not_expandable",
            reason: `governing body in '${jurisType ?? "unknown"}' jurisdiction is not graph-expandable`,
            governingBody: gbKey,
          },
          { status: 422 },
        );
      }

      // Resolve the cohort by gb.type. committee → active membership join (the
      // FIX-139 path); every other type → the canonical FIX-470 roster predicate
      // on officials.governing_body_id (NOT role_title, which counts the FEC
      // candidate field). `party` composes with both.
      if (gb.type === "committee") {
        const { data: memberRows, error: memberErr } = await supabase
          .from("official_committee_memberships")
          .select("official_id")
          .eq("committee_id", gb.id)
          .is("ended_at", null);
        if (memberErr) {
          return NextResponse.json({ error: memberErr.message }, { status: 500 });
        }
        memberIds   = [...new Set((memberRows ?? []).map((r) => r.official_id))];
        memberCount = memberIds.length;
      } else {
        let memberQuery = currentGoverningBodyMembers(
          supabase
            .from("officials")
            .select("id", { count: "exact" })
            .eq("governing_body_id", gb.id),
        );
        if (party)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          memberQuery = memberQuery.eq("party", party as any);

        const { count, data: memberData } = await withDbTimeout<{
          count: number | null;
          data: Array<{ id: string }> | null;
          error: { message: string } | null;
        }>(memberQuery.limit(1000));

        memberIds   = (memberData ?? []).map((m) => m.id);
        memberCount = count;
      }

      // Seats canary (decision 5) — a roster-pollution regression signal, NEVER
      // a gate (seat_count is NULL on all 101 state-chamber rows). Warn + flag,
      // still render.
      if (
        gb.seat_count != null &&
        memberCount != null &&
        memberCount > gb.seat_count * 1.2
      ) {
        seatCanaryTripped = true;
        console.warn(
          `[graph/group] gb ${gb.id} (${gb.name}) roster ${memberCount} exceeds ` +
            `seat_count ${gb.seat_count} × 1.2 — possible roster pollution`,
        );
      }

      // Server-resolved identity (decision 3).
      const visual = GB_TYPE_VISUAL[gb.type] ?? GB_TYPE_VISUAL_DEFAULT;
      groupNameOut  = gb.name;
      groupIconOut  = visual.icon;
      groupColorOut = visual.color;
    } else {
      let memberQuery = supabase
        .from("officials")
        .select("id", { count: "exact" })
        .eq("is_active", true);

      if (chamber === "senate")
        memberQuery = memberQuery.eq("role_title", "Senator");
      else if (chamber === "house")
        memberQuery = memberQuery.eq("role_title", "Representative");

      if (party)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        memberQuery = memberQuery.eq("party", party as any);

      if (state)
        // FIX-175: match metadata.state OR metadata.state_abbr to mirror the
        // treemap route's filter. FIX-124 backfilled state_abbr for federal
        // officials whose state lives in source_ids/jurisdictions; checking
        // only metadata.state silently drops them from state-filtered groups.
        memberQuery = memberQuery.or(
          `metadata->>state.eq.${state},metadata->>state_abbr.eq.${state}`,
        );

      // QWEN-ADDED: Add generic type to withDbTimeout for officials query with count
      const { count, data: memberData } = await withDbTimeout<{
        count: number | null;
        data: Array<{ id: string }> | null;
        error: { message: string } | null;
      }>(memberQuery.limit(1000));

      memberIds   = (memberData ?? []).map((m) => m.id);
      memberCount = count;
    }

    if (memberIds.length === 0) {
      return NextResponse.json({
        group: { id: groupId, name: groupNameOut, count: 0 },
        nodes: [],
        edges: [],
      });
    }

    // FIX-499 — server-side donor aggregation via get_group_donor_totals.
    // The prior path paged every donation row (House: 649,252 rows over ~180
    // OFFSET pages per 100-member chunk) and SUMmed in JS, then resolved
    // financial_entities for all ~292k distinct donors to drop individuals —
    // blowing the 8s budget on House (donorFetchError) and silently truncating
    // Senate at the fetchAllRows maxRows:50000 ceiling (the FIX-476 class:
    // "2,480 donors / $40.5M" was a partial result; the true set is 4,139). The
    // RPC collapses the per-donor SUM AND the institutional-only filter (exclude
    // individuals + the PAC/Committee placeholder) into one indexed aggregate —
    // prod-measured House ~3.8s / Senate ~0.7s, one round-trip. Keyset paging,
    // the originally-planned fix, was measured 73x SLOWER per page on prod (the
    // (to_id,id) row-value seek does not compose with to_id = ANY(batch)), so it
    // was dropped. See migration 20260605000001 + docs/FIXES.md FIX-499.
    let donorFetchError = false;

    // FIX-497 fail-closed contract preserved: the aggregate runs under the same
    // DONOR_FETCH_BUDGET_MS race, and an RPC error OR a budget overrun sets
    // donorFetchError + returns a partial-with-flag payload — never a silent
    // donorCount:0. donorFetchError still distinguishes "this cohort genuinely
    // has no institutional donors" (empty rows, no error) from "the aggregation
    // timed out / errored".
    type DonorTotalsRow = {
      financial_entity_id: string;
      entity_name: string;
      entity_type: string;
      total_cents: number;
      member_count: number;
    };
    // Async IIFE → a real Promise (supabase's .rpc().then() is only PromiseLike,
    // which raceWithBudget's Promise<T> param won't accept).
    const donorWork = (async (): Promise<{ rows: DonorTotalsRow[]; fetchFailed: boolean }> => {
      const { data, error } = await supabase.rpc("get_group_donor_totals", { p_official_ids: memberIds });
      if (error) {
        console.error(`[graph/group] get_group_donor_totals error: ${error.message}`);
        return { rows: [], fetchFailed: true };
      }
      // A PostgREST schema-cache cold-start can return null data with no error —
      // treat null (NOT []) as a fetch failure, never as "this cohort has no donors".
      if (data == null) {
        console.error("[graph/group] get_group_donor_totals returned null (schema-cache cold-start?)");
        return { rows: [], fetchFailed: true };
      }
      return { rows: data as DonorTotalsRow[], fetchFailed: false };
    })();
    const { value: donorAgg } = await raceWithBudget<{ rows: DonorTotalsRow[]; fetchFailed: boolean }>(
      donorWork,
      DONOR_FETCH_BUDGET_MS,
      "group-donor-totals",
      () => ({ rows: [], fetchFailed: true }),
    );
    if (donorAgg.fetchFailed) donorFetchError = true;
    // The RPC returns EVERY institutional donor (no row cap), already filtered
    // and ordered by total DESC, so donorRows.length is the exact distinct-
    // institutional-donor count — no maxRows truncation, no per-donor FE fan-out.
    const donorRows = donorAgg.rows;

    // Resolve industry/sector tags for just the displayed top-N (entity_tags,
    // FIX-167) — not the full donor set. A tag-lookup failure is cosmetic and
    // must NOT blank the bubble or set donorFetchError: the money totals are
    // valid; fall through with null sectors.
    const topDonorRows = donorRows.slice(0, limit);
    let sectorByEntityId = new Map<string, { tag: string; display_label: string }>();
    if (topDonorRows.length > 0) {
      try {
        sectorByEntityId = await fetchIndustryTagsByEntityId(
          supabase,
          topDonorRows.map((r) => r.financial_entity_id),
        );
      } catch (err) {
        console.error(
          `[graph/group] industry tag lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const topDonors = topDonorRows.map((r) => ({
      donorId:     r.financial_entity_id,
      donorName:   r.entity_name,
      totalUsd:    (r.total_cents ?? 0) / 100,
      memberCount: r.member_count,
      sector:      sectorByEntityId.get(r.financial_entity_id)?.display_label ?? null,
    }));

    // Group node represents the whole cohort as a single graph node
    const groupNode: ResponseNode = {
      id: groupId,
      name: groupNameOut,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIconOut,
        color: groupColorOut,
        memberCount: memberCount ?? 0,
        isGroup: true,
        // FIX-497 — surfaced on the node so the renderer can show a degraded
        // "donor data unavailable — retry" state on the bubble itself.
        donorFetchError,
      },
    };

    const connectedNodes: ResponseNode[] = topDonors.map((donor) => ({
      id: `donor-${donor.donorId}`,
      name: donor.donorName,
      type: "financial" as NodeType,
      collapsed: false,
      metadata: { sector: donor.sector },
    }));

    const edges: ResponseEdge[] = topDonors.map((donor) => ({
      id: `edge-${groupId}-${donor.donorId}`,
      fromId: `donor-${donor.donorId}`,
      toId: groupId,
      connectionType: "donation",
      amountUsd: donor.totalUsd,
      strength: Math.min(donor.totalUsd / 1_000_000, 1),
      metadata: {
        memberCount: donor.memberCount,
        pctOfGroup: memberCount
          ? Math.round((donor.memberCount / memberCount) * 100)
          : 0,
      },
    }));

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupNameOut,
        icon: groupIconOut,
        color: groupColorOut,
        count: memberCount ?? 0,
        filter: { entity_type: entityType, chamber, party, state, committeeId, governingBody },
      },
      nodes: [groupNode, ...connectedNodes],
      edges,
      meta: {
        memberCount:      memberCount ?? 0,
        // FIX-499 — exact distinct-institutional-donor count straight from the
        // RPC result set (no maxRows truncation). On a donorFetchError this is 0
        // and the client must read donorFetchError, not treat 0 as "no donors".
        donorCount:       donorRows.length,
        topDonorsShown:   topDonors.length,
        totalDonatedUsd:  topDonors.reduce((s, d) => s + d.totalUsd, 0),
        // FIX-497 — true when the donor aggregation timed out or errored. The
        // client renders a degraded "retry" state instead of treating
        // donorCount:0 as "this group has no donors". memberCount stays valid.
        donorFetchError,
        // FIX-490 — roster-pollution canary; true when resolved members exceed
        // the gb's seat_count × 1.2. Advisory only (never gates the response).
        seatCanaryTripped,
      },
    });
  }

  // ── PAC group mode ───────────────────────────────────────────────────────────
  // Which officials received the most money from PACs in this industry?

  if (entityType === "pac") {
    // Step 1: find the PAC financial_entities tagged with this industry.
    // Industry filter comes from `entity_tags.tag` now (FIX-167) — the legacy
    // `financial_entities.industry` column was dropped.
    const taggedIds = industry ? await fetchEntityIdsByIndustryTag(supabase, industry) : [];

    const pacEntitiesRows: Array<{ id: string; display_name: string }> = [];
    if (taggedIds.length > 0) {
      const BATCH_FILTER = 200;
      for (let i = 0; i < taggedIds.length; i += BATCH_FILTER) {
        const batch = taggedIds.slice(i, i + BATCH_FILTER);
        const { data } = await withDbTimeout<{
          data: Array<{ id: string; display_name: string }> | null;
          error: { message: string } | null;
        }>(
          supabase
            .from("financial_entities")
            .select("id, display_name")
            .eq("entity_type", "pac")
            .in("id", batch)
            .not("display_name", "ilike", "%PAC/Committee%"),
        );
        if (data) pacEntitiesRows.push(...data);
      }
    }

    const pacIds = pacEntitiesRows.map((p) => p.id);

    // Step 2: pull their donations to officials via entity_connections
    // (pre-aggregated, indexed) rather than financial_relationships.
    // FIX-497 — same fail-closed contract as the official branch: a swallowed
    // page timeout must flag, not ship an empty recipient list as "no money".
    let donorFetchError = false;
    const pacData: Array<{ to_id: string; amount_cents: number | null }> = [];
    if (pacIds.length > 0) {
      const BATCH = 200;
      const pacChunks: string[][] = [];
      for (let i = 0; i < pacIds.length; i += BATCH)
        pacChunks.push(pacIds.slice(i, i + BATCH));

      // FIX-476 — PAC→official donations, also SUMmed downstream. The prior
      // `.limit(5000)` was silently capped to 1000 (and had no ORDER BY, so the
      // kept rows were an arbitrary slice). Page the full set with a stable key.
      // FIX-497 — page errors / JS-budget overrun now surface via fetchFailed
      // instead of `for (const r of pacResults) pacData.push(...r.rows)` dropping
      // the per-page error. A timed-out recipient aggregation flags rather than
      // shipping an empty "no PAC recipients" payload.
      const pacFetch = await fetchPagedConnections<{ to_id: string; amount_cents: number | null }>(
        pacChunks.map((batch) => (f: number, t: number) =>
          supabase
            .from("entity_connections")
            .select("to_id, amount_cents")
            .eq("connection_type", "donation")
            .eq("from_type", "financial_entity")
            .in("from_id", batch)
            .eq("to_type", "official")
            .order("id", { ascending: true })
            .range(f, t),
        ),
        DONOR_FETCH_BUDGET_MS,
        "pac-donations",
      );
      if (pacFetch.fetchFailed) donorFetchError = true;
      pacData.push(...pacFetch.rows);
    }

    const officialMap = new Map<string, {
      officialId: string;
      totalUsd: number;
      pacCount: number;
    }>();

    for (const row of pacData) {
      const id  = row.to_id;
      const usd = (row.amount_cents ?? 0) / 100;

      if (officialMap.has(id)) {
        const ex = officialMap.get(id)!;
        ex.totalUsd  += usd;
        ex.pacCount  += 1;
      } else {
        officialMap.set(id, { officialId: id, totalUsd: usd, pacCount: 1 });
      }
    }

    const topRecipients = [...officialMap.values()]
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, limit);

    const officialIds = topRecipients.map((r) => r.officialId);

    type OfficialRow = { id: string; full_name: string; party: string | null; metadata: Record<string, unknown> | null };
    const { data: officialsData, error: officialsErr } = officialIds.length > 0
      ? await supabase
          .from("officials")
          .select("id, full_name, party, metadata")
          .in("id", officialIds)
      : { data: [] as OfficialRow[], error: null };
    if (officialsErr) {
      donorFetchError = true;
      console.error(`[graph/group] pac recipient lookup error: ${officialsErr.message}`);
    }

    const officialLookup = new Map(
      (officialsData ?? []).map((o) => [o.id, o as OfficialRow])
    );

    const groupNode: ResponseNode = {
      id: groupId,
      name: groupName,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIcon,
        color: groupColor,
        memberCount: officialMap.size,
        isGroup: true,
        isPacGroup: true,
        donorFetchError, // FIX-497
      },
    };

    const connectedNodes: ResponseNode[] = topRecipients.map((r) => {
      const official = officialLookup.get(r.officialId);
      return {
        id: r.officialId,
        name: official?.full_name ?? "Unknown",
        type: "official" as NodeType,
        collapsed: false,
        metadata: {
          party: official?.party,
          state: (official?.metadata as Record<string, unknown> | null)?.state,
        },
      };
    });

    // Edges flow from group to officials — PAC industry → recipients
    const edges: ResponseEdge[] = topRecipients.map((r) => ({
      id: `edge-${groupId}-${r.officialId}`,
      fromId: groupId,
      toId: r.officialId,
      connectionType: "donation",
      amountUsd: r.totalUsd,
      strength: Math.min(r.totalUsd / 100_000, 1),
      metadata: { pacCount: r.pacCount },
    }));

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupName,
        icon: groupIcon,
        color: groupColor,
        count: officialMap.size,
        filter: { entity_type: entityType, industry },
      },
      nodes: [groupNode, ...connectedNodes],
      edges,
      meta: {
        totalPacDonors:      officialMap.size,
        topRecipientsShown:  topRecipients.length,
        totalDonatedUsd:     topRecipients.reduce((s, r) => s + r.totalUsd, 0),
        donorFetchError, // FIX-497 — connection aggregation timed out / errored
      },
    });
  }

  // ── Proposal/topic-tag group mode (FIX-137) ───────────────────────────────
  // Surface a single group node carrying memberCount. Drill-down into the
  // member proposals and their connections (votes, sponsorships) is a future
  // enhancement — for now the tag bubble is the visible artifact and the
  // count is what the user reads.

  if (entityType === "proposal") {
    if (!tag) {
      return NextResponse.json(
        { error: "tag query param required for entity_type=proposal" },
        { status: 400 },
      );
    }

    const { count: rawCount } = await supabase
      .from("entity_tags")
      .select("entity_id", { count: "exact", head: true })
      .eq("entity_type", "proposal")
      .eq("tag_category", "topic")
      .eq("tag", tag)
      .neq("visibility", "internal");

    const memberCount = rawCount ?? 0;

    const groupNode: ResponseNode = {
      id: groupId,
      name: groupName,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIcon,
        color: groupColor,
        memberCount,
        isGroup: true,
        isTagGroup: true,
        tag,
      },
    };

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupName,
        icon: groupIcon,
        color: groupColor,
        count: memberCount,
        filter: { entity_type: entityType, tag },
      },
      nodes: [groupNode],
      edges: [],
      meta: { memberCount, tag },
    });
  }

  // ── Agency group mode ────────────────────────────────────────────────────────
  // Show which governing bodies (congressional committees) oversee the agencies
  // in this group. Oversight edges live in entity_connections where
  // from_type='governing_body', to_type='agency', connection_type='oversight'.

  if (entityType === "agency") {
    const { data: agencyData, count: agencyCount } = await withDbTimeout<{
      data: Array<{ id: string }> | null;
      count: number | null;
      error: { message: string } | null;
    }>(
      supabase
        .from("agencies")
        .select("id", { count: "exact" })
        .eq("is_active", true)
        .limit(1000)
    );

    const agencyIds = (agencyData ?? []).map(a => a.id);

    if (agencyIds.length === 0) {
      return NextResponse.json({
        group: { id: groupId, name: groupName, count: 0 },
        nodes: [],
        edges: [],
      });
    }

    // FIX-497 — same fail-closed contract for the agency branch's connection
    // fetch (oversight edges). `donorFetchError` here means "oversight
    // aggregation timed out / errored", so the client degrades instead of
    // treating an empty overseer set as "no oversight".
    let donorFetchError = false;

    // Fetch oversight edges for all agencies in parallel batches
    const AG_BATCH = 500;
    const agChunks: string[][] = [];
    for (let i = 0; i < agencyIds.length; i += AG_BATCH)
      agChunks.push(agencyIds.slice(i, i + AG_BATCH));

    // Propagate the per-page error (previously dropped by `r.data ?? []`) and
    // bound the aggregation with the JS budget.
    const oversightWork = Promise.all(
      agChunks.map(batch =>
        supabase
          .from("entity_connections")
          .select("from_id, strength")
          .eq("connection_type", "oversight")
          .eq("to_type", "agency")
          .in("to_id", batch)
      )
    ).then((results) => {
      const errored = results.find((r) => r.error != null);
      if (errored) console.error(`[graph/group] agency oversight error: ${errored.error?.message}`);
      return {
        rows: results.flatMap((r) => r.data ?? []) as Array<{ from_id: string; strength: number }>,
        failed: results.some((r) => r.error != null),
      };
    });
    const { value: oversight, timedOut: oversightTimedOut } = await raceWithBudget(
      oversightWork,
      DONOR_FETCH_BUDGET_MS,
      "agency-oversight",
      () => ({ rows: [] as Array<{ from_id: string; strength: number }>, failed: true }),
    );
    if (oversightTimedOut || oversight.failed) donorFetchError = true;
    const oversightRows: Array<{ from_id: string; strength: number }> = oversight.rows;

    // Aggregate by overseer (governing_body): count agencies each oversees
    const overseerMap = new Map<string, { agencyCount: number; totalStrength: number }>();
    for (const row of oversightRows) {
      const ex = overseerMap.get(row.from_id);
      if (ex) {
        ex.agencyCount     += 1;
        ex.totalStrength   += (row.strength ?? 0.7);
      } else {
        overseerMap.set(row.from_id, { agencyCount: 1, totalStrength: (row.strength ?? 0.7) });
      }
    }

    const topOverseers = [...overseerMap.entries()]
      .sort((a, b) => b[1].agencyCount - a[1].agencyCount)
      .slice(0, limit);

    const overseerIds = topOverseers.map(([id]) => id);
    type GovBodyRow = { id: string; name: string; metadata: Record<string, unknown> | null };
    const { data: overseerData, error: overseerErr } = overseerIds.length > 0
      ? await supabase
          .from("governing_bodies")
          .select("id, name, metadata")
          .in("id", overseerIds)
      : { data: [] as GovBodyRow[], error: null };
    if (overseerErr) {
      donorFetchError = true;
      console.error(`[graph/group] overseer lookup error: ${overseerErr.message}`);
    }

    const overseerLookup = new Map(
      (overseerData ?? []).map(g => [g.id, g as GovBodyRow])
    );

    const agencyGroupNode: ResponseNode = {
      id: groupId,
      name: groupName,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIcon,
        color: groupColor,
        memberCount: agencyCount ?? 0,
        isGroup: true,
        isAgencyGroup: true,
        donorFetchError, // FIX-497
      },
    };

    // governing_body maps to 'agency' node type in the V2 type system
    const overseerNodes: ResponseNode[] = topOverseers.map(([id, stats]) => {
      const g = overseerLookup.get(id);
      return {
        id,
        name: g?.name ?? "Unknown Committee",
        type: "agency" as NodeType,
        collapsed: false,
        metadata: {
          chamber: (g?.metadata as Record<string, unknown> | null)?.chamber,
          agencyCount: stats.agencyCount,
        },
      };
    });

    const overseerEdges: ResponseEdge[] = topOverseers.map(([id, stats]) => ({
      id: `edge-${groupId}-${id}`,
      fromId: id,
      toId: groupId,
      connectionType: "oversight",
      strength: Math.min(stats.totalStrength, 1),
      metadata: { agencyCount: stats.agencyCount },
    }));

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupName,
        icon: groupIcon,
        color: groupColor,
        count: agencyCount ?? 0,
        filter: { entity_type: entityType },
      },
      nodes: [agencyGroupNode, ...overseerNodes],
      edges: overseerEdges,
      meta: {
        agencyCount:      agencyCount ?? 0,
        overseersShown:   topOverseers.length,
        donorFetchError, // FIX-497 — oversight aggregation timed out / errored
      },
    });
  }

  return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
}
