import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient, afterKey } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

/**
 * /api/graph/small-dollar?entityId=X — FIX-218, corrected by FIX-1068.
 *
 * Returns the focused official's small-dollar dependency. Powers the
 * "Small-Dollar Dependency" preset.
 *
 * ── What "small dollar" means here, precisely ────────────────────────────────
 * There are TWO populations, and until FIX-1068 this route conflated them and
 * reported the wrong one under the right name.
 *
 *   ITEMIZED SMALL-DOLLAR — donors whose cycle aggregate with this official
 *     landed under $500. These have `financial_relationships` rows;
 *     `smallDollarCents` sums them.
 *
 *   SUB-FLOOR — donors whose cycle aggregate never reached FEC's $200
 *     itemization floor. Disclosed in the bulk file, but they emit NO FR row by
 *     design (PR 3b), so they are invisible to any query over
 *     financial_relationships. `subFloorCents` comes from
 *     small_dollar_bracket_rollup instead.
 *
 * The bug FIX-1068 closes: before PR 3b the ingest applied the $200 threshold
 * PER TRANSACTION at parse time, so every FR row was built from $200-and-up
 * transactions. `amount_cents < 50000` therefore selected the $200–$500 band and
 * nothing below it — "small dollar" pointed down while the data pointed up, and
 * the entire sub-$200 population it claims to describe was absent by
 * construction. Post-3b an indiv FR amount IS a donor cycle aggregate, so the
 * itemized band is honest; the sub-floor half arrives via the bracket rollup.
 *
 * ── Two shares, because two denominators ─────────────────────────────────────
 * `official_donor_totals.total_cents` (FIX-942; was
 * `officials.total_received_cents` until that column lost its writer) is derived
 * from FR rows, so it contains the itemized population and NOT the sub-floor
 * one. Adding the residual to the
 * numerator alone would inflate the share. So the route returns both, named for
 * what they measure, and leaves the choice to the caller:
 *
 *   smallDollarShare          = smallDollar / totalReceived
 *                               "of ITEMIZED receipts, how much is small-dollar"
 *   smallDollarShareWithSubFloor
 *                             = (smallDollar + subFloor) / (totalReceived + subFloor)
 *                               "of all DISCLOSED receipts we can see"
 *
 * Neither is a grassroots-share-of-everything: truly unitemized giving (a donor
 * who never crosses $200 and so never appears in the bulk file) is not in any
 * denominator available to us, and no rule change can recover it.
 */

interface ResponseShape {
  officialId: string;
  officialName: string;
  /** FR-derived. Excludes sub-floor money. */
  totalReceivedCents: number;
  /** Itemized donations whose amount (a donor cycle aggregate) is under $500. */
  smallDollarCents: number;
  smallDollarCount: number;
  /** FIX-1068: disclosed giving below the $200 itemization floor — no FR rows. */
  subFloorCents: number;
  /** (donor × official) groups behind subFloorCents. Groups, not distinct donors. */
  subFloorDonorCount: number;
  /** smallDollarCents / totalReceivedCents. Itemized population only. */
  smallDollarShare: number;     // 0–1
  /** (smallDollar + subFloor) / (totalReceived + subFloor). */
  smallDollarShareWithSubFloor: number;  // 0–1
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upper edge of the ITEMIZED small-dollar band. Not the itemization floor —
 *  that is $200 and lives in the ingest (indiv.ts MIN_AGGREGATE_CENTS). */
const SMALL_DOLLAR_CENTS_LIMIT = 50_000; // $500

interface DonationLite { amount_cents: number | null }
interface OfficialRow  { id: string; full_name: string }

// FIX-776 live-compute fallback: paginate every small-dollar donation row for the
// official and sum. This is the pre-materialization request-path aggregation; it
// stays as the per-entity fallback for a rollup miss (an official absent from
// official_small_dollar_rollup — e.g. not yet backfilled, or with zero donations)
// so nothing 500s / blanks. PostgREST caps responses at 1000, so page until a
// partial page; small-dollar volumes can run into the hundreds of thousands.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeSmallDollarLive(supabase: any, entityId: string): Promise<{ cents: number; count: number }> {
  let allRows: DonationLite[] = [];
  let afterId: string | null = null; // FIX-984: keyset cursor, not an OFFSET
  const PAGE = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // FIX-503 pinned the pkey order so the small-dollar sum cannot double-count
    // or skip; FIX-984 makes that same pkey the seek key so deep pages stop
    // re-walking every row before them.
    const { data }: { data: Array<{ id: string; amount_cents: number | null }> | null } =
      await afterKey(supabase
        .from("financial_relationships")
        .select("id, amount_cents")
        .eq("relationship_type", "donation")
        .eq("to_type", "official")
        .eq("to_id", entityId)
        .lt("amount_cents", SMALL_DOLLAR_CENTS_LIMIT)
        .gt("amount_cents", 0)
        .order("id", { ascending: true })
        .limit(PAGE), "id", afterId);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data as DonationLite[]);
    if (data.length < PAGE) break;
    afterId = data[data.length - 1]!.id;
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
    .select("id, full_name")
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
  // FIX-1068: the sub-floor half. Only the rollup can supply it — there is no
  // live-compute fallback, because the rows it summarizes do not exist in
  // financial_relationships by design. A rollup miss therefore reports 0 here,
  // which is honest ("we have not measured this official's sub-floor giving"),
  // not a silent undercount of something we could have computed.
  let subFloorCents = 0;
  let subFloorDonorCount = 0;
  const { data: rollup, error: rErr } = await supabase
    .from("official_small_dollar_rollup")
    .select("small_dollar_cents, small_dollar_count, sub_floor_cents, sub_floor_donor_count")
    .eq("official_id", entityId)
    .maybeSingle();
  if (!rErr && rollup) {
    smallDollarCents   = Number(rollup.small_dollar_cents ?? 0);
    smallDollarCount   = Number(rollup.small_dollar_count ?? 0);
    subFloorCents      = Number(rollup.sub_floor_cents ?? 0);
    subFloorDonorCount = Number(rollup.sub_floor_donor_count ?? 0);
  } else {
    if (rErr) console.error("[small-dollar] rollup read (falling back to live):", rErr.message);
    const live = await computeSmallDollarLive(supabase, entityId);
    smallDollarCents = live.cents;
    smallDollarCount = live.count;
  }

  // FIX-942 — the denominator comes from official_donor_totals, not from
  // officials.total_received_cents. Both sum the SAME quantity (FR rows with
  // to_type='official' AND relationship_type='donation'), but only the rollup
  // has a live writer: the column's last writer was retired when the nightly
  // moved to the FIX-836 bulk regime, so it has been frozen ever since. Prod
  // 2026-09-05: 4,131 officials disagree, $2,745,805,506 of |gap| — Jon Ossoff
  // rendered a 4.0x small-dollar share off a denominator $66.4M too low.
  // Missing rollup row = 0, which is the honest answer for an official with no
  // donations. Point read on the rollup's PK.
  const { data: totalsRow, error: tErr } = await supabase
    .from("official_donor_totals")
    .select("total_cents")
    .eq("official_id", entityId)
    .maybeSingle();
  if (tErr) console.error("[small-dollar] donor totals read (treating as 0):", tErr.message);
  const totalReceivedCents = Number(totalsRow?.total_cents ?? 0);
  const smallDollarShare =
    totalReceivedCents > 0 ? smallDollarCents / totalReceivedCents : 0;
  const disclosedCents = totalReceivedCents + subFloorCents;
  const smallDollarShareWithSubFloor =
    disclosedCents > 0 ? (smallDollarCents + subFloorCents) / disclosedCents : 0;

  const body: ResponseShape = {
    officialId:        o.id,
    officialName:      o.full_name,
    totalReceivedCents,
    smallDollarCents,
    smallDollarCount,
    subFloorCents,
    subFloorDonorCount,
    smallDollarShare,
    smallDollarShareWithSubFloor,
  };
  return withPublicCdnCache(NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
  }));
}
