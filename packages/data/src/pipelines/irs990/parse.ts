/**
 * FIX-250 — Form 990 XML parser.
 *
 * The IRS publishes a new schema version every tax year (2014v1.0 through
 * 2024v5.x at time of writing). Element names mostly stay stable, but they
 * move between sections, the namespace prefix sometimes changes, and a few
 * fields were renamed pre-2015 vs post-2015. Rather than maintain a per-year
 * XPath table, we use a tag-name-only traversal that finds nodes by their
 * unqualified local name regardless of where they live in the document. This
 * is robust to namespace prefix changes (`irs:`, `efile:`, none) and to the
 * 2014→2015 element renames documented in the Nonprofit Open Data Collective
 * Master Concordance.
 *
 * Fields we extract:
 *   - Filing meta: SubsectionCd, NTEE NTEECd, business state
 *   - Financials: TotalRevenue / TotalAssetsEOY / TotalExpenses
 *   - Officers (Part VII Section A): Form990PartVIISectionAGrp, or older
 *     OfficerDirectorTrusteeOrKeyEmployeeGrp
 *   - Grants out (Schedule I, Part II): RecipientTable (post-2014) or
 *     GrantsToOrgsIndivInUS (pre-2014). One row per recipient org or person.
 *
 * Notably absent: anything that looks like a donor. Schedule B is redacted
 * from the public e-file distribution; we never see it.
 */

import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface ParsedFiling {
  organizationName:    string;
  ein:                 string | null;        // sometimes present in body, otherwise fall back to index
  taxYear:             number | null;
  filingType:          string;                // 'Form990', 'Form990EZ', etc.
  subsectionCode:      number | null;         // 3, 4, 5, 6, ...
  nteeCode:            string | null;
  totalRevenueCents:   number | null;
  totalAssetsEoyCents: number | null;
  totalExpensesCents:  number | null;
  addressState:        string | null;         // 2-letter
  schemaVersion:       string | null;         // e.g. '2024v5.0' — straight from Return @returnVersion
}

export interface ParsedOfficer {
  personName:        string;
  roleTitle:         string;
  compensationCents: number | null;
  hoursPerWeek:      number | null;
}

export interface ParsedGrantOut {
  recipientName:          string;
  recipientEin:           string | null;
  amountCents:            number;
  purpose:                string | null;
}

export interface ParsedReturn {
  filing:    ParsedFiling;
  officers:  ParsedOfficer[];
  grantsOut: ParsedGrantOut[];
}

// ---------------------------------------------------------------------------
// Tag-name-only traversal
// ---------------------------------------------------------------------------

// fast-xml-parser strips namespace prefixes when removeNSPrefix is set, so a
// tag like `irs:Form990PartVIISectionAGrp` becomes `Form990PartVIISectionAGrp`.
// We don't need the prefix for our purposes — only the local name.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlNode = any;

/** Depth-first search for the first node whose local-name === `tagName`. */
function findFirst(node: XmlNode, tagName: string): XmlNode | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findFirst(item, tagName);
      if (r !== null) return r;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    if (key === tagName) return node[key];
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith("@_")) continue;
    const r = findFirst(node[key], tagName);
    if (r !== null) return r;
  }
  return null;
}

/** Depth-first search for ALL nodes whose local-name === `tagName`. */
function findAll(node: XmlNode, tagName: string, acc: XmlNode[] = []): XmlNode[] {
  if (node === null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, tagName, acc);
    return acc;
  }
  for (const key of Object.keys(node)) {
    if (key === tagName) {
      const v = node[key];
      if (Array.isArray(v)) acc.push(...v);
      else acc.push(v);
    }
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith("@_") || key === tagName) continue;
    findAll(node[key], tagName, acc);
  }
  return acc;
}

function textOf(node: XmlNode): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && "#text" in node) {
    const t = node["#text"];
    return typeof t === "string" ? t.trim() || null : t != null ? String(t) : null;
  }
  return null;
}

function intOf(node: XmlNode): number | null {
  const t = textOf(node);
  if (t === null) return null;
  const n = parseInt(t.replace(/[, ]+/g, ""), 10);
  return isNaN(n) ? null : n;
}

function numberOf(node: XmlNode): number | null {
  const t = textOf(node);
  if (t === null) return null;
  const n = parseFloat(t.replace(/[, ]+/g, ""));
  return isNaN(n) ? null : n;
}

/** USD as a string of dollars → integer cents. */
function dollarsToCents(node: XmlNode): number | null {
  const n = numberOf(node);
  return n === null ? null : Math.round(n * 100);
}

// ---------------------------------------------------------------------------
// Field locators
// ---------------------------------------------------------------------------

function readSubsectionCode(root: XmlNode): number | null {
  // SubsectionCd lives in IRS990/IRS990ScheduleA depending on tax year.
  const node = findFirst(root, "SubsectionCd") ?? findFirst(root, "Organization501cTypeTxt");
  const t = textOf(node);
  if (!t) return null;
  const n = parseInt(t, 10);
  return isNaN(n) ? null : n;
}

function readNteeCode(root: XmlNode): string | null {
  const node = findFirst(root, "NTEECd") ?? findFirst(root, "ActivityOrMissionDesc");
  // Only return if it looks like a real NTEE code (letter + 2 digits).
  const t = textOf(node);
  if (!t || !/^[A-Z]\d{2}$/i.test(t)) return null;
  return t.toUpperCase();
}

function readState(root: XmlNode): string | null {
  // Filer-scoped to avoid picking up the preparer firm's state.
  const filer = findFirst(root, "Filer") ?? root;
  const node = findFirst(filer, "StateAbbreviationCd") ?? findFirst(filer, "State");
  const t = textOf(node);
  if (!t) return null;
  return t.length === 2 ? t.toUpperCase() : null;
}

function readOrgName(root: XmlNode): string {
  // The `Filer` element wraps the filing org's identifying fields. BOTH the
  // filing org and the paid preparer's firm use `BusinessNameLine1Txt`, so an
  // unscoped findFirst can land on the preparer (KPMG, RSM US, etc.) — bug
  // surfaced during initial smoke test. Scope to Filer first.
  const filer = findFirst(root, "Filer") ?? root;
  const name1 = textOf(findFirst(filer, "BusinessNameLine1Txt"))
             ?? textOf(findFirst(filer, "BusinessNameLine1"))
             ?? textOf(findFirst(filer, "Name"))
             ?? "";
  const name2 = textOf(findFirst(filer, "BusinessNameLine2Txt")) ?? "";
  return [name1, name2].filter(Boolean).join(" ").trim() || "(unknown)";
}

function readEin(root: XmlNode): string | null {
  // Scope to Filer for the same reason — preparer firm has its own
  // `PreparerFirmEIN` and other groups carry EINs too.
  const filer = findFirst(root, "Filer") ?? root;
  const t = textOf(findFirst(filer, "EIN"));
  if (!t) return null;
  const digits = t.replace(/\D+/g, "");
  return digits.length === 9 ? digits : null;
}

function readReturnTaxYear(root: XmlNode): number | null {
  const t = textOf(findFirst(root, "TaxYr")) ?? textOf(findFirst(root, "TaxYear"));
  if (!t) return null;
  const n = parseInt(t, 10);
  return isNaN(n) ? null : n;
}

function readFilingType(root: XmlNode): string {
  // The Return element has a ReturnTypeCd child: 990, 990EZ, 990PF, 990T.
  const t = textOf(findFirst(root, "ReturnTypeCd")) ?? textOf(findFirst(root, "ReturnType"));
  return t ?? "990";
}

function readSchemaVersion(root: XmlNode): string | null {
  // The root <Return> element carries a @returnVersion attribute.
  const ret = findFirst(root, "Return");
  if (ret && typeof ret === "object" && "@_returnVersion" in ret) {
    const v = (ret as Record<string, unknown>)["@_returnVersion"];
    return typeof v === "string" ? v : null;
  }
  // Or sometimes attached to the root directly.
  if (root && typeof root === "object" && "@_returnVersion" in root) {
    const v = (root as Record<string, unknown>)["@_returnVersion"];
    return typeof v === "string" ? v : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Officers (Part VII Section A)
// ---------------------------------------------------------------------------

function readOfficers(root: XmlNode): ParsedOfficer[] {
  // 2015+ schema: Form990PartVIISectionAGrp (one per officer)
  // Pre-2015:    OfficerDirectorTrusteeOrKeyEmployeeGrp (similar shape)
  const groups: XmlNode[] = [
    ...findAll(root, "Form990PartVIISectionAGrp"),
    ...findAll(root, "OfficerDirectorTrusteeOrKeyEmployeeGrp"),
    ...findAll(root, "Form990PartVIISectionA"),  // even-older flat variant
  ];

  const out: ParsedOfficer[] = [];
  for (const g of groups) {
    // Person name: PersonNm (preferred) or BusinessName fallback for non-person filers.
    const name = textOf(findFirst(g, "PersonNm"))
              ?? textOf(findFirst(g, "PersonName"))
              ?? textOf(findFirst(g, "BusinessNameLine1Txt"))
              ?? "";
    if (!name) continue;

    const titleTxt = textOf(findFirst(g, "TitleTxt")) ?? textOf(findFirst(g, "Title")) ?? "Director";
    const compNode = findFirst(g, "ReportableCompFromOrgAmt")
                  ?? findFirst(g, "CompensationAmt")
                  ?? findFirst(g, "ReportableCompFromOrganization");
    const hrsNode  = findFirst(g, "AverageHoursPerWeekRt")
                  ?? findFirst(g, "AverageHoursPerWeek");

    out.push({
      personName:        name.trim(),
      roleTitle:         titleTxt.trim().slice(0, 100),
      compensationCents: dollarsToCents(compNode),
      hoursPerWeek:      numberOf(hrsNode),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grants out (Schedule I, Part II)
// ---------------------------------------------------------------------------

function readGrantsOut(root: XmlNode): ParsedGrantOut[] {
  // 2015+: IRS990ScheduleI → RecipientTable (one per grantee)
  // Pre-2015: GrantsToOrgsIndivInUS or GrantTbl
  const groups: XmlNode[] = [
    ...findAll(root, "RecipientTable"),
    ...findAll(root, "GrantsToOrgsIndivInUS"),
    ...findAll(root, "GrantTbl"),
  ];

  const out: ParsedGrantOut[] = [];
  for (const g of groups) {
    const recipName = textOf(findFirst(g, "RecipientBusinessName"))
                   ?? textOf(findFirst(g, "BusinessNameLine1Txt"))
                   ?? textOf(findFirst(g, "RecipientPersonNm"))
                   ?? textOf(findFirst(g, "RecipientNameBusiness"))
                   ?? "";
    if (!recipName) continue;

    const recipEinRaw = textOf(findFirst(g, "RecipientEIN")) ?? textOf(findFirst(g, "EINOfRecipient"));
    const recipEin = recipEinRaw ? recipEinRaw.replace(/\D+/g, "") : null;

    const amtNode = findFirst(g, "CashGrantAmt")
                 ?? findFirst(g, "AmountOfCashGrant")
                 ?? findFirst(g, "Amount");
    const cents = dollarsToCents(amtNode);
    if (cents === null || cents <= 0) continue;

    const purpose = textOf(findFirst(g, "PurposeOfGrantTxt"))
                 ?? textOf(findFirst(g, "PurposeOfGrant"))
                 ?? null;

    out.push({
      recipientName:  recipName.trim(),
      recipientEin:   recipEin && recipEin.length === 9 ? recipEin : null,
      amountCents:    cents,
      purpose:        purpose ? purpose.slice(0, 500) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function parse990Xml(xml: string): ParsedReturn {
  const root = parser.parse(xml);

  // Financials: the names changed several times across schema versions, so
  // try each plausible field in order and take the first non-null.
  const totalRevenue =
       findFirst(root, "TotalRevenueColumnAmt")
    ?? findFirst(root, "CYTotalRevenueAmt")
    ?? findFirst(root, "TotalRevenue");
  const totalAssetsEoy =
       findFirst(root, "TotalAssetsEOYAmt")
    ?? findFirst(root, "TotalAssetsEOY")
    ?? findFirst(root, "TotalAssetsBOYAmt");  // budget shouldn't fall back to BOY, but it's a non-zero data point if EOY is missing
  const totalExpenses =
       findFirst(root, "TotalFunctionalExpensesAmt")
    ?? findFirst(root, "CYTotalExpensesAmt")
    ?? findFirst(root, "TotalExpensesCurrentYearAmt")
    ?? findFirst(root, "TotalExpenses");

  const filing: ParsedFiling = {
    organizationName:    readOrgName(root),
    ein:                 readEin(root),
    taxYear:             readReturnTaxYear(root),
    filingType:          readFilingType(root),
    subsectionCode:      readSubsectionCode(root),
    nteeCode:            readNteeCode(root),
    totalRevenueCents:   dollarsToCents(totalRevenue),
    totalAssetsEoyCents: dollarsToCents(totalAssetsEoy),
    totalExpensesCents:  dollarsToCents(totalExpenses),
    addressState:        readState(root),
    schemaVersion:       readSchemaVersion(root),
  };

  return {
    filing,
    officers:  readOfficers(root),
    grantsOut: readGrantsOut(root),
  };
}

// Exported for unit-test-like spot checks from index.ts.
export const _testHelpers = { findFirst, findAll, dollarsToCents };
