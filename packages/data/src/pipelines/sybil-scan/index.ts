/**
 * FIX-571 PR2 — Sybil / linkage cluster scan runner (shadow, detection-only).
 *
 * Read-only orchestrator for the linkage detector. It calls the conservative,
 * FP-aware scorer `public.detect_sybil_clusters()` over the observe-only
 * `public.abuse_events` log (shipped by FIX-880 / PR1) and appends any candidate
 * clusters to the append-only `public.sybil_candidates` log.
 *
 * DETECTION ≠ PUNISHMENT. This run confers ZERO consequence: it never flags,
 * collapses, hides, blocks, scores, or mutates any content. The ONLY table it
 * writes is sybil_candidates. Enforcement is a deliberate, human-gated follow-up.
 * A zero-pollution self-check counts the mutable content tables AND abuse_events
 * itself before/after and fails if any row count changed — the scan must not even
 * log an abuse_event about its own run.
 *
 * Synthetic + confirmed-abuse authors are excluded, and NULL-hash (linkage-blind,
 * pepper-unset era) rows are skipped, INSIDE the scorer.
 *
 * APPEND-ONLY, NOT IDEMPOTENT. sybil_candidates is an append-only log (mirrors
 * brigade_candidates): each run appends the candidates it found at that moment.
 * Re-running appends again — that is by design, not a bug; the detected_at + sha
 * columns date each run.
 *
 *   pnpm --filter @civitics/data data:sybil-scan
 *   pnpm --filter @civitics/data data:sybil-scan -- --dry-run
 *   pnpm --filter @civitics/data data:sybil-scan -- --allow-prod --db-url postgresql://...
 *
 * Defaults to LOCAL Docker. A prod run reads prod tables and writes
 * sybil_candidates on prod, so it requires --allow-prod AND a supabase.co
 * --db-url (see CLAUDE.md "Data-state changes vs schema changes"). Run via direct
 * pg.Client (this script), never PostgREST — the double-keyed scan can exceed the
 * service_role statement timeout. There is deliberately NO cron: the scan runs at
 * a manual/shadow cadence until the log has real data.
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Tables the detector must NEVER mutate. sybil_candidates (its own log) is
// deliberately excluded — that is the one table it appends to. abuse_events is
// INCLUDED: the scan reads it and must never write an event about its own run.
const CONTENT_TABLES = [
  "abuse_events",
  "entity_comments",
  "comment_ratings",
  "content_flags",
  "entity_positions",
  "position_events",
  "evidence_cards",
  "citations",
  "investigations",
];

export interface Args {
  dbUrl: string;
  allowProd: boolean;
  dryRun: boolean;
  horizonDays: number;
  minAccounts: number;
  coupleMinutes: number;
  burstMinutes: number;
  dampCap: number;
  scoreThreshold: number;
}

export interface Candidate {
  signal: "shared_fingerprint" | "shared_ip" | "temporal_coupling" | "auth_burst";
  cluster_key: string | null;
  cluster_size: number;
  account_ids: string[];
  event_count: number | null;
  first_seen: string | null;
  last_seen: string | null;
  score: string; // numeric comes back as string from pg
  signals: Record<string, unknown>;
}

function workspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/data/src/pipelines/sybil-scan/index.ts → up 5 levels.
  return resolve(here, "..", "..", "..", "..", "..");
}

export function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dbUrl =
    process.env.SUPABASE_DB_URL ?? process.env.COWORK_READONLY_DB_URL ?? LOCAL_DB_URL;
  let allowProd = false;
  let dryRun = false;
  let horizonDays = 30;
  let minAccounts = 3;
  let coupleMinutes = 15;
  let burstMinutes = 60;
  let dampCap = 25;
  let scoreThreshold = 0.6;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i];
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--horizon-days" && args[i + 1]) horizonDays = Number(args[++i]);
    else if (a === "--min-accounts" && args[i + 1]) minAccounts = Number(args[++i]);
    else if (a === "--couple-minutes" && args[i + 1]) coupleMinutes = Number(args[++i]);
    else if (a === "--burst-minutes" && args[i + 1]) burstMinutes = Number(args[++i]);
    else if (a === "--damp-cap" && args[i + 1]) dampCap = Number(args[++i]);
    else if (a === "--score-threshold" && args[i + 1]) scoreThreshold = Number(args[++i]);
    else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: data:sybil-scan [--db-url <url>] [--allow-prod] [--dry-run] " +
          "[--horizon-days N] [--min-accounts N] [--couple-minutes N] " +
          "[--burst-minutes N] [--damp-cap N] [--score-threshold F]",
      );
      process.exit(0);
    }
  }
  return {
    dbUrl,
    allowProd,
    dryRun,
    horizonDays,
    minAccounts,
    coupleMinutes,
    burstMinutes,
    dampCap,
    scoreThreshold,
  };
}

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/** Does this host/url look like the Supabase Pro project (not local Docker)? */
export function isProdHost(host: string, url: string): boolean {
  return /supabase\.(co|com)/i.test(host) || /supabase\./i.test(url);
}

/** Flatten a candidate to the compact row printed in the run summary table. */
export function summarizeCandidate(c: Candidate): {
  signal: string;
  size: number;
  score: string;
  key: string;
} {
  return {
    signal: c.signal,
    size: c.cluster_size,
    score: c.score,
    key: c.cluster_key ?? "(none)",
  };
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: workspaceRoot(),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function tableCounts(client: Client): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const t of CONTENT_TABLES) {
    const res = await client.query(`SELECT count(*)::bigint AS n FROM public.${t}`);
    counts.set(t, Number(res.rows[0].n));
  }
  return counts;
}

/** Rows the scorer can actually link over — non-NULL ip_hash within the horizon. */
async function linkableRowCount(client: Client, a: Args): Promise<number> {
  const res = await client.query<{ n: string }>(
    `SELECT count(*)::bigint AS n
       FROM public.abuse_events
      WHERE ip_hash IS NOT NULL
        AND occurred_at >= now() - make_interval(days => $1)`,
    [a.horizonDays],
  );
  return Number(res.rows[0].n);
}

async function scan(client: Client, a: Args): Promise<Candidate[]> {
  const res = await client.query<Candidate>(
    `SELECT signal, cluster_key, cluster_size, account_ids, event_count,
            first_seen, last_seen, score, signals
       FROM public.detect_sybil_clusters(
         $1,  -- p_horizon_days
         $2,  -- p_min_accounts
         $3,  -- p_couple_minutes
         $4,  -- p_burst_minutes
         $5,  -- p_damp_cap
         $6   -- p_score_threshold
       )`,
    [
      a.horizonDays,
      a.minAccounts,
      a.coupleMinutes,
      a.burstMinutes,
      a.dampCap,
      a.scoreThreshold,
    ],
  );
  return res.rows;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv);
  const host = hostFromUrl(a.dbUrl);
  const isProd = isProdHost(host, a.dbUrl);

  if (isProd && !a.allowProd) {
    // eslint-disable-next-line no-console
    console.error(
      `REFUSING to run against what looks like prod (${host}) without --allow-prod.\n` +
        "The scan reads prod tables and appends to sybil_candidates. Confirm intent, " +
        "then re-run with --allow-prod.",
    );
    process.exit(2);
  }

  const sha = gitSha();
  const cleanUrl = a.dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(a.dbUrl) || a.dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  // eslint-disable-next-line no-console
  console.log(
    `FIX-571 Sybil scan — host=${host} sha=${sha} ${isProd ? "(PROD)" : "(local)"}` +
      `${a.dryRun ? " [dry-run]" : ""}`,
  );

  const before = await tableCounts(client);
  const linkable = await linkableRowCount(client, a);
  const candidates = await scan(client, a);

  let written = 0;
  if (!a.dryRun) {
    for (const c of candidates) {
      await client.query(
        `INSERT INTO public.sybil_candidates
           (sha, signal, cluster_key, cluster_size, account_ids, event_count,
            first_seen, last_seen, score, signals, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          sha,
          c.signal,
          c.cluster_key,
          c.cluster_size,
          c.account_ids,
          c.event_count,
          c.first_seen,
          c.last_seen,
          c.score,
          c.signals,
          "FIX-571 shadow candidate — detection only, no consequence conferred.",
        ],
      );
      written++;
    }
  }

  const after = await tableCounts(client);
  await client.end();

  // eslint-disable-next-line no-console
  console.table(candidates.map(summarizeCandidate));
  // eslint-disable-next-line no-console
  console.log(
    `\nScanned ${linkable} linkable event(s) (non-NULL ip_hash, last ${a.horizonDays}d). ` +
      `Candidates: ${candidates.length}` +
      ` — ${
        a.dryRun ? "dry-run (nothing written)" : `${written} appended to sybil_candidates`
      }.`,
  );
  if (candidates.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      linkable === 0
        ? "  (0 linkable rows — the log is empty / pepper-unset era: measured-empty, not broken.)"
        : "  (linkable rows present but none crossed the score threshold: measured-empty.)",
    );
  }

  // Zero-pollution proof: the detector must not have mutated any content table
  // NOR abuse_events itself (no self-logging).
  const dirty = CONTENT_TABLES.map((t) => ({
    table: t,
    delta: (after.get(t) ?? 0) - (before.get(t) ?? 0),
  })).filter((d) => d.delta !== 0);

  if (dirty.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n⚠️  POLLUTION: detector mutated watched tables — ${dirty
        .map((d) => `${d.table}+${d.delta}`)
        .join(", ")}`,
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(
    "✅ Zero-pollution: no content table nor abuse_events mutated (only sybil_candidates appended).",
  );
}

// Only auto-run when invoked directly (not when imported by the test suite).
// Compare normalized file:// URLs (lowercased for Windows drive-letter casing).
const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href.toLowerCase() : "";
if (invokedHref === import.meta.url.toLowerCase()) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
