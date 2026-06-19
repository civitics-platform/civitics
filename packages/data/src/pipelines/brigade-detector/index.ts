/**
 * SF-P4 brigade detector — shadow scan runner (FIX-608).
 *
 * Read-only orchestrator for the coordinated-abuse detector. It calls the
 * conservative, FP-aware scorer `public.detect_brigade_candidates()` in both
 * modes (fast = F8 pile-on, slow = F9 cross-target co-occurrence) and appends any
 * candidate clusters to the append-only `public.brigade_candidates` log.
 *
 * DETECTION ≠ PUNISHMENT. This run confers ZERO consequence: it never flags,
 * collapses, hides, scores, or mutates any content. The ONLY table it writes is
 * brigade_candidates. Enforcement is a deliberate, human-gated follow-up. A
 * zero-pollution self-check counts the mutable content tables before/after and
 * fails if any row count changed.
 *
 * Synthetic + confirmed-abuse authors are excluded inside the scorer (canonical
 * SF-P1 predicate author_excluded_from_standing), so the State of Franklin seed —
 * coordinated by design — never produces a candidate.
 *
 *   pnpm --filter @civitics/data data:brigade-scan
 *   pnpm --filter @civitics/data data:brigade-scan -- --dry-run
 *   pnpm --filter @civitics/data data:brigade-scan -- --allow-prod --db-url postgresql://...
 *
 * Defaults to LOCAL Docker. A prod run reads prod tables and writes
 * brigade_candidates on prod, so it requires --allow-prod AND a supabase.co
 * --db-url (see CLAUDE.md "Data-state changes vs schema changes"). Run via direct
 * pg.Client (this script), never PostgREST — the slow-mode scan can exceed the
 * service_role statement timeout.
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Content tables the detector must NEVER mutate. brigade_candidates (its log) is
// deliberately excluded — that is the one table it appends to.
const CONTENT_TABLES = [
  "entity_comments",
  "comment_ratings",
  "content_flags",
  "entity_positions",
  "position_events",
  "evidence_cards",
  "citations",
  "investigations",
];

interface Args {
  dbUrl: string;
  allowProd: boolean;
  dryRun: boolean;
  horizonDays: number;
  windowMinutes: number;
  minCluster: number;
  scoreThreshold: number;
}

interface Candidate {
  mode: "fast" | "slow";
  target_id: string | null;
  cluster_size: number;
  account_ids: string[];
  score: string; // numeric comes back as string from pg
  signals: Record<string, unknown>;
}

function workspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/data/src/pipelines/brigade-detector/index.ts → up 5 levels.
  return resolve(here, "..", "..", "..", "..", "..");
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dbUrl =
    process.env.SUPABASE_DB_URL ?? process.env.COWORK_READONLY_DB_URL ?? LOCAL_DB_URL;
  let allowProd = false;
  let dryRun = false;
  let horizonDays = 14;
  let windowMinutes = 60;
  let minCluster = 5;
  let scoreThreshold = 0.6;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i];
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--horizon-days" && args[i + 1]) horizonDays = Number(args[++i]);
    else if (a === "--window-minutes" && args[i + 1]) windowMinutes = Number(args[++i]);
    else if (a === "--min-cluster" && args[i + 1]) minCluster = Number(args[++i]);
    else if (a === "--score-threshold" && args[i + 1]) scoreThreshold = Number(args[++i]);
    else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: data:brigade-scan [--db-url <url>] [--allow-prod] [--dry-run] " +
          "[--horizon-days N] [--window-minutes N] [--min-cluster N] [--score-threshold F]",
      );
      process.exit(0);
    }
  }
  return { dbUrl, allowProd, dryRun, horizonDays, windowMinutes, minCluster, scoreThreshold };
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
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

async function scan(client: Client, mode: "fast" | "slow", a: Args): Promise<Candidate[]> {
  // p_target_ids = NULL → scan all recent activity within the horizon.
  const res = await client.query<Candidate>(
    `SELECT mode, target_id, cluster_size, account_ids, score, signals
       FROM public.detect_brigade_candidates(
         $1, NULL,
         $2,  -- p_window_minutes
         $3,  -- p_horizon_days
         $4,  -- p_min_cluster
         3,   -- p_min_cooccur_targets (default)
         7,   -- p_new_account_days (default)
         30,  -- p_established_days (default)
         $5   -- p_score_threshold
       )`,
    [mode, a.windowMinutes, a.horizonDays, a.minCluster, a.scoreThreshold],
  );
  return res.rows;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv);
  const host = hostFromUrl(a.dbUrl);
  const isProd = /supabase\.(co|com)/i.test(host) || /supabase\./i.test(a.dbUrl);

  if (isProd && !a.allowProd) {
    // eslint-disable-next-line no-console
    console.error(
      `REFUSING to run against what looks like prod (${host}) without --allow-prod.\n` +
        "The scan reads prod tables and appends to brigade_candidates. Confirm intent, " +
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
    `SF-P4 brigade scan — host=${host} sha=${sha} ${isProd ? "(PROD)" : "(local)"}` +
      `${a.dryRun ? " [dry-run]" : ""}`,
  );

  const before = await tableCounts(client);

  const fast = await scan(client, "fast", a);
  const slow = await scan(client, "slow", a);
  const candidates = [...fast, ...slow];

  let written = 0;
  if (!a.dryRun) {
    for (const c of candidates) {
      await client.query(
        `INSERT INTO public.brigade_candidates
           (sha, mode, target_id, cluster_size, account_ids, score, signals, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          sha,
          c.mode,
          c.target_id,
          c.cluster_size,
          c.account_ids,
          c.score,
          c.signals,
          "SF-P4 shadow candidate — detection only, no consequence conferred.",
        ],
      );
      written++;
    }
  }

  const after = await tableCounts(client);
  await client.end();

  // eslint-disable-next-line no-console
  console.table(
    candidates.map((c) => ({
      mode: c.mode,
      cluster: c.cluster_size,
      score: c.score,
      target: c.target_id ?? "(cross-target)",
    })),
  );
  // eslint-disable-next-line no-console
  console.log(
    `\nCandidates: ${fast.length} fast · ${slow.length} slow` +
      ` — ${a.dryRun ? "dry-run (nothing written)" : `${written} logged to brigade_candidates`}`,
  );

  // Zero-pollution proof: the detector must not have mutated any content table.
  const dirty = CONTENT_TABLES.map((t) => ({
    table: t,
    delta: (after.get(t) ?? 0) - (before.get(t) ?? 0),
  })).filter((d) => d.delta !== 0);

  if (dirty.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n⚠️  POLLUTION: detector mutated content tables — ${dirty
        .map((d) => `${d.table}+${d.delta}`)
        .join(", ")}`,
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("✅ Zero-pollution: no content table mutated (only brigade_candidates appended).");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
