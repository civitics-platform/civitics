/**
 * Rule-based entity tagger.
 *
 * All rule-based tags have confidence: 1.0 and generated_by: 'rule'.
 * No AI calls — deterministic, zero cost, runs on every nightly sync.
 *
 * Covers three entity types (Node-side taggers only — the two heavy SQL
 * rebuilds, financial-entity size buckets + pre-vote timing, moved to the
 * pg_cron procedure run_rule_taggers in FIX-716):
 *   proposal       — urgency, agency sector, scope
 *   official       — tenure, voting pattern, donor pattern, industry (FIX-897)
 *   financial_entity — industry from name / NAICS matching
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:tag-rules
 */

import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync } from "../sync-log";
import { selectDirect, rollupJsonbDirect } from "../../lib/heavy-rebuild";
import { withDirectClient, bulkUpsert } from "../../lib/direct-pg-upsert";
import { VALID_INDUSTRIES } from "./topics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TagInsert {
  entity_type: string;
  entity_id: string;
  tag: string;
  tag_category: string;
  display_label: string;
  display_icon: string | null;
  visibility: "primary" | "secondary" | "internal";
  generated_by: "rule";
  confidence: number;
  pipeline_version: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Agency → sector mapping
// ---------------------------------------------------------------------------

const AGENCY_SECTORS: Record<
  string,
  { tag: string; label: string; icon: string; category: string }
> = {
  EPA:  { tag: "environment",         label: "Environment",     icon: "🌊", category: "topic" },
  FDA:  { tag: "healthcare",          label: "Healthcare",      icon: "🏥", category: "topic" },
  FTC:  { tag: "consumer_protection", label: "Consumer",        icon: "🛡", category: "topic" },
  FAA:  { tag: "aviation",            label: "Aviation",        icon: "✈️", category: "topic" },
  SEC:  { tag: "finance",             label: "Finance",         icon: "📈", category: "topic" },
  DOE:  { tag: "energy",              label: "Energy",          icon: "⚡", category: "topic" },
  USDA: { tag: "agriculture",         label: "Agriculture",     icon: "🌾", category: "topic" },
  HHS:  { tag: "healthcare",          label: "Healthcare",      icon: "🏥", category: "topic" },
  DOT:  { tag: "transportation",      label: "Transport",       icon: "🚗", category: "topic" },
  ED:   { tag: "education",           label: "Education",       icon: "📚", category: "topic" },
  HUD:  { tag: "housing",             label: "Housing",         icon: "🏠", category: "topic" },
  DOD:  { tag: "defense",             label: "Defense",         icon: "🛡", category: "topic" },
  DOJ:  { tag: "justice",             label: "Justice",         icon: "⚖️", category: "topic" },
  DHS:  { tag: "homeland_security",   label: "Security",        icon: "🔒", category: "topic" },
  CFPB: { tag: "finance",             label: "Finance",         icon: "📈", category: "topic" },
  OSHA: { tag: "labor",               label: "Labor",           icon: "👷", category: "topic" },
  FCC:  { tag: "technology",          label: "Technology",      icon: "📡", category: "topic" },
  FERC: { tag: "energy",              label: "Energy",          icon: "⚡", category: "topic" },
  NOAA: { tag: "environment",         label: "Environment",     icon: "🌊", category: "topic" },
  FWS:  { tag: "environment",         label: "Environment",     icon: "🌊", category: "topic" },
  NRC:  { tag: "energy",              label: "Energy",          icon: "⚡", category: "topic" },
  CPSC: { tag: "consumer_protection", label: "Consumer",        icon: "🛡", category: "topic" },
  USCG: { tag: "transportation",      label: "Transport",       icon: "⚓", category: "topic" },
  FEMA: { tag: "emergency",           label: "Emergency",       icon: "🚨", category: "topic" },
  VA:   { tag: "veterans",            label: "Veterans",        icon: "🎖", category: "topic" },
  SBA:  { tag: "small_business",      label: "Small Biz",       icon: "🏪", category: "topic" },
};

// ---------------------------------------------------------------------------
// Industry keyword matching for financial entities
// ---------------------------------------------------------------------------

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  pharma: [
    "pharma", "drug", "medical", "health", "biotech",
    "pfizer", "merck", "physician", "hospital", "healthcare",
    "medicine", "surgical", "dental", "optometry", "nursing",
    "american medical", "american hospital", "american dental",
    "american nurses", "ama",
  ],
  oil_gas: [
    "petroleum", "exxon", "chevron", "koch", "pipeline",
    "natural gas", "propane", "fossil", "drilling", "mining",
    "coal", "american petroleum", "independent petroleum",
    "american gas", "conocophillips", "valero", "refin",
    // short keywords (word-boundary matched): oil, gas, bp
    "oil", "gas", "bp", "shell",
  ],
  finance: [
    "bank", "financial", "investment", "securities",
    "goldman", "jpmorgan", "wells", "capital", "credit",
    "insurance", "mortgage", "lending", "asset management",
    "hedge", "private equity", "venture", "ubs",
    "morgan stanley", "blackstone", "fidelity", "vanguard",
    "american bankers", "american financial", "american insurance",
    "independent insurance", "national association of insurance",
    "american council of life",
  ],
  tech: [
    "tech", "software", "google", "amazon", "microsoft",
    "digital", "internet", "semiconductor", "computer",
    "cyber", "telecom", "wireless", "broadband",
    "national cable", "ctia", "information technology",
    "computing", "electronic",
    // short keywords (word-boundary matched): att, meta, data
    "att", "meta", "data", "apple", "verizon", "comcast",
  ],
  defense: [
    "defense", "military", "lockheed", "boeing", "raytheon",
    "northrop", "general dynamics", "leidos", "bae systems",
    "aerospace", "veteran", "navy league", "air force",
    "national guard",
    "association of the united states army",
    // short keywords (word-boundary matched): army
    "army",
  ],
  real_estate: [
    "real estate", "realty", "housing", "property", "realtor",
    "builder", "homebuilder", "apartment",
    "national association of realtors", "national multifamily",
    "mortgage bankers", "home builders",
    "commercial real estate", "retail properties",
    "shopping center",
  ],
  labor: [
    "union", "workers", "seiu", "afscme", "teamsters",
    "ibew", "ufcw", "machinists", "steelworkers",
    "carpenters", "painters", "plumbers", "electricians",
    "teachers", "firefighters", "postal workers",
    "transit workers", "communications workers",
    "sheet metal", "ironworkers", "operating engineers",
    "laborers international",
    // short keywords (word-boundary matched): afl, cwa, police
    "afl", "cwa", "police",
  ],
  agriculture: [
    "farm", "agri", "crop", "cattle", "dairy",
    "sugar", "corn", "soybean", "wheat", "cotton",
    "tobacco", "poultry", "american farm",
    "national farmers", "farm bureau", "rural",
    "agribusiness", "food processing", "crystal sugar",
    "imperial sugar", "american sugar", "rice growers",
    // short keywords (word-boundary matched): pork, beef
    "pork", "beef",
  ],
  legal: [
    "attorney", "trial", "lawyers", "legal",
    "bar association", "american bar", "plaintiffs",
    "tort", "litigation",
    "american association for justice",
  ],
  retail: [
    "retail", "restaurant", "grocery", "walmart", "target",
    "home depot", "costco", "national retail",
    "national restaurant", "american restaurant",
    "convenience store", "drug store", "pharmacy chain",
    "fast food",
    // short keywords (word-boundary matched): food, lowes
    "food", "lowes",
  ],
  transportation: [
    "transport", "trucking", "airline", "railroad",
    "shipping", "freight", "logistics",
    "american trucking", "air transport", "pilots",
    "flight attendants", "united parcel", "fedex",
    "american airlines", "delta", "southwest",
    // short keywords (word-boundary matched): ups
    "ups",
  ],
  lobby: [
    "aipac", "american israel",
    "national rifle", "gun owners", "club for growth",
    "chamber of commerce", "business roundtable",
    "national federation of independent business",
    "citizens united",
    // short keywords (word-boundary matched): nra, nfib
    "nra", "nfib",
  ],
};

const INDUSTRY_LABELS: Record<string, { label: string; icon: string }> = {
  pharma:         { label: "Pharma",          icon: "💊" },
  oil_gas:        { label: "Oil & Gas",       icon: "🛢" },
  finance:        { label: "Finance",         icon: "📈" },
  tech:           { label: "Tech",            icon: "💻" },
  defense:        { label: "Defense",         icon: "🛡" },
  real_estate:    { label: "Real Estate",     icon: "🏠" },
  labor:          { label: "Labor",           icon: "👷" },
  agriculture:    { label: "Agriculture",     icon: "🌾" },
  legal:          { label: "Legal",           icon: "⚖️" },
  retail:         { label: "Retail",          icon: "🛒" },
  transportation: { label: "Transportation",  icon: "🚛" },
  lobby:          { label: "Lobby / Advocacy",icon: "🏛" },
};

// ---------------------------------------------------------------------------
// FIX-897 — official industry labels from donation sector affinity
//
// The derived, citeable replacement for the AI issue-area tags retired by
// FIX-896. Pure functions, exported so the shape and the vocabulary guard are
// testable without a database — the DB half (the ranked read) lives in
// tagOfficials().
// ---------------------------------------------------------------------------

/** Top 3 by dollars — see the rationale at the read site in tagOfficials(). */
export const INDUSTRY_TOP_N = 3;

export type OfficialSector = {
  industry: string;
  total_cents: number;
  donor_count: number;
  /** 1-based, by total_cents DESC. Rank 1 is the primary-visibility pill. */
  rank: number;
};

/**
 * Fail loud on vocabulary drift rather than emitting a null-labelled pill.
 * INDUSTRY_LABELS is this file's label/icon table; VALID_INDUSTRIES in topics.ts
 * is the shared vocabulary. A rollup value outside either means an upstream
 * industry tagger started emitting a slug nobody registered — the FIX-889
 * failure one layer down, and the caller would render a pill with a blank label.
 *
 * NOTE: `'Untagged'` — the rollup's bucket for donors with no industry tag —
 * is filtered out in SQL before this ever sees it. It is not an industry; it is
 * the absence of one, and it would (correctly) throw here.
 */
export function assertIndustryVocabulary(industries: readonly string[]): void {
  const unknown = [...new Set(industries)].filter(
    (i) => !VALID_INDUSTRIES.includes(i as (typeof VALID_INDUSTRIES)[number]) || !INDUSTRY_LABELS[i],
  );
  if (unknown.length > 0) {
    throw new Error(
      `official_sector_affinity_rollup carries industry value(s) outside the vocabulary: ` +
        `${unknown.join(", ")}. Register them in topics.ts VALID_INDUSTRIES + ` +
        `rules.ts INDUSTRY_LABELS, or exclude them at the read — refusing to write ` +
        `null-labelled pills.`,
    );
  }
}

/**
 * One `entity_tags` row per sector, shaped like the tenure/voting/donor blocks'
 * `base` object. Rank 1 is `primary` (the pill that always shows), the rest
 * `secondary` (behind "+N more").
 *
 * `metadata` carries the dollars and the donor count so the number behind the
 * label is auditable from the row itself, and `source: 'donations'` names what
 * the figure is. That wording is load-bearing: sector affinity is
 * donation-scoped by design (FIX-872) and EXCLUDES independent expenditures, so
 * the label must never imply total money raised.
 */
export function buildOfficialIndustryTags(
  officialId: string,
  sectors: readonly OfficialSector[],
): TagInsert[] {
  const out: TagInsert[] = [];
  for (const s of sectors) {
    const info = INDUSTRY_LABELS[s.industry];
    // Unreachable once assertIndustryVocabulary has run (it throws first) —
    // belt-and-braces so a future caller that skips the assert drops the pill
    // rather than rendering a null-labelled one.
    if (!info) continue;
    out.push({
      entity_type: "official",
      entity_id: officialId,
      tag: s.industry,
      tag_category: "industry",
      display_label: info.label,
      display_icon: info.icon,
      visibility: s.rank === 1 ? "primary" : "secondary",
      generated_by: "rule",
      confidence: 1.0,
      pipeline_version: "v1",
      metadata: {
        rank: s.rank,
        total_cents: s.total_cents,
        donor_count: s.donor_count,
        source: "donations",
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// FIX-651: lightweight phase timing. The 2026-06-22 nightly's rule tagger
// burned ~96 min before dying; the rollup reads are now confirmed+lifted (donor
// 34.6s, bipartisan 113.9s on prod, both direct-pg), but whether the remaining
// budget is the entity_tags upserts (2.4 GB / 3.39M rows, capped PostgREST
// path) or the paginated reads is the open deliverable-C question. These logs
// let the next nightly answer it without guessing. Cheap (one Date.now pair per
// phase) — safe to leave in.
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`    [timing] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function yearsBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

// TagInsert field order — the row arrays handed to bulkUpsert align to this.
const TAG_COLUMNS = [
  "entity_type", "entity_id", "tag", "tag_category",
  "display_label", "display_icon", "visibility",
  "generated_by", "confidence", "pipeline_version", "metadata",
] as const;

// FIX-651: direct-pg bulk upsert (was PostgREST .upsert in 500-row chunks with a
// 3× backoff). The financial-industry write measured 92.7s for ~21k rows on
// local Docker (uncapped); on prod's 2.4 GB / 3.39M-row entity_tags under the 8s
// service_role cap the same chunked PostgREST path is slower and retry-prone —
// a material share of the 2026-06-22 rule-tagger 96-min burn. bulkUpsert
// collapses ~N/500 capped round-trips into ~N/4000 uncapped ones over one
// session-statement_timeout-raised connection (the FIX-462 pattern). Conflict
// arbiter is the full unique constraint
// entity_tags_entity_type_entity_id_tag_tag_category_key (verified via \d),
// so ON CONFLICT (cols) DO UPDATE matches PostgREST merge-duplicates byte-for-
// byte. A non-zero `failed` now signals a real data/constraint problem rather
// than a swallowed timeout drop.
async function upsertTags(tags: TagInsert[]): Promise<number> {
  if (tags.length === 0) return 0;
  const rows = tags.map((t) => [
    t.entity_type, t.entity_id, t.tag, t.tag_category,
    t.display_label, t.display_icon, t.visibility,
    t.generated_by, t.confidence, t.pipeline_version, t.metadata,
  ]);
  const { upserted, failed } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table: "entity_tags",
      columns: [...TAG_COLUMNS],
      conflictColumns: ["entity_type", "entity_id", "tag", "tag_category"],
      jsonbColumns: ["metadata"],
      rows,
      label: "entity_tags",
    }),
  );
  if (failed > 0) console.error(`    entity_tags bulk upsert: ${failed} row(s) failed`);
  return upserted;
}

// ---------------------------------------------------------------------------
// Pagination — several tables here exceed the 1,000-row PostgREST cap
// (supabase/config.toml max_rows). Unpaginated selects silently truncate to the
// first 1,000 rows (FIX-427). Mirrors the fetchAll helper in
// enrichment/seed-backlog.ts. NOTE: set-returning RPCs are ALSO subject to the
// cap, so the rollup .rpc() calls below paginate through this same helper.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 5;

// Retry transient PostgREST/fetch failures. Both the local Kong/PostgREST stack
// and Pro occasionally drop a connection mid-pipeline ("TypeError: fetch
// failed"), especially around the heavier rollup RPCs. Crucially this THROWS
// after MAX_ATTEMPTS rather than returning a short result — a partial load must
// never be silently consumed as if complete (that is the FIX-426/427 failure
// mode, and tagOfficials/tagProposals DELETE-then-reinsert on the result).
async function callWithRetry<T>(
  label: string,
  fn: () => Promise<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  let lastErr = "unknown error";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await fn();
      if (!error) return data;
      lastErr = error.message;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
}

async function fetchAllPaged<T>(
  label: string,
  loader: (
    from: number,
    to: number,
  ) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const rows =
      (await callWithRetry<T[]>(`${label} page ${from}-${to}`, () => loader(from, to))) ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Proposal rules
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagProposals(db: any): Promise<number> {
  console.log("\n  [1/3] Tagging proposals...");

  // Paginated — proposals is ~73k rows, far past the 1,000-row cap (FIX-427).
  const proposals = await fetchAllPaged<{
    id: string;
    title: string | null;
    type: string | null;
    status: string | null;
    introduced_at: string | null;
    created_at: string | null;
    metadata: Record<string, unknown> | null;
  }>("proposals", (from, to) =>
    db
      .from("proposals")
      .select("id, title, type, status, introduced_at, created_at, metadata")
      .order("id", { ascending: true })
      .range(from, to),
  );

  if (proposals.length === 0) {
    console.log("    No proposals found. Skipping.");
    return 0;
  }

  console.log(`    Processing ${proposals.length} proposals`);
  const now = new Date();
  const allTags: TagInsert[] = [];

  for (const p of proposals) {
    const tags: TagInsert[] = [];
    const base = { entity_type: "proposal", entity_id: p.id as string, generated_by: "rule" as const, confidence: 1.0, pipeline_version: "v1" };

    // ── Urgency from comment_period_end (lives in metadata post-cutover) ────
    const commentPeriodEnd =
      (p.metadata as Record<string, string> | null)?.["comment_period_end"] ?? null;
    if (commentPeriodEnd) {
      const closeDate = new Date(commentPeriodEnd);
      const days = daysBetween(now, closeDate);

      if (days >= 0 && days <= 7) {
        tags.push({
          ...base,
          tag: "urgent",
          tag_category: "urgency",
          display_label: "Urgent",
          display_icon: "⚡",
          visibility: "primary",
          metadata: { days_until_close: days },
        });
      } else if (days > 7 && days <= 14) {
        tags.push({
          ...base,
          tag: "closing_soon",
          tag_category: "urgency",
          display_label: "Closing Soon",
          display_icon: "⏰",
          visibility: "primary",
          metadata: { days_until_close: days },
        });
      }
    }

    // ── New (added in last 7 days) ────────────────────────────────────────
    if (p.created_at) {
      const createdDaysAgo = daysBetween(new Date(p.created_at as string), now);
      if (createdDaysAgo <= 7) {
        tags.push({
          ...base,
          tag: "new",
          tag_category: "urgency",
          display_label: "New",
          display_icon: "🆕",
          visibility: "secondary",
          metadata: {},
        });
      }
    }

    // ── Agency → sector ───────────────────────────────────────────────────
    const agencyId = (p.metadata as Record<string, string> | null)?.agency_id ?? null;
    if (agencyId && AGENCY_SECTORS[agencyId]) {
      const sector = AGENCY_SECTORS[agencyId];
      tags.push({
        ...base,
        tag: sector.tag,
        tag_category: sector.category,
        display_label: sector.label,
        display_icon: sector.icon,
        visibility: "primary",
        metadata: { agency_id: agencyId },
      });
    }

    // ── Proposal type → scope ─────────────────────────────────────────────
    const type = p.type as string | null;
    if (type === "regulation" || type === "bill" || type === "executive_order") {
      tags.push({
        ...base,
        tag: "national",
        tag_category: "scope",
        display_label: "National Scope",
        display_icon: null,
        visibility: "secondary",
        metadata: { proposal_type: type },
      });
    }

    allTags.push(...tags);
  }

  // Authoritative rebuild: clear this function's prior rule tags, then insert
  // the freshly-computed set. Upsert-only writes would leave stale,
  // time-sensitive tags — 'urgent'/'closing_soon' from elapsed comment windows
  // and 'new' tags older than 7 days — accumulating indefinitely.
  const { error: delErr } = await db
    .from("entity_tags")
    .delete()
    .eq("entity_type", "proposal")
    .eq("generated_by", "rule");
  if (delErr) console.error("    Error clearing prior proposal rule tags:", delErr.message);

  const totalUpserted = await timed(`proposal tags upsert (n=${allTags.length})`, () =>
    upsertTags(allTags),
  );
  console.log(`    Upserted ${totalUpserted} proposal tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// 2. Official rules
// ---------------------------------------------------------------------------

// Exported (FIX-897) so the industry block can be exercised — and, critically,
// re-run — in isolation. The property that matters is that a SECOND run
// reproduces the same industry row count rather than zeroing it: this function's
// authoritative DELETE owns every official rule tag, so anything that wrote
// industry rows from outside would silently vanish on the next nightly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tagOfficials(db: any): Promise<number> {
  console.log("\n  [2/3] Tagging officials...");

  // Paginated — officials is ~27k rows, past the 1,000-row cap (FIX-427).
  const officials = await timed("officials fetch (paged)", () =>
    fetchAllPaged<{
      id: string;
      full_name: string;
      party: string | null;
      term_start: string | null;
      term_end: string | null;
      is_active: boolean;
    }>("officials", (from, to) =>
      db
        .from("officials")
        .select("id, full_name, party, term_start, term_end, is_active")
        .order("id", { ascending: true })
        .range(from, to),
    ),
  );

  if (officials.length === 0) {
    console.log("    No officials found. Skipping.");
    return 0;
  }

  console.log(`    Processing ${officials.length} officials`);
  const now = new Date();

  // Donor + bipartisan rollups computed server-side (FIX-427 / FIX-426). The raw
  // donations (~1.4M) and votes (~590k) can't be loaded into Node and joined
  // without re-truncating at the 1,000-row cap, and the old `.in(donorIds)`
  // lookup would blow the URL-length limit once the donation load was
  // un-truncated (550k+ distinct donor ids). Each RPC returns its whole result
  // as one jsonb array — a SETOF shape would itself be capped at 1,000 rows, and
  // paginating it with .range() would re-run the aggregation per page.
  //
  // FIX-651: both rollups run over a DIRECT pg.Client (rollupJsonbDirect), not
  // the capped admin.rpc()+callWithRetry path. Measured on prod 2026-06-22:
  // get_official_donor_rollup 34.6s (> the 8s service_role cap) and
  // get_official_bipartisan_stats 113.9s (> the ~100s gateway cap). On
  // admin.rpc() the latter blew the gateway on every one of its 5 retries while
  // the 114s function kept running server-side ×5, lock-contending on votes —
  // the core of the enrichment statement_timeout cascade. The per-function
  // ALTER FUNCTION statement_timeout=300s does not re-arm the outer statement's
  // timer; only a session-level raise over a direct connection does.
  // rollupJsonbDirect THROWS on error (no silent partial), preserving the
  // FIX-426/427 contract that tagOfficials DELETE-then-reinserts on the result.
  const donorRollup = await timed("get_official_donor_rollup (direct-pg)", () =>
    rollupJsonbDirect<{
      official_id: string;
      total_cents: number;
      pac_cents: number;
      individual_cents: number;
      donor_count: number;
    }>("get_official_donor_rollup"),
  );
  const donorByOfficial = new Map<string, { total: number; pac: number; count: number }>();
  for (const r of donorRollup) {
    donorByOfficial.set(r.official_id, {
      total: Number(r.total_cents ?? 0),
      pac: Number(r.pac_cents ?? 0),
      count: Number(r.donor_count ?? 0),
    });
  }

  const bipartisanRollup = await timed("get_official_bipartisan_stats (direct-pg)", () =>
    rollupJsonbDirect<{
      official_id: string;
      total_votes: number;
      yes_votes: number;
      bipartisan_yes: number;
    }>("get_official_bipartisan_stats"),
  );
  const voteStatsByOfficial = new Map<
    string,
    { totalVotes: number; yesVotes: number; bipartisanYes: number }
  >();
  for (const r of bipartisanRollup) {
    voteStatsByOfficial.set(r.official_id, {
      totalVotes: Number(r.total_votes ?? 0),
      yesVotes: Number(r.yes_votes ?? 0),
      bipartisanYes: Number(r.bipartisan_yes ?? 0),
    });
  }

  // ── Donation sector affinity → industry labels (FIX-897) ──────────────────
  // The derived replacement for the AI issue-area tags retired by FIX-896.
  // Source is public.official_sector_affinity_rollup (FIX-777): per-(official,
  // industry) donation dollars + distinct donor count, refreshed daily off the
  // FIX-704/832 donor dirty set, deduped by FIX-872/875.
  //
  // Read over direct pg (selectDirect), NOT PostgREST: the rollup is ~18k rows,
  // well past the 1,000-row cap, and a bare .select() would silently truncate —
  // most officials would just quietly lose their labels with no error (FIX-427
  // class). Ranking happens server-side so only the top N rows cross the wire.
  //
  // 'Untagged' is the rollup's bucket for donors carrying no industry tag (4,174
  // of 4,326 officials on prod). It is NOT a member of VALID_INDUSTRIES and is
  // not an industry — it is the absence of one. Excluded here rather than
  // rendered as a meaningless pill.
  //
  // Top 3 by dollars (INDUSTRY_TOP_N): measured on prod 2026-07-26, top-3
  // captures 81.4% of an official's classified donation dollars on average
  // (top-4 85.8%, top-5 89.2%), and the rollup averages ~4.2 industries per
  // labelled official, so three is where the marginal pill stops carrying its
  // own weight. It also matches the EntityTags tier-1 budget of 3.
  type SectorRow = { official_id: string; industry: string; total_cents: string; donor_count: string; rank: string };
  const sectorRows = await timed("official_sector_affinity_rollup (direct-pg)", () =>
    selectDirect<SectorRow>(
      `SELECT official_id, industry, total_cents, donor_count, rank
         FROM (
           SELECT r.official_id,
                  r.industry,
                  r.total_cents,
                  r.donor_count,
                  row_number() OVER (
                    PARTITION BY r.official_id
                    ORDER BY r.total_cents DESC, r.industry
                  ) AS rank
             FROM public.official_sector_affinity_rollup r
             JOIN public.officials o ON o.id = r.official_id
            WHERE o.is_active
              AND r.industry <> 'Untagged'
              AND r.total_cents > 0
         ) ranked
        WHERE rank <= $1`,
      [INDUSTRY_TOP_N],
    ),
  );

  assertIndustryVocabulary(sectorRows.map((r) => r.industry));

  const sectorsByOfficial = new Map<string, OfficialSector[]>();
  for (const r of sectorRows) {
    const list = sectorsByOfficial.get(r.official_id) ?? [];
    list.push({
      industry: r.industry,
      total_cents: Number(r.total_cents),
      donor_count: Number(r.donor_count),
      rank: Number(r.rank),
    });
    sectorsByOfficial.set(r.official_id, list);
  }
  console.log(
    `    Industry labels: ${sectorRows.length} rows across ${sectorsByOfficial.size} officials ` +
      `(top ${INDUSTRY_TOP_N} by donation dollars)`,
  );

  const allTags: TagInsert[] = [];

  for (const official of officials) {
    const base = { entity_type: "official", entity_id: official.id as string, generated_by: "rule" as const, confidence: 1.0, pipeline_version: "v1" };

    // ── Tenure ───────────────────────────────────────────────────────────
    if (official.term_start) {
      const years = yearsBetween(new Date(official.term_start as string), now);
      let tenureTag: string, tenureLabel: string;
      if (years < 2)       { tenureTag = "freshman";  tenureLabel = "Freshman"; }
      else if (years < 6)  { tenureTag = "sophomore"; tenureLabel = "Sophomore"; }
      else if (years < 12) { tenureTag = "veteran";   tenureLabel = "Veteran"; }
      else                  { tenureTag = "senior";    tenureLabel = "Senior"; }

      allTags.push({
        ...base,
        tag: tenureTag,
        tag_category: "pattern",
        display_label: tenureLabel,
        display_icon: null,
        visibility: "secondary",
        metadata: { years_in_office: Math.floor(years) },
      });
    }

    // ── Voting pattern (bipartisan/partisan) ─────────────────────────────
    // Thresholds unchanged; inputs now come from the full-data SQL rollup.
    const voteStats = voteStatsByOfficial.get(official.id as string);
    const officialParty = official.party;

    if (voteStats && voteStats.totalVotes > 0 && officialParty) {
      const bipartisanPct =
        voteStats.yesVotes > 0 ? voteStats.bipartisanYes / voteStats.yesVotes : 0;

      if (bipartisanPct > 0.20) {
        allTags.push({
          ...base,
          tag: "bipartisan",
          tag_category: "pattern",
          display_label: "Bipartisan",
          display_icon: "🤝",
          visibility: "primary",
          metadata: { bipartisan_pct: Math.round(bipartisanPct * 100) },
        });
      } else if (bipartisanPct < 0.05 && voteStats.totalVotes > 50) {
        allTags.push({
          ...base,
          tag: "partisan",
          tag_category: "pattern",
          display_label: "Partisan",
          display_icon: null,
          visibility: "secondary",
          metadata: { bipartisan_pct: Math.round(bipartisanPct * 100) },
        });
      }
    }

    // ── Donor pattern ─────────────────────────────────────────────────────
    // Thresholds unchanged; totals now come from the full-data SQL rollup.
    const donor = donorByOfficial.get(official.id as string);
    if (donor && donor.count > 0) {
      const total = donor.total;
      const pacTotal = donor.pac;
      const donorCount = donor.count;
      const avgDonation = total / donorCount;

      if (total > 0) {
        const pacPct = pacTotal / total;

        if (pacPct > 0.5) {
          allTags.push({
            ...base,
            tag: "pac_heavy",
            tag_category: "pattern",
            display_label: "PAC-Heavy",
            display_icon: "💰",
            visibility: "primary",
            metadata: { pac_percentage: Math.round(pacPct * 100), pac_total_cents: pacTotal },
          });
        }

        if (avgDonation < 50000 && donorCount > 100) {
          allTags.push({
            ...base,
            tag: "grassroots",
            tag_category: "pattern",
            display_label: "Grassroots",
            display_icon: "🌱",
            visibility: "primary",
            metadata: { avg_donation_cents: Math.round(avgDonation), donor_count: donorCount },
          });
        }

        if (avgDonation > 500000) {
          allTags.push({
            ...base,
            tag: "large_donor_funded",
            tag_category: "pattern",
            display_label: "Large Donors",
            display_icon: null,
            visibility: "secondary",
            metadata: { avg_donation_cents: Math.round(avgDonation) },
          });
        }
      }
    }

    // ── Industry (donation sector affinity) ───────────────────────────────
    // FIX-897 — the derived, citeable replacement for the AI issue-area tags
    // retired by FIX-896. Every pill here is backed by a dollar figure and a
    // donor count carried in metadata, not by a model's guess about a named
    // person.
    allTags.push(
      ...buildOfficialIndustryTags(
        official.id as string,
        sectorsByOfficial.get(official.id as string) ?? [],
      ),
    );
  }

  // Authoritative rebuild: clear this function's prior rule tags, then insert
  // the freshly-computed set. Upsert-only writes would leave stale false
  // positives — e.g. large_donor_funded tags computed from the truncated
  // pre-FIX-427 prefix, or both freshman AND sophomore once an official crosses
  // a tenure boundary.
  //
  // NOTE (FIX-897): this DELETE is scoped by (entity_type, generated_by) with NO
  // tag_category filter, so it owns EVERY official rule tag — pattern AND
  // industry. That is exactly why the industry block above lives inside this
  // function: industry rows written by any other job or pipeline would be
  // silently wiped on the next nightly run (the co-owned-rows failure class,
  // cf. FIX-808). If you ever need to write official rule tags from elsewhere,
  // this DELETE must gain a tag_category scope FIRST.
  const { error: delErr } = await db
    .from("entity_tags")
    .delete()
    .eq("entity_type", "official")
    .eq("generated_by", "rule");
  if (delErr) console.error("    Error clearing prior official rule tags:", delErr.message);

  const totalUpserted = await timed(`official tags upsert (n=${allTags.length})`, () =>
    upsertTags(allTags),
  );
  console.log(`    Upserted ${totalUpserted} official tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// NAICS 2-digit → industry tag (for USASpending contractors)
// More-specific 3/4-digit entries override the 2-digit bucket.
// ---------------------------------------------------------------------------

const NAICS2_INDUSTRY: Record<string, string> = {
  "11": "agriculture",
  "21": "oil_gas",
  "22": "oil_gas",
  "31": "agriculture",
  "32": "pharma",
  "33": "defense",
  "42": "retail",
  "44": "retail",
  "45": "retail",
  "48": "transportation",
  "49": "transportation",
  "51": "tech",
  "52": "finance",
  "53": "real_estate",
  "54": "tech",
  "55": "finance",
  "56": "labor",
  "62": "pharma",
  "92": "lobby",
};

const NAICS_OVERRIDE: Record<string, string> = {
  "334": "tech",
  "335": "tech",
  "336": "defense",
  "325": "pharma",
  "326": "pharma",
  "541": "tech",
  "5411": "legal",
  "5412": "finance",
  "5415": "tech",
};

function naicsToIndustry(code: string): string | null {
  const clean = code.trim();
  return (
    NAICS_OVERRIDE[clean.slice(0, 4)] ??
    NAICS_OVERRIDE[clean.slice(0, 3)] ??
    NAICS2_INDUSTRY[clean.slice(0, 2)] ??
    null
  );
}

// ---------------------------------------------------------------------------
// 3. Financial entity rules (industry — size buckets moved to pg_cron, FIX-716)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagFinancialEntities(db: any): Promise<number> {
  console.log("\n  [3/3] Tagging financial entities...");

  // ── Donation size tags — RELOCATED to pg_cron (FIX-716) ──────────────────
  // rebuild_financial_entity_size_tags() (the DELETE('size') + INSERT…SELECT of
  // ~2.33M size tags) and its FIX-652 donation-signature skip gate moved to the
  // pg_cron procedure run_rule_taggers('weekly') — donation-derived, off this
  // nightly critical path, under the 6h role-default budget. The SQL gate reads
  // the SAME pipeline_state key ('size_tags:donation_watermark') with the SAME
  // count+max(created_at)+max(updated_at) signature shape, so continuity holds.
  // This function now writes only the INDUSTRY tags below (keyword + NAICS); the
  // 'size' category is owned entirely by the pg_cron procedure. See
  // supabase/migrations/20260703000100_fix716_rule_taggers_pgcron.sql.

  // NAICS-only rollup (FIX-443): replaces the donation-bearing rollup for the
  // industry path. One row per contract/grant entity carrying a NAICS code — the
  // small slice, not the donor universe — so the payload is safe to fetch.
  const naicsRollup =
    (await callWithRetry<Array<{ entity_id: string; naics_code: string | null }>>(
      "get_financial_entity_naics", () => db.rpc("get_financial_entity_naics"),
    )) ?? [];

  const allTags: TagInsert[] = [];

  // ── Industry from display_name keyword matching (FEC PACs / orgs) ─────────
  // Scoped to NON-individual entities (FIX-437). Un-truncating the old select
  // would keyword-match 1.05M individual donors by surname (e.g. anyone named
  // "Koch" → oil_gas, "Wells" → finance) — false positives on people. The
  // ~78k PAC/super_pac/party/union/corp/nonprofit/other rows.
  //
  // FIX-444: fetched over a DIRECT pg.Client (selectDirect), not PostgREST.
  // OFFSET-paginating `entity_type <> 'individual'` is an index scan over
  // financial_entities that discards the ~1M interleaved individual rows page by
  // page; the deep pages measured ~18s on prod — past the 8s PostgREST role
  // timeout — so the PostgREST path could never complete the keyword pass (the
  // failure FIX-443's gateway death used to mask). One direct query pulls the
  // whole non-individual set in a single scan: no 8s role cap, no 1,000-row
  // max_rows cap, no OFFSET re-scan. Keyword vocab/confidence/visibility below
  // are unchanged.
  const entities = await selectDirect<{
    id: string;
    display_name: string | null;
    entity_type: string | null;
  }>(
    "SELECT id, display_name, entity_type FROM public.financial_entities " +
      "WHERE entity_type <> 'individual' ORDER BY id",
  );

  for (const entity of entities) {
    const nameLower = String(entity.display_name ?? "").toLowerCase();
    const matchedIndustries: string[] = [];

    for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
      const matched = keywords.some((kw) => {
        if (kw.length <= 4) {
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`\\b${escaped}\\b`, "i").test(nameLower);
        }
        return nameLower.includes(kw);
      });
      if (matched) matchedIndustries.push(industry);
    }

    if (matchedIndustries.length > 0) {
      const baseConfidence = matchedIndustries.length > 1 ? 0.7 : 0.8;
      const base = { entity_type: "financial_entity", entity_id: entity.id as string, generated_by: "rule" as const, pipeline_version: "v1" };
      for (const industry of matchedIndustries) {
        const info = INDUSTRY_LABELS[industry];
        if (!info) continue;
        allTags.push({
          ...base,
          confidence: baseConfidence,
          tag: industry,
          tag_category: "industry",
          display_label: info.label,
          display_icon: info.icon,
          visibility: baseConfidence >= 0.8 ? "primary" : "secondary",
          metadata: { matched_count: matchedIndustries.length },
        });
      }
    }
  }

  // ── NAICS → industry for USASpending contractors (from the rollup) ────────
  // First NAICS per entity. Keyword match takes priority on an industry/entity
  // collision (deduped below — keyword tags are pushed first). Applies to all
  // entities: NAICS is a real contract industry code, not a name guess (and is
  // only ~78 rows). Confidence/visibility unchanged. Source is now the tiny
  // NAICS-only RPC (FIX-443), not the OOM-prone donation rollup.
  for (const r of naicsRollup) {
    if (!r.naics_code) continue;
    const industry = naicsToIndustry(r.naics_code);
    if (!industry) continue;
    const info = INDUSTRY_LABELS[industry];
    if (!info) continue;
    allTags.push({
      entity_type: "financial_entity",
      entity_id: r.entity_id,
      tag: industry,
      tag_category: "industry",
      display_label: info.label,
      display_icon: info.icon,
      visibility: "primary",
      confidence: 0.85,
      generated_by: "rule",
      pipeline_version: "v1",
      metadata: { naics_code: r.naics_code },
    });
  }

  // Dedupe by (entity_id, tag, tag_category) — keyword + NAICS can both emit the
  // same industry for one entity, and the batched upsert (ON CONFLICT) cannot
  // affect the same row twice in one statement. Keyword tags are pushed before
  // NAICS, so first-wins preserves the keyword tag.
  const seen = new Set<string>();
  const deduped = allTags.filter((t) => {
    const k = `${t.entity_id}|${t.tag}|${t.tag_category}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Authoritative rebuild of the INDUSTRY category only (FIX-443 — 'size' is now
  // cleared+rebuilt server-side by rebuild_financial_entity_size_tags above).
  // Runs only AFTER both the keyword fetch and the NAICS rollup succeeded (each
  // throws on failure), so a partial load can never wipe good tags. The DELETE
  // goes through a statement_timeout-raised RPC because the 8s ceiling pinned on
  // the PostgREST roles under contention cancels a bare .delete(). callWithRetry
  // THROWS on exhaustion → a failed clear aborts the rebuild rather than
  // upserting onto a stale table.
  await callWithRetry<number>("clear_financial_entity_rule_tags(industry)", () =>
    db.rpc("clear_financial_entity_rule_tags", { p_categories: ["industry"] }),
  );

  const industryUpserted = await timed(`financial industry tags upsert (n=${deduped.length})`, () =>
    upsertTags(deduped),
  );
  // [FIX-716] size tags moved to pg_cron run_rule_taggers('weekly'); this
  // function now returns only the industry tag count.
  console.log(`    Wrote ${industryUpserted} industry tags (size tags now on pg_cron)`);
  return industryUpserted;
}

// ---------------------------------------------------------------------------
// 4. Pre-vote timing flags — RELOCATED to pg_cron (FIX-716)
// ---------------------------------------------------------------------------
// rebuild_pre_vote_timing_tags() (the DELETE + INSERT…SELECT of the
// 'pre_vote_timing' tags) moved to the pg_cron procedure run_rule_taggers('daily')
// — vote-derived, off this nightly critical path under the 6h role-default
// budget. See supabase/migrations/20260703000100_fix716_rule_taggers_pgcron.sql.

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runRuleBasedTagger(): Promise<{ tagsCreated: number }> {
  console.log("\n=== Rule-based tagger ===");
  const logId = await startSync("tag_rules");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  try {
    const proposalTags     = await timed("phase: tagProposals", () => tagProposals(db));
    const officialTags     = await timed("phase: tagOfficials", () => tagOfficials(db));
    const financialTags    = await timed("phase: tagFinancialEntities", () => tagFinancialEntities(db));
    // [FIX-716] pre-vote timing tags moved to pg_cron run_rule_taggers('daily').
    const tagsCreated      = proposalTags + officialTags + financialTags;

    console.log("\n  ─────────────────────────────────────────────────");
    console.log("  Rule-based tagger report");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  ${"Proposal tags:".padEnd(32)} ${proposalTags}`);
    console.log(`  ${"Official tags:".padEnd(32)} ${officialTags}`);
    console.log(`  ${"Financial entity tags:".padEnd(32)} ${financialTags}`);
    console.log(`  ${"Total:".padEnd(32)} ${tagsCreated}`);

    await completeSync(logId, { inserted: tagsCreated, updated: 0, failed: 0, estimatedMb: 0 });
    return { tagsCreated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Rule-based tagger fatal error:", msg);
    await failSync(logId, msg);
    return { tagsCreated: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    try {
      await runRuleBasedTagger();
      process.exit(0);
    } catch (err) {
      console.error("Fatal:", err);
      process.exit(1);
    }
  })();
}
