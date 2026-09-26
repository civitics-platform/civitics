#!/usr/bin/env node
// fix1226-rederive-received-totals.mjs — ONE authorized prod data set (FIX-1226 (b), cc-160).
//
// Re-derives financial_entities.total_received_cents for the committees the
// unscoped PAC upsert zeroed, through the FE totals family's own writer:
//
//   SELECT public.financial_entity_received_totals_rebuild(ARRAY[…]::uuid[]);
//
// (20260704000000_fix702_726_incremental_financial_entity_totals.sql:213-232.)
// It sums FR rows to_type = from_type = 'financial_entity', relationship_type =
// 'donation', to_id = ANY(p_ids), grouped by to_id, and UPDATEs only ids present
// in that aggregate whose stored value IS DISTINCT FROM the sum. It never zeroes
// an id with no rows, so a re-run of the same manifest updates only rows that
// are still distinct: the set is idempotent.
//
// WHY: until 200a98c2 (cc-159) upsertPacEntitiesBatch's unscoped mode wrote a
// literal 0 into total_received_cents on conflict, on every FEC run. The only
// re-deriver, fe-crawl (jobid 46), is FR-dirty, so a committee whose FR rows did
// not change kept the 0; the monthly reconcile (jobid 14) is an orphan sweep
// that only ever zeroes, never re-derives. The writer is fixed; this puts back
// what it took.
//
// THE POPULATION (rule 45 — the filter is part of the contract): every
// financial_entities row with a fec_committee_id whose total_received_cents IS
// DISTINCT FROM financial_entity_inbound_totals.sum_total (FIX-1217's B, the
// same definition, PK join). That is the zeroed rows plus any drifted non-zero
// row. A row at 0 with no totals row has no inbound rows, so the function would
// not touch it and it is not in the set.
//
// THE COST IS A HEAP READ. The function filters to_type, which
// financial_relationships_donor_rollup_idx does not carry, so its aggregate is
// an Index Scan on financial_relationships_to with a heap Filter — not the
// index-only read B's bootstrap did (cc-159: 62.4 s for all 9,656 recipients).
// On the 09-03 clone the set's 1.81 M rows sit on 229,756 heap pages (52 % of
// the heap); an index scan does not use a buffer ring, so on prod it turns
// shared_buffers over many times. Hence the row cap and the budget below.
//
// TWO MODES
//   --dry-run   reads prod inside a READ ONLY transaction, writes the manifest
//               (docs/audits/2026-09-26-fix1226-rederive-manifest.json, or
//               --out), prints the plan and a plain EXPLAIN of the largest
//               ordinary chunk's aggregate. Writes nothing to the database.
//   --manifest  applies a committed manifest (rule 42: the prod run READS it).
//               One psql session, autocommit (no BEGIN, no
//               --single-transaction): SET statement_timeout = '10min' as its
//               own statement first (rule 109 — the bound is armed at the
//               statement boundary in front of the call), then ONE statement
//               per chunk, each its own transaction, fed only after the one
//               before it has returned. Prints `chunk i/n: k rows updated,
//               wall` as each commits. ON_ERROR_STOP stops at the first error;
//               the chunks before it stay committed and a re-run of the same
//               manifest is safe.
//
// CHUNKING (cc-160 D1): by b_tx_total ascending, 200 ids per chunk; every
// recipient over 10,000 inbound rows in a chunk of ONE, the largest last. Plus a
// row cap: an ordinary chunk also closes at 50,000 inbound rows, because the
// 200-id cut alone made two ordinary chunks (394 k and 442 k rows) larger than
// the RNC, the largest whale.
//
// THE BUDGET (--budget-seconds, default 960 = 2 × the 8 min the landing is
// gated for): the gate cleared a span, and the set must not run past it. Before
// each chunk, the script stops cleanly — nothing in flight — if the elapsed
// wall has reached the budget, or, once 100,000 rows have been read, if the
// elapsed wall plus the remaining rows at the observed rate would pass it.
// Exit 5 says so; the committed chunks stand and the manifest re-runs.
//
// THE CLAIM: session:wait-for-gate --then hands this process
// CIVITICS_PROD_SESSION_CLAIMANT; when present it is SET on the session. The
// function is not a guarded procedure, so the GUC only labels the session
// (rule 169).
//
// No psql meta-commands anywhere (see fix1142's note: a doubled backslash does
// not survive every shell that might edit this file). Walls are measured on the
// server (clock_timestamp() - statement_timestamp()), so pooler latency is not
// in them.
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD. Relative paths resolve
// against the cwd:
//   node scripts/fix1226-rederive-received-totals.mjs --dry-run --env-file <primary>/.env.local.prod
//   (from packages/data) node ../../scripts/fix1226-rederive-received-totals.mjs \
//       --manifest ../../docs/audits/2026-09-26-fix1226-rederive-manifest.json --env-file ../../.env.local.prod

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const DEFAULT_OUT = join(ROOT, "docs", "audits", "2026-09-26-fix1226-rederive-manifest.json");

const IDS_PER_CHUNK = 200;
const ROWS_PER_CHUNK = 50_000; // an ordinary chunk also closes here
const WHALE_ROWS = 10_000; // over this, a recipient is a chunk of one
const STATEMENT_TIMEOUT = "10min";
const PROJECTION_MIN_ROWS = 100_000; // below this the per-row rate is index probes, not heap
// cc-159 landing (iii): run_fe_inbound_rollup read every B recipient's inbound
// range in 62.4 s, index-only. The dry run scales that by rows as the FLOOR.
const BOOTSTRAP_SECONDS = 62.4;
// The 09-03 clone: the set's rows at 7.89 per heap page (1,813,206 / 229,756).
const CLONE_ROWS_PER_PAGE = 1_813_206 / 229_756;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes("--dry-run");
const MANIFEST = argValue("--manifest", null);
const OUT = resolve(argValue("--out", DEFAULT_OUT));
const ENV_FILE = resolve(argValue("--env-file", join(ROOT, ".env.local.prod")));
const BUDGET_SECONDS = Number(argValue("--budget-seconds", "960"));

if (DRY_RUN === (MANIFEST !== null)) {
  console.error("[fix1226] pass exactly one of --dry-run or --manifest <path>");
  process.exit(64);
}
if (!Number.isFinite(BUDGET_SECONDS) || BUDGET_SECONDS <= 0) {
  console.error("[fix1226] --budget-seconds must be a positive number");
  process.exit(64);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

// --local runs either mode against local Docker (the rehearsal); the manifest
// records its database, and an apply refuses a manifest from the other one.
const TARGET = process.argv.includes("--local") ? "local" : "prod";
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function prodUrl() {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[fix1226] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    console.error(`[fix1226] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
    process.exit(2);
  }
  const baseUrl = existsSync(POOLER_FILE)
    ? readFileSync(POOLER_FILE, "utf8").trim()
    : POOLER_FALLBACK;
  const u = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (u === baseUrl) {
    console.error(`[fix1226] could not inject password into pooler URL: ${baseUrl}`);
    process.exit(2);
  }
  return u;
}
const url = TARGET === "local" ? LOCAL_URL : prodUrl();

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const arrayLiteral = (ids) => `ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`;

/** The manifest's chunks, from rows with b_tx_total (D1 plus the row cap). */
function chunkIds(rows) {
  const sorted = [...rows].sort((a, b) => a.b_tx_total - b.b_tx_total || (a.id < b.id ? -1 : 1));
  const chunks = [];
  let cur = [];
  let curRows = 0;
  for (const r of sorted.filter((x) => x.b_tx_total <= WHALE_ROWS)) {
    if (cur.length > 0 && (cur.length === IDS_PER_CHUNK || curRows + r.b_tx_total > ROWS_PER_CHUNK)) {
      chunks.push(cur);
      cur = [];
      curRows = 0;
    }
    cur.push(r.id);
    curRows += r.b_tx_total;
  }
  if (cur.length > 0) chunks.push(cur);
  for (const w of sorted.filter((x) => x.b_tx_total > WHALE_ROWS)) chunks.push([w.id]);
  return chunks;
}

// ── --dry-run ────────────────────────────────────────────────────────────────
function dryRun() {
  // One row out: the whole read as a single JSON value, so psql's tag lines and
  // separators never have to be parsed.
  const sql = `
SET TRANSACTION READ ONLY;
SELECT json_build_object(
  'read_at', now(),
  'b_all_tx_total', (SELECT COALESCE(sum(tx_total), 0) FROM public.financial_entity_inbound_totals),
  'b_all_recipients', (SELECT count(*) FROM public.financial_entity_inbound_totals),
  'zero_no_inbound', (SELECT count(*) FROM public.financial_entities fe
                        LEFT JOIN public.financial_entity_inbound_totals b ON b.recipient_id = fe.id
                       WHERE fe.fec_committee_id IS NOT NULL AND fe.total_received_cents = 0
                         AND b.recipient_id IS NULL),
  'rows', COALESCE((
    SELECT json_agg(json_build_object(
             'id', fe.id,
             'fec_committee_id', fe.fec_committee_id,
             'before_cents', fe.total_received_cents,
             'b_sum_total', b.sum_total,
             'b_tx_total', b.tx_total) ORDER BY b.tx_total, fe.id)
      FROM public.financial_entities fe
      JOIN public.financial_entity_inbound_totals b ON b.recipient_id = fe.id
     WHERE fe.fec_committee_id IS NOT NULL
       AND fe.total_received_cents IS DISTINCT FROM b.sum_total), '[]'::json)
);
`;
  const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-At"], {
    stdio: ["pipe", "pipe", "inherit"],
    input: sql,
    shell: process.platform === "win32",
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  });
  if (res.error || res.status !== 0) {
    console.error(`[fix1226] dry-run read failed: ${res.error?.message ?? `psql exit ${res.status}`}`);
    process.exit(1);
  }
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith("{"));
  if (!line) {
    console.error("[fix1226] dry-run read returned no JSON row");
    process.exit(1);
  }
  const read = JSON.parse(line);
  const rows = read.rows.map((r) => ({
    id: r.id,
    fec_committee_id: r.fec_committee_id,
    before_cents: r.before_cents,
    b_sum_total: Number(r.b_sum_total),
    b_tx_total: Number(r.b_tx_total),
  }));
  for (const r of rows) {
    if (!UUID_RE.test(r.id)) throw new Error(`not a uuid: ${r.id}`);
  }
  const zeroed = rows.filter((r) => r.before_cents === 0).length;
  const nullBefore = rows.filter((r) => r.before_cents === null).length;
  const drifted = rows.length - zeroed - nullBefore;
  const chunks = chunkIds(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const isWhale = (c) => c.length === 1 && byId.get(c[0]).b_tx_total > WHALE_ROWS;
  const chunkTx = chunks.map((c) => sum(c.map((id) => byId.get(id).b_tx_total)));
  const txTotal = sum(rows.map((r) => r.b_tx_total));
  const sumTotal = sum(rows.map((r) => r.b_sum_total));

  const manifest = {
    generated_at: read.read_at,
    database: TARGET,
    fix: "FIX-1226",
    prompt: "cc-160",
    function: "public.financial_entity_received_totals_rebuild(uuid[])",
    population_filter:
      "financial_entities fe JOIN financial_entity_inbound_totals b ON b.recipient_id = fe.id " +
      "WHERE fe.fec_committee_id IS NOT NULL AND fe.total_received_cents IS DISTINCT FROM b.sum_total",
    population: { zeroed, drifted, null_before: nullBefore, zero_no_inbound_excluded: read.zero_no_inbound },
    totals: { ids: rows.length, b_tx_total: txTotal, b_sum_total_cents: sumTotal },
    chunking: {
      order: "b_tx_total ascending",
      ids_per_chunk: IDS_PER_CHUNK,
      rows_per_chunk: ROWS_PER_CHUNK,
      whale_rows_over: WHALE_ROWS,
      whales_last: true,
    },
    chunks,
    ids: rows,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 1) + "\n");

  const whaleChunks = chunks.filter(isWhale).length;
  const floor = BOOTSTRAP_SECONDS * (txTotal / Number(read.b_all_tx_total));
  const pages = txTotal / CLONE_ROWS_PER_PAGE;
  const gb = (pages * 8192) / 1e9;
  console.log(`[fix1226] DRY RUN — ${TARGET} read at ${read.read_at}; nothing written to the database`);
  console.log(`[fix1226] manifest: ${OUT}`);
  console.log(`[fix1226] population: ${fmtInt(rows.length)} ids — zeroed ${fmtInt(zeroed)}, drifted ${fmtInt(drifted)}, null ${fmtInt(nullBefore)}; excluded (0, no inbound rows): ${fmtInt(read.zero_no_inbound)}`);
  console.log(`[fix1226] inbound rows Σ b_tx_total ${fmtInt(txTotal)}; Σ b_sum_total ${fmtInt(sumTotal)} ¢`);
  console.log(`[fix1226] chunks: ${chunks.length} (${chunks.length - whaleChunks} ordinary of ≤ ${IDS_PER_CHUNK} ids / ≤ ${fmtInt(ROWS_PER_CHUNK)} rows, ${whaleChunks} whales of 1, largest last)`);
  chunks.forEach((c, i) => {
    const tag = isWhale(c) ? ` whale ${c[0]} (${byId.get(c[0]).fec_committee_id})` : "";
    console.log(`[fix1226]   chunk ${i + 1}/${chunks.length}: ${c.length} ids, ${fmtInt(chunkTx[i])} rows${tag}`);
  });
  console.log(
    `[fix1226] expected wall FLOOR (index-only scaling): ${BOOTSTRAP_SECONDS} s × ${fmtInt(txTotal)} / ${fmtInt(read.b_all_tx_total)} B rows ` +
      `(${fmtInt(read.b_all_recipients)} recipients) = ${floor.toFixed(1)} s`,
  );
  console.log(
    `[fix1226] heap read at the clone's ${CLONE_ROWS_PER_PAGE.toFixed(2)} rows/page: ~${fmtInt(Math.round(pages))} pages, ~${gb.toFixed(1)} GB — ` +
      `${Math.round((gb * 1000) / 50)} s at 50 MB/s, ${Math.round((gb * 1000) / 9)} s at 9 MB/s`,
  );

  // The plan the largest ordinary chunk's aggregate gets — plain EXPLAIN, no ANALYZE.
  const ordinary = chunks.map((c, i) => (isWhale(c) ? -1 : chunkTx[i]));
  const largest = ordinary.indexOf(Math.max(...ordinary));
  if (largest < 0 || ordinary[largest] < 0) process.exit(0); // nothing ordinary to plan
  const explain = `
SET TRANSACTION READ ONLY;
EXPLAIN
SELECT fr.to_id, SUM(fr.amount_cents)::bigint AS total
  FROM public.financial_relationships fr
 WHERE fr.to_type = 'financial_entity'
   AND fr.from_type = 'financial_entity'
   AND fr.relationship_type = 'donation'
   AND fr.to_id = ANY (${arrayLiteral(chunks[largest])})
 GROUP BY fr.to_id;
`;
  console.log(`[fix1226] plan of the largest ordinary chunk's aggregate (chunk ${largest + 1}, ${chunks[largest].length} ids, ${fmtInt(chunkTx[largest])} rows):`);
  const ex = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-At"], {
    stdio: ["pipe", "pipe", "inherit"],
    input: explain,
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  // The ANY(...) literal is the chunk's ids — already in the manifest; print the plan without it.
  for (const l of (ex.stdout ?? "").split(/\r?\n/)) {
    if (l.trim() !== "") console.log(`[fix1226]   ${l.replace(/ANY \('\{[^}]*\}'::uuid\[\]\)/, "ANY ('{…}'::uuid[])")}`);
  }
  process.exit(ex.status ?? 1);
}

// ── --manifest (apply) ───────────────────────────────────────────────────────
function loadManifest(path) {
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (m.database !== TARGET) throw new Error(`manifest database is ${JSON.stringify(m.database)}, this run targets "${TARGET}"`);
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) throw new Error("manifest has no chunks");
  const known = new Map((m.ids ?? []).map((r) => [r.id, r]));
  const seen = new Set();
  for (const c of m.chunks) {
    if (!Array.isArray(c) || c.length === 0) throw new Error("manifest has an empty chunk");
    for (const id of c) {
      if (!UUID_RE.test(id)) throw new Error(`not a uuid: ${id}`);
      if (!known.has(id)) throw new Error(`chunk id ${id} is not in the manifest's ids`);
      if (seen.has(id)) throw new Error(`id ${id} is in two chunks`);
      seen.add(id);
    }
  }
  if (seen.size !== known.size) throw new Error(`chunks cover ${seen.size} ids, the manifest lists ${known.size}`);
  return { m, known };
}

function apply() {
  const path = resolve(MANIFEST);
  const { m, known } = loadManifest(path);
  const n = m.chunks.length;
  const chunkTx = m.chunks.map((c) => sum(c.map((id) => known.get(id).b_tx_total)));
  const totalRows = sum(chunkTx);
  const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (claimant !== null && /[\r\n\0]/.test(claimant)) {
    console.error("[fix1226] CIVITICS_PROD_SESSION_CLAIMANT must be one line");
    process.exit(64);
  }
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const chunkSql = (i) =>
    `WITH r AS MATERIALIZED (SELECT public.financial_entity_received_totals_rebuild(${arrayLiteral(m.chunks[i])}) AS n) ` +
    `SELECT 'CHUNK|${i + 1}|${m.chunks[i].length}|${chunkTx[i]}|' || r.n || '|' || ` +
    `round((EXTRACT(epoch FROM clock_timestamp() - statement_timestamp()) * 1000)::numeric, 1) FROM r;\n`;

  console.error(`[fix1226] ${TARGET === "prod" ? "PROD (Supabase Pro)" : "LOCAL"} — WRITE: ${n} chunks, ${fmtInt(known.size)} ids, ${fmtInt(totalRows)} inbound rows, from ${path}`);
  console.error(
    `[fix1226] each chunk is one autocommitted SELECT of financial_entity_received_totals_rebuild; statement_timeout ${STATEMENT_TIMEOUT}; ` +
      `budget ${BUDGET_SECONDS} s${claimant !== null ? `; claimant ${claimant}` : ""}`,
  );
  const t0 = Date.now();
  console.error(`[fix1226] start ${new Date(t0).toISOString()}`);

  let updated = 0;
  let done = 0;
  let rowsDone = 0;
  let chunkMs = 0;
  let stopReason = null;
  let buf = "";
  const child = spawn("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-At"], {
    stdio: ["pipe", "pipe", "inherit"],
    shell: process.platform === "win32",
  });

  // Feed the next chunk, or end the session: after the last chunk, or when the
  // budget says the next one must not start.
  const next = () => {
    if (done < n) {
      const elapsed = (Date.now() - t0) / 1000;
      const remaining = totalRows - rowsDone;
      const rate = rowsDone >= PROJECTION_MIN_ROWS && chunkMs > 0 ? rowsDone / (chunkMs / 1000) : null;
      if (elapsed >= BUDGET_SECONDS) {
        stopReason = `elapsed ${elapsed.toFixed(1)} s reached the ${BUDGET_SECONDS} s budget`;
      } else if (rate !== null && elapsed + remaining / rate > BUDGET_SECONDS) {
        stopReason =
          `projected ${(elapsed + remaining / rate).toFixed(1)} s (${fmtInt(remaining)} rows left at ${fmtInt(Math.round(rate))} rows/s) ` +
          `passes the ${BUDGET_SECONDS} s budget`;
      } else {
        child.stdin.write(chunkSql(done));
        return;
      }
    }
    child.stdin.end(`SELECT 'END|' || clock_timestamp();\n`);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      const p = line.split("|");
      if (p[0] === "START") {
        console.log(`[fix1226] server start ${p[1]}`);
        next();
      } else if (p[0] === "END") {
        console.log(`[fix1226] server end ${p[1]}`);
      } else if (p[0] === "CHUNK") {
        const [, i, ids, tx, k, ms] = p;
        updated += Number(k);
        done += 1;
        rowsDone += Number(tx);
        chunkMs += Number(ms);
        const short = Number(k) < Number(ids) ? ` (${Number(ids) - Number(k)} already equal)` : "";
        console.log(`[fix1226] chunk ${i}/${n}: ${k} rows updated of ${ids} ids, ${fmtInt(tx)} inbound rows, wall ${(Number(ms) / 1000).toFixed(2)} s${short}`);
        next();
      } else if (line.trim() !== "") {
        console.log(`[fix1226] ${line}`);
      }
    }
  });
  child.on("error", (e) => {
    console.error(`[fix1226] failed to launch psql: ${e.message}`);
    process.exit(1);
  });
  child.on("close", (code) => {
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[fix1226] end ${new Date().toISOString()} — psql wall clock ${wall} s, chunk walls Σ ${(chunkMs / 1000).toFixed(1)} s`);
    console.log(`[fix1226] total: ${fmtInt(updated)} rows updated over ${done}/${n} chunks (manifest ${fmtInt(known.size)} ids)`);
    if (code !== 0) {
      console.error(`[fix1226] STOPPED at chunk ${done + 1}/${n} (psql exit ${code}). Chunks 1..${done} are committed; read why before re-running.`);
      process.exit(code ?? 1);
    }
    if (stopReason !== null) {
      console.error(`[fix1226] STOPPED before chunk ${done + 1}/${n}: ${stopReason}. Chunks 1..${done} are committed; the manifest re-runs.`);
      process.exit(5);
    }
    process.exit(0);
  });

  let pre = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\n`;
  if (claimant !== null) pre += `SET civitics.prod_session_claimant = ${lit(claimant)};\n`;
  pre += `SET application_name = 'fix1226-rederive';\n`;
  pre += `SELECT 'START|' || clock_timestamp();\n`;
  child.stdin.write(pre);
}

if (DRY_RUN) dryRun();
else apply();
