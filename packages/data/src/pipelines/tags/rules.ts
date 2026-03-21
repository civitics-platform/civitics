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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertTags(db: any, tags: TagInsert[]): Promise<number> {
  if (tags.length === 0) return 0;
  let upserted = 0;
  for (const tag of tags) {
    const { error } = await db.from("entity_tags").upsert(tag, {
      onConflict: "entity_type,entity_id,tag,tag_category",
    });
    if (error) {
      console.error(`    Tag upsert error [${tag.entity_type}/${tag.tag}]:`, error.message);
    } else {
      upserted++;
    }
  }
  return upserted;
}

// ---------------------------------------------------------------------------
// 1. Proposal rules
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagProposals(db: any): Promise<number> {
  console.log("\n  [1/3] Tagging proposals...");

  const { data: proposals, error } = await db
    .from("proposals")
    .select("id, title, type, status, comment_period_end, introduced_at, created_at, metadata");

  if (error) {
    console.error("    Error fetching proposals:", error.message);
    return 0;
  }
  if (!proposals || proposals.length === 0) {
    console.log("    No proposals found. Skipping.");
    return 0;
  }

  console.log(`    Processing ${proposals.length} proposals`);
  const now = new Date();
  let totalUpserted = 0;

  for (const p of proposals) {
    const tags: TagInsert[] = [];
    const base = { entity_type: "proposal", entity_id: p.id as string, generated_by: "rule" as const, confidence: 1.0, pipeline_version: "v1" };

    // ── Urgency from comment_period_end ──────────────────────────────────
    if (p.comment_period_end) {
      const closeDate = new Date(p.comment_period_end as string);
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

    totalUpserted += await upsertTags(db, tags);
  }

  console.log(`    Upserted ${totalUpserted} proposal tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// 2. Official rules
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagOfficials(db: any): Promise<number> {
  console.log("\n  [2/3] Tagging officials...");

  const { data: officials, error } = await db
    .from("officials")
    .select("id, full_name, party, term_start, term_end, is_active");

  if (error) {
    console.error("    Error fetching officials:", error.message);
    return 0;
  }
  if (!officials || officials.length === 0) {
    console.log("    No officials found. Skipping.");
    return 0;
  }

  console.log(`    Processing ${officials.length} officials`);
  const now = new Date();
  let totalUpserted = 0;

  // Fetch all votes in batch for bipartisan analysis
  const { data: allVotes } = await db
    .from("votes")
    .select("official_id, proposal_id, vote");

  const { data: allFinancials } = await db
    .from("financial_relationships")
    .select("official_id, donor_type, amount_cents");

  // Index votes by official_id
  const votesByOfficial = new Map<string, Array<{ proposal_id: string; vote: string }>>();
  for (const v of allVotes ?? []) {
    const list = votesByOfficial.get(v.official_id) ?? [];
    list.push({ proposal_id: v.proposal_id, vote: v.vote });
    votesByOfficial.set(v.official_id, list);
  }

  // Index yes-votes by proposal_id → set of official_ids for cross-party lookup
  const yesVotesByProposal = new Map<string, Set<string>>();
  for (const v of allVotes ?? []) {
    if (v.vote === "yes") {
      const set = yesVotesByProposal.get(v.proposal_id) ?? new Set();
      set.add(v.official_id);
      yesVotesByProposal.set(v.proposal_id, set);
    }
  }

  // Build party map
  const partyByOfficial = new Map<string, string>();
  for (const o of officials) {
    if (o.party) partyByOfficial.set(o.id, o.party);
  }

  // Index financials by official_id
  const financialsByOfficial = new Map<
    string,
    Array<{ donor_type: string; amount_cents: number }>
  >();
  for (const f of allFinancials ?? []) {
    const list = financialsByOfficial.get(f.official_id) ?? [];
    list.push({ donor_type: f.donor_type, amount_cents: f.amount_cents ?? 0 });
    financialsByOfficial.set(f.official_id, list);
  }

  for (const official of officials) {
    const tags: TagInsert[] = [];
    const base = { entity_type: "official", entity_id: official.id as string, generated_by: "rule" as const, confidence: 1.0, pipeline_version: "v1" };

    // ── Tenure ───────────────────────────────────────────────────────────
    if (official.term_start) {
      const years = yearsBetween(new Date(official.term_start as string), now);
      let tenureTag: string, tenureLabel: string;
      if (years < 2)       { tenureTag = "freshman";  tenureLabel = "Freshman"; }
      else if (years < 6)  { tenureTag = "sophomore"; tenureLabel = "Sophomore"; }
      else if (years < 12) { tenureTag = "veteran";   tenureLabel = "Veteran"; }
      else                  { tenureTag = "senior";    tenureLabel = "Senior"; }

      tags.push({
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
    const officialVotes = votesByOfficial.get(official.id as string) ?? [];
    const officialParty = partyByOfficial.get(official.id as string);
    const totalVotes = officialVotes.length;

    if (totalVotes > 0 && officialParty) {
      const yesVotes = officialVotes.filter((v) => v.vote === "yes");
      let bipartisanYes = 0;

      for (const yv of yesVotes) {
        const votersOnProposal = yesVotesByProposal.get(yv.proposal_id) ?? new Set();
        // Check if any official of different party also voted yes
        const hasCrossParty = Array.from(votersOnProposal).some((oid) => {
          const p = partyByOfficial.get(oid);
          return p && p !== officialParty;
        });
        if (hasCrossParty) bipartisanYes++;
      }

      const bipartisanPct = yesVotes.length > 0 ? bipartisanYes / yesVotes.length : 0;

      if (bipartisanPct > 0.20) {
        tags.push({
          ...base,
          tag: "bipartisan",
          tag_category: "pattern",
          display_label: "Bipartisan",
          display_icon: "🤝",
          visibility: "primary",
          metadata: { bipartisan_pct: Math.round(bipartisanPct * 100) },
        });
      } else if (bipartisanPct < 0.05 && totalVotes > 50) {
        tags.push({
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
    const financials = financialsByOfficial.get(official.id as string) ?? [];
    if (financials.length > 0) {
      const total = financials.reduce((s, f) => s + f.amount_cents, 0);
      const pacTotal = financials
        .filter((f) => f.donor_type === "pac" || f.donor_type === "super_pac")
        .reduce((s, f) => s + f.amount_cents, 0);
      const individualTotal = financials
        .filter((f) => f.donor_type === "individual")
        .reduce((s, f) => s + f.amount_cents, 0);
      const donorCount = financials.length;
      const avgDonation = total / donorCount;

      if (total > 0) {
        const pacPct = pacTotal / total;

        if (pacPct > 0.5) {
          tags.push({
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
          tags.push({
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
          tags.push({
            ...base,
            tag: "large_donor_funded",
            tag_category: "pattern",
            display_label: "Large Donors",
            display_icon: null,
            visibility: "secondary",
            metadata: { avg_donation_cents: Math.round(avgDonation) },
          });
        }

        void individualTotal; // referenced for future use
      }
    }

    totalUpserted += await upsertTags(db, tags);
  }

  console.log(`    Upserted ${totalUpserted} official tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// 3. Financial entity rules (donation size + industry)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagFinancialEntities(db: any): Promise<number> {
  console.log("\n  [3/3] Tagging financial entities...");

  // Load financial_relationships for donation size
  const { data: relationships, error: relErr } = await db
    .from("financial_relationships")
    .select("id, official_id, donor_name, amount_cents");

  if (relErr) {
    console.error("    Error fetching financial_relationships:", relErr.message);
    return 0;
  }

  // Load financial_entities for industry matching
  const { data: entities, error: entErr } = await db
    .from("financial_entities")
    .select("id, name, entity_type");

  if (entErr) {
    console.error("    Error fetching financial_entities:", entErr.message);
    return 0;
  }

  let totalUpserted = 0;

  // ── Donation size tags (per relationship row → tagged on financial entity) ─
  // Build lookup: donor_name → financial_entity id
  const entityByName = new Map<string, string>();
  for (const e of entities ?? []) {
    entityByName.set(String(e.name).trim().toUpperCase(), e.id as string);
  }

  for (const rel of relationships ?? []) {
    const donorName = String(rel.donor_name ?? "").trim().toUpperCase();
    const entityId = entityByName.get(donorName);
    if (!entityId) continue;

    const amountCents = Number(rel.amount_cents ?? 0);
    const base = { entity_type: "financial_entity", entity_id: entityId, generated_by: "rule" as const, confidence: 1.0, pipeline_version: "v1" };

    let tag: string, label: string, icon: string | null, visibility: "primary" | "secondary" | "internal";

    if (amountCents < 500_000) {
      tag = "small_donation"; label = "Small Donation"; icon = null; visibility = "internal";
    } else if (amountCents < 5_000_000) {
      tag = "medium_donation"; label = "Medium Donation"; icon = null; visibility = "secondary";
    } else if (amountCents < 50_000_000) {
      tag = "large_donation"; label = "Large Donation"; icon = "💰"; visibility = "primary";
    } else {
      tag = "major_donation"; label = "Major Donation"; icon = "💰💰"; visibility = "primary";
    }

    const tagRow: TagInsert = {
      ...base, tag, tag_category: "size", display_label: label, display_icon: icon, visibility,
      metadata: { amount_cents: amountCents },
    };
    totalUpserted += await upsertTags(db, [tagRow]);
  }

  // ── Industry from name matching ──────────────────────────────────────────
  for (const entity of entities ?? []) {
    const nameLower = String(entity.name ?? "").toLowerCase();
    const matchedIndustries: string[] = [];

    for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
      const matched = keywords.some((kw) => {
        if (kw.length <= 4) {
          // Short keywords require word boundaries to avoid false positives.
          // e.g. "gas" should not match "gaston"; "ups" should not match "groups"
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`\\b${escaped}\\b`, "i").test(nameLower);
        }
        return nameLower.includes(kw);
      });
      if (matched) matchedIndustries.push(industry);
    }

    if (matchedIndustries.length === 0) continue;

    const baseConfidence = matchedIndustries.length > 1 ? 0.7 : 0.8;
    const base = { entity_type: "financial_entity", entity_id: entity.id as string, generated_by: "rule" as const, pipeline_version: "v1" };

    for (const industry of matchedIndustries) {
      const info = INDUSTRY_LABELS[industry];
      if (!info) continue;
      const tagRow: TagInsert = {
        ...base,
        confidence: baseConfidence,
        tag: industry,
        tag_category: "industry",
        display_label: info.label,
        display_icon: info.icon,
        visibility: baseConfidence >= 0.8 ? "primary" : "secondary",
        metadata: { matched_count: matchedIndustries.length },
      };
      totalUpserted += await upsertTags(db, [tagRow]);
    }
  }

  console.log(`    Upserted ${totalUpserted} financial entity tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// 4. Pre-vote timing flags (donation connections within 90 days before a vote)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagPreVoteConnections(db: any): Promise<number> {
  console.log("\n  [4/4] Tagging pre-vote timing connections...");

  // Fetch financial relationships with created_at as proxy for donation timing
  const { data: relationships, error: relErr } = await db
    .from("financial_relationships")
    .select("official_id, donor_name, created_at");

  if (relErr) {
    console.error("    Error fetching financial_relationships:", relErr.message);
    return 0;
  }

  // Fetch votes with voted_at
  const { data: votes, error: voteErr } = await db
    .from("votes")
    .select("id, official_id, proposal_id, vote, voted_at");

  if (voteErr) {
    console.error("    Error fetching votes:", voteErr.message);
    return 0;
  }

  // Build donation index: official_id → [{donorName, date}]
  const donationsByOfficial = new Map<string, Array<{ donorName: string; date: Date }>>();
  for (const r of relationships ?? []) {
    if (!r.official_id || !r.created_at) continue;
    const list = donationsByOfficial.get(r.official_id) ?? [];
    list.push({ donorName: r.donor_name, date: new Date(r.created_at) });
    donationsByOfficial.set(r.official_id, list);
  }

  // Fetch proposals for titles
  const { data: proposals } = await db.from("proposals").select("id, title");
  const proposalTitles = new Map<string, string>();
  for (const p of proposals ?? []) {
    proposalTitles.set(p.id, p.title ?? "Unknown");
  }

  // Fetch entity_connections (donation type) for entity_id lookups
  const { data: connections } = await db
    .from("entity_connections")
    .select("id, from_id, to_id, connection_type")
    .eq("connection_type", "donation");

  let totalUpserted = 0;

  for (const vote of votes ?? []) {
    if (!vote.voted_at || !vote.official_id) continue;
    const voteDate = new Date(vote.voted_at);
    const donations = donationsByOfficial.get(vote.official_id) ?? [];

    for (const donation of donations) {
      const daysBefore = daysBetween(donation.date, voteDate);
      if (daysBefore <= 0 || daysBefore > 90) continue;

      // Find the entity_connection for this donation relationship
      const connection = (connections ?? []).find(
        (c: { from_id: string; to_id: string; connection_type: string }) =>
          c.to_id === vote.official_id && c.connection_type === "donation"
      );
      if (!connection) continue;

      const proposalTitle = proposalTitles.get(vote.proposal_id) ?? "Unknown proposal";

      // Tag the financial entity (from_id) with pre-vote timing
      const tagRow: TagInsert = {
        entity_type: "financial_entity",
        entity_id: connection.from_id,
        tag: "pre_vote_timing",
        tag_category: "internal",
        display_label: "Pre-Vote Timing",
        display_icon: null,
        visibility: "internal",
        generated_by: "rule",
        confidence: 1.0,
        pipeline_version: "v1",
        metadata: {
          days_before_vote: daysBefore,
          vote_cast: vote.vote,
          proposal_id: vote.proposal_id,
          proposal_title: proposalTitle,
          vote_id: vote.id,
          official_id: vote.official_id,
        },
      };
      totalUpserted += await upsertTags(db, [tagRow]);
    }
  }

  console.log(`    Upserted ${totalUpserted} pre-vote timing tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runRuleBasedTagger(): Promise<{ tagsCreated: number }> {
  console.log("\n=== Rule-based tagger ===");
  const logId = await startSync("tag-rules");
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
