import { createAdminClient } from "@civitics/db";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";
import { fetchChunkedByIds } from "@/lib/paginate";
import type { Database } from "@civitics/db";
import type { GraphEdgeV2 as GraphEdge, GraphNodeV2 as GraphNode, EdgeType, NodeTypeV2 as NodeType, IndividualDisplayMode } from "@civitics/graph";
import { BRACKET_TIERS } from "@civitics/graph";

type ConnectionRow = Database["public"]["Tables"]["entity_connections"]["Row"];

export const dynamic = "force-dynamic";

/**
 * At depth 2, neighbors with fewer than MAX_AUTO_EXPAND connections are expanded
 * automatically. Neighbors at or above this threshold are returned as "collapsed"
 * nodes with a + badge — the user must click to expand them manually.
 *
 * This prevents financial entities like "Individual Contributors" (which connect to
 * hundreds of officials) from freezing the graph when using Follow the Money + depth 2.
 */
const MAX_AUTO_EXPAND = 50;

// PostgREST hard row cap (supabase/config.toml db-max-rows). A single .select()
// — even with .limit(N) for N>1000 — never returns more than this, so any load
// that consumes its result as the complete set silently truncates past it (FIX-428).
const MAX_ROWS = 1000;

// FIX-802 — whitelisted fetch caps, dropdown-driven from the client.
//   limit        — named donation/opposition donors by MV rank
//   votes_limit  — vote-bucket rows (most recent first, unchanged ordering)
const DONOR_LIMIT_CHOICES = [10, 25, 50, 100];
const DEFAULT_DONOR_LIMIT = 25;
const VOTES_LIMIT_CHOICES = [50, 100, 250, 500];
const DEFAULT_VOTES_LIMIT = 50;

// FIX-802 — cap for every raw entity_connections bucket read (donation/
// opposition fallback, oversight bucket, investigation backstop), ordered
// amount_cents DESC NULLS LAST (NULLS LAST is required for index use —
// FIX-664 precedent) so the cap keeps the biggest-dollar edges. No read of
// entity_connections in this route may be unbounded: the silent MAX_ROWS
// truncation with no ORDER BY handed back an arbitrary subset for the 555+
// officials with >1,000 donation edges.
const RAW_EDGE_CAP = 500;

// FIX-781 — JS deadline for the whole depth-2 expansion phase (neighbor stats
// + edge hydration), modeled on the group route's DONOR_FETCH_BUDGET_MS
// (FIX-497). On exhaustion (or a failed depth-2 read) the un-hydrated
// neighbors degrade to collapsed nodes and the response carries
// meta.depth2Truncated — depth 2 is an enhancement and must never 500 a graph
// that depth 1 already answered.
const DEPTH2_BUDGET_MS = 8000;

/**
 * Page through a row-capped PostgREST query so the full set is assembled rather
 * than silently truncated at MAX_ROWS (FIX-428). `build(from, to)` must return a
 * fresh query with `.range(from, to)` applied.
 *
 * Returns the accumulated rows plus an `error` (propagated from the first failing
 * page — never swallowed, FIX-431) and a `truncated` flag set when an optional
 * `maxRows` safety ceiling was reached before exhaustion.
 */
async function fetchAllPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { maxRows?: number } = {},
): Promise<{ rows: T[]; error: { message: string } | null; truncated: boolean }> {
  const ceiling = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + MAX_ROWS - 1);
    if (error) return { rows, error, truncated: false };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < MAX_ROWS) break;        // last (short) page → exhausted
    from += MAX_ROWS;
    if (rows.length >= ceiling) return { rows, error: null, truncated: true };
  }
  return { rows, error: null, truncated: false };
}

/**
 * FIX-901 — the local FIX-732 `fetchChunkedByIds` + its `ID_CHUNK = 200`
 * constant moved to `@/lib/paginate` (shared with the officials directory and
 * the agency-staffing rollup, which had each hand-written the same loop). The
 * name-batch reads below pass `{ strict: true }` to keep FIX-732's throw-on-
 * failed-chunk contract: a swallowed chunk here renders its entities as
 * "Unknown"-labeled nodes on an HTTP 200 (FIX-431 class), so a short read is
 * strictly worse than the 500 the catch block turns the throw into.
 */

// ── Individual-donor aggregation helpers (FIX-194) ────────────────────────────

/** Normalize FEC employer strings for grouping. "GOLDMAN SACHS & CO" → "GOLDMAN SACHS". */
const LEGAL_SUFFIX_RE = /\b(incorporated|inc|llc|corp|corporation|l\.l\.c|co|company|the|plc|ltd|limited|lp|l\.p)\b\.?/gi;

function normalizeEmployer(raw: string): string {
  return raw
    .toUpperCase()
    .replace(LEGAL_SUFFIX_RE, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Log-scale donation strength identical to the rebuild function's formula. */
function logScaleDonation(cents: number): number {
  return Math.min(0.999, Math.max(0.001, Math.log10(Math.max(cents / 100, 1)) / 8));
}

// ── official_donor_rollup_mv read path (FIX-802) ──────────────────────────────

/**
 * Per (recipient, relationship_type): rank 1..200 named donors + one rank-201
 * tail row (donor_id NULL, tail_donor_count set). SUM(total_cents) over a
 * recipient's rows is the true total — the FIX-518/FIX-704 contract. This is
 * the donation/opposition source for a focused OFFICIAL: Allred's 31,368 raw
 * donation edges collapse to 231 rollup rows, which both kills the timeout
 * 500s and ends the silent 1,000-row truncation that corrupted rendered
 * donation totals for every official past the cap.
 */
type MvRollupRow = {
  relationship_type: string;
  rank: number;
  donor_id: string | null;
  donor_name: string | null;
  entity_type: string | null;
  total_cents: number | null;
  tx_count: number | null;
  tail_donor_count: number | null;
  // FIX-804 — denormalized at MV refresh (FIX-518); forwarded onto donor node
  // payloads for the "Color by: Industry" encoding.
  industry_tag: string | null;
  industry_label: string | null;
};

type MvDonorAgg = { donorId: string; name: string; entityType: string; cents: number; tx: number; industryTag?: string; industryLabel?: string };

/**
 * Aggregate bucket for everything that stays unnamed on the graph: the MV
 * rank-201 tail, named rows folded past the top-N cap, and sub-bracket-
 * threshold individuals. One node per (official, connection type) so rendered
 * totals equal the true MV sums — the tail is never silently dropped.
 */
type TailAgg = { connType: "donation" | "opposition"; officialId: string; cents: number; tx: number; donorCount: number };

/**
 * Synthesize an entity_connections-shaped row from an MV donor aggregate so the
 * downstream node/edge/bracket machinery consumes it unchanged. The id is
 * namespaced `mv:` — never a real entity_connections uuid. occurred_at stays
 * null (the row is an aggregate, not an event); evidence_source matches the
 * real donation edges so rendering is identical.
 */
function mvPseudoRow(officialId: string, donor: MvDonorAgg, connType: "donation" | "opposition"): ConnectionRow {
  return {
    id: `mv:${connType}:${officialId}:${donor.donorId}`,
    from_type: "financial_entity",
    from_id: donor.donorId,
    to_type: "official",
    to_id: officialId,
    connection_type: connType,
    amount_cents: donor.cents,
    strength: logScaleDonation(donor.cents),
    occurred_at: null,
    ended_at: null,
    derived_at: "",
    evidence_count: 0,
    evidence_ids: [],
    evidence_source: "financial_relationships",
    metadata: {},
  } as ConnectionRow;
}

/** Map DB entity type string → GraphNode type */
function mapNodeType(dbType: string, subType?: string): NodeType {
  switch (dbType) {
    case "official": return "official";
    case "agency": return "agency";
    case "governing_body": return "agency";
    case "proposal": return "proposal";
    case "initiative": return "initiative";
    case "financial":
    case "financial_entity": {
      switch (subType) {
        case "pac":
        case "super_pac":
        case "party_committee": return "pac";
        case "individual": return "individual";
        default: return "corporation";
      }
    }
    case "organization": return "organization";
    default: return "corporation";
  }
}

/** Map DB connection_type string → GraphEdge type */
function mapEdgeType(dbType: string): EdgeType {
  const valid: EdgeType[] = [
    "donation", "opposition", "vote_yes", "vote_no", "vote_abstain",
    "nomination_vote_yes", "nomination_vote_no",
    "appointment", "revolving_door", "oversight", "lobbying", "co_sponsorship",
    "contract_award",
  ];
  if (valid.includes(dbType as EdgeType)) return dbType as EdgeType;
  switch (dbType) {
    case "business_partner": return "oversight";
    case "endorsement": return "oversight";
    case "family": return "appointment";
    case "legal_representation": return "oversight";
    default: return "oversight";
  }
}

/**
 * FIX-125: drop vote-type connections whose underlying votes are all procedural.
 *
 * The connections pipeline already skips procedural votes at derivation
 * (voteToConnectionType returns null), so most entity_connections rows are clean.
 * This runtime filter handles legacy rows derived before the procedural skip
 * was tightened, and lets the pipeline's procedural list grow without a re-run.
 *
 * For each vote-type connection (official ↔ proposal), look up the underlying
 * votes by (official_id, proposal_id) and drop the connection only if every
 * matching vote has a procedural vote_question. Connections with no matching
 * vote rows are kept (trust the existing edge).
 */
const PROCEDURAL_PREFIXES = [
  "on the cloture motion",
  "on the motion to proceed",
  "on the motion to table",
  "on the motion to recommit",
  "on ordering the previous question",
  "on agreeing to the amendment",
  "on the conference report",
  "on the joint resolution",
  "on the resolution",
  "on the motion",
];

const VOTE_CONN_TYPES = new Set([
  "vote_yes", "vote_no", "vote_abstain",
  "nomination_vote_yes", "nomination_vote_no",
]);

async function filterProceduralConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  connections: ConnectionRow[],
): Promise<ConnectionRow[]> {
  const voteConns = connections.filter(c => VOTE_CONN_TYPES.has(c.connection_type));
  if (voteConns.length === 0) return connections;

  const officialIds = new Set<string>();
  const proposalIds = new Set<string>();
  for (const c of voteConns) {
    const officialId = c.from_type === "official" ? c.from_id : c.to_id;
    const proposalId = c.from_type === "proposal" ? c.from_id : c.to_id;
    officialIds.add(officialId);
    proposalIds.add(proposalId);
  }

  // FIX-802 — both id lists ride the request URL, so the previous single
  // .in()+.in() read 414'd once either list grew (FIX-732 class) and the whole
  // filter failed open silently. Chunk both sides at 100 (≤200 uuids per
  // request). Pairs in a failed chunk stay un-looked-up → their edges are
  // kept, preserving the existing fail-open contract.
  const PROC_CHUNK = 100;
  const officialIdList = [...officialIds];
  const proposalIdList = [...proposalIds];
  const oChunks: string[][] = [];
  for (let i = 0; i < officialIdList.length; i += PROC_CHUNK) oChunks.push(officialIdList.slice(i, i + PROC_CHUNK));
  const pChunks: string[][] = [];
  for (let i = 0; i < proposalIdList.length; i += PROC_CHUNK) pChunks.push(proposalIdList.slice(i, i + PROC_CHUNK));

  if (oChunks.length * pChunks.length > 25) {
    // Pathological pair space (default view at full expansion) — skip rather
    // than fan out 100+ lookups. Same fail-open outcome: no edge is hidden.
    console.warn(`[graph/connections] procedural filter skipped — ${oChunks.length}x${pChunks.length} vote-lookup chunks`);
    return connections;
  }

  const pairs: Array<[string[], string[]]> = [];
  for (const o of oChunks) for (const p of pChunks) pairs.push([o, p]);
  const results: Array<{ data: unknown; error: { message: string } | null }> = await Promise.all(
    pairs.map(([o, p]) =>
      supabase
        .from("votes")
        .select("official_id, bill_proposal_id, vote_question")
        .in("official_id", o)
        .in("bill_proposal_id", p),
    ),
  );
  const votes: { official_id: string; bill_proposal_id: string; vote_question: string | null }[] = [];
  for (const r of results) {
    if (r.error) {
      console.warn("[graph/connections] procedural vote-lookup chunk failed (fail open):", r.error.message);
      continue;
    }
    votes.push(...((r.data ?? []) as typeof votes));
  }

  // For each (official, proposal) pair: true if at least one non-procedural vote exists,
  // false if we saw votes but they were all procedural, missing if no votes were found.
  const hasSubstantive = new Map<string, boolean>();
  // vote_question is a first-class votes column (NOT metadata->>'vote_question').
  // Reading it off metadata returned undefined for every row, so the procedural
  // filter failed open and treated every vote as substantive.
  for (const v of votes) {
    const key = `${v.official_id}|${v.bill_proposal_id}`;
    const q = String(v.vote_question ?? "").toLowerCase();
    const isProcedural = PROCEDURAL_PREFIXES.some(p => q.startsWith(p));
    if (!isProcedural) hasSubstantive.set(key, true);
    else if (!hasSubstantive.has(key)) hasSubstantive.set(key, false);
  }

  return connections.filter(c => {
    if (!VOTE_CONN_TYPES.has(c.connection_type)) return true;
    const officialId = c.from_type === "official" ? c.from_id : c.to_id;
    const proposalId = c.from_type === "proposal" ? c.from_id : c.to_id;
    const flag = hasSubstantive.get(`${officialId}|${proposalId}`);
    // missing → no vote rows found, keep edge; false → all procedural, drop; true → keep
    return flag !== false;
  });
}

export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const { searchParams } = new URL(request.url);
  const entityId = searchParams.get("entityId");
  // Server handles up to depth 2 (direct + one smart expansion).
  // Client-side BFS handles further depth filtering on the loaded data.
  const depth = Math.min(parseInt(searchParams.get("depth") ?? "1", 10), 2);
  // Default: hide procedural votes (cloture, passage motions, etc.).
  // Pass ?include_procedural=true to show all — for researchers/journalists.
  const includeProcedural = searchParams.get("include_procedural") === "true";
  // Individual donor display mode (FIX-194).
  // 'bracket'   = aggregate into 4 tier nodes per official (default)
  // 'connector' = real nodes for donors giving to 2+ officials; rest → brackets
  // 'employer'  = synthetic employer-group nodes per official
  // 'off'       = pass all individuals through as real nodes (researcher mode)
  const individualMode = (searchParams.get("individualMode") ?? "bracket") as IndividualDisplayMode;
  const connectorMin = Math.max(2, parseInt(searchParams.get("connectorMin") ?? "2", 10));
  // FIX-802 — whitelisted fetch caps (see constants above). Anything off the
  // whitelist falls back to the default so cache keys stay enumerable.
  const donorLimitRaw = parseInt(searchParams.get("limit") ?? "", 10);
  const donorLimit = DONOR_LIMIT_CHOICES.includes(donorLimitRaw) ? donorLimitRaw : DEFAULT_DONOR_LIMIT;
  const votesLimitRaw = parseInt(searchParams.get("votes_limit") ?? "", 10);
  const votesLimit = VOTES_LIMIT_CHOICES.includes(votesLimitRaw) ? votesLimitRaw : DEFAULT_VOTES_LIMIT;

  try {
    const supabase = createAdminClient();

    let connections: ConnectionRow[] = [];
    let totalCount = 0;
    // Set when an edge-hydration load was capped at a safety ceiling — surfaced to
    // the client so a truncated graph is honest rather than silently incomplete (FIX-428).
    let partial = false;
    // FIX-781 — set when the depth-2 budget tripped or a depth-2 read failed;
    // surfaced as meta.depth2Truncated. Depth-1 data is always complete.
    let depth2Truncated = false;

    // FIX-802 — side-state for rollup-sourced donation/opposition edges:
    //   mvDonorInfo  donor_id → name/entity_type from the MV (these ids skip
    //                the financial_entities NAME fetch — the rollup is the
    //                name source for aggregate edges)
    //   mvTxCounts   pseudo-row id → tx_count (edge payload txCount)
    //   tailAggs     per (official, type) unnamed-remainder aggregates
    const mvDonorInfo = new Map<string, { label: string; subType: string; industryTag?: string; industryLabel?: string }>();
    const mvTxCounts = new Map<string, number>();
    const tailAggs = new Map<string, TailAgg>();

    // Tracks which neighbor nodes were not auto-expanded: entityId → connection
    // count (undefined when the count itself is unknown — depth-2 degrade path).
    const collapsedNodes = new Map<string, number | undefined>();

    if (entityId) {
      // ── Entity-focused mode — parallel type-bucketed fetches ───────────
      // Donation + opposition for a focused OFFICIAL come from
      // official_donor_rollup_mv (FIX-802) — see MvRollupRow above. The raw
      // entity_connections read this replaces was unbounded behind a stale
      // "never more than ~20-30" comment; Allred carries 31,368 donation
      // edges and blew the 5s withDbTimeout under IOWait (the 500 users hit).
      // Votes are capped at votes_limit most recent; oversight-class and
      // investigation reads are capped too — no unbounded EC read remains.
      const VOTE_TYPES = [
        "vote_yes", "vote_no", "vote_abstain",
        "nomination_vote_yes", "nomination_vote_no",
      ] as const;
      const OVERSIGHT_TYPES = ["oversight", "appointment", "co_sponsorship", "revolving_door", "contract_award"] as const;

      const [officialProbeRes, rollupRes, votesRes, oversightRes, investigationRes] = await Promise.all([
        // Cheap PK probe: the rollup keys recipients of BOTH kinds (officials
        // and super-PAC financial_entities, FIX-704), but only an official
        // focus is fully served by it — a financial focus also has OUTBOUND
        // donations the MV doesn't key by donor, so it takes the capped raw
        // fallback (decision 6).
        withDbTimeout(
          supabase.from("officials").select("id").eq("id", entityId).limit(1),
          5000,
          "connections:official-probe",
        ),
        withDbTimeout(
          supabase
            .from("official_donor_rollup_mv")
            .select("relationship_type, rank, donor_id, donor_name, entity_type, total_cents, tx_count, tail_donor_count, industry_tag, industry_label")
            .eq("official_id", entityId)
            .in("relationship_type", ["donation", "ie_support", "ie_oppose"])
            .order("rank", { ascending: true }),
          5000,
          "connections:donor-rollup",
        ),
        withDbTimeout(
          supabase
            .from("entity_connections")
            .select("*")
            .in("connection_type", VOTE_TYPES)
            .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
            .order("occurred_at", { ascending: false, nullsFirst: false })
            .limit(votesLimit),
          5000,
          "connections:votes",
        ),
        // Previously unbounded → silently MAX_ROWS-capped for contract-heavy
        // agencies. Amount-ordered cap keeps the biggest-dollar edges.
        withDbTimeout(
          supabase
            .from("entity_connections")
            .select("*")
            .in("connection_type", OVERSIGHT_TYPES)
            .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
            .order("amount_cents", { ascending: false, nullsFirst: false })
            .limit(RAW_EDGE_CAP),
          5000,
          "connections:oversight",
        ),
        // FIX-584 — investigation-sourced edges by source, not connection_type:
        // a promoted edge card can carry any of the 16 assertable relationship_kinds
        // (member_of / owns / lobbying / family / …), most of which fall outside the
        // type-bucketed fetches above. Fetching by evidence_source guarantees every
        // promoted edge touching this entity surfaces. The set is tiny
        // (hand-curated); the cap is a pure backstop (FIX-802 no-unbounded rule).
        withDbTimeout(
          supabase
            .from("entity_connections")
            .select("*")
            .eq("evidence_source", "investigation")
            .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
            .limit(RAW_EDGE_CAP),
          5000,
          "connections:investigation",
        ),
      ]);

      // Check every edge-type result, not just donations — a votes/oversight
      // timeout was previously merged blind, silently dropping those edge types
      // and presenting a partial graph as complete (FIX-431). Fail loud instead.
      if (officialProbeRes.error) throw officialProbeRes.error;
      if (rollupRes.error) throw rollupRes.error;
      if (votesRes.error) throw votesRes.error;
      if (oversightRes.error) throw oversightRes.error;
      if (investigationRes.error) throw investigationRes.error;

      const isOfficialFocus = (officialProbeRes.data ?? []).length > 0;
      const mvRows = (rollupRes.data ?? []) as MvRollupRow[];

      const direct: ConnectionRow[] = [
        ...(oversightRes.data ?? []),
        ...(votesRes.data ?? []),
        ...(investigationRes.data ?? []),
      ];

      if (isOfficialFocus && mvRows.length > 0) {
        // ── MV path (FIX-802) ────────────────────────────────────────────
        // relationship_type mapping mirrors the EC derivation (FIX-747):
        // donation + ie_support → connection_type 'donation'; ie_oppose →
        // 'opposition'. A donor named under both donation and ie_support
        // merges into one edge (summed cents/tx) — EC keys one edge per
        // (donor, official, type) pair, so the merged edge matches what the
        // raw path rendered.
        const donationByDonor = new Map<string, MvDonorAgg>();
        const oppositionByDonor = new Map<string, MvDonorAgg>();
        const donationTail: TailAgg = { connType: "donation", officialId: entityId, cents: 0, tx: 0, donorCount: 0 };
        const oppositionTail: TailAgg = { connType: "opposition", officialId: entityId, cents: 0, tx: 0, donorCount: 0 };

        for (const r of mvRows) {
          const cents = Number(r.total_cents) || 0;
          const tx = Number(r.tx_count) || 0;
          const isOpp = r.relationship_type === "ie_oppose";
          if (r.donor_id == null) {
            // rank-201 tail bucket — everything beyond the MV's top-200
            const tail = isOpp ? oppositionTail : donationTail;
            tail.cents += cents;
            tail.tx += tx;
            tail.donorCount += Number(r.tail_donor_count) || 0;
            continue;
          }
          const map = isOpp ? oppositionByDonor : donationByDonor;
          const existing = map.get(r.donor_id);
          if (existing) {
            existing.cents += cents;
            existing.tx += tx;
          } else {
            map.set(r.donor_id, {
              donorId: r.donor_id,
              name: r.donor_name ?? "Unknown donor",
              entityType: r.entity_type ?? "unknown",
              cents,
              tx,
              ...(r.industry_tag ? { industryTag: r.industry_tag, industryLabel: r.industry_label ?? undefined } : {}),
            });
          }
        }

        const donationDonors = [...donationByDonor.values()].sort((a, b) => b.cents - a.cents);
        const oppositionDonors = [...oppositionByDonor.values()].sort((a, b) => b.cents - a.cents);

        // Top-N governs NAMED nodes (decision 4): in bracket/connector/employer
        // modes the cap applies to institutional donors (individuals — ALL
        // stored ranks — feed the bracket machinery below); with
        // individualMode=off it caps named donors of every entity_type. Rows
        // past the cap fold into the tail aggregate so totals stay exact.
        let namedDonation: MvDonorAgg[];
        let foldedDonation: MvDonorAgg[];
        if (individualMode === "off") {
          namedDonation = donationDonors.slice(0, donorLimit);
          foldedDonation = donationDonors.slice(donorLimit);
        } else {
          const individuals = donationDonors.filter((d) => d.entityType === "individual");
          const institutions = donationDonors.filter((d) => d.entityType !== "individual");
          namedDonation = [...institutions.slice(0, donorLimit), ...individuals];
          foldedDonation = institutions.slice(donorLimit);
        }
        const namedOpposition = oppositionDonors.slice(0, donorLimit);
        const foldedOpposition = oppositionDonors.slice(donorLimit);

        for (const d of foldedDonation) {
          donationTail.cents += d.cents;
          donationTail.tx += d.tx;
          donationTail.donorCount += 1;
        }
        for (const d of foldedOpposition) {
          oppositionTail.cents += d.cents;
          oppositionTail.tx += d.tx;
          oppositionTail.donorCount += 1;
        }

        for (const d of namedDonation) {
          const row = mvPseudoRow(entityId, d, "donation");
          mvTxCounts.set(row.id, d.tx);
          mvDonorInfo.set(d.donorId, { label: d.name, subType: d.entityType, industryTag: d.industryTag, industryLabel: d.industryLabel });
          direct.push(row);
        }
        for (const d of namedOpposition) {
          const row = mvPseudoRow(entityId, d, "opposition");
          mvTxCounts.set(row.id, d.tx);
          mvDonorInfo.set(d.donorId, { label: d.name, subType: d.entityType, industryTag: d.industryTag, industryLabel: d.industryLabel });
          direct.push(row);
        }

        if (donationTail.donorCount > 0 || donationTail.cents > 0) {
          tailAggs.set(`donation:${entityId}`, donationTail);
        }
        if (oppositionTail.donorCount > 0 || oppositionTail.cents > 0) {
          tailAggs.set(`opposition:${entityId}`, oppositionTail);
        }
      } else {
        // ── Raw fallback (decision 6): non-official focus (a PAC's OUTBOUND
        // donations aren't keyed by it in the MV) or an official absent from
        // the MV. Capped + amount-ordered — never unbounded.
        const [donationsRes, oppositionRes] = await Promise.all([
          withDbTimeout(
            supabase
              .from("entity_connections")
              .select("*")
              .eq("connection_type", "donation")
              .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
              .order("amount_cents", { ascending: false, nullsFirst: false })
              .limit(RAW_EDGE_CAP),
            5000,
            "connections:donations-raw",
          ),
          // FIX-747 — opposition (IE-against) edges are financial→official;
          // their own bucket so they surface on a focused official/PAC graph.
          withDbTimeout(
            supabase
              .from("entity_connections")
              .select("*")
              .eq("connection_type", "opposition")
              .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
              .order("amount_cents", { ascending: false, nullsFirst: false })
              .limit(RAW_EDGE_CAP),
            5000,
            "connections:opposition-raw",
          ),
        ]);
        if (donationsRes.error) throw donationsRes.error;
        if (oppositionRes.error) throw oppositionRes.error;
        direct.push(...(donationsRes.data ?? []), ...(oppositionRes.data ?? []));
      }

      if (depth >= 2 && direct.length > 0) {
        // FIX-781 — the whole depth-2 phase runs under a JS deadline. Budget
        // checks land between chunks; a trip or read error degrades the
        // remaining neighbors to collapsed nodes (+ meta.depth2Truncated)
        // instead of 500ing the request.
        const deadlineAt = Date.now() + DEPTH2_BUDGET_MS;

        // Get all neighbor IDs from direct connections
        const neighborIds = Array.from(
          new Set(direct.map((c) => (c.from_id === entityId ? c.to_id : c.from_id)))
        );

        // Count how many connections each neighbor has (to decide auto-expand vs. collapsed).
        // FIX-503 counted neighbor degrees with the get_connection_counts RPC
        // (from+to UNION ALL GROUP BY, server-side). FIX-774 reads the same
        // per-entity counts from entity_connection_stats_mv (one row per entity,
        // both directions pre-folded, refreshed after each entity_connections
        // rebuild) instead — the live RPC re-COUNTs ~5.68M edges on every call
        // and blew the 8s authenticator cap on high-degree entities (FIX-499),
        // which is the 500 users hit. A neighbor absent from the MV genuinely
        // has zero edges → count 0. Chunk at 200: supabase-js encodes the .in()
        // filter in the request URL, and ~356 uuids (~13KB) trips PostgREST's
        // 414 URI-too-long (verified in the FIX-509 treemap swap), so the RPC's
        // old 500-wide uuid[] body arg can't carry over to a URL-based read.
        const neighborConnCounts = new Map<string, number>();
        const STATS_CHUNK = 200;
        let statsDegraded = false;
        for (let i = 0; i < neighborIds.length; i += STATS_CHUNK) {
          if (Date.now() > deadlineAt) {
            statsDegraded = true;
            depth2Truncated = true;
            break;
          }
          const chunk = neighborIds.slice(i, i + STATS_CHUNK);
          const { data, error } = await withDbTimeout(
            supabase
              .from("entity_connection_stats_mv")
              .select("entity_id, connection_count")
              .in("entity_id", chunk)
              .limit(chunk.length),
            5000,
            "connections:depth2-stats",
          );
          if (error) {
            console.error("[graph/connections] depth-2 stats chunk failed — degrading:", error.message);
            statsDegraded = true;
            depth2Truncated = true;
            break;
          }
          for (const r of (data ?? []) as Array<{ entity_id: string; connection_count: number | string }>) {
            neighborConnCounts.set(r.entity_id, Number(r.connection_count));
          }
        }

        const autoExpandIds: string[] = [];
        for (const id of neighborIds) {
          if (statsDegraded && !neighborConnCounts.has(id)) {
            // Degree unknown (budget/error) — collapsed; manual expand still works
            collapsedNodes.set(id, undefined);
            continue;
          }
          const count = neighborConnCounts.get(id) ?? 0;
          if (count >= MAX_AUTO_EXPAND) {
            // Too many connections — show as collapsed, let user expand manually
            collapsedNodes.set(id, count);
          } else {
            autoExpandIds.push(id);
          }
        }

        // Hydrate expansion edges in bounded neighbor chunks: each chunk is
        // ≤ EXPAND_CHUNK neighbors × < MAX_AUTO_EXPAND edges, so a budget trip
        // or read error degrades only the REMAINING neighbors. Pagination
        // inside a chunk still guards MAX_ROWS truncation (FIX-428).
        const EXPAND_CHUNK = 50;
        const expandedRows: ConnectionRow[] = [];
        let cursor = 0;
        while (cursor < autoExpandIds.length) {
          if (Date.now() > deadlineAt) {
            depth2Truncated = true;
            break;
          }
          const chunk = autoExpandIds.slice(cursor, cursor + EXPAND_CHUNK);
          const [expandFromRes, expandToRes] = await Promise.all([
            fetchAllPaged<ConnectionRow>((f, t) =>
              withDbTimeout(
                supabase.from("entity_connections").select("*").in("from_id", chunk).range(f, t),
                5000,
                "connections:depth2-from",
              )),
            fetchAllPaged<ConnectionRow>((f, t) =>
              withDbTimeout(
                supabase.from("entity_connections").select("*").in("to_id", chunk).range(f, t),
                5000,
                "connections:depth2-to",
              )),
          ]);
          if (expandFromRes.error || expandToRes.error) {
            console.error(
              "[graph/connections] depth-2 expansion chunk failed — degrading:",
              expandFromRes.error?.message ?? expandToRes.error?.message,
            );
            depth2Truncated = true;
            break;
          }
          expandedRows.push(...expandFromRes.rows, ...expandToRes.rows);
          cursor += EXPAND_CHUNK;
        }
        // Neighbors whose hydration never ran degrade to collapsed.
        for (const id of autoExpandIds.slice(cursor)) {
          collapsedNodes.set(id, neighborConnCounts.get(id));
        }

        if (expandedRows.length > 0) {
          const connMap = new Map<string, ConnectionRow>();
          for (const c of [...direct, ...expandedRows]) {
            connMap.set(c.id, c);
          }
          connections = [...connMap.values()];
        } else {
          connections = direct;
        }
      } else {
        connections = direct;
      }

      if (!includeProcedural) {
        connections = await filterProceduralConnections(supabase, connections);
      }

      totalCount = connections.length;

    } else {
      // ── Default view: top 10 most connected officials ──────────────────
      // Use a HEAD request for the total count (no rows transferred), then
      // two small targeted queries (officials only, capped at 3 000 each)
      // to find the top 10 by connection frequency.
      // Previously fetched all 143 k rows client-side — ~100× egress reduction.
      // QWEN-ADDED: Add generic type to withDbTimeout for count-only HEAD query
      const { count, error: countErr } = await withDbTimeout<{
        count: number | null;
        error: { message: string } | null;
      }>(
        supabase
          .from("entity_connections")
          .select("*", { count: "exact", head: true })
      );

      if (countErr) throw countErr;
      totalCount = count ?? 0;

      if (totalCount === 0) {
        return withPublicCdnCache(Response.json({ nodes: [], edges: [], count: 0 }));
      }

      // FIX-476 — true top-10 by degree via a GROUP BY RPC. The prior approach
      // (two `.limit(3000)` selects, no ORDER BY) was silently capped to 1000 by
      // PostgREST max_rows, so the "top 10" came from an arbitrary slice of the
      // ~143k-row table. RPCs aren't row-capped. Fall back to the old capped
      // sample if the RPC is unavailable (e.g. prod schema-cache cold-start).
      let top10Ids: string[] = [];
      const topRes = await supabase.rpc("get_top_connected_officials", { p_limit: 10 });
      if (!topRes.error && Array.isArray(topRes.data) && topRes.data.length > 0) {
        top10Ids = topRes.data.map((r) => r.entity_id);
      } else {
        if (topRes.error) {
          console.warn("[graph/connections] get_top_connected_officials unavailable, falling back to capped sample:", topRes.error.message);
        }
        const [fromRes, toRes] = await Promise.all([
          supabase.from("entity_connections").select("from_id").eq("from_type", "official").limit(1000),
          supabase.from("entity_connections").select("to_id").eq("to_type", "official").limit(1000),
        ]);
        const officialCounts = new Map<string, number>();
        for (const r of fromRes.data ?? []) {
          officialCounts.set(r.from_id, (officialCounts.get(r.from_id) ?? 0) + 1);
        }
        for (const r of toRes.data ?? []) {
          officialCounts.set(r.to_id, (officialCounts.get(r.to_id) ?? 0) + 1);
        }
        top10Ids = [...officialCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([id]) => id);
      }

      if (top10Ids.length === 0) {
        return withPublicCdnCache(Response.json({ nodes: [], edges: [], count: totalCount }));
      }

      // Top-10 officials are the highest-degree nodes, so this is the egress-sensitive
      // path the default view is designed to keep small. Cap each direction at a safety
      // ceiling and signal `partial` when truncated, rather than silently dropping edges
      // past MAX_ROWS (the prior unbounded load) or fetching the whole table (FIX-428).
      const TOP10_EDGE_CEILING = MAX_ROWS * 5;
      const [expandFromRes, expandToRes] = await Promise.all([
        fetchAllPaged<ConnectionRow>((f, t) =>
          supabase.from("entity_connections").select("*").in("from_id", top10Ids).range(f, t),
          { maxRows: TOP10_EDGE_CEILING }),
        fetchAllPaged<ConnectionRow>((f, t) =>
          supabase.from("entity_connections").select("*").in("to_id", top10Ids).range(f, t),
          { maxRows: TOP10_EDGE_CEILING }),
      ]);
      if (expandFromRes.error) throw expandFromRes.error;
      if (expandToRes.error) throw expandToRes.error;
      if (expandFromRes.truncated || expandToRes.truncated) partial = true;

      const connMap = new Map<string, ConnectionRow>();
      for (const c of [...expandFromRes.rows, ...expandToRes.rows]) {
        connMap.set(c.id, c);
      }
      connections = [...connMap.values()];

      if (!includeProcedural) {
        connections = await filterProceduralConnections(supabase, connections);
      }
    }

    // ── Collect unique entity (type, id) pairs ─────────────────────────────
    const entityMap = new Map<string, { type: string; id: string }>();
    for (const conn of connections) {
      entityMap.set(`${conn.from_type}:${conn.from_id}`, { type: conn.from_type, id: conn.from_id });
      entityMap.set(`${conn.to_type}:${conn.to_id}`, { type: conn.to_type, id: conn.to_id });
    }

    // Also ensure collapsed nodes appear as graph nodes (they're in direct connections
    // but may not have any connections in the expanded set).
    // They're already included via the `direct` connections above — the entity map
    // captures them from the direct connection endpoints.

    const entities = [...entityMap.values()];
    const officialIds  = entities.filter((e) => e.type === "official").map((e) => e.id);
    const agencyIds    = entities.filter((e) => e.type === "agency").map((e) => e.id);
    const proposalIds  = entities.filter((e) => e.type === "proposal").map((e) => e.id);
    const gbIds        = entities.filter((e) => e.type === "governing_body").map((e) => e.id);
    const financialIds = entities.filter((e) => e.type === "financial_entity").map((e) => e.id);

    // ── Batch-fetch names in parallel ──────────────────────────────────────
    // FIX-123: bill_number lives in `bill_details` (one-to-one with proposals)
    // post-cutover, so it's a separate fetch keyed on proposal_id.
    // Every batch is chunked at the shared ID_CHUNK_SIZE (200) with per-chunk
    // error checks (FIX-732/FIX-802/FIX-901) — a 414/timeout here previously
    // fell through `data ?? []` and rendered "Unknown"-labeled nodes on HTTP
    // 200. FIX-772: the prior 500-wide financial chunk 414'd ("URI too long")
    // at ~234 uuids behind local Kong. `strict` makes a failed chunk throw to
    // the route's catch (→ 500) rather than quietly shortening the name map.
    type FinRow = { id: string; display_name: string; entity_type: string; recipient_count?: number | null; metadata?: Record<string, unknown> | null; is_synthetic?: boolean };
    type FinMetaRow = { id: string; entity_type: string; recipient_count?: number | null; metadata?: Record<string, unknown> | null; is_synthetic?: boolean };

    // Rollup-sourced donor ids get their names from the MV (decision 7); fetch
    // only the fields the aggregation modes + synthetic labeling still need.
    const rawFinancialIds = financialIds.filter((id) => !mvDonorInfo.has(id));
    const mvFinancialIds  = financialIds.filter((id) => mvDonorInfo.has(id));

    const finSelect = individualMode === 'employer'
      ? "id, display_name, entity_type, recipient_count, metadata, is_synthetic"
      : "id, display_name, entity_type, recipient_count, is_synthetic";
    const mvFinSelect = individualMode === 'employer'
      ? "id, entity_type, recipient_count, metadata, is_synthetic"
      : "id, entity_type, recipient_count, is_synthetic";

    // FIX-804 — state rides the officials name batch via the single
    // officials_jurisdiction_id_fkey embed (jurisdictions.name is the plain
    // state name). NOT metadata->>'state' — that is {} for federal officials.
    type OfficialNameRow = { id: string; full_name: string; party: string | null; is_synthetic: boolean | null; jurisdictions: { name: string } | null };
    type AgencyNameRow   = { id: string; name: string; acronym: string | null; is_synthetic: boolean | null };
    type ProposalNameRow = { id: string; title: string | null; is_synthetic: boolean | null };
    type BillDetailRow   = { proposal_id: string; bill_number: string | null };
    type GbNameRow       = { id: string; name: string; is_synthetic: boolean | null };

    const STRICT = { strict: true } as const;
    const [finRes, mvFinMetaRes, officialRes, agencyRes, proposalRes, billDetailRes, gbRes] = await Promise.all([
      fetchChunkedByIds<FinRow>(rawFinancialIds, (ids, { label }) =>
        withDbTimeout(supabase.from("financial_entities").select(finSelect).in("id", ids), 5000, label),
        { ...STRICT, label: "connections:fin-names" }),
      fetchChunkedByIds<FinMetaRow>(mvFinancialIds, (ids, { label }) =>
        withDbTimeout(supabase.from("financial_entities").select(mvFinSelect).in("id", ids), 5000, label),
        { ...STRICT, label: "connections:fin-mv-meta" }),
      fetchChunkedByIds<OfficialNameRow>(officialIds, (ids, { label }) =>
        withDbTimeout(supabase.from("officials").select("id, full_name, party, is_synthetic, jurisdictions(name)").in("id", ids), 5000, label),
        { ...STRICT, label: "connections:official-names" }),
      fetchChunkedByIds<AgencyNameRow>(agencyIds, (ids, { label }) =>
        withDbTimeout(supabase.from("agencies").select("id, name, acronym, is_synthetic").in("id", ids), 5000, label),
        { ...STRICT, label: "connections:agency-names" }),
      fetchChunkedByIds<ProposalNameRow>(proposalIds, (ids, { label }) =>
        withDbTimeout(supabase.from("proposals").select("id, title, is_synthetic").in("id", ids), 5000, label),
        { ...STRICT, label: "connections:proposal-names" }),
      fetchChunkedByIds<BillDetailRow>(proposalIds, (ids, { label }) =>
        withDbTimeout(supabase.from("bill_details").select("proposal_id, bill_number").in("proposal_id", ids), 5000, label),
        { ...STRICT, label: "connections:bill-details" }),
      fetchChunkedByIds<GbNameRow>(gbIds, (ids, { label }) =>
        withDbTimeout(supabase.from("governing_bodies").select("id, name, is_synthetic").in("id", ids), 5000, label),
        { ...STRICT, label: "connections:gb-names" }),
    ]);
    // `strict` above guarantees these are complete or the whole Promise.all threw.
    const financialData   = finRes.rows;
    const mvFinMetaRows   = mvFinMetaRes.rows;
    const officialRows    = officialRes.rows;
    const agencyRows      = agencyRes.rows;
    const proposalRows    = proposalRes.rows;
    const billDetailRows  = billDetailRes.rows;
    const gbRows          = gbRes.rows;

    const mvFinMeta = new Map(mvFinMetaRows.map((r) => [r.id, r]));

    const billNumberByProposal = new Map<string, string>();
    for (const b of billDetailRows) {
      if (b.bill_number) billNumberByProposal.set(b.proposal_id, b.bill_number);
    }

    // ── Build name lookup ───────────────────────────────────────────────────
    const nameMap = new Map<string, { label: string; party?: string; subType?: string; role?: string; isSynthetic?: boolean; state?: string; industryTag?: string; industryLabel?: string }>();
    for (const o of officialRows) nameMap.set(o.id, { label: o.full_name, party: o.party ?? undefined, isSynthetic: o.is_synthetic ?? false, state: o.jurisdictions?.name ?? undefined });
    for (const a of agencyRows) nameMap.set(a.id, { label: a.acronym ?? a.name, isSynthetic: a.is_synthetic ?? false });
    for (const p of proposalRows) {
      // FIX-123: bill_number ("HR 1234") goes into role so the tooltip subtitle
      // shows it. Title stays as the primary name. If title is missing, fall
      // back to bill_number rather than rendering blank.
      const billNumber = billNumberByProposal.get(p.id);
      nameMap.set(p.id, {
        label: p.title || billNumber || "Untitled bill",
        role: billNumber,
        isSynthetic: p.is_synthetic ?? false,
      });
    }
    for (const g of gbRows) nameMap.set(g.id, { label: g.name, isSynthetic: g.is_synthetic ?? false });

    // Track individual-donor extra data for bracket/employer aggregation (FIX-194)
    const individualMeta = new Map<string, { recipientCount: number; employer?: string }>();
    for (const f of financialData) {
      nameMap.set(f.id, { label: f.display_name, subType: f.entity_type, isSynthetic: f.is_synthetic ?? false });
      if (f.entity_type === 'individual') {
        const meta = f.metadata as Record<string, string> | null;
        individualMeta.set(f.id, {
          recipientCount: f.recipient_count ?? 0,
          employer: meta?.employer ?? undefined,
        });
      }
    }
    // FIX-802 — rollup-sourced donors: label/type from the MV, synthetic flag +
    // individual meta from the slim fetch.
    for (const [id, info] of mvDonorInfo) {
      const meta = mvFinMeta.get(id);
      nameMap.set(id, { label: info.label, subType: info.subType, isSynthetic: meta?.is_synthetic ?? false, industryTag: info.industryTag, industryLabel: info.industryLabel });
      if (info.subType === 'individual') {
        const m = (meta?.metadata ?? null) as Record<string, string> | null;
        individualMeta.set(id, {
          recipientCount: meta?.recipient_count ?? 0,
          employer: m?.employer ?? undefined,
        });
      }
    }

    // ── Individual-donor bracket/employer aggregation (FIX-194) ──────────────
    // Replaces per-individual nodes+edges with synthetic aggregate nodes when
    // individualMode !== 'off'. Keeps the graph renderable for high-donor officials
    // (e.g. Sanders ~975 individual donors at depth 1).
    type BucketKey = string; // "bracket:{officialId}:{tierId}" or "employer:{officialId}:{normalized}"
    const skipEntityKeys = new Set<string>();
    const skipConnectionIds = new Set<string>();
    const bracketNodes: GraphNode[] = [];
    const bracketEdges: GraphEdge[] = [];

    if (individualMode !== 'off' && individualMeta.size > 0) {
      // FIX-592 — any node that is an endpoint of an investigation-promoted
      // edge is EXEMPT from bracket collapse. Collapsing the donor node made
      // the promoted edge fail the nodeIds guard below, silently dropping
      // admin-reviewed evidence in the default bracket mode. The exempted
      // donor passes through as a real node (its donation edges stay per-edge).
      const investigationEndpointIds = new Set<string>();
      for (const c of connections) {
        if (c.evidence_source === "investigation") {
          investigationEndpointIds.add(c.from_id);
          investigationEndpointIds.add(c.to_id);
        }
      }

      // FIX-852 — distinct recipients per individual donor WITHIN this response.
      // A donor bridging ≥2 recipients is a CONNECTOR: it must render as a real
      // node with its real edges so the recipients stay wired through it. At
      // depth 2 the old code bracketed every donation row per-recipient and
      // deleted the donor globally, so a hop-2 connector (gave to focus A AND
      // neighbor B) was replaced by an unlinked `bracket:{B}:{tier}` island — B
      // lost its only tie to the focus component. That IS the explosion.
      const donorRecipients = new Map<string, Set<string>>();
      for (const c of connections) {
        if (c.connection_type !== 'donation') continue;
        if (c.from_type !== 'financial_entity') continue;
        if (!individualMeta.has(c.from_id)) continue;
        const set = donorRecipients.get(c.from_id) ?? new Set<string>();
        set.add(c.to_id);
        donorRecipients.set(c.from_id, set);
      }
      const isConnectorDonor = (donorId: string): boolean => {
        // In-response bridge: reaches ≥2 recipients in THIS graph → real node.
        if ((donorRecipients.get(donorId)?.size ?? 0) >= 2) return true;
        // Connector viz mode also honors the donor's GLOBAL recipient breadth.
        const meta = individualMeta.get(donorId);
        return individualMode === 'connector' && (meta?.recipientCount ?? 0) >= connectorMin;
      };

      const buckets = new Map<BucketKey, {
        totalCents: number;
        donorCount: number;
        officialId: string;
        tier?: string;
        employer?: string;
      }>();

      for (const c of connections) {
        if (c.connection_type !== 'donation') continue;
        if (c.from_type !== 'financial_entity') continue;
        const meta = individualMeta.get(c.from_id);
        if (!meta) continue; // not an individual donor

        // FIX-592 — investigation-edge endpoints render as real nodes
        if (investigationEndpointIds.has(c.from_id)) continue;

        // FIX-852 — connectors (in-response bridge OR global breadth in connector
        // mode) pass through as real nodes; do NOT bracket or skip their edges.
        if (isConnectorDonor(c.from_id)) continue;

        // Mark THIS ROW as aggregated. The donor NODE is suppressed only if ALL
        // its rows were aggregated (computed after the loop) — a donor with any
        // surviving edge stays a real node so the edge guard can't drop it.
        skipConnectionIds.add(c.id);

        const officialId = c.to_id;
        const amountCents = c.amount_cents ?? 0;

        if (individualMode === 'employer') {
          const rawEmployer = meta.employer ?? '';
          const normalized = rawEmployer ? normalizeEmployer(rawEmployer) : '';
          const employerKey = normalized || 'UNAFFILIATED';
          const bucketKey: BucketKey = `employer:${officialId}:${employerKey}`;
          const existing = buckets.get(bucketKey);
          if (existing) {
            existing.totalCents += amountCents;
            existing.donorCount += 1;
          } else {
            buckets.set(bucketKey, { totalCents: amountCents, donorCount: 1, officialId, employer: employerKey });
          }
        } else {
          // bracket + connector modes: aggregate non-connector donors into tiers
          const tier = BRACKET_TIERS.find(t =>
            amountCents >= t.minCents && (t.maxCents === null || amountCents <= t.maxCents)
          );
          if (!tier) {
            // Below the smallest bracket tier — fold into the official's
            // unnamed-tail aggregate so headline totals stay exact
            // (previously silently dropped, FIX-802).
            const key = `donation:${officialId}`;
            const t = tailAggs.get(key) ?? { connType: 'donation' as const, officialId, cents: 0, tx: 0, donorCount: 0 };
            t.cents += amountCents;
            t.tx += mvTxCounts.get(c.id) ?? 1;
            t.donorCount += 1;
            tailAggs.set(key, t);
            continue;
          }
          const bucketKey: BucketKey = `bracket:${officialId}:${tier.id}`;
          const existing = buckets.get(bucketKey);
          if (existing) {
            existing.totalCents += amountCents;
            existing.donorCount += 1;
          } else {
            buckets.set(bucketKey, { totalCents: amountCents, donorCount: 1, officialId, tier: tier.id });
          }
        }
      }

      // FIX-852 — suppress a donor NODE only if EVERY connection touching it was
      // aggregated into a bracket/tail. A donor with any surviving edge (a
      // connector donation the loop passed through, or a non-donation edge like
      // an investigation link) keeps its node so the edge guard below cannot
      // silently drop that surviving edge. Previously the loop added the donor
      // to skipEntityKeys on the FIRST aggregated row, dropping the whole node.
      const donorTotalRefs = new Map<string, number>();
      const donorAggregatedRefs = new Map<string, number>();
      for (const c of connections) {
        const endpoints: Array<[string, string]> = [
          [c.from_type, c.from_id],
          [c.to_type, c.to_id],
        ];
        for (const [endpointType, endpointId] of endpoints) {
          if (endpointType !== 'financial_entity') continue;
          if (!individualMeta.has(endpointId)) continue;
          donorTotalRefs.set(endpointId, (donorTotalRefs.get(endpointId) ?? 0) + 1);
          if (skipConnectionIds.has(c.id)) {
            donorAggregatedRefs.set(endpointId, (donorAggregatedRefs.get(endpointId) ?? 0) + 1);
          }
        }
      }
      for (const [donorId, total] of donorTotalRefs) {
        if ((donorAggregatedRefs.get(donorId) ?? 0) >= total) {
          skipEntityKeys.add(`financial_entity:${donorId}`);
        }
      }

      for (const [bucketKey, bucket] of buckets) {
        const officialNodeId = `official:${bucket.officialId}`;

        if (individualMode === 'employer') {
          const displayName = bucket.employer === 'UNAFFILIATED'
            ? 'Unaffiliated'
            : bucket.employer!;
          bracketNodes.push({
            id: bucketKey,
            type: 'individual_bracket',
            name: displayName,
            connectionCount: bucket.donorCount,
            donationTotal: bucket.totalCents,
            metadata: {
              isEmployerNode: true,
              employer: bucket.employer,
              donorCount: bucket.donorCount,
              officialId: bucket.officialId,
            },
          });
        } else {
          const tier = BRACKET_TIERS.find(t => t.id === bucket.tier)!;
          bracketNodes.push({
            id: bucketKey,
            type: 'individual_bracket',
            name: `${tier.shortLabel} Donors`,
            connectionCount: bucket.donorCount,
            donationTotal: bucket.totalCents,
            metadata: {
              isBracketNode: true,
              tier: tier.id,
              donorCount: bucket.donorCount,
              officialId: bucket.officialId,
            },
          });
        }

        bracketEdges.push({
          fromId: bucketKey,
          toId: officialNodeId,
          connectionType: 'donation',
          amountUsd: bucket.totalCents / 100,
          strength: logScaleDonation(bucket.totalCents),
          metadata: {
            isBracketEdge: true,
            tier: bucket.tier,
            employer: bucket.employer,
            donorCount: bucket.donorCount,
          },
        });
      }
    }

    // ── Unnamed-remainder aggregate nodes (FIX-802) ───────────────────────────
    // One per (official, connection type): the MV rank-201 tail + named rows
    // folded past the top-N cap + sub-bracket-threshold individuals. Reuses the
    // synthetic bracket node shape; rendered totals equal the true MV sums.
    for (const t of tailAggs.values()) {
      if (t.donorCount <= 0 && t.cents <= 0) continue;
      const nodeId = `tail:${t.connType}:${t.officialId}`;
      bracketNodes.push({
        id: nodeId,
        type: 'individual_bracket',
        name: t.connType === 'opposition'
          ? `${t.donorCount.toLocaleString('en-US')} more opposition spenders`
          : `${t.donorCount.toLocaleString('en-US')} smaller donors`,
        connectionCount: t.donorCount,
        donationTotal: t.cents,
        metadata: { isTailNode: true, donorCount: t.donorCount, officialId: t.officialId },
      });
      bracketEdges.push({
        fromId: nodeId,
        toId: `official:${t.officialId}`,
        connectionType: t.connType,
        amountUsd: t.cents / 100,
        strength: logScaleDonation(t.cents),
        txCount: t.tx,
        metadata: { isTailEdge: true, donorCount: t.donorCount },
      });
    }

    // ── Pre-compute per-financial-entity donation totals (cents) ──────────
    // Used to populate donationTotal on PAC/corporation/individual nodes so
    // the tooltip can show total donations given to officials in this graph.
    const financialDonationTotals = new Map<string, number>();
    for (const c of connections) {
      if (c.connection_type !== 'donation') continue;
      if (c.from_type !== 'financial_entity') continue;
      if (skipConnectionIds.has(c.id)) continue; // aggregated into bracket
      financialDonationTotals.set(
        c.from_id,
        (financialDonationTotals.get(c.from_id) ?? 0) + (c.amount_cents ?? 0),
      );
    }

    // ── Build nodes ────────────────────────────────────────────────────────
    const nodes: GraphNode[] = [];
    for (const [key, { type, id }] of entityMap) {
      // Individual-donor entities that were aggregated into bracket/employer nodes
      // are excluded here — they'll appear via bracketNodes instead.
      if (skipEntityKeys.has(key)) continue;
      const info = nameMap.get(id) ?? { label: `Unknown ${type}` };
      const isCollapsed = collapsedNodes.has(id);
      const donationTotalCents = type === 'financial_entity' ? financialDonationTotals.get(id) : undefined;
      nodes.push({
        id: key,
        type: mapNodeType(type, info.subType),
        name: info.label,
        party: info.party as GraphNode["party"],
        ...(info.role ? { role: info.role } : {}),
        ...(info.isSynthetic ? { isSynthetic: true } : {}),
        // FIX-804 — color-by payload: state (officials) + industry (rollup donors)
        ...(info.state ? { state: info.state } : {}),
        ...(info.industryTag ? { industryTag: info.industryTag, industryLabel: info.industryLabel } : {}),
        ...(donationTotalCents != null ? { donationTotal: donationTotalCents } : {}),
        ...(isCollapsed
          ? { collapsed: true, connectionCount: collapsedNodes.get(id) }
          : {}),
      });
    }
    // Append synthetic bracket/employer/tail aggregate nodes
    nodes.push(...bracketNodes);

    const nodeIds = new Set(nodes.map((n) => n.id));

    // ── Investigation-edge attribution lookup (FIX-585) ──────────────────────
    // An investigation-sourced edge carries evidence_ids = the promoting evidence
    // card id(s). The attribution popover links the CASE FILE (/investigations/[id]),
    // so resolve card id → investigation_id + title + reviewed-at. Small set
    // (hand-curated promotions), one extra round-trip only when present.
    const investAttr = new Map<string, { investigationId: string; title: string; reviewedAt: string }>();
    const investCardIds = Array.from(
      new Set(
        connections
          .filter((c) => c.evidence_source === "investigation" && c.evidence_ids?.[0])
          .map((c) => c.evidence_ids[0] as string),
      ),
    );
    if (investCardIds.length > 0) {
      const { data: invCards } = await supabase
        .from("evidence_cards")
        .select("id, investigation_id, updated_at")
        .in("id", investCardIds);
      const invIds = Array.from(new Set((invCards ?? []).map((c) => c.investigation_id as string)));
      const titleById = new Map<string, string>();
      if (invIds.length > 0) {
        const { data: invs } = await supabase.from("investigations").select("id, title").in("id", invIds);
        for (const i of invs ?? []) titleById.set(i.id as string, i.title as string);
      }
      for (const c of invCards ?? []) {
        investAttr.set(c.id as string, {
          investigationId: c.investigation_id as string,
          title: titleById.get(c.investigation_id as string) ?? "Investigation",
          reviewedAt: c.updated_at as string,
        });
      }
    }

    // ── Build edges ────────────────────────────────────────────────────────
    const edges: GraphEdge[] = [];
    for (const c of connections) {
      // Skip individual-donor donation connections that were aggregated into bracket edges
      if (skipConnectionIds.has(c.id)) continue;
      const sourceKey = `${c.from_type}:${c.from_id}`;
      const targetKey = `${c.to_type}:${c.to_id}`;
      if (!nodeIds.has(sourceKey) || !nodeIds.has(targetKey)) continue;
      // FIX-584/585 — surface evidence_source so investigation-promoted edges render
      // distinctly + filterable, plus the resolved case-file attribution so the
      // popover can render "asserted by [title], reviewed [date]" and deep-link it.
      const attr = c.evidence_source === "investigation" ? investAttr.get(c.evidence_ids?.[0] as string) : undefined;
      edges.push({
        fromId: sourceKey,
        toId: targetKey,
        connectionType: mapEdgeType(c.connection_type),
        amountUsd: c.amount_cents != null ? c.amount_cents / 100 : undefined,
        occurredAt: c.occurred_at ?? undefined,
        strength: Number(c.strength),
        // FIX-802 — rollup-sourced edges are aggregates: txCount is the
        // underlying transaction count (G2 hover labels consume it).
        ...(mvTxCounts.has(c.id) ? { txCount: mvTxCounts.get(c.id) } : {}),
        ...(c.evidence_source ? { evidenceSource: c.evidence_source } : {}),
        ...(attr
          ? { investigationId: attr.investigationId, investigationTitle: attr.title, reviewedAt: attr.reviewedAt }
          : {}),
      });
    }
    // Append synthetic bracket/employer/tail aggregate edges (official endpoints guaranteed in nodeIds)
    edges.push(...bracketEdges);

    return withPublicCdnCache(Response.json({
      nodes,
      edges,
      count: totalCount,
      ...(partial ? { partial: true } : {}),
      ...(depth2Truncated ? { meta: { depth2Truncated: true } } : {}),
    }));
  } catch (err) {
    console.error("[graph/connections]", err);
    return Response.json({ error: "Failed to load graph data" }, { status: 500 });
  }
}
