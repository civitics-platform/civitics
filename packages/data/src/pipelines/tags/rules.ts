/**
 * Rule-based entity tagger.
 *
 * All rule-based tags have confidence: 1.0 and generated_by: 'rule'.
 * No AI calls — deterministic, zero cost, runs on every nightly sync.
 *
 * Covers three entity types:
 *   proposal       — urgency, agency sector, scope
 *   official       — tenure, voting pattern, donor pattern
 *   financial_entity — donation size buckets, industry from name matching
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:tag-rules
 */

import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync } from "../sync-log";

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
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function yearsBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

const TAG_CHUNK_SIZE = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertTagChunkWithRetry(db: any, chunk: TagInsert[], maxRetries = 3): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const { error } = await db.from("entity_tags").upsert(chunk, {
      onConflict: "entity_type,entity_id,tag,tag_category",
    });
    if (!error) return true;
    if (i < maxRetries - 1) {
      // Exponential backoff: 500ms, 1000ms, 2000ms — schema cache errors resolve with a short wait
      const wait = 500 * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertTags(db: any, tags: TagInsert[]): Promise<number> {
  if (tags.length === 0) return 0;
  let upserted = 0;
  for (let i = 0; i < tags.length; i += TAG_CHUNK_SIZE) {
    const chunk = tags.slice(i, i + TAG_CHUNK_SIZE);
    const ok = await upsertTagChunkWithRetry(db, chunk);
    if (ok) {
      upserted += chunk.length;
    } else {
      console.error(`    Tag upsert chunk ${i}-${i + chunk.length} failed after retries`);
    }
  }
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

  const totalUpserted = await upsertTags(db, allTags);
  console.log(`    Upserted ${totalUpserted} proposal tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// 2. Official rules
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagOfficials(db: any): Promise<number> {
  console.log("\n  [2/3] Tagging officials...");

  // Paginated — officials is ~27k rows, past the 1,000-row cap (FIX-427).
  const officials = await fetchAllPaged<{
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
  // paginating it with .range() would re-run the ~16s aggregation per page.
  const donorRollup =
    (await callWithRetry<
      Array<{
        official_id: string;
        total_cents: number;
        pac_cents: number;
        individual_cents: number;
        donor_count: number;
      }>
    >("get_official_donor_rollup", () => db.rpc("get_official_donor_rollup"))) ?? [];
  const donorByOfficial = new Map<string, { total: number; pac: number; count: number }>();
  for (const r of donorRollup) {
    donorByOfficial.set(r.official_id, {
      total: Number(r.total_cents ?? 0),
      pac: Number(r.pac_cents ?? 0),
      count: Number(r.donor_count ?? 0),
    });
  }

  const bipartisanRollup =
    (await callWithRetry<
      Array<{
        official_id: string;
        total_votes: number;
        yes_votes: number;
        bipartisan_yes: number;
      }>
    >("get_official_bipartisan_stats", () => db.rpc("get_official_bipartisan_stats"))) ?? [];
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
  }

  // Authoritative rebuild: clear this function's prior rule tags (every official
  // rule tag is tag_category='pattern'), then insert the freshly-computed set.
  // Upsert-only writes would leave stale false positives — e.g. large_donor_funded
  // tags computed from the truncated pre-FIX-427 prefix, or both freshman AND
  // sophomore once an official crosses a tenure boundary.
  const { error: delErr } = await db
    .from("entity_tags")
    .delete()
    .eq("entity_type", "official")
    .eq("generated_by", "rule");
  if (delErr) console.error("    Error clearing prior official rule tags:", delErr.message);

  const totalUpserted = await upsertTags(db, allTags);
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
// 3. Financial entity rules (donation size + industry)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagFinancialEntities(db: any): Promise<number> {
  console.log("\n  [3/3] Tagging financial entities...");

  // Donation totals + first NAICS per entity computed server-side (FIX-437).
  // financial_relationships (~1.9M from financial_entity) exceeds the 1,000-row
  // PostgREST cap; an unbounded select silently truncated to ~0.07% of the data
  // (size tags were built from 477 rows). The rollup returns one jsonb array — a
  // SETOF shape would itself be capped, and .range()-paginating it would re-run
  // the ~1.9M-row aggregation per page. callWithRetry THROWS on exhaustion, so a
  // partial load never reaches the authoritative DELETE below.
  const donationRollup =
    (await callWithRetry<
      Array<{ entity_id: string; total_cents: number | null; naics_code: string | null }>
    >("get_financial_entity_donation_totals", () =>
      db.rpc("get_financial_entity_donation_totals"),
    )) ?? [];

  const allTags: TagInsert[] = [];

  // ── Donation size tags — applies to every donor entity (individuals too) ──
  // Thresholds/visibility unchanged.
  for (const r of donationRollup) {
    if (r.total_cents === null || r.total_cents === undefined) continue; // no donations → no size tag
    const totalCents = Number(r.total_cents);
    const base = { entity_type: "financial_entity", entity_id: r.entity_id, generated_by: "rule" as const, confidence: 1.0, pipeline_version: "v1" };
    let tag: string, label: string, icon: string | null, visibility: "primary" | "secondary" | "internal";
    if (totalCents < 500_000)        { tag = "small_donation";  label = "Small Donation";  icon = null;    visibility = "internal"; }
    else if (totalCents < 5_000_000) { tag = "medium_donation"; label = "Medium Donation"; icon = null;    visibility = "secondary"; }
    else if (totalCents < 50_000_000){ tag = "large_donation";  label = "Large Donation";  icon = "💰";   visibility = "primary"; }
    else                              { tag = "major_donation";  label = "Major Donation";  icon = "💰💰"; visibility = "primary"; }
    allTags.push({ ...base, tag, tag_category: "size", display_label: label, display_icon: icon, visibility, metadata: { total_cents: totalCents } });
  }

  // ── Industry from display_name keyword matching (FEC PACs / orgs) ─────────
  // Scoped to NON-individual entities (FIX-437). Un-truncating the old select
  // would keyword-match 1.05M individual donors by surname (e.g. anyone named
  // "Koch" → oil_gas, "Wells" → finance) — false positives on people. The
  // ~95k PAC/super_pac/party/union/corp/nonprofit/other rows still exceed the
  // 1,000-row cap, so this is paginated. Keyword vocab/confidence/visibility
  // unchanged. fetchAllPaged's callWithRetry THROWS on exhaustion.
  const entities = await fetchAllPaged<{
    id: string;
    display_name: string | null;
    entity_type: string | null;
  }>("financial_entities (non-individual)", (from, to) =>
    db
      .from("financial_entities")
      .select("id, display_name, entity_type")
      .neq("entity_type", "individual")
      .order("id", { ascending: true })
      .range(from, to),
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
  // only ~78 rows). Confidence/visibility unchanged.
  for (const r of donationRollup) {
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

  // Authoritative rebuild (FIX-437): clear this function's own tag categories,
  // then insert the freshly-computed set. Scoped to size + industry so the
  // 'internal' pre_vote_timing tags written by tagPreVoteConnections survive.
  // Runs only AFTER both loads above succeeded (each throws on failure), so a
  // partial load can never wipe good tags. The DELETE goes through a
  // statement_timeout-raised RPC because ~928k rows exceeds the 8s ceiling
  // pinned on the PostgREST roles under contention (a bare .delete() failed with
  // "canceling statement due to statement timeout"). callWithRetry THROWS on
  // exhaustion → a failed clear aborts the rebuild rather than upserting onto a
  // stale table.
  await callWithRetry<number>("clear_financial_entity_rule_tags(size,industry)", () =>
    db.rpc("clear_financial_entity_rule_tags", { p_categories: ["size", "industry"] }),
  );

  const totalUpserted = await upsertTags(db, deduped);
  console.log(`    Upserted ${totalUpserted} financial entity tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// 4. Pre-vote timing flags (donation connections within 90 days before a vote)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagPreVoteConnections(db: any): Promise<number> {
  console.log("\n  [4/4] Tagging pre-vote timing connections...");

  // Fully server-side authoritative rebuild (FIX-437 follow-up). The
  // 'pre_vote_timing' tag is constant per entity — same tag/label/visibility,
  // empty metadata — so there is nothing for Node to compute. The original
  // approach shipped the ~371k qualifying entity ids out as a jsonb array and
  // re-upserted them, which the local PostgREST/Kong gateway reliably failed on
  // ("The upstream server is timing out"), leaving fe_internal stuck at 1. The
  // aggregation itself is ~5s in psql; only the array round-trip was the
  // problem. rebuild_pre_vote_timing_tags() does the DELETE + INSERT…SELECT in
  // one statement under a raised statement_timeout and returns just the count —
  // nothing crosses the gateway but a number. callWithRetry THROWS on
  // exhaustion. "Qualifying" = a financial_entity with ≥1 donation in (0,90]
  // days before any vote by the recipient official (sargable range form so the
  // votes_official_voted_at index applies). Old Node cross-join (~65M pairs) and
  // proposals-title fetch are gone — the tag persists no per-pair detail and no
  // consumer reads it (verified FIX-437).
  const written =
    (await callWithRetry<number>("rebuild_pre_vote_timing_tags", () =>
      db.rpc("rebuild_pre_vote_timing_tags"),
    )) ?? 0;

  const total = Number(written);
  console.log(`    Upserted ${total} pre-vote timing tags`);
  return total;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runRuleBasedTagger(): Promise<{ tagsCreated: number }> {
  console.log("\n=== Rule-based tagger ===");
  const logId = await startSync("tag_rules");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  try {
    const proposalTags     = await tagProposals(db);
    const officialTags     = await tagOfficials(db);
    const financialTags    = await tagFinancialEntities(db);
    const preVoteTags      = await tagPreVoteConnections(db);
    const tagsCreated      = proposalTags + officialTags + financialTags + preVoteTags;

    console.log("\n  ─────────────────────────────────────────────────");
    console.log("  Rule-based tagger report");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  ${"Proposal tags:".padEnd(32)} ${proposalTags}`);
    console.log(`  ${"Official tags:".padEnd(32)} ${officialTags}`);
    console.log(`  ${"Financial entity tags:".padEnd(32)} ${financialTags}`);
    console.log(`  ${"Pre-vote timing tags:".padEnd(32)} ${preVoteTags}`);
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
