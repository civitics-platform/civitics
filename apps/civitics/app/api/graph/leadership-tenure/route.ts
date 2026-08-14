import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import { fetchChunkedByIds } from "@/lib/paginate";

export const dynamic = "force-dynamic";

/**
 * /api/graph/leadership-tenure?agencyId=X — FIX-217 / FIX-218
 *
 * Returns one row per agency-leadership appointment, suitable for the
 * Tenure Gantt viz. Reads entity_connections WHERE connection_type =
 * 'appointment' AND to_id = $agencyId. Each row carries metadata.start_date,
 * metadata.end_date, metadata.position_title (FIX-209/215).
 *
 * official_id / official_name come from a join against the officials table.
 */

interface ResponseRow {
  officialId: string;
  officialName: string;
  positionTitle: string;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  party: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConnectionMetadata {
  start_date?: string | null;
  end_date?: string | null;
  position_title?: string | null;
  is_current?: boolean | null;
}

interface ConnectionRow {
  from_id: string;
  metadata: ConnectionMetadata | null;
}

interface OfficialRow {
  id: string;
  full_name: string;
  party: string | null;
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("agencyId");
  if (!raw || !UUID_RE.test(raw)) {
    return NextResponse.json({ error: "agencyId required (uuid)" }, { status: 400 });
  }
  const agencyId = raw;

  // Pull all appointment connections to this agency.
  // Note: per FIX-211 the canonical direction is from_type='official' →
  // to_type='agency' for appointment edges.
  const { data: conns, error: cErr } = await supabase
    .from("entity_connections")
    .select("from_id, metadata")
    .eq("connection_type", "appointment")
    .eq("from_type", "official")
    .eq("to_type", "agency")
    .eq("to_id", agencyId)
    .limit(500);

  if (cErr) {
    console.error("[leadership-tenure] connections fetch:", cErr.message);
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }

  const conRows = (conns ?? []) as ConnectionRow[];
  if (conRows.length === 0) return withPublicCdnCache(NextResponse.json([]));

  // FIX-902: chunked. The appointment-edge read above is capped at 500 rows,
  // so this list reaches 500 distinct officials — 2.5× the URL bound. The
  // busiest agency carries 810 appointment edges on the local clone, i.e. the
  // cap is the only thing holding it down. Non-strict: an unresolved official
  // renders as an unnamed tenure bar rather than a failed panel.
  const officialIds = [...new Set(conRows.map(r => r.from_id))];
  const { rows: officials, complete } = await fetchChunkedByIds<OfficialRow>(
    officialIds,
    (ids) => supabase.from("officials").select("id, full_name, party").in("id", ids),
    { label: "leadership-tenure:official-names" },
  );
  if (!complete) console.error("[leadership-tenure] official name read incomplete — some rows unnamed");
  const officialMap = new Map<string, OfficialRow>();
  for (const o of officials) officialMap.set(o.id, o);

  const rows: ResponseRow[] = conRows.map((c) => {
    const meta: ConnectionMetadata = c.metadata ?? {};
    const o = officialMap.get(c.from_id);
    return {
      officialId:    c.from_id,
      officialName:  o?.full_name ?? "Unknown",
      positionTitle: meta.position_title ?? "Leader",
      startDate:     meta.start_date ?? null,
      endDate:       meta.end_date ?? null,
      isCurrent:     Boolean(meta.is_current),
      party:         o?.party ?? null,
    };
  });

  // Sort: current first, then by most recent start date desc
  rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const sa = a.startDate ? Date.parse(a.startDate) : 0;
    const sb = b.startDate ? Date.parse(b.startDate) : 0;
    return sb - sa;
  });

  return withPublicCdnCache(NextResponse.json(rows, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  }));
}
