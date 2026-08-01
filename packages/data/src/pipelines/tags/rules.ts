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

import type { Client } from "pg";
import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync } from "../sync-log";
import { selectDirect, rollupJsonbDirect, callHeavyProcedure } from "../../lib/heavy-rebuild";
import { withDirectClient, bulkUpsert } from "../../lib/direct-pg-upsert";
import { VALID_INDUSTRIES, industryDisplay } from "./topics";

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
  // FIX-916: `curated` joins `rule` here — hand-audited industry overrides for
  // financial entities. The distinction is load-bearing, not cosmetic:
  // clear_financial_entity_rule_tags() is scoped to generated_by='rule', so
  // curated rows deliberately SURVIVE the nightly clear and are owned by their
  // own authoritative delete (clearCuratedIndustryTags below).
  generated_by: "rule" | "curated";
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

// Exported (FIX-908) so industry-vocabulary.test.ts can assert that every key
// here is a real vocabulary member. That invariant is load-bearing: the emit
// loop below drops any match whose key misses INDUSTRY_LABELS (`if (!info)
// continue`), and this function does an AUTHORITATIVE rebuild — it clears the
// whole 'industry' category first. So a key that stops resolving does not
// degrade, it silently ZEROES that industry on the next nightly.
export const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  // FIX-908: key renamed `pharma` → `health` in lockstep with the VALID_INDUSTRIES
  // rename. This key IS the emitted tag — leaving it as `pharma` would make
  // every keyword match resolve to an INDUSTRY_LABELS miss and get dropped by
  // the `if (!info) continue` guard below, silently zeroing the largest industry
  // tag on the next nightly. The keyword list itself is unchanged and was always
  // health-sector, not pharmaceutical-sector; see the note in topics.ts.
  health: [
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

// FIX-908: the local INDUSTRY_LABELS copy that lived here is gone — the map is now
// imported from ./topics, beside VALID_INDUSTRIES, so the vocabulary and its
// labels can no longer drift apart. Runtime lookups on unvalidated keys (rollup
// values, NAICS output) go through industryDisplay().

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
 * Both halves now live in topics.ts (FIX-908): VALID_INDUSTRIES is the vocabulary
 * and INDUSTRY_LABELS (read here via industryDisplay) is its label/icon table. A
 * rollup value outside either means an upstream industry tagger started emitting
 * a slug nobody registered — the FIX-889 failure one layer down, and the caller
 * would render a pill with a blank label.
 *
 * FIX-908 NOTE: official_sector_affinity_rollup STORES the industry key and is
 * refreshed incrementally off the donor dirty set, so a vocabulary key rename
 * must UPDATE that table in the same migration as entity_tags. Renaming only
 * entity_tags leaves stale keys in the rollup for every official whose donors
 * did not change, and this assert then throws and takes the whole official
 * tagger down on the next nightly.
 *
 * NOTE: `'Untagged'` — the rollup's bucket for donors with no industry tag —
 * is filtered out in SQL before this ever sees it. It is not an industry; it is
 * the absence of one, and it would (correctly) throw here.
 */
export function assertIndustryVocabulary(industries: readonly string[]): void {
  const unknown = [...new Set(industries)].filter(isOutOfVocabularyIndustry);
  if (unknown.length > 0) {
    throw new Error(
      `official_sector_affinity_rollup carries industry value(s) outside the vocabulary: ` +
        `${unknown.join(", ")}. Register them in topics.ts (VALID_INDUSTRIES + ` +
        `INDUSTRY_LABELS), or exclude them at the read — refusing to write ` +
        `null-labelled pills.`,
    );
  }
}

/** In the vocabulary AND labellable. Both halves matter — see FIX-908. */
function isOutOfVocabularyIndustry(industry: string): boolean {
  return (
    !VALID_INDUSTRIES.includes(industry as (typeof VALID_INDUSTRIES)[number]) ||
    !industryDisplay(industry)
  );
}

/**
 * FIX-920 — the officials-side read fails SOFT.
 *
 * WHY THIS IS NOT assertIndustryVocabulary(). The two call sites have opposite
 * correct failure modes, and sharing the throwing one was the bug:
 *
 *   - applyIndustryOverrides() (donor side) reads a CHECK-constrained table we
 *     control, one row per curated decision. An out-of-vocabulary value there is
 *     impossible-by-construction, so it means real drift and there is nothing
 *     sensible to degrade to — a silently dropped curated row is
 *     indistinguishable from the deliberate NULL "no industry, ever" case. It
 *     THROWS, and should keep throwing.
 *
 *   - tagOfficials() (this side) reads official_sector_affinity_rollup, whose
 *     `industry` column is an UNCONSTRAINED text mirror of whatever the donor
 *     taggers wrote. Any writer that lands one junk donor tag — the `other` rows
 *     FIX-911 traces to ai-classifier.ts, a future AI answer, a hand-edit —
 *     propagates it into the rollup for every official that donor gave to. If
 *     that value reaches rank <= 3 for even ONE official, the throw takes down
 *     the ENTIRE nightly official tagger: no tenure tags, no voting-pattern
 *     tags, no donor-profile tags, for all ~27k officials. Prod was safe only by
 *     margin — the 8 `other` donors happened not to crack any official's top 3.
 *
 * A missing pill is the right failure for a rendering path. A dead nightly is
 * not. So: drop the unknown rows, count them by key, and let the caller warn.
 *
 * The dropped rows are NOT re-ranked. Ranks come from the SQL window function
 * and are kept as-is, so an official whose rank-2 sector was junk shows its
 * rank-1 and rank-3 pills and simply has one fewer. Re-ranking would silently
 * promote a sector into primary visibility on the strength of a bug.
 *
 * Pure — no DB — so the guard is pinnable by a unit test rather than only
 * reachable through a live nightly. Same convention as FIX-917's
 * selectClassifierCandidates().
 */
export function partitionSectorRowsByVocabulary<T extends { industry: string }>(
  rows: readonly T[],
): { kept: T[]; skipped: Map<string, number> } {
  const kept: T[] = [];
  const skipped = new Map<string, number>();

  for (const row of rows) {
    if (isOutOfVocabularyIndustry(row.industry)) {
      skipped.set(row.industry, (skipped.get(row.industry) ?? 0) + 1);
      continue;
    }
    kept.push(row);
  }

  return { kept, skipped };
}

/** The counted warning for a non-empty partitionSectorRowsByVocabulary() skip set. */
export function formatSectorVocabularyWarning(skipped: ReadonlyMap<string, number>): string {
  const detail = [...skipped.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([industry, n]) => `${industry} (${n} row${n === 1 ? "" : "s"})`)
    .join(", ");
  const total = [...skipped.values()].reduce((a, b) => a + b, 0);
  return (
    `    [FIX-920] SKIPPED ${total} official_sector_affinity_rollup row(s) carrying ` +
    `industry value(s) outside the vocabulary: ${detail}. Those officials lose that ` +
    `pill; every other tag still writes. Register the key in topics.ts ` +
    `(VALID_INDUSTRIES + INDUSTRY_LABELS) or fix the donor tagger that emitted it.`
  );
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
    const info = industryDisplay(s.industry);
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
// FIX-916 — curated industry overrides for financial entities
//
// WHY THIS LIVES INSIDE tagFinancialEntities() AND NOWHERE ELSE
// ------------------------------------------------------------
// tagFinancialEntities() does an AUTHORITATIVE rebuild of the whole `industry`
// category: it calls clear_financial_entity_rule_tags(['industry']), which
// DELETEs every entity_type='financial_entity' AND generated_by='rule' AND
// tag_category='industry' row, and then re-inserts the full keyword+NAICS set.
// An override applied ANYWHERE ELSE — a post-hoc row edit, a separate job, a
// migration — is therefore shadowed by a freshly re-inserted keyword tag on the
// very next nightly. That is the exact trap FIX-897 hit with the official
// industry pills (which is why THAT block also had to move inside tagOfficials)
// and the co-owned-rows failure class of FIX-808. The override has to be the
// last word inside the same function that owns the rebuild.
//
// The rows are written generated_by='curated', which the nightly clear does NOT
// touch (it is scoped to 'rule'). So this function owns them with its own
// authoritative delete-then-insert — see clearCuratedIndustryTags(). That makes
// a re-run a no-op instead of an accumulation, and it means an override whose
// industry CHANGES (or is removed from the table entirely) cannot leave a stale
// curated row behind.
//
// The source list is the 2026-07-27 dollar-weighted audit, committed at
// docs/audits/2026-07-27-industry-tag-overrides.tsv and seeded into
// public.financial_entity_industry_overrides. Keyed on fec_committee_id, not
// financial_entities.id — UUIDs are not portable across a re-seed.
// ---------------------------------------------------------------------------

export type IndustryOverride = {
  /** financial_entities.id, resolved via the fec_committee_id join. */
  entity_id: string;
  fec_committee_id: string;
  /**
   * NULL is a POSITIVE ASSERTION — "this donor carries no industry, ever" — not
   * "unknown". It is the 362 rows written NONE in the audit TSV: leadership
   * PACs, party committees and abstract vanity PACs (WinRed, NRSC, Save
   * America, Huck PAC, AmeriPAC), which are not industries at all. It must
   * SUPPRESS tagging, not merely omit it — several of them trip the keyword
   * list on their own names.
   */
  industry: string | null;
  audited_sector: string | null;
  source: string;
};

/**
 * Apply the curated overrides as the last word over the computed keyword+NAICS
 * industry set.
 *
 * For every overridden entity: drop EVERY keyword/NAICS-derived industry tag it
 * would otherwise have carried, then emit exactly ONE curated row with the
 * override's industry — or none at all when `industry` is NULL.
 *
 * Exactly-one-tag is deliberate and has a second payoff beyond correctness: it
 * collapses 96.4% of the multi-tag donation dollar mass ($328.4M of $340.8M
 * across 478 multi-tag donating donors, measured 2026-07-27) down to a single
 * tag at the source, leaving the alphabetical `DISTINCT ON … ORDER BY tag`
 * tie-break on the eight consuming surfaces almost nothing to arbitrate. That
 * tie-break is NOT changed here — see FIX-918, filed not fixed.
 *
 * Non-industry categories pass through untouched: this function owns the
 * `industry` category only.
 *
 * Pure — no DB. The caller supplies the resolved overrides.
 */
export function applyIndustryOverrides(
  computed: readonly TagInsert[],
  overrides: readonly IndustryOverride[],
): TagInsert[] {
  // Fail loud on vocabulary drift rather than silently dropping a curated row.
  // The DB CHECK constraint already pins `industry` to VALID_INDUSTRIES, so a
  // miss here means INDUSTRY_LABELS drifted away from the vocabulary — and a
  // silent drop would mean the donor keeps NO tag while looking overridden,
  // which is indistinguishable from the NULL case. Same contract as
  // assertIndustryVocabulary() on the officials side.
  assertIndustryVocabulary(
    overrides.map((o) => o.industry).filter((i): i is string => i !== null),
  );

  const overridden = new Set(overrides.map((o) => o.entity_id));

  // Drop every computed industry tag for an overridden entity. Deliberately
  // done here rather than by an early `continue` in the keyword/NAICS loops so
  // that ONE place owns the rule and it stays unit-testable without a database.
  const out = computed.filter(
    (t) => !(t.tag_category === "industry" && overridden.has(t.entity_id)),
  );

  for (const o of overrides) {
    if (o.industry === null) continue; // positive "no industry, ever"
    const info = industryDisplay(o.industry);
    if (!info) continue; // unreachable — assertIndustryVocabulary threw first
    out.push({
      entity_type: "financial_entity",
      entity_id: o.entity_id,
      tag: o.industry,
      tag_category: "industry",
      display_label: info.label,
      display_icon: info.icon,
      // Always primary: a hand-audited assignment is the most confident label
      // this entity will ever carry, and it is now the only one.
      visibility: "primary",
      generated_by: "curated",
      confidence: 1.0,
      pipeline_version: "v1",
      // `audited_sector` is the finer-grained sector the auditor actually
      // recorded (e.g. `credit_union`, `labor_union`, `electric_utility`), kept
      // so the number behind the coarse label stays auditable from the row —
      // mirrors the FIX-897 metadata shape.
      metadata: {
        source: o.source,
        audited_sector: o.audited_sector,
        fec_committee_id: o.fec_committee_id,
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
//
// FIX-949: takes the CALLER's client rather than opening its own, so the upsert
// lands inside the caller's clear+upsert transaction (see withTagRebuild below).
// It stays a plain bulkUpsert — the transaction is opened one level up, never
// around bulkUpsert itself, whose autocommit-per-chunk behaviour FIX-754's
// resume support depends on.
async function upsertTags(client: Client, tags: TagInsert[]): Promise<number> {
  if (tags.length === 0) return 0;
  const rows = tags.map((t) => [
    t.entity_type, t.entity_id, t.tag, t.tag_category,
    t.display_label, t.display_icon, t.visibility,
    t.generated_by, t.confidence, t.pipeline_version, t.metadata,
  ]);
  const { upserted, failed } = await bulkUpsert(client, {
    table: "entity_tags",
    columns: [...TAG_COLUMNS],
    conflictColumns: ["entity_type", "entity_id", "tag", "tag_category"],
    jsonbColumns: ["metadata"],
    rows,
    label: "entity_tags",
  });
  if (failed > 0) {
    // Inside a transaction a failed chunk has already aborted it — every later
    // statement errors and the COMMIT in withTagRebuild degrades to a ROLLBACK.
    // Throw rather than return a short count so the caller rolls back loudly
    // instead of reporting a partial rebuild as a success.
    throw new Error(`entity_tags bulk upsert: ${failed} row(s) failed`);
  }
  return upserted;
}

/**
 * FIX-949 / FIX-945 — run one rule tagger's authoritative rebuild as a single
 * transaction: clear(s) + upsert, all-or-nothing, on one connection.
 *
 * The bug this exists to close: every tagger cleared its category in one
 * transaction and then upserted the recomputed set in a series of separate
 * autocommitted chunks. A process death anywhere in that upsert window — the
 * cancelled nightly of 2026-07-30 05:30 UTC — left the DELETEs committed and
 * the INSERTs half-applied. Prod lost 16k of 40k `rule` industry rows and ALL
 * 425 `curated` ones, and the loss propagated into the sector-affinity rollups
 * before anyone noticed. Ordering discipline (FIX-443) cannot buy this: it
 * guards against exceptions, and by the time the process is killed the DELETEs
 * have already committed.
 *
 * Scope is ONE transaction per tagger, not one across the run — the three
 * categories are independent, and a green proposals rebuild should not be rolled
 * back by a financial-entity failure. Largest single transaction is the
 * financial-entity industry set (~40.5k rows); proposals ~16.5k, officials ~7.1k.
 *
 * The reads stay OUTSIDE, before this opens. FIX-443's ordering is still correct
 * and still load-bearing — the two mechanisms cover different halves: ordering
 * guards against a partial READ reaching the clear, this guards against a
 * partial WRITE surviving the clear.
 */
async function withTagRebuild<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return withDirectClient((client) => runTagRebuildTransaction(client, fn));
}

/**
 * The BEGIN/COMMIT/ROLLBACK core of withTagRebuild, split out so it can be
 * driven by a fake client in tests (opening a real connection is the one part
 * that cannot be). Exported for tests only — production callers want
 * withTagRebuild, which owns the connection lifecycle.
 */
export async function runTagRebuildTransaction<T>(
  client: Client,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    // Best-effort — if the connection itself is gone the server rolls back for
    // us, which is precisely the kill case this exists for.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * FIX-916 — authoritative clear of the CURATED financial-entity industry rows.
 *
 * clear_financial_entity_rule_tags(['industry']) is scoped to
 * generated_by='rule', so curated rows survive it by design (that survival is
 * the whole point — it is what stops the keyword pass from shadowing a hand
 * audit). The consequence is that nothing else would ever remove one: an
 * override whose industry changed, or a row deleted from
 * financial_entity_industry_overrides entirely, would leave a stale curated tag
 * behind forever, and the entity would carry TWO industries — breaking the
 * exactly-one invariant that decision 7 buys.
 *
 * So this function's producer owns them the same way it owns the rule rows:
 * clear the whole curated set, then re-insert from the override table. ~380
 * rows, once a night. Runs in the same position as the rule clear — AFTER every
 * read has succeeded — so a partial load can never wipe good tags (FIX-443).
 *
 * Direct pg rather than PostgREST: a bare .delete() is subject to the 8s role
 * statement_timeout pinned on the prod PostgREST roles, the same reason the rule
 * clear goes through a timeout-raised RPC.
 *
 * FIX-949: takes the caller's client so the DELETE joins the caller's
 * clear+upsert transaction instead of committing on its own connection.
 */
async function clearCuratedIndustryTags(client: Client): Promise<number> {
  const res = await client.query(
    `DELETE FROM public.entity_tags
      WHERE entity_type  = 'financial_entity'
        AND tag_category = 'industry'
        AND generated_by = 'curated'`,
  );
  return res.rowCount ?? 0;
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
  //
  // FIX-949: clear + upsert run in ONE transaction (withTagRebuild), and the
  // clear moved off PostgREST onto the same direct-pg client. Two bugs closed at
  // once. (1) Atomicity: this was clear-in-its-own-txn then autocommitted upsert
  // chunks, so a kill mid-upsert stranded the DELETE without its INSERTs — the
  // FIX-945 shape, which hit the financial-entity path only because that is
  // where the cancelled nightly landed. (2) The old `.delete()` error was
  // console.error'd and then execution FELL THROUGH into the upsert, writing the
  // fresh set onto a table that was never cleared — the exact stale-table
  // outcome FIX-443's ordering was written to prevent, never applied here. A pg
  // error throws, so a failed clear now aborts the rebuild.
  const totalUpserted = await withTagRebuild(async (client) => {
    const cleared = await client.query(
      `DELETE FROM public.entity_tags
        WHERE entity_type = 'proposal' AND generated_by = 'rule'`,
    );
    console.log(`    Cleared ${cleared.rowCount ?? 0} prior proposal rule tags`);
    return timed(`proposal tags upsert (n=${allTags.length})`, () => upsertTags(client, allTags));
  });
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
  // [3/3] since FIX-959 — runs AFTER tagFinancialEntities + the sector-affinity
  // refresh, so the industry pills read a rollup that already reflects tonight's
  // donor tag changes.
  console.log("\n  [3/3] Tagging officials...");

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

  // FIX-920: skip-with-warning, NOT assertIndustryVocabulary(). The rollup's
  // `industry` is an unconstrained text mirror of the donor taggers' output, so
  // one junk donor tag reaching rank <= 3 for a single official used to throw
  // here and kill the tagging run for all ~27k officials — tenure and voting
  // tags included. See partitionSectorRowsByVocabulary() for the full rationale.
  const { kept: renderableSectorRows, skipped: skippedIndustries } =
    partitionSectorRowsByVocabulary(sectorRows);
  if (skippedIndustries.size > 0) {
    console.warn(formatSectorVocabularyWarning(skippedIndustries));
  }

  const sectorsByOfficial = new Map<string, OfficialSector[]>();
  for (const r of renderableSectorRows) {
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
    `    Industry labels: ${renderableSectorRows.length} rows across ${sectorsByOfficial.size} officials ` +
      `(top ${INDUSTRY_TOP_N} by donation dollars)` +
      (skippedIndustries.size > 0
        ? `, ${sectorRows.length - renderableSectorRows.length} row(s) skipped as out-of-vocabulary`
        : ""),
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
  // this DELETE must gain a tag_category scope FIRST. FIX-949 moved it to
  // direct pg but deliberately did NOT narrow it — the unscoped ownership is
  // the protection.
  //
  // FIX-949: clear + upsert are one transaction (withTagRebuild), and the clear
  // is direct-pg on that same client. Same two bugs as tagProposals — a kill
  // mid-upsert used to strand a committed DELETE (FIX-945's shape, ~7.1k rows
  // here), and a failed `.delete()` used to log and then upsert onto an uncleared
  // table. A pg error throws, so the rebuild aborts instead.
  const totalUpserted = await withTagRebuild(async (client) => {
    const cleared = await client.query(
      `DELETE FROM public.entity_tags
        WHERE entity_type = 'official' AND generated_by = 'rule'`,
    );
    console.log(`    Cleared ${cleared.rowCount ?? 0} prior official rule tags`);
    return timed(`official tags upsert (n=${allTags.length})`, () => upsertTags(client, allTags));
  });
  console.log(`    Upserted ${totalUpserted} official tags`);
  return totalUpserted;
}

// ---------------------------------------------------------------------------
// NAICS 2-digit → industry tag (for USASpending contractors)
// More-specific 3/4-digit entries override the 2-digit bucket.
// ---------------------------------------------------------------------------

// FIX-909: five sector-level corrections. These touch only ~78 contractor rows so
// the dollar impact is nil, but each was the same category error the taxonomy
// audit found in entity_tags, written down a second time — left alone they would
// reseed it on every nightly.
const NAICS2_INDUSTRY: Record<string, string> = {
  "11": "agriculture",
  "21": "oil_gas",         // NAICS 21 — Mining, Quarrying, and Oil and Gas Extraction (kept on oil_gas; see decision 4)
  "22": "utilities",       // NAICS 22 — Utilities. WAS oil_gas: sector 22 IS Utilities; this is the mis-bucketing the audit named
  "31": "manufacturing",   // NAICS 31 — Manufacturing (food/textile/apparel). WAS agriculture
  "32": "manufacturing",   // NAICS 32 — Manufacturing (paper/chemical/plastics). WAS pharma
  "33": "manufacturing",   // NAICS 33 — Manufacturing (metal/machinery/electrical/transport equip). WAS defense
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
  // NAICS 56 — Administrative/Support and Waste Management: staffing, security
  // and waste firms, NOT unions. Mapping it to `labor` was a category error and
  // there is no right bucket in this vocabulary, so the entry is REMOVED rather
  // than repointed — naicsToIndustry returns null and the row goes untagged,
  // which is the honest answer.
  "62": "health",          // NAICS 62 — Health Care and Social Assistance (key renamed from pharma)
  "92": "lobby",
};

// 3/4-digit overrides beat the 2-digit bucket. FIX-909 left these alone except
// where the 2-digit rename forced a rewrite, per decision 8 ("only if the change
// is clean — skip if it spiders").
const NAICS_OVERRIDE: Record<string, string> = {
  "334": "tech",
  "335": "tech",
  // "336" — Transportation Equipment Manufacturing. Kept on `defense` rather
  // than moved to `manufacturing`: 336 is where the aerospace/defense primes
  // actually sit (3364 Aerospace Product and Parts), and `defense` is the more
  // specific true answer for this contractor set. Its parent 33 now correctly
  // resolves to `manufacturing`, so autos and the rest of 336 that are NOT
  // defense primes are the open question — deliberately left as a follow-up
  // rather than swept in here, because splitting 3361/3363 (autos) from 3364
  // (aerospace) is a real classification call, not a typo fix.
  "336": "defense",
  // 325/326 — Chemical and Plastics/Rubber Manufacturing. WERE `pharma`, which
  // was only ever right for 3254 (Pharmaceutical and Medicine Manufacturing);
  // bulk chemicals and plastics are manufacturing, and `chemicals` is one of the
  // buckets the audit named as missing. 3254 keeps its true home via the 4-digit
  // entry below, which is checked first.
  "3254": "health",
  "325": "manufacturing",
  "326": "manufacturing",
  "541": "tech",
  "5411": "legal",
  "5412": "finance",
  "5415": "tech",
};

// Exported (FIX-909) for the same reason as INDUSTRY_KEYWORDS — the NAICS emit
// loop drops unresolvable keys just as silently.
export const NAICS_MAPS = { NAICS2_INDUSTRY, NAICS_OVERRIDE } as const;

export function naicsToIndustry(code: string): string | null {
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

// Exported (FIX-916) for the same reason tagOfficials is: the property that
// matters cannot be unit-tested. A SECOND run must reproduce the same industry
// row count rather than zeroing it or doubling it — this function's two
// authoritative clears (rule via RPC, curated via clearCuratedIndustryTags) own
// every industry row on the table, so anything written from outside is wiped on
// the next nightly and anything written twice from inside accumulates.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tagFinancialEntities(db: any): Promise<number> {
  // [2/3] since FIX-959 — the donor-side tag writes must land before the
  // sector-affinity refresh and tagOfficials read them.
  console.log("\n  [2/3] Tagging financial entities...");

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
  //
  // FIX-910: read over a DIRECT pg.Client (rollupJsonbDirect), not the capped
  // PostgREST db.rpc()+callWithRetry path — the last of this function's three
  // reads to be lifted (the keyword fetch went in FIX-444, the two official
  // rollups in FIX-651). The payload is tiny; the COST is planner-dependent.
  // Prod picks a bitmap index scan on financial_relationships_derivation (79ms,
  // measured 2026-07-28); the local prod-clone's stale stats pick a Parallel Seq
  // Scan over 2.77M rows and measured 104s cold — past the 60s PostgREST gateway
  // cap, so callWithRetry burned 5 × 60s and THREW, taking the whole function
  // down before it ever reached clear_financial_entity_rule_tags. That failed
  // CLOSED (the DELETE is downstream of the throw — FIX-443's ordering working as
  // designed), but a dead tagger writes no overrides either. rollupJsonbDirect
  // raises statement_timeout at the SESSION level, so the gateway cap stops
  // applying and the pipeline no longer depends on which plan a given env's
  // stats happen to produce. THROWS on error (no silent partial), preserving the
  // FIX-426/427 contract that the clear+rebuild below runs only on a full read.
  //
  // NOTE (FIX-919): this rollup currently returns [] on BOTH envs — it aggregates
  // fr.from_id WHERE from_type='financial_entity', but all 3,238,246 NAICS-bearing
  // contract rows are agency → financial_entity, so the contractor is to_id. The
  // NAICS pass below has therefore never emitted a tag. Filed, not fixed here:
  // repointing it writes thousands of new industry rows and needs its own
  // before/after. Do not "simplify away" the pass on the strength of its zero
  // output — the code is correct-in-shape and wrong-in-join.
  const naicsRollup = await timed("get_financial_entity_naics (direct-pg)", () =>
    rollupJsonbDirect<{ entity_id: string; naics_code: string | null }>(
      "get_financial_entity_naics",
    ),
  );

  // ── Curated overrides (FIX-916) ──────────────────────────────────────────
  // Fetched BEFORE any clear, alongside the other reads, so a failure here
  // aborts the rebuild rather than wiping tags and then discovering the
  // override table is unreachable (the FIX-443 ordering contract).
  //
  // LEFT JOIN, not INNER: an override row whose fec_committee_id no longer
  // resolves to a financial_entity is surfaced and counted rather than silently
  // vanishing. The migration RAISEs on orphans at seed time (they were zero on
  // both envs at seed), so any orphan seen here is post-seed drift — almost
  // certainly a FIX-544 entity merge that re-pointed or dropped a committee id.
  // Logged loudly but NOT thrown: the right response to a merged committee is to
  // re-point one override row, not to stop tagging ~78k entities every night.
  type OverrideRow = {
    entity_id: string | null;
    fec_committee_id: string;
    industry: string | null;
    audited_sector: string | null;
    source: string;
  };
  const overrideRows = await timed("financial_entity_industry_overrides (direct-pg)", () =>
    selectDirect<OverrideRow>(
      `SELECT fe.id AS entity_id,
              o.fec_committee_id,
              o.industry,
              o.audited_sector,
              o.source
         FROM public.financial_entity_industry_overrides o
         LEFT JOIN public.financial_entities fe
                ON fe.fec_committee_id = o.fec_committee_id
        ORDER BY o.fec_committee_id`,
    ),
  );

  const orphanOverrides = overrideRows.filter((r) => !r.entity_id);
  if (orphanOverrides.length > 0) {
    console.error(
      `    [FIX-916] ${orphanOverrides.length} override(s) reference an fec_committee_id ` +
        `absent from financial_entities — these donors keep their uncurated tags: ` +
        `${orphanOverrides.slice(0, 10).map((r) => r.fec_committee_id).join(", ")}` +
        `${orphanOverrides.length > 10 ? ", …" : ""}`,
    );
  }

  const overrides: IndustryOverride[] = overrideRows
    .filter((r): r is OverrideRow & { entity_id: string } => r.entity_id !== null)
    .map((r) => ({
      entity_id: r.entity_id,
      fec_committee_id: r.fec_committee_id,
      industry: r.industry,
      audited_sector: r.audited_sector,
      source: r.source,
    }));

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
        const info = industryDisplay(industry);
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
    const info = industryDisplay(industry);
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

  // ── Curated overrides — the last word (FIX-916) ──────────────────────────
  // Runs AFTER the keyword pass and the NAICS pass, over their deduped output:
  // every keyword/NAICS industry tag for an overridden donor is dropped, and
  // exactly one curated row replaces it (or none, for the 362 `industry IS NULL`
  // committees that are not industries at all). See the block comment above
  // applyIndustryOverrides for why this cannot live outside this function.
  const withOverrides = applyIndustryOverrides(deduped, overrides);

  const curatedCount = withOverrides.filter((t) => t.generated_by === "curated").length;
  const suppressed = overrides.filter((o) => o.industry === null).length;
  console.log(
    `    Curated overrides: ${overrides.length} resolved ` +
      `(${curatedCount} re-assigned, ${suppressed} de-tagged)`,
  );

  // Authoritative rebuild of the INDUSTRY category only (FIX-443 — 'size' is now
  // cleared+rebuilt server-side by rebuild_financial_entity_size_tags above).
  // Runs only AFTER both the keyword fetch and the NAICS rollup succeeded (each
  // throws on failure), so a partial load can never wipe good tags.
  //
  // FIX-949 / FIX-945: both clears and the upsert now run in ONE transaction on
  // ONE direct-pg connection. This is the site the 2026-07-30 05:30 UTC nightly
  // cancellation actually hit: both DELETEs had committed, the single batched
  // upsert of ~40.5k rows was mid-flight, and the kill left prod with 24,000 of
  // 40,148 `rule` rows and ZERO of 425 `curated` ones — applyIndustryOverrides
  // appends the curated rows to the END of the array, so the tail is exactly
  // what a truncated upsert drops. FIX-443's ordering was working as designed
  // and could not help: it guards against a partial READ, not a killed process.
  //
  // The rule clear still goes through clear_financial_entity_rule_tags rather
  // than an inline DELETE — the function carries `SET statement_timeout = '120s'`
  // and is the tested owner of the category scoping — but it is now invoked as
  // SELECT over this transaction's client instead of over PostgREST, so it
  // shares the transaction (and stops depending on the 8s role cap that made
  // callWithRetry necessary here in the first place).
  const industryUpserted = await withTagRebuild(async (client) => {
    await client.query(`SELECT public.clear_financial_entity_rule_tags($1::text[])`, [
      ["industry"],
    ]);

    // FIX-916: the function above is scoped to generated_by='rule', so the
    // curated rows need their own clear or a changed/removed override would
    // strand a stale tag and break the exactly-one-industry invariant. Same
    // position as the rule clear — after every read, before the upsert.
    const curatedCleared = await clearCuratedIndustryTags(client);
    console.log(`    Cleared ${curatedCleared} prior curated industry tags`);

    return timed(`financial industry tags upsert (n=${withOverrides.length})`, () =>
      upsertTags(client, withOverrides),
    );
  });
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
// FIX-958 — sector-affinity refresh off donor industry-tag changes
// ---------------------------------------------------------------------------

/**
 * CALL refresh_sector_affinity_from_tag_changes() — the content-signature-gated
 * targeted rebuild of official_sector_affinity_rollup. The procedure computes a
 * signature over the (entity_id, tag) industry set, no-ops when it is unchanged
 * (the common night), and rebuilds ONLY the officials who received from a
 * changed donor when it moved. Cold start / signature-store miss falls back to
 * the chunked full backfill. See supabase/migrations/20260801010000.
 *
 * Deliberately NON-fatal (FIX-959): a stale rollup is the pre-existing
 * condition this whole mechanism replaces, and a dead nightly is strictly worse
 * (the FIX-920 lesson). On failure tagOfficials still runs against the prior
 * rollup state, the signature store is not advanced, and the canary's
 * check_sector_affinity_tag_staleness() escalates if the strand persists past
 * one nightly cycle.
 */
async function refreshSectorAffinityFromTagChanges(): Promise<void> {
  try {
    await callHeavyProcedure("refresh_sector_affinity_from_tag_changes");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `    [FIX-958] sector-affinity refresh FAILED — official_sector_affinity_rollup ` +
        `may be stale; the FIX-959 canary staleness check escalates if this persists: ${msg}`,
    );
  }
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
    const proposalTags     = await timed("phase: tagProposals", () => tagProposals(db));
    // FIX-959 — financial entities BEFORE officials. tagOfficials() reads
    // official_sector_affinity_rollup to write the FIX-897 industry pills, and
    // that rollup is rebuilt (targeted, signature-gated — FIX-958) from
    // TONIGHT's donor industry-tag changes by the refresh between the two
    // phases. The old order (officials → financialEntities) meant the pills
    // were derived before that night's donor tag changes even existed, so even
    // a perfect change-trigger left them lagging a full night.
    const financialTags    = await timed("phase: tagFinancialEntities", () => tagFinancialEntities(db));
    await timed("phase: sector-affinity refresh (FIX-958)", () => refreshSectorAffinityFromTagChanges());
    const officialTags     = await timed("phase: tagOfficials", () => tagOfficials(db));
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
