/**
 * Enrichment queue helpers — shared by the pipeline queue-mode branches and
 * the backlog seeder. Wraps the `enqueue_enrichment` RPC and assembles the
 * context blob a worker will replay in-session to produce tags / summaries
 * without having to re-query the database.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

import { rowsOrThrow } from "@civitics/db";
import { VALID_TOPICS, TOPIC_ICONS, ISSUE_AREAS } from "../tags/topics";

export type EntityType = "proposal" | "official" | "financial_entity";
export type TaskType = "tag" | "summary";
export type EnqueueAction =
  | "created"
  | "retried"
  | "skipped_done"
  | "skipped_pending";

export type EnqueueCounts = Record<EnqueueAction, number>;

export function zeroCounts(): EnqueueCounts {
  return { created: 0, retried: 0, skipped_done: 0, skipped_pending: 0 };
}

export async function enqueue(
  db: Db,
  row: {
    entity_id: string;
    entity_type: EntityType;
    task_type: TaskType;
    context: unknown;
    priority?: number;
    entity_updated_at?: string;
  },
): Promise<EnqueueAction> {
  const { data, error } = await db.rpc("enqueue_enrichment", {
    p_entity_id: row.entity_id,
    p_entity_type: row.entity_type,
    p_task_type: row.task_type,
    p_context: row.context,
    ...(row.priority !== undefined && { p_priority: row.priority }),
    ...(row.entity_updated_at !== undefined && { p_entity_updated_at: row.entity_updated_at }),
  });
  if (error) throw error;
  return data as EnqueueAction;
}

// ---------------------------------------------------------------------------
// Jurisdiction-based priority helpers
// ---------------------------------------------------------------------------

export function jurisdictionToPriority(type: string): number {
  switch (type) {
    case "global":
    case "supranational":
    case "country": return 40;
    case "state":   return 30;
    case "county":  return 20;
    case "city":
    case "district": return 10;
    default:         return 5;
  }
}

export async function loadJurisdictionPriorities(
  db: Db,
  jurisdictionIds: string[],
): Promise<Map<string, number>> {
  if (jurisdictionIds.length === 0) return new Map();
  const unique = [...new Set(jurisdictionIds)];
  const out = new Map<string, number>();
  // FIX-545: was a silent-zero read, and the unique-jurisdiction list from a
  // proposals snapshot can exceed the ~200-id .in() URL cap. Chunk + throw.
  for (let i = 0; i < unique.length; i += 200) {
    const rows = rowsOrThrow(
      await db
        .from("jurisdictions")
        .select("id, type")
        .in("id", unique.slice(i, i + 200)),
      "enrichment jurisdiction-priority preload",
    ) as { id: string; type: string }[];
    for (const j of rows) {
      out.set(j.id, jurisdictionToPriority(j.type));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context builders — shapes the worker needs to reproduce the inline prompt.
// ---------------------------------------------------------------------------

export type ProposalTagInput = {
  id: string;
  title: string;
  summary_plain: string | null;
  metadata: Record<string, unknown> | null;
};

export function buildProposalTagContext(p: ProposalTagInput) {
  const agencyId =
    typeof p.metadata?.["agency_id"] === "string"
      ? (p.metadata["agency_id"] as string)
      : null;
  return {
    title: p.title,
    summary_plain: (p.summary_plain ?? "").slice(0, 300),
    agency_id: agencyId,
    valid_topics: VALID_TOPICS,
    topic_icons: TOPIC_ICONS,
  };
}

export type OfficialTagInput = {
  id: string;
  full_name: string;
  role_title: string;
  party: string | null;
  state: string | null;
  vote_count: number;
  total_raised: number;
  top_industries: string;
};

export function buildOfficialTagContext(o: OfficialTagInput) {
  return {
    full_name: o.full_name,
    role_title: o.role_title,
    party: o.party,
    state: o.state,
    vote_count: o.vote_count,
    total_raised: o.total_raised,
    top_industries: o.top_industries,
    issue_areas: ISSUE_AREAS,
  };
}

export type ProposalSummaryInput = {
  id: string;
  title: string;
  summary_plain: string | null;
  type: string | null;
  agency_name: string | null;
  agency_acronym: string | null;
  // metadata.latest_action — the last legislative/regulatory action text.
  // Stored by congress (bills.ts) and openstates (writer.ts) ingestion but
  // historically dropped from the summary context, leaving the worker with
  // nothing but the title to infer from. Threaded through as grounding for
  // title_only items (FIX-434). null for sources that don't capture it
  // (legistar, courtlistener, regulations).
  latest_action: string | null;
};

export type ProposalContextLevel = "full_summary" | "title_only" | "truly_empty";

/**
 * A `summary_plain` that is just a copy of the title is not a real summary —
 * grounding on it yields title-quality output while falsely claiming
 * `full_summary`. Treat it as no-summary. (Part A audit 2026-05-30: no source
 * populates `summary_plain` today, so this guard is defensive — it bites only
 * if a future ingestion path copies the title into `summary_plain`.)
 */
function isTitleMasqueradingAsSummary(summaryPlain: string, title: string): boolean {
  return summaryPlain.trim().toLowerCase() === title.trim().toLowerCase();
}

export function classifyProposalContext(
  summaryPlain: string | null,
  title: string,
): ProposalContextLevel {
  const sp = (summaryPlain ?? "").trim();
  if (sp.length > 100 && !isTitleMasqueradingAsSummary(sp, title)) return "full_summary";
  if (title.trim().length >= 10) return "title_only";
  return "truly_empty";
}

export function buildProposalSummaryContext(p: ProposalSummaryInput) {
  const context_level = classifyProposalContext(p.summary_plain, p.title);
  return {
    title: p.title,
    summary_plain: p.summary_plain,
    agency_name: p.agency_name,
    agency_acronym: p.agency_acronym,
    type: p.type,
    latest_action: p.latest_action,
    context_level,
    prompt_template: context_level, // worker resolves template by name
    max_tokens: context_level === "full_summary" ? 300 : 200,
  };
}

export type OfficialSummaryInput = {
  id: string;
  full_name: string;
  role_title: string;
  state: string | null;
  party: string | null;
  vote_count: number;
  donor_count: number;
  total_raised: number;
};

export function buildOfficialSummaryContext(o: OfficialSummaryInput) {
  return {
    full_name: o.full_name,
    role_title: o.role_title,
    state: o.state,
    party: o.party,
    vote_count: o.vote_count,
    donor_count: o.donor_count,
    total_raised: o.total_raised,
    max_tokens: 200,
  };
}

// ---------------------------------------------------------------------------
// Financial entity context builder
// ---------------------------------------------------------------------------

// Valid industry tags the AI worker may assign — mirrors INDUSTRY_LABELS in rules.ts.
export const VALID_INDUSTRIES = [
  "pharma", "oil_gas", "finance", "tech", "defense",
  "real_estate", "labor", "agriculture", "legal",
  "retail", "transportation", "lobby",
] as const;

export const INDUSTRY_DISPLAY: Record<string, { label: string; icon: string }> = {
  pharma:         { label: "Pharma",           icon: "💊" },
  oil_gas:        { label: "Oil & Gas",        icon: "🛢" },
  finance:        { label: "Finance",          icon: "📈" },
  tech:           { label: "Tech",             icon: "💻" },
  defense:        { label: "Defense",          icon: "🛡" },
  real_estate:    { label: "Real Estate",      icon: "🏠" },
  labor:          { label: "Labor",            icon: "👷" },
  agriculture:    { label: "Agriculture",      icon: "🌾" },
  legal:          { label: "Legal",            icon: "⚖️" },
  retail:         { label: "Retail",           icon: "🛒" },
  transportation: { label: "Transportation",   icon: "🚛" },
  lobby:          { label: "Lobby / Advocacy", icon: "🏛" },
};

export type FinancialEntityTagInput = {
  id: string;
  display_name: string;
  entity_subtype: string;  // financial_entities.entity_type (pac, corporation, …)
  total_donated_cents: number;
};

export function buildFinancialEntityTagContext(fe: FinancialEntityTagInput) {
  return {
    display_name: fe.display_name,
    entity_subtype: fe.entity_subtype,
    total_donated_cents: fe.total_donated_cents,
    valid_industries: VALID_INDUSTRIES,
    industry_labels: Object.fromEntries(
      Object.entries(INDUSTRY_DISPLAY).map(([k, v]) => [k, v.label])
    ),
  };
}

// ---------------------------------------------------------------------------
// Batch enrichment for officials — vote_count / donor totals / composition
// aren't on the officials row itself. FIX-547: the prior implementation read
// votes + financial_relationships over PostgREST with an unchunked .in()
// (>200-id URL cap) that also truncated at the 1,000-row max_rows cap, so
// counts were massively under-reported (931k votes / 28.6k officials). Route
// through the FIX-426/427 server-side GROUP BY rollup RPCs instead — same
// pattern as tags/rules.ts tagOfficials(). Each RPC returns its whole result
// as one jsonb array, so nothing is truncated and no per-batch .in() is
// needed; build the Map once per run and look up per official.
// ---------------------------------------------------------------------------

export type OfficialAggregate = {
  vote_count: number;
  donor_count: number;
  total_raised: number;
  pac_cents: number;
  individual_cents: number;
  /**
   * Donor-composition summary (PAC vs individual share of total raised) —
   * the rollup can't reconstruct a true sector breakdown. Real per-sector
   * dollars live in official_sector_dollars_mv (FIX-506); wiring that in is
   * a separate follow-up.
   */
  top_industries: string;
};

const RPC_MAX_ATTEMPTS = 5;

// Mirrors callWithRetry in tags/rules.ts: retry transient PostgREST/fetch
// failures, THROW after the attempts cap — a partial/empty rollup must never
// be consumed as "official has no votes/donations".
async function rpcWithRetry<T>(
  label: string,
  fn: () => Promise<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  let lastErr = "unknown error";
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await fn();
      if (!error) return data;
      lastErr = error.message;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < RPC_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error(`${label} failed after ${RPC_MAX_ATTEMPTS} attempts: ${lastErr}`);
}

function donorComposition(total: number, pac: number, individual: number): string {
  if (total <= 0) return "Unknown";
  const pct = (n: number) => Math.round((n / total) * 100);
  const dollars = Math.round(total / 100).toLocaleString("en-US");
  return `PAC ${pct(pac)}%, individual ${pct(individual)}% of $${dollars} raised`;
}

export async function aggregateOfficialStats(
  db: Db,
  officialIds: string[],
): Promise<Map<string, OfficialAggregate>> {
  const out = new Map<string, OfficialAggregate>();
  if (officialIds.length === 0) return out;

  const donorRollup =
    (await rpcWithRetry<
      Array<{
        official_id: string;
        total_cents: number;
        pac_cents: number;
        individual_cents: number;
        donor_count: number;
      }>
    >("get_official_donor_rollup", () => db.rpc("get_official_donor_rollup"))) ?? [];
  const donorByOfficial = new Map<
    string,
    { total: number; pac: number; individual: number; count: number }
  >();
  for (const r of donorRollup) {
    donorByOfficial.set(r.official_id, {
      total: Number(r.total_cents ?? 0),
      pac: Number(r.pac_cents ?? 0),
      individual: Number(r.individual_cents ?? 0),
      count: Number(r.donor_count ?? 0),
    });
  }

  const voteRollup =
    (await rpcWithRetry<Array<{ official_id: string; total_votes: number }>>(
      "get_official_bipartisan_stats",
      () => db.rpc("get_official_bipartisan_stats"),
    )) ?? [];
  const votesByOfficial = new Map<string, number>();
  for (const r of voteRollup) {
    votesByOfficial.set(r.official_id, Number(r.total_votes ?? 0));
  }

  for (const id of officialIds) {
    const d = donorByOfficial.get(id);
    out.set(id, {
      vote_count: votesByOfficial.get(id) ?? 0,
      donor_count: d?.count ?? 0,
      total_raised: d?.total ?? 0,
      pac_cents: d?.pac ?? 0,
      individual_cents: d?.individual ?? 0,
      top_industries: donorComposition(d?.total ?? 0, d?.pac ?? 0, d?.individual ?? 0),
    });
  }
  return out;
}
