import { createAdminClient, fetchIndustryTagsByEntityId, fetchEntityIdsByIndustryTag } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

interface TreemapRow {
  official_id: string;
  official_name: string;
  party: string;
  state: string;
  chamber: string;
  total_donated_cents: number;
  connection_count: number;
  vote_count: number;
}

export interface DonorRow {
  donor_id: string;
  donor_name: string;
  industry_category: string;
  amount_usd: number;
  entity_type: string;
}

export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const supabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const entityId = searchParams.get("entityId");
  // FIX-185 — Cohort × Filter: when an industry filter is supplied alongside
  // the cohort filters, restrict donation aggregation to donors tagged with
  // that industry. Answers questions like "which Senate Democrats got the
  // most money from Finance PACs?" Falls through to the current behavior
  // when unset — no breaking change.
  const industryFilter = searchParams.get("industry_filter");

  // FIX-220 — user-controlled donation floor. Filters donor leaves
  // (entity mode) and official cohort rows (aggregate mode) by total ≥ floor.
  // Default 0 (show all). Forwarded by TreemapGraph from
  // view.connections.donation.minAmount.
  const minAmountUsd = Math.max(0, parseFloat(searchParams.get("minAmountUsd") ?? "0") || 0);
  const minAmountCents = minAmountUsd * 100;

  // Resolve filter PAC ids once. Used in both entity mode and aggregate mode.
  let filterPacIds: string[] | null = null;
  if (industryFilter) {
    filterPacIds = await fetchEntityIdsByIndustryTag(supabase, industryFilter);
    if (filterPacIds.length === 0) {
      // No PACs tagged with this industry — return empty result rather than
      // running a query against an empty .in() filter (which PostgREST may
      // mis-interpret as "match anything").
      return Response.json([], {
        headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" },
      });
    }
  }

  // Validate UUID format — reject group IDs like 'group-pac-finance'
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validEntityId = entityId && UUID_RE.test(entityId) ? entityId : null;

  // ── Entity mode: donors for one official ─────────────────────────────────
  // get_official_donors RPC was retired in the shadow→public promotion.
  // Direct query: financial_relationships → aggregate by from_id → join financial_entities.
  if (validEntityId) {
    let donationsQuery = supabase
      .from("financial_relationships")
      .select("from_id, amount_cents")
      .eq("relationship_type", "donation")
      .eq("to_type", "official")
      .eq("to_id", validEntityId)
      .eq("from_type", "financial_entity");

    if (filterPacIds) donationsQuery = donationsQuery.in("from_id", filterPacIds);

    const { data: donations, error: donationsErr } = await donationsQuery;

    if (donationsErr) {
      console.error("[graph/treemap/entity] donations error:", donationsErr.message);
      return Response.json({ error: donationsErr.message }, { status: 500 });
    }

    const byDonor = new Map<string, number>();
    for (const d of donations ?? []) {
      byDonor.set(d.from_id, (byDonor.get(d.from_id) ?? 0) + (d.amount_cents ?? 0));
    }

    const donorIds = [...byDonor.keys()];
    const donorInfo = new Map<string, { name: string; entity_type: string | null }>();
    if (donorIds.length > 0) {
      const BATCH = 300;
      for (let i = 0; i < donorIds.length; i += BATCH) {
        const batch = donorIds.slice(i, i + BATCH);
        const { data: entities } = await supabase
          .from("financial_entities")
          .select("id, display_name, entity_type")
          .in("id", batch);
        for (const e of entities ?? []) {
          donorInfo.set(e.id, {
            name: e.display_name,
            entity_type: e.entity_type,
          });
        }
      }
    }

    const industryByEntityId = await fetchIndustryTagsByEntityId(supabase, donorIds);

    const rows: DonorRow[] = [];
    for (const [donorId, cents] of byDonor) {
      // FIX-220 — apply user donation floor before pushing the row.
      if (cents < minAmountCents) continue;
      const info = donorInfo.get(donorId);
      if (!info) continue;
      const industry = industryByEntityId.get(donorId);
      rows.push({
        donor_id: donorId,
        donor_name: info.name,
        industry_category: industry?.display_label ?? "Other",
        amount_usd: cents / 100,
        entity_type: info.entity_type ?? "financial",
      });
    }
    rows.sort((a, b) => b.amount_usd - a.amount_usd);

    return Response.json(rows, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" },
    });
  }

  // ── Aggregate mode: all officials by party / chamber ─────────────────────
  // groupBy and sizeBy are accepted for API compatibility and passed to the client.
  // Actual grouping is done client-side in TreemapGraph; chamber data is always returned.
  void searchParams.get("groupBy");  // accepted, used client-side
  void searchParams.get("sizeBy");   // accepted, used client-side

  const chamber = searchParams.get("chamber");
  const party   = searchParams.get("party");
  const state   = searchParams.get("state");

  // treemap_officials_by_donations RPC was retired in the shadow→public promotion.
  // Query the filtered officials + aggregate their donations app-side.
  // FIX-124: select source_ids + jurisdictions.short_name so we can derive
  // state with the same fallback chain the old RPC used. Pure metadata lookups
  // missed every federal Senator/Rep before the state_abbr backfill.
  // FIX-219: select total_received_cents (May 8 migration) so we can
  // skip the 1000-row-capped per-batch financial_relationships scan
  // unless an industry_filter is active. Generated DB types may lag the
  // migration on the dev box; cast through unknown to keep the strict
  // build green without regenerating types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let officialsQuery = (supabase as any)
    .from("officials")
    .select("id, full_name, party, role_title, metadata, source_ids, total_received_cents, jurisdictions:jurisdiction_id(short_name)")
    .eq("is_active", true);

  if (chamber === "senate") officialsQuery = officialsQuery.eq("role_title", "Senator");
  else if (chamber === "house") officialsQuery = officialsQuery.eq("role_title", "Representative");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (party) officialsQuery = officialsQuery.eq("party", party as any);
  if (state) {
    // Match either metadata field — they're kept in sync by the FIX-124 backfill
    // but accept both for robustness.
    officialsQuery = officialsQuery.or(`metadata->>state.eq.${state},metadata->>state_abbr.eq.${state}`);
  }

  const { data: officials, error: officialsErr } = await officialsQuery.limit(1000);
  if (officialsErr) {
    console.error("[graph/treemap] officials error:", officialsErr.message);
    return Response.json({ error: officialsErr.message }, { status: 500 });
  }

  const VALID_STATES = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC","PR","GU","VI","AS","MP",
  ]);
  function deriveState(
    metadata: Record<string, unknown> | null,
    sourceIds: Record<string, unknown> | null,
    jurShortName: string | null,
  ): string {
    const meta = metadata ?? {};
    if (typeof meta["state_abbr"] === "string" && meta["state_abbr"]) return meta["state_abbr"] as string;
    if (typeof meta["state"]      === "string" && meta["state"])      return meta["state"]      as string;
    if (jurShortName && jurShortName.length === 2 && VALID_STATES.has(jurShortName)) return jurShortName;
    const cand = (sourceIds?.["fec_candidate_id"] as string | undefined) ?? "";
    if (/^[SH][0-9][A-Z]{2}/.test(cand)) {
      const code = cand.substring(2, 4);
      if (VALID_STATES.has(code)) return code;
    }
    return "";
  }

  const officialById = new Map<string, {
    full_name: string;
    party: string | null;
    role_title: string | null;
    state: string;
    total_received_cents: number;
  }>();
  for (const o of officials ?? []) {
    // jurisdictions:jurisdiction_id(short_name) collapses to a single object
    // because jurisdiction_id is a singular FK.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jur = (o as any).jurisdictions as { short_name: string | null } | null;
    officialById.set(o.id, {
      full_name: o.full_name,
      party: o.party,
      role_title: o.role_title,
      state: deriveState(
        o.metadata as Record<string, unknown> | null,
        o.source_ids as Record<string, unknown> | null,
        jur?.short_name ?? null,
      ),
      // FIX-219: read the denormalized total instead of re-aggregating
      // financial_relationships per-batch. The previous per-batch query
      // capped at 1000 rows (PostgREST default) and silently dropped
      // donations for officials whose rows didn't make the cut — e.g.
      // Senate Democrats showed $0 for everyone except Maria Cantwell
      // because her rows happened to be in the first 1000 returned.
      total_received_cents: Number(o.total_received_cents ?? 0),
    });
  }

  // FIX-172/177: aggregate donation totals + entity_connections counts per official
  // in parallel batches. We iterate officialById (the full filtered set) to build
  // rows so officials with $0 donations still appear — required for "Full Senate"
  // to render all 100 senators when most have no FEC seed yet. sizeBy controls
  // (connection_count, vote_count) need real data so users can pick a meaningful
  // size when donations are sparse.
  const VOTE_CONN_TYPES = new Set([
    "vote_yes", "vote_no", "vote_abstain",
    "nomination_vote_yes", "nomination_vote_no",
  ]);

  const totalByOfficial = new Map<string, number>();
  const connByOfficial  = new Map<string, number>();
  const votesByOfficial = new Map<string, number>();

  const officialIds = [...officialById.keys()];

  // FIX-219: default donations source is the denormalized
  // officials.total_received_cents (refreshed by
  // rebuild_official_donation_totals_full()). Only run a real
  // financial_relationships scan when an industry_filter is set, since
  // that requires donor-side filtering not encoded in the precomputed
  // total. The scan uses range() pagination to defeat the 1000-row
  // PostgREST default that produced the original Cantwell-only result.
  if (!filterPacIds) {
    for (const [id, o] of officialById) {
      totalByOfficial.set(id, o.total_received_cents);
    }
  } else if (officialIds.length > 0) {
    const PAGE = 1000;
    const BATCH = 200;
    for (let i = 0; i < officialIds.length; i += BATCH) {
      const batch = officialIds.slice(i, i + BATCH);
      let from = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data } = await supabase
          .from("financial_relationships")
          .select("to_id, amount_cents")
          .eq("relationship_type", "donation")
          .eq("to_type", "official")
          .in("to_id", batch)
          .in("from_id", filterPacIds)
          .range(from, from + PAGE - 1);
        if (!data || data.length === 0) break;
        for (const d of data) {
          totalByOfficial.set(d.to_id, (totalByOfficial.get(d.to_id) ?? 0) + (d.amount_cents ?? 0));
        }
        if (data.length < PAGE) break;
        from += PAGE;
        if (from > 200_000) break; // safety guard
      }
    }
  }

  // Connection counts and vote counts — paginate the same way.
  if (officialIds.length > 0) {
    const PAGE = 1000;
    const BATCH = 200;
    for (let i = 0; i < officialIds.length; i += BATCH) {
      const batch = officialIds.slice(i, i + BATCH);

      const accumulate = async (
        column: "from_id" | "to_id",
        typeColumn: "from_type" | "to_type",
        target: Map<string, number>,
        voteTarget: Map<string, number>,
      ) => {
        let from = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { data } = await supabase
            .from("entity_connections")
            .select(`${column}, connection_type`)
            .eq(typeColumn, "official")
            .in(column, batch)
            .range(from, from + PAGE - 1);
          if (!data || data.length === 0) break;
          for (const r of data as Array<Record<string, string>>) {
            const id = r[column];
            if (!id) continue;
            target.set(id, (target.get(id) ?? 0) + 1);
            if (VOTE_CONN_TYPES.has(r.connection_type as string)) {
              voteTarget.set(id, (voteTarget.get(id) ?? 0) + 1);
            }
          }
          if (data.length < PAGE) break;
          from += PAGE;
          if (from > 200_000) break;
        }
      };

      await Promise.all([
        accumulate("from_id", "from_type", connByOfficial, votesByOfficial),
        accumulate("to_id",   "to_type",   connByOfficial, votesByOfficial),
      ]);
    }
  }

  const rows: TreemapRow[] = [];
  for (const [officialId, o] of officialById) {
    const total = totalByOfficial.get(officialId) ?? 0;
    // FIX-220 — apply user donation floor against per-official aggregate.
    if (total < minAmountCents) continue;
    rows.push({
      official_id: officialId,
      official_name: o.full_name,
      party: o.party ?? "Unknown",
      state: o.state,
      chamber: o.role_title === "Senator" ? "senate" : o.role_title === "Representative" ? "house" : (o.role_title ?? ""),
      total_donated_cents: total,
      connection_count:    connByOfficial.get(officialId)  ?? 0,
      vote_count:          votesByOfficial.get(officialId) ?? 0,
    });
  }
  rows.sort((a, b) => b.total_donated_cents - a.total_donated_cents);

  // Cap unfiltered "all officials" view (local dev has 9k+ officials per FIX-113);
  // chamber-filtered queries are already bounded (100 senators, 435 reps) so no
  // implicit cap there.
  const top = chamber ? rows : rows.slice(0, 500);

  return Response.json(top, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" },
  });
}
