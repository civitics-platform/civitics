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
import {
  BAND_HI,
  BAND_LO,
  type Branch,
  classify,
  constructDbUrlFromEnv,
  envLabel,
  fecState,
  PLATFORM_SQL,
  SUSPECT_COUNT_SQL,
  SUSPECT_SQL,
  type SuspectRow,
  usd,
} from "./fec-orphan-classify";

// The suspect query, the derived branch boundary and the same-vs-cross decision
// live in ./fec-orphan-classify so the PR-2 remediation scripts act on EXACTLY
// this population. See that module's header for why it is shared rather than
// copied.

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

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

  // Reference-case ids, checked at the end. Read in the same transaction as
  // everything else so the verdict describes one consistent snapshot.
  const REF_SHONTEL = "f29bbd4e-944f-4840-adbd-16a4706a3c02";
  const REF_OSSOFF = "1376dc1e-f697-40b2-8c0f-780f8fe8ea00";

  /** Live facts about a reference official, used to prove a remediation LANDED. */
  interface RefFacts {
    id: string;
    /** carries source_ids->>'fec_candidate_id' */
    has_cand_id: boolean;
    /** still holds fec_bulk-sourced donation rows */
    holds_fec_money: boolean;
    /** live donation total on this row, cents */
    donation_cents: string;
    /** other officials rows claiming the SAME CAND_ID (0 once a merge finished) */
    rival_claims: string;
  }

  let suspects: SuspectRow[];
  let platform: { officials: string; cents: string };
  let refFacts: Map<string, RefFacts>;
  let expectedSuspects: number;
  try {
    // Read-only transaction: a stray write errors instead of landing.
    await client.query("BEGIN TRANSACTION READ ONLY");
    const [sRes, pRes, cRes, rRes] = [
      await client.query<SuspectRow>(SUSPECT_SQL),
      await client.query<{ officials: string; cents: string }>(PLATFORM_SQL),
      await client.query<{ n: string }>(SUSPECT_COUNT_SQL),
      await client.query<RefFacts>(
        `SELECT o.id::text AS id,
                (o.source_ids->>'fec_candidate_id' IS NOT NULL) AS has_cand_id,
                EXISTS (SELECT 1 FROM financial_relationships fr
                         WHERE fr.to_type='official' AND fr.relationship_type='donation'
                           AND fr.to_id = o.id
                           AND fr.metadata->>'source' LIKE 'fec_bulk%') AS holds_fec_money,
                COALESCE((SELECT sum(fr.amount_cents) FROM financial_relationships fr
                           WHERE fr.to_type='official' AND fr.relationship_type='donation'
                             AND fr.to_id = o.id), 0)::text AS donation_cents,
                (SELECT count(*) FROM officials r
                  WHERE r.id <> o.id
                    AND o.source_ids->>'fec_candidate_id' IS NOT NULL
                    AND r.source_ids->>'fec_candidate_id'
                        = o.source_ids->>'fec_candidate_id')::text AS rival_claims
           FROM officials o WHERE o.id = ANY($1::uuid[])`,
        [[REF_SHONTEL, REF_OSSOFF]],
      ),
    ];
    suspects = sRes.rows;
    platform = pRes.rows[0];
    expectedSuspects = Number(cRes.rows[0]?.n ?? -1);
    refFacts = new Map(rRes.rows.map((r) => [r.id, r]));
    await client.query("COMMIT");
  } finally {
    await client.end();
  }

  // Cross-check BEFORE anything is classified or written. Every CTE downstream
  // of `suspect` is a LEFT JOIN onto it, so the row count must survive the whole
  // chain — a mismatch means the query lost suspects and the report would
  // understate the problem while looking clean. Fail loudly instead.
  if (suspects.length !== expectedSuspects) {
    console.error(
      `\nSUSPECT QUERY MISMATCH — the predicate alone counts ${expectedSuspects} officials but ` +
        `SUSPECT_SQL returned ${suspects.length} rows.\n` +
        `One of its CTEs is dropping suspects. Do NOT act on this report; fix the query first.`,
    );
    process.exit(3);
  }

  // ── classify (shared with the PR-2 remediation scripts) ───────────────────
  const { boundary, classified } = classify(suspects);

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

  const refShontel = classified.find((e) => e.official_id === REF_SHONTEL);
  const refOssoff = classified.find((e) => e.official_id === REF_OSSOFF);

  // A reference case passes if it lands in its expected branch, OR if it is
  // absent AND there is POSITIVE EVIDENCE that its remediation landed.
  //
  // "Absent" alone is not enough, and this is the whole point of the check.
  // FIX-933 merged the SAME-PERSON branch, so Ossoff correctly leaves the
  // suspect population and a bare "in the expected branch" assertion would
  // exit(2) forever the moment the audit's own remediation shipped. But the
  // mirror-image failure is worse: a broken suspect predicate ALSO makes every
  // reference case absent, and a guard that accepts absence would go green on
  // an audit that found nothing at all — reporting "0 suspects, all clear" when
  // the truth is "the query is broken". That matters most for FIX-934, which
  // leans on this same audit to authorise DELETING rows.
  //
  // So each reference case declares what its remediation looks like, and
  // absence is only accepted when those live facts hold:
  //
  //   merge  (FIX-933, SAME-PERSON) — the survivor must still HOLD the money and
  //          must now CARRY the CAND_ID, with no rival row claiming it. That is
  //          "the survivor holds the merged total", which a predicate bug cannot
  //          fake: a broken query leaves the id unwritten and the rival present.
  //   delete (FIX-934, CROSS-PERSON) — the mis-bound rows are gone, so the row
  //          must hold NO fec_bulk donation money and claim no CAND_ID.
  type Remediation = "merge" | "delete";
  const refVerdict = (
    id: string,
    row: (typeof classified)[number] | undefined,
    expected: Branch,
    via: Remediation,
  ): { ok: boolean; observed: string } => {
    if (row) return { ok: row.branch === expected, observed: row.branch };
    const f = refFacts.get(id);
    if (!f) return { ok: false, observed: "**OFFICIALS ROW MISSING**" };
    if (via === "merge") {
      const ok = f.has_cand_id && f.holds_fec_money && f.rival_claims === "0";
      return {
        ok,
        observed: ok
          ? `MERGED (holds ${usd(f.donation_cents)}, carries its CAND_ID, no rival claim)`
          : `**ABSENT — merge evidence missing** (cand_id=${f.has_cand_id}, ` +
            `money=${f.holds_fec_money}, rival_claims=${f.rival_claims})`,
      };
    }
    const ok = !f.holds_fec_money && !f.has_cand_id;
    return {
      ok,
      observed: ok
        ? "CLEARED (no fec_bulk donation money, no CAND_ID claim)"
        : `**ABSENT — delete evidence missing** (money=${f.holds_fec_money}, cand_id=${f.has_cand_id})`,
    };
  };
  const vShontel = refVerdict(REF_SHONTEL, refShontel, "CROSS-PERSON MISATTRIBUTION", "delete");
  const vOssoff = refVerdict(REF_OSSOFF, refOssoff, "SAME-PERSON DUPLICATE", "merge");
  const shontelOk = vShontel.ok;
  const ossoffOk = vOssoff.ok;

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
    `| Shontel M. Brown → Sherrod Brown | CROSS-PERSON MISATTRIBUTION | ${vShontel.observed} | ${refShontel?.shared ?? "—"} | ${shontelOk ? "✓" : "✗"} |`,
  );
  L.push(
    `| Jon Ossoff (elected) → Ossoff (candidate) | SAME-PERSON DUPLICATE | ${vOssoff.observed} | ${refOssoff?.shared ?? "—"} | ${ossoffOk ? "✓" : "✗"} |`,
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
  console.log(`reference Shontel/Sherrod  → ${vShontel.observed}  ${shontelOk ? "OK" : "MISMATCH"}`);
  console.log(`reference Ossoff/Ossoff    → ${vOssoff.observed}  ${ossoffOk ? "OK" : "MISMATCH"}`);
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
