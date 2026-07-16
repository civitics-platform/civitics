import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

/**
 * /api/graph/small-dollar?entityId=X — FIX-218
 *
 * Returns the focused official's small-dollar dependency: the fraction
 * of total donations received in amounts under $500 (the federal
 * itemization threshold; donations under this are considered grassroots).
 *
 *   small_dollar_share = SUM(amount_cents WHERE amount_cents < 50000)
 *                       / officials.total_received_cents
 *
 * Powers the "Small-Dollar Dependency" preset.
 */

interface ResponseShape {
  officialId: string;
  officialName: string;
  totalReceivedCents: number;
  smallDollarCents: number;
  smallDollarShare: number;     // 0–1
  smallDollarCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SMALL_DOLLAR_CENTS_LIMIT = 50_000; // $500

interface DonationLite { amount_cents: number | null }
interface OfficialRow  { id: string; full_name: string; total_received_cents: number | null }

// FIX-776 live-compute fallback: paginate every small-dollar donation row for the
// official and sum. This is the pre-materialization request-path aggregation; it
// stays as the per-entity fallback for a rollup miss (an official absent from
// official_small_dollar_rollup — e.g. not yet backfilled, or with zero donations)
// so nothing 500s / blanks. PostgREST caps responses at 1000, so page until a
// partial page; small-dollar volumes can run into the hundreds of thousands.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeSmallDollarLive(supabase: any, entityId: string): Promise<{ cents: number; count: number }> {
  let allRows: DonationLite[] = [];
  let from = 0;
  const PAGE = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await supabase
      .from("financial_relationships")
      .select("amount_cents")
      .eq("relationship_type", "donation")
      .eq("to_type", "official")
      .eq("to_id", entityId)
      .lt("amount_cents", SMALL_DOLLAR_CENTS_LIMIT)
      .gt("amount_cents", 0)
      // FIX-503: stable pkey order — .range() is OFFSET pagination; without an
      // ORDER BY the small-dollar sum could double-count or skip rows.
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data as DonationLite[]);
    if (data.length < PAGE) break;
    from += PAGE;
    if (allRows.length > 200_000) break; // safety guard
  }
  let cents = 0;
  for (const r of allRows) cents += r.amount_cents ?? 0;
  return { cents, count: allRows.length };
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("entityId");
  if (!raw || !UUID_RE.test(raw)) {
    return NextResponse.json({ error: "entityId required (uuid)" }, { status: 400 });
  }
  const entityId = raw;

  const { data: official, error: oErr } = await supabase
    .from("officials")
    .select("id, full_name, total_received_cents")
    .eq("id", entityId)
    .maybeSingle();
  if (oErr) {
    console.error("[small-dollar] official fetch:", oErr.message);
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  if (!official) {
    return NextResponse.json({ error: "official not found" }, { status: 404 });
  }
  const o = official as OfficialRow;

  // FIX-776: read the materialized per-official small-dollar summary
  // (official_small_dollar_rollup, maintained incrementally on the FIX-704 donor
  // dirty set). PK point read; falls through to the live pagination sum on a miss
  // (official absent — not yet backfilled, or no donations) so nothing blanks.
  let smallDollarCents: number;
  let smallDollarCount: number;
  const { data: rollup, error: rErr } = await supabase
    .from("official_small_dollar_rollup")
    .select("small_dollar_cents, small_dollar_count")
    .eq("official_id", entityId)
    .maybeSingle();
  if (!rErr && rollup) {
    smallDollarCents = Number(rollup.small_dollar_cents ?? 0);
    smallDollarCount = Number(rollup.small_dollar_count ?? 0);
  } else {
    if (rErr) console.error("[small-dollar] rollup read (falling back to live):", rErr.message);
    const live = await computeSmallDollarLive(supabase, entityId);
    smallDollarCents = live.cents;
    smallDollarCount = live.count;
  }

  const totalReceivedCents = o.total_received_cents ?? 0;
  const smallDollarShare =
    totalReceivedCents > 0 ? smallDollarCents / totalReceivedCents : 0;

  const body: ResponseShape = {
    officialId:        o.id,
    officialName:      o.full_name,
    totalReceivedCents,
    smallDollarCents,
    smallDollarShare,
    smallDollarCount,
  };
  return withPublicCdnCache(NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
  }));
}
