/**
 * FIX-954 — cross-person contamination on officials that DO hold a legitimate
 * FEC binding, which the FIX-930 audit is structurally unable to see.
 *
 * WHY FIX-930 CANNOT FIND THESE
 * -----------------------------
 * Its suspect predicate ends `AND source_ids->>'fec_candidate_id' IS NULL`.
 * That clause is what supplies DIRECTION: it identifies which side of a
 * symmetric donation-key overlap is the holder the matcher would never
 * legitimately have selected. Once an official has a valid binding — the
 * correct end state, and what the FIX-952 backfill produced for Shontel M.
 * Brown — the audit stops seeing them while the contamination stays.
 *
 * Widening the predicate does NOT work and was measured: 1,023 officials /
 * $1.07B at >=50% overlap, still 497 / $289M after the name+seat CROSS test,
 * because the overlap relation is symmetric. The same query flags Marjorie
 * Greene (rightful holder of H0GA06192) against Richard Greene, who is the
 * actually mis-bound one. So direction has to come from somewhere else.
 *
 * THE DIRECTION SIGNAL, AND WHY IT IS THREE-PART
 * ----------------------------------------------
 * The writer bumps `updated_at` on every row it believes should exist, so a
 * binding that is still current keeps being refreshed while a mis-binding
 * freezes at the last run that resolved to it. Relative staleness alone is NOT
 * sufficient — measured on this data it produces two false-positive classes:
 *
 *   Dormant holder — an inactive candidate whose CAND_ID no longer appears in
 *     current FEC files has EVERY row stale (Carl Sherman: 0 of 115 rows
 *     refreshed, Claudia De La Cruz 0 of 109, Ylenia Aguilar 0 of 83). Being
 *     staler than an active same-surname official is then guaranteed and means
 *     nothing; deleting would destroy their real historical money.
 *   Both current — R Ivey has ALL 144 rows fresh yet scores 100% "staler"
 *     because the counterpart happened to be written moments later.
 *
 * So a row is only actionable when all three hold:
 *   (a) the holder's copy is OLDER than the counterpart's, and
 *   (b) the counterpart is a CROSS-person same-surname official, and
 *   (c) the holder has rows strictly NEWER than the newest contaminated row —
 *       proof that the holder's own binding is still being written, so the
 *       stale set is residue rather than the holder simply being dormant.
 *
 * (c) is deliberately expressed RELATIVE to the holder's own rows rather than
 * against a global per-cycle run watermark. There is no trustworthy watermark
 * to use: `data_sync_log` records no cycle scope, the run history carries
 * failed runs and a stuck `running` row, and `max(updated_at)` per cycle marks
 * 1.62M of 1.71M cycle-2024 rows "stale" because recent runs were not full
 * passes. Making that derivable is FIX-957.
 *
 * NOT A SWEEP. The manifest is small and every row of it is meant to be read
 * before --apply; that is what FIX-934 asked for on this branch ("a reviewed,
 * row-level manifest before anything is deleted, not a heuristic sweep").
 *
 * Usage:
 *   pnpm --filter @civitics/data data:remediate:bound-cross-person            # dry-run + manifest
 *   pnpm --filter @civitics/data data:remediate:bound-cross-person -- --apply
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import { constructDbUrlFromEnv, envLabel, PLATFORM_SQL, usd } from "./fec-orphan-classify";

/** Holder must be staler on at least this share of shared keys. */
const STALE_SHARE_MIN = 0.95;
/** Overlap must be at least this share of the holder's own rows. */
const OVERLAP_MIN = 0.5;
/** …and at least this many shared keys, so coincidence is not a story. */
const SHARED_MIN = 52;
/** Holder must have at least this many rows NEWER than its contaminated set. */
const LIVE_ROWS_MIN = 50;
/** Sanity bound — measured 5 on the local clone. */
const MAX_OFFICIALS = 40;

const MONEY_EDGE_TYPES = ["donation", "opposition"];
const CHURNED_TABLES = ["financial_relationships", "entity_connections", "officials"];

/**
 * Build the candidate set. Mirrors the FIX-934 SAME/CROSS test in SQL: a
 * counterpart is CROSS-person when the 3-letter first-name keys disagree AND
 * its CAND_ID does not describe the seat the holder actually occupies.
 */
const BUILD_SQL = `
DROP TABLE IF EXISTS _lk;
CREATE TEMP TABLE _lk AS
SELECT o.id,
       regexp_replace(upper(COALESCE(NULLIF(o.last_name,''), o.full_name)), '[^A-Z]', '', 'g') AS lastkey,
       COALESCE(o.source_ids->>'fec_candidate_id', o.source_ids->>'fec_id') AS fecid,
       left(regexp_replace(upper(COALESCE(NULLIF(o.first_name,''), split_part(o.full_name,' ',1))), '[^A-Z]', '', 'g'), 3) AS first3,
       o.full_name, o.role_title, o.tier, upper(j.short_name) AS juris
  FROM officials o LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id;
CREATE INDEX ON _lk(lastkey);

DROP TABLE IF EXISTS _holder;
CREATE TEMP TABLE _holder AS
SELECT fr.to_id AS id, count(*)::bigint AS rows
  FROM financial_relationships fr
 WHERE fr.to_type='official' AND fr.relationship_type='donation'
   AND fr.metadata->>'source' LIKE 'fec_bulk%'
 GROUP BY 1;
CREATE UNIQUE INDEX ON _holder(id);

-- CROSS-person same-surname pairs only.
DROP TABLE IF EXISTS _xp;
CREATE TEMP TABLE _xp AS
SELECT h.id AS holder_id, t.id AS owner_id
  FROM _holder h
  JOIN _lk s ON s.id = h.id
  JOIN _lk t ON t.lastkey = s.lastkey AND t.id <> h.id AND t.fecid IS NOT NULL
 WHERE s.lastkey <> ''
   AND NOT (s.first3 <> '' AND t.first3 <> '' AND s.first3 = t.first3)
   AND NOT (CASE
         WHEN upper(left(t.fecid,1))='S' AND s.role_title IN ('Senator','Candidate for Senator')
           THEN s.juris = upper(substr(t.fecid,3,2))
         WHEN upper(left(t.fecid,1))='H' AND s.role_title IN ('Representative','Candidate for Representative')
           THEN s.juris = upper(substr(t.fecid,3,2))
         WHEN upper(left(t.fecid,1))='P' AND s.role_title IN ('President','Candidate for President')
           THEN s.juris = upper(substr(t.fecid,3,2))
         ELSE false END);

-- Every holder row a CROSS-person owner holds with a STRICTLY FRESHER copy.
DROP TABLE IF EXISTS _stale;
CREATE TEMP TABLE _stale AS
SELECT DISTINCT ON (a.id)
       a.id AS row_id, p.holder_id, p.owner_id, a.amount_cents, a.cycle_year, a.updated_at
  FROM _xp p
  JOIN financial_relationships a
    ON a.to_type='official' AND a.to_id = p.holder_id AND a.relationship_type='donation'
  JOIN financial_relationships b
    ON b.to_type='official' AND b.to_id = p.owner_id
   AND b.relationship_type = a.relationship_type
   AND b.from_id           = a.from_id
   AND b.cycle_year        = a.cycle_year
   AND b.updated_at        > a.updated_at
 ORDER BY a.id, b.updated_at DESC;
CREATE INDEX ON _stale(holder_id);
CREATE INDEX ON _stale(row_id);
ANALYZE _stale;
`;

/**
 * Per-holder evidence. `live_rows` is the (c) test: rows the holder owns that
 * are NEWER than the newest contaminated row, i.e. proof the binding still
 * writes. `shared` counts every CROSS-overlapping key regardless of direction,
 * so `stale_share` is honest about how one-sided the staleness actually is.
 */
const EVIDENCE_SQL = `
SELECT h.id                                       AS holder_id,
       lk.full_name, lk.role_title, lk.tier, lk.juris, lk.fecid,
       h.rows                                     AS holder_rows,
       s.stale_rows, s.stale_cents, s.newest_stale,
       ov.shared,
       (SELECT count(*) FROM financial_relationships fr
         WHERE fr.to_type='official' AND fr.to_id = h.id
           AND fr.updated_at > s.newest_stale)::bigint AS live_rows,
       t.top_owner                                AS owner_id,
       ow.full_name                               AS owner_name,
       ow.fecid                                   AS owner_fecid,
       ow.role_title                              AS owner_role
  FROM _holder h
  JOIN _lk lk ON lk.id = h.id
  -- Everything below is scoped to ONE owner — the counterpart accounting for
  -- the most contaminated rows. Mixing owners made the ratio incoherent
  -- (stale_rows counted every owner while shared counted one, so the share
  -- could exceed 1.0 and a holder contaminated by several owners could clear
  -- the gate without any single owner justifying it).
  JOIN LATERAL (
        SELECT owner_id AS top_owner FROM _stale x
         WHERE x.holder_id = h.id
         GROUP BY owner_id ORDER BY count(*) DESC, owner_id LIMIT 1) t ON TRUE
  JOIN LATERAL (
        SELECT count(*)::bigint AS stale_rows,
               COALESCE(sum(amount_cents),0)::bigint AS stale_cents,
               max(updated_at) AS newest_stale,
               t.top_owner
          FROM _stale st
         WHERE st.holder_id = h.id AND st.owner_id = t.top_owner) s ON s.stale_rows > 0
  JOIN _lk ow ON ow.id = s.top_owner
  JOIN LATERAL (
        SELECT count(*)::bigint AS shared
          FROM _xp p
          JOIN financial_relationships a
            ON a.to_type='official' AND a.to_id=p.holder_id AND a.relationship_type='donation'
          JOIN financial_relationships b
            ON b.to_type='official' AND b.to_id=p.owner_id
           AND b.relationship_type=a.relationship_type AND b.from_id=a.from_id
           AND b.cycle_year=a.cycle_year
         WHERE p.holder_id = h.id AND p.owner_id = s.top_owner) ov ON TRUE
 ORDER BY s.stale_cents DESC;
`;

interface Evidence {
  holder_id: string;
  full_name: string;
  role_title: string | null;
  tier: string | null;
  juris: string | null;
  fecid: string | null;
  holder_rows: string;
  stale_rows: string;
  stale_cents: string;
  newest_stale: Date;
  shared: string;
  live_rows: string;
  owner_id: string;
  owner_name: string | null;
  owner_fecid: string | null;
  owner_role: string | null;
}

type Verdict = "ACT" | "REFUSE-dormant" | "REFUSE-weak-overlap" | "REFUSE-low-share";

function verdictOf(e: Evidence): Verdict {
  const holderRows = Number(e.holder_rows);
  const stale = Number(e.stale_rows);
  const shared = Number(e.shared);
  const live = Number(e.live_rows);
  if (shared < SHARED_MIN || shared / Math.max(holderRows, 1) < OVERLAP_MIN) return "REFUSE-weak-overlap";
  if (stale / Math.max(shared, 1) < STALE_SHARE_MIN) return "REFUSE-low-share";
  // (c) — no rows newer than the contamination means the holder is dormant (or
  // its whole set is current), so staleness carries no information.
  if (live < LIVE_ROWS_MIN) return "REFUSE-dormant";
  return "ACT";
}

async function q<T = Record<string, unknown>>(c: Client, sql: string, p: unknown[] = []): Promise<T[]> {
  return (await c.query(sql, p)).rows as T[];
}
async function run(c: Client, label: string, sql: string, p: unknown[] = []): Promise<number> {
  const t0 = Date.now();
  const n = (await c.query(sql, p)).rowCount ?? 0;
  console.log(`  ${label.padEnd(50)} ${String(n).padStart(9)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const allowProd = argv.includes("--allow-prod");
  const prod = /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");

  if (prod && !allowProd) {
    console.error("✗ Active env points at PROD but --allow-prod was not passed.");
    process.exit(1);
  }
  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("Could not construct a DB URL.");
    process.exit(1);
  }

  console.log(`# FIX-954 — cross-person contamination on BOUND officials`);
  console.log(`Env:        ${envLabel()}`);
  console.log(`Mode:       ${apply ? "APPLY (COMMIT)" : "DRY-RUN (ROLLBACK)"}\n`);

  const client = new Client({ connectionString: dbUrl, statement_timeout: 1_800_000 });
  await client.connect();
  await client.query("SET idle_in_transaction_session_timeout = 0");
  if (!prod) await client.query("SET max_parallel_workers_per_gather = 0");

  console.log("Building CROSS-person overlap + staleness evidence…");
  await client.query(BUILD_SQL);
  const evidence = await q<Evidence>(client, EVIDENCE_SQL);

  const rows = evidence.map((e) => ({ e, verdict: verdictOf(e) }));
  const act = rows.filter((r) => r.verdict === "ACT");

  console.log(`\n── Candidates (${rows.length}) ─────────────────────────────`);
  console.log(
    `  ${"holder".padEnd(24)}${"role".padEnd(16)}${"verdict".padEnd(20)}` +
      `${"stale $".padStart(14)}${"stale/shared".padStart(13)}${"live".padStart(8)}  owner`,
  );
  for (const { e, verdict } of rows) {
    const shared = Number(e.shared);
    const share = shared > 0 ? (Number(e.stale_rows) / shared) * 100 : 0;
    console.log(
      `  ${(e.full_name ?? "").slice(0, 23).padEnd(24)}${(e.role_title ?? "").slice(0, 15).padEnd(16)}` +
        `${verdict.padEnd(20)}${usd(e.stale_cents).padStart(14)}` +
        `${`${e.stale_rows}/${e.shared}`.padStart(13)}${String(e.live_rows).padStart(8)}  ` +
        `${e.owner_name} [${e.owner_fecid}]`,
    );
  }

  const actCents = act.reduce((s, r) => s + BigInt(r.e.stale_cents), 0n);
  console.log(`\n  ACT: ${act.length} officials, ${usd(actCents.toString())}`);
  for (const r of rows.filter((x) => x.verdict !== "ACT")) {
    console.log(`  ${r.verdict.padEnd(20)} ${r.e.full_name} — ${usd(r.e.stale_cents)} (not acted on)`);
  }

  // ── Artifacts ─────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(__dirname, "../../../../docs/audits");
  const base = path.join(outDir, `${stamp}-fix954-bound-cross-person${envLabel() === "local" ? "-local" : ""}`);
  const header = [
    "holder_id", "full_name", "role_title", "tier", "jurisdiction", "holder_fec_id",
    "verdict", "holder_rows", "shared_rows", "stale_rows", "stale_usd", "stale_share",
    "live_rows_newer_than_contamination", "owner_name", "owner_fec_id", "owner_role",
  ];
  const body = rows.map(({ e, verdict }) => {
    const shared = Number(e.shared);
    return [
      e.holder_id, e.full_name, e.role_title ?? "", e.tier ?? "", e.juris ?? "", e.fecid ?? "",
      verdict, e.holder_rows, e.shared, e.stale_rows, (Number(e.stale_cents) / 100).toFixed(2),
      shared > 0 ? (Number(e.stale_rows) / shared).toFixed(4) : "",
      e.live_rows, e.owner_name ?? "", e.owner_fecid ?? "", e.owner_role ?? "",
    ].map(String);
  });
  fs.writeFileSync(
    `${base}.tsv`,
    [header, ...body].map((r) => r.map((c) => c.replace(/[\t\r\n]/g, " ")).join("\t")).join("\n") + "\n",
  );
  console.log(`\nWrote ${base}.tsv`);

  if (act.length === 0) {
    console.log("\nNothing to act on.");
    await client.end();
    return;
  }
  if (act.length > MAX_OFFICIALS) {
    console.error(`\n✗ ${act.length} exceeds MAX_OFFICIALS=${MAX_OFFICIALS} — refusing.`);
    await client.end();
    process.exit(1);
  }

  // ── Delete, with conservation ─────────────────────────────────────────────
  await client.query("BEGIN");
  try {
    const [before] = await q<{ cents: string }>(client, PLATFORM_SQL);
    await client.query(
      `DROP TABLE IF EXISTS _act;
       CREATE TEMP TABLE _act (holder_id uuid PRIMARY KEY, owner_id uuid NOT NULL);`,
    );
    for (const r of act) {
      await client.query(`INSERT INTO _act VALUES ($1::uuid, $2::uuid)`, [r.e.holder_id, r.e.owner_id]);
    }

    await client.query(`
      DROP TABLE IF EXISTS _doomed;
      -- Delete ONLY the rows the evidenced owner covers, matching the gate's
      -- scope exactly. A holder's overlap with some third party was never
      -- justified by this manifest and is left alone.
      CREATE TEMP TABLE _doomed AS
        SELECT s.row_id, s.holder_id, s.amount_cents
          FROM _stale s JOIN _act a ON a.holder_id = s.holder_id AND a.owner_id = s.owner_id;
      CREATE UNIQUE INDEX ON _doomed(row_id);
      DROP TABLE IF EXISTS _donor;
      CREATE TEMP TABLE _donor AS
        SELECT DISTINCT fr.from_id AS id FROM financial_relationships fr
          JOIN _doomed d ON d.row_id = fr.id WHERE fr.from_id IS NOT NULL;
      CREATE UNIQUE INDEX ON _donor(id);
    `);
    const [agg] = await q<{ n: string; cents: string }>(
      client,
      `SELECT count(*)::text AS n, COALESCE(sum(amount_cents),0)::text AS cents FROM _doomed`,
    );

    const deleted = await run(
      client,
      "FR delete contaminated rows",
      `DELETE FROM financial_relationships fr USING _doomed d WHERE fr.id = d.row_id`,
    );
    await run(
      client,
      "entity_connections delete stale money edges",
      `DELETE FROM entity_connections e USING _act a
        WHERE e.to_type='official' AND e.to_id = a.holder_id
          AND e.from_type='financial_entity'
          AND e.connection_type::text = ANY($1::text[])`,
      [MONEY_EDGE_TYPES],
    );

    const [after] = await q<{ cents: string }>(client, PLATFORM_SQL);
    const drop = BigInt(before?.cents ?? "0") - BigInt(after?.cents ?? "0");
    const expected = BigInt(agg?.cents ?? "0");
    console.log("\n── Conservation ─────────────────────────────────────────");
    console.log(`  platform donation dollars: ${usd(before?.cents ?? "0")} → ${usd(after?.cents ?? "0")}`);
    console.log(`  observed drop:             ${usd(drop.toString())}`);
    console.log(`  deleted rows:              ${usd(expected.toString())}  (${deleted.toLocaleString()} rows)`);
    console.log(`  difference (must be $0):   ${usd((drop - expected).toString())}  ${drop === expected ? "OK" : "FAIL"}`);
    if (drop !== expected) throw new Error("conservation FAILED");

    if (apply) {
      await client.query("COMMIT");
      console.log(`\n✓ COMMITTED — ${deleted.toLocaleString()} rows removed from ${act.length} officials.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n✓ DRY-RUN complete — rolled back. Re-run with --apply to commit.`);
      await client.end();
      return;
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n✗ Rolled back:", err instanceof Error ? err.message : String(err));
    await client.end();
    process.exit(1);
  }

  // ── Rollups + the standing vacuum rule ────────────────────────────────────
  console.log("\n── Rollups ──────────────────────────────────────────────");
  const [dn] = await q<{ n: string }>(client, `SELECT count(*)::text AS n FROM _donor`);
  const donors = Number(dn?.n ?? 0);
  await client.query("SET statement_timeout = 0");
  await run(client, "donor_rollup_rebuild_recipients", `SELECT donor_rollup_rebuild_recipients(ARRAY(SELECT holder_id FROM _act))`);
  await run(client, "rebuild_official_donation_totals()", `SELECT rebuild_official_donation_totals()`);
  const CH = 5000;
  for (let i = 0; i < Math.ceil(donors / CH); i++) {
    await run(client, `financial_entity_donation_totals_rebuild ${i + 1}`,
      `SELECT financial_entity_donation_totals_rebuild(ARRAY(SELECT id FROM _donor ORDER BY id OFFSET $1 LIMIT $2))`, [i * CH, CH]);
    await run(client, `donor_party_rollup_rebuild_donors ${i + 1}`,
      `SELECT donor_party_rollup_rebuild_donors(ARRAY(SELECT id FROM _donor ORDER BY id OFFSET $1 LIMIT $2))`, [i * CH, CH]);
  }
  for (const fn of [
    "rebuild_financial_entity_ie_totals", "refresh_group_donor_rollup", "rebuild_entity_search_index",
    "refresh_official_sector_dollars_mv", "refresh_official_homepage_stats_mv", "refresh_homepage_stats_mv",
    "refresh_chord_industry_flows_mv", "refresh_chord_donor_type_party_flows_mv", "refresh_chord_donor_state_party_flows_mv",
  ]) {
    try {
      await run(client, `${fn}()`, `SELECT ${fn}()`);
    } catch (err) {
      console.error(`  ! ${fn}() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Standing rule (root CLAUDE.md): a bulk rewrite ends by vacuuming what it rewrote.
  console.log("\n── VACUUM (ANALYZE) ─────────────────────────────────────");
  for (const t of CHURNED_TABLES) {
    try {
      await run(client, `VACUUM ANALYZE ${t}`, `VACUUM (ANALYZE) public.${t}`);
    } catch (err) {
      console.error(`  ! VACUUM ${t} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
