/**
 * Graph Entity Search — companion to the diagnostic snapshot endpoint.
 * Use this to find valid entity IDs before calling /api/graph/snapshot.
 *
 * GET /api/graph/entities?q=warren&type=official
 * GET /api/graph/entities?q=epa&type=agency
 * GET /api/graph/entities?q=phrma
 *
 * Types: official | agency | financial | proposal
 * Returns up to 20 results with connection counts, has_donations, has_votes flags.
 * No auth required. Rate limited to 20 requests/minute/IP.
 */

import { createAdminClient, fetchIndustryTagsByEntityId } from "@civitics/db";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";

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
  // FIX-473 — primary-source provenance read off the entity-table columns.
  primary_source: string | null;
  primary_source_url: string | null;
}

// ── GET /api/graph/entities ────────────────────────────────────────────────────
export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
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

  // search_graph_entities RPC was retired in the shadow→public promotion. We now
  // do four parallel ILIKE queries and merge. Good enough for prefix/substring
  // match; trigram fuzzy match can come back as a dedicated pg_trgm RPC later.
  const like = `%${q}%`;
  const [officialsRes, agenciesRes, financialRes, proposalsRes] = await Promise.all([
    withDbTimeout(
      supabase
        .from("officials")
        .select("id, full_name, role_title, party, primary_source, primary_source_url")
        .ilike("full_name", like)
        .limit(20),
    ),
    withDbTimeout(
      supabase
        .from("agencies")
        .select("id, name, acronym, agency_type, primary_source, primary_source_url")
        .or(`name.ilike.${like},acronym.ilike.${like}`)
        .limit(20),
    ),
    withDbTimeout(
      supabase
        .from("financial_entities")
        // FIX-503: scope to non-individuals so the partial display_name trgm
        // index (financial_entities_display_trgm WHERE entity_type<>'individual')
        // serves this ILIKE — otherwise it seq-scans (prod cost 219k→27).
        // Individual donor aggregates aren't meaningful graph nodes here.
        .select("id, display_name, entity_type, primary_source, primary_source_url")
        .neq("entity_type", "individual")
        .ilike("display_name", like)
        .limit(20),
    ),
    withDbTimeout(
      supabase
        .from("proposals")
        .select("id, title, type, primary_source, primary_source_url")
        .ilike("title", like)
        .limit(20),
    ),
  ]);

  type Prov = { primary_source: string | null; primary_source_url: string | null };
  type OfficialRow = { id: string; full_name: string; role_title: string | null; party: string | null } & Prov;
  type AgencyRow = { id: string; name: string; acronym: string | null; agency_type: string | null } & Prov;
  type FinancialRow = { id: string; display_name: string; entity_type: string | null } & Prov;
  type ProposalRow = { id: string; title: string; type: string | null } & Prov;

  const financialRows = ((financialRes as { data: FinancialRow[] | null }).data ?? []);
  const industryByEntityId = await fetchIndustryTagsByEntityId(
    supabase,
    financialRows.map((f) => f.id),
  );

  let rows: SearchRow[] = [];
  for (const o of ((officialsRes as { data: OfficialRow[] | null }).data ?? [])) {
    rows.push({ id: o.id, label: o.full_name, entity_type: "official", subtitle: o.role_title, party: o.party, primary_source: o.primary_source ?? null, primary_source_url: o.primary_source_url ?? null });
  }
  for (const a of ((agenciesRes as { data: AgencyRow[] | null }).data ?? [])) {
    rows.push({
      id: a.id,
      label: a.acronym ? `${a.acronym} — ${a.name}` : a.name,
      entity_type: "agency",
      subtitle: a.agency_type,
      party: null,
      primary_source: a.primary_source ?? null,
      primary_source_url: a.primary_source_url ?? null,
    });
  }
  for (const f of financialRows) {
    rows.push({
      id: f.id,
      label: f.display_name,
      entity_type: "financial",
      subtitle: industryByEntityId.get(f.id)?.display_label ?? f.entity_type,
      party: null,
      primary_source: f.primary_source ?? null,
      primary_source_url: f.primary_source_url ?? null,
    });
  }
  for (const p of ((proposalsRes as { data: ProposalRow[] | null }).data ?? [])) {
    rows.push({ id: p.id, label: p.title, entity_type: "proposal", subtitle: p.type, party: null, primary_source: p.primary_source ?? null, primary_source_url: p.primary_source_url ?? null });
  }

  // Optional type filter (post-RPC since the RPC mixes all types)
  if (typeFilter) {
    rows = rows.filter((r) => r.entity_type === typeFilter);
  }

  if (rows.length === 0) {
    return withPublicCdnCache(Response.json({ results: [], total: 0 }));
  }

  const allIds = rows.map((r) => r.id);

  // FIX-509 / FIX-510 — connection counts + donation/vote flags now read from
  // entity_connection_stats_mv (one row per entity, both edge directions already
  // folded in). This replaces the two unpaged entity_connections fetches, which
  // silently capped count + flags at the PostgREST 1000-row default — the
  // graph/entities site of FIX-510.
  // has_vote here folds in the broader 5-type vote set (the MV's vote_count),
  // a slight, intentional improvement over the old vote_yes/vote_no-only flag.
  //
  // FIX-783 — mirrors the FIX-774 P1 read shape (api/graph/connections): chunk
  // the .in() at 200 ids and CHECK the error explicitly. The prior read used a
  // bare `const { data }` with no error check and a single unbounded batch, so
  // an MV error or a Kong 414 URI-too-long from a large id chunk fell through
  // `data ?? []` and silently returned HTTP 200 with every count/flag = 0
  // (silent-empty class). allIds is normally ~80 (4 source queries × 20), but a
  // future scope widening shouldn't be able to reintroduce the URI-limit trap.
  // Counts here are decorative metadata and this endpoint has no outer try/catch,
  // so we log-and-degrade rather than throw (a failed MV read yields count 0
  // with a warning in the logs, not a 500 that kills the whole search).
  const countMap = new Map<string, number>();
  const hasDonation = new Set<string>();
  const hasVote = new Set<string>();

  const STATS_CHUNK = 200;
  for (let i = 0; i < allIds.length; i += STATS_CHUNK) {
    const chunk = allIds.slice(i, i + STATS_CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: statsData, error: statsErr } = await (supabase as any)
      .from("entity_connection_stats_mv")
      .select("entity_id, connection_count, has_donation, has_vote")
      .in("entity_id", chunk)
      .limit(chunk.length);
    if (statsErr) {
      console.warn("[graph/entities] entity_connection_stats_mv read failed — counts degraded to 0:", statsErr.message);
      continue;
    }
    for (const r of (statsData ?? []) as {
      entity_id: string;
      connection_count: number;
      has_donation: boolean;
      has_vote: boolean;
    }[]) {
      countMap.set(r.entity_id, Number(r.connection_count));
      if (r.has_donation) hasDonation.add(r.entity_id);
      if (r.has_vote) hasVote.add(r.entity_id);
    }
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
    primary_source: r.primary_source,          // FIX-473
    primary_source_url: r.primary_source_url,   // FIX-473
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

  return withPublicCdnCache(Response.json(
    { results, total: results.length },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=30" } },
  ));
}
