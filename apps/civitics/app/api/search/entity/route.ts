/**
 * GET /api/search/entity?id=<uuid>&type=official|proposal|agency|financial|jurisdiction|institution|meeting
 *
 * Lightweight entity detail fetch for the SearchDetailPanel.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, isMergeStubSourceIds } from "@civitics/db";
import { meetingsEnabled } from "@/lib/meetings-flag";

interface EntityDetail {
  id: string;
  type: string;
  name: string;
  subtitle: string;
  photo_url?: string | null;
  party?: string | null;
  description?: string | null;
  connection_count: number;
  profile_url: string;
  meta?: Record<string, string | number | null>;
  // FIX-473 — primary-source provenance, read straight off the materialized
  // entity-table columns (zero extra queries). Null for types whose tables
  // carry no primary_source* columns (jurisdiction, meeting).
  primary_source?: string | null;
  primary_source_url?: string | null;
}

// FIX-774: read the count from entity_connection_stats_mv (one row per entity,
// both edge directions folded in; refreshed after each entity_connections
// rebuild) instead of the live get_connection_counts RPC. The RPC live-COUNTs
// both directions of ~5.68M edges and timed out the 8s authenticator cap on
// high-connection entities (FIX-499), which is the 500 Craig hit selecting an
// entity in the detail rail. Fallback is NOT the live RPC (that's the bug): an
// entity absent from the MV genuinely has no edges → 0; on MV error, degrade to
// 0 (hidden count) rather than blocking the whole detail response.
async function getConnectionCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  id: string,
): Promise<number> {
  const { data, error } = await db
    .from("entity_connection_stats_mv")
    .select("connection_count")
    .eq("entity_id", id)
    .maybeSingle();
  if (error || !data) return 0;
  return Number((data as { connection_count?: number }).connection_count ?? 0);
}

function formatDollars(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(0)}K`;
  return `$${d.toFixed(0)}`;
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
} as const;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const id   = searchParams.get("id")   ?? "";
  const type = searchParams.get("type") ?? "";

  if (!id || !type) {
    return NextResponse.json({ error: "id and type are required" }, { status: 400 });
  }

  const db = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db2 = db as any;

  try {
    if (type === "official") {
      const { data } = await db2
        .from("officials")
        // FIX-939: source_ids so the merge-stub check below can run.
        .select("id, full_name, role_title, party, photo_url, is_active, metadata, source_ids, primary_source, primary_source_url")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });
      // FIX-939 — a FIX-933 merge stub is a $0 same-person duplicate of a real
      // official. It is excluded from entity_search_index, so nothing in the UI
      // links here any more; a direct hit on the old id is answered the same way
      // the index answers it. Once the survivor POINTER (`merged_into`) is
      // written, this is the hook that turns into a redirect rather than a 404.
      if (isMergeStubSourceIds(data.source_ids)) {
        return NextResponse.json(null, { status: 404 });
      }

      const [connection_count, aiRes] = await Promise.all([
        getConnectionCount(db2, id),
        db2.from("ai_summary_cache").select("summary_text")
          .eq("entity_id", id).eq("entity_type", "official").maybeSingle(),
      ]);

      const detail: EntityDetail = {
        id, type,
        name: data.full_name,
        subtitle: [data.role_title, data.metadata?.state].filter(Boolean).join(" · "),
        photo_url: data.photo_url ?? null,
        party: data.party ?? null,
        description: aiRes?.data?.summary_text ?? null,
        connection_count,
        profile_url: `/officials/${id}`,
        primary_source: data.primary_source ?? null,
        primary_source_url: data.primary_source_url ?? null,
        meta: {
          State: data.metadata?.state ?? null,
          Chamber: data.metadata?.chamber ?? null,
          Status: data.is_active ? "Active" : "Inactive",
        },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "proposal") {
      const { data } = await db2
        .from("proposals")
        .select("id, title, status, type, summary_plain, metadata, primary_source, primary_source_url")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });

      const [connection_count, aiRes] = await Promise.all([
        getConnectionCount(db2, id),
        db2.from("ai_summary_cache").select("summary_text")
          .eq("entity_id", id).eq("entity_type", "proposal").maybeSingle(),
      ]);

      const detail: EntityDetail = {
        id, type,
        name: data.title,
        subtitle: `${data.type.replace(/_/g, " ")} · ${data.status.replace(/_/g, " ")}`,
        description: aiRes?.data?.summary_text ?? data.summary_plain ?? null,
        connection_count,
        profile_url: `/proposals/${id}`,
        primary_source: data.primary_source ?? null,
        primary_source_url: data.primary_source_url ?? null,
        meta: {
          Status: data.status.replace(/_/g, " "),
          "Comment deadline": data.metadata?.comment_period_end
            ? new Date(data.metadata.comment_period_end).toLocaleDateString()
            : null,
          Agency: data.metadata?.agency_id ?? null,
        },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "agency") {
      const { data } = await db2
        .from("agencies")
        .select("id, name, acronym, agency_type, description, website_url, primary_source, primary_source_url")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });

      const connection_count = await getConnectionCount(db2, id);

      const detail: EntityDetail = {
        id, type,
        name: data.name,
        subtitle: data.acronym ? `${data.acronym} · ${data.agency_type.replace(/_/g, " ")}` : data.agency_type.replace(/_/g, " "),
        description: data.description ?? null,
        connection_count,
        profile_url: `/agencies/${id}`,
        primary_source: data.primary_source ?? null,
        primary_source_url: data.primary_source_url ?? null,
        meta: { Type: data.agency_type.replace(/_/g, " ") },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "financial") {
      const { data } = await db2
        .from("financial_entities")
        .select("id, display_name, entity_type, total_donated_cents, total_received_cents, primary_source, primary_source_url")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });

      const [connection_count, tagRes, aiRes] = await Promise.all([
        getConnectionCount(db2, id),
        // FIX-503: lead with entity_type so idx_entity_tags_entity(entity_type,
        // entity_id) serves this (prod cost 26989 → 2.8). This is the financial
        // branch, so the tag rows are stored under entity_type 'financial_entity'.
        db2.from("entity_tags").select("display_label, tag")
          .eq("entity_type", "financial_entity").eq("entity_id", id)
          .eq("tag_category", "industry").maybeSingle(),
        db2.from("ai_summary_cache").select("summary_text")
          .eq("entity_id", id).eq("entity_type", "financial").maybeSingle(),
      ]);

      const detail: EntityDetail = {
        id, type,
        name: data.display_name,
        subtitle: [
          data.entity_type.replace(/_/g, " "),
          tagRes?.data?.display_label ?? tagRes?.data?.tag ?? null,
        ].filter(Boolean).join(" · "),
        description: aiRes?.data?.summary_text ?? null,
        connection_count,
        profile_url: `/donors/${id}`,
        primary_source: data.primary_source ?? null,
        primary_source_url: data.primary_source_url ?? null,
        meta: {
          "Total donated": data.total_donated_cents
            ? formatDollars(data.total_donated_cents)
            : null,
          Industry: tagRes?.data?.display_label ?? tagRes?.data?.tag ?? null,
        },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "jurisdiction") {
      const { data } = await db2
        .from("jurisdictions")
        .select("id, name, short_name, type, population")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });

      const connection_count = await getConnectionCount(db2, id);

      const detail: EntityDetail = {
        id, type,
        name: data.name,
        subtitle: data.short_name ? `${data.short_name} · ${data.type}` : String(data.type),
        connection_count,
        profile_url: `/jurisdictions/${id}`,
        meta: {
          Type: data.type,
          Population: data.population != null ? Number(data.population).toLocaleString() : null,
        },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "institution") {
      const { data } = await db2
        .from("governing_bodies")
        .select("id, name, short_name, type, is_active, primary_source, primary_source_url")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });

      const connection_count = await getConnectionCount(db2, id);

      const detail: EntityDetail = {
        id, type,
        name: data.name,
        subtitle: data.short_name ? `${data.short_name} · ${String(data.type).replace(/_/g, " ")}` : String(data.type).replace(/_/g, " "),
        connection_count,
        profile_url: `/institutions/${id}`,
        primary_source: data.primary_source ?? null,
        primary_source_url: data.primary_source_url ?? null,
        meta: {
          Type: String(data.type).replace(/_/g, " "),
          Status: data.is_active ? "Active" : "Former",
        },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "meeting") {
      // FIX-1119 — the surface is hidden, so this detail lookup would only ever
      // hand the client a profile_url into a 404. 404 here instead: the search
      // UI already treats that as "no such entity", which is the truthful answer
      // while /meetings is gated.
      if (!meetingsEnabled()) return NextResponse.json(null, { status: 404 });
      const { data } = await db2
        .from("meetings")
        .select("id, title, scheduled_at, meeting_type, status, location, governing_bodies(name, short_name)")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });

      const gb = Array.isArray(data.governing_bodies) ? data.governing_bodies[0] : data.governing_bodies;
      const detail: EntityDetail = {
        id, type,
        name: data.title ?? "Untitled meeting",
        subtitle: [gb?.name, data.meeting_type?.replace(/_/g, " ")].filter(Boolean).join(" · "),
        connection_count: 0,
        profile_url: `/meetings/${id}`,
        meta: {
          "Body": gb?.name ?? null,
          "Date": data.scheduled_at ? new Date(data.scheduled_at).toLocaleDateString() : null,
          "Type": data.meeting_type?.replace(/_/g, " ") ?? null,
          Status: data.status?.replace(/_/g, " ") ?? null,
          Location: data.location ?? null,
        },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (err) {
    console.error("[search/entity]", err);
    return NextResponse.json(null, { status: 500 });
  }
}
