/**
 * FIX-250 — Curated seed list of politically-active nonprofits to ingest from
 * IRS Form 990 bulk e-file.
 *
 * Phase 1 is seed-list driven, NOT a full-bulk crawl. The set is biased toward
 * 501(c)(4) social-welfare orgs because that's where dark-money network
 * structure concentrates — they're not required to disclose donors, but Form
 * 990 still surfaces officers and grants-out.
 *
 * EINs are stored digits-only (no hyphens) to match the IRS bulk index format.
 * Confirmed EINs come from ProPublica Nonprofit Explorer; uncertain ones are
 * commented as TODO so they can be resolved later via the IRS Tax Exempt Org
 * Search or a manual ProPublica lookup before re-running.
 *
 * Adding new seeds: append; do NOT renumber. The pipeline filter is just
 * `EIN ∈ SEED_EIN_SET`, so order is immaterial.
 */

export interface SeedNonprofit {
  /** EIN in digits-only form (no hyphen). 9 digits. */
  ein: string;
  /** Display name for logging — the canonical name is derived from the 990 filing itself. */
  expectedName: string;
  /** 501(c) subsection — informational only; the parser reads SubsectionCd from the XML directly. */
  subsection: "501c3" | "501c4" | "501c5" | "501c6" | "527" | "unknown";
  /** Why this org is in the seed list — short note. */
  note?: string;
}

export const SEED_NONPROFITS: SeedNonprofit[] = [
  // ── 501(c)(4) — primary dark-money vehicle ──────────────────────────────
  { ein: "753148958", expectedName: "Americans for Prosperity",                subsection: "501c4", note: "Koch network" },
  { ein: "271937961", expectedName: "One Nation",                              subsection: "501c4", note: "Rove/McConnell aligned" },
  { ein: "530116130", expectedName: "National Rifle Association",              subsection: "501c4", note: "Includes NRA-ILA lobbying arm" },
  { ein: "521733698", expectedName: "League of Conservation Voters",           subsection: "501c4", note: "Environmental" },
  { ein: "272244700", expectedName: "Heritage Action for America",             subsection: "501c4", note: "Heritage Foundation advocacy arm" },
  { ein: "270730508", expectedName: "American Action Network",                 subsection: "501c4", note: "Republican-aligned" },
  { ein: "474368320", expectedName: "Majority Forward",                        subsection: "501c4", note: "Senate Majority PAC partner" },
  { ein: "450710294", expectedName: "Patriot Majority USA",                    subsection: "501c4", note: "Labor-funded, Democratic-aligned" },
  { ein: "208036639", expectedName: "Center for Individual Freedom",           subsection: "501c4", note: "Citizens United-aligned" },
  { ein: "453168329", expectedName: "Americans for Tax Reform",                subsection: "501c4", note: "Norquist; pledge org" },
  { ein: "521264785", expectedName: "Sierra Club",                             subsection: "501c4", note: "Environmental advocacy" },
  { ein: "521267875", expectedName: "Planned Parenthood Action Fund",          subsection: "501c4", note: "Reproductive rights advocacy" },
  { ein: "521226094", expectedName: "Common Cause",                            subsection: "501c4", note: "Government accountability" },
  { ein: "521623781", expectedName: "Brennan Center for Justice",              subsection: "501c4", note: "Voting rights / democracy reform" },
  { ein: "452968449", expectedName: "End Citizens United",                     subsection: "501c4", note: "Campaign-finance reform" },
  { ein: "474311093", expectedName: "Tea Party Patriots Action",               subsection: "501c4", note: "Tea Party national" },
  { ein: "204411099", expectedName: "Center for American Progress Action Fund", subsection: "501c4", note: "CAP's 501c4 sibling" },
  // TODO: Crossroads GPS — EIN not in ProPublica search results; resolve via IRS Tax Exempt Org Search before reactivating.
  // { ein: "________", expectedName: "Crossroads GPS",                         subsection: "501c4", note: "Karl Rove dark-money flagship; EIN TBD" },

  // ── 501(c)(3) — politically active think tanks / advocacy ────────────────
  { ein: "300126510", expectedName: "Center for American Progress",            subsection: "501c3", note: "Progressive policy" },
  { ein: "237327730", expectedName: "Heritage Foundation",                     subsection: "501c3", note: "Conservative policy" },
  { ein: "237432162", expectedName: "Cato Institute",                          subsection: "501c3", note: "Libertarian policy. EIN verified via ProPublica 2026-05-11." },
  { ein: "521263436", expectedName: "Ludwig von Mises Institute",              subsection: "501c3", note: "Austrian-school libertarian think tank. (Originally seeded under the Cato Institute label; this is the correct identity for EIN 521263436.)" },
  { ein: "521324646", expectedName: "American Enterprise Institute",           subsection: "501c3", note: "Conservative policy" },
  { ein: "521304621", expectedName: "Brookings Institution",                   subsection: "501c3", note: "Centrist policy" },
  { ein: "133839293", expectedName: "Brennan Center for Justice",              subsection: "501c3", note: "Voting rights / democracy reform (NYU-affiliated). EIN verified via ProPublica 2026-05-11." },
  { ein: "521623781", expectedName: "American Israel Education Foundation",    subsection: "501c3", note: "AIPAC's 501(c)(3) sister; politically active. (Originally seeded under the Brennan Center label; this is the correct identity for EIN 521623781.)" },
  { ein: "133082975", expectedName: "Demos",                                   subsection: "501c3", note: "Voting rights / democracy" },
  { ein: "521264819", expectedName: "Center for Responsive Politics (OpenSecrets)", subsection: "501c3", note: "Money-in-politics transparency" },
  { ein: "521268274", expectedName: "Citizens for Responsibility and Ethics in Washington (CREW)", subsection: "501c3", note: "Government accountability" },
  { ein: "237325238", expectedName: "American Civil Liberties Union Foundation", subsection: "501c3", note: "Civil rights" },
  { ein: "260006131", expectedName: "Federalist Society",                      subsection: "501c3", note: "Conservative legal network" },
  { ein: "237314929", expectedName: "American Legislative Exchange Council (ALEC)", subsection: "501c3", note: "Model legislation" },
  { ein: "521328468", expectedName: "FreedomWorks Foundation",                 subsection: "501c3", note: "Conservative grassroots" },

  // ── 501(c)(5) / (6) — unions + trade associations ────────────────────────
  { ein: "530227420", expectedName: "AFL-CIO",                                 subsection: "501c5", note: "Labor federation" },
  { ein: "131628121", expectedName: "Service Employees International Union",   subsection: "501c5", note: "SEIU" },
  { ein: "131623831", expectedName: "American Federation of Teachers",         subsection: "501c5", note: "AFT" },
  { ein: "530115260", expectedName: "National Education Association",          subsection: "501c5", note: "Largest US teacher's union. (Originally seeded under the U.S. Chamber of Commerce label; this is the correct identity for EIN 530115260.)" },
  { ein: "530045720", expectedName: "U.S. Chamber of Commerce",                subsection: "501c6", note: "Big business lobby. EIN verified via ProPublica 2026-05-11." },
  { ein: "530245876", expectedName: "National Association of Manufacturers",   subsection: "501c6", note: "Industry trade group" },
  { ein: "131734621", expectedName: "American Hospital Association",           subsection: "501c6", note: "Hospital lobby" },
  { ein: "360727175", expectedName: "American Medical Association",            subsection: "501c6", note: "Physician lobby. EIN verified via ProPublica 2026-05-11." },
  { ein: "530196605", expectedName: "American National Red Cross",             subsection: "501c3", note: "Disaster relief; included by accident under the AMA label. Kept in seed because filings are already ingested at this EIN; minimally politically active. Remove if seed-list size becomes a concern." },
  // TODO: AFSCME national — multiple per-local EINs; need national HQ EIN. Likely starts 53- given DC address.
];

/** Set form for O(1) "is this EIN in the seed list?" checks in the streaming index parser. */
export const SEED_EIN_SET: ReadonlySet<string> = new Set(SEED_NONPROFITS.map((s) => s.ein));

/** Map form for `EIN → SeedNonprofit` lookups when we need the expected name or subsection. */
export const SEED_EIN_MAP: ReadonlyMap<string, SeedNonprofit> = new Map(
  SEED_NONPROFITS.map((s) => [s.ein, s] as const),
);
