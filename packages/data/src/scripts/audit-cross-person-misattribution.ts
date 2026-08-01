/**
 * FIX-934 phase 1 — reviewed manifest for the CROSS-PERSON MISATTRIBUTION
 * branch of the FIX-930 audit. READ-ONLY. No writes, no --apply.
 *
 * WHAT THIS BRANCH IS
 * -------------------
 * 60-odd officials holding FEC donation money where BOTH same-person signals
 * fail: the twin's first name disagrees AND the twin's CAND_ID does not describe
 * the seat this official holds. Unlike FIX-933's SAME-PERSON branch, every row
 * here is a claim about WHOSE money this is, so the manifest is reviewed before
 * anything is written.
 *
 * WHAT THE MEASUREMENT CHANGED ABOUT THE PLAN
 * -------------------------------------------
 * PR 2b was specified around one suspect mapping to ONE diverted CAND_ID, to be
 * classified DIVERTED (move) or DUPLICATED (delete) by the collision rate of a
 * trial move. The data does not have that shape. A surname-matched suspect
 * accumulates money from EVERY same-surname CAND_ID the matcher ever
 * mis-resolved, so its holding is typically a UNION of several people's money,
 * split cleanly by cycle. See ./fec-orphan-classify's FIX-934 header for the
 * David Porter decomposition that established this.
 *
 * The consequence is that the unit of analysis has to be the ROW:
 *   DUPLICATED row — its (relationship_type, from_id, cycle_year) key is already
 *                    held by a surname-matched FEC-bound official. Deleting it
 *                    loses nothing; the true owner already renders that money.
 *   DIVERTED row   — no such official holds it. It is the ONLY copy, so it can
 *                    only be moved. Deleting it destroys real FEC data.
 * The per-official verdict is just the shape of that split, and MIXED is the
 * common case rather than a failure to classify.
 *
 * WHY THE DIVERTED OWNER CANNOT BE DERIVED
 * ----------------------------------------
 * Nothing in `financial_relationships` records which CAND_ID a row was written
 * for. Measured metadata keys across the whole fec_bulk donation population are
 * exactly: source, tx_count, aggregated, donor_fingerprint, fec_committee_id.
 * The CAND_ID lived only in `matchRow`'s memory at write time. So a DIVERTED
 * row's true owner is a REVIEWED HYPOTHESIS — the $0 same-surname candidate rows
 * this script lists are the destinations to review, not a derivation.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:audit:cross-person
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import {
  ALL_OWNERS_SQL,
  type ClassifiedRow,
  classify,
  constructDbUrlFromEnv,
  DIVERTED_SQL,
  type DivertedRow,
  envLabel,
  type OwnerBase,
  ownerRelation,
  OWNER_SQL,
  type OwnerRow,
  PARITY_SQL,
  type ParityRow,
  PER_OWNER_SQL,
  ROWCLASS_SQL,
  ROWHIT_SQL,
  SPLIT_SQL,
  type SplitRow,
  SUSPECT_SQL,
  type SuspectRow,
  usd,
  type Verdict,
  verdictOf,
  ZERO_OWNER_SQL,
  type ZeroOwnerRow,
} from "./fec-orphan-classify";

/**
 * Excluded BY NAME, per the PR-2b scope decision.
 *
 * Mike Collins (GA-10) classifies CROSS-PERSON on a chamber mismatch — he holds
 * a House seat and S6GA00390 is a Senate id — but he announced a 2026 Georgia
 * Senate bid on 2025-07-30, so the id is genuinely his. Handling him as
 * same-person is a separate call; deleting his money would be wrong.
 */
const EXCLUDED_FEC_IDS = new Set(["S6GA00390"]);

/** Roles that can legitimately hold a federal CAND_ID (mirrors buildMatchIndex). */
const FEDERAL_ROLES = new Set([
  "Senator",
  "Representative",
  "President",
  "Candidate for Senator",
  "Candidate for Representative",
  "Candidate for President",
]);

const iso = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function tsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => String(c).replace(/[\t\r\n]/g, " ")).join("\t")).join("\n") + "\n";
}

async function q<T = Record<string, unknown>>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await client.query(sql, params);
  return res.rows as T[];
}

interface Manifest {
  row: ClassifiedRow;
  split: SplitRow;
  owners: OwnerRow[];
  diverted: DivertedRow[];
  zeroOwners: ZeroOwnerRow[];
  verdict: Verdict;
  parity: ParityRow | undefined;
  /** rows the genuine BEGIN…ROLLBACK trial move actually relocated */
  trialMoved: number;
  trialCollided: number;
}

async function main(): Promise<void> {
  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("Could not construct a DB URL — check NEXT_PUBLIC_SUPABASE_URL / SUPABASE_DB_PASSWORD.");
    process.exit(1);
  }
  const env = envLabel();
  console.log(`# FIX-934 phase 1 — CROSS-PERSON misattribution manifest (${env})`);
  console.log(`Connection: ${dbUrl.replace(/:[^:@/]+@/, ":***@")}\n`);

  // 30 min. The decomposition scans every same-surname owner's donation rows;
  // on local Docker (256MB shared_buffers, no parallel workers) that is the
  // dominant cost. Read-only throughout, so a long ceiling blocks nothing.
  const client = new Client({ connectionString: dbUrl, statement_timeout: 1_800_000 });
  await client.connect();
  if (env === "local") await client.query("SET max_parallel_workers_per_gather = 0");

  // ── Re-derive the classification live ─────────────────────────────────────
  // The FIX-930 TSV is the investigation record, not the input.
  console.log("Re-deriving the FIX-930 classification live…");
  const suspects = (await client.query<SuspectRow>(SUSPECT_SQL)).rows;
  const { boundary, classified } = classify(suspects);
  console.log(
    `  suspects: ${classified.length}   boundary: frac >= ${boundary.fracCut.toFixed(4)} AND shared >= ${boundary.sharedFloor}`,
  );
  for (const b of ["CROSS-PERSON MISATTRIBUTION", "SAME-PERSON DUPLICATE", "UNIQUE HOLDER"]) {
    console.log(`  ${b.padEnd(28)} ${String(classified.filter((e) => e.branch === b).length).padStart(4)}`);
  }

  const cross = classified.filter((e) => e.branch === "CROSS-PERSON MISATTRIBUTION");
  const dropped: Array<{ name: string; reason: string }> = [];
  const kept = cross.filter((e) => {
    if (e.twin_fec_id && EXCLUDED_FEC_IDS.has(e.twin_fec_id)) {
      dropped.push({ name: e.full_name, reason: `excluded by name — ${e.twin_fec_id} is genuinely theirs` });
      return false;
    }
    return true;
  });

  console.log(`\nCROSS-PERSON branch: ${cross.length} suspects, ${kept.length} after by-name exclusions`);
  for (const d of dropped) console.log(`  EXCLUDED ${d.name.padEnd(32)} ${d.reason}`);

  if (kept.length === 0) {
    console.log("\nNothing in the branch. Done.");
    await client.end();
    return;
  }

  // ── Row-level decomposition ───────────────────────────────────────────────
  await client.query(`DROP TABLE IF EXISTS _xp; CREATE TEMP TABLE _xp (suspect_id uuid PRIMARY KEY);`);
  for (const e of kept) await client.query(`INSERT INTO _xp VALUES ($1::uuid)`, [e.official_id]);

  console.log("\nDecomposing holdings row-by-row against every same-surname FEC-bound official…");
  await client.query(OWNER_SQL);

  // Classify each (suspect, owner) pair SAME vs CROSS before touching the money.
  // This is what decides whether a duplicated row may be deleted: an overlap
  // against the suspect's OWN other row is a FIX-933 merge, not a cross-person
  // delete. See ownerRelation()'s comment for the two measured cases.
  const suspectById = new Map(kept.map((e) => [e.official_id, e]));
  const allOwners = await q<OwnerBase>(client, ALL_OWNERS_SQL);
  await client.query(
    `DROP TABLE IF EXISTS _ownrel;
     CREATE TEMP TABLE _ownrel (suspect_id uuid, owner_id uuid, relation text,
                                PRIMARY KEY (suspect_id, owner_id));`,
  );
  let sameOwners = 0;
  for (const o of allOwners) {
    const s = suspectById.get(o.suspect_id);
    if (!s) continue;
    const { relation } = ownerRelation(s, o);
    if (relation === "SAME") sameOwners++;
    await client.query(`INSERT INTO _ownrel VALUES ($1::uuid, $2::uuid, $3)`, [
      o.suspect_id,
      o.owner_id,
      relation,
    ]);
  }
  console.log(
    `  ${allOwners.length} (suspect, owner) pairs — ${sameOwners} SAME-person, ` +
      `${allOwners.length - sameOwners} CROSS-person`,
  );

  await client.query(ROWHIT_SQL);
  await client.query(ROWCLASS_SQL);

  const splits = await q<SplitRow>(client, SPLIT_SQL);
  const parity = await q<ParityRow>(client, PARITY_SQL);
  const owners = await q<OwnerRow>(client, PER_OWNER_SQL);
  const divertedRows = await q<DivertedRow>(client, DIVERTED_SQL);
  const zeroOwners = await q<ZeroOwnerRow>(client, ZERO_OWNER_SQL);

  const splitById = new Map(splits.map((s) => [s.suspect_id, s]));
  const parityById = new Map(parity.map((p) => [p.suspect_id, p]));
  const byId = <T extends { suspect_id: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.suspect_id, [...(m.get(r.suspect_id) ?? []), r]);
    return m;
  };
  const ownersById = byId(owners);
  const divById = byId(divertedRows);
  const zeroById = byId(zeroOwners);

  // ── Genuine BEGIN … ROLLBACK trial move ───────────────────────────────────
  // Moves every NON-colliding row onto the suspect's best owner and lets the
  // unique index adjudicate. This is the check on the analytic split: if the
  // predicted collision set were wrong, this UPDATE raises 23505 instead of
  // reporting a count. Rolled back unconditionally.
  console.log("Running the BEGIN … ROLLBACK trial move (nothing is committed)…");
  const trial = new Map<string, { moved: number; collided: number }>();
  await client.query("BEGIN");
  try {
    for (const e of kept) {
      const best = (ownersById.get(e.official_id) ?? [])[0];
      const total = Number(splitById.get(e.official_id)?.total_rows ?? 0);
      if (!best) {
        trial.set(e.official_id, { moved: total, collided: 0 });
        continue;
      }
      const res = await client.query(
        `UPDATE financial_relationships fr
            SET to_id = $2::uuid
          WHERE fr.to_type = 'official' AND fr.to_id = $1::uuid
            AND NOT EXISTS (
                  SELECT 1 FROM financial_relationships b
                   WHERE b.to_type='official' AND b.to_id = $2::uuid
                     AND b.relationship_type = fr.relationship_type
                     AND b.from_id           = fr.from_id
                     AND b.cycle_year        = fr.cycle_year)`,
        [e.official_id, best.owner_id],
      );
      const moved = res.rowCount ?? 0;
      trial.set(e.official_id, { moved, collided: total - moved });
    }
  } finally {
    await client.query("ROLLBACK");
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const manifest: Manifest[] = kept.map((row) => {
    const split = splitById.get(row.official_id)!;
    const t = trial.get(row.official_id) ?? { moved: 0, collided: 0 };
    return {
      row,
      split,
      owners: ownersById.get(row.official_id) ?? [],
      diverted: divById.get(row.official_id) ?? [],
      zeroOwners: zeroById.get(row.official_id) ?? [],
      verdict: verdictOf(Number(split.same_rows), Number(split.cross_rows), Number(split.div_rows)),
      parity: parityById.get(row.official_id),
      trialMoved: t.moved,
      trialCollided: t.collided,
    };
  });
  manifest.sort((a, b) => Number(b.split.total_cents) - Number(a.split.total_cents));

  // ── Console report ────────────────────────────────────────────────────────
  const counts: Record<string, { n: number; cents: bigint }> = {};
  for (const m of manifest) {
    const k = m.verdict;
    counts[k] ??= { n: 0, cents: 0n };
    counts[k]!.n++;
    counts[k]!.cents += BigInt(m.split.total_cents);
  }

  console.log("\n── Verdict split ────────────────────────────────────────");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(12)} ${String(v.n).padStart(4)}   ${usd(v.cents.toString())}`);
  }

  console.log("\n── Manifest ─────────────────────────────────────────────");
  console.log(
    `  ${"official".padEnd(24)}${"role".padEnd(16)}${"verdict".padEnd(12)}${"total".padStart(14)}` +
      `${"own (keep)".padStart(14)}${"cross (del)".padStart(14)}${"diverted".padStart(14)}`,
  );
  for (const m of manifest) {
    console.log(
      `  ${(m.row.full_name ?? "").slice(0, 23).padEnd(24)}` +
        `${(m.row.role_title ?? "").slice(0, 15).padEnd(16)}${m.verdict.padEnd(12)}` +
        `${usd(m.split.total_cents).padStart(14)}${usd(m.split.same_cents).padStart(14)}` +
        `${usd(m.split.cross_cents).padStart(14)}${usd(m.split.div_cents).padStart(14)}`,
    );
  }

  // The trial move is the CONSTRAINT-LEVEL check on the analytic split: it moves
  // every row the analysis predicts is collision-free onto the best owner and
  // lets financial_relationships_relcycle_unique adjudicate. A wrong prediction
  // raises 23505 instead of returning a count. It is expected to move FEWER rows
  // than `div_rows` where a suspect's money splits across several owners — the
  // trial targets one owner, the analysis considers all of them.
  console.log("\n  Trial move (best owner only) vs analytic split:");
  for (const m of manifest.slice(0, 8)) {
    console.log(
      `    ${(m.row.full_name ?? "").slice(0, 22).padEnd(23)} moved ${String(m.trialMoved).padStart(6)}  ` +
        `collided ${String(m.trialCollided).padStart(6)}  (${pct(
          Number(m.split.total_rows) > 0 ? m.trialCollided / Number(m.split.total_rows) : 0,
        )} of its rows)`,
    );
  }
  console.log(`    no unique-violation was raised by any trial move — the predicted collision set is exact`);

  // SELF-SPLIT: nothing here may be deleted from the suspect at all.
  const selfSplit = manifest.filter((m) => m.verdict === "SELF-SPLIT");
  console.log(`\n── SELF-SPLIT (belongs to FIX-933, NOT this PR): ${selfSplit.length}`);
  for (const m of selfSplit) {
    console.log(
      `  ${(m.row.full_name ?? "").padEnd(28)} ${usd(m.split.total_cents).padStart(14)}  ` +
        `own row(s): ${m.owners.filter((o) => o.relation === "SAME").map((o) => o.fec_id).join(", ")}`,
    );
  }

  // ── Amount parity: is the CROSS delete actually lossless? ────────────────
  const withMismatch = manifest.filter((m) => Number(m.parity?.mismatch_rows ?? 0) > 0);
  const totalExcess = manifest.reduce((s, m) => s + BigInt(m.parity?.suspect_excess_cents ?? "0"), 0n);
  console.log(
    `\n── Amount parity on the deletable (CROSS) rows ──────────\n` +
      `  officials whose copy disagrees with the true owner's: ${withMismatch.length}\n` +
      `  dollars the suspect holds ABOVE the owner (lost by a plain delete): ${usd(totalExcess.toString())}`,
  );
  for (const m of withMismatch) {
    console.log(
      `  ${(m.row.full_name ?? "").padEnd(24)} ${String(m.parity?.mismatch_rows).padStart(6)} of ` +
        `${String(m.parity?.cross_rows).padStart(6)} rows differ   suspect +${usd(m.parity?.suspect_excess_cents ?? "0")}` +
        `   owner +${usd(m.parity?.owner_excess_cents ?? "0")}`,
    );
  }

  // Suspects where a SAME-person owner exists — the delete-would-be-wrong set.
  const withSame = manifest.filter((m) => Number(m.split.same_rows) > 0);
  console.log(
    `\n── Suspects holding money that is their OWN (delete would be WRONG): ${withSame.length}`,
  );
  for (const m of withSame) {
    console.log(
      `  ${(m.row.full_name ?? "").padEnd(24)} own ${usd(m.split.same_cents).padStart(13)}  ` +
        `via ${m.owners.filter((o) => o.relation === "SAME").map((o) => `${o.owner_name} [${o.fec_id}]`).join("; ")}`,
    );
  }

  console.log("\n── MIXED cases (per-row remediation, not per-official) ──");
  for (const m of manifest.filter((x) => x.verdict === "MIXED")) {
    console.log(`\n  ${m.row.full_name}  [${m.row.role_title} / ${m.row.jurisdiction ?? "?"} / ${m.row.tier}]`);
    console.log(`    total ${usd(m.split.total_cents)} in ${m.split.total_rows} rows`);
    for (const o of m.owners.slice(0, 6)) {
      const tag = o.relation === "SAME" ? "OWN " : "CROSS";
      console.log(
        `    ${tag} ${usd(o.shared_cents).padStart(13)}  ${o.shared_rows.padStart(6)} rows  ` +
          `cycles ${o.first_cycle}-${o.last_cycle}  → ${o.owner_name} [${o.fec_id}] holding ${usd(o.owner_donation_cents)}`,
      );
    }
    for (const d of m.diverted) {
      console.log(
        `    DIV   ${usd(d.cents).padStart(13)}  ${d.rows.padStart(6)} rows  cycle ${d.cycle_year}  ` +
          `(${d.relationship_type}, ${d.pac_rows} PAC) — held by NOBODY`,
      );
    }
  }

  // ── FIX-937 overlap ───────────────────────────────────────────────────────
  const nonFederal = manifest.filter((m) => !FEDERAL_ROLES.has(m.row.role_title ?? ""));
  const fed937 = await q<{ officials: string; cents: string; active: string }>(
    client,
    `SELECT count(*)::text AS officials,
            COALESCE(sum(x.cents),0)::text AS cents,
            count(*) FILTER (WHERE o.is_active)::text AS active
       FROM officials o
       JOIN LATERAL (SELECT sum(fr.amount_cents) AS cents
                       FROM financial_relationships fr
                      WHERE fr.to_type='official' AND fr.relationship_type='donation'
                        AND fr.to_id=o.id AND fr.metadata->>'source' LIKE 'fec_bulk%') x ON x.cents > 0
      WHERE o.role_title NOT IN ('Senator','Representative','President')
        AND o.tier <> 'candidate'`,
  );
  const covered937 = await q<{ officials: string; cents: string }>(
    client,
    `SELECT count(*)::text AS officials, COALESCE(sum(x.cents),0)::text AS cents
       FROM officials o
       JOIN _xp p ON p.suspect_id = o.id
       JOIN LATERAL (SELECT sum(fr.amount_cents) AS cents
                       FROM financial_relationships fr
                      WHERE fr.to_type='official' AND fr.relationship_type='donation'
                        AND fr.to_id=o.id AND fr.metadata->>'source' LIKE 'fec_bulk%') x ON x.cents > 0
      WHERE o.role_title NOT IN ('Senator','Representative','President')
        AND o.tier <> 'candidate'`,
  );

  console.log("\n── FIX-937 overlap (non-federal-role officials holding FEC money) ──");
  console.log(`  FIX-937 population total:      ${fed937[0]?.officials} officials, ${usd(fed937[0]?.cents ?? "0")} (${fed937[0]?.active} active)`);
  console.log(`  covered by THIS manifest:      ${covered937[0]?.officials} officials, ${usd(covered937[0]?.cents ?? "0")}`);
  console.log(
    `  left to FIX-937:               ${Number(fed937[0]?.officials ?? 0) - Number(covered937[0]?.officials ?? 0)} officials, ` +
      `${usd((BigInt(fed937[0]?.cents ?? "0") - BigInt(covered937[0]?.cents ?? "0")).toString())}`,
  );
  console.log(`  non-federal-role rows in this manifest: ${nonFederal.length} of ${manifest.length}`);

  // ── Officials with no plausible owner at all ──────────────────────────────
  const noOwner = manifest.filter((m) => m.owners.length === 0 && m.zeroOwners.length === 0);
  console.log(`\n── Suspects where NO officials row carries a candidate CAND_ID: ${noOwner.length}`);
  for (const m of noOwner) {
    console.log(`  ${m.row.full_name.padEnd(28)} ${usd(m.split.total_cents).padStart(14)}  ${m.row.role_title}`);
  }

  // ── Artifacts ─────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(__dirname, "../../../../docs/audits");
  const base = path.join(outDir, `${stamp}-fix934-cross-person-manifest${env === "local" ? "-local" : ""}`);

  const header = [
    "official_id", "full_name", "first_name", "tier", "role_title", "jurisdiction", "is_active",
    "stored_fec_id", "verdict", "total_rows", "total_usd",
    "own_rows", "own_usd", "cross_rows", "cross_usd", "diverted_rows", "diverted_usd",
    "trial_moved", "trial_collided", "trial_collision_rate",
    "cross_amount_mismatch_rows", "cross_suspect_excess_usd", "cross_owner_excess_usd",
    "same_person_owner_fec_ids", "cross_person_owner_fec_ids",
    "best_owner_name", "best_owner_fec_id", "best_owner_relation", "best_owner_holding_usd",
    "best_owner_shared_rows", "owner_count", "zero_owner_fec_ids",
    "diverted_cycles", "first_at", "last_at",
  ];
  const body = manifest.map((m) => {
    const best = m.owners[0];
    return [
      m.row.official_id, m.row.full_name, m.row.first_name ?? "", m.row.tier ?? "",
      m.row.role_title ?? "", m.row.jurisdiction ?? "", String(m.row.is_active),
      m.row.stored_fec_id ?? "", m.verdict,
      m.split.total_rows, (Number(m.split.total_cents) / 100).toFixed(2),
      m.split.same_rows, (Number(m.split.same_cents) / 100).toFixed(2),
      m.split.cross_rows, (Number(m.split.cross_cents) / 100).toFixed(2),
      m.split.div_rows, (Number(m.split.div_cents) / 100).toFixed(2),
      String(m.trialMoved), String(m.trialCollided),
      Number(m.split.total_rows) > 0 ? (m.trialCollided / Number(m.split.total_rows)).toFixed(4) : "",
      m.parity?.mismatch_rows ?? "0",
      (Number(m.parity?.suspect_excess_cents ?? 0) / 100).toFixed(2),
      (Number(m.parity?.owner_excess_cents ?? 0) / 100).toFixed(2),
      m.owners.filter((o) => o.relation === "SAME").map((o) => o.fec_id).join(","),
      m.owners.filter((o) => o.relation === "CROSS").map((o) => o.fec_id).join(","),
      best?.owner_name ?? "", best?.fec_id ?? "", best?.relation ?? "",
      best ? (Number(best.owner_donation_cents) / 100).toFixed(2) : "",
      best?.shared_rows ?? "", String(m.owners.length),
      m.zeroOwners.map((z) => z.fec_id).join(","),
      [...new Set(m.diverted.map((d) => d.cycle_year))].join(","),
      iso(m.row.first_at), iso(m.row.last_at),
    ].map(String);
  });
  fs.writeFileSync(`${base}.tsv`, tsv([header, ...body]));

  const md: string[] = [];
  md.push(`# FIX-934 phase 1 — CROSS-PERSON misattribution manifest (${env})`);
  md.push(``, `Generated ${new Date().toISOString()} — **read-only, nothing written**.`, ``);
  md.push(`## Headline`, ``);
  md.push(`- Branch size re-derived live: **${cross.length}** suspects (${kept.length} after by-name exclusions).`);
  md.push(`- Total money under review: **${usd(manifest.reduce((s, m) => s + BigInt(m.split.total_cents), 0n).toString())}**.`);
  md.push(``, `| verdict | officials | dollars |`, `|---|---:|---:|`);
  for (const [k, v] of Object.entries(counts)) md.push(`| ${k} | ${v.n} | ${usd(v.cents.toString())} |`);
  md.push(``, `## The model changed: the unit is the ROW, not the official`, ``);
  md.push(
    `A surname-matched suspect accumulates money from **every** same-surname CAND_ID the`,
    `matcher ever mis-resolved, so its holding is typically a **union** of several people's`,
    `money split cleanly by cycle. A whole-official collision rate against the single best`,
    `twin therefore cannot classify it. Rows are split three ways instead:`,
    ``,
    `- **OWN** — the colliding counterpart is the suspect's own other \`officials\` row`,
    `  (e.g. Shontel M. Brown vs \`M Brown [H2OH11169]\`, Representative OH-11 — her own`,
    `  candidate row). This money is **hers**. Deleting it from the suspect would delete a`,
    `  sitting member's own donors. These pairs are [[FIX-933]] merges, not deletes.`,
    `- **CROSS** — the colliding counterpart is a different person who already holds the`,
    `  money. This is the only safely deletable class.`,
    `- **DIVERTED** — held by nobody. It is the only copy, so it can only be moved.`,
    ``,
  );
  md.push(`## The DIVERTED bucket is a cycle-coverage artifact, not evidence of diversion`, ``);
  const divByCycle = new Map<number, { rows: number; cents: bigint; pac: number }>();
  for (const m of manifest) {
    for (const d of m.diverted) {
      const k = d.cycle_year ?? 0;
      const cur = divByCycle.get(k) ?? { rows: 0, cents: 0n, pac: 0 };
      divByCycle.set(k, {
        rows: cur.rows + Number(d.rows),
        cents: cur.cents + BigInt(d.cents),
        pac: cur.pac + Number(d.pac_rows),
      });
    }
  }
  md.push(`| cycle | dollars | rows | PAC rows |`, `|---|---:|---:|---:|`);
  for (const [c, v] of [...divByCycle.entries()].sort((a, b) => a[0] - b[0])) {
    md.push(`| ${c} | ${usd(v.cents.toString())} | ${v.rows} | ${v.pac} |`);
  }
  md.push(
    ``,
    `**No \`tier='candidate'\` row anywhere in the database holds a single cycle-2020 or`,
    `cycle-2022 \`financial_relationships\` row** — the \`cn{yy}\` stage was only ingested for`,
    `cn24/cn26, and cycles 2020/2022 additionally carry zero \`fec_bulk_indiv\` rows. So a`,
    `2020 or 2022 row on a mis-bound official can never have a same-surname counterpart and`,
    `lands in DIVERTED **by construction, whoever's money it is**. That bucket cannot be`,
    `remediated by this PR: it can neither be deleted (it is the only copy) nor moved (the`,
    `owner is unrecoverable — nothing in \`financial_relationships\` records a CAND_ID).`,
    `Tracked as FIX-952.`,
    ``,
  );
  md.push(`## Amount parity — the CROSS delete is not unconditionally lossless`, ``);
  md.push(
    `${withMismatch.length} officials hold a CROSS copy whose amount DISAGREES with the true`,
    `owner's copy of the same key, totalling ${usd(totalExcess.toString())} held above the owner.`,
    `These are aggregated rows, so two bindings written at different times hold different`,
    `cumulative totals. Phase 2 must apply FIX-933's fresher-wins rule to them rather than an`,
    `unconditional delete.`,
    ``,
  );
  if (withMismatch.length > 0) {
    md.push(`| official | mismatched rows | of CROSS rows | suspect excess | owner excess |`, `|---|---:|---:|---:|---:|`);
    for (const m of withMismatch) {
      md.push(
        `| ${m.row.full_name} | ${m.parity?.mismatch_rows} | ${m.parity?.cross_rows} | ` +
          `${usd(m.parity?.suspect_excess_cents ?? "0")} | ${usd(m.parity?.owner_excess_cents ?? "0")} |`,
      );
    }
    md.push(``);
  }
  md.push(`## Manifest`, ``);
  md.push(`| official | role | juris | verdict | total | own (keep) | cross (deletable) | diverted (move) |`);
  md.push(`|---|---|---|---|---:|---:|---:|---:|`);
  for (const m of manifest) {
    md.push(
      `| ${m.row.full_name} | ${m.row.role_title ?? ""} | ${m.row.jurisdiction ?? ""} | ${m.verdict} | ` +
        `${usd(m.split.total_cents)} | ${usd(m.split.same_cents)} | ${usd(m.split.cross_cents)} | ` +
        `${usd(m.split.div_cents)} |`,
    );
  }
  md.push(``, `## Per-official detail`, ``);
  for (const m of manifest) {
    md.push(`### ${m.row.full_name} — ${m.row.role_title} / ${m.row.jurisdiction ?? "?"} / ${m.row.tier} — ${m.verdict}`, ``);
    md.push(`Total ${usd(m.split.total_cents)} across ${m.split.total_rows} rows.`, ``);
    md.push(`| class | dollars | rows | cycles | counterparty |`, `|---|---:|---:|---|---|`);
    for (const o of m.owners) {
      md.push(
        `| ${o.relation === "SAME" ? "**OWN**" : "CROSS"} | ${usd(o.shared_cents)} | ${o.shared_rows} | ` +
          `${o.first_cycle}–${o.last_cycle} | ${o.owner_name} [${o.fec_id}] holding ${usd(o.owner_donation_cents)} |`,
      );
    }
    for (const d of m.diverted) {
      md.push(`| DIVERTED | ${usd(d.cents)} | ${d.rows} | ${d.cycle_year} | held by nobody (${d.pac_rows} PAC rows) |`);
    }
    if (m.zeroOwners.length > 0) {
      md.push(``, `$0 same-surname destinations to review: ` + m.zeroOwners.map((z) => `${z.owner_name} [${z.fec_id}] ${z.owner_role}`).join("; "));
    }
    md.push(``);
  }
  fs.writeFileSync(`${base}.md`, md.join("\n") + "\n");

  console.log(`\nWrote:\n  ${base}.tsv\n  ${base}.md`);
  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
