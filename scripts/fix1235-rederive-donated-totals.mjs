#!/usr/bin/env node
// fix1235-rederive-donated-totals.mjs — ONE authorized prod data set (FIX-1235, cc-163).
//
// Re-derives financial_entities.total_donated_cents for the committees the
// unscoped PAC upsert overwrote, through the FE totals family's own writer:
//
//   SELECT public.financial_entity_donation_totals_rebuild(ARRAY[…]::uuid[]);
//
// (20260704000000_fix702_726_incremental_financial_entity_totals.sql:182-206.)
// It sums FR rows from_type = 'financial_entity', relationship_type =
// 'donation', from_id = ANY(p_ids), grouped by from_id, and UPDATEs only ids
// present in that aggregate whose stored value IS DISTINCT FROM the sum. It
// never zeroes an id with no rows, so a re-run of the same manifest updates only
// rows that are still distinct: the set is idempotent.
//
// WHY: until 200a98c2 (cc-159) upsertPacEntitiesBatch's unscoped mode SET
// total_donated_cents on conflict to the RUN's pas2 total — a 0 for committees
// the run met only as recipients, and otherwise the sum over the cycles that
// run processed, not the all-cycle FR aggregate the FIX-702/726 family keeps.
// fe-crawl (jobid 46) is FR-dirty, so a committee whose FR rows did not change
// kept what the writer left; jobid 14's monthly reconcile only zeroes orphans.
// The writer is fixed (FIX-1226, both columns); this puts back what it took.
//
// THE POPULATION (rule 45 — the filter is part of the contract): every
// financial_entities row with a fec_committee_id and at least one outbound
// donation FR row whose total_donated_cents IS DISTINCT FROM that aggregate —
// cc-163 read 3's (b) zeroed ∪ (c) drifted. There is no B table for the donated
// side, so the aggregate the function computes is the truth, and the manifest
// records each id's expected_cents so the after-check (--verify) compares the
// stored value to the manifest, not to a re-read of the same aggregate. A row at
// 0 with no outbound rows is not in the set: the function would not touch it.
//
// THE COST IS AN INDEX-ONLY READ plus the FE writes. The aggregate's key,
// INCLUDE and partial predicate match financial_relationships_donation_size_rollup
// (20260530030000:31-33) exactly — cc-163 read 4 saw Index Only Scan on prod —
// unlike FIX-1226's received side. The write is ~15 ms per FE row on prod
// (cc-160), non-HOT (financial_entities_donated_positive is partial on > 0);
// fe-vacuum-analyze 04:50 owns the dead tuples (rule 41), so there is no VACUUM
// tail here.
//
// MODES (exactly one)
//   --dry-run          reads inside a READ ONLY transaction, writes the manifest
//                      (docs/audits/2026-09-27-fix1235-rederive-donated-manifest.json,
//                      or --out), prints the plan and a plain EXPLAIN of the
//                      largest chunk's aggregate. Writes nothing to the database.
//   --manifest <path>  applies a committed manifest (rule 42: the prod run READS
//                      it). One psql session, autocommit (no BEGIN, no
//                      --single-transaction): SET statement_timeout as its own
//                      statement first (rule 109), then ONE statement per chunk,
//                      each its own transaction, fed only after the one before
//                      it returned. ON_ERROR_STOP stops at the first error; the
//                      chunks before it stay committed and a re-run is safe.
//   --verify <path>    READ ONLY: the manifest's ids against their expected_cents
//                      now, and the live population count (0 after a clean set).
//
// CHUNKING: cc-160's constants — fr_rows ascending, 200 ids per chunk, an
// ordinary chunk also closes at 50,000 rows, anything over 10,000 rows a chunk
// of one, last. cc-163 read 3 measured a max of 1,503 rows per committee, so on
// that population every chunk is ordinary; the dry run says which.
//
// THE BUDGET (--budget-seconds, default 300): before each chunk the script stops
// cleanly — nothing in flight — if the elapsed wall has reached the budget, or,
// from the third chunk on, if elapsed plus the TWO-TERM projection of what is
// left would pass it (scripts/lib/rederive-budget.mjs: wall ≈ msPerId × ids +
// msPerRow × rows fitted over the chunks done, each term kept only when the
// samples identify it — rule 204, and the reason cc-160's single-rate guard
// stopped a run 3.3× early). Exit 5 says so; committed chunks stand and the
// manifest re-runs. Every chunk line prints the projection it was judged on.
//
// THE CLAIM: session:wait-for-gate --then hands this process
// CIVITICS_PROD_SESSION_CLAIMANT; when present it is SET on the session. The
// function is not a guarded procedure, so the GUC only labels the session.
//
// No psql meta-commands. Walls are server-side (clock_timestamp() -
// statement_timestamp()), so pooler latency is not in them.
//
// USAGE — from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD. Relative paths resolve
// against the cwd:
//   node scripts/fix1235-rederive-donated-totals.mjs --dry-run --env-file <primary>/.env.local.prod
//   (from packages/data) node ../../scripts/fix1235-rederive-donated-totals.mjs \
//       --manifest ../../docs/audits/2026-09-27-fix1235-rederive-donated-manifest.json --env-file ../../.env.local.prod
//   --local runs any mode against local Docker (the rehearsal).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkIds, budgetCheck } from "./lib/rederive-budget.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const DEFAULT_OUT = join(ROOT, "docs", "audits", "2026-09-27-fix1235-rederive-donated-manifest.json");
const TAG = "[fix1235]";

const IDS_PER_CHUNK = 200;
const ROWS_PER_CHUNK = 50_000;
const WHALE_ROWS = 10_000;
const STATEMENT_TIMEOUT = "10min";
const PROJECTION_MIN_CHUNKS = 3;
const CHUNKING = { idsPerChunk: IDS_PER_CHUNK, rowsPerChunk: ROWS_PER_CHUNK, whaleRows: WHALE_ROWS };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes("--dry-run");
const MANIFEST = argValue("--manifest", null);
const VERIFY = argValue("--verify", null);
const OUT = resolve(argValue("--out", DEFAULT_OUT));
const ENV_FILE = resolve(argValue("--env-file", join(ROOT, ".env.local.prod")));
const BUDGET_SECONDS = Number(argValue("--budget-seconds", "300"));

if ([DRY_RUN, MANIFEST !== null, VERIFY !== null].filter(Boolean).length !== 1) {
  console.error(`${TAG} pass exactly one of --dry-run, --manifest <path>, --verify <path>`);
  process.exit(64);
}
if (!Number.isFinite(BUDGET_SECONDS) || BUDGET_SECONDS <= 0) {
  console.error(`${TAG} --budget-seconds must be a positive number`);
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

// The manifest records its database, and an apply or verify refuses a manifest
// from the other one.
const TARGET = process.argv.includes("--local") ? "local" : "prod";
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function prodUrl() {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`${TAG} SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    console.error(`${TAG} a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
    process.exit(2);
  }
  const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  const u = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (u === baseUrl) {
    console.error(`${TAG} could not inject password into pooler URL: ${baseUrl}`);
    process.exit(2);
  }
  return u;
}
const url = TARGET === "local" ? LOCAL_URL : prodUrl();

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const arrayLiteral = (ids) => `ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`;

/** One READ ONLY psql round trip whose single output line is a JSON value. */
function readJson(sql, what) {
  const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-At"], {
    stdio: ["pipe", "pipe", "inherit"],
    input: `SET TRANSACTION READ ONLY;\n${sql}`,
    shell: process.platform === "win32",
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  });
  if (res.error || res.status !== 0) {
    console.error(`${TAG} ${what} failed: ${res.error?.message ?? `psql exit ${res.status}`}`);
    process.exit(1);
  }
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith("{"));
  if (!line) {
    console.error(`${TAG} ${what} returned no JSON row`);
    process.exit(1);
  }
  return JSON.parse(line);
}

// The function's own aggregate, over committees only.
const AGG_CTE = `
WITH agg AS (
  SELECT fr.from_id, SUM(fr.amount_cents)::bigint AS total, count(*)::bigint AS n
    FROM public.financial_relationships fr
   WHERE fr.from_type = 'financial_entity'
     AND fr.relationship_type = 'donation'
     AND fr.from_id IN (SELECT id FROM public.financial_entities WHERE fec_committee_id IS NOT NULL)
   GROUP BY fr.from_id
)`;

// ── --dry-run ────────────────────────────────────────────────────────────────
function dryRun() {
  const read = readJson(
    `${AGG_CTE}
SELECT json_build_object(
  'read_at', now(),
  'committees', (SELECT count(*) FROM public.financial_entities WHERE fec_committee_id IS NOT NULL),
  'consistent', (SELECT count(*) FROM public.financial_entities fe JOIN agg a ON a.from_id = fe.id
                  WHERE fe.fec_committee_id IS NOT NULL AND fe.total_donated_cents = a.total),
  'zero_no_outbound', (SELECT count(*) FROM public.financial_entities fe LEFT JOIN agg a ON a.from_id = fe.id
                        WHERE fe.fec_committee_id IS NOT NULL AND fe.total_donated_cents = 0 AND a.from_id IS NULL),
  'rows', COALESCE((
    SELECT json_agg(json_build_object(
             'id', fe.id,
             'fec_committee_id', fe.fec_committee_id,
             'before_cents', fe.total_donated_cents,
             'expected_cents', a.total,
             'fr_rows', a.n) ORDER BY a.n, fe.id)
      FROM public.financial_entities fe
      JOIN agg a ON a.from_id = fe.id
     WHERE fe.fec_committee_id IS NOT NULL
       AND fe.total_donated_cents IS DISTINCT FROM a.total), '[]'::json)
);`,
    "dry-run read",
  );
  const rows = read.rows.map((r) => ({
    id: r.id,
    fec_committee_id: r.fec_committee_id,
    before_cents: r.before_cents === null ? null : Number(r.before_cents),
    expected_cents: Number(r.expected_cents),
    fr_rows: Number(r.fr_rows),
  }));
  for (const r of rows) {
    if (!UUID_RE.test(r.id)) throw new Error(`not a uuid: ${r.id}`);
  }
  const zeroed = rows.filter((r) => r.before_cents === 0).length;
  const nullBefore = rows.filter((r) => r.before_cents === null).length;
  const drifted = rows.filter((r) => r.before_cents !== null && r.before_cents !== 0);
  const chunks = chunkIds(rows, CHUNKING);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const isWhale = (c) => c.length === 1 && byId.get(c[0]).fr_rows > WHALE_ROWS;
  const chunkRows = chunks.map((c) => sum(c.map((id) => byId.get(id).fr_rows)));
  const frRows = sum(rows.map((r) => r.fr_rows));
  const expectedSum = sum(rows.map((r) => r.expected_cents));
  const beforeSum = sum(rows.map((r) => r.before_cents ?? 0));

  const manifest = {
    generated_at: read.read_at,
    database: TARGET,
    fix: "FIX-1235",
    prompt: "cc-163",
    function: "public.financial_entity_donation_totals_rebuild(uuid[])",
    population_filter:
      "financial_entities fe JOIN (SUM(amount_cents), count(*) of financial_relationships WHERE from_type = 'financial_entity' " +
      "AND relationship_type = 'donation' GROUP BY from_id) a ON a.from_id = fe.id " +
      "WHERE fe.fec_committee_id IS NOT NULL AND fe.total_donated_cents IS DISTINCT FROM a.total",
    population: {
      zeroed,
      drifted: drifted.length,
      drifted_low: drifted.filter((r) => r.before_cents < r.expected_cents).length,
      drifted_high: drifted.filter((r) => r.before_cents > r.expected_cents).length,
      null_before: nullBefore,
      zero_no_outbound_excluded: read.zero_no_outbound,
      consistent: read.consistent,
      committees: read.committees,
    },
    totals: { ids: rows.length, fr_rows: frRows, before_cents: beforeSum, expected_cents: expectedSum },
    chunking: {
      order: "fr_rows ascending",
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
  const maxRows = rows.length ? Math.max(...rows.map((r) => r.fr_rows)) : 0;
  console.log(`${TAG} DRY RUN — ${TARGET} read at ${read.read_at}; nothing written to the database`);
  console.log(`${TAG} manifest: ${OUT}`);
  console.log(
    `${TAG} population: ${fmtInt(rows.length)} ids — zeroed ${fmtInt(zeroed)}, drifted ${fmtInt(drifted.length)} ` +
      `(${fmtInt(manifest.population.drifted_low)} low, ${fmtInt(manifest.population.drifted_high)} high), null ${fmtInt(nullBefore)}; ` +
      `excluded (0, no outbound rows): ${fmtInt(read.zero_no_outbound)}; consistent: ${fmtInt(read.consistent)} of ${fmtInt(read.committees)} committees`,
  );
  console.log(`${TAG} FR rows Σ ${fmtInt(frRows)} (max ${fmtInt(maxRows)} per committee); Σ before ${fmtInt(beforeSum)} ¢ → Σ expected ${fmtInt(expectedSum)} ¢`);
  console.log(
    `${TAG} chunks: ${chunks.length} (${chunks.length - whaleChunks} ordinary of ≤ ${IDS_PER_CHUNK} ids / ≤ ${fmtInt(ROWS_PER_CHUNK)} rows, ` +
      `${whaleChunks} whales of 1${whaleChunks === 0 ? ` — every chunk is ordinary: max ${fmtInt(maxRows)} rows ≤ ${fmtInt(WHALE_ROWS)}` : ", largest last"})`,
  );
  chunks.forEach((c, i) => {
    const tag = isWhale(c) ? ` whale ${c[0]} (${byId.get(c[0]).fec_committee_id})` : "";
    console.log(`${TAG}   chunk ${i + 1}/${chunks.length}: ${c.length} ids, ${fmtInt(chunkRows[i])} rows${tag}`);
  });
  console.log(
    `${TAG} expected wall at cc-160's ~15 ms per FE row written: ${((rows.length * 15) / 1000).toFixed(1)} s of writes, plus an index-only read of ${fmtInt(frRows)} rows`,
  );

  if (chunks.length === 0) process.exit(0);
  const largest = chunkRows.indexOf(Math.max(...chunkRows));
  const explain = `SET TRANSACTION READ ONLY;
EXPLAIN
SELECT fr.from_id, SUM(fr.amount_cents)::bigint AS total
  FROM public.financial_relationships fr
 WHERE fr.from_type = 'financial_entity'
   AND fr.relationship_type = 'donation'
   AND fr.from_id = ANY (${arrayLiteral(chunks[largest])})
 GROUP BY fr.from_id;
`;
  console.log(`${TAG} plan of the largest chunk's aggregate (chunk ${largest + 1}, ${chunks[largest].length} ids, ${fmtInt(chunkRows[largest])} rows):`);
  const ex = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-At"], {
    stdio: ["pipe", "pipe", "inherit"],
    input: explain,
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  for (const l of (ex.stdout ?? "").split(/\r?\n/)) {
    if (l.trim() !== "") console.log(`${TAG}   ${l.replace(/ANY \('\{[^}]*\}'::uuid\[\]\)/, "ANY ('{…}'::uuid[])")}`);
  }
  process.exit(ex.status ?? 1);
}

// ── manifest load (apply + verify) ─────────────────────────────────────────────
function loadManifest(path) {
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (m.database !== TARGET) throw new Error(`manifest database is ${JSON.stringify(m.database)}, this run targets "${TARGET}"`);
  if (m.fix !== "FIX-1235") throw new Error(`manifest is for ${JSON.stringify(m.fix)}, not FIX-1235`);
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
  for (const r of known.values()) {
    if (!Number.isSafeInteger(r.expected_cents)) throw new Error(`id ${r.id} has no integer expected_cents`);
  }
  return { m, known };
}

// ── --verify ─────────────────────────────────────────────────────────────────
function verify() {
  const path = resolve(VERIFY);
  const { m, known } = loadManifest(path);
  const pairs = JSON.stringify([...known.values()].map((r) => ({ id: r.id, e: r.expected_cents }))).replace(/'/g, "''");
  const read = readJson(
    `${AGG_CTE}, man AS (
  SELECT (x->>'id')::uuid AS id, (x->>'e')::bigint AS expected
    FROM json_array_elements('${pairs}'::json) x
)
SELECT json_build_object(
  'read_at', now(),
  'manifest_ids', (SELECT count(*) FROM man),
  'equal', (SELECT count(*) FROM man JOIN public.financial_entities fe ON fe.id = man.id
             WHERE fe.total_donated_cents IS NOT DISTINCT FROM man.expected),
  'distinct', COALESCE((SELECT json_agg(json_build_object('id', man.id, 'expected', man.expected, 'now', fe.total_donated_cents))
                          FROM man JOIN public.financial_entities fe ON fe.id = man.id
                         WHERE fe.total_donated_cents IS DISTINCT FROM man.expected), '[]'::json),
  'missing', (SELECT count(*) FROM man LEFT JOIN public.financial_entities fe ON fe.id = man.id WHERE fe.id IS NULL),
  'population_now', (SELECT count(*) FROM public.financial_entities fe JOIN agg a ON a.from_id = fe.id
                      WHERE fe.fec_committee_id IS NOT NULL AND fe.total_donated_cents IS DISTINCT FROM a.total)
);`,
    "verify read",
  );
  console.log(`${TAG} VERIFY — ${TARGET} read at ${read.read_at}; manifest ${path} (generated ${m.generated_at})`);
  console.log(`${TAG} manifest ids ${fmtInt(read.manifest_ids)}: equal to expected_cents ${fmtInt(read.equal)}, DISTINCT ${fmtInt(read.distinct.length)}, missing ${fmtInt(read.missing)}`);
  for (const d of read.distinct.slice(0, 20)) console.log(`${TAG}   distinct ${d.id}: expected ${d.expected}, now ${d.now}`);
  console.log(`${TAG} live population (committees DISTINCT from the aggregate) now: ${fmtInt(read.population_now)}`);
  process.exit(read.distinct.length === 0 && read.missing === 0 ? 0 : 3);
}

// ── --manifest (apply) ───────────────────────────────────────────────────────
function apply() {
  const path = resolve(MANIFEST);
  const { m, known } = loadManifest(path);
  const n = m.chunks.length;
  const chunkRows = m.chunks.map((c) => sum(c.map((id) => known.get(id).fr_rows)));
  const totalRows = sum(chunkRows);
  const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (claimant !== null && /[\r\n\0]/.test(claimant)) {
    console.error(`${TAG} CIVITICS_PROD_SESSION_CLAIMANT must be one line`);
    process.exit(64);
  }
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const chunkSql = (i) =>
    `WITH r AS MATERIALIZED (SELECT public.financial_entity_donation_totals_rebuild(${arrayLiteral(m.chunks[i])}) AS n) ` +
    `SELECT 'CHUNK|${i + 1}|${m.chunks[i].length}|${chunkRows[i]}|' || r.n || '|' || ` +
    `round((EXTRACT(epoch FROM clock_timestamp() - statement_timestamp()) * 1000)::numeric, 1) FROM r;\n`;

  console.error(`${TAG} ${TARGET === "prod" ? "PROD (Supabase Pro)" : "LOCAL"} — WRITE: ${n} chunks, ${fmtInt(known.size)} ids, ${fmtInt(totalRows)} FR rows, from ${path}`);
  console.error(
    `${TAG} each chunk is one autocommitted SELECT of financial_entity_donation_totals_rebuild; statement_timeout ${STATEMENT_TIMEOUT}; ` +
      `budget ${BUDGET_SECONDS} s (two-term projection from chunk ${PROJECTION_MIN_CHUNKS + 1})${claimant !== null ? `; claimant ${claimant}` : ""}`,
  );
  const t0 = Date.now();
  console.error(`${TAG} start ${new Date(t0).toISOString()}`);

  let updated = 0;
  let idsDone = 0;
  let rowsDone = 0;
  let chunkMs = 0;
  const samples = [];
  let stopReason = null;
  let lastProjection = null;
  let buf = "";
  const child = spawn("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-At"], {
    stdio: ["pipe", "pipe", "inherit"],
    shell: process.platform === "win32",
  });

  const next = () => {
    const i = samples.length;
    if (i < n) {
      const check = budgetCheck({
        elapsedSeconds: (Date.now() - t0) / 1000,
        budgetSeconds: BUDGET_SECONDS,
        done: samples,
        idsLeft: known.size - idsDone,
        rowsLeft: totalRows - rowsDone,
        chunksLeft: n - i,
        minChunks: PROJECTION_MIN_CHUNKS,
      });
      lastProjection = check.projectedSeconds;
      if (check.stop) {
        stopReason = check.reason;
      } else {
        child.stdin.write(chunkSql(i));
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
        console.log(`${TAG} server start ${p[1]}`);
        next();
      } else if (p[0] === "END") {
        console.log(`${TAG} server end ${p[1]}`);
      } else if (p[0] === "CHUNK") {
        const [, i, ids, rows, k, ms] = p;
        updated += Number(k);
        idsDone += Number(ids);
        rowsDone += Number(rows);
        chunkMs += Number(ms);
        samples.push({ ids: Number(ids), rows: Number(rows), ms: Number(ms) });
        const short = Number(k) < Number(ids) ? ` (${Number(ids) - Number(k)} already equal)` : "";
        const proj = lastProjection === null ? "projection n/a (< 3 chunks)" : `judged on projected total ${lastProjection.toFixed(1)} s`;
        console.log(
          `${TAG} chunk ${i}/${n}: ${k} rows updated of ${ids} ids, ${fmtInt(rows)} FR rows, wall ${(Number(ms) / 1000).toFixed(2)} s${short}; ` +
            `elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s; ${proj}`,
        );
        next();
      } else if (line.trim() !== "") {
        console.log(`${TAG} ${line}`);
      }
    }
  });
  child.on("error", (e) => {
    console.error(`${TAG} failed to launch psql: ${e.message}`);
    process.exit(1);
  });
  child.on("close", (code) => {
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    const done = samples.length;
    console.error(`${TAG} end ${new Date().toISOString()} — psql wall clock ${wall} s, chunk walls Σ ${(chunkMs / 1000).toFixed(1)} s`);
    console.log(`${TAG} total: ${fmtInt(updated)} rows updated over ${done}/${n} chunks (manifest ${fmtInt(known.size)} ids)`);
    if (code !== 0) {
      console.error(`${TAG} STOPPED at chunk ${done + 1}/${n} (psql exit ${code}). Chunks 1..${done} are committed; read why before re-running.`);
      process.exit(code ?? 1);
    }
    if (stopReason !== null) {
      console.error(`${TAG} STOPPED before chunk ${done + 1}/${n}: ${stopReason}. Chunks 1..${done} are committed; the manifest re-runs.`);
      process.exit(5);
    }
    process.exit(0);
  });

  let pre = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\n`;
  if (claimant !== null) pre += `SET civitics.prod_session_claimant = ${lit(claimant)};\n`;
  pre += `SET application_name = 'fix1235-rederive';\n`;
  pre += `SELECT 'START|' || clock_timestamp();\n`;
  child.stdin.write(pre);
}

if (DRY_RUN) dryRun();
else if (VERIFY !== null) verify();
else apply();
