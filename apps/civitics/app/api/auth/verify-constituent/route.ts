import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  createServerClient,
  createAdminClient,
  isKillSwitchEnabled,
} from "@civitics/db";

export const dynamic = "force-dynamic";

// PII hard rule: never persist raw address, raw name, raw coordinates, or the
// raw Mapbox feature payload. Only the relevance score, match count, and
// returned feature_type are stored in grant_evidence.metadata.

const NAME_MAX = 120;
const ADDRESS_MAX = 300;
const RATE_LIMIT_PER_HOUR = 5;
const MAPBOX_TIMEOUT_MS = 5000;
const GRANT_DURATION = "2 years";

type MapboxFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    feature_type?: string;
    match_code?: { confidence?: string };
    mapbox_id?: string;
  };
};

type MapboxResponse = {
  features?: MapboxFeature[];
};

export async function POST(request: NextRequest) {
  // 1. Auth
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. Body validation
  let body: { name?: unknown; address?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!name || !address) {
    return NextResponse.json({ error: "name_and_address_required" }, { status: 400 });
  }
  if (name.length > NAME_MAX || address.length > ADDRESS_MAX) {
    return NextResponse.json({ error: "name_or_address_too_long" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // 3. Kill switch
  const enabled = await isKillSwitchEnabled(admin, "mapbox_geocode");
  if (!enabled) {
    return NextResponse.json({ error: "geocoding_disabled" }, { status: 503 });
  }

  // 4. Per-user rate limit (5 attempts / hour, success OR inconclusive)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await admin
    .from("grant_evidence")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("method", "address_check")
    .gte("submitted_at", oneHourAgo);
  if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // 5. Mapbox v6 forward geocode (server-side)
  const token = process.env["NEXT_PUBLIC_MAPBOX_TOKEN"];
  if (!token) {
    // Token missing is a deploy-config error, not a user-facing inconclusive.
    return NextResponse.json({ error: "geocoding_disabled" }, { status: 503 });
  }
  const url =
    `https://api.mapbox.com/search/geocode/v6/forward` +
    `?q=${encodeURIComponent(address)}` +
    `&access_token=${encodeURIComponent(token)}` +
    `&country=us&types=address&limit=1`;

  let mapboxData: MapboxResponse | null = null;
  let mapboxFailed = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAPBOX_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      mapboxFailed = true;
    } else {
      mapboxData = (await res.json()) as MapboxResponse;
    }
  } catch {
    mapboxFailed = true;
  } finally {
    clearTimeout(timer);
  }

  if (mapboxFailed) {
    await admin.from("grant_evidence").insert({
      user_id: user.id,
      method: "address_check",
      outcome: "inconclusive",
      metadata: { failure_reason: "mapbox_unavailable" },
    });
    return NextResponse.json(
      { verified: false, reason: "geocoding_failed" },
      { status: 200 },
    );
  }

  const feature = mapboxData?.features?.[0];
  const featureType = feature?.properties?.feature_type ?? null;
  const coords = feature?.geometry?.coordinates;

  if (!feature || featureType !== "address" || !coords || coords.length !== 2) {
    await admin.from("grant_evidence").insert({
      user_id: user.id,
      method: "address_check",
      outcome: "inconclusive",
      metadata: {
        feature_type_returned: featureType,
        match_count: mapboxData?.features?.length ?? 0,
      },
    });
    return NextResponse.json(
      { verified: false, reason: "address_inconclusive" },
      { status: 200 },
    );
  }

  const [lng, lat] = coords;

  // 6. Spatial lookup
  const { data: matches, error: rpcError } = await admin.rpc(
    "jurisdictions_containing_point",
    { p_lng: lng, p_lat: lat },
  );
  if (rpcError) {
    await admin.from("grant_evidence").insert({
      user_id: user.id,
      method: "address_check",
      outcome: "inconclusive",
      metadata: { failure_reason: "spatial_lookup_failed" },
    });
    return NextResponse.json(
      { verified: false, reason: "geocoding_failed" },
      { status: 200 },
    );
  }

  const matched: Array<{ id: string; name: string; type: string }> = matches ?? [];

  if (matched.length === 0) {
    await admin.from("grant_evidence").insert({
      user_id: user.id,
      method: "address_check",
      outcome: "inconclusive",
      metadata: {
        feature_type_returned: featureType,
        matched_jurisdiction_count: 0,
      },
    });
    return NextResponse.json(
      { verified: false, reason: "no_jurisdiction_match" },
      { status: 200 },
    );
  }

  // 7. Approved — record evidence then upsert grants
  const matchConfidence =
    typeof feature.properties?.match_code?.confidence === "string"
      ? feature.properties.match_code.confidence
      : null;

  const { data: evidenceRow, error: evidenceErr } = await admin
    .from("grant_evidence")
    .insert({
      user_id: user.id,
      method: "address_check",
      outcome: "approved",
      metadata: {
        feature_type_returned: featureType,
        matched_jurisdiction_count: matched.length,
        mapbox_confidence: matchConfidence,
      },
    })
    .select("id")
    .single();

  if (evidenceErr || !evidenceRow) {
    return NextResponse.json({ error: "evidence_write_failed" }, { status: 500 });
  }

  const grantedAt = new Date();
  const expiresAt = new Date(grantedAt);
  expiresAt.setFullYear(expiresAt.getFullYear() + 2);

  // Idempotent per-jurisdiction upsert. The partial unique index
  // entity_grants_unique_active is filtered by status='active'; PostgREST's
  // onConflict doesn't target partial indexes, so we SELECT-then-INSERT/UPDATE
  // per match. 1–3 round-trips total in practice.
  for (const j of matched) {
    const { data: existing } = await admin
      .from("entity_grants")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "constituent")
      .eq("target_type", "jurisdiction")
      .eq("target_id", j.id)
      .eq("status", "active")
      .maybeSingle();

    if (existing?.id) {
      await admin
        .from("entity_grants")
        .update({
          expires_at: expiresAt.toISOString(),
          evidence_id: evidenceRow.id,
        })
        .eq("id", existing.id);
    } else {
      const { data: inserted, error: grantErr } = await admin
        .from("entity_grants")
        .insert({
          user_id: user.id,
          role: "constituent",
          target_type: "jurisdiction",
          target_id: j.id,
          status: "active",
          granted_at: grantedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          evidence_id: evidenceRow.id,
        })
        .select("id")
        .single();

      if (!grantErr && inserted?.id) {
        await admin.from("grant_events").insert({
          grant_id: inserted.id,
          event: "auto_approved",
          actor_id: null,
          metadata: { source: "mapbox_geocode_v6" },
        });
      }
    }
  }

  return NextResponse.json({
    verified: true,
    jurisdictions: matched.map((j) => ({ id: j.id, name: j.name, type: j.type })),
    evidence_id: evidenceRow.id,
  });
}
