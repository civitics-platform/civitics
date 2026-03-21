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

  // Enrich officials with state and detect federal vs state-level
  const officialIds = results
    .filter((r) => r.type === "official")
    .map((r) => r.id);

  const federalIds = new Set<string>();

  if (officialIds.length > 0) {
    const { data: offData } = await supabase
      .from("officials")
      .select("id, metadata, source_ids")
      .in("id", officialIds);

    type OffRow = {
      id: string;
      metadata: Record<string, string> | null;
      source_ids: Record<string, string> | null;
    };

    // Valid US state abbreviations — used to validate FEC ID extraction.
    const VALID_STATES = new Set([
      "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
      "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
      "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
      "VA","WA","WV","WI","WY",
    ]);

    for (const o of (offData ?? []) as OffRow[]) {
      // Federal = has a congress_gov source ID
      if (o.source_ids?.["congress_gov"]) federalIds.add(o.id);

      // State: metadata.state → metadata.state_abbr → fec_candidate_id only.
      // fec_id is intentionally excluded — it's a committee/filing ID that can
      // encode a different state than the official's actual state (e.g. Tammy
      // Baldwin has fec_id="S0VA00070" but represents WI).
      const candId =
        o.source_ids?.["fec_candidate_id"] ?? o.source_ids?.["fec_id"] ?? "";
      let stateFromFec: string | undefined;
      if (/^[SH][0-9][A-Z]{2}/.test(candId)) {
        const code = candId.substring(2, 4);
        stateFromFec = VALID_STATES.has(code) ? code : undefined;
      }

      const state =
        o.metadata?.["state"] ||
        o.metadata?.["state_abbr"] ||
        stateFromFec;

      const result = results.find((r) => r.id === o.id);
      if (result && state) result.state = state;
    }
  }

  // Sort by relevance:
  //   0 exact full name  1 exact last name  2 starts-with
  //   3 federal+connections  4 federal  5 has connections  6 else
  // Secondary: connection_count desc, name asc.
  const qLower = q.toLowerCase();
  results.sort((a, b) => {
    const priority = (r: (typeof results)[0]): number => {
      const name = r.name.toLowerCase();
      if (name === qLower) return 0;
      // Last word of name = query (e.g. "warren" matches "Elizabeth Warren")
      const lastName = (r.name.split(" ").pop() ?? "").toLowerCase();
      if (lastName === qLower) return 1;
      if (name.startsWith(qLower)) return 2;
      const isFederal = r.type === "official" && federalIds.has(r.id);
      if (isFederal && r.connection_count > 0) return 3;
      if (isFederal) return 4;
      if (r.connection_count > 0) return 5;
      return 6;
    };
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    if (b.connection_count !== a.connection_count)
      return b.connection_count - a.connection_count;
    return a.name.localeCompare(b.name);
  });

  return Response.json(
    { results, total: results.length },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=30" } },
  );
}
