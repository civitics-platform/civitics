// FIX-194 — Individual donor list for bracket node click-through.
//
// Called when a user clicks an individual_bracket node in the Force Graph.
// Returns the paginated list of real donors aggregated into that bracket,
// so they can be inspected or pinned as real graph nodes (option c).

import { createAdminClient } from "@civitics/db";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";
import { BRACKET_TIERS } from "@civitics/graph";

export const dynamic = "force-dynamic";

const LEGAL_SUFFIX_RE = /\b(incorporated|inc|llc|corp|corporation|l\.l\.c|co|company|the|plc|ltd|limited|lp|l\.p)\b\.?/gi;

function normalizeEmployer(raw: string): string {
  return raw
    .toUpperCase()
    .replace(LEGAL_SUFFIX_RE, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface IndividualDonorRow {
  id: string;
  display_name: string;
  amount_cents: number;
  recipient_count: number;
  employer: string | null;
  state: string | null;
}

export interface IndividualDonorsResponse {
  donors: IndividualDonorRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function GET(request: Request): Promise<Response> {
  if (supabaseUnavailable()) return unavailableResponse();

  const { searchParams } = new URL(request.url);
  const officialId = searchParams.get("officialId");
  const tier = searchParams.get("tier"); // 'mega' | 'major' | 'mid' | 'small'
  const employer = searchParams.get("employer"); // normalized employer string (employer mode)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") ?? "50", 10)));

  if (!officialId) {
    return Response.json({ error: "officialId is required" }, { status: 400 });
  }
  if (!tier && !employer) {
    return Response.json({ error: "tier or employer is required" }, { status: 400 });
  }

  try {
    const supabase = createAdminClient();

    // Step 1: fetch entity_connections rows for this official's individual donors
    const { data: connRows, error: connErr } = await withDbTimeout(
      supabase
        .from("entity_connections")
        .select("from_id, amount_cents")
        .eq("to_id", officialId)
        .eq("connection_type", "donation")
        .eq("from_type", "financial_entity")
        .order("amount_cents", { ascending: false, nullsFirst: false })
    );
    if (connErr) throw connErr;
    if (!connRows?.length) {
      return withPublicCdnCache(Response.json({ donors: [], total: 0, page, pageSize }));
    }

    // Step 2: fetch individual donor metadata for those entity IDs
    const fromIds = connRows.map((r) => r.from_id);
    const { data: entities, error: entErr } = await withDbTimeout(
      supabase
        .from("financial_entities")
        .select("id, display_name, entity_type, recipient_count, metadata")
        .in("id", fromIds)
        .eq("entity_type", "individual")
    );
    if (entErr) throw entErr;

    type EntityRow = {
      id: string;
      display_name: string;
      entity_type: string;
      recipient_count: number | null;
      metadata: Record<string, string> | null;
    };

    // Build a lookup: entity_id → { display_name, recipient_count, employer, state }
    const entityLookup = new Map<string, EntityRow>();
    for (const e of (entities ?? []) as unknown as EntityRow[]) {
      entityLookup.set(e.id, e);
    }

    // Step 3: join + filter by tier or employer
    const amountLookup = new Map<string, number>();
    for (const r of connRows) {
      amountLookup.set(r.from_id, r.amount_cents ?? 0);
    }

    const filtered: IndividualDonorRow[] = [];

    for (const [id, entity] of entityLookup) {
      const amountCents = amountLookup.get(id) ?? 0;
      const meta = entity.metadata ?? {};

      if (employer !== null) {
        // Employer mode: match normalized employer
        const rawEmp = meta.employer ?? '';
        const normalized = rawEmp ? normalizeEmployer(rawEmp) : '';
        const key = normalized || 'UNAFFILIATED';
        if (key !== employer) continue;
      } else if (tier !== null) {
        // Bracket mode: match donation amount to tier
        const bracketTier = BRACKET_TIERS.find((t) =>
          amountCents >= t.minCents && (t.maxCents === null || amountCents <= t.maxCents)
        );
        if (!bracketTier || bracketTier.id !== tier) continue;
      }

      filtered.push({
        id,
        display_name: entity.display_name,
        amount_cents: amountCents,
        recipient_count: entity.recipient_count ?? 0,
        employer: meta.employer ?? null,
        state: meta.state ?? null,
      });
    }

    // Sort: connector donors first (recipient_count desc), then by amount desc
    filtered.sort((a, b) => {
      if (b.recipient_count !== a.recipient_count) return b.recipient_count - a.recipient_count;
      return b.amount_cents - a.amount_cents;
    });

    const total = filtered.length;
    const donors = filtered.slice((page - 1) * pageSize, page * pageSize);

    return withPublicCdnCache(Response.json({ donors, total, page, pageSize } satisfies IndividualDonorsResponse));
  } catch (err) {
    console.error("[graph/individual-donors]", err);
    return Response.json({ error: "Failed to load donor list" }, { status: 500 });
  }
}
