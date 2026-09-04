import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient, afterKey } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { fetchChunkedByIds } from "@/lib/paginate";

export const dynamic = "force-dynamic";

/**
 * /api/graph/agency-staffing — FIX-217 / FIX-218
 *
 * Returns one row per agency with the dimensions needed for the "Agencies
 * by Staffing" scatter preset:
 *   - personnel_fte (OPM, FIX-214)
 *   - appointment count (entity_connections WHERE connection_type='appointment')
 *   - total_contract_cents / total_grant_cents (USASpending, FIX-194/114)
 *   - founded_year (Wikidata, FIX-208)
 *
 * Federal scope only by default; query param `agencyType` can switch.
 *
 * FIX-778: appointment/contract/grant aggregates are served from the
 * public.agency_staffing_rollup table (weekly recompute) instead of a live
 * per-request COUNT/SUM over entity_connections + the ~1.28M agency contract/
 * grant FR rows. The live aggregation below stays as the per-agency fallback for
 * agencies missing from the rollup (pre-backfill / brand-new). fte / founded_year
 * / name stay on the agencies table.
 */

interface ResponseRow {
  agencyId: string;
  agencyName: string;
  agencyAcronym: string | null;
  agencyType: string;
  fte: number;
  appointmentCount: number;
  contractTotal: number;   // cents
  grantTotal: number;      // cents
  foundedYear: number | null;
}

interface AgencyStats { appointmentCount: number; contractTotal: number; grantTotal: number }
interface RollupRow {
  agency_id: string;
  appointment_count: number | string | null;
  contract_cents: number | string | null;
  grant_cents: number | string | null;
}

// FIX-778 live-compute fallback: the pre-materialization per-agency aggregation
// over entity_connections (appointment COUNT) + financial_relationships (contract/
// grant SUM), batched by 100 agencyIds to dodge PostgREST URL-length limits
// (FIX-220) and paged (FIX-503 stable order). Kept as the per-agency fallback for
// agencies absent from agency_staffing_rollup so nothing 500s / renders 0 wrongly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeAgencyStatsLive(supabase: any, agencyIds: string[]): Promise<Map<string, AgencyStats>> {
  const out = new Map<string, AgencyStats>();
  const get = (id: string): AgencyStats => {
    let s = out.get(id);
    if (!s) { s = { appointmentCount: 0, contractTotal: 0, grantTotal: 0 }; out.set(id, s); }
    return s;
  };
  const BATCH = 100;
  const PAGE = 1000;
  for (let i = 0; i < agencyIds.length; i += BATCH) {
    const batch = agencyIds.slice(i, i + BATCH);

    // Appointment counts. Paginate in case a single agency has >1000 leaders.
    let afterApptId: string | null = null;
    let apptSeen = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // FIX-984: keyset on the entity_connections pkey (also the .order() key).
      const { data: appts, error: apptErr }: { data: Array<{ id: string; to_id: string }> | null; error: { message: string } | null } = await afterKey(supabase
        .from("entity_connections")
        .select("id, to_id")
        .eq("connection_type", "appointment")
        .eq("to_type", "agency")
        .in("to_id", batch)
        .order("id", { ascending: true })
        .limit(PAGE), "id", afterApptId);
      if (apptErr) { console.error("[agency-staffing] appts error:", apptErr.message); break; }
      if (!appts || appts.length === 0) break;
      for (const r of appts) get(r.to_id).appointmentCount += 1;
      apptSeen += appts.length;
      if (appts.length < PAGE) break;
      afterApptId = appts[appts.length - 1]!.id;
      if (apptSeen > 50_000) break; // safety
    }

    // Contract + grant totals.
    let afterSpendId: string | null = null;
    let spendSeen = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // FIX-984: keyset on the financial_relationships pkey.
      const { data: spendRows, error: spendErr }: { data: Array<{ id: string; from_id: string; amount_cents: number | null; relationship_type: string }> | null; error: { message: string } | null } = await afterKey(supabase
        .from("financial_relationships")
        .select("id, from_id, amount_cents, relationship_type")
        .eq("from_type", "agency")
        .in("from_id", batch)
        .in("relationship_type", ["contract", "grant"])
        .order("id", { ascending: true })
        .limit(PAGE), "id", afterSpendId);
      if (spendErr) { console.error("[agency-staffing] spend error:", spendErr.message); break; }
      if (!spendRows || spendRows.length === 0) break;
      for (const r of spendRows) {
        const s = get(r.from_id);
        if (r.relationship_type === "contract") s.contractTotal += (r.amount_cents ?? 0);
        else s.grantTotal += (r.amount_cents ?? 0);
      }
      spendSeen += spendRows.length;
      if (spendRows.length < PAGE) break;
      afterSpendId = spendRows[spendRows.length - 1]!.id;
      if (spendSeen > 200_000) break;
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const agencyType = searchParams.get("agencyType") ?? "federal";

  const { data: agencies, error: aErr } = await supabase
    .from("agencies")
    .select("id, name, acronym, short_name, agency_type, personnel_fte, founded_year")
    .eq("agency_type", agencyType)
    .eq("is_active", true)
    .limit(1000);

  if (aErr) {
    console.error("[agency-staffing] agencies fetch:", aErr.message);
    return NextResponse.json({ error: aErr.message }, { status: 500 });
  }
  if (!agencies || agencies.length === 0) {
    return withPublicCdnCache(NextResponse.json([]));
  }

  const agencyIds = agencies.map((a: { id: string }) => a.id);

  // FIX-778 fast path: read the materialized per-agency rollup. FIX-901 moved
  // the hand-rolled 200-id chunk loop onto the shared `fetchChunkedByIds`
  // (same URL-length bound). Non-strict: a failed chunk is reported via
  // `complete`, and this route already has a better answer than an error —
  // `rollupErr` sends EVERY agency down the live-compute fallback, exactly as
  // the old `break`-on-first-error did.
  const statByAgency = new Map<string, AgencyStats>();
  const { rows: rollupRows, complete } = await fetchChunkedByIds<RollupRow>(
    agencyIds,
    (ids) =>
      supabase
        .from("agency_staffing_rollup")
        .select("agency_id, appointment_count, contract_cents, grant_cents")
        .in("agency_id", ids),
    { label: "agency-staffing:rollup" },
  );
  const rollupErr = !complete;
  if (rollupErr) console.error("[agency-staffing] rollup read incomplete — falling back to live");
  for (const r of rollupRows) {
    statByAgency.set(r.agency_id, {
      appointmentCount: Number(r.appointment_count ?? 0),
      contractTotal:    Number(r.contract_cents ?? 0),
      grantTotal:       Number(r.grant_cents ?? 0),
    });
  }

  // Live fallback for agencies missing from the rollup (pre-backfill / brand-new),
  // or ALL agencies if the rollup read errored.
  const missing = rollupErr ? agencyIds : agencyIds.filter((id: string) => !statByAgency.has(id));
  if (missing.length > 0) {
    const live = await computeAgencyStatsLive(supabase, missing);
    for (const [id, s] of live) statByAgency.set(id, s);
  }

  const rows: ResponseRow[] = agencies.map((a: {
    id: string;
    name: string;
    acronym: string | null;
    short_name: string | null;
    agency_type: string;
    personnel_fte: number | null;
    founded_year: number | null;
  }) => {
    const s = statByAgency.get(a.id);
    return {
      agencyId:        a.id,
      agencyName:      a.name,
      agencyAcronym:   a.acronym ?? a.short_name ?? null,
      agencyType:      a.agency_type,
      fte:             a.personnel_fte ?? 0,
      appointmentCount: s?.appointmentCount ?? 0,
      contractTotal:   s?.contractTotal ?? 0,
      grantTotal:      s?.grantTotal ?? 0,
      foundedYear:     a.founded_year,
    };
  });

  return withPublicCdnCache(NextResponse.json(rows, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  }));
}
