/**
 * GET /api/search/entity?id=<uuid>&type=official|proposal|agency|financial
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
        .select("id, full_name, role_title, party, photo_url, is_active, metadata")
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
        .select("id, title, status, type, comment_period_end, summary_plain, metadata")
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
        meta: {
          Status: data.status.replace(/_/g, " "),
          "Comment deadline": data.comment_period_end
            ? new Date(data.comment_period_end).toLocaleDateString()
            : null,
          Agency: data.metadata?.agency_id ?? null,
        },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "agency") {
      const { data } = await db2
        .from("agencies")
        .select("id, name, acronym, agency_type, description, website_url, slug")
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
        meta: { Type: data.agency_type.replace(/_/g, " ") },
      };
      return NextResponse.json(detail, { headers: CACHE_HEADERS });
    }

    if (type === "financial") {
      const { data } = await db2
        .from("financial_entities")
        .select("id, display_name, entity_type, total_donated_cents, total_received_cents")
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
        meta: {
          "Total donated": data.total_donated_cents
            ? formatDollars(data.total_donated_cents)
            : null,
          Industry: tagRes?.data?.display_label ?? tagRes?.data?.tag ?? null,
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
