/**
 * GET /api/search/entity?id=<uuid>&type=official|proposal|agency|financial|jurisdiction|institution|meeting
 *
 * Lightweight entity detail fetch for the SearchDetailPanel.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";

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

async function getConnectionCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  id: string,
): Promise<number> {
  const { data } = await db.rpc("get_connection_counts", { entity_ids: [id] });
  return Number((data?.[0] as { connection_count?: number } | undefined)?.connection_count ?? 0);
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
        .select("id, full_name, role_title, party, photo_url, is_active, metadata, primary_source, primary_source_url")
        .eq("id", id)
        .single();
      if (!data) return NextResponse.json(null, { status: 404 });

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
        .select("id, name, acronym, agency_type, description, website_url, slug, primary_source, primary_source_url")
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
        profile_url: data.slug ? `/agencies/${data.slug}` : `/agencies/${id}`,
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
        db2.from("entity_tags").select("display_label, tag")
          .eq("entity_id", id).eq("tag_category", "industry").maybeSingle(),
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
