/**
 * Graph Entity Search — companion to the diagnostic snapshot endpoint.
 * Use this to find valid entity IDs before calling /api/graph/snapshot.
 *
 * GET /api/graph/entities?q=warren&type=official
 * GET /api/graph/entities?q=epa&type=agency
 * GET /api/graph/entities?q=phrma
 *
 * Types: official | agency | financial | proposal
 * Returns up to 10 results with connection counts, has_donations, has_votes flags.
 * No auth required. Rate limited to 20 requests/minute/IP.
 */

import { createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// ── Rate limiter ───────────────────────────────────────────────────────────────
const RL = new Map<string, { n: number; t: number }>();
const RL_MAX = 20;
const RL_WIN_MS = 60_000;

function getIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function rateOk(ip: string): boolean {
  const now = Date.now();
  const s = RL.get(ip);
  if (!s || now - s.t > RL_WIN_MS) {
    RL.set(ip, { n: 1, t: now });
    return true;
  }
  if (s.n >= RL_MAX) return false;
  s.n++;
  return true;
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface SearchRow {
  id: string;
  label: string;
  entity_type: string;
  subtitle: string | null;
  party: string | null;
}

// ── GET /api/graph/entities ────────────────────────────────────────────────────
export async function GET(request: Request) {
  const ip = getIp(request);
  if (!rateOk(ip)) {
    return Response.json(
      { error: "Rate limit exceeded — 20 requests per minute per IP" },
      { status: 429 },
    );
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const typeFilter = searchParams.get("type")?.trim() ?? "";

  if (q.length < 2) {
    return Response.json(
      { error: "q must be at least 2 characters" },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Use existing fuzzy-search RPC (trigram + ILIKE across all entity tables)
  const { data, error } = await supabase.rpc("search_graph_entities", {
    q,
    lim: 10,
  });

  if (error) {
    console.error("[graph/entities]", error.message);
    return Response.json({ results: [], total: 0 }, { status: 500 });
  }

  let rows = (data ?? []) as SearchRow[];

  // Optional type filter (post-RPC since the RPC mixes all types)
  if (typeFilter) {
    rows = rows.filter((r) => r.entity_type === typeFilter);
  }

  if (rows.length === 0) {
    return Response.json({ results: [], total: 0 });
  }

  const allIds = rows.map((r) => r.id);

  // Connection counts + connection type flags in parallel
  const [fromRes, toRes] = await Promise.all([
    supabase
      .from("entity_connections")
      .select("from_id, connection_type")
      .in("from_id", allIds),
    supabase
      .from("entity_connections")
      .select("to_id, connection_type")
      .in("to_id", allIds),
  ]);

  const countMap = new Map<string, number>();
  const hasDonation = new Set<string>();
  const hasVote = new Set<string>();

  for (const r of (fromRes.data ?? []) as { from_id: string; connection_type: string }[]) {
    countMap.set(r.from_id, (countMap.get(r.from_id) ?? 0) + 1);
    if (r.connection_type === "donation") hasDonation.add(r.from_id);
    if (r.connection_type === "vote_yes" || r.connection_type === "vote_no")
      hasVote.add(r.from_id);
  }
  for (const r of (toRes.data ?? []) as { to_id: string; connection_type: string }[]) {
    countMap.set(r.to_id, (countMap.get(r.to_id) ?? 0) + 1);
    if (r.connection_type === "donation") hasDonation.add(r.to_id);
    if (r.connection_type === "vote_yes" || r.connection_type === "vote_no")
      hasVote.add(r.to_id);
  }

  // Fetch top topic tags per entity
  const { data: tagData } = await supabase
    .from("entity_tags")
    .select("entity_id, tag")
    .in("entity_id", allIds)
    .eq("tag_category", "topic")
    .eq("visibility", "primary")
    .gte("confidence", 0.7)
    .limit(allIds.length * 3);

  const tagMap = new Map<string, string[]>();
  for (const t of (tagData ?? []) as { entity_id: string; tag: string }[]) {
    const existing = tagMap.get(t.entity_id) ?? [];
    existing.push(t.tag);
    tagMap.set(t.entity_id, existing);
  }

  const results = rows.map((r) => ({
    id: r.id,
    name: r.label,
    type: r.entity_type as "official" | "agency" | "financial" | "proposal",
    role: r.subtitle ?? undefined,
    state: undefined as string | undefined, // populated below for officials
    party: r.party ?? undefined,
    connection_count: countMap.get(r.id) ?? 0,
    has_donations: hasDonation.has(r.id),
    has_votes: hasVote.has(r.id),
    top_tags: tagMap.get(r.id) ?? [],
  }));

  // Enrich officials with state from metadata
  const officialIds = results
    .filter((r) => r.type === "official")
    .map((r) => r.id);

  if (officialIds.length > 0) {
    const { data: offData } = await supabase
      .from("officials")
      .select("id, metadata")
      .in("id", officialIds);

    const stateMap = new Map<string, string>();
    for (const o of (offData ?? []) as { id: string; metadata: Record<string, string> | null }[]) {
      const state = o.metadata?.["state"];
      if (state) stateMap.set(o.id, state);
    }

    for (const r of results) {
      if (r.type === "official") r.state = stateMap.get(r.id);
    }
  }

  return Response.json(
    { results, total: results.length },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=30" } },
  );
}
