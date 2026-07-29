/**
 * FIX-930 — read-only enumeration of orphaned FEC attribution.
 *
 * WHY THIS EXISTS
 * ---------------
 * matchRow()'s weball name fallback binds a FEC CAND_ID to an official in
 * memory. When that binding later CHANGES — because the cn{yy} stage minted a
 * candidate-tier row, or the last-name pool composition shifted — the writer
 * upserts on financial_relationships_relcycle_unique
 * (relationship_type, from_id, to_id, cycle_year). A changed `to_id` produces a
 * NEW row and never retires the old one, so every historical mis-binding is
 * still resident in the table. FIX-929 stops new ones being made; this script
 * sizes the residue so the cleanup (PR 2) can be planned against real numbers
 * instead of a heuristic.
 *
 * THE SIGNAL
 * ----------
 * An official holding relationship_type='donation' rows whose
 * metadata->>'source' starts with 'fec_bulk', but whose source_ids carries
 * NEITHER fec_candidate_id NOR a role-prefix-matching fec_id (Senator->S,
 * Representative->H — mirroring buildMatchIndex's prefix rule). That is an
 * official the current match index would never select, yet who holds FEC money.
 *
 * TWIN SCOPE
 * ----------
 * Candidate twins are scoped to the same normalised SURNAME. That is not a
 * convenience cut: the mis-binding mechanism is byLastName-pool-driven, so a
 * wrong binding is ALWAYS same-surname. A cross-surname collision cannot be
 * produced by this code path.
 *
 * THREE BRANCHES — they need OPPOSITE remediations, so they are never collapsed
 * ---------------------------------------------------------------------------
 *   SAME-PERSON DUPLICATE     twin's first name agrees. One human, two rows
 *                             (elected + candidate), both holding the money.
 *   CROSS-PERSON MISATTRIB.   twin's first name disagrees. Another person's
 *                             donors are rendered under this official's name.
 *                             The severe branch.
 *   UNIQUE HOLDER             no meaningful overlap. Most likely a CORRECT
 *                             binding whose persistNewFecIds step never ran
 *                             (the fec phase gets SIGTERM'd at its GHA budget).
 *                             Remediation is to WRITE the missing id, NOT to
 *                             remove rows. Do not treat this branch as garbage.
 *
 * READ-ONLY. No UPDATE, no DELETE, no upsert. Runs inside a READ ONLY
 * transaction so a stray write would error rather than land.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:audit:fec-attribution
 *   # against prod (read-only, still confirm with the user first):
 *   pnpm --filter @civitics/data exec tsx --env-file=<abs>/.env.local.prod \
 *     <abs>/src/scripts/audit-fec-orphan-attribution.ts
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function constructDbUrlFromEnv(): string {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) return "";
  if (/127\.0\.0\.1:54321|localhost:54321/.test(supabaseUrl)) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "";
  const password = process.env["SUPABASE_DB_PASSWORD"];
  if (!password) return "";
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function envLabel(): "local" | "prod" {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  return /127\.0\.0\.1|localhost/.test(url) ? "local" : "prod";
}

// ---------------------------------------------------------------------------
// The enumeration query
//
// Built as one statement so the (from_id, cycle_year) overlap join runs
// server-side against financial_relationships_donor_rollup_idx rather than
// shipping ~250k donation keys per suspect over the wire.
// ---------------------------------------------------------------------------

const SUSPECT_SQL = `
WITH suspect AS (
  SELECT o.id
  FROM officials o
  WHERE EXISTS (
          SELECT 1 FROM financial_relationships fr
          WHERE fr.to_type = 'official'
            AND fr.relationship_type = 'donation'
            AND fr.to_id = o.id
            AND fr.metadata->>'source' LIKE 'fec_bulk%')
    AND o.source_ids->>'fec_candidate_id' IS NULL
    AND NOT (
      o.source_ids->>'fec_id' IS NOT NULL AND (
        (o.role_title = 'Senator'        AND upper(left(o.source_ids->>'fec_id', 1)) = 'S') OR
        (o.role_title = 'Representative' AND upper(left(o.source_ids->>'fec_id', 1)) = 'H')
      ))
),
-- normalised surname + "does this official carry any FEC id at all"
lk AS (
  SELECT o.id,
         regexp_replace(upper(COALESCE(NULLIF(o.last_name, ''), o.full_name)), '[^A-Z]', '', 'g') AS lastkey,
         (o.source_ids ? 'fec_candidate_id' OR o.source_ids ? 'fec_id') AS has_fec
  FROM officials o
),
pair AS (
  SELECT s.id AS suspect_id, t.id AS twin_id
  FROM suspect s
  JOIN lk sl ON sl.id = s.id
  JOIN lk t  ON t.lastkey = sl.lastkey AND t.has_fec AND t.id <> s.id
  WHERE sl.lastkey <> ''
),
-- donation keys for every official involved on either side of a pair
d AS (
  SELECT fr.to_id, fr.from_id, fr.cycle_year
  FROM financial_relationships fr
  WHERE fr.to_type = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.to_id IN (SELECT suspect_id FROM pair UNION SELECT twin_id FROM pair)
),
ov AS (
  SELECT p.suspect_id, p.twin_id, count(*)::bigint AS shared
  FROM pair p
  JOIN d a ON a.to_id = p.suspect_id
  JOIN d b ON b.to_id = p.twin_id
          AND b.from_id = a.from_id
          AND b.cycle_year IS NOT DISTINCT FROM a.cycle_year
  GROUP BY 1, 2
),
best AS (
  SELECT DISTINCT ON (suspect_id) suspect_id, twin_id, shared
  FROM ov ORDER BY suspect_id, shared DESC, twin_id
),
-- suspect-side facts, straight off the donation rows
facts AS (
  SELECT fr.to_id AS official_id,
         count(*)::bigint          AS donation_rows,
         sum(fr.amount_cents)::bigint AS fec_cents,
         min(fr.occurred_at)       AS first_at,
         max(fr.occurred_at)       AS last_at
  FROM financial_relationships fr
  WHERE fr.to_type = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.to_id IN (SELECT id FROM suspect)
  GROUP BY 1
)
SELECT
  o.id                                        AS official_id,
  o.full_name,
  o.first_name,
  o.last_name,
  o.tier,
  o.is_active,
  o.role_title,
  j.short_name                                AS jurisdiction,
  o.source_ids->>'fec_id'                     AS stored_fec_id,
  COALESCE(odt.total_cents, 0)::bigint        AS totals_table_cents,
  COALESCE(f.fec_cents, 0)::bigint            AS donation_cents,
  COALESCE(f.donation_rows, 0)::bigint        AS donation_rows,
  f.first_at,
  f.last_at,
  b.twin_id,
  tw.full_name                                AS twin_name,
  tw.first_name                               AS twin_first_name,
  tw.tier                                     AS twin_tier,
  COALESCE(tw.source_ids->>'fec_candidate_id', tw.source_ids->>'fec_id') AS twin_fec_id,
  COALESCE(twodt.total_cents, 0)::bigint      AS twin_total_cents,
  COALESCE(b.shared, 0)::bigint               AS shared_pairs
FROM suspect s
JOIN officials o                     ON o.id = s.id
LEFT JOIN jurisdictions j            ON j.id = o.jurisdiction_id
LEFT JOIN official_donor_totals odt  ON odt.official_id = o.id
LEFT JOIN facts f                    ON f.official_id = o.id
LEFT JOIN best b                     ON b.suspect_id = o.id
LEFT JOIN officials tw               ON tw.id = b.twin_id
LEFT JOIN official_donor_totals twodt ON twodt.official_id = b.twin_id
ORDER BY COALESCE(f.fec_cents, 0) DESC;
`;

const PLATFORM_SQL = `
SELECT
  count(DISTINCT to_id)::bigint AS officials,
  sum(amount_cents)::bigint     AS cents
FROM financial_relationships
WHERE to_type = 'official' AND relationship_type = 'donation';
`;

interface SuspectRow {
  official_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  tier: string | null;
  is_active: boolean;
  role_title: string | null;
  jurisdiction: string | null;
  stored_fec_id: string | null;
  totals_table_cents: string;
  donation_cents: string;
  donation_rows: string;
  first_at: Date | null;
  last_at: Date | null;
  twin_id: string | null;
  twin_name: string | null;
  twin_first_name: string | null;
  twin_tier: string | null;
  twin_fec_id: string | null;
  twin_total_cents: string;
  shared_pairs: string;
}

type Branch = "SAME-PERSON DUPLICATE" | "CROSS-PERSON MISATTRIBUTION" | "UNIQUE HOLDER";

// ---------------------------------------------------------------------------
// Name agreement — same 3-letter key the FIX-929 gate uses, so the branch
// boundary and the matcher agree on what "same person" means.
// ---------------------------------------------------------------------------

function firstNameKey(raw: string | null | undefined): string {
  const norm = (raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return norm.length >= 3 ? norm.slice(0, 3) : "";
}

function officialFirstKey(first: string | null, full: string | null): string {
  return firstNameKey(first) || firstNameKey((full ?? "").split(/\s+/)[0]);
}

// ---------------------------------------------------------------------------
// Branch boundary — DERIVED from the data, not hardcoded.
//
// The raw shared-pair count is the wrong instrument: 90 shared pairs out of an
// official's 100 rows is damning, 90 out of 45,000 is noise. Measured on this
// data the raw counts are NOT bimodal — they spread near-continuously from 0 to
// the maximum. So the boundary is drawn on the OVERLAP FRACTION (shared / the
// suspect's own donation rows), which normalises for size and IS bimodal.
//
// The cut is the midpoint of the widest empty band in the observed fraction
// distribution, searched within [BAND_LO, BAND_HI] — outside that range a "gap"
// is just the distribution's own sparse tail, not a boundary.
//
// A second, absolute floor guards ONE specific corner the fraction cannot see:
// an official with 2 donation rows that both happen to land on a same-surname
// twin scores frac=1.0 by coincidence (one PAC giving to two same-surname
// officials in a cycle is entirely ordinary). The floor is derived from the low
// tail of the shared-count distribution AMONG SUSPECTS THAT ALREADY PASS THE
// FRACTION CUT — that is the only population it operates on, so it is the only
// population it should be measured against. Deriving it from the below-cut
// population instead gives a wildly inflated floor: high-volume officials sit
// below the cut while still sharing hundreds of pairs in absolute terms.
// ---------------------------------------------------------------------------

const BAND_LO = 0.02;
const BAND_HI = 0.60;
/** Above this many shared pairs, coincidence stops being a plausible story. */
const FLOOR_SEARCH_HI = 50;

interface Boundary {
  fracCut: number;
  gapLo: number;
  gapHi: number;
  gapWidth: number;
  sharedFloor: number;
  floorGapLo: number;
  floorGapHi: number;
  bimodal: boolean;
}

/** Midpoint + edges of the widest empty band in `values` within [lo, hi]. */
function widestGap(values: number[], lo: number, hi: number): { gapLo: number; gapHi: number; width: number } {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  let gapLo = lo;
  let gapHi = hi;
  let width = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b < lo || a > hi) continue;
    if (b - a > width) {
      width = b - a;
      gapLo = a;
      gapHi = b;
    }
  }
  return { gapLo, gapHi, width };
}

function deriveBoundary(rows: Array<{ frac: number; shared: number }>): Boundary {
  const fg = widestGap(rows.map((r) => r.frac), BAND_LO, BAND_HI);
  const fracCut = fg.width > 0 ? (fg.gapLo + fg.gapHi) / 2 : BAND_HI;

  // Floor: low tail of the shared counts among suspects that clear the cut.
  const above = rows.filter((r) => r.frac >= fracCut).map((r) => r.shared);
  const sg = widestGap(above, 1, FLOOR_SEARCH_HI);
  const sharedFloor = sg.width > 0 ? sg.gapHi : 1;

  const nBelow = rows.filter((r) => r.frac < fracCut).length;
  const bimodal = fg.width >= 0.05 && nBelow > 0 && above.length > 0;

  return {
    fracCut,
    gapLo: fg.gapLo,
    gapHi: fg.gapHi,
    gapWidth: fg.width,
    sharedFloor,
    floorGapLo: sg.gapLo,
    floorGapHi: sg.gapHi,
    bimodal,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const usd = (cents: number | bigint): string =>
  `$${(Number(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const iso = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");

function tsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\r\n]/g, " ")).join("\t")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("Could not construct a DB URL — check NEXT_PUBLIC_SUPABASE_URL / SUPABASE_DB_PASSWORD.");
    process.exit(1);
  }
  const env = envLabel();
  console.log(`[audit] FEC orphan attribution — ${env}\n`);

  const client = new Client({ connectionString: dbUrl, statement_timeout: 600_000 });
  await client.connect();

  let suspects: SuspectRow[];
  let platform: { officials: string; cents: string };
  try {
    // Read-only transaction: a stray write errors instead of landing.
    await client.query("BEGIN TRANSACTION READ ONLY");
    const [sRes, pRes] = [
      await client.query<SuspectRow>(SUSPECT_SQL),
      await client.query<{ officials: string; cents: string }>(PLATFORM_SQL),
    ];
    suspects = sRes.rows;
    platform = pRes.rows[0];
    await client.query("COMMIT");
  } finally {
    await client.end();
  }

  // ── classify ──────────────────────────────────────────────────────────────
  const enriched = suspects.map((r) => {
    const rows = Number(r.donation_rows);
    const shared = Number(r.shared_pairs);
    const frac = rows > 0 ? shared / rows : 0;
    return { ...r, rows, shared, frac };
  });

  const boundary = deriveBoundary(enriched.map((e) => ({ frac: e.frac, shared: e.shared })));

  // A FEC CAND_ID encodes the seat: office in char 0 (H/S/P), a cycle digit in
  // char 1, then the two-letter state in chars 2-3. `H8TN07076` is a Tennessee
  // House seat, `S8GA00180` a Georgia Senate seat. Both halves are compared —
  // chamber alone is far too coarse, since most suspects are Representatives
  // and would therefore agree on chamber by default.
  const fecOffice = (id: string | null): string => (id ?? "")[0]?.toUpperCase() ?? "";
  const fecState = (id: string | null): string => (id ?? "").slice(2, 4).toUpperCase();

  /** Does the twin's FEC id describe the seat this suspect actually holds? */
  function seatAgrees(e: (typeof enriched)[number]): boolean {
    const office = fecOffice(e.twin_fec_id);
    if (!office) return false;
    const role = e.role_title ?? "";
    const officeOk =
      (office === "S" && (role === "Senator" || role === "Candidate for Senator")) ||
      (office === "H" && (role === "Representative" || role === "Candidate for Representative")) ||
      (office === "P" && (role === "President" || role === "Candidate for President"));
    // Anything else (Council Member, Mayor, agency titles…) holds no federal
    // seat at all, so a federal CAND_ID can never legitimately be theirs.
    if (!officeOk) return false;
    return stateAgrees(e);
  }

  /**
   * Suspect's jurisdiction vs the state baked into the twin's CAND_ID.
   * Municipal jurisdictions (AUS, SF, …) are not two-letter state codes and can
   * never match a federal seat — which is the correct answer for them.
   */
  function stateAgrees(e: (typeof enriched)[number]): boolean {
    const ours = (e.jurisdiction ?? "").toUpperCase();
    const theirs = fecState(e.twin_fec_id);
    return ours.length === 2 && theirs.length === 2 && ours === theirs;
  }

  /**
   * Same-person evidence is the UNION of two independent signals, because
   * neither alone survives contact with this data:
   *
   *   name  — the two first names agree on a 3-letter key.
   *   seat  — the twin's CAND_ID describes the seat this official actually
   *           holds (chamber AND state).
   *
   * Name alone is not sufficient. FEC files candidates under their LEGAL name
   * while we hold the name they go by, and that pair disagrees constantly:
   * Ted/Rafael Cruz, Mike/James Johnson, Jack/John Reed, Bill/William Cassidy,
   * Jim/James Banks, Andy/Garland Barr — ten of the top twelve overlaps on this
   * clone. Routing those into CROSS-PERSON tells PR 2 to delete a person's own
   * donors as if they were someone else's, so name-only is not merely imprecise
   * here, it is destructive.
   *
   * Nor is name alone NECESSARY: a first name can be uncomparable because the
   * twin is an FEC initial (cn{yy} mints candidate rows from CAND_NAME and
   * parseFecName reduces a leading initial cluster to the initial, so Jon
   * Ossoff's own candidate row is literally named "T Ossoff") or because the
   * suspect's own first name is under three letters ("Ro" Khanna, "Al" Green).
   * Undecidable is not "disagrees".
   *
   * Seat alone is not sufficient either — it cannot see municipal officials at
   * all, and Scott Wiener / Connie Chan are same-name pairs on a city seat.
   *
   * The union keeps both reference cases right for the RIGHT reason:
   *   Shontel Brown  Representative-OH vs Sherrod's S6OH00163 (Senate) →
   *                  names disagree AND seat disagrees → CROSS-PERSON.
   *   Jon Ossoff     Senator-GA vs S8GA00180 → name undecidable, seat agrees →
   *                  SAME-PERSON.
   */
  function branchOf(e: (typeof enriched)[number]): { branch: Branch; decidedBy: string } {
    const overlapping =
      e.twin_id !== null && e.frac >= boundary.fracCut && e.shared >= boundary.sharedFloor;
    if (!overlapping) return { branch: "UNIQUE HOLDER", decidedBy: "" };

    const a = officialFirstKey(e.first_name, e.full_name);
    const b = officialFirstKey(e.twin_first_name, e.twin_name);
    const nameOk = a !== "" && b !== "" && a === b;
    const seatOk = seatAgrees(e);

    if (!nameOk && !seatOk) return { branch: "CROSS-PERSON MISATTRIBUTION", decidedBy: "neither" };
    return {
      branch: "SAME-PERSON DUPLICATE",
      decidedBy: nameOk && seatOk ? "name+seat" : nameOk ? "name" : "seat",
    };
  }

  const classified = enriched.map((e) => {
    const { branch, decidedBy } = branchOf(e);
    return { ...e, branch, decidedBy, stateOk: stateAgrees(e) };
  });

  // Officials whose fraction clears the cut but whose absolute overlap does
  // not — low-confidence UNIQUE HOLDERs, called out so PR 2 knows they are the
  // ambiguous corner rather than confident singletons.
  const lowVolume = classified.filter(
    (e) => e.branch === "UNIQUE HOLDER" && e.twin_id !== null && e.frac >= boundary.fracCut,
  );

  // ── output ────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(process.cwd(), "../../docs/audits");
  fs.mkdirSync(outDir, { recursive: true });
  const base = `${stamp}-fec-orphan-attribution`;
  const tsvPath = path.join(outDir, `${base}.tsv`);
  const mdPath = path.join(outDir, `${base}.md`);

  const header = [
    "branch", "decided_by", "official_id", "full_name", "tier", "is_active", "role_title",
    "jurisdiction", "stored_fec_id", "totals_table_cents", "donation_cents", "donation_rows",
    "first_at", "last_at",
    "twin_id", "twin_name", "twin_tier", "twin_fec_id", "twin_fec_state", "state_agrees",
    "twin_total_cents", "shared_pairs", "overlap_frac",
  ];
  const body = classified.map((e) => [
    e.branch, e.branch === "UNIQUE HOLDER" ? "" : e.decidedBy,
    e.official_id, e.full_name, e.tier ?? "", String(e.is_active),
    e.role_title ?? "", e.jurisdiction ?? "", e.stored_fec_id ?? "",
    e.totals_table_cents, e.donation_cents, e.donation_rows,
    iso(e.first_at), iso(e.last_at),
    e.twin_id ?? "", e.twin_name ?? "", e.twin_tier ?? "", e.twin_fec_id ?? "",
    e.twin_id ? fecState(e.twin_fec_id) : "", e.twin_id ? String(e.stateOk) : "",
    e.twin_id ? e.twin_total_cents : "",
    String(e.shared), e.frac.toFixed(4),
  ]);
  fs.writeFileSync(tsvPath, tsv([header, ...body]), "utf8");

  // ── summary ───────────────────────────────────────────────────────────────
  const BRANCHES: Branch[] = [
    "CROSS-PERSON MISATTRIBUTION",
    "SAME-PERSON DUPLICATE",
    "UNIQUE HOLDER",
  ];
  const perBranch = BRANCHES.map((b) => {
    const rows = classified.filter((e) => e.branch === b);
    return { branch: b, n: rows.length, cents: rows.reduce((s, e) => s + Number(e.donation_cents), 0) };
  });

  const totalCents = classified.reduce((s, e) => s + Number(e.donation_cents), 0);
  const platformCents = Number(platform.cents);
  const withTwin = classified.filter((e) => e.twin_id !== null);

  const byTier = new Map<string, { n: number; cents: number }>();
  for (const e of classified) {
    const k = `${e.tier ?? "?"}${e.is_active ? "" : " (inactive)"}`;
    const cur = byTier.get(k) ?? { n: 0, cents: 0 };
    cur.n += 1;
    cur.cents += Number(e.donation_cents);
    byTier.set(k, cur);
  }

  // Fraction histogram, 20 buckets — the evidence behind the chosen cut.
  const hist = Array.from({ length: 21 }, () => 0);
  for (const e of classified) hist[Math.min(20, Math.floor(e.frac * 20))] += 1;

  const REF_SHONTEL = "f29bbd4e-944f-4840-adbd-16a4706a3c02";
  const REF_OSSOFF = "1376dc1e-f697-40b2-8c0f-780f8fe8ea00";
  const refShontel = classified.find((e) => e.official_id === REF_SHONTEL);
  const refOssoff = classified.find((e) => e.official_id === REF_OSSOFF);
  const shontelOk = refShontel?.branch === "CROSS-PERSON MISATTRIBUTION";
  const ossoffOk = refOssoff?.branch === "SAME-PERSON DUPLICATE";

  const L: string[] = [];
  L.push(`# FEC orphan attribution — ${env} — ${stamp}`);
  L.push("");
  L.push(`Read-only enumeration for FIX-930. Row-level detail: \`${path.basename(tsvPath)}\`.`);
  L.push("");
  L.push("## Signal");
  L.push("");
  L.push("Officials holding `relationship_type='donation'` rows sourced `fec_bulk*` whose");
  L.push("`source_ids` carries neither `fec_candidate_id` nor a role-prefix-matching `fec_id`");
  L.push("— i.e. officials the current match index would never select, yet who hold FEC money.");
  L.push("");
  L.push(`- **suspects: ${classified.length}** holding **${usd(totalCents)}**`);
  L.push(
    `- platform-wide donation money on officials: ${usd(platformCents)} across ${Number(platform.officials).toLocaleString()} officials` +
      ` → suspects are **${((totalCents / platformCents) * 100).toFixed(1)}%** of official-attributed donation dollars`,
  );
  L.push(`- with a same-surname official that DOES carry an FEC id: ${withTwin.length} (${usd(withTwin.reduce((s, e) => s + Number(e.donation_cents), 0))})`);
  L.push("");
  L.push("| tier | officials | dollars |");
  L.push("|---|---:|---:|");
  for (const [k, v] of [...byTier.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
    L.push(`| ${k} | ${v.n} | ${usd(v.cents)} |`);
  }
  L.push("");
  L.push("## Branch boundary");
  L.push("");
  L.push("Drawn on the **overlap fraction** (shared `(from_id, cycle_year)` pairs / the suspect's");
  L.push("own donation rows), not on the raw shared count — 90 shared out of 100 rows is damning,");
  L.push("90 out of 45,000 is noise. Cut placed at the midpoint of the widest empty band in the");
  L.push(`observed fraction distribution within [${BAND_LO}, ${BAND_HI}].`);
  L.push("");
  L.push(`- widest empty band: **${boundary.gapLo.toFixed(4)} → ${boundary.gapHi.toFixed(4)}** (width ${boundary.gapWidth.toFixed(4)})`);
  L.push(`- **fraction cut = ${boundary.fracCut.toFixed(4)}**`);
  L.push(
    `- **absolute floor = ${boundary.sharedFloor} shared pairs** — widest empty band in the low tail ` +
      `(${boundary.floorGapLo} → ${boundary.floorGapHi}) of the shared counts *among suspects that already clear the ` +
      `fraction cut*. That is the only population the floor acts on. Its job is the tiny-N corner: an ` +
      `official with 2 rows that both land on a same-surname twin scores frac=1.0 by chance, because ` +
      `one PAC giving to two same-surname officials in a cycle is entirely ordinary.`,
  );
  L.push(`- distribution **${boundary.bimodal ? "IS" : "is NOT"} cleanly bimodal** on the fraction${boundary.bimodal ? "" : " — the cut is a judgement call, treat branch membership near the boundary as provisional"}.`);
  L.push("");
  L.push("Raw shared-pair counts alone are **not** bimodal — they spread near-continuously from 0");
  L.push("to the maximum, which is exactly why the boundary is normalised before it is cut.");
  L.push("");
  L.push("| overlap fraction | suspects |");
  L.push("|---|---:|");
  for (let i = 0; i <= 20; i++) {
    if (hist[i] === 0) continue;
    const label = i === 20 ? "1.00 (exact)" : `${(i / 20).toFixed(2)}–${((i + 1) / 20).toFixed(2)}`;
    L.push(`| ${label} | ${hist[i]} |`);
  }
  L.push("");
  L.push("## Branches");
  L.push("");
  L.push("| branch | officials | dollars | remediation |");
  L.push("|---|---:|---:|---|");
  const REMEDY: Record<Branch, string> = {
    "CROSS-PERSON MISATTRIBUTION": "delete the mis-bound rows — another person's donors",
    "SAME-PERSON DUPLICATE": "merge the two official rows, carrying the FK surface",
    "UNIQUE HOLDER": "**write the missing `source_ids` id** — do NOT remove rows",
  };
  for (const b of perBranch) {
    L.push(`| ${b.branch} | ${b.n} | ${usd(b.cents)} | ${REMEDY[b.branch]} |`);
  }
  L.push("");
  const overlapping = classified.filter((e) => e.branch !== "UNIQUE HOLDER");
  const decCount = (k: string) => overlapping.filter((e) => e.decidedBy === k).length;
  L.push("### How SAME vs CROSS is decided");
  L.push("");
  L.push("Same-person evidence is the **union of two independent signals** — `name` (first names agree");
  L.push("on a 3-letter key) and `seat` (the twin's CAND_ID describes the chamber AND state this official");
  L.push("actually holds). CROSS-PERSON is the residual: neither signal fires.");
  L.push("");
  L.push(`- decided \`name+seat\`: ${decCount("name+seat")}`);
  L.push(`- decided \`seat\` only: ${decCount("seat")}`);
  L.push(`- decided \`name\` only: ${decCount("name")}`);
  L.push(`- \`neither\` → CROSS-PERSON: ${decCount("neither")}`);
  L.push("");
  L.push("**Why not first-name agreement alone, as originally scoped.** FEC files candidates under their");
  L.push("LEGAL name while we hold the name they go by, and that pair disagrees constantly — Ted/Rafael");
  L.push("Cruz, Mike/James Johnson, Jack/John Reed, Bill/William Cassidy, Jim/James Banks, Andy/Garland");
  L.push("Barr were **ten of the top twelve overlaps** on this clone. Routing those into CROSS-PERSON tells");
  L.push("PR 2 to delete a person's own donors as though they were someone else's, so name-only is not");
  L.push("merely imprecise here — it is destructive. Nor is a name match *necessary*: a first name can be");
  L.push("uncomparable because the twin is an FEC initial (`T Ossoff`) or because the suspect's own first");
  L.push("name is under three letters (`Ro` Khanna, `Al` Green). **Undecidable is not \"disagrees\".**");
  L.push("");
  L.push("Seat alone would not do either — it cannot see municipal officials at all, and Scott Wiener /");
  L.push("Connie Chan are same-name pairs on a city seat. And chamber without state is far too coarse:");
  L.push("most suspects are Representatives, so Al Green (TX) would have merged into Mark Green's");
  L.push("`H8TN07076`. Both reference cases land correctly for the right reason — Shontel Brown is a");
  L.push("Representative against a *Senate* CAND_ID (both signals fail), Jon Ossoff a GA Senator against");
  L.push("`S8GA00180` (seat fires where the name cannot).");
  L.push("");
  const sameStateMismatch = classified.filter((e) => e.branch === "SAME-PERSON DUPLICATE" && !e.stateOk);
  if (sameStateMismatch.length > 0) {
    L.push(
      `**Merge-blockers:** ${sameStateMismatch.length} SAME-PERSON DUPLICATE row(s) were decided on name ` +
        `agreement but their jurisdiction does NOT match the state in the twin's CAND_ID — a shared name ` +
        `across state lines. Confirm identity by hand before merging: ` +
        sameStateMismatch
          .map((e) => `${e.full_name} (${e.jurisdiction ?? "?"}) → ${e.twin_name} (${e.twin_fec_id})`)
          .join("; ") +
        ".",
    );
    L.push("");
  }
  if (lowVolume.length > 0) {
    L.push(
      `**Low-confidence corner:** ${lowVolume.length} suspect(s) clear the fraction cut but not the ` +
        `absolute floor, so they are filed as UNIQUE HOLDER (the non-destructive default). They are ` +
        `the ambiguous population, not confident singletons — re-check them by hand in PR 2. ` +
        `Grep the TSV for \`overlap_frac >= ${boundary.fracCut.toFixed(4)}\` with \`branch=UNIQUE HOLDER\`.`,
    );
    L.push("");
  }
  L.push("## Reference cases");
  L.push("");
  L.push("| case | expected branch | observed | shared pairs | ✓ |");
  L.push("|---|---|---|---:|:-:|");
  L.push(
    `| Shontel M. Brown → Sherrod Brown | CROSS-PERSON MISATTRIBUTION | ${refShontel?.branch ?? "**ABSENT**"} | ${refShontel?.shared ?? "—"} | ${shontelOk ? "✓" : "✗"} |`,
  );
  L.push(
    `| Jon Ossoff (elected) → Ossoff (candidate) | SAME-PERSON DUPLICATE | ${refOssoff?.branch ?? "**ABSENT**"} | ${refOssoff?.shared ?? "—"} | ${ossoffOk ? "✓" : "✗"} |`,
  );
  L.push("");
  if (!shontelOk || !ossoffOk) {
    L.push("> **STOP — a reference case is missing or in the wrong branch. The signal is wrong;");
    L.push("> do not act on these numbers until it is re-derived.**");
    L.push("");
  }
  L.push("## Top suspects by dollars");
  L.push("");
  L.push("| official | tier | branch | rows | dollars | window | twin | shared |");
  L.push("|---|---|---|---:|---:|---|---|---:|");
  for (const e of classified.slice(0, 25)) {
    L.push(
      `| ${e.full_name} | ${e.tier ?? ""}${e.is_active ? "" : " (inactive)"} | ${e.branch} | ${e.rows.toLocaleString()} | ${usd(e.donation_cents)} | ${iso(e.first_at)}→${iso(e.last_at)} | ${e.twin_name ?? "—"}${e.twin_fec_id ? ` (${e.twin_fec_id})` : ""} | ${e.shared.toLocaleString()} |`,
    );
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("Figures are environment-specific. **Re-derive on prod before acting on any of them.**");
  L.push("");
  fs.writeFileSync(mdPath, L.join("\n"), "utf8");

  // ── console ───────────────────────────────────────────────────────────────
  console.log(`suspects: ${classified.length}  holding ${usd(totalCents)}`);
  console.log(`platform: ${usd(platformCents)} over ${Number(platform.officials).toLocaleString()} officials (${((totalCents / platformCents) * 100).toFixed(1)}% suspect)`);
  console.log(`with same-surname FEC-bound twin: ${withTwin.length}`);
  console.log("");
  console.log(`boundary: frac >= ${boundary.fracCut.toFixed(4)} AND shared >= ${boundary.sharedFloor}`);
  console.log(`  fraction gap ${boundary.gapLo.toFixed(4)} → ${boundary.gapHi.toFixed(4)} (width ${boundary.gapWidth.toFixed(4)})`);
  console.log(`  floor gap    ${boundary.floorGapLo} → ${boundary.floorGapHi} (above-cut suspects only)`);
  console.log(`  cleanly bimodal on fraction: ${boundary.bimodal ? "yes" : "NO"}`);
  console.log("");
  for (const b of perBranch) {
    console.log(`  ${b.branch.padEnd(28)} ${String(b.n).padStart(4)}   ${usd(b.cents)}`);
  }
  if (lowVolume.length > 0) {
    console.log(`  (${lowVolume.length} low-confidence: frac over cut, shared under floor → filed UNIQUE HOLDER)`);
  }
  console.log("");
  console.log(`reference Shontel/Sherrod  → ${refShontel?.branch ?? "ABSENT"}  ${shontelOk ? "OK" : "MISMATCH"}`);
  console.log(`reference Ossoff/Ossoff    → ${refOssoff?.branch ?? "ABSENT"}  ${ossoffOk ? "OK" : "MISMATCH"}`);
  console.log("");
  console.log(`wrote ${path.relative(process.cwd(), tsvPath)}`);
  console.log(`wrote ${path.relative(process.cwd(), mdPath)}`);

  if (!shontelOk || !ossoffOk) {
    console.error("\nA reference case is missing or landed in the wrong branch — the signal is wrong.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
